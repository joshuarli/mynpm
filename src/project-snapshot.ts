import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { parseAllDocuments } from 'yaml';
import type { PackageManager, ProjectRecord, ProjectSnapshot } from './inventory.ts';
import { errorCode, MynpmError } from './errors.ts';

type JsonRecord = Record<string, unknown>;
type NpmInstallOptions = ProjectSnapshot['npmInstallOptions'];

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failInput(message: string): never {
  throw new MynpmError('input', message);
}

function fileOperation<Value>(
  operation: (signal: AbortSignal) => PromiseLike<Value>,
  mapError: (cause: unknown) => MynpmError,
): Effect.Effect<Value, MynpmError> {
  return Effect.tryPromise({ try: operation, catch: mapError });
}

function safeProjectPath(value: string, label: string): string[] {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\')) {
    throw new MynpmError('input', `${label} is not a safe project-relative path`);
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new MynpmError('input', `${label} is not a safe project-relative path`);
  }
  return segments;
}

function readProjectFile(projectRoot: string, relativePath: string, { optional = false }: { optional?: boolean } = {}): Effect.Effect<string | null, MynpmError> {
  return Effect.gen(function*() {
    const segments = yield* Effect.try({
      try: () => safeProjectPath(relativePath, 'project snapshot path'),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('input', `project snapshot path is not safe: ${relativePath}`, { cause }),
    });
    let directory = projectRoot;
    for (const segment of segments.slice(0, -1)) {
      directory = join(directory, segment);
      const info = yield* fileOperation(
        () => lstat(directory).catch(cause => {
          if (optional && errorCode(cause) === 'ENOENT') return null;
          throw cause;
        }),
        cause => new MynpmError('input', `could not inspect project snapshot path ${relativePath}`, { cause }),
      );
      if (info === null) return null;
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return yield* Effect.fail(new MynpmError('input', `project snapshot path is not a regular directory: ${relativePath}`));
      }
    }
    const fileName = segments.at(-1);
    if (fileName === undefined) return yield* Effect.fail(new MynpmError('input', 'project snapshot path must not be empty'));
    const filePath = join(directory, fileName);
    return yield* Effect.acquireUseRelease(
      fileOperation(
        () => open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(cause => {
          if (optional && errorCode(cause) === 'ENOENT') return null;
          throw cause;
        }),
        cause => new MynpmError('input', `could not read project snapshot path ${relativePath}`, { cause }),
      ),
      (handle: FileHandle | null) => {
        if (handle === null) return Effect.succeed(null);
        return Effect.gen(function*() {
          const info = yield* fileOperation(() => handle.stat(), cause => new MynpmError('input', `could not read project snapshot path ${relativePath}`, { cause }));
          if (!info.isFile()) return yield* Effect.fail(new MynpmError('input', `project snapshot path is not a regular file: ${relativePath}`));
          return yield* fileOperation(signal => handle.readFile({ encoding: 'utf8', signal }), cause => new MynpmError('input', `could not read project snapshot path ${relativePath}`, { cause }));
        });
      },
      (handle: FileHandle | null) => handle === null
        ? Effect.void
        : fileOperation(() => handle.close(), cause => new MynpmError('input', `could not read project snapshot path ${relativePath}`, { cause })),
    );
  });
}

function assertNoCredentialUrls(value: unknown, label: string): void {
  if (typeof value === 'string') {
    const urls = value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi) ?? [];
    for (const candidate of urls) {
      const normalized = candidate.replace(/^git\+/i, '');
      const authority = normalized.slice(normalized.indexOf('://') + 3).split(/[/?#]/, 1)[0];
      try {
        const url = new URL(normalized);
        if (authority.includes('@') || url.username !== '' || url.password !== '' || url.search !== '') {
          failInput(`${label} contains a credential-bearing URL`);
        }
      } catch (cause) {
        if (cause instanceof MynpmError) throw cause;
        if (authority.includes('@') || normalized.includes('?')) failInput(`${label} contains a credential-bearing URL`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoCredentialUrls(entry, label);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) assertNoCredentialUrls(entry, label);
  }
}

function parseManifest(text: string, label: string, manager: PackageManager): JsonRecord {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('input', `${label} is not valid JSON`, { cause });
  }
  if (!isRecord(manifest)) failInput(`${label} must contain an object`);
  assertNoCredentialUrls(manifest, label);
  if (manager === 'pnpm') {
    inspectPnpmConfiguration(manifest.pnpm, `${label}.pnpm`);
    if (isRecord(manifest.devEngines) && Object.hasOwn(manifest.devEngines, 'runtime')) {
      failInput(`unsupported pnpm project configuration: runtime in ${label}`);
    }
  }
  return manifest;
}

function parseNpmrc(text: string | null, manager: PackageManager): NpmInstallOptions {
  const options: NpmInstallOptions = { legacyPeerDeps: null, installLinks: null };
  if (text === null) return options;
  const seen = new Set<string>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    const key = (separator < 0 ? line : line.slice(0, separator)).trim().toLowerCase();
    const option = key === 'legacy-peer-deps' ? 'legacyPeerDeps' : key === 'install-links' ? 'installLinks' : null;
    if (option === null) failInput(`unsupported .npmrc setting ${key || `on line ${index + 1}`}`);
    if (manager !== 'npm') failInput(`unsupported .npmrc setting ${key} for pnpm`);
    if (seen.has(key)) failInput(`duplicate .npmrc setting ${key}`);
    seen.add(key);
    const rawValue = separator < 0 ? 'true' : line.slice(separator + 1).trim().toLowerCase();
    if (rawValue !== 'true' && rawValue !== 'false') {
      failInput(`.npmrc setting ${key} must be true or false`);
    }
    options[option] = rawValue === 'true';
  }
  return options;
}

function parseYamlDocuments(text: string, label: string): unknown[] {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(text, { uniqueKeys: true });
  } catch (cause) {
    throw new MynpmError('input', `${label} is not valid YAML`, { cause });
  }
  const errors = documents.flatMap(document => document.errors);
  if (errors.length > 0) throw new MynpmError('input', `${label} contains invalid YAML: ${errors[0].message}`, { cause: errors[0] });
  return documents.map(document => document.toJSON());
}

function hasEntries(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function unsupportedPnpmConfigurationKey(key: string): string | null {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  if (normalized.includes('registry')) return 'custom registry';
  if (normalized === 'runtime' || normalized === 'nodeversion' || normalized === 'usenodeversion' || normalized === 'executionenv') return 'runtime';
  if (normalized === 'pnpmfile' || normalized === 'hooks') return 'executable hook';
  if (normalized === 'configdependencies') return 'configuration dependency';
  if (normalized === 'patcheddependencies' || normalized === 'patches') return 'patch configuration';
  return null;
}

function inspectPnpmConfiguration(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const kind = unsupportedPnpmConfigurationKey(key);
    if (kind !== null && (kind === 'custom registry' || hasEntries(child))) {
      failInput(`unsupported pnpm project configuration: ${kind} in ${label}`);
    }
    if (key === 'settings' || key === 'pnpm') inspectPnpmConfiguration(child, `${label}.${key}`);
  }
}

function preflightPnpmLock(value: unknown, label: string): void {
  if (!isRecord(value)) failInput(`${label} document must be an object`);
  inspectPnpmConfiguration(value.settings, `${label}.settings`);
  for (const [key, child] of Object.entries(value)) {
    const kind = unsupportedPnpmConfigurationKey(key);
    if (kind !== null && (kind === 'custom registry' || hasEntries(child))) {
      failInput(`unsupported pnpm project configuration: ${kind} in ${label}`);
    }
  }
  const importers = value.importers;
  if (isRecord(importers)) {
    for (const [importer, entry] of Object.entries(importers)) {
      if (isRecord(entry) && hasEntries(entry.configDependencies)) {
        failInput(`unsupported pnpm project configuration: configuration dependency in ${label}.importers.${importer}`);
      }
      if (isRecord(entry) && hasEntries(entry.packageManagerDependencies)) {
        failInput(`unsupported pnpm project configuration: package-manager boot dependency in ${label}.importers.${importer}`);
      }
    }
  }
  for (const section of ['packages', 'snapshots']) {
    const entries = value[section];
    if (isRecord(entries) && Object.keys(entries).some(key => /patch_hash=/i.test(key))) {
      failInput(`unsupported pnpm project configuration: patch configuration in ${label}.${section}`);
    }
  }
}

function preflightPnpmConfig(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  inspectPnpmConfiguration(value, label);
  const nestedPnpm = value.pnpm;
  inspectPnpmConfiguration(nestedPnpm, `${label}.pnpm`);
}

function preflightPnpmLockfile(text: string): void {
  const documents = parseYamlDocuments(text, 'pnpm lockfile');
  for (const [index, document] of documents.entries()) {
    assertNoCredentialUrls(document, `pnpm lockfile document ${index + 1}`);
    preflightPnpmLock(document, `pnpm lockfile document ${index + 1}`);
  }
}

function validateSnapshotContents(manager: PackageManager, snapshot: ProjectSnapshot): void {
  if (snapshot.manifest !== null) parseManifest(snapshot.manifest, 'project package.json snapshot', manager);
  if (manager === 'npm') {
    const lock = JSON.parse(snapshot.lockfile) as unknown;
    assertNoCredentialUrls(lock, 'npm lockfile snapshot');
  } else {
    preflightPnpmLockfile(snapshot.lockfile);
  }
  for (const file of snapshot.workspaceFiles) {
    if (file.path === 'pnpm-workspace.yaml' && manager === 'pnpm') {
      const documents = parseYamlDocuments(file.contents, file.path);
      for (const [index, document] of documents.entries()) {
        assertNoCredentialUrls(document, `${file.path} document ${index + 1}`);
        preflightPnpmConfig(document, `${file.path} document ${index + 1}`);
      }
    } else if (file.path.endsWith('/package.json')) {
      parseManifest(file.contents, file.path, manager);
    } else {
      failInput(`unsupported project snapshot file ${file.path}`);
    }
  }
}

export function assertRestorableProjectSnapshot(manager: PackageManager, snapshot: ProjectSnapshot): void {
  validateSnapshotContents(manager, snapshot);
}

function npmWorkspacePaths(lock: unknown): Set<string> {
  if (!isRecord(lock)) throw new MynpmError('input', 'npm lockfile must be an object');
  const packagesValue = lock.packages ?? {};
  if (!isRecord(packagesValue)) throw new MynpmError('input', 'npm lockfile packages must be an object');
  const paths = new Set<string>();
  for (const entryValue of Object.values(packagesValue)) {
    if (!isRecord(entryValue) || entryValue.link !== true || typeof entryValue.resolved !== 'string') continue;
    const target = entryValue.resolved.replace(/^file:/, '').replace(/^\.\//, '');
    if (target.startsWith('/') || target.includes('\\') || target.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) continue;
    paths.add(target);
  }
  return paths;
}

export type CaptureProjectSnapshotOptions = {
  manager: PackageManager;
  projectDirectory: string;
  lockfileText: string;
  lock: unknown;
  project: ProjectRecord;
};

export function captureProjectSnapshot({ manager, projectDirectory, lockfileText, lock, project }: CaptureProjectSnapshotOptions): Effect.Effect<ProjectSnapshot, MynpmError> {
  return Effect.gen(function*() {
    const projectRoot = yield* fileOperation(
      () => realpath(projectDirectory),
      cause => new MynpmError('input', `could not resolve project directory ${projectDirectory}`, { cause }),
    );
    const manifest = yield* readProjectFile(projectRoot, 'package.json', { optional: true });
    const npmrc = yield* readProjectFile(projectRoot, '.npmrc', { optional: true });
    const npmInstallOptions = yield* Effect.try({
      try: () => parseNpmrc(npmrc, manager),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('input', 'could not inspect project .npmrc', { cause }),
    });
    if (manager === 'pnpm') {
      for (const hookPath of ['.pnpmfile.cjs', '.pnpmfile.mjs']) {
        const hook = yield* readProjectFile(projectRoot, hookPath, { optional: true });
        if (hook !== null) return yield* Effect.fail(new MynpmError('input', `unsupported pnpm project configuration: executable hook ${hookPath}`));
      }
    }
    const workspacePaths = manager === 'pnpm'
      ? new Set(project.importers.filter(importer => importer !== '.'))
      : yield* Effect.try({
          try: () => npmWorkspacePaths(lock),
          catch: cause => cause instanceof MynpmError ? cause : new MynpmError('input', 'could not inspect npm workspace lockfile', { cause }),
        });
    const workspaceFiles: ProjectSnapshot['workspaceFiles'] = [];
    for (const workspacePath of [...workspacePaths].sort()) {
      const relativePath = `${workspacePath}/package.json`;
      const contents = yield* readProjectFile(projectRoot, relativePath, { optional: true });
      if (contents !== null) {
        workspaceFiles.push({ path: relativePath, contents });
      }
    }
    if (manager === 'pnpm') {
      const contents = yield* readProjectFile(projectRoot, 'pnpm-workspace.yaml', { optional: true });
      if (contents !== null) {
        workspaceFiles.push({ path: 'pnpm-workspace.yaml', contents });
      }
    }
    const snapshot: ProjectSnapshot = {
      manifest,
      lockfile: lockfileText,
      workspaceFiles,
      npmInstallOptions,
    };
    yield* Effect.try({
      try: () => assertRestorableProjectSnapshot(manager, snapshot),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('input', 'could not inspect project snapshot policy', { cause }),
    });
    return snapshot;
  });
}
