import { constants } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, mkdtemp, open, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MynpmError } from './errors.mjs';
import { inspectPackageArchive } from './archive.mjs';
import { formatBytes, formatDuration, limits } from './limits.mjs';
import { createFetchByteBudget } from './fetch-budget.mjs';
import { loadInventory, updateInventory } from './inventory-store.mjs';
import { recordVerifiedArtifact } from './inventory.mjs';

const restrictedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) restrictedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2001:20::', 28], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) restrictedAddresses.addSubnet(address, prefix, 'ipv6');

function fail(category, message, options) {
  throw new MynpmError(category, message, options);
}

export function isRestrictedAddress(address, family) {
  const normalized = address.toLowerCase();
  return isIP(address) !== family || (family === 6 && normalized.startsWith('::ffff:')) || restrictedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function validateSourceUrl(value, expectedHost) {
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

async function publicAddresses(hostname, resolver = dnsLookup) {
  let addresses;
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new MynpmError('operation', `could not resolve upstream host ${hostname}`, { cause });
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address, family }) => isRestrictedAddress(address, family))) {
    fail('operation', `upstream host ${hostname} resolved to a non-public address`);
  }
  return addresses;
}

function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const requestedFamily = typeof options === 'number' ? options : options?.family ?? 0;
    const candidates = requestedFamily === 0 ? addresses : addresses.filter(item => item.family === requestedFamily);
    if (candidates.length === 0) {
      callback(Object.assign(new Error(`no verified DNS address for ${hostname}`), { code: 'ENOTFOUND' }));
      return;
    }
    if (typeof options === 'object' && options.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
}

function exchangeHttps(url, { signal, addresses }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishError = error => {
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

function responseLength(response, maximum) {
  const raw = response.headers['content-length'];
  if (raw === undefined) return;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) fail('operation', 'upstream returned an invalid Content-Length');
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > maximum) fail('operation', `upstream response exceeds the ${formatBytes(maximum)} limit`);
}

function closeResponse(response) {
  response.close?.();
  response.body.destroy?.();
}

function abortReason(signal, fallback) {
  return signal.reason instanceof Error ? signal.reason : fallback;
}

async function transfer(urlValue, { maxBytes, signal, expectedHost, exchange, resolver, consume, countBytes, scheduleTimeout = setTimeout, clearScheduledTimeout = clearTimeout }) {
  let url = validateSourceUrl(urlValue, expectedHost);
  for (let redirects = 0; ; redirects += 1) {
    if (signal.aborted) throw abortReason(signal, new MynpmError('cancelled', 'fetch was cancelled'));
    url = validateSourceUrl(url, expectedHost);
    const requestController = new AbortController();
    const onAbort = () => requestController.abort(abortReason(signal, new MynpmError('cancelled', 'fetch was cancelled')));
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = scheduleTimeout(() => requestController.abort(new MynpmError('operation', `upstream request exceeded the ${formatDuration(limits.requestMilliseconds)} limit`)), limits.requestMilliseconds);
    let response;
    try {
      const addresses = await publicAddresses(url.hostname, resolver);
      if (requestController.signal.aborted) throw abortReason(requestController.signal, new MynpmError('cancelled', 'fetch was cancelled'));
      response = await exchange(url, { signal: requestController.signal, addresses });
      if (requestController.signal.aborted) throw abortReason(requestController.signal, new MynpmError('cancelled', 'fetch was cancelled'));
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        closeResponse(response);
        if (redirects >= limits.redirects) fail('operation', `upstream exceeded the ${limits.redirects} redirect limit`);
        if (typeof location !== 'string' || location.length === 0) fail('operation', 'upstream redirect omitted Location');
        url = validateSourceUrl(new URL(location, url), expectedHost);
        continue;
      }
      if (status !== 200) fail('operation', `upstream returned HTTP ${String(status)} for ${url.href}`);
      responseLength(response, maxBytes);
      let received = 0;
      for await (const chunk of response.body) {
        if (requestController.signal.aborted) throw abortReason(requestController.signal, new MynpmError('cancelled', 'fetch was cancelled'));
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > maxBytes) fail('operation', `upstream response exceeds the ${formatBytes(maxBytes)} limit`);
        countBytes(bytes.length);
        await consume(bytes);
      }
      return { bytes: received, url };
    } catch (cause) {
      if (requestController.signal.aborted) throw abortReason(requestController.signal, cause);
      throw cause;
    } finally {
      clearScheduledTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (response) closeResponse(response);
    }
  }
}

function packageRoute(name) {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const separator = name.indexOf('/');
  return `${name.slice(0, separator)}%2f${encodeURIComponent(name.slice(separator + 1))}`;
}

function parseIntegrity(value, label) {
  if (value === undefined || value === null) return new Map();
  if (typeof value !== 'string' || value.length === 0) fail('operation', `${label} is malformed`);
  const lengths = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  const claims = new Map();
  for (const token of value.split(/\s+/)) {
    const [claim] = token.split('?', 1);
    const separator = claim.indexOf('-');
    const algorithm = claim.slice(0, separator);
    const digest = claim.slice(separator + 1);
    if (!Object.hasOwn(lengths, algorithm) || !/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) fail('operation', `${label} contains an unsupported integrity token`);
    const bytes = Buffer.from(digest, 'base64');
    if (bytes.length !== lengths[algorithm] || bytes.toString('base64') !== digest) fail('operation', `${label} contains a malformed ${algorithm} digest`);
    const hex = bytes.toString('hex');
    const prior = claims.get(algorithm);
    if (prior !== undefined && prior !== hex) fail('conflict', `${label} contains conflicting ${algorithm} integrity claims`);
    claims.set(algorithm, hex);
  }
  return claims;
}

function mergeClaims(records, metadata) {
  const claims = new Map();
  const sources = records.map(record => [`lockfile integrity for ${record.name}@${record.version}`, record.integrity]);
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

function lockClaims(records) {
  const claims = new Map();
  for (const record of records) {
    for (const [algorithm, digest] of parseIntegrity(record.integrity, `lockfile integrity for ${record.name}@${record.version}`)) {
      const prior = claims.get(algorithm);
      if (prior !== undefined && prior !== digest) fail('conflict', `lockfiles disagree about ${algorithm} for ${record.name}@${record.version}`);
      claims.set(algorithm, digest);
    }
  }
  return claims;
}

function validatePlatformClaims(records, metadata) {
  for (const record of records) {
    for (const field of ['os', 'cpu', 'libc']) {
      const locked = record.platform[field];
      if (locked === null) continue;
      const upstream = metadata[field];
      const normalized = upstream === undefined ? null : [...new Set(Array.isArray(upstream) ? upstream : [upstream])].sort();
      if (normalized === null || JSON.stringify([...locked].sort()) !== JSON.stringify(normalized)) {
        fail('conflict', `${metadata.name}@${metadata.version} upstream ${field} metadata conflicts with the lockfile`);
      }
    }
  }
}

function supportsTarget(platform, target) {
  for (const [field, value] of [['os', target.os], ['cpu', target.cpu], ['libc', target.libc]]) {
    const values = platform[field];
    if (values === null || value === null || value === undefined) continue;
    const excluded = values.filter(item => item.startsWith('!')).map(item => item.slice(1));
    const included = values.filter(item => !item.startsWith('!'));
    if (excluded.includes(value) || (included.length > 0 && !included.includes(value))) return false;
  }
  return true;
}

function groupPackages(inventory, config) {
  const targetById = new Map(config.targets.map(target => [target.id, target]));
  const artifactsByIdentity = new Map(inventory.artifacts.map(item => [`${item.name}\0${item.version}`, item]));
  const packages = new Map();
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
      const found = packages.get(key) ?? { name: record.name, version: record.version, records: [], targets: new Map() };
      found.records.push(record);
      for (const target of targets) found.targets.set(target.id, target);
      packages.set(key, found);
    }
  }
  return [...packages.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
    .map(task => {
      task.artifactRecord = artifactsByIdentity.get(`${task.name}\0${task.version}`) ?? null;
      task.artifact = task.artifactRecord?.artifact ?? null;
      return task;
    });
}

function validateMetadataResponse(value, task) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== task.name || !value.versions || typeof value.versions !== 'object' || Array.isArray(value.versions)) {
    fail('operation', `upstream package metadata does not match ${task.name}`);
  }
  const metadata = value.versions[task.version];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.name !== task.name || metadata.version !== task.version) {
    fail('operation', `upstream metadata is missing exact version ${task.name}@${task.version}`);
  }
  if (!metadata.dist || typeof metadata.dist !== 'object' || Array.isArray(metadata.dist) || typeof metadata.dist.tarball !== 'string') {
    fail('operation', `upstream metadata has no tarball for ${task.name}@${task.version}`);
  }
  const tarballUrl = validateSourceUrl(metadata.dist.tarball, new URL(task.upstreamRegistry).hostname).href;
  const packument = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'versions'));
  return { packument, metadata, tarballUrl };
}

function digesters() {
  return new Map(['sha1', 'sha256', 'sha384', 'sha512'].map(algorithm => [algorithm, createHash(algorithm)]));
}

function digestValues(hashers) {
  return new Map([...hashers].map(([algorithm, hasher]) => [algorithm, hasher.digest('hex')]));
}

function checkDigests(expected, actual, identity) {
  for (const [algorithm, digest] of expected) {
    if (actual.get(algorithm) !== digest) fail('conflict', `${algorithm === 'sha512' ? 'SHA-512' : algorithm.toUpperCase()} integrity mismatch for ${identity}`);
  }
}

function objectPath(stateDirectory, digest) {
  return join(stateDirectory, 'objects', 'sha512', `${digest}.tgz`);
}

async function ensureDirectory(directory, category = 'operation') {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(category, `managed directory is not a real directory: ${directory}`);
    const handle = await open(directory, 'r');
    try {
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (cause instanceof MynpmError) throw cause;
    throw new MynpmError(category, `could not prepare managed directory ${directory}`, { cause });
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause.code === 'ESRCH') return false;
    if (cause.code === 'EPERM') return true;
    throw cause;
  }
}

async function cleanInterruptedStaging(stagingRoot) {
  let entries;
  try {
    entries = await readdir(stagingRoot, { withFileTypes: true });
  } catch (cause) {
    throw new MynpmError('operation', `could not inspect private staging directory ${stagingRoot}`, { cause });
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^mynpm-fetch-(\d+)-[A-Za-z0-9_-]+$/.exec(entry.name);
    if (!match || processIsAlive(Number(match[1]))) continue;
    await rm(join(stagingRoot, entry.name), { recursive: true, force: true });
  }
}

async function inspectObject(path, task, metadata, expectedClaims, category) {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail(category, `stored artifact is not a regular file: ${path}`);
    if (info.size > limits.tarballBytes) fail(category, `stored artifact exceeds the ${formatBytes(limits.tarballBytes)} compressed size limit: ${task.name}@${task.version}`);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const hashers = digesters();
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > limits.tarballBytes) fail(category, `stored artifact exceeds the ${formatBytes(limits.tarballBytes)} compressed size limit: ${task.name}@${task.version}`);
      for (const hasher of hashers.values()) hasher.update(chunk);
    }
    const actual = digestValues(hashers);
    checkDigests(expectedClaims, actual, `${task.name}@${task.version}`);
    if (task.artifact && actual.get('sha512') !== task.artifact.sha512) fail(category, `stored artifact SHA-512 does not match inventory for ${task.name}@${task.version}`);
    if (metadata?.dist?.shasum && actual.get('sha1') !== metadata.dist.shasum) fail(category, `stored artifact SHA-1 does not match metadata for ${task.name}@${task.version}`);
    let inspected;
    try {
      inspected = await inspectPackageArchive(path, { name: task.name, version: task.version });
    } catch (cause) {
      if (cause instanceof MynpmError && cause.category === category) throw cause;
      throw new MynpmError(category, `stored package archive is invalid for ${task.name}@${task.version}`, { cause });
    }
    validatePlatformClaims(task.records, inspected.manifest);
    if (metadata) validatePlatformClaims(task.records, metadata);
    return { bytes, digests: actual, inspected };
  } catch (cause) {
    if (cause instanceof MynpmError) throw cause;
    throw new MynpmError(category, `could not verify stored artifact ${task.name}@${task.version}`, { cause });
  } finally {
    await handle?.close();
  }
}

async function hasObject(path) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
}

async function assertSafeObjectDirectories(stateDirectory, category) {
  for (const directory of [join(stateDirectory, 'objects'), join(stateDirectory, 'objects', 'sha512')]) {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) fail(category, `object store directory is not a real directory: ${directory}`);
    } catch (cause) {
      if (cause.code === 'ENOENT') return;
      if (cause instanceof MynpmError) throw cause;
      throw new MynpmError(category, `could not inspect object store directory ${directory}`, { cause });
    }
  }
}

async function fetchMetadata(task, { signal, expectedHost, exchange, resolver, countBytes, scheduleTimeout, clearScheduledTimeout }) {
  const url = new URL(packageRoute(task.name), task.upstreamRegistry);
  const chunks = [];
  await transfer(url, {
    maxBytes: limits.metadataBytes,
    signal,
    expectedHost,
    exchange,
    resolver,
    countBytes,
    scheduleTimeout,
    clearScheduledTimeout,
    async consume(chunk) { chunks.push(Buffer.from(chunk)); },
  });
  let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    value = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('operation', `upstream metadata is not valid UTF-8 JSON for ${task.name}`, { cause });
  }
  return validateMetadataResponse(value, task);
}

async function writeStage(stagePath, task, tarballUrl, expectedClaims, context) {
  const handle = await open(stagePath, 'wx', 0o600);
  const hashers = digesters();
  let byteCount = 0;
  let completed = false;
  try {
    const result = await transfer(tarballUrl, {
      maxBytes: limits.tarballBytes,
      signal: context.signal,
      expectedHost: context.expectedHost,
      exchange: context.exchange,
      resolver: context.resolver,
      countBytes: context.countBytes,
      scheduleTimeout: context.scheduleTimeout,
      clearScheduledTimeout: context.clearScheduledTimeout,
      async consume(chunk) {
        byteCount += chunk.length;
        for (const hasher of hashers.values()) hasher.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          offset += bytesWritten;
        }
      },
    });
    if (byteCount === 0 || result.bytes !== byteCount) fail('operation', `upstream returned an empty tarball for ${task.name}@${task.version}`);
    await handle.sync();
    const digests = digestValues(hashers);
    checkDigests(expectedClaims, digests, `${task.name}@${task.version}`);
    const info = await lstat(stagePath);
    if (info.size !== byteCount) fail('operation', `staged tarball size changed for ${task.name}@${task.version}`);
    await handle.close();
    let inspected;
    try {
      inspected = await inspectPackageArchive(stagePath, { name: task.name, version: task.version }, { signal: context.signal });
    } catch (cause) {
      throw new MynpmError('operation', cause.message, { cause });
    }
    validatePlatformClaims(task.records, inspected.manifest);
    validatePlatformClaims(task.records, task.metadata);
    completed = true;
    return { stagePath, digest: digests.get('sha512'), digests, byteCount, inspected };
  } finally {
    if (!handle.closed) await handle.close();
    if (!completed) await unlink(stagePath).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
  }
}

async function acquirePackage(task, context) {
  task.upstreamRegistry = context.upstreamRegistry;
  await assertSafeObjectDirectories(context.stateDirectory, 'operation');
  let metadata;
  let packument;
  let claims;
  let legacySha1Only;
  if (task.artifact !== null) {
    metadata = task.artifactRecord.metadata;
    packument = task.artifactRecord.packument;
    const expected = mergeClaims(task.records, metadata);
    if (expected.legacySha1Only && !context.allowLegacySha1Only) fail('corrupt', `inventory records SHA-1-only metadata for ${task.name}@${task.version}`);
    const expectedClaims = new Map(expected.claims);
    const artifactSha512 = expectedClaims.get('sha512');
    if (artifactSha512 !== undefined && artifactSha512 !== task.artifact.sha512) fail('conflict', `stored digest conflicts with lockfile for ${task.name}@${task.version}`);
    expectedClaims.set('sha512', task.artifact.sha512);
    if (task.artifact.shasum !== null) expectedClaims.set('sha1', task.artifact.shasum);
    const path = objectPath(context.stateDirectory, task.artifact.sha512);
    if (await hasObject(path)) {
      await inspectObject(path, task, metadata, expectedClaims, 'corrupt');
      return { task, metadata, packument, artifact: task.artifact, stagePath: null, byteCount: 0, reused: true };
    }
    const tarballUrl = validateSourceUrl(metadata.dist.tarball, context.expectedHost);
    const stagePath = join(context.stagingDirectory, `${randomUUID()}.part`);
    const downloaded = await writeStage(stagePath, { ...task, metadata }, tarballUrl, expectedClaims, context);
    if (downloaded.digest !== task.artifact.sha512) fail('conflict', `refetched artifact digest changed for ${task.name}@${task.version}`);
    return { task, metadata, packument, artifact: task.artifact, stagePath, byteCount: downloaded.byteCount, reused: false };
  }

  const fetched = await fetchMetadata(task, context);
  metadata = fetched.metadata;
  packument = fetched.packument;
  validatePlatformClaims(task.records, metadata);
  const expected = mergeClaims(task.records, metadata);
  claims = expected.claims;
  legacySha1Only = expected.legacySha1Only;
  if (legacySha1Only && !context.allowLegacySha1Only) fail('operation', `refusing SHA-1-only integrity for ${task.name}@${task.version}; enable policy.allowLegacySha1Only only after audit`);
  const lockSha512 = lockClaims(task.records).get('sha512');
  const metadataSha512 = claims.get('sha512');
  const expectedSha512 = metadataSha512 ?? lockSha512;
  const expectedClaims = new Map(claims);
  if (expectedSha512 !== undefined) expectedClaims.set('sha512', expectedSha512);
  const candidatePath = expectedSha512 === undefined ? null : objectPath(context.stateDirectory, expectedSha512);
  if (candidatePath !== null) {
    const existing = await hasObject(candidatePath);
    if (existing !== null) {
      const checked = await inspectObject(candidatePath, task, metadata, expectedClaims, 'corrupt');
      const artifact = {
        sha512: checked.digests.get('sha512'),
        integrity: `sha512-${Buffer.from(checked.digests.get('sha512'), 'hex').toString('base64')}`,
        shasum: expectedClaims.has('sha1') ? checked.digests.get('sha1') : null,
        sourceUrl: metadata.dist.tarball,
        legacySha1Only,
      };
      return { task, metadata, packument, artifact, stagePath: null, byteCount: 0, reused: true };
    }
  }
  const stagePath = join(context.stagingDirectory, `${randomUUID()}.part`);
  const downloaded = await writeStage(stagePath, { ...task, metadata }, fetched.tarballUrl, expectedClaims, context);
  const artifact = {
    sha512: downloaded.digest,
    integrity: `sha512-${Buffer.from(downloaded.digest, 'hex').toString('base64')}`,
    shasum: expectedClaims.has('sha1') ? downloaded.digests.get('sha1') : null,
    sourceUrl: metadata.dist.tarball,
    legacySha1Only,
  };
  return { task, metadata, packument, artifact, stagePath, byteCount: downloaded.byteCount, reused: false };
}

async function promoteArtifact(result, context) {
  if (result.stagePath === null) return;
  const destination = objectPath(context.stateDirectory, result.artifact.sha512);
  await ensureDirectory(join(context.stateDirectory, 'objects'));
  await ensureDirectory(join(context.stateDirectory, 'objects', 'sha512'));
  try {
    await link(result.stagePath, destination);
  } catch (cause) {
    if (cause.code !== 'EEXIST') throw new MynpmError('operation', `could not promote ${result.task.name}@${result.task.version}`, { cause });
    const existing = await inspectObject(destination, result.task, result.metadata, new Map([['sha512', result.artifact.sha512], ...(result.artifact.shasum === null ? [] : [['sha1', result.artifact.shasum]])]), 'corrupt');
    if (existing.digests.get('sha512') !== result.artifact.sha512) fail('conflict', `content-addressed object collision for ${result.artifact.sha512}`);
  }
  await unlink(result.stagePath);
  result.stagePath = null;
}

async function hashDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function makeOperationSignal(signal, scheduleTimeout = setTimeout, clearScheduledTimeout = clearTimeout) {
  const controller = new AbortController();
  const timeout = scheduleTimeout(() => {
    controller.abort(new MynpmError('operation', `fetch exceeded the ${formatDuration(limits.fetchMilliseconds)} operation limit`));
  }, limits.fetchMilliseconds);
  const relay = () => controller.abort(signal.reason instanceof MynpmError && signal.reason.category === 'cancelled'
    ? signal.reason
    : new MynpmError('cancelled', 'fetch was cancelled'));
  signal?.addEventListener('abort', relay, { once: true });
  if (signal?.aborted) relay();
  return {
    signal: controller.signal,
    close() {
      clearScheduledTimeout(timeout);
      signal?.removeEventListener('abort', relay);
    },
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
  };
}

export async function fetchInventory({ stateDirectory, config, signal }, dependencies = {}) {
  const exchange = dependencies.exchange ?? exchangeHttps;
  const resolver = dependencies.resolveAddresses ?? dnsLookup;
  const scheduleTimeout = dependencies.scheduleTimeout ?? setTimeout;
  const clearScheduledTimeout = dependencies.clearScheduledTimeout ?? clearTimeout;
  const inventory = await loadInventory(stateDirectory);
  const tasks = groupPackages(inventory, config);
  if (tasks.length === 0) return { downloadedBytes: 0, verifiedCount: 0, reusedCount: 0 };
  const operation = makeOperationSignal(signal, scheduleTimeout, clearScheduledTimeout);
  const expectedHost = new URL(config.upstreamRegistry).hostname;
  const budget = createFetchByteBudget();
  const countBytes = count => budget.consume(count);
  const stagingRoot = join(stateDirectory, 'tmp');
  let stagingDirectory;
  try {
    await ensureDirectory(stagingRoot);
    await cleanInterruptedStaging(stagingRoot);
    stagingDirectory = await mkdtemp(join(stagingRoot, `mynpm-fetch-${process.pid}-`));
    const context = {
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
    let firstFailure;
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length && !operation.signal.aborted) {
        const task = tasks[cursor];
        cursor += 1;
        try {
          results.push(await acquirePackage(task, context));
        } catch (cause) {
          firstFailure ??= cause;
          operation.abort(cause);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limits.concurrentDownloads, tasks.length) }, worker));
    if (firstFailure) throw firstFailure;
    if (operation.signal.aborted) throw abortReason(operation.signal, new MynpmError('cancelled', 'fetch was cancelled'));
    for (const result of results) await promoteArtifact(result, context);
    if (results.length > 0) await hashDirectory(join(stateDirectory, 'objects', 'sha512'));
    await updateInventory(stateDirectory, current => results.reduce((updated, result) => recordVerifiedArtifact(updated, {
      name: result.task.name,
      version: result.task.version,
      packument: result.packument,
      metadata: result.metadata,
      artifact: result.artifact,
    }), current));
    return { downloadedBytes: budget.usedBytes, verifiedCount: results.length, reusedCount: results.filter(result => result.reused).length };
  } finally {
    operation.close();
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function verifyInventorySnapshot({ stateDirectory, config, inventory }) {
  const tasks = groupPackages(inventory, config);
  await assertSafeObjectDirectories(stateDirectory, 'corrupt');
  let verifiedCount = 0;
  for (const task of tasks) {
    if (task.artifactRecord === null) fail('corrupt', `no verified artifact is recorded for ${task.name}@${task.version}`);
    const record = task.artifactRecord;
    const expected = mergeClaims(task.records, record.metadata).claims;
    expected.set('sha512', task.artifact.sha512);
    if (task.artifact.shasum !== null) expected.set('sha1', task.artifact.shasum);
    await inspectObject(objectPath(stateDirectory, task.artifact.sha512), task, record.metadata, expected, 'corrupt');
    validatePlatformClaims(task.records, record.metadata);
    verifiedCount += 1;
  }
  return { verifiedCount };
}

export async function verifyInventory({ stateDirectory, config }) {
  const inventory = await loadInventory(stateDirectory);
  return verifyInventorySnapshot({ stateDirectory, config, inventory });
}
