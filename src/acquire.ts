import { constants } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { lstat, link, mkdir, mkdtemp, open, readdir, rm, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { errorCode, MynpmError } from './errors.ts';
import type { ErrorCategory } from './errors.ts';
import { inspectPackageArchive } from './archive.ts';
import type { InspectedPackageArchive } from './archive.ts';
import type { MynpmConfig, TargetConfig } from './config.ts';
import { formatBytes, formatDuration, limits } from './limits.ts';
import { createFetchByteBudget } from './fetch-budget.ts';
import { loadInventory, updateInventory } from './inventory-store.ts';
import { recordVerifiedArtifact } from './inventory.ts';
import type {
  ArtifactRecord,
  ArtifactVerification,
  Inventory,
  JsonObject,
  JsonValue,
  PackageRecord,
  PackumentMetadata,
  PlatformConstraints,
  VerifiedVersionMetadata,
} from './inventory.ts';

type DigestAlgorithm = 'sha1' | 'sha256' | 'sha384' | 'sha512';
type DigestMap = Map<DigestAlgorithm, string>;
type AddressResolver = typeof dnsLookup;
type TimeoutScheduler = typeof setTimeout;
type TimeoutClearer = typeof clearTimeout;

interface ExchangeOptions {
  signal: AbortSignal;
  addresses: LookupAddress[];
}

interface ResponseBody extends AsyncIterable<string | Uint8Array> {
  destroy?(error?: Error): unknown;
}

interface ExchangeResponse {
  statusCode: number | undefined;
  headers: IncomingHttpHeaders;
  body: ResponseBody;
  close?(): void;
}

type Exchange = (url: URL, options: ExchangeOptions) => Promise<ExchangeResponse>;

interface LookupCallback {
  (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number): void;
}

type PinnedLookup = (
  hostname: string,
  options: LookupOptions | number,
  callback: LookupCallback,
) => void;

interface TransferOptions {
  maxBytes: number;
  signal: AbortSignal;
  expectedHost: string;
  exchange: Exchange;
  resolver: AddressResolver;
  consume: (this: void, chunk: Buffer) => Effect.Effect<void, MynpmError>;
  countBytes: (this: void, bytes: number) => number;
  scheduleTimeout: TimeoutScheduler;
  clearScheduledTimeout: TimeoutClearer;
}

interface PackageTaskBase {
  name: string;
  version: string;
  records: PackageRecord[];
  targets: Map<string, TargetConfig>;
  upstreamRegistry: string;
}

type PackageTask = PackageTaskBase & (
  | { artifactRecord: null; artifact: null }
  | { artifactRecord: ArtifactRecord; artifact: ArtifactVerification }
);

interface TaskWithMetadata extends PackageTaskBase {
  metadata: VerifiedVersionMetadata;
  records: PackageRecord[];
  targets: Map<string, TargetConfig>;
  artifactRecord: ArtifactRecord | null;
  artifact: ArtifactVerification | null;
}

interface MetadataResult {
  packument: PackumentMetadata;
  metadata: VerifiedVersionMetadata;
  tarballUrl: string;
}

interface AcquisitionContext {
  stateDirectory: string;
  upstreamRegistry: string;
  allowLegacySha1Only: boolean;
  signal: AbortSignal;
  expectedHost: string;
  exchange: Exchange;
  resolver: AddressResolver;
  countBytes: (this: void, bytes: number) => number;
  scheduleTimeout: TimeoutScheduler;
  clearScheduledTimeout: TimeoutClearer;
  stagingDirectory: string;
}

interface PackageResult {
  task: PackageTask;
  metadata: VerifiedVersionMetadata;
  packument: PackumentMetadata;
  artifact: ArtifactVerification;
  stagePath: string | null;
  byteCount: number;
  reused: boolean;
}

interface FetchDependencies {
  exchange?: Exchange;
  resolveAddresses?: AddressResolver;
  scheduleTimeout?: TimeoutScheduler;
  clearScheduledTimeout?: TimeoutClearer;
}

interface FetchInventoryOptions {
  stateDirectory: string;
  config: MynpmConfig;
}

interface VerifyInventoryOptions {
  stateDirectory: string;
  config: MynpmConfig;
}

interface VerifyInventorySnapshotOptions extends VerifyInventoryOptions {
  inventory: Inventory;
}

const restrictedAddresses = new BlockList();
const restrictedIpv4Subnets: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
for (const [address, prefix] of restrictedIpv4Subnets) restrictedAddresses.addSubnet(address, prefix, 'ipv4');
const restrictedIpv6Subnets: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2001:20::', 28], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
];
for (const [address, prefix] of restrictedIpv6Subnets) restrictedAddresses.addSubnet(address, prefix, 'ipv6');

function fail(category: ErrorCategory, message: string, options?: ErrorOptions): never {
  throw new MynpmError(category, message, options);
}

function tryPromise<A>(
  operation: (signal: AbortSignal) => Promise<A>,
  mapError: (cause: unknown) => MynpmError,
): Effect.Effect<A, MynpmError> {
  return Effect.tryPromise({ try: operation, catch: mapError });
}

function trySync<A>(operation: () => A, mapError: (cause: unknown) => MynpmError): Effect.Effect<A, MynpmError> {
  return Effect.try({ try: operation, catch: mapError });
}

function asMynpmError(cause: unknown, category: ErrorCategory, message: string): MynpmError {
  return cause instanceof MynpmError ? cause : new MynpmError(category, message, { cause });
}

export function isRestrictedAddress(address: string, family: number): boolean {
  const normalized = address.toLowerCase();
  return isIP(address) !== family || (family === 6 && normalized.startsWith('::ffff:')) || restrictedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function validateSourceUrl(value: string | URL, expectedHost: string): URL {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (cause) {
    throw new MynpmError('operation', 'upstream returned an invalid URL', { cause });
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || host !== expectedHost || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || isIP(host) !== 0) {
    fail('operation', `upstream URL is outside the allowlisted HTTPS registry ${expectedHost}`);
  }
  return url;
}

function publicAddresses(hostname: string, resolver: AddressResolver = dnsLookup): Effect.Effect<LookupAddress[], MynpmError> {
  return Effect.gen(function*() {
    const addresses = yield* tryPromise(
      () => resolver(hostname, { all: true, verbatim: true }),
      cause => asMynpmError(cause, 'operation', `could not resolve upstream host ${hostname}`),
    );
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address, family }) => isRestrictedAddress(address, family))) {
      return yield* Effect.fail(new MynpmError('operation', `upstream host ${hostname} resolved to a non-public address`));
    }
    return addresses;
  });
}

function pinnedLookup(addresses: LookupAddress[]): PinnedLookup {
  return (hostname, options, callback) => {
    const requestedFamily = typeof options === 'number' ? options : options?.family ?? 0;
    const candidates = requestedFamily === 0 ? addresses : addresses.filter(item => item.family === requestedFamily);
    if (candidates.length === 0) {
      callback(Object.assign(new Error(`no verified DNS address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    if (typeof options === 'object' && options.all) callback(null, candidates);
    else {
      const candidate = candidates[0];
      if (candidate === undefined) {
        callback(Object.assign(new Error(`no verified DNS address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
        return;
      }
      callback(null, candidate.address, candidate.family);
    }
  };
}

function exchangeHttps(url: URL, { signal, addresses }: ExchangeOptions): Promise<ExchangeResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    };
    const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new MynpmError('cancelled', 'upstream request was cancelled'));
    const request = httpsRequest(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'mynpm/0.1.0' },
      lookup: pinnedLookup(addresses),
    }, response => {
      settled = true;
      resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: response,
        close() {
          signal.removeEventListener('abort', abort);
        },
      });
    });
    request.on('error', finishError);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    request.end();
  });
}

function responseLength(response: ExchangeResponse, maximum: number): void {
  const raw = response.headers['content-length'];
  if (raw === undefined) return;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) fail('operation', 'upstream returned an invalid Content-Length');
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > maximum) fail('operation', `upstream response exceeds the ${formatBytes(maximum)} limit`);
}

function closeResponse(response: ExchangeResponse): void {
  response.close?.();
  response.body.destroy?.();
}

function abortReason<T>(signal: AbortSignal, fallback: T): Error | T {
  return signal.reason instanceof Error ? signal.reason : fallback;
}

function abortWhen(signal: AbortSignal): Effect.Effect<never, MynpmError> {
  return tryPromise(
    runtimeSignal => new Promise<never>((_resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        runtimeSignal.removeEventListener('abort', cleanup);
      };
      const onAbort = () => {
        cleanup();
        reject(abortReason(signal, new MynpmError('cancelled', 'fetch was cancelled')));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      runtimeSignal.addEventListener('abort', cleanup, { once: true });
      if (signal.aborted) onAbort();
    }),
    cause => asMynpmError(cause, 'cancelled', 'fetch was cancelled'),
  );
}

interface TransferResponseResult {
  statusCode: number | undefined;
  location: string | string[] | undefined;
  received: number;
}

function transfer(urlValue: string | URL, {
  maxBytes,
  signal,
  expectedHost,
  exchange,
  resolver,
  consume,
  countBytes,
  scheduleTimeout,
  clearScheduledTimeout,
}: TransferOptions): Effect.Effect<{ bytes: number; url: URL }, MynpmError> {
  const request = (url: URL): Effect.Effect<TransferResponseResult, MynpmError> => Effect.scoped(Effect.gen(function*() {
    const requestResources = yield* trySync(() => {
      const controller = new AbortController();
      const onAbort = () => controller.abort(abortReason(signal, new MynpmError('cancelled', 'fetch was cancelled')));
      signal.addEventListener('abort', onAbort, { once: true });
      let timeout: ReturnType<typeof setTimeout>;
      try {
        timeout = scheduleTimeout(
          () => controller.abort(new MynpmError('operation', `upstream request exceeded the ${formatDuration(limits.requestMilliseconds)} limit`)),
          limits.requestMilliseconds,
        );
      } catch (cause) {
        signal.removeEventListener('abort', onAbort);
        throw cause;
      }
      return { controller, onAbort, timeout };
    }, cause => asMynpmError(cause, 'operation', 'could not start upstream request'));
    const { controller: requestController, onAbort, timeout } = requestResources;
    let requestCompleted = false;
    yield* Effect.acquireRelease(
      Effect.succeed(requestResources),
      resources => Effect.sync(() => {
        clearScheduledTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        if (!requestCompleted && !resources.controller.signal.aborted) resources.controller.abort(new MynpmError('cancelled', 'upstream request failed'));
      }),
    );
    const responseEffect = Effect.gen(function*() {
      const addresses = yield* publicAddresses(url.hostname, resolver);
      if (signal.aborted) return yield* Effect.fail(asMynpmError(abortReason(signal, new MynpmError('cancelled', 'fetch was cancelled')), 'cancelled', 'fetch was cancelled'));
      const response = yield* Effect.acquireRelease(
        tryPromise(
          runtimeSignal => {
            const onRuntimeAbort = () => requestController.abort(abortReason(runtimeSignal, new MynpmError('cancelled', 'fetch was cancelled')));
            runtimeSignal.addEventListener('abort', onRuntimeAbort, { once: true });
            if (runtimeSignal.aborted) onRuntimeAbort();
            return exchange(url, { signal: requestController.signal, addresses }).finally(() => runtimeSignal.removeEventListener('abort', onRuntimeAbort));
          },
          cause => asMynpmError(abortReason(requestController.signal, cause), 'operation', `upstream request failed for ${url.href}`),
        ),
        value => Effect.sync(() => closeResponse(value)),
      );
      if (requestController.signal.aborted) {
        return yield* Effect.fail(asMynpmError(abortReason(requestController.signal, new MynpmError('cancelled', 'fetch was cancelled')), 'operation', `upstream request failed for ${url.href}`));
      }
      const statusCode = response.statusCode;
      if (typeof statusCode === 'number' && [301, 302, 303, 307, 308].includes(statusCode)) {
        return { statusCode, location: response.headers.location, received: 0 };
      }
      if (statusCode !== 200) return yield* Effect.fail(new MynpmError('operation', `upstream returned HTTP ${String(statusCode)} for ${url.href}`));
      const lengthCheck = Effect.try({
        try: () => responseLength(response, maxBytes),
        catch: cause => asMynpmError(cause, 'operation', `upstream returned an invalid response for ${url.href}`),
      });
      yield* lengthCheck;
      let received = 0;
      const body = Stream.fromAsyncIterable(
        response.body,
        cause => requestController.signal.aborted
          ? asMynpmError(abortReason(requestController.signal, cause), 'operation', `upstream response failed for ${url.href}`)
          : asMynpmError(cause, 'operation', `upstream response failed for ${url.href}`),
      );
      yield* Stream.runForEach(body, chunk => Effect.gen(function*() {
        if (requestController.signal.aborted) {
          return yield* Effect.fail(asMynpmError(abortReason(requestController.signal, new MynpmError('cancelled', 'fetch was cancelled')), 'operation', `upstream response failed for ${url.href}`));
        }
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > maxBytes) return yield* Effect.fail(new MynpmError('operation', `upstream response exceeds the ${formatBytes(maxBytes)} limit`));
        yield* Effect.try({
          try: () => countBytes(bytes.length),
          catch: cause => asMynpmError(cause, 'operation', 'fetch byte limit exceeded'),
        });
        yield* consume(bytes);
      }));
      return { statusCode, location: undefined, received };
    });
    const result = yield* Effect.raceFirst(responseEffect, abortWhen(requestController.signal));
    requestCompleted = true;
    return result;
  }));

  return Effect.gen(function*() {
    let url = yield* trySync(() => validateSourceUrl(urlValue, expectedHost), cause => asMynpmError(cause, 'operation', 'upstream returned an invalid URL'));
    for (let redirects = 0; ; redirects += 1) {
      if (signal.aborted) return yield* Effect.fail(asMynpmError(abortReason(signal, new MynpmError('cancelled', 'fetch was cancelled')), 'cancelled', 'fetch was cancelled'));
      url = yield* trySync(() => validateSourceUrl(url, expectedHost), cause => asMynpmError(cause, 'operation', 'upstream returned an invalid URL'));
      const result = yield* request(url);
      if (typeof result.statusCode === 'number' && [301, 302, 303, 307, 308].includes(result.statusCode)) {
        if (redirects >= limits.redirects) return yield* Effect.fail(new MynpmError('operation', `upstream exceeded the ${limits.redirects} redirect limit`));
        if (typeof result.location !== 'string' || result.location.length === 0) return yield* Effect.fail(new MynpmError('operation', 'upstream redirect omitted Location'));
        const location = result.location;
        url = yield* trySync(() => validateSourceUrl(new URL(location, url), expectedHost), cause => asMynpmError(cause, 'operation', 'upstream returned an invalid redirect URL'));
        continue;
      }
      return { bytes: result.received, url };
    }
  });
}

function packageRoute(name: string): string {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const separator = name.indexOf('/');
  return `${name.slice(0, separator)}%2f${encodeURIComponent(name.slice(separator + 1))}`;
}

function parseIntegrity(value: unknown, label: string): DigestMap {
  if (value === undefined || value === null) return new Map();
  if (typeof value !== 'string' || value.length === 0) fail('operation', `${label} is malformed`);
  const lengths: Readonly<Record<DigestAlgorithm, number>> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  const claims: DigestMap = new Map();
  for (const token of value.split(/\s+/)) {
    const claim = token.split('?', 1)[0];
    if (claim === undefined) fail('operation', `${label} is malformed`);
    const separator = claim.indexOf('-');
    const algorithm = claim.slice(0, separator);
    const digest = claim.slice(separator + 1);
    if (!isDigestAlgorithm(algorithm) || !/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) fail('operation', `${label} contains an unsupported integrity token`);
    const bytes = Buffer.from(digest, 'base64');
    if (bytes.length !== lengths[algorithm] || bytes.toString('base64') !== digest) fail('operation', `${label} contains a malformed ${algorithm} digest`);
    const hex = bytes.toString('hex');
    const prior = claims.get(algorithm);
    if (prior !== undefined && prior !== hex) fail('conflict', `${label} contains conflicting ${algorithm} integrity claims`);
    claims.set(algorithm, hex);
  }
  return claims;
}

function isDigestAlgorithm(value: string): value is DigestAlgorithm {
  return value === 'sha1' || value === 'sha256' || value === 'sha384' || value === 'sha512';
}

function digestValue(digests: ReadonlyMap<DigestAlgorithm, string>, algorithm: DigestAlgorithm): string {
  const digest = digests.get(algorithm);
  if (digest === undefined) fail('operation', `could not calculate ${algorithm} digest`);
  return digest;
}

function mergeClaims(records: readonly PackageRecord[], metadata: VerifiedVersionMetadata): { claims: DigestMap; legacySha1Only: boolean } {
  const claims: DigestMap = new Map();
  const sources: Array<readonly [string, unknown]> = records.map(record => [`lockfile integrity for ${record.name}@${record.version}`, record.integrity]);
  sources.push(['upstream metadata integrity', metadata.dist.integrity]);
  for (const [label, integrity] of sources) {
    for (const [algorithm, digest] of parseIntegrity(integrity, label)) {
      const prior = claims.get(algorithm);
      if (prior !== undefined && prior !== digest) fail('conflict', `upstream ${algorithm} integrity conflicts for ${metadata.name}@${metadata.version}`);
      claims.set(algorithm, digest);
    }
  }
  if (metadata.dist.shasum !== undefined) {
    if (typeof metadata.dist.shasum !== 'string' || !/^[a-f0-9]{40}$/.test(metadata.dist.shasum)) fail('operation', 'upstream shasum is malformed');
    const prior = claims.get('sha1');
    if (prior !== undefined && prior !== metadata.dist.shasum) fail('conflict', `upstream SHA-1 integrity conflicts for ${metadata.name}@${metadata.version}`);
    claims.set('sha1', metadata.dist.shasum);
  }
  if (claims.size === 0) fail('operation', `upstream supplied no integrity claim for ${metadata.name}@${metadata.version}`);
  const legacySha1Only = [...claims.keys()].every(algorithm => algorithm === 'sha1');
  return { claims, legacySha1Only };
}

function lockClaims(records: readonly PackageRecord[]): DigestMap {
  const claims: DigestMap = new Map();
  for (const record of records) {
    for (const [algorithm, digest] of parseIntegrity(record.integrity, `lockfile integrity for ${record.name}@${record.version}`)) {
      const prior = claims.get(algorithm);
      if (prior !== undefined && prior !== digest) fail('conflict', `lockfiles disagree about ${algorithm} for ${record.name}@${record.version}`);
      claims.set(algorithm, digest);
    }
  }
  return claims;
}

function validatePlatformClaims(records: readonly PackageRecord[], metadata: Record<string, unknown>): void {
  const fields: readonly (keyof PlatformConstraints)[] = ['os', 'cpu', 'libc'];
  for (const record of records) {
    for (const field of fields) {
      const locked = record.platform[field];
      if (locked === null) continue;
      const upstream = metadata[field];
      const normalized = upstream === undefined ? null : [...new Set(Array.isArray(upstream) ? upstream : [upstream])].sort((left, right) => {
        const leftText = String(left);
        const rightText = String(right);
        return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
      });
      if (normalized === null || JSON.stringify([...locked].sort()) !== JSON.stringify(normalized)) {
        fail('conflict', `${String(metadata.name)}@${String(metadata.version)} upstream ${field} metadata conflicts with the lockfile`);
      }
    }
  }
}

function supportsTarget(platform: PlatformConstraints, target: TargetConfig): boolean {
  const valuesByField: ReadonlyArray<readonly [keyof PlatformConstraints, string | undefined]> = [
    ['os', target.os],
    ['cpu', target.cpu],
    ['libc', 'libc' in target ? target.libc : undefined],
  ];
  for (const [field, value] of valuesByField) {
    const values = platform[field];
    if (values === null || value === null || value === undefined) continue;
    const excluded = values.filter(item => item.startsWith('!')).map(item => item.slice(1));
    const included = values.filter(item => !item.startsWith('!'));
    if (excluded.includes(value) || (included.length > 0 && !included.includes(value))) return false;
  }
  return true;
}

function groupPackages(inventory: Inventory, config: MynpmConfig): PackageTask[] {
  const targetById = new Map(config.targets.map(target => [target.id, target]));
  const artifactsByIdentity = new Map(inventory.artifacts.map(item => [`${item.name}\0${item.version}`, item]));
  const packages = new Map<string, PackageTaskBase>();
  for (const project of inventory.projects) {
    for (const record of project.packages) {
      if (record.sourceKind === 'local') continue;
      if (record.sourceKind !== 'registry') fail('input', `fetch rejects ${record.sourceKind} source ${record.name}${record.version ? `@${record.version}` : ''}`);
      if (record.version === null) fail('input', `fetch requires an exact version for ${record.name}`);
      const targets = record.targets.map(id => {
        const target = targetById.get(id);
        if (!target) fail('input', `inventory package ${record.name}@${record.version} references unknown target ${id}`);
        return target;
      }).filter(target => supportsTarget(record.platform, target));
      if (targets.length === 0) continue;
      const key = `${record.name}\0${record.version}`;
      const found = packages.get(key) ?? {
        name: record.name,
        version: record.version,
        records: [],
        targets: new Map<string, TargetConfig>(),
        upstreamRegistry: config.upstreamRegistry,
      };
      found.records.push(record);
      for (const target of targets) found.targets.set(target.id, target);
      packages.set(key, found);
    }
  }
  return [...packages.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
    .map(task => {
      const artifactRecord = artifactsByIdentity.get(`${task.name}\0${task.version}`);
      if (artifactRecord === undefined) return { ...task, artifactRecord: null, artifact: null };
      return { ...task, artifactRecord, artifact: artifactRecord.artifact };
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') continue;
    if (isUnknownArray(current)) {
      for (const item of current) pending.push(item);
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) pending.push(item);
    } else {
      return false;
    }
  }
  return true;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateMetadataResponse(value: JsonValue, task: PackageTask): MetadataResult {
  if (!isJsonObject(value) || value.name !== task.name || !isJsonObject(value.versions)) {
    fail('operation', `upstream package metadata does not match ${task.name}`);
  }
  const metadata = value.versions[task.version];
  if (!isJsonObject(metadata) || metadata.name !== task.name || metadata.version !== task.version) {
    fail('operation', `upstream metadata is missing exact version ${task.name}@${task.version}`);
  }
  if (!isJsonObject(metadata.dist)) fail('operation', `upstream metadata has no tarball for ${task.name}@${task.version}`);
  if (typeof metadata.dist.tarball !== 'string') {
    fail('operation', `upstream metadata has no tarball for ${task.name}@${task.version}`);
  }
  const tarballUrl = validateSourceUrl(metadata.dist.tarball, new URL(task.upstreamRegistry).hostname).href;
  const packument: PackumentMetadata = {
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'versions')),
    name: task.name,
  };
  const verifiedMetadata: VerifiedVersionMetadata = {
    ...metadata,
    name: task.name,
    version: task.version,
    dist: { ...metadata.dist, tarball: metadata.dist.tarball },
  };
  return { packument, metadata: verifiedMetadata, tarballUrl };
}

function digesters(): Map<DigestAlgorithm, Hash> {
  return new Map<DigestAlgorithm, Hash>([
    ['sha1', createHash('sha1')],
    ['sha256', createHash('sha256')],
    ['sha384', createHash('sha384')],
    ['sha512', createHash('sha512')],
  ]);
}

function digestValues(hashers: Map<DigestAlgorithm, Hash>): DigestMap {
  return new Map([...hashers].map(([algorithm, hasher]) => [algorithm, hasher.digest('hex')]));
}

function checkDigests(expected: ReadonlyMap<DigestAlgorithm, string>, actual: ReadonlyMap<DigestAlgorithm, string>, identity: string): void {
  for (const [algorithm, digest] of expected) {
    if (actual.get(algorithm) !== digest) fail('conflict', `${algorithm === 'sha512' ? 'SHA-512' : algorithm.toUpperCase()} integrity mismatch for ${identity}`);
  }
}

function objectPath(stateDirectory: string, digest: string): string {
  return join(stateDirectory, 'objects', 'sha512', `${digest}.tgz`);
}

function ensureDirectory(directory: string, category: ErrorCategory = 'operation'): Effect.Effect<void, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    yield* tryPromise(() => mkdir(directory, { recursive: true, mode: 0o700 }), cause => asMynpmError(cause, category, `could not prepare managed directory ${directory}`));
    const info = yield* tryPromise(() => lstat(directory), cause => asMynpmError(cause, category, `could not inspect managed directory ${directory}`));
    if (!info.isDirectory() || info.isSymbolicLink()) return yield* Effect.fail(new MynpmError(category, `managed directory is not a real directory: ${directory}`));
    const handle = yield* Effect.acquireRelease(
      tryPromise(() => open(directory, 'r'), cause => asMynpmError(cause, category, `could not open managed directory ${directory}`)),
      value => tryPromise(() => value.close(), cause => asMynpmError(cause, category, `could not close managed directory ${directory}`)).pipe(Effect.orDie),
    );
    yield* tryPromise(() => handle.chmod(0o700), cause => asMynpmError(cause, category, `could not set managed directory permissions ${directory}`));
  }));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (errorCode(cause) === 'ESRCH') return false;
    if (errorCode(cause) === 'EPERM') return true;
    throw cause;
  }
}

function cleanInterruptedStaging(stagingRoot: string): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const entries = yield* tryPromise(
      () => readdir(stagingRoot, { withFileTypes: true }),
      cause => asMynpmError(cause, 'operation', `could not inspect private staging directory ${stagingRoot}`),
    );
    yield* Effect.forEach(entries, entry => {
      if (!entry.isDirectory()) return Effect.void;
      const match = /^mynpm-fetch-(\d+)-[A-Za-z0-9_-]+$/.exec(entry.name);
      if (!match || processIsAlive(Number(match[1]))) return Effect.void;
      return tryPromise(() => rm(join(stagingRoot, entry.name), { recursive: true, force: true }), cause => asMynpmError(cause, 'operation', `could not remove interrupted staging directory ${entry.name}`));
    }, { concurrency: 1, discard: true });
  });
}

function inspectObject(
  path: string,
  task: PackageTask,
  metadata: VerifiedVersionMetadata,
  expectedClaims: ReadonlyMap<DigestAlgorithm, string>,
  category: ErrorCategory,
): Effect.Effect<{ bytes: number; digests: DigestMap; inspected: InspectedPackageArchive }, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    const info = yield* tryPromise(() => lstat(path), cause => asMynpmError(cause, category, `could not verify stored artifact ${task.name}@${task.version}`));
    if (!info.isFile() || info.isSymbolicLink()) return yield* Effect.fail(new MynpmError(category, `stored artifact is not a regular file: ${path}`));
    if (info.size > limits.tarballBytes) return yield* Effect.fail(new MynpmError(category, `stored artifact exceeds the ${formatBytes(limits.tarballBytes)} compressed size limit: ${task.name}@${task.version}`));
    const handle = yield* Effect.acquireRelease(
      tryPromise(() => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), cause => asMynpmError(cause, category, `could not verify stored artifact ${task.name}@${task.version}`)),
      value => tryPromise(() => value.close(), cause => asMynpmError(cause, category, `could not close stored artifact ${task.name}@${task.version}`)).pipe(Effect.orDie),
    );
    const hashers = digesters();
    let bytes = 0;
    const readStream = yield* Effect.acquireRelease(
      Effect.sync(() => handle.createReadStream({ autoClose: false })),
      value => Effect.sync(() => { value.destroy(); }),
    );
    const stream = Stream.fromAsyncIterable(
      readStream,
      cause => asMynpmError(cause, category, `could not read stored artifact ${task.name}@${task.version}`),
    );
    yield* Stream.runForEach(stream, chunk => Effect.try({
      try: () => {
        bytes += chunk.length;
        if (bytes > limits.tarballBytes) fail(category, `stored artifact exceeds the ${formatBytes(limits.tarballBytes)} compressed size limit: ${task.name}@${task.version}`);
        for (const hasher of hashers.values()) hasher.update(chunk);
      },
      catch: cause => asMynpmError(cause, category, `could not verify stored artifact ${task.name}@${task.version}`),
    }));
    const actual = digestValues(hashers);
    yield* Effect.try({ try: () => checkDigests(expectedClaims, actual, `${task.name}@${task.version}`), catch: cause => asMynpmError(cause, category, `could not verify stored artifact ${task.name}@${task.version}`) });
    if (task.artifact && actual.get('sha512') !== task.artifact.sha512) return yield* Effect.fail(new MynpmError(category, `stored artifact SHA-512 does not match inventory for ${task.name}@${task.version}`));
    if (metadata.dist.shasum && actual.get('sha1') !== metadata.dist.shasum) return yield* Effect.fail(new MynpmError(category, `stored artifact SHA-1 does not match metadata for ${task.name}@${task.version}`));
    const inspected = yield* Effect.mapError(
      inspectPackageArchive(path, { name: task.name, version: task.version }),
      cause => cause.category === category ? cause : new MynpmError(category, `stored package archive is invalid for ${task.name}@${task.version}`, { cause }),
    );
    yield* Effect.try({ try: () => validatePlatformClaims(task.records, inspected.manifest), catch: cause => asMynpmError(cause, category, `stored package metadata conflicts for ${task.name}@${task.version}`) });
    yield* Effect.try({ try: () => validatePlatformClaims(task.records, metadata), catch: cause => asMynpmError(cause, category, `stored package metadata conflicts for ${task.name}@${task.version}`) });
    return { bytes, digests: actual, inspected };
  }));
}

function hasObject(path: string): Effect.Effect<Stats | null, MynpmError> {
  return tryPromise(
    () => lstat(path),
    cause => errorCode(cause) === 'ENOENT' ? new MynpmError('operation', `object does not exist: ${path}`, { cause }) : asMynpmError(cause, 'operation', `could not inspect stored artifact ${path}`),
  ).pipe(Effect.catchIf(error => errorCode(error.cause) === 'ENOENT', () => Effect.succeed(null)));
}

function assertSafeObjectDirectories(stateDirectory: string, category: ErrorCategory): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    for (const directory of [join(stateDirectory, 'objects'), join(stateDirectory, 'objects', 'sha512')]) {
      const exists = yield* tryPromise(
        () => lstat(directory),
        cause => errorCode(cause) === 'ENOENT'
          ? new MynpmError('operation', `object store directory is missing: ${directory}`, { cause })
          : asMynpmError(cause, category, `could not inspect object store directory ${directory}`),
      ).pipe(Effect.catchIf(error => errorCode(error.cause) === 'ENOENT', () => Effect.succeed(null)));
      if (exists === null) return;
      if (!exists.isDirectory() || exists.isSymbolicLink()) return yield* Effect.fail(new MynpmError(category, `object store directory is not a real directory: ${directory}`));
    }
  });
}

function fetchMetadata(task: PackageTask, {
  signal,
  expectedHost,
  exchange,
  resolver,
  countBytes,
  scheduleTimeout,
  clearScheduledTimeout,
}: Pick<AcquisitionContext, 'signal' | 'expectedHost' | 'exchange' | 'resolver' | 'countBytes' | 'scheduleTimeout' | 'clearScheduledTimeout'>): Effect.Effect<MetadataResult, MynpmError> {
  return Effect.gen(function*() {
    const url = yield* trySync(() => new URL(packageRoute(task.name), task.upstreamRegistry), cause => asMynpmError(cause, 'operation', `could not create metadata URL for ${task.name}`));
    const chunks: Buffer[] = [];
    yield* transfer(url, {
      maxBytes: limits.metadataBytes,
      signal,
      expectedHost,
      exchange,
      resolver,
      countBytes,
      scheduleTimeout,
      clearScheduledTimeout,
      consume: chunk => Effect.sync(() => { chunks.push(Buffer.from(chunk)); }),
    });
    const value = yield* Effect.try({
      try: () => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const parsed: unknown = JSON.parse(text);
        return parsed;
      },
      catch: cause => asMynpmError(cause, 'operation', `upstream metadata is not valid UTF-8 JSON for ${task.name}`),
    });
    if (!isJsonValue(value)) return yield* Effect.fail(new MynpmError('operation', `upstream metadata is not valid UTF-8 JSON for ${task.name}`));
    return yield* Effect.try({ try: () => validateMetadataResponse(value, task), catch: cause => asMynpmError(cause, 'operation', `upstream metadata is invalid for ${task.name}`) });
  });
}

interface DownloadedStage {
  stagePath: string;
  digest: string;
  digests: DigestMap;
  byteCount: number;
  inspected: InspectedPackageArchive;
}

function writeStage(
  stagePath: string,
  task: TaskWithMetadata,
  tarballUrl: string | URL,
  expectedClaims: ReadonlyMap<DigestAlgorithm, string>,
  context: AcquisitionContext,
): Effect.Effect<DownloadedStage, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    let completed = false;
    let handleClosed = false;
    const handle = yield* Effect.acquireRelease(
      tryPromise(() => open(stagePath, 'wx', 0o600), cause => asMynpmError(cause, 'operation', `could not create staged tarball for ${task.name}@${task.version}`)),
      value => Effect.gen(function*() {
        if (!handleClosed) {
          yield* tryPromise(() => value.close(), cause => asMynpmError(cause, 'operation', `could not close staged tarball for ${task.name}@${task.version}`)).pipe(Effect.orDie);
          handleClosed = true;
        }
        if (!completed) {
          yield* Effect.orDie(Effect.tryPromise({
            try: () => unlink(stagePath).catch(cause => {
              if (errorCode(cause) !== 'ENOENT') throw cause;
            }),
            catch: cause => cause,
          }));
        }
      }),
    );
    const hashers = digesters();
    let byteCount = 0;
    const result = yield* transfer(tarballUrl, {
      maxBytes: limits.tarballBytes,
      signal: context.signal,
      expectedHost: context.expectedHost,
      exchange: context.exchange,
      resolver: context.resolver,
      countBytes: context.countBytes,
      scheduleTimeout: context.scheduleTimeout,
      clearScheduledTimeout: context.clearScheduledTimeout,
      consume: chunk => Effect.gen(function*() {
        byteCount += chunk.length;
        for (const hasher of hashers.values()) hasher.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const writeResult = yield* Effect.uninterruptible(tryPromise(
            () => handle.write(chunk, offset, chunk.length - offset),
            cause => asMynpmError(cause, 'operation', `could not stage tarball for ${task.name}@${task.version}`),
          ));
          offset += writeResult.bytesWritten;
        }
      }),
    });
    if (byteCount === 0 || result.bytes !== byteCount) return yield* Effect.fail(new MynpmError('operation', `upstream returned an empty tarball for ${task.name}@${task.version}`));
    yield* tryPromise(() => handle.sync(), cause => asMynpmError(cause, 'operation', `could not sync staged tarball for ${task.name}@${task.version}`));
    const digests = digestValues(hashers);
    yield* Effect.try({ try: () => checkDigests(expectedClaims, digests, `${task.name}@${task.version}`), catch: cause => asMynpmError(cause, 'conflict', `tarball integrity mismatch for ${task.name}@${task.version}`) });
    const info = yield* tryPromise(() => lstat(stagePath), cause => asMynpmError(cause, 'operation', `could not inspect staged tarball for ${task.name}@${task.version}`));
    if (info.size !== byteCount) return yield* Effect.fail(new MynpmError('operation', `staged tarball size changed for ${task.name}@${task.version}`));
    yield* tryPromise(() => handle.close(), cause => asMynpmError(cause, 'operation', `could not close staged tarball for ${task.name}@${task.version}`));
    handleClosed = true;
    const inspected = yield* Effect.mapError(
      inspectPackageArchive(stagePath, { name: task.name, version: task.version }),
      cause => new MynpmError('operation', `could not inspect package archive for ${task.name}@${task.version}: ${cause.message}`, { cause }),
    );
    yield* Effect.try({ try: () => validatePlatformClaims(task.records, inspected.manifest), catch: cause => asMynpmError(cause, 'conflict', `staged package metadata conflicts for ${task.name}@${task.version}`) });
    yield* Effect.try({ try: () => validatePlatformClaims(task.records, task.metadata), catch: cause => asMynpmError(cause, 'conflict', `upstream package metadata conflicts for ${task.name}@${task.version}`) });
    completed = true;
    return { stagePath, digest: digestValue(digests, 'sha512'), digests, byteCount, inspected };
  }));
}

function acquirePackage(task: PackageTask, context: AcquisitionContext): Effect.Effect<PackageResult, MynpmError> {
  return Effect.gen(function*() {
  yield* assertSafeObjectDirectories(context.stateDirectory, 'operation');
  let metadata: VerifiedVersionMetadata;
  let packument: PackumentMetadata;
  let claims: DigestMap;
  let legacySha1Only: boolean;
  if (task.artifact !== null) {
    metadata = task.artifactRecord.metadata;
    packument = task.artifactRecord.packument;
    const expected = yield* trySync(() => mergeClaims(task.records, metadata), cause => asMynpmError(cause, 'corrupt', `inventory integrity is invalid for ${task.name}@${task.version}`));
    if (expected.legacySha1Only && !context.allowLegacySha1Only) return yield* Effect.fail(new MynpmError('corrupt', `inventory records SHA-1-only metadata for ${task.name}@${task.version}`));
    const expectedClaims = new Map(expected.claims);
    const artifactSha512 = expectedClaims.get('sha512');
    if (artifactSha512 !== undefined && artifactSha512 !== task.artifact.sha512) return yield* Effect.fail(new MynpmError('conflict', `stored digest conflicts with lockfile for ${task.name}@${task.version}`));
    expectedClaims.set('sha512', task.artifact.sha512);
    if (task.artifact.shasum !== null) expectedClaims.set('sha1', task.artifact.shasum);
    const path = objectPath(context.stateDirectory, task.artifact.sha512);
    if (yield* hasObject(path)) {
      yield* inspectObject(path, task, metadata, expectedClaims, 'corrupt');
      return { task, metadata, packument, artifact: task.artifact, stagePath: null, byteCount: 0, reused: true };
    }
    const tarballUrl = yield* trySync(() => validateSourceUrl(metadata.dist.tarball, context.expectedHost), cause => asMynpmError(cause, 'operation', `upstream tarball URL is invalid for ${task.name}@${task.version}`));
    const stagePath = join(context.stagingDirectory, `${randomUUID()}.part`);
    const downloaded = yield* writeStage(stagePath, { ...task, metadata }, tarballUrl, expectedClaims, context);
    if (downloaded.digest !== task.artifact.sha512) return yield* Effect.fail(new MynpmError('conflict', `refetched artifact digest changed for ${task.name}@${task.version}`));
    return { task, metadata, packument, artifact: task.artifact, stagePath, byteCount: downloaded.byteCount, reused: false };
  }

  const fetched = yield* fetchMetadata(task, context);
  metadata = fetched.metadata;
  packument = fetched.packument;
  yield* Effect.try({ try: () => validatePlatformClaims(task.records, metadata), catch: cause => asMynpmError(cause, 'conflict', `upstream package metadata conflicts for ${task.name}@${task.version}`) });
  const expected = yield* trySync(() => mergeClaims(task.records, metadata), cause => asMynpmError(cause, 'operation', `upstream integrity is invalid for ${task.name}@${task.version}`));
  claims = expected.claims;
  legacySha1Only = expected.legacySha1Only;
  if (legacySha1Only && !context.allowLegacySha1Only) return yield* Effect.fail(new MynpmError('operation', `refusing SHA-1-only integrity for ${task.name}@${task.version}; enable policy.allowLegacySha1Only only after audit`));
  const lockSha512 = yield* trySync(() => lockClaims(task.records).get('sha512'), cause => asMynpmError(cause, 'operation', `lockfile integrity is invalid for ${task.name}@${task.version}`));
  const metadataSha512 = claims.get('sha512');
  const expectedSha512 = metadataSha512 ?? lockSha512;
  const expectedClaims = new Map(claims);
  if (expectedSha512 !== undefined) expectedClaims.set('sha512', expectedSha512);
  const candidatePath = expectedSha512 === undefined ? null : objectPath(context.stateDirectory, expectedSha512);
  if (candidatePath !== null) {
    const existing = yield* hasObject(candidatePath);
    if (existing !== null) {
      const checked = yield* inspectObject(candidatePath, task, metadata, expectedClaims, 'corrupt');
      const sha512 = digestValue(checked.digests, 'sha512');
      const artifact: ArtifactVerification = {
        sha512,
        integrity: `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`,
        shasum: expectedClaims.has('sha1') ? digestValue(checked.digests, 'sha1') : null,
        sourceUrl: metadata.dist.tarball,
        legacySha1Only,
      };
      return { task, metadata, packument, artifact, stagePath: null, byteCount: 0, reused: true };
    }
  }
  const stagePath = join(context.stagingDirectory, `${randomUUID()}.part`);
  const downloaded = yield* writeStage(stagePath, { ...task, metadata }, fetched.tarballUrl, expectedClaims, context);
  const artifact: ArtifactVerification = {
    sha512: downloaded.digest,
    integrity: `sha512-${Buffer.from(downloaded.digest, 'hex').toString('base64')}`,
    shasum: expectedClaims.has('sha1') ? digestValue(downloaded.digests, 'sha1') : null,
    sourceUrl: metadata.dist.tarball,
    legacySha1Only,
  };
  return { task, metadata, packument, artifact, stagePath, byteCount: downloaded.byteCount, reused: false };
  });
}

function promoteArtifact(result: PackageResult, context: AcquisitionContext): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const stagePath = result.stagePath;
    if (stagePath === null) return;
    const destination = objectPath(context.stateDirectory, result.artifact.sha512);
    yield* ensureDirectory(join(context.stateDirectory, 'objects'));
    yield* ensureDirectory(join(context.stateDirectory, 'objects', 'sha512'));
    const linked = yield* tryPromise(
      () => link(stagePath, destination),
      cause => asMynpmError(cause, errorCode(cause) === 'EEXIST' ? 'conflict' : 'operation', `could not promote ${result.task.name}@${result.task.version}`),
    ).pipe(Effect.as(true), Effect.catchIf(error => errorCode(error.cause) === 'EEXIST', () => Effect.succeed(false)));
    if (!linked) {
      const expectedClaims: DigestMap = new Map([['sha512', result.artifact.sha512]]);
      if (result.artifact.shasum !== null) expectedClaims.set('sha1', result.artifact.shasum);
      const existing = yield* inspectObject(destination, result.task, result.metadata, expectedClaims, 'corrupt');
      if (existing.digests.get('sha512') !== result.artifact.sha512) return yield* Effect.fail(new MynpmError('conflict', `content-addressed object collision for ${result.artifact.sha512}`));
    }
    yield* tryPromise(() => unlink(stagePath), cause => asMynpmError(cause, 'operation', `could not remove staged tarball for ${result.task.name}@${result.task.version}`));
    result.stagePath = null;
  });
}

function hashDirectory(directory: string): Effect.Effect<void, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    const handle = yield* Effect.acquireRelease(
      tryPromise(() => open(directory, 'r'), cause => asMynpmError(cause, 'operation', `could not open artifact directory ${directory}`)),
      value => tryPromise(() => value.close(), cause => asMynpmError(cause, 'operation', `could not close artifact directory ${directory}`)).pipe(Effect.orDie),
    );
    yield* tryPromise(() => handle.sync(), cause => asMynpmError(cause, 'operation', `could not sync artifact directory ${directory}`));
  }));
}

interface OperationSignal {
  signal: AbortSignal;
  close(): void;
  abort(reason: unknown): void;
}

function makeOperationSignal(
  scheduleTimeout: TimeoutScheduler = setTimeout,
  clearScheduledTimeout: TimeoutClearer = clearTimeout,
): OperationSignal {
  const controller = new AbortController();
  const timeout = scheduleTimeout(() => {
    controller.abort(new MynpmError('operation', `fetch exceeded the ${formatDuration(limits.fetchMilliseconds)} operation limit`));
  }, limits.fetchMilliseconds);
  return {
    signal: controller.signal,
    close() {
      clearScheduledTimeout(timeout);
      if (!controller.signal.aborted) controller.abort(new MynpmError('cancelled', 'fetch completed'));
    },
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
  };
}

export function fetchInventory(
  { stateDirectory, config }: FetchInventoryOptions,
  dependencies: FetchDependencies = {},
): Effect.Effect<{ downloadedBytes: number; verifiedCount: number; reusedCount: number }, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    const exchange = dependencies.exchange ?? exchangeHttps;
    const resolver = dependencies.resolveAddresses ?? dnsLookup;
    const scheduleTimeout = dependencies.scheduleTimeout ?? setTimeout;
    const clearScheduledTimeout = dependencies.clearScheduledTimeout ?? clearTimeout;
    const inventory = yield* loadInventory(stateDirectory);
    const tasks = yield* Effect.try({ try: () => groupPackages(inventory, config), catch: cause => asMynpmError(cause, 'input', 'inventory contains an invalid package') });
    if (tasks.length === 0) return { downloadedBytes: 0, verifiedCount: 0, reusedCount: 0 };
    const operation = yield* Effect.acquireRelease(
      Effect.try({
        try: () => makeOperationSignal(scheduleTimeout, clearScheduledTimeout),
        catch: cause => asMynpmError(cause, 'operation', 'could not start fetch deadline'),
      }),
      value => Effect.sync(() => {
        value.abort(new MynpmError('cancelled', 'fetch was cancelled'));
        value.close();
      }),
    );
    const work = Effect.gen(function*() {
      const expectedHost = yield* Effect.try({
        try: () => new URL(config.upstreamRegistry).hostname,
        catch: cause => asMynpmError(cause, 'input', 'configured upstream registry is invalid'),
      });
      const budget = createFetchByteBudget();
      const countBytes = (count: number) => budget.consume(count);
      const stagingRoot = join(stateDirectory, 'tmp');
      yield* ensureDirectory(stagingRoot);
      yield* cleanInterruptedStaging(stagingRoot);
      const stagingDirectory = yield* Effect.acquireRelease(
        tryPromise(() => mkdtemp(join(stagingRoot, `mynpm-fetch-${process.pid}-`)), cause => asMynpmError(cause, 'operation', `could not create private staging directory under ${stagingRoot}`)),
        directory => tryPromise(() => rm(directory, { recursive: true, force: true }), cause => asMynpmError(cause, 'operation', `could not remove private staging directory ${directory}`)).pipe(Effect.orDie),
      );
      const context: AcquisitionContext = {
        stateDirectory,
        upstreamRegistry: config.upstreamRegistry,
        allowLegacySha1Only: config.policy.allowLegacySha1Only,
        signal: operation.signal,
        expectedHost,
        exchange,
        resolver,
        countBytes,
        scheduleTimeout,
        clearScheduledTimeout,
        stagingDirectory,
      };
      const results = yield* Effect.forEach(tasks, task => acquirePackage(task, context), { concurrency: limits.concurrentDownloads });
      yield* Effect.forEach(results, result => promoteArtifact(result, context), { concurrency: 1, discard: true });
      if (results.length > 0) yield* hashDirectory(join(stateDirectory, 'objects', 'sha512'));
      yield* updateInventory(stateDirectory, current => results.reduce((updated, result) => recordVerifiedArtifact(updated, {
          name: result.task.name,
          version: result.task.version,
          packument: result.packument,
          metadata: result.metadata,
          artifact: result.artifact,
        }), current));
      return { downloadedBytes: budget.usedBytes, verifiedCount: results.length, reusedCount: results.filter(result => result.reused).length };
    });
    return yield* Effect.raceFirst(work, abortWhen(operation.signal));
  }));
}

export function verifyInventorySnapshot(
  { stateDirectory, config, inventory }: VerifyInventorySnapshotOptions,
): Effect.Effect<{ verifiedCount: number }, MynpmError> {
  return Effect.gen(function*() {
    const tasks = yield* Effect.try({ try: () => groupPackages(inventory, config), catch: cause => asMynpmError(cause, 'corrupt', 'inventory contains an invalid package') });
    yield* assertSafeObjectDirectories(stateDirectory, 'corrupt');
    const verified = yield* Effect.forEach(tasks, task => Effect.gen(function*() {
      if (task.artifactRecord === null) return yield* Effect.fail(new MynpmError('corrupt', `no verified artifact is recorded for ${task.name}@${task.version}`));
      const record = task.artifactRecord;
      const artifact = task.artifact;
      const expected = yield* Effect.try({ try: () => mergeClaims(task.records, record.metadata).claims, catch: cause => asMynpmError(cause, 'corrupt', `inventory integrity is invalid for ${task.name}@${task.version}`) });
      expected.set('sha512', artifact.sha512);
      if (artifact.shasum !== null) expected.set('sha1', artifact.shasum);
      yield* inspectObject(objectPath(stateDirectory, artifact.sha512), task, record.metadata, expected, 'corrupt');
      yield* Effect.try({ try: () => validatePlatformClaims(task.records, record.metadata), catch: cause => asMynpmError(cause, 'corrupt', `inventory metadata is invalid for ${task.name}@${task.version}`) });
      return undefined;
    }), { concurrency: 1 });
    return { verifiedCount: verified.length };
  });
}

export function verifyInventory({ stateDirectory, config }: VerifyInventoryOptions): Effect.Effect<{ verifiedCount: number }, MynpmError> {
  return Effect.gen(function*() {
    const inventory = yield* loadInventory(stateDirectory);
    return yield* verifyInventorySnapshot({ stateDirectory, config, inventory });
  });
}
