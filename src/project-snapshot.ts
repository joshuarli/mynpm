import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { PackageManager, ProjectRecord, ProjectSnapshot } from './inventory.ts';
import { errorCode, MynpmError } from './errors.ts';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function sanitizedLockfileText(text: string, manager: PackageManager): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, value => {
    try {
      const url = new URL(value);
      const hasCredentials = url.username !== '' || url.password !== '' || url.search !== '';
      url.username = '';
      url.password = '';
      url.search = '';
      if (manager === 'pnpm' || hasCredentials) url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  });
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
      if (contents !== null) workspaceFiles.push({ path: relativePath, contents });
    }
    if (manager === 'pnpm') {
      const contents = yield* readProjectFile(projectRoot, 'pnpm-workspace.yaml', { optional: true });
      if (contents !== null) workspaceFiles.push({ path: 'pnpm-workspace.yaml', contents });
    }
    return {
      manifest,
      lockfile: sanitizedLockfileText(lockfileText, manager),
      workspaceFiles,
    };
  });
}
