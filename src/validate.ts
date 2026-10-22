import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Effect } from 'effect';
import { errorCode, MynpmError, type ErrorCategory } from './errors.ts';
import type { MynpmConfig, TargetConfig } from './config.ts';
import type { ArtifactRecord, Inventory, PackageManager, PackageRecord, ProjectRecord, ProjectSnapshot } from './inventory.ts';
import { loadInventory } from './inventory-store.ts';
import { parseNpmLock } from './lock-npm.ts';
import { parsePnpmLock } from './lock-pnpm.ts';
import { managerVersions } from './resolve.ts';
import { publishSite } from './publish.ts';
import { assertRestorableProjectSnapshot } from './project-snapshot.ts';
import { runProcess, type ProcessResult } from './process.ts';
import { limits } from './limits.ts';

type SelectedPackage = { identity: string; integrity: string };
type StaticRequest = {
  method: string | undefined;
  target: string;
  pathname: string;
  prefix: string | null;
  status: number | null;
  contentType: string | null;
  responseBytes: number;
  responseSha512: string | null;
  complete: boolean;
};
type StaticServer = { server: Server; requests: StaticRequest[]; port: number };
type StaticServerResource = { server: Server; requests: StaticRequest[] };
type ValidationDependencies = { runProcess?: typeof runProcess };
type InstallDependencies = ValidationDependencies & { artifacts: readonly ArtifactRecord[] };
type LockParseOptions = {
  projectId: string;
  packageManagerPin: string | null;
  lockfilePath: string;
  targetIds: readonly string[];
  snapshot: ProjectSnapshot | null;
};
type JsonObject = Record<string, unknown>;
type InstalledPackageReport = { roots: JsonObject[]; nodes: JsonObject[] };

const clientTimeoutMilliseconds = 60 * 60 * 1000;

function asMynpmError(cause: unknown, category: ErrorCategory, message: string): MynpmError {
  return cause instanceof MynpmError ? cause : new MynpmError(category, message, { cause });
}

function syncEffect<A>(operation: () => A, category: ErrorCategory = 'operation', message = 'validation failed'): Effect.Effect<A, MynpmError> {
  return Effect.try({
    try: operation,
    catch: cause => asMynpmError(cause, category, message),
  });
}

function promiseEffect<A>(operation: () => Promise<A>, category: ErrorCategory, message: string): Effect.Effect<A, MynpmError> {
  return Effect.tryPromise({
    try: operation,
    catch: cause => asMynpmError(cause, category, message),
  });
}

function processEffect(
  dependencies: ValidationDependencies,
  command: string,
  args: readonly string[],
  options: Parameters<typeof runProcess>[2],
): Effect.Effect<ProcessResult, MynpmError> {
  const run = dependencies.runProcess ?? runProcess;
  return run(command, args, options);
}

function fail(category: ErrorCategory, message: string, options?: ErrorOptions): never {
  throw new MynpmError(category, message, options);
}

function targetForCurrentPlatform(config: MynpmConfig): TargetConfig {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const cpu = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  let libc: 'glibc' | 'musl' | null = null;
  if (os === 'linux') {
    const report: unknown = process.report?.getReport();
    const header = isRecord(report) ? report.header : undefined;
    libc = isRecord(header) && header.glibcVersionRuntime ? 'glibc' : 'musl';
  }
  const target = config.targets.find(item => item.os === os && item.cpu === cpu && ('libc' in item ? item.libc === libc : libc === null));
  if (!target) fail('input', `the current platform is not a configured target: ${os ?? process.platform}/${cpu ?? process.arch}/${libc ?? ''}`);
  return target;
}

function supportsPlatformValue(values: readonly string[] | null, value: string | undefined): boolean {
  if (values === null || value === undefined) return true;
  const excluded = values.filter(item => item.startsWith('!')).map(item => item.slice(1));
  const included = values.filter(item => !item.startsWith('!'));
  return !excluded.includes(value) && (included.length === 0 || included.includes(value));
}

function supportsTarget(platform: PackageRecord['platform'], target: TargetConfig): boolean {
  return supportsPlatformValue(platform.os, target.os)
    && supportsPlatformValue(platform.cpu, target.cpu)
    && supportsPlatformValue(platform.libc, 'libc' in target ? target.libc : undefined);
}

function packageSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || 'project';
}

function integrityKey(value: string | null, artifactRecord: ArtifactRecord | undefined, identity: string): string {
  if (artifactRecord === undefined) fail('corrupt', `no verified artifact is available for ${identity}`);
  const expected = new Map([['sha512', artifactRecord.artifact.sha512]]);
  if (artifactRecord.artifact.shasum !== null) expected.set('sha1', artifactRecord.artifact.shasum);
  if (value !== null) {
    for (const token of value.split(/\s+/)) {
      const [claim] = token.split('?', 1);
      const separator = claim.indexOf('-');
      const algorithm = claim.slice(0, separator);
      const digest = claim.slice(separator + 1);
      const expectedDigest = expected.get(algorithm);
      if (expectedDigest === undefined || Buffer.from(digest, 'base64').toString('hex') !== expectedDigest) {
        fail('conflict', `${algorithm || 'unknown'} integrity does not match verified artifact for ${identity}`);
      }
    }
  }
  return artifactRecord.artifact.integrity;
}

function packageSelection(
  project: Pick<ProjectRecord, 'packages'>,
  target: TargetConfig,
  artifacts: readonly ArtifactRecord[],
  { allowLocalHost = false, localOrigin }: { allowLocalHost?: boolean; localOrigin?: string } = {},
): SelectedPackage[] {
  const artifactByIdentity = new Map(artifacts.map(record => [`${record.name}\0${record.version}`, record]));
  const selected = new Map<string, SelectedPackage>();
  for (const item of project.packages) {
    if (item.version === null || item.sourceKind === 'local' || !supportsTarget(item.platform, target)) continue;
    if (!allowLocalHost && item.sourceKind !== 'registry') continue;
    if (allowLocalHost) {
      if (item.sourceKind === 'git') fail('conflict', `validation lock contains a git source for ${item.name}@${item.version}`);
      if (item.resolved !== null) {
        let resolved;
        try {
          resolved = new URL(item.resolved);
        } catch (cause) {
          throw new MynpmError('conflict', `validation lock contains an invalid source for ${item.name}@${item.version}`, { cause });
        }
        if (resolved.origin !== localOrigin) fail('conflict', `validation lock resolved ${item.name}@${item.version} outside the local static site`);
      }
    }
    const identity = `${item.name}@${item.version}`;
    const key = `${identity}\0${integrityKey(item.integrity, artifactByIdentity.get(`${item.name}\0${item.version}`), identity)}`;
    selected.set(key, { identity, integrity: key.slice(key.indexOf('\0') + 1) });
  }
  return [...selected.values()].sort((left, right) => left.identity.localeCompare(right.identity) || left.integrity.localeCompare(right.integrity));
}

function compareSelections(expected: readonly SelectedPackage[], actual: readonly SelectedPackage[], projectId: string, manager: PackageManager): void {
  const key = (item: SelectedPackage): string => `${item.identity}\0${item.integrity}`;
  const expectedSet = new Set(expected.map(key));
  const actualSet = new Set(actual.map(key));
  const missing = [...expectedSet].filter(item => !actualSet.has(item)).sort();
  const extra = [...actualSet].filter(item => !expectedSet.has(item)).sort();
  if (missing.length > 0 || extra.length > 0) {
    fail('conflict', `${manager} validation changed package/version/integrity selections for ${projectId}; missing ${missing.length}, added ${extra.length}`);
  }
}

function clientEnvironment(workspace: string, registry: string, cacheDirectory: string): NodeJS.ProcessEnv {
  const environment = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C',
    LC_ALL: 'C',
    HOME: join(workspace, 'home'),
    TMPDIR: resolve(process.cwd(), '.work', 'tmp'),
    XDG_CONFIG_HOME: join(workspace, 'config'),
    COREPACK_HOME: join(workspace, 'corepack'),
    CI: 'true',
    npm_config_userconfig: join(workspace, 'user.npmrc'),
    npm_config_globalconfig: join(workspace, 'global.npmrc'),
    npm_config_registry: registry,
    npm_config_cache: cacheDirectory,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '0',
    pnpm_config_ignore_pnpmfile: 'true',
    pnpm_config_store_dir: join(workspace, 'pnpm-store'),
    pnpm_config_pm_on_fail: 'ignore',
    pnpm_config_trust_lockfile: 'true',
  };
  return environment;
}

function createClientEnvironment(workspace: string, registry: string, cacheDirectory: string): Effect.Effect<NodeJS.ProcessEnv, MynpmError> {
  return Effect.gen(function*() {
    for (const directory of [join(workspace, 'home'), join(workspace, 'config'), cacheDirectory, join(workspace, 'pnpm-store')]) {
      yield* promiseEffect(() => mkdir(directory, { recursive: true, mode: 0o700 }), 'operation', `could not create validation directory ${directory}`);
    }
    yield* promiseEffect(
      () => writeFile(join(workspace, 'user.npmrc'), `registry=${registry}\naudit=false\nfund=false\nignore-scripts=true\n`),
      'operation',
      `could not write validation npm configuration in ${workspace}`,
    );
    yield* promiseEffect(() => writeFile(join(workspace, 'global.npmrc'), ''), 'operation', `could not write validation npm configuration in ${workspace}`);
    return clientEnvironment(workspace, registry, cacheDirectory);
  });
}

function safeStaticPath(pathname: string, mountPrefix: string): string[] | null {
  if (mountPrefix !== '/' && !pathname.startsWith(mountPrefix)) return null;
  const relativePath = mountPrefix === '/' ? pathname.slice(1) : pathname.slice(mountPrefix.length);
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || segment.includes('\\'))) return null;
  return segments;
}

function createStaticServer(mirrorDirectory: string): StaticServerResource {
  const requests: StaticRequest[] = [];
  const server = createServer((request, response) => {
    const target = request.url ?? '';
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(target, 'http://127.0.0.1').pathname);
    } catch {
      pathname = target;
    }
    const prefix = pathname.startsWith('/mirror/')
      ? '/mirror/'
      : pathname.startsWith('/current/') || pathname.startsWith('/tarballs/')
        ? '/'
        : null;
    const record: StaticRequest = {
      method: request.method,
      target,
      pathname,
      prefix,
      status: null,
      contentType: null,
      responseBytes: 0,
      responseSha512: null,
      complete: false,
    };
    requests.push(record);
    response.once('finish', () => { record.complete = true; });
    const send = (status: number, contentType: string | null = null, body: Buffer | null = null, cacheControl?: string): void => {
      record.status = status;
      record.contentType = contentType;
      const responseBody = request.method === 'HEAD' ? null : body;
      record.responseBytes = responseBody?.byteLength ?? 0;
      record.responseSha512 = responseBody === null ? null : createHash('sha512').update(responseBody).digest('hex');
      response.writeHead(status, {
        ...(contentType === null ? {} : { 'Content-Type': contentType }),
        ...(cacheControl === undefined ? {} : { 'Cache-Control': cacheControl }),
        ...(body === null ? {} : { 'Content-Length': body.byteLength }),
      });
      response.end(responseBody ?? undefined);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(405);
      return;
    }
    if (request.url === undefined) {
      send(400);
      return;
    }
    if (prefix === null) {
      send(404);
      return;
    }
    const segments = safeStaticPath(pathname, prefix);
    if (segments === null || segments.length === 0) {
      send(404);
      return;
    }
    const isLegacyTarball = segments[0] === 'tarballs' && segments.length === 2;
    const isNestedTarball = segments[0] === 'current' && segments[1] === '-' && segments[2] === 'tarballs' && segments.length === 4;
    const isRendererTwoTarball = segments[0] === 'current' && segments[1] === 'tarballs' && segments.length === 3;
    const isMetadata = segments[0] === 'current' && segments.length >= 2 && segments[1] !== '-';
    if (!isLegacyTarball && !isNestedTarball && !isRendererTwoTarball && !isMetadata) {
      send(404);
      return;
    }
    const filePath = resolve(mirrorDirectory, ...segments);
    const pathFromRoot = relative(mirrorDirectory, filePath);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
      send(404);
      return;
    }
    const serveFile = Effect.gen(function*() {
      const bytes = yield* promiseEffect(() => readFile(filePath), 'operation', `could not read local registry file ${filePath}`);
      yield* syncEffect(() => {
        const metadataResponse = isMetadata;
        send(200, metadataResponse ? 'application/json' : 'application/octet-stream', bytes, metadataResponse ? 'no-cache' : 'public, max-age=31536000, immutable');
      }, 'operation', `could not respond to local registry request ${pathname}`);
    });
    void Effect.runPromise(serveFile).catch(cause => {
      if (response.destroyed) return;
      const originalCause = cause instanceof MynpmError ? cause.cause : cause;
      try {
        send(errorCode(originalCause) === 'ENOENT' ? 404 : 500);
      } catch (responseCause) {
        response.destroy(responseCause instanceof Error ? responseCause : undefined);
      }
    });
  });
  return { server, requests };
}

function listenStaticServer(resource: StaticServerResource): Effect.Effect<StaticServer, MynpmError> {
  return Effect.tryPromise({
    try: signal => new Promise<StaticServer>((resolveListen, rejectListen) => {
      const onError = (cause: Error): void => {
        cleanup();
        rejectListen(cause);
      };
      const onListening = (): void => {
        cleanup();
        const address = resource.server.address();
        if (address === null || typeof address === 'string') {
          rejectListen(new MynpmError('operation', 'local validation server did not bind to a TCP port'));
          return;
        }
        resolveListen({ ...resource, port: address.port });
      };
      const cleanup = (): void => {
        resource.server.removeListener('error', onError);
        resource.server.removeListener('listening', onListening);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        rejectListen(new MynpmError('cancelled', 'local validation server startup was interrupted'));
      };
      resource.server.once('error', onError);
      resource.server.once('listening', onListening);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        resource.server.listen(0, '127.0.0.1');
      } catch (cause) {
        cleanup();
        rejectListen(cause);
      }
    }),
    catch: cause => asMynpmError(cause, 'operation', 'could not start local validation server'),
  });
}

function closeStaticServer(resource: StaticServerResource): Effect.Effect<void, MynpmError> {
  return promiseEffect(() => new Promise<void>((resolveClose, rejectClose) => {
    resource.server.closeAllConnections();
    resource.server.close(cause => {
      if (cause && errorCode(cause) !== 'ERR_SERVER_NOT_RUNNING') rejectClose(cause);
      else resolveClose();
    });
  }), 'operation', 'could not close local validation server');
}

function checkClientVersion(
  client: PackageManager,
  target: TargetConfig,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  dependencies: ValidationDependencies,
): Effect.Effect<string, MynpmError> {
  return Effect.gen(function*() {
    const expected = managerVersions[client];
    if (process.version !== `v${target.node}`) {
      return yield* Effect.fail(new MynpmError('operation', `${client} validation requires Node.js ${target.node}; found ${process.version}`));
    }
    const result = yield* processEffect(dependencies, client, ['--version'], { cwd, env: environment, timeoutMs: 30_000 });
    const version = result.stdout.trim().split(/\s+/)[0];
    if (version !== expected) return yield* Effect.fail(new MynpmError('operation', `${client} ${expected} is required for validation; found ${version || 'no version output'}`));
    return version;
  });
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string, category: ErrorCategory): JsonObject {
  if (!isRecord(value)) fail(category, `${label} must be an object`);
  return value;
}

function parseJson(text: string, label: string, category: ErrorCategory): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (cause) {
    throw new MynpmError(category, `${label} is not valid JSON`, { cause });
  }
}

function canonicalValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail('corrupt', 'lock data contains a recursive structure');
    ancestors.add(value);
    const canonical = value.map(item => canonicalValue(item, ancestors));
    ancestors.delete(value);
    return canonical;
  }
  if (!isRecord(value)) return value;
  if (ancestors.has(value)) fail('corrupt', 'lock data contains a recursive structure');
  ancestors.add(value);
  const canonical = Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key], ancestors)]));
  ancestors.delete(value);
  return canonical;
}

function canonicalText(value: unknown): string {
  try {
    const text = JSON.stringify(canonicalValue(value));
    if (text === undefined) fail('corrupt', 'lock data is not JSON serializable');
    return text;
  } catch (cause) {
    if (cause instanceof MynpmError) throw cause;
    throw new MynpmError('corrupt', 'lock data is not JSON serializable', { cause });
  }
}

function pnpmDocuments(text: string): Effect.Effect<{ yaml: typeof import('yaml'); values: unknown[] }, MynpmError> {
  return Effect.gen(function*() {
    const yaml = yield* promiseEffect(
      () => import('yaml'),
      'operation',
      'pnpm validation requires the pinned yaml@2.9.1 dependency; install locked project dependencies',
    );
    const documents = yield* syncEffect(() => yaml.parseAllDocuments(text, { uniqueKeys: true }), 'input', 'pnpm lockfile is not valid YAML');
    return yield* syncEffect(() => {
      const errors = documents.flatMap(document => document.errors);
      if (errors.length > 0) throw new MynpmError('input', `pnpm lockfile contains invalid YAML: ${errors[0].message}`, { cause: errors[0] });
      try {
        return { yaml, values: documents.map(document => document.toJS({ maxAliasCount: 100 })) };
      } catch (cause) {
        throw new MynpmError('input', 'pnpm lockfile could not be decoded from YAML', { cause });
      }
    }, 'input', 'pnpm lockfile could not be decoded from YAML');
  });
}

function parseProjectLock(manager: PackageManager, text: string, options: LockParseOptions): Effect.Effect<ProjectRecord, MynpmError> {
  if (manager === 'npm') {
    return syncEffect(() => {
      const lock = parseJson(text, 'npm package-lock.json', 'input');
      try {
        return parseNpmLock(lock, options);
      } catch (cause) {
        throw asMynpmError(cause, 'input', 'could not parse npm package-lock.json');
      }
    }, 'input', 'could not parse npm package-lock.json');
  }
  return parsePnpmLock(text, options);
}

function projectWithoutSnapshot(project: ProjectRecord): Omit<ProjectRecord, 'snapshot'> & { snapshot: null } {
  return { ...project, snapshot: null };
}

function workspaceFileMap(snapshot: ProjectSnapshot): Map<string, string> {
  return new Map(snapshot.workspaceFiles.map(file => [file.path, file.contents]));
}

function safeLocalPath(value: string): string | null {
  const normalized = value.replace(/^file:/, '').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
  return normalized;
}

function projectSnapshot(project: ProjectRecord): ProjectSnapshot & { manifest: string } {
  const snapshot = project.snapshot;
  if (snapshot === null) fail('input', `validation requires an imported package.json snapshot for ${project.id}`);
  return { ...snapshot, manifest: snapshot.manifest ?? fail('input', `validation requires an imported package.json snapshot for ${project.id}`) };
}

function npmLockPackages(lock: JsonObject, projectId: string): JsonObject {
  const packages = lock.packages;
  if (packages === undefined) fail('corrupt', `saved npm lockfile has no package entries for ${projectId}`);
  return requireRecord(packages, `saved npm lockfile packages for ${projectId}`, 'corrupt');
}

function pnpmPackageEntries(document: unknown, label: string): Array<[string, JsonObject]> {
  const lock = requireRecord(document, label, 'corrupt');
  if (lock.packages === undefined) return [];
  const packages = requireRecord(lock.packages, `${label}.packages`, 'corrupt');
  return Object.entries(packages).map(([key, entry]) => [key, requireRecord(entry, `${label}.packages[${JSON.stringify(key)}]`, 'corrupt')]);
}

function pnpmPackageEntry(document: unknown, key: string, label: string): JsonObject | undefined {
  const lock = requireRecord(document, label, 'corrupt');
  if (lock.packages === undefined) return undefined;
  const packages = requireRecord(lock.packages, `${label}.packages`, 'corrupt');
  const entry = packages[key];
  return entry === undefined ? undefined : requireRecord(entry, `${label}.packages[${JSON.stringify(key)}]`, 'corrupt');
}

function assertSnapshotRestorable(project: ProjectRecord): Effect.Effect<void, MynpmError> {
  return syncEffect(() => {
    const snapshot = projectSnapshot(project);
    const files = workspaceFileMap(snapshot);
    if (project.manager === 'npm') {
      const lock = requireRecord(parseJson(snapshot.lockfile, `saved npm lockfile for ${project.id}`, 'corrupt'), `saved npm lockfile for ${project.id}`, 'corrupt');
      for (const entryValue of Object.values(lock.packages === undefined ? {} : npmLockPackages(lock, project.id))) {
        const entry = requireRecord(entryValue, `saved npm lockfile package for ${project.id}`, 'corrupt');
        if (entry.link !== true || typeof entry.resolved !== 'string') continue;
        const workspacePath = safeLocalPath(entry.resolved);
        if (workspacePath === null || !files.has(`${workspacePath}/package.json`)) {
          fail('input', `validation cannot restore local workspace ${entry.resolved} for ${project.id}`);
        }
      }
      for (const item of project.packages) {
        if (item.sourceKind === 'local' && item.flags.link !== true && item.version !== null) {
          fail('input', `validation cannot restore local file package ${item.name}@${item.version} for ${project.id}`);
        }
      }
    } else {
      const importers = project.importers.filter(importer => importer !== '.');
      for (const importer of importers) {
        if (!files.has(`${importer}/package.json`)) fail('input', `validation cannot restore pnpm workspace importer ${importer} for ${project.id}`);
      }
      if (importers.length > 0 && !files.has('pnpm-workspace.yaml')) {
        fail('input', `validation cannot restore pnpm workspace configuration for ${project.id}`);
      }
      for (const item of project.packages) {
        if (item.sourceKind === 'local' && item.flags.link !== true && item.version !== null) {
          fail('input', `validation cannot restore local pnpm package ${item.name}@${item.version} for ${project.id}`);
        }
      }
    }
  }, 'input', `saved project snapshot is not restorable for ${project.id}`);
}

function assertSnapshotMatchesProject(project: ProjectRecord, target: TargetConfig): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    yield* assertSnapshotRestorable(project);
    const snapshot = yield* syncEffect(() => projectSnapshot(project), 'input', `validation requires an imported snapshot for ${project.id}`);
    yield* syncEffect(() => assertRestorableProjectSnapshot(project.manager, snapshot), 'input', `saved project configuration is not restorable for ${project.id}`);
    const restored = yield* parseProjectLock(project.manager, snapshot.lockfile, {
      projectId: project.id,
      packageManagerPin: project.packageManagerPin,
      lockfilePath: project.lockfilePath,
      targetIds: project.targets,
      snapshot: null,
    });
    return yield* syncEffect(() => {
      if (canonicalText(projectWithoutSnapshot(restored)) !== canonicalText(projectWithoutSnapshot(project))) {
        fail('corrupt', `saved ${project.manager} lockfile no longer matches imported project ${project.id}`);
      }
      const manifest = requireRecord(parseJson(snapshot.manifest, `saved package.json for ${project.id}`, 'corrupt'), `saved package.json for ${project.id}`, 'corrupt');
      if ((manifest.packageManager ?? null) !== project.packageManagerPin) {
        fail('corrupt', `saved package.json pin no longer matches imported project ${project.id}`);
      }
      const expectedPackageManagerPin = `${project.manager}@${managerVersions[project.manager]}`;
      if (project.packageManagerPin !== null && project.packageManagerPin.replace(/\+sha512\..*$/, '') !== expectedPackageManagerPin) {
        fail('input', `validation requires ${expectedPackageManagerPin}; project ${project.id} is pinned to ${project.packageManagerPin}`);
      }
      const unsupported = project.packages.find(item => item.version !== null && supportsTarget(item.platform, target) && item.sourceKind !== 'registry' && item.sourceKind !== 'local');
      if (unsupported) fail('input', `validation rejects ${unsupported.sourceKind} source ${unsupported.name}@${unsupported.version}`);
    }, 'corrupt', `saved project snapshot does not match ${project.id}`);
  });
}

function packageArtifact(project: ProjectRecord, item: PackageRecord, artifacts: readonly ArtifactRecord[]): ArtifactRecord {
  const artifact = artifacts.find(record => record.name === item.name && record.version === item.version);
  integrityKey(item.integrity, artifact, `${item.name}@${item.version}`);
  if (artifact === undefined) fail('corrupt', `no verified artifact is available for ${item.name}@${item.version}`);
  return artifact;
}

function localTarballUrl(registry: string, digest: string): string {
  return new URL(`-/tarballs/${digest}.tgz`, registry).href;
}

function unavailableTarballUrl(registry: string): string {
  return new URL('-/tarballs/unavailable.tgz', registry).href;
}

function rewriteNpmLock(project: ProjectRecord, target: TargetConfig, artifacts: readonly ArtifactRecord[], registry: string): Effect.Effect<string, MynpmError> {
  return syncEffect(() => {
    const snapshot = projectSnapshot(project);
    const lock = requireRecord(parseJson(snapshot.lockfile, `saved npm lockfile for ${project.id}`, 'corrupt'), `saved npm lockfile for ${project.id}`, 'corrupt');
    const packages = npmLockPackages(lock, project.id);
    for (const item of project.packages) {
      if (item.version === null || item.sourceKind === 'local') continue;
      if (item.sourceKind !== 'registry') fail('input', `validation cannot migrate ${item.sourceKind} source ${item.name}@${item.version}`);
      const entry = packages[item.key];
      if (!isRecord(entry)) fail('corrupt', `saved npm lockfile is missing ${item.key}`);
      entry.resolved = supportsTarget(item.platform, target)
        ? localTarballUrl(registry, packageArtifact(project, item, artifacts).artifact.sha512)
        : unavailableTarballUrl(registry);
    }
    rewriteNpmLegacyDependencies(lock, project, target, artifacts, registry);
    return `${JSON.stringify(lock, null, 2)}\n`;
  }, 'corrupt', `could not migrate saved npm lockfile for ${project.id}`);
}

function rewriteNpmLegacyDependencies(
  lock: JsonObject,
  project: ProjectRecord,
  target: TargetConfig,
  artifacts: readonly ArtifactRecord[],
  registry: string,
): void {
  if (lock.dependencies === undefined) return;
  const packageByKey = new Map(project.packages.map(item => [item.key, item]));
  const visit = (entries: unknown, parentPath: string): void => {
    const dependencies = requireRecord(entries, `saved npm legacy dependencies for ${project.id}`, 'corrupt');
    for (const [requestedName, rawEntry] of Object.entries(dependencies)) {
      const entry = requireRecord(rawEntry, `saved npm legacy dependency ${requestedName} for ${project.id}`, 'corrupt');
      const key = parentPath === ''
        ? `node_modules/${requestedName}`
        : `${parentPath}/node_modules/${requestedName}`;
      const item = packageByKey.get(key);
      if (item !== undefined && item.version !== null && item.sourceKind === 'registry') {
        entry.resolved = supportsTarget(item.platform, target)
          ? localTarballUrl(registry, packageArtifact(project, item, artifacts).artifact.sha512)
          : unavailableTarballUrl(registry);
      }
      if (entry.dependencies !== undefined) visit(entry.dependencies, key);
    }
  };
  visit(lock.dependencies, '');
}

function normalizeNpmLegacyDependencies(lock: JsonObject, project: ProjectRecord): void {
  if (lock.dependencies === undefined) return;
  const packageByKey = new Map(project.packages.map(item => [item.key, item]));
  const visit = (entries: unknown, parentPath: string): void => {
    const dependencies = requireRecord(entries, `npm legacy dependencies for ${project.id}`, 'corrupt');
    for (const [requestedName, rawEntry] of Object.entries(dependencies)) {
      const entry = requireRecord(rawEntry, `npm legacy dependency ${requestedName} for ${project.id}`, 'corrupt');
      const key = parentPath === ''
        ? `node_modules/${requestedName}`
        : `${parentPath}/node_modules/${requestedName}`;
      const item = packageByKey.get(key);
      if (item !== undefined && item.version !== null && item.sourceKind === 'registry') {
        entry.resolved = 'mynpm-local-tarball';
      }
      if (entry.dependencies !== undefined) visit(entry.dependencies, key);
    }
  };
  visit(lock.dependencies, '');
}

function rewritePnpmLock(project: ProjectRecord, target: TargetConfig, artifacts: readonly ArtifactRecord[], registry: string): Effect.Effect<string, MynpmError> {
  return Effect.gen(function*() {
    const snapshot = yield* syncEffect(() => projectSnapshot(project), 'input', `validation requires a saved snapshot for ${project.id}`);
    const { yaml, values } = yield* pnpmDocuments(snapshot.lockfile);
    return yield* syncEffect(() => {
      const packages = new Map(project.packages.map(item => [item.key, item]));
      for (const [documentIndex, document] of values.entries()) {
        for (const [key, entry] of pnpmPackageEntries(document, `saved pnpm lockfile document ${documentIndex}`)) {
          const item = packages.get(key);
          if (!item || item.version === null || item.sourceKind === 'local') continue;
          if (item.sourceKind !== 'registry') {
            if (supportsTarget(item.platform, target)) fail('input', `validation cannot migrate ${item.sourceKind} source ${item.name}@${item.version}`);
            continue;
          }
          const resolution = requireRecord(entry.resolution, `saved pnpm lockfile package resolution for ${item.name}@${item.version}`, 'corrupt');
          resolution.tarball = supportsTarget(item.platform, target)
            ? localTarballUrl(registry, packageArtifact(project, item, artifacts).artifact.sha512)
            : unavailableTarballUrl(registry);
        }
      }
      const documentMarker = /^\s*---(?:\s|$)/.test(snapshot.lockfile) ? '---\n' : '';
      return documentMarker + values.map(value => yaml.stringify(value).trimEnd()).join('\n---\n') + '\n';
    }, 'corrupt', `could not migrate saved pnpm lockfile for ${project.id}`);
  });
}

function assertMigrationPreservesGraph(project: ProjectRecord, migratedLock: string): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const snapshot = yield* syncEffect(() => projectSnapshot(project), 'input', `validation requires a saved snapshot for ${project.id}`);
    if (project.manager === 'npm') {
      yield* syncEffect(() => {
        const original = requireRecord(parseJson(snapshot.lockfile, `saved npm lockfile for ${project.id}`, 'corrupt'), `saved npm lockfile for ${project.id}`, 'corrupt');
        const migrated = requireRecord(parseJson(migratedLock, `migrated npm lockfile for ${project.id}`, 'corrupt'), `migrated npm lockfile for ${project.id}`, 'corrupt');
        const originalPackages = npmLockPackages(original, project.id);
        const migratedPackages = npmLockPackages(migrated, project.id);
        for (const item of project.packages) {
          if (item.version === null || item.sourceKind !== 'registry') continue;
          const originalEntry = originalPackages[item.key];
          const migratedEntry = migratedPackages[item.key];
          if (!isRecord(originalEntry) || !isRecord(migratedEntry)) fail('corrupt', `saved npm lockfile is missing ${item.key}`);
          originalEntry.resolved = 'mynpm-local-tarball';
          migratedEntry.resolved = 'mynpm-local-tarball';
        }
        normalizeNpmLegacyDependencies(original, project);
        normalizeNpmLegacyDependencies(migrated, project);
        if (canonicalText(original) !== canonicalText(migrated)) fail('conflict', `registry migration changed the saved npm dependency graph for ${project.id}`);
      }, 'conflict', `registry migration changed the saved npm dependency graph for ${project.id}`);
      return;
    }
    const original = (yield* pnpmDocuments(snapshot.lockfile)).values;
    const migrated = (yield* pnpmDocuments(migratedLock)).values;
    yield* syncEffect(() => {
      for (const item of project.packages) {
        if (item.version === null || item.sourceKind !== 'registry') continue;
        const originalEntries = original.map((document, index) => pnpmPackageEntry(document, item.key, `saved pnpm lockfile document ${index}`)).filter((entry): entry is JsonObject => entry !== undefined);
        const migratedEntries = migrated.map((document, index) => pnpmPackageEntry(document, item.key, `migrated pnpm lockfile document ${index}`)).filter((entry): entry is JsonObject => entry !== undefined);
        if (originalEntries.length === 0 || migratedEntries.length === 0) fail('corrupt', `saved pnpm lockfile is missing ${item.name}@${item.version}`);
        for (const entry of [...originalEntries, ...migratedEntries]) {
          const resolution = requireRecord(entry.resolution, `pnpm package resolution for ${item.name}@${item.version}`, 'corrupt');
          resolution.tarball = 'mynpm-local-tarball';
        }
      }
      if (canonicalText(original) !== canonicalText(migrated)) fail('conflict', `registry migration changed the saved pnpm dependency graph for ${project.id}`);
    }, 'conflict', `registry migration changed the saved pnpm dependency graph for ${project.id}`);
  });
}

function lockGraph(manager: PackageManager, text: string, project: ProjectRecord): Effect.Effect<unknown, MynpmError> {
  if (manager === 'npm') {
    return syncEffect(() => {
      const lock = requireRecord(parseJson(text, `npm package-lock.json for ${project.id}`, 'input'), `npm package-lock.json for ${project.id}`, 'input');
      const packages = npmLockPackages(lock, project.id);
      for (const item of project.packages) {
        if (item.version === null || item.sourceKind !== 'registry') continue;
        const entry = packages[item.key];
        if (!isRecord(entry)) fail('corrupt', `saved npm lockfile is missing ${item.key}`);
        entry.resolved = 'mynpm-local-tarball';
      }
      normalizeNpmLegacyDependencies(lock, project);
      return lock;
    }, 'input', `could not read npm lockfile for ${project.id}`);
  }
  return Effect.gen(function*() {
    const { values } = yield* pnpmDocuments(text);
    return yield* syncEffect(() => {
      for (const item of project.packages) {
        if (item.version === null || item.sourceKind !== 'registry') continue;
        const entries = values.map((document, index) => pnpmPackageEntry(document, item.key, `pnpm lockfile document ${index}`)).filter((entry): entry is JsonObject => entry !== undefined);
        if (entries.length === 0) fail('corrupt', `saved pnpm lockfile is missing ${item.key}`);
        for (const entry of entries) {
          const resolution = requireRecord(entry.resolution, `pnpm package resolution for ${item.name}@${item.version}`, 'corrupt');
          resolution.tarball = 'mynpm-local-tarball';
        }
      }
      return values;
    }, 'corrupt', `could not read pnpm lockfile for ${project.id}`);
  });
}

function assertLockfileMatches(manager: PackageManager, expectedText: string, actualText: string, project: ProjectRecord): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const expected = yield* lockGraph(manager, expectedText, project);
    const actual = yield* lockGraph(manager, actualText, project);
    yield* syncEffect(() => {
      if (canonicalText(expected) !== canonicalText(actual)) fail('conflict', `${manager} changed the saved dependency graph for ${project.id}`);
    }, 'conflict', `${manager} changed the saved dependency graph for ${project.id}`);
  });
}

type ExpectedInstance = { key: string; name: string; version: string; optional: boolean };
type InstallCoverage = { instanceCount: number; platformSkippedCount: number };

function packageReportNodes(value: unknown, output: JsonObject[] = [], seenPaths = new Set<string>(), topLevel = true, dependencyName?: string): JsonObject[] {
  if (Array.isArray(value)) {
    for (const item of value) packageReportNodes(item, output, seenPaths, true);
    return output;
  }
  if (!isRecord(value)) return output;
  const path = typeof value.path === 'string' ? value.path : null;
  const name = typeof value.name === 'string' ? value.name : dependencyName;
  if (!topLevel && name !== undefined && typeof value.version === 'string' && (path === null || !seenPaths.has(path))) {
    output.push({ ...value, name });
    if (path !== null) seenPaths.add(path);
  }
  if (isRecord(value.dependencies)) {
    for (const [childName, child] of Object.entries(value.dependencies)) {
      packageReportNodes(child, output, seenPaths, false, childName);
    }
  }
  return output;
}

function packageIdentityCounts(instances: readonly { name: string; version: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const instance of instances) {
    const identity = `${instance.name}\0${instance.version}`;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

function expectedPnpmInstances(project: ProjectRecord, target: TargetConfig): Effect.Effect<{ instances: ExpectedInstance[]; platformSkippedCount: number; platformSkippedIdentities: Set<string> }, MynpmError> {
  return Effect.gen(function*() {
    const snapshot = yield* syncEffect(() => projectSnapshot(project), 'input', `validation requires a saved snapshot for ${project.id}`);
    const { values } = yield* pnpmDocuments(snapshot.lockfile);
    return yield* syncEffect(() => {
      const packages = new Map(project.packages.map(item => [item.key.startsWith('/') ? item.key.slice(1) : item.key, item]));
      const snapshots = new Map<string, JsonObject>();
      for (const [documentIndex, document] of values.entries()) {
        const lock = requireRecord(document, `saved pnpm lockfile document ${documentIndex}`, 'corrupt');
        if (lock.snapshots === undefined) continue;
        for (const [key, value] of Object.entries(requireRecord(lock.snapshots, `saved pnpm lockfile document ${documentIndex}.snapshots`, 'corrupt'))) {
          snapshots.set(key.startsWith('/') ? key.slice(1) : key, requireRecord(value, `saved pnpm snapshot ${key}`, 'corrupt'));
        }
      }
      let platformSkippedCount = 0;
      const platformSkippedIdentities = new Set<string>();
      const instances: ExpectedInstance[] = [];
      for (const [key, snapshot] of snapshots) {
        const artifactKey = key.split('(', 1)[0];
        const item = packages.get(artifactKey);
        if (item === undefined) fail('corrupt', `saved pnpm snapshot has no package entry: ${key}`);
        if (item.version === null || item.sourceKind === 'local') continue;
        const optional = item.flags.optional || snapshot.optional === true;
        if (!supportsTarget(item.platform, target)) {
          if (!optional) fail('conflict', `required pnpm package ${item.name}@${item.version} does not support target ${target.id}`);
          platformSkippedCount += 1;
          platformSkippedIdentities.add(`${item.name}\0${item.version}`);
          continue;
        }
        instances.push({ key, name: item.name, version: item.version, optional });
      }
      return { instances, platformSkippedCount, platformSkippedIdentities };
    }, 'corrupt', `could not inspect saved pnpm installation graph for ${project.id}`);
  });
}

function expectedNpmInstances(project: ProjectRecord, target: TargetConfig): Effect.Effect<{ instances: ExpectedInstance[]; platformSkippedCount: number; platformSkippedIdentities: Set<string> }, MynpmError> {
  return syncEffect(() => {
    let platformSkippedCount = 0;
    const platformSkippedIdentities = new Set<string>();
    const instances: ExpectedInstance[] = [];
    for (const item of project.packages) {
      if (!item.key.startsWith('node_modules/') || item.version === null) continue;
      if (!supportsTarget(item.platform, target)) {
        if (!item.flags.optional) fail('conflict', `required npm package ${item.name}@${item.version} does not support target ${target.id}`);
        platformSkippedCount += 1;
        platformSkippedIdentities.add(`${item.name}\0${item.version}`);
        continue;
      }
      instances.push({ key: item.key, name: item.name, version: item.version, optional: item.flags.optional });
    }
    return { instances, platformSkippedCount, platformSkippedIdentities };
  }, 'corrupt', `could not inspect saved npm installation graph for ${project.id}`);
}

function inspectInstalledPackage(projectDirectory: string, instance: ExpectedInstance): Effect.Effect<{ name: string; version: string }, MynpmError> {
  return Effect.gen(function*() {
    const segments = instance.key.split('/');
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
      return yield* Effect.fail(new MynpmError('corrupt', `saved lockfile contains an unsafe installed package path: ${instance.key}`));
    }
    const packageDirectory = join(projectDirectory, ...segments);
    const resolvedDirectory = yield* promiseEffect(() => realpath(packageDirectory), 'conflict', `applicable ${instance.optional ? 'optional' : 'required'} package ${instance.name}@${instance.version} is missing from the installed tree at ${instance.key}`);
    const projectRoot = yield* promiseEffect(() => realpath(projectDirectory), 'operation', `could not resolve restored project directory ${projectDirectory}`);
    const pathFromRoot = relative(projectRoot, resolvedDirectory);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep)) {
      return yield* Effect.fail(new MynpmError('conflict', `installed package path leaves restored project: ${instance.key}`));
    }
    const packageJsonPath = join(resolvedDirectory, 'package.json');
    const packageJsonInfo = yield* promiseEffect(() => lstat(packageJsonPath), 'conflict', `installed package ${instance.name}@${instance.version} has no package.json at ${instance.key}`);
    if (!packageJsonInfo.isFile() || packageJsonInfo.isSymbolicLink()) {
      return yield* Effect.fail(new MynpmError('conflict', `installed package ${instance.name}@${instance.version} has an unsafe package.json at ${instance.key}`));
    }
    const text = yield* promiseEffect(() => readFile(packageJsonPath, 'utf8'), 'conflict', `could not read installed package ${instance.key}/package.json`);
    const manifest = yield* syncEffect(() => requireRecord(parseJson(text, `installed package ${instance.key}/package.json`, 'conflict'), `installed package ${instance.key}/package.json`, 'conflict'), 'conflict', `installed package ${instance.key} has invalid metadata`);
    const name = typeof manifest.name === 'string' ? manifest.name : '';
    const version = typeof manifest.version === 'string' ? manifest.version : '';
    if (name !== instance.name || version !== instance.version) {
      return yield* Effect.fail(new MynpmError('conflict', `installed package at ${instance.key} is ${name || 'unnamed'}@${version || 'unversioned'}, expected ${instance.name}@${instance.version}`));
    }
    return { name, version };
  });
}

function packageReport(client: PackageManager, projectDirectory: string, environment: NodeJS.ProcessEnv, dependencies: ValidationDependencies): Effect.Effect<InstalledPackageReport, MynpmError> {
  return Effect.gen(function*() {
    const args = client === 'npm'
      ? ['ls', '--all', '--json', '--long', '--ignore-scripts']
      : ['list', '--recursive', '--depth', 'Infinity', '--json', '--ignore-pnpmfile'];
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const result = yield* Effect.result(processEffect(dependencies, client, args, {
      cwd: projectDirectory,
      env: environment,
      timeoutMs: clientTimeoutMilliseconds,
      onStdout: chunk => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > limits.packageReportBytes) {
          fail('conflict', `${client} installed package report exceeds ${limits.packageReportBytes} bytes`);
        }
        stdoutChunks.push(Buffer.from(chunk));
      },
    }));
    if (result._tag === 'Failure') {
      const cause = result.failure;
      return yield* Effect.fail(new MynpmError('conflict', `${client} reported an invalid or incomplete installed dependency graph for ${projectDirectory}`, { cause }));
    }
    return yield* syncEffect(() => {
      const stdout = stdoutBytes === 0 ? result.success.stdout : Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      const report = parseJson(stdout, `${client} installed package report`, 'conflict');
      const roots = Array.isArray(report) ? report : [report];
      const problems = roots.flatMap(root => isRecord(root) && Array.isArray(root.problems) ? root.problems.filter(item => typeof item === 'string') : []);
      if (problems.length > 0) fail('conflict', `${client} reports installed dependency problems: ${problems.slice(0, 3).join('; ')}`);
      const nodes = packageReportNodes(roots);
      const packages = client === 'pnpm'
        ? nodes.filter(node => typeof node.path === 'string' && node.path.includes(`${sep}node_modules${sep}.pnpm${sep}`))
        : nodes;
      return { roots, nodes: packages };
    }, 'conflict', `${client} returned an invalid installed package report`);
  });
}

function verifyReportedDependencyLinks(
  roots: readonly JsonObject[],
  projectDirectory: string,
  platformSkippedIdentities: ReadonlySet<string>,
): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const projectRoot = yield* promiseEffect(() => realpath(projectDirectory), 'operation', `could not resolve restored project directory ${projectDirectory}`);
    const visited = new Set<string>();
    const visit = function*(node: JsonObject): Generator<Effect.Effect<unknown, MynpmError>, void, unknown> {
      if (typeof node.path !== 'string') return;
      const parentPath = yield* promiseEffect(() => realpath(node.path as string), 'conflict', 'package report path is missing from the installed tree');
      const parentRelative = relative(projectRoot, parentPath);
      if (parentRelative === '..' || parentRelative.startsWith(`..${sep}`) || parentRelative.startsWith(sep)) {
        return yield* Effect.fail(new MynpmError('conflict', 'package report path leaves the restored project'));
      }
      if (visited.has(parentPath)) return;
      visited.add(parentPath);
      if (!isRecord(node.dependencies)) return;
      for (const [dependencyName, childValue] of Object.entries(node.dependencies)) {
        if (!isRecord(childValue) || typeof childValue.path !== 'string') continue;
        const childPackageName = typeof childValue.name === 'string' ? childValue.name : dependencyName;
        if (typeof childValue.version === 'string' && platformSkippedIdentities.has(`${childPackageName}\0${childValue.version}`)) continue;
        const segments = dependencyName.split('/');
        if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
          return yield* Effect.fail(new MynpmError('conflict', `package report contains an unsafe dependency name: ${dependencyName}`));
        }
        const childPath = yield* promiseEffect(() => realpath(childValue.path as string), 'conflict', `reported dependency ${dependencyName} is missing from the installed tree`);
        let searchPath = parentPath;
        let linkedPath: string | null = null;
        while (true) {
          const candidate = join(searchPath, 'node_modules', ...segments);
          const info = yield* promiseEffect(
            () => lstat(candidate).catch(cause => errorCode(cause) === 'ENOENT' ? null : Promise.reject(cause)),
            'conflict',
            `could not inspect installed dependency link ${candidate}`,
          );
          if (info !== null) {
            const targetPath = yield* promiseEffect(() => realpath(candidate), 'conflict', `installed dependency link ${candidate} is broken`);
            if (targetPath !== childPath) {
              return yield* Effect.fail(new MynpmError('conflict', `installed dependency link ${dependencyName} points to a different package instance`));
            }
            linkedPath = candidate;
            break;
          }
          if (searchPath === projectRoot) break;
          const parentSearchPath = dirname(searchPath);
          const parentRelative = relative(projectRoot, parentSearchPath);
          if (parentSearchPath === searchPath || parentRelative === '..' || parentRelative.startsWith(`..${sep}`) || parentRelative.startsWith(sep)) break;
          searchPath = parentSearchPath;
        }
        if (linkedPath === null) {
          return yield* Effect.fail(new MynpmError('conflict', `installed dependency link ${dependencyName} is missing`));
        }
        yield* visit(childValue);
      }
    };
    for (const root of roots) yield* visit(root);
  });
}

function assertReportMatchesExpected(
  report: readonly JsonObject[],
  expected: readonly ExpectedInstance[],
  client: PackageManager,
  projectId: string,
  projectDirectory: string,
): void {
  const expectedByPath = new Map(expected.map(instance => [instance.key, instance]));
  const actualInstances = report.flatMap(item => {
    if (typeof item.version !== 'string') return [];
    if (typeof item.path === 'string') {
      const pathFromProject = relative(projectDirectory, item.path);
      if (pathFromProject === '..' || pathFromProject.startsWith(`..${sep}`) || pathFromProject.startsWith(sep)) {
        fail('conflict', `${client} package report points outside the restored project for ${projectId}`);
      }
      const installed = expectedByPath.get(pathFromProject.split(sep).join('/'));
      if (installed !== undefined) return [{ name: installed.name, version: item.version }];
    }
    return typeof item.name === 'string' ? [{ name: item.name, version: item.version }] : [];
  });
  const expectedCounts = packageIdentityCounts(expected);
  const actualCounts = packageIdentityCounts(actualInstances);
  const identities = new Set([...expectedCounts.keys(), ...actualCounts.keys()]);
  const mismatch = [...identities].find(identity => expectedCounts.get(identity) !== actualCounts.get(identity));
  if (mismatch !== undefined) {
    const separator = mismatch.indexOf('\0');
    const identity = `${mismatch.slice(0, separator)}@${mismatch.slice(separator + 1)}`;
    const expectedCount = expectedCounts.get(mismatch) ?? 0;
    const actualCount = actualCounts.get(mismatch) ?? 0;
    fail('conflict', `${client} installed package report for ${projectId} does not match the selected graph at ${identity}; expected ${expectedCount} instance(s), found ${actualCount}`);
  }
}

function verifyInstalledTree(
  projectDirectory: string,
  project: ProjectRecord,
  target: TargetConfig,
  client: PackageManager,
  environment: NodeJS.ProcessEnv,
  dependencies: ValidationDependencies,
): Effect.Effect<InstallCoverage, MynpmError> {
  return Effect.gen(function*() {
    const expected = client === 'npm'
      ? yield* expectedNpmInstances(project, target)
      : yield* expectedPnpmInstances(project, target);
    const expectedOptionalIdentities = new Set(expected.instances
      .filter(instance => instance.optional)
      .map(instance => `${instance.name}\0${instance.version}`));
    if (client === 'npm') {
      for (const instance of expected.instances) yield* inspectInstalledPackage(projectDirectory, instance);
    }
    const report = yield* packageReport(client, projectDirectory, environment, dependencies);
    const installedReportNodes = report.nodes.filter(node => {
      const identity = typeof node.name === 'string' && typeof node.version === 'string'
        ? `${node.name}\0${node.version}`
        : null;
      return identity === null || !expected.platformSkippedIdentities.has(identity);
    });
    if (client === 'pnpm') {
      for (const node of installedReportNodes) {
        if (typeof node.path !== 'string' || typeof node.name !== 'string' || typeof node.version !== 'string') {
          return yield* Effect.fail(new MynpmError('conflict', `pnpm package report omitted an installed package path for ${project.id}`));
        }
        const pathFromProject = relative(projectDirectory, node.path);
        if (pathFromProject === '..' || pathFromProject.startsWith(`..${sep}`) || pathFromProject.startsWith(sep)) {
          return yield* Effect.fail(new MynpmError('conflict', `pnpm package report points outside the restored project for ${project.id}`));
        }
        yield* inspectInstalledPackage(projectDirectory, {
          key: pathFromProject.split(sep).join('/'),
          name: node.name,
          version: node.version,
          optional: expectedOptionalIdentities.has(`${node.name}\0${node.version}`),
        });
      }
    }
    yield* verifyReportedDependencyLinks(report.roots, projectDirectory, expected.platformSkippedIdentities);
    yield* syncEffect(() => assertReportMatchesExpected(installedReportNodes, expected.instances, client, project.id, projectDirectory), 'conflict', `${client} installed package report changed the selected graph for ${project.id}`);
    return { instanceCount: expected.instances.length, platformSkippedCount: expected.platformSkippedCount };
  });
}

function checkExecutables(
  projectDirectory: string,
  project: ProjectRecord,
  roots: ProjectRecord['roots'],
  target: TargetConfig,
  environment: NodeJS.ProcessEnv,
  dependencies: ValidationDependencies,
): Effect.Effect<Record<string, string>, MynpmError> {
  return Effect.gen(function*() {
    const outputs: Record<string, string> = {};
    const typescriptVersion = roots.find(root => root.packageName === 'typescript')?.packageVersion
      ?? project.packages.find(item => item.name === 'typescript' && item.key === 'node_modules/typescript')?.version;
    if (typescriptVersion !== undefined && typescriptVersion !== null) {
      const result = yield* processEffect(dependencies, process.execPath, ['node_modules/typescript/bin/tsc', '--version'], {
        cwd: projectDirectory,
        env: environment,
        timeoutMs: 30_000,
      });
      outputs.typescript = result.stdout.trim();
      if (outputs.typescript !== `Version ${typescriptVersion}`) {
        return yield* Effect.fail(new MynpmError('conflict', `TypeScript executable did not report the selected version ${typescriptVersion}`));
      }
    }
    const esbuildVersion = roots.find(root => root.packageName === 'esbuild')?.packageVersion
      ?? project.packages.find(item => item.name === 'esbuild' && item.key === 'node_modules/esbuild')?.version;
    if (esbuildVersion !== undefined && esbuildVersion !== null) {
      const result = yield* processEffect(dependencies, process.execPath, ['node_modules/esbuild/bin/esbuild', '--version'], {
        cwd: projectDirectory,
        env: environment,
        timeoutMs: 30_000,
      });
      outputs.esbuild = result.stdout.trim();
      if (outputs.esbuild !== esbuildVersion) {
        return yield* Effect.fail(new MynpmError('conflict', `esbuild executable did not report the selected version ${esbuildVersion}`));
      }
    }
    return outputs;
  });
}

function assertProjectStaticResponses(
  requests: readonly StaticRequest[],
  publicPrefix: string,
  project: ProjectRecord,
  target: TargetConfig,
  artifacts: readonly ArtifactRecord[],
): void {
  const expectedNames = new Map<string, string[]>();
  const expectedDigests = new Set<string>();
  for (const item of project.packages) {
    if (item.version === null || item.sourceKind !== 'registry' || !supportsTarget(item.platform, target)) continue;
    const digest = packageArtifact(project, item, artifacts).artifact.sha512;
    expectedDigests.add(digest);
    const names = expectedNames.get(digest) ?? [];
    names.push(`${item.name}@${item.version}`);
    expectedNames.set(digest, names);
  }
  for (const request of requests) {
    const platformSkip = request.pathname.endsWith('/current/-/tarballs/unavailable.tgz')
      && request.method === 'GET'
      && request.status === 404
      && request.complete;
    if (!request.complete || (request.status !== 200 && !platformSkip)) {
      const digest = /\/([a-f0-9]{128})\.tgz$/.exec(request.pathname)?.[1];
      const identity = digest === undefined ? undefined : expectedNames.get(digest)?.join(', ');
      fail('conflict', `local static server returned HTTP ${request.status ?? 'incomplete'} for ${request.pathname}${identity === undefined ? '' : ` (${identity})`}`);
    }
  }
  for (const digest of expectedDigests) {
    const pathname = `${publicPrefix}current/-/tarballs/${digest}.tgz`;
    const matching = requests.filter(request => request.pathname === pathname && request.method === 'GET');
    const corrupt = matching.find(request => request.status === 200 && request.responseSha512 !== digest);
    if (corrupt !== undefined) fail('corrupt', `local static server returned corrupted tarball bytes for ${pathname} (${expectedNames.get(digest)?.join(', ')})`);
    const response = matching.find(request => request.status === 200 && request.complete && request.responseSha512 === digest);
    if (response === undefined) fail('conflict', `package manager did not fetch expected applicable artifact ${pathname} (${expectedNames.get(digest)?.join(', ')})`);
    if (response.contentType !== 'application/octet-stream') {
      fail('conflict', `local server returned the wrong content type for tarball ${pathname}`);
    }
  }
}

function writeProjectSnapshot(projectDirectory: string, project: ProjectRecord, lockText: string, lockfileName: string): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const snapshot = yield* syncEffect(() => projectSnapshot(project), 'input', `validation requires a saved snapshot for ${project.id}`);
    yield* promiseEffect(() => mkdir(projectDirectory, { recursive: true, mode: 0o700 }), 'operation', `could not create restored project directory ${projectDirectory}`);
    yield* promiseEffect(() => writeFile(join(projectDirectory, 'package.json'), snapshot.manifest, { flag: 'wx' }), 'operation', `could not restore package.json for ${project.id}`);
    yield* promiseEffect(() => writeFile(join(projectDirectory, lockfileName), lockText, { flag: 'wx' }), 'operation', `could not restore ${lockfileName} for ${project.id}`);
    for (const file of snapshot.workspaceFiles) {
      const filePath = join(projectDirectory, ...file.path.split('/'));
      const parent = filePath.slice(0, filePath.lastIndexOf('/'));
      yield* promiseEffect(() => mkdir(parent, { recursive: true, mode: 0o700 }), 'operation', `could not restore workspace directory ${parent}`);
      yield* promiseEffect(() => writeFile(filePath, file.contents, { flag: 'wx' }), 'operation', `could not restore workspace file ${file.path} for ${project.id}`);
    }
  });
}

function assertProjectFilesUnchanged(projectDirectory: string, project: ProjectRecord, lockfileName: string): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const snapshot = yield* syncEffect(() => projectSnapshot(project), 'input', `validation requires a saved snapshot for ${project.id}`);
    const files = [{ path: 'package.json', contents: snapshot.manifest }, ...snapshot.workspaceFiles];
    for (const file of files) {
      if (file.path === lockfileName) continue;
      const actual = yield* promiseEffect(
        () => readFile(join(projectDirectory, ...file.path.split('/')), 'utf8'),
        'operation',
        `client removed project snapshot file ${file.path} for ${project.id}`,
      );
      if (actual !== file.contents) return yield* Effect.fail(new MynpmError('conflict', `${project.manager} changed project snapshot file ${file.path} for ${project.id}`));
    }
  });
}

function installProject({
  client,
  project,
  target,
  workspace,
  registry,
  localOrigin,
  projectNumber,
  smokeExecutables,
  dependencies,
}: {
  client: PackageManager;
  project: ProjectRecord;
  target: TargetConfig;
  workspace: string;
  registry: string;
  localOrigin: string;
  projectNumber: number;
  smokeExecutables: boolean;
  dependencies: InstallDependencies;
}): Effect.Effect<{ selection: SelectedPackage[]; coverage: InstallCoverage; executables: Record<string, string> }, MynpmError> {
  return Effect.gen(function*() {
    const projectDirectory = join(workspace, 'projects', `${packageSlug(project.id)}-${projectNumber}`);
    const installWorkspace = join(workspace, 'clients', `${packageSlug(project.id)}-${projectNumber}`);
    yield* promiseEffect(() => mkdir(installWorkspace, { recursive: true, mode: 0o700 }), 'operation', `could not create validation client directory ${installWorkspace}`);
    const lockfileName = client === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
    const migratedLock = client === 'npm'
      ? yield* rewriteNpmLock(project, target, dependencies.artifacts, registry)
      : yield* rewritePnpmLock(project, target, dependencies.artifacts, registry);
    yield* assertMigrationPreservesGraph(project, migratedLock);
    yield* writeProjectSnapshot(projectDirectory, project, migratedLock, lockfileName);
    const cacheDirectory = join(installWorkspace, 'cache');
    const environment = yield* createClientEnvironment(installWorkspace, registry, cacheDirectory);
    const args = client === 'npm'
      ? [
        'ci',
        `--registry=${registry}`,
        `--cache=${cacheDirectory}`,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--fetch-retries=0',
        ...npmSnapshotInstallArgs(project),
      ]
      : ['install', '--frozen-lockfile', `--registry=${registry}`, `--store-dir=${join(installWorkspace, 'pnpm-store')}`, '--ignore-scripts', '--ignore-pnpmfile'];
    yield* processEffect(dependencies, client, args, { cwd: projectDirectory, env: environment, timeoutMs: clientTimeoutMilliseconds });
    const actualLock = yield* promiseEffect(
      () => readFile(join(projectDirectory, lockfileName), 'utf8'),
      'operation',
      `${client} removed ${lockfileName} while restoring ${project.id}`,
    );
    const actualProject = yield* parseProjectLock(client, actualLock, {
      projectId: project.id,
      packageManagerPin: project.packageManagerPin,
      lockfilePath: lockfileName,
      targetIds: [target.id],
      snapshot: null,
    });
    yield* assertLockfileMatches(client, migratedLock, actualLock, project);
    const coverage = yield* verifyInstalledTree(projectDirectory, project, target, client, environment, dependencies);
    const selection = yield* syncEffect(() => packageSelection(actualProject, target, dependencies.artifacts, { allowLocalHost: true, localOrigin }), 'conflict', `could not verify restored package selection for ${project.id}`);
    yield* assertProjectFilesUnchanged(projectDirectory, project, lockfileName);
    const roots = project.roots.filter(root => root.importer === '.');
    const executables = smokeExecutables
      ? yield* checkExecutables(projectDirectory, project, roots, target, environment, dependencies)
      : {};
    return { selection, coverage, executables };
  });
}

function npmSnapshotInstallArgs(project: ProjectRecord): string[] {
  const options = projectSnapshot(project).npmInstallOptions;
  const args: string[] = [];
  if (options?.legacyPeerDeps !== null && options?.legacyPeerDeps !== undefined) {
    args.push(`--legacy-peer-deps=${options.legacyPeerDeps}`);
  }
  if (options?.installLinks !== null && options?.installLinks !== undefined) {
    args.push(`--install-links=${options.installLinks}`);
  }
  return args;
}

export interface ValidateInventoryOptions {
  client: PackageManager;
  stateDirectory: string;
  config: MynpmConfig;
  cwd?: string;
  smokeExecutables?: boolean;
}

export interface ValidationResult {
  client: PackageManager;
  version: string;
  nodeVersion: string;
  target: string;
  packageCount: number;
  platformSkippedCount: number;
  projectCount: number;
  rootCount: number;
  requestCount: number;
  generationId: string;
  executables: Array<{ name: string; output: string }>;
}

export function validateInventory(
  { client, stateDirectory, config, cwd = process.cwd(), smokeExecutables = false }: ValidateInventoryOptions,
  dependencies: ValidationDependencies = {},
): Effect.Effect<ValidationResult, MynpmError> {
  return Effect.gen(function*() {
    if (client !== 'npm' && client !== 'pnpm') return yield* Effect.fail(new MynpmError('input', 'validate requires client npm or pnpm'));
    const target = yield* syncEffect(() => targetForCurrentPlatform(config), 'input', 'current platform is not configured');
    const inventory: Inventory = yield* loadInventory(stateDirectory);
    const projects = inventory.projects.filter(project => project.manager === client && project.targets.includes(target.id));
    if (projects.length === 0) return yield* Effect.fail(new MynpmError('input', `inventory contains no ${client} projects for target ${target.id}`));
    const scratchRoot = resolve(cwd, '.work', 'tmp');
    yield* promiseEffect(() => mkdir(scratchRoot, { recursive: true, mode: 0o700 }), 'operation', `could not create validation scratch directory ${scratchRoot}`);
    return yield* Effect.acquireUseRelease(
      promiseEffect(() => mkdtemp(join(scratchRoot, 'mynpm-validate-')), 'operation', 'could not create validation workspace'),
      workspace => Effect.gen(function*() {
        for (const project of projects) yield* assertSnapshotMatchesProject(project, target);
        const artifacts = inventory.artifacts;
        const expectedByProject = yield* syncEffect(
          () => new Map<ProjectRecord, SelectedPackage[]>(projects.map(project => [project, packageSelection(project, target, artifacts)])),
          'conflict',
          'could not verify imported package selections',
        );
        const siteDirectory = join(workspace, 'site');
        const mirrorDirectory = join(siteDirectory, 'mirror');
        yield* promiseEffect(() => mkdir(mirrorDirectory, { recursive: true, mode: 0o700 }), 'operation', `could not create local site directory ${mirrorDirectory}`);
        return yield* Effect.acquireUseRelease(
          syncEffect(() => createStaticServer(mirrorDirectory), 'operation', 'could not create local validation server'),
          resource => Effect.gen(function*() {
            const staticServer = yield* listenStaticServer(resource);
            const origin = `http://127.0.0.1:${staticServer.port}`;
            const environment = yield* createClientEnvironment(workspace, `${origin}/current/`, join(workspace, 'tool-cache'));
            const version = yield* checkClientVersion(client, target, workspace, environment, dependencies);
            let projectNumber = 0;
            const validatedSelections = new Set<string>();
            let platformSkippedCount = 0;
            const executableResults: Array<{ name: string; output: string }> = [];
            let finalGenerationId: string | undefined;
            for (const mount of ['/mirror/', '/']) {
              const publicBaseUrl = `${origin}${mount}`;
              const published = yield* publishSite({ stateDirectory, siteDirectory, config }, { renderBaseUrl: publicBaseUrl });
              finalGenerationId = published.generationId;
              const registry = `${publicBaseUrl}current/`;
              for (const project of projects) {
                projectNumber += 1;
                const requestStart = staticServer.requests.length;
                const installResult = yield* Effect.result(installProject({
                  client,
                  project,
                  target,
                  workspace,
                  registry,
                  localOrigin: origin,
                  projectNumber,
                  smokeExecutables,
                  dependencies: { ...dependencies, artifacts },
                }));
                yield* syncEffect(
                  () => assertProjectStaticResponses(staticServer.requests.slice(requestStart), mount, project, target, artifacts),
                  'conflict',
                  `local static responses were incomplete for ${project.id}`,
                );
                if (installResult._tag === 'Failure') return yield* Effect.fail(installResult.failure);
                const result = installResult.success;
                const expected = expectedByProject.get(project);
                if (expected === undefined) return yield* Effect.fail(new MynpmError('corrupt', `validation lost the expected package selection for ${project.id}`));
                yield* syncEffect(() => compareSelections(expected, result.selection, project.id, client), 'conflict', `validation changed package selection for ${project.id}`);
                for (const item of expected) validatedSelections.add(`${project.id}\0${item.identity}\0${item.integrity}`);
                platformSkippedCount += result.coverage.platformSkippedCount;
                executableResults.push(...Object.entries(result.executables).map(([name, output]) => ({ name, output })));
              }
            }
            const invalidRequest = staticServer.requests.find(request => request.prefix === null);
            if (invalidRequest) return yield* Effect.fail(new MynpmError('conflict', `validation served a request outside the local static site: ${invalidRequest.pathname}`));
            const servingFailure = staticServer.requests.find(request => {
              const platformSkip = request.pathname.endsWith('/current/-/tarballs/unavailable.tgz') && request.method === 'GET' && request.status === 404 && request.complete;
              return !request.complete || (request.status !== 200 && !platformSkip);
            });
            if (servingFailure) {
              return yield* Effect.fail(new MynpmError('conflict', `local static server returned HTTP ${servingFailure.status ?? 'incomplete'} for ${servingFailure.pathname}`));
            }
            if (validatedSelections.size > 0 && staticServer.requests.length === 0) {
              return yield* Effect.fail(new MynpmError('operation', 'package manager made no requests to the local static site'));
            }
            if (finalGenerationId === undefined) return yield* Effect.fail(new MynpmError('operation', 'validation did not publish a site generation'));
            return {
              client,
              version,
              nodeVersion: process.version,
              target: target.id,
              packageCount: validatedSelections.size,
              platformSkippedCount,
              projectCount: projects.length,
              rootCount: projects.reduce((count, project) => count + project.roots.length, 0),
              requestCount: staticServer.requests.length,
              generationId: finalGenerationId,
              executables: executableResults,
            };
          }),
          resource => closeStaticServer(resource),
        );
      }),
      workspace => promiseEffect(() => rm(workspace, { recursive: true, force: true }), 'operation', `could not remove validation workspace ${workspace}`),
    );
  });
}
