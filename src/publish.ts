import { constants } from 'node:fs';
import { open, mkdir, lstat, readlink, rename, link, unlink, rm, readdir, symlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { Effect, Result, Stream } from 'effect';
import type { MynpmConfig } from './config.ts';
import { acquireFilesystemLock, loadInventory } from './inventory-store.ts';
import { verifyInventorySnapshot } from './acquire.ts';
import { canonicalJson, renderPackumentFiles, rendererVersion, type PackumentFile } from './packument.ts';
import { validateArtifactRecord, type ArtifactRecord, type Inventory } from './inventory.ts';
import { errorCode, MynpmError, type ErrorCategory } from './errors.ts';

type RendererVersion = 1 | 2 | typeof rendererVersion;
type MynpmEffect<A> = Effect.Effect<A, MynpmError>;

interface GenerationManifest {
  schemaVersion: 1;
  rendererVersion: RendererVersion;
  publicBaseUrl: string;
  generationId: string;
  artifacts: ArtifactRecord[];
}

interface PublicationDependencies {
  renderBaseUrl?: string;
  syncDirectory?: (directory: string) => Promise<void>;
  link?: (existingPath: string, newPath: string) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  symlink?: (target: string, path: string) => Promise<void>;
  beforeInventoryRead?: () => void | Promise<void>;
  afterInventoryRead?: (inventory: Inventory) => void | Promise<void>;
}

interface GenerationDependencies extends PublicationDependencies {
  mirrorRoot: string;
  generationsDirectory: string;
}

interface CurrentPublication {
  target: string | null;
  artifacts: ArtifactRecord[];
}

interface PublishResult {
  generationId: string;
  packageCount: number;
  versionCount: number;
  noOp: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(category: ErrorCategory, message: string, options?: ErrorOptions): MynpmEffect<never> {
  return Effect.fail(new MynpmError(category, message, options));
}

function tryIO<A>(operation: (signal: AbortSignal) => PromiseLike<A>, category: ErrorCategory, message: string): MynpmEffect<A> {
  return Effect.tryPromise({
    try: operation,
    catch: cause => cause instanceof MynpmError ? cause : new MynpmError(category, message, { cause }),
  });
}

function tryValue<A>(operation: () => A, category: ErrorCategory, message: string): MynpmEffect<A> {
  return Effect.try({
    try: operation,
    catch: cause => cause instanceof MynpmError ? cause : new MynpmError(category, message, { cause }),
  });
}

function causeCode(cause: unknown): string | undefined {
  let current = cause;
  while (current instanceof MynpmError && current.cause !== undefined) current = current.cause;
  return errorCode(current);
}

function isRendererVersion(value: unknown): value is RendererVersion {
  return value === 1 || value === 2 || value === rendererVersion;
}

function sortedArtifacts(records: readonly unknown[]): MynpmEffect<ArtifactRecord[]> {
  return Effect.gen(function*() {
    const artifacts: ArtifactRecord[] = [];
    for (const record of records) {
      artifacts.push(yield* tryValue(() => validateArtifactRecord(record), 'corrupt', 'verified artifact is invalid'));
    }
    return artifacts.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  });
}

function generationPayload(
  publicBaseUrl: string,
  artifacts: readonly ArtifactRecord[],
  packuments: readonly PackumentFile[],
  renderVersion: RendererVersion,
): unknown {
  const legacyPayload = {
    schemaVersion: 1,
    rendererVersion: renderVersion,
    publicBaseUrl,
    artifacts: artifacts.map(record => ({ name: record.name, version: record.version, sha512: record.artifact.sha512 })),
    packuments: packuments.map(file => ({ path: file.path, contents: file.bytes.toString('utf8') })),
  };
  if (renderVersion < 3) return legacyPayload;
  return {
    ...legacyPayload,
    publicationLayout: 'current-dash-tarballs-v1',
    artifacts: artifacts.map(record => ({
      name: record.name,
      version: record.version,
      digests: {
        sha512: record.artifact.sha512,
        integrity: record.artifact.integrity,
        shasum: record.artifact.shasum,
      },
    })),
  };
}

function generationId(publicBaseUrl: string, artifacts: readonly ArtifactRecord[], packuments: readonly PackumentFile[], renderVersion: RendererVersion = rendererVersion): string {
  return createHash('sha256').update(canonicalJson(generationPayload(publicBaseUrl, artifacts, packuments, renderVersion))).digest('hex');
}

function syncDirectory(directory: string, message?: string): MynpmEffect<void> {
  return Effect.acquireUseRelease(
    tryIO(() => open(directory, 'r'), 'operation', message ?? `could not open directory for synchronization: ${directory}`),
    handle => tryIO(() => handle.sync(), 'operation', message ?? `could not synchronize directory ${directory}`),
    handle => tryIO(() => handle.close(), 'operation', message ?? `could not close directory ${directory}`),
  );
}

function syncPublicationDirectory(
  directory: string,
  dependencies: PublicationDependencies,
  message?: string,
): MynpmEffect<void> {
  const synchronize = dependencies.syncDirectory;
  return synchronize
    ? tryIO(() => synchronize(directory), 'operation', message ?? `could not synchronize directory ${directory}`)
    : syncDirectory(directory, message);
}

function ensureDirectory(directory: string, category: ErrorCategory = 'operation', publicAccess = false): MynpmEffect<void> {
  return Effect.gen(function*() {
    let created = false;
    yield* tryIO(() => mkdir(directory, { mode: 0o755 }), category, `could not create directory ${directory}`).pipe(
      Effect.tap(() => Effect.sync(() => { created = true; })),
      Effect.catchIf(error => causeCode(error) === 'EEXIST', () => Effect.void),
    );
    const info = yield* tryIO(() => lstat(directory), category, `could not inspect directory ${directory}`);
    if (!info.isDirectory() || info.isSymbolicLink()) return yield* failure(category, `managed path is not a real directory: ${directory}`);
    if (created) {
      yield* Effect.acquireUseRelease(
        tryIO(() => open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), category, `could not open directory ${directory}`),
        handle => publicAccess
          ? tryIO(() => handle.chmod(0o755), category, `could not set directory permissions: ${directory}`)
          : Effect.void,
        handle => tryIO(() => handle.close(), category, `could not close directory ${directory}`),
      );
      yield* syncDirectory(dirname(directory));
    }
  });
}

function ensureDirectoryTree(targetDirectory: string, category: ErrorCategory = 'input'): MynpmEffect<string> {
  return Effect.gen(function*() {
    const target = resolve(targetDirectory);
    const root = parse(target).root;
    if (target === root) return yield* failure(category, `publish site cannot be a filesystem root: ${target}`);
    let current = root;
    for (const part of relative(root, target).split(sep).filter(Boolean)) {
      current = join(current, part);
      yield* ensureDirectory(current, category, true);
    }
    return target;
  });
}

function openRegularFile(path: string, category: ErrorCategory, missingAllowed = false): MynpmEffect<FileHandle | null> {
  return Effect.gen(function*() {
    const opened = yield* Effect.result(Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      catch: cause => cause,
    }));
    if (Result.isFailure(opened)) {
      if (missingAllowed && errorCode(opened.failure) === 'ENOENT') return null;
      if (errorCode(opened.failure) === 'ELOOP') return yield* failure(category, `managed file is a symbolic link: ${path}`);
      return yield* Effect.fail(new MynpmError(category, `could not open regular file ${path}`, { cause: opened.failure }));
    }
    const handle = opened.success;
    const stat = yield* Effect.result(tryIO(() => handle.stat(), category, `could not inspect regular file ${path}`));
    if (Result.isFailure(stat)) {
      const close = yield* Effect.result(tryIO(() => handle.close(), category, `could not close regular file ${path}`));
      if (Result.isFailure(close)) {
        return yield* failure(category, `could not inspect and close regular file ${path}`, { cause: new AggregateError([stat.failure, close.failure]) });
      }
      return yield* Effect.fail(stat.failure);
    }
    if (!stat.success.isFile()) {
      yield* tryIO(() => handle.close(), category, `could not close regular file ${path}`);
      return yield* failure(category, `managed path is not a regular file: ${path}`);
    }
    return handle;
  });
}

function withRegularFile<A>(
  path: string,
  category: ErrorCategory,
  missingAllowed: false,
  use: (handle: FileHandle, close: () => MynpmEffect<void>) => MynpmEffect<A>,
): MynpmEffect<A>;
function withRegularFile<A>(
  path: string,
  category: ErrorCategory,
  missingAllowed: true,
  use: (handle: FileHandle, close: () => MynpmEffect<void>) => MynpmEffect<A>,
): MynpmEffect<A | null>;
function withRegularFile<A>(
  path: string,
  category: ErrorCategory,
  missingAllowed: boolean,
  use: (handle: FileHandle, close: () => MynpmEffect<void>) => MynpmEffect<A>,
): MynpmEffect<A | null> {
  return Effect.acquireUseRelease(
    openRegularFile(path, category, missingAllowed).pipe(
      Effect.map(handle => handle === null ? null : { handle, open: true }),
    ),
    resource => {
      if (resource === null) return Effect.succeed(null);
      const close = (): MynpmEffect<void> => tryIO(() => resource.handle.close(), category, `could not close regular file ${path}`).pipe(
        Effect.tap(() => Effect.sync(() => { resource.open = false; })),
      );
      return use(resource.handle, close);
    },
    resource => {
      if (resource === null || !resource.open) return Effect.void;
      return tryIO(() => resource.handle.close(), category, `could not close regular file ${path}`);
    },
  );
}

function readRegularFile(path: string, category: ErrorCategory): MynpmEffect<Buffer>;
function readRegularFile(path: string, category: ErrorCategory, missingAllowed: true): MynpmEffect<Buffer | null>;
function readRegularFile(path: string, category: ErrorCategory, missingAllowed = false): MynpmEffect<Buffer | null> {
  if (missingAllowed) {
    return withRegularFile(path, category, true, handle =>
      tryIO(signal => handle.readFile({ signal }), category, `could not read regular file ${path}`));
  }
  return withRegularFile(path, category, false, handle =>
    tryIO(signal => handle.readFile({ signal }), category, `could not read regular file ${path}`));
}

function generationFiles(directory: string, prefix = ''): MynpmEffect<string[]> {
  return Effect.gen(function*() {
    const entries = yield* tryIO(() => readdir(directory, { withFileTypes: true }), 'corrupt', `could not read generation directory ${directory}`);
    const found: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix === '' ? entry.name : join(prefix, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        return yield* failure('corrupt', `generation contains an unsafe entry: ${path}`);
      }
      if (entry.isDirectory()) {
        const info = yield* tryIO(() => lstat(path), 'corrupt', `could not inspect generation directory ${path}`);
        if (!info.isDirectory() || info.isSymbolicLink()) return yield* failure('corrupt', `generation contains an unsafe directory: ${path}`);
        found.push(...yield* generationFiles(path, relativePath));
      } else {
        found.push(relativePath.split(sep).join('/'));
      }
    }
    return found;
  });
}

function hashRegularFile(path: string, expectedDigest: string, category: ErrorCategory): MynpmEffect<string> {
  return withRegularFile(path, category, false, handle => Effect.gen(function*() {
    const digest = createHash('sha512');
    const readable = yield* tryIO(
      signal => Promise.resolve(handle.createReadStream({ autoClose: false, signal })),
      category,
      `could not read artifact ${path}`,
    );
    const stream = Stream.fromAsyncIterable(
      readable,
      cause => new MynpmError(category, `could not read artifact ${path}`, { cause }),
    );
    yield* Stream.runForEach(stream, chunk => Effect.sync(() => { digest.update(chunk); }));
    const actual = digest.digest('hex');
    if (actual !== expectedDigest) return yield* failure('corrupt', `SHA-512 mismatch for published artifact ${basename(path)}`);
    return actual;
  }));
}

function parseManifest(text: string, path: string): MynpmEffect<GenerationManifest> {
  return Effect.gen(function*() {
    const parsed: unknown = yield* tryValue(() => JSON.parse(text), 'corrupt', `generation manifest is not valid JSON: ${path}`);
    if (!isRecord(parsed)) return yield* failure('corrupt', `generation manifest must be an object: ${path}`);
    const keys = ['schemaVersion', 'rendererVersion', 'publicBaseUrl', 'generationId', 'artifacts'];
    if (Object.keys(parsed).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(parsed, key))) {
      return yield* failure('corrupt', `generation manifest has an unsupported shape: ${path}`);
    }
    if (parsed.schemaVersion !== 1 || !isRendererVersion(parsed.rendererVersion) || typeof parsed.publicBaseUrl !== 'string' || typeof parsed.generationId !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.generationId) || !Array.isArray(parsed.artifacts)) {
      return yield* failure('corrupt', `generation manifest has invalid fields: ${path}`);
    }
    const rawArtifacts: unknown[] = parsed.artifacts;
    const artifacts = yield* sortedArtifacts(rawArtifacts);
    const identities = artifacts.map(record => `${record.name}\0${record.version}`);
    if (new Set(identities).size !== identities.length) return yield* failure('corrupt', `generation manifest has duplicate package identities: ${path}`);
    return {
      schemaVersion: 1,
      rendererVersion: parsed.rendererVersion,
      publicBaseUrl: parsed.publicBaseUrl,
      generationId: parsed.generationId,
      artifacts,
    };
  });
}

function generationIdForManifest(manifest: GenerationManifest, files: readonly PackumentFile[]): string {
  return generationId(manifest.publicBaseUrl, manifest.artifacts, files, manifest.rendererVersion);
}

function validateGeneration(generationsDirectory: string, id: string, mirrorRoot: string): MynpmEffect<GenerationManifest | null> {
  return Effect.gen(function*() {
    const generationDirectory = join(generationsDirectory, id);
    const infoResult = yield* Effect.result(tryIO(() => lstat(generationDirectory), 'operation', `could not inspect generation ${id}`));
    if (Result.isFailure(infoResult)) {
      if (causeCode(infoResult.failure) === 'ENOENT') return null;
      return yield* Effect.fail(infoResult.failure);
    }
    const info = infoResult.success;
    if (!info.isDirectory() || info.isSymbolicLink()) return yield* failure('corrupt', `generation is not a real directory: ${generationDirectory}`);
    const manifestPath = join(generationDirectory, 'manifest.json');
    const manifestBytes = yield* readRegularFile(manifestPath, 'corrupt');
    if (manifestBytes === null) return yield* failure('corrupt', `generation manifest is missing: ${manifestPath}`);
    const manifest = yield* parseManifest(manifestBytes.toString('utf8'), manifestPath);
    const files = yield* tryValue(
      () => renderPackumentFiles(manifest.artifacts, manifest.publicBaseUrl, { renderer: manifest.rendererVersion }),
      'corrupt',
      `could not render generation packuments: ${id}`,
    );
    const computedId = generationIdForManifest(manifest, files);
    if (computedId !== id || manifest.generationId !== id) return yield* failure('corrupt', `generation identity does not match its contents: ${id}`);
    const digests = [...new Set(manifest.artifacts.map(record => record.artifact.sha512))];
    const tarballAliases = manifest.rendererVersion === 1
      ? []
      : digests.flatMap(digest => manifest.rendererVersion === 2
        ? [`tarballs/${digest}.tgz`]
        : [`tarballs/${digest}.tgz`, `-/tarballs/${digest}.tgz`]);
    const expectedFiles = [...files.map(file => file.path), ...tarballAliases, 'manifest.json'].sort();
    const actualFiles = (yield* generationFiles(generationDirectory)).sort();
    if (canonicalJson(expectedFiles) !== canonicalJson(actualFiles)) return yield* failure('corrupt', `generation file set does not match its manifest: ${id}`);
    for (const file of files) {
      const actual = yield* readRegularFile(join(generationDirectory, file.path), 'corrupt');
      if (actual === null || !actual.equals(file.bytes)) return yield* failure('corrupt', `generation packument does not match its manifest: ${file.path}`);
    }
    for (const record of manifest.artifacts) {
      yield* hashRegularFile(join(mirrorRoot, 'tarballs', `${record.artifact.sha512}.tgz`), record.artifact.sha512, 'corrupt');
      if (manifest.rendererVersion !== 1) {
        yield* hashRegularFile(join(generationDirectory, 'tarballs', `${record.artifact.sha512}.tgz`), record.artifact.sha512, 'corrupt');
      }
      if (manifest.rendererVersion === 3) {
        yield* hashRegularFile(join(generationDirectory, '-', 'tarballs', `${record.artifact.sha512}.tgz`), record.artifact.sha512, 'corrupt');
      }
    }
    return manifest;
  });
}

function readCurrent(mirrorRoot: string, generationsDirectory: string): MynpmEffect<CurrentPublication> {
  return Effect.gen(function*() {
    const currentPath = join(mirrorRoot, 'current');
    const currentResult = yield* Effect.result(tryIO(() => lstat(currentPath), 'operation', `could not inspect current publication at ${currentPath}`));
    if (Result.isFailure(currentResult)) {
      if (causeCode(currentResult.failure) === 'ENOENT') return { target: null, artifacts: [] };
      return yield* Effect.fail(currentResult.failure);
    }
    if (!currentResult.success.isSymbolicLink()) return yield* failure('corrupt', `current publication is not a symbolic link: ${currentPath}`);
    const target = yield* tryIO(() => readlink(currentPath), 'operation', `could not read current publication target at ${currentPath}`);
    const match = /^generations\/([a-f0-9]{64})$/.exec(target);
    if (match === null) return yield* failure('corrupt', `current publication has an unsafe generation target: ${target}`);
    const manifest = yield* validateGeneration(generationsDirectory, match[1], mirrorRoot);
    if (manifest === null) return yield* failure('corrupt', `current publication points to a missing generation: ${match[1]}`);
    return { target, artifacts: manifest.artifacts };
  });
}

function mergeArtifacts(retained: readonly ArtifactRecord[], incoming: readonly ArtifactRecord[]): MynpmEffect<ArtifactRecord[]> {
  return Effect.gen(function*() {
    const merged = new Map(retained.map(record => [`${record.name}\0${record.version}`, record]));
    for (const record of incoming) {
      const key = `${record.name}\0${record.version}`;
      const existing = merged.get(key);
      if (existing && existing.artifact.sha512 !== record.artifact.sha512) {
        return yield* failure('conflict', `published digest conflicts for ${record.name}@${record.version}`);
      }
      merged.set(key, record);
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  });
}

function writeFully(handle: FileHandle, buffer: Buffer): MynpmEffect<void> {
  return Effect.gen(function*() {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = yield* tryIO(
        () => handle.write(buffer, offset, buffer.length - offset, null),
        'operation',
        'could not write published artifact',
      );
      if (bytesWritten === 0) return yield* failure('operation', 'file write made no progress');
      offset += bytesWritten;
    }
  });
}

function copyArtifact(
  record: ArtifactRecord,
  stateDirectory: string,
  tarballsDirectory: string,
  dependencies: PublicationDependencies,
): MynpmEffect<void> {
  return Effect.gen(function*() {
    const digest = record.artifact.sha512;
    const destination = join(tarballsDirectory, `${digest}.tgz`);
    const existing = yield* withRegularFile(destination, 'corrupt', true, () => Effect.succeed(true));
    if (existing !== null) {
      yield* hashRegularFile(destination, digest, 'corrupt');
      return;
    }
    const source = join(stateDirectory, 'objects', 'sha512', `${digest}.tgz`);
    yield* withRegularFile(source, 'corrupt', false, (sourceHandle, closeSource) => {
      const temporaryPath = join(tarballsDirectory, `.mynpm-${randomUUID()}.tmp`);
      const state = { destinationOpen: true, sourceOpen: true };
      return Effect.acquireUseRelease(
        tryIO(() => open(temporaryPath, 'wx', 0o644), 'operation', `could not create temporary artifact ${temporaryPath}`),
        destinationHandle => Effect.gen(function*() {
          const hash = createHash('sha512');
          yield* tryIO(() => destinationHandle.chmod(0o644), 'operation', `could not set artifact permissions: ${temporaryPath}`);
          const readable = yield* tryIO(
            signal => Promise.resolve(sourceHandle.createReadStream({ autoClose: false, signal })),
            'operation',
            `could not read state artifact ${source}`,
          );
          const stream = Stream.fromAsyncIterable(
            readable,
            cause => new MynpmError('operation', `could not read state artifact ${source}`, { cause }),
          );
          yield* Stream.runForEach(stream, chunk => Effect.gen(function*() {
            yield* Effect.sync(() => { hash.update(chunk); });
            yield* writeFully(destinationHandle, chunk);
          }));
          if (hash.digest('hex') !== digest) return yield* failure('corrupt', `state artifact digest mismatch for ${record.name}@${record.version}`);
          yield* tryIO(() => destinationHandle.sync(), 'operation', `could not synchronize artifact ${temporaryPath}`);
          yield* tryIO(() => destinationHandle.close(), 'operation', `could not close artifact ${temporaryPath}`);
          state.destinationOpen = false;
          yield* closeSource();
          state.sourceOpen = false;
          yield* tryIO(() => (dependencies.link ?? link)(temporaryPath, destination), 'operation', `could not publish artifact ${record.name}@${record.version}`);
        }),
        destinationHandle => Effect.gen(function*() {
          if (state.destinationOpen) yield* tryIO(() => destinationHandle.close(), 'operation', `could not close artifact ${temporaryPath}`);
          if (state.sourceOpen) yield* closeSource();
          yield* tryIO(() => unlink(temporaryPath), 'operation', `could not remove temporary artifact ${temporaryPath}`).pipe(
            Effect.catchIf(error => causeCode(error) === 'ENOENT', () => Effect.void),
          );
        }),
      ).pipe(
        Effect.catchIf(
          error => causeCode(error) === 'EEXIST',
          () => hashRegularFile(destination, digest, 'corrupt').pipe(Effect.asVoid),
        ),
        Effect.asVoid,
      );
    });
    yield* syncPublicationDirectory(tarballsDirectory, dependencies);
  });
}

function writeDurableFile(path: string, bytes: Buffer): MynpmEffect<void> {
  return Effect.acquireUseRelease(
    tryIO(() => open(path, 'wx', 0o644), 'operation', `could not create file ${path}`),
    handle => Effect.gen(function*() {
      yield* tryIO(() => handle.chmod(0o644), 'operation', `could not set file permissions: ${path}`);
      yield* tryIO(() => handle.writeFile(bytes), 'operation', `could not write file ${path}`);
      yield* tryIO(() => handle.sync(), 'operation', `could not synchronize file ${path}`);
    }),
    handle => tryIO(() => handle.close(), 'operation', `could not close file ${path}`),
  );
}

function syncGenerationTree(directory: string, sync: (directory: string) => MynpmEffect<void> = syncDirectory): MynpmEffect<void> {
  return Effect.gen(function*() {
    const children = yield* tryIO(() => readdir(directory, { withFileTypes: true }), 'operation', `could not read generation directory ${directory}`);
    for (const child of children) {
      if (child.isDirectory()) yield* syncGenerationTree(join(directory, child.name), sync);
    }
    yield* Effect.acquireUseRelease(
      tryIO(() => open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), 'operation', `could not open generation directory ${directory}`),
      handle => tryIO(() => handle.chmod(0o755), 'operation', `could not set directory permissions: ${directory}`),
      handle => tryIO(() => handle.close(), 'operation', `could not close generation directory ${directory}`),
    );
    yield* sync(directory);
  });
}

function writeGenerationTarballAliases(
  directory: string,
  artifacts: readonly ArtifactRecord[],
  mirrorRoot: string,
  dependencies: PublicationDependencies,
): MynpmEffect<void> {
  return Effect.gen(function*() {
    const digests = [...new Set(artifacts.map(record => record.artifact.sha512))].sort();
    if (digests.length === 0) return;
    for (const relativeDirectory of ['tarballs', join('-', 'tarballs')]) {
      const directoryPath = join(directory, relativeDirectory);
      yield* tryIO(() => mkdir(directoryPath, { recursive: true, mode: 0o755 }), 'operation', `could not create generation tarballs directory ${directoryPath}`);
      for (const digest of digests) {
        const alias = join(directoryPath, `${digest}.tgz`);
        yield* tryIO(
          () => (dependencies.link ?? link)(join(mirrorRoot, 'tarballs', `${digest}.tgz`), alias),
          'operation',
          `could not expose published artifact ${digest}`,
        );
        yield* hashRegularFile(alias, digest, 'corrupt');
      }
    }
  });
}

function ensureGeneration(
  generationsDirectory: string,
  id: string,
  manifest: GenerationManifest,
  files: readonly PackumentFile[],
  dependencies: GenerationDependencies,
): MynpmEffect<void> {
  return Effect.gen(function*() {
    const finalDirectory = join(generationsDirectory, id);
    const existing = yield* validateGeneration(generationsDirectory, id, dependencies.mirrorRoot);
    if (existing !== null) return;
    const temporaryDirectory = join(generationsDirectory, `.mynpm-generation-${id}-${randomUUID()}`);
    const generationState = { renamed: false };
    yield* Effect.acquireUseRelease(
      tryIO(() => mkdir(temporaryDirectory, { mode: 0o755 }), 'operation', `could not create temporary generation ${temporaryDirectory}`).pipe(
        Effect.as(generationState),
      ),
      () => Effect.gen(function*() {
        let renamed = false;
        for (const file of files) {
          const path = join(temporaryDirectory, file.path);
          const parent = dirname(path);
          if (parent !== temporaryDirectory) {
            yield* tryIO(() => mkdir(parent, { recursive: true, mode: 0o755 }), 'operation', `could not create generation directory ${parent}`);
          }
          yield* writeDurableFile(path, file.bytes);
        }
        yield* writeGenerationTarballAliases(temporaryDirectory, manifest.artifacts, dependencies.mirrorRoot, dependencies);
        yield* writeDurableFile(join(temporaryDirectory, 'manifest.json'), Buffer.from(canonicalJson(manifest), 'utf8'));
        yield* syncGenerationTree(temporaryDirectory, path => syncPublicationDirectory(path, dependencies, `could not finalize generation ${id}`));
        yield* tryIO(
          () => (dependencies.rename ?? rename)(temporaryDirectory, finalDirectory),
          'operation',
          `could not finalize generation ${id}`,
        ).pipe(
          Effect.tap(() => Effect.sync(() => { renamed = true; })),
          Effect.catchIf(
            error => ['EEXIST', 'ENOTEMPTY'].includes(causeCode(error) ?? ''),
            error => Effect.gen(function*() {
              const concurrent = yield* validateGeneration(dependencies.generationsDirectory, id, dependencies.mirrorRoot);
              if (concurrent === null) return yield* Effect.fail(error);
            }),
          ),
        );
        generationState.renamed = renamed;
        yield* syncPublicationDirectory(generationsDirectory, dependencies, `could not finalize generation ${id}`);
      }),
      state => state.renamed
        ? Effect.void
        : tryIO(() => rm(temporaryDirectory, { recursive: true, force: true }), 'operation', `could not remove temporary generation ${temporaryDirectory}`),
    );
  });
}

function switchCurrent(mirrorRoot: string, nextTarget: string, oldTarget: string | null, dependencies: PublicationDependencies): MynpmEffect<void> {
  return Effect.gen(function*() {
    const currentPath = join(mirrorRoot, 'current');
    const temporaryPath = join(mirrorRoot, `.current-${randomUUID()}`);
    yield* tryIO(() => (dependencies.symlink ?? symlink)(nextTarget, temporaryPath), 'operation', 'could not create the next current publication link');
    const switchResult = yield* Effect.result(tryIO(
      () => (dependencies.rename ?? rename)(temporaryPath, currentPath),
      'operation',
      'could not atomically switch the current publication',
    ));
    if (Result.isFailure(switchResult)) {
      const cleanup = yield* Effect.result(tryIO(() => unlink(temporaryPath), 'operation', `could not remove temporary publication link ${temporaryPath}`).pipe(
        Effect.catchIf(error => causeCode(error) === 'ENOENT', () => Effect.void),
      ));
      if (Result.isFailure(cleanup)) {
        return yield* failure('operation', 'could not switch publication and remove its temporary link', { cause: new AggregateError([switchResult.failure, cleanup.failure]) });
      }
      return yield* Effect.fail(switchResult.failure);
    }
    const syncResult = yield* Effect.result(syncPublicationDirectory(mirrorRoot, dependencies));
    if (Result.isSuccess(syncResult)) return;
    const rollback = yield* Effect.result(Effect.gen(function*() {
      if (oldTarget === null) {
        yield* tryIO(() => unlink(currentPath), 'operation', `could not remove current publication ${currentPath}`);
      } else {
        const rollbackPath = join(mirrorRoot, `.current-rollback-${randomUUID()}`);
        yield* tryIO(() => (dependencies.symlink ?? symlink)(oldTarget, rollbackPath), 'operation', 'could not create rollback publication link');
        yield* tryIO(() => (dependencies.rename ?? rename)(rollbackPath, currentPath), 'operation', 'could not restore prior current publication');
      }
      yield* syncPublicationDirectory(mirrorRoot, dependencies);
    }));
    if (Result.isFailure(rollback)) {
      return yield* failure('operation', 'current publication changed but durability failed and rollback was incomplete', {
        cause: new AggregateError([syncResult.failure, rollback.failure]),
      });
    }
    return yield* failure('operation', 'could not durably switch the current publication', { cause: syncResult.failure });
  });
}

export function publishSite(
  { stateDirectory, siteDirectory, config }: { stateDirectory: string; siteDirectory: string; config: MynpmConfig },
  dependencies: PublicationDependencies = {},
): Effect.Effect<PublishResult, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    const siteRoot = yield* ensureDirectoryTree(siteDirectory);
    const mirrorRoot = join(siteRoot, 'mirror');
    yield* ensureDirectory(mirrorRoot, 'operation', true);
    const generationsDirectory = join(mirrorRoot, 'generations');
    const tarballsDirectory = join(mirrorRoot, 'tarballs');
    yield* ensureDirectory(generationsDirectory, 'operation', true);
    yield* ensureDirectory(tarballsDirectory, 'operation', true);
    yield* acquireFilesystemLock(mirrorRoot, '.publish.lock', 'publication');
    const beforeInventoryRead = dependencies.beforeInventoryRead;
    if (beforeInventoryRead) yield* tryIO(() => Promise.resolve(beforeInventoryRead()), 'operation', 'before-inventory hook failed');
    const inventory: Inventory = yield* loadInventory(stateDirectory);
    const afterInventoryRead = dependencies.afterInventoryRead;
    if (afterInventoryRead) yield* tryIO(() => Promise.resolve(afterInventoryRead(inventory)), 'operation', 'after-inventory hook failed');
    yield* verifyInventorySnapshot({ stateDirectory, config, inventory });
    const current = yield* readCurrent(mirrorRoot, generationsDirectory);
    const artifacts = yield* mergeArtifacts(current.artifacts, inventory.artifacts);
    const publicBaseUrl = dependencies.renderBaseUrl ?? config.publicBaseUrl;
    const files = yield* tryValue(() => renderPackumentFiles(artifacts, publicBaseUrl), 'operation', 'could not render publication packuments');
    const id = yield* tryValue(() => generationId(publicBaseUrl, artifacts, files, rendererVersion), 'operation', 'could not identify publication generation');
    const manifest = yield* parseManifest(canonicalJson({
      schemaVersion: 1,
      rendererVersion,
      publicBaseUrl,
      generationId: id,
      artifacts,
    }), 'candidate manifest');
    for (const record of artifacts) yield* copyArtifact(record, stateDirectory, tarballsDirectory, dependencies);
    yield* ensureGeneration(generationsDirectory, id, manifest, files, { ...dependencies, mirrorRoot, generationsDirectory });
    const target = `generations/${id}`;
    if (current.target === target) return { generationId: id, packageCount: files.length, versionCount: artifacts.length, noOp: true };
    yield* switchCurrent(mirrorRoot, target, current.target, dependencies);
    return { generationId: id, packageCount: files.length, versionCount: artifacts.length, noOp: false };
  }));
}
