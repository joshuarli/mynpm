import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, link, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import type { Scope } from 'effect/Scope';
import { createEmptyInventory, parseInventory, serializeInventory } from './inventory.ts';
import type { Inventory } from './inventory.ts';
import { errorCode, MynpmError } from './errors.ts';

interface LockOwner {
  pid: number;
  token: string;
}

interface LockLease {
  lockPath: string;
  resourceName: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function filesystemOperation<Value>(
  operation: (signal: AbortSignal) => PromiseLike<Value>,
  mapError: (cause: unknown) => MynpmError,
): Effect.Effect<Value, MynpmError> {
  return Effect.tryPromise({ try: operation, catch: mapError });
}

function causeErrorCode(cause: unknown): string | undefined {
  return cause instanceof MynpmError ? errorCode(cause.cause) : errorCode(cause);
}

function syncDirectory(directory: string, failure: (cause: unknown) => MynpmError): Effect.Effect<void, MynpmError> {
  return Effect.acquireUseRelease(
    filesystemOperation(() => open(directory, 'r'), failure),
    handle => filesystemOperation(() => handle.sync(), failure),
    handle => filesystemOperation(() => handle.close(), failure),
  );
}

function processIsAlive(pid: number, resourceName: string, lockPath: string): Effect.Effect<boolean, MynpmError> {
  if (!Number.isSafeInteger(pid) || pid < 1) return Effect.succeed(false);
  return Effect.try({
    try: () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause) {
        if (errorCode(cause) === 'ESRCH') return false;
        if (errorCode(cause) === 'EPERM') return true;
        throw cause;
      }
    },
    catch: cause => new MynpmError('operation', `could not inspect ${resourceName} lock at ${lockPath}`, { cause }),
  });
}

function readLock(lockPath: string, resourceName: string): Effect.Effect<LockOwner | null, MynpmError> {
  return Effect.gen(function*() {
    const text = yield* Effect.acquireUseRelease(
      filesystemOperation(
        () => open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(cause => {
          if (errorCode(cause) === 'ENOENT') return null;
          throw cause;
        }),
        cause => errorCode(cause) === 'ELOOP'
          ? new MynpmError('corrupt', `${resourceName} lock is a symbolic link at ${lockPath}`)
          : new MynpmError('operation', `could not inspect ${resourceName} lock at ${lockPath}`, { cause }),
      ),
      (handle: FileHandle | null) => {
        if (handle === null) return Effect.succeed(null);
        return Effect.gen(function*() {
          const info = yield* filesystemOperation(
            () => handle.stat(),
            cause => new MynpmError('operation', `could not inspect ${resourceName} lock at ${lockPath}`, { cause }),
          );
          if (!info.isFile()) return yield* Effect.fail(new MynpmError('corrupt', `${resourceName} lock is not a regular file at ${lockPath}`));
          return yield* filesystemOperation(
            signal => handle.readFile({ encoding: 'utf8', signal }),
            cause => new MynpmError('operation', `could not inspect ${resourceName} lock at ${lockPath}`, { cause }),
          );
        });
      },
      (handle: FileHandle | null) => handle === null
        ? Effect.void
        : filesystemOperation(
            () => handle.close(),
            cause => new MynpmError('operation', `could not inspect ${resourceName} lock at ${lockPath}`, { cause }),
          ),
    );
    if (text === null) return null;
    const owner: unknown = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: cause => new MynpmError('corrupt', `${resourceName} lock is not valid JSON at ${lockPath}`, { cause }),
    });
    if (!isRecord(owner)) return yield* Effect.fail(new MynpmError('corrupt', `${resourceName} lock has an invalid owner at ${lockPath}`));
    const pid = owner.pid;
    const token = owner.token;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || typeof token !== 'string') {
      return yield* Effect.fail(new MynpmError('corrupt', `${resourceName} lock has an invalid owner at ${lockPath}`));
    }
    return { pid, token };
  });
}

function unlinkIfPresent(path: string, mapError: (cause: unknown) => MynpmError): Effect.Effect<void, MynpmError> {
  return filesystemOperation(
    () => unlink(path).catch(cause => {
      if (errorCode(cause) === 'ENOENT') return;
      throw cause;
    }),
    mapError,
  );
}

function releaseLock(lease: LockLease): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    const owner = yield* readLock(lease.lockPath, lease.resourceName);
    if (owner?.token !== lease.token) return yield* Effect.fail(new MynpmError('conflict', `${lease.resourceName} lock ownership changed before release`));
    const releaseError = (cause: unknown) => new MynpmError('operation', `could not release ${lease.resourceName} lock at ${lease.lockPath}`, { cause });
    yield* filesystemOperation(() => unlink(lease.lockPath), releaseError);
    yield* syncDirectory(dirname(lease.lockPath), releaseError);
  });
}

function acquireLockLease(directory: string, lockName: string, resourceName: string): Effect.Effect<LockLease, MynpmError> {
  const lockPath = join(directory, lockName);
  return Effect.gen(function*() {
    for (;;) {
      const token = randomUUID();
      const temporaryPath = join(directory, `.${lockName.replace(/^\./, '').replace(/\.lock$/, '')}-lock-${token}.tmp`);
      let handle: FileHandle | undefined;
      let linked = false;
      const acquireAttempt = Effect.gen(function*() {
        const failure = (cause: unknown) => new MynpmError('operation', `could not acquire ${resourceName} lock at ${lockPath}`, { cause });
        handle = yield* filesystemOperation(() => open(temporaryPath, 'wx', 0o600), failure);
        const temporaryHandle = handle;
        yield* filesystemOperation(
          signal => temporaryHandle.writeFile(JSON.stringify({ pid: process.pid, token }), { encoding: 'utf8', signal }),
          failure,
        );
        yield* filesystemOperation(() => temporaryHandle.sync(), failure);
        yield* filesystemOperation(() => temporaryHandle.close(), failure);
        handle = undefined;
        yield* filesystemOperation(() => link(temporaryPath, lockPath), failure);
        linked = true;
        yield* filesystemOperation(() => unlink(temporaryPath), failure);
        yield* syncDirectory(directory, failure);
        return { lockPath, resourceName, token } satisfies LockLease;
      });
      const attempt = yield* Effect.match(acquireAttempt, {
        onFailure: error => ({ _tag: 'failure' as const, error }),
        onSuccess: lease => ({ _tag: 'success' as const, lease }),
      });
      if (attempt._tag === 'success') return attempt.lease;
      const cause = attempt.error;
      const cleanupErrors: unknown[] = [];
      if (handle !== undefined) {
        const cleanupHandle = handle;
        const cleanup = yield* Effect.match(
          filesystemOperation(() => cleanupHandle.close(), error => new MynpmError('operation', `could not clean up ${resourceName} lock at ${directory}`, { cause: error })),
          {
            onFailure: error => ({ _tag: 'failure' as const, error }),
            onSuccess: () => ({ _tag: 'success' as const }),
          },
        );
        if (cleanup._tag === 'failure') cleanupErrors.push(cleanup.error.cause ?? cleanup.error);
      }
      const cleanupError = (error: unknown) => new MynpmError('operation', `could not clean up ${resourceName} lock at ${directory}`, { cause: error });
      if (!linked) {
        const cleanup = yield* Effect.match(unlinkIfPresent(temporaryPath, cleanupError), {
          onFailure: error => ({ _tag: 'failure' as const, error }),
          onSuccess: () => ({ _tag: 'success' as const }),
        });
        if (cleanup._tag === 'failure') cleanupErrors.push(cleanup.error.cause ?? cleanup.error);
      }
      if (linked) {
        for (const path of [lockPath, temporaryPath]) {
          const cleanup = yield* Effect.match(unlinkIfPresent(path, cleanupError), {
            onFailure: error => ({ _tag: 'failure' as const, error }),
            onSuccess: () => ({ _tag: 'success' as const }),
          });
          if (cleanup._tag === 'failure') cleanupErrors.push(cleanup.error.cause ?? cleanup.error);
        }
      }
      if (cleanupErrors.length > 0) {
        return yield* Effect.fail(new MynpmError(
          'operation',
          `${resourceName} lock cleanup failed at ${directory}`,
          { cause: new AggregateError([cause.cause ?? cause, ...cleanupErrors]) },
        ));
      }
      if (causeErrorCode(cause) !== 'EEXIST') return yield* Effect.fail(cause);
      const owner = yield* readLock(lockPath, resourceName);
      if (owner === null) continue;
      if (yield* processIsAlive(owner.pid, resourceName, lockPath)) {
        return yield* Effect.fail(new MynpmError('conflict', `another mynpm operation is updating ${resourceName}`));
      }
      const inspectLockError = (error: unknown) => new MynpmError('operation', `could not inspect ${resourceName} lock at ${lockPath}`, { cause: error });
      const before = yield* filesystemOperation(
        () => lstat(lockPath).catch(error => {
          if (errorCode(error) === 'ENOENT') return null;
          throw error;
        }),
        inspectLockError,
      );
      const current = yield* readLock(lockPath, resourceName);
      const after = yield* filesystemOperation(
        () => lstat(lockPath).catch(error => {
          if (errorCode(error) === 'ENOENT') return null;
          throw error;
        }),
        inspectLockError,
      );
      if (current?.token === owner.token && before && after && before.dev === after.dev && before.ino === after.ino && !(yield* processIsAlive(current.pid, resourceName, lockPath))) {
        yield* unlinkIfPresent(lockPath, inspectLockError);
      }
    }
  });
}

export function acquireFilesystemLock(directory: string, lockName: string, resourceName: string): Effect.Effect<void, MynpmError, Scope> {
  return Effect.asVoid(Effect.acquireRelease(
    acquireLockLease(directory, lockName, resourceName),
    lease => Effect.catch(releaseLock(lease), cause => Effect.die(cause)),
  ));
}

export function loadInventory(stateDirectory: string): Effect.Effect<Inventory, MynpmError> {
  const inventoryPath = join(stateDirectory, 'inventory.json');
  return Effect.gen(function*() {
    const contents = yield* Effect.acquireUseRelease(
      filesystemOperation(
        () => open(inventoryPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(cause => {
          if (errorCode(cause) === 'ENOENT') return null;
          throw cause;
        }),
        cause => errorCode(cause) === 'ELOOP'
          ? new MynpmError('corrupt', `inventory is a symbolic link: ${inventoryPath}`)
          : new MynpmError('operation', `could not read inventory at ${inventoryPath}`, { cause }),
      ),
      (handle: FileHandle | null) => {
        if (handle === null) return Effect.succeed(null);
        return Effect.gen(function*() {
          const info = yield* filesystemOperation(
            () => handle.stat(),
            cause => new MynpmError('operation', `could not read inventory at ${inventoryPath}`, { cause }),
          );
          if (!info.isFile()) return yield* Effect.fail(new MynpmError('corrupt', `inventory is not a regular file: ${inventoryPath}`));
          return yield* filesystemOperation(
            signal => handle.readFile({ encoding: 'utf8', signal }),
            cause => new MynpmError('operation', `could not read inventory at ${inventoryPath}`, { cause }),
          );
        });
      },
      (handle: FileHandle | null) => handle === null
        ? Effect.void
        : filesystemOperation(
            () => handle.close(),
            cause => new MynpmError('operation', `could not read inventory at ${inventoryPath}`, { cause }),
          ),
    );
    if (contents === null) return createEmptyInventory();
    return yield* Effect.try({
      try: () => parseInventory(contents),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('corrupt', 'inventory is not valid JSON', { cause }),
    });
  });
}

function writeInventory(stateDirectory: string, inventory: Inventory): Effect.Effect<void, MynpmError> {
  const inventoryPath = join(stateDirectory, 'inventory.json');
  return Effect.gen(function*() {
    const existing = yield* filesystemOperation(
      () => lstat(inventoryPath).catch(cause => {
        if (errorCode(cause) === 'ENOENT') return null;
        throw cause;
      }),
      cause => new MynpmError('operation', `could not inspect inventory at ${inventoryPath}`, { cause }),
    );
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      return yield* Effect.fail(new MynpmError('corrupt', `inventory is not a regular file: ${inventoryPath}`));
    }
    const contents = yield* Effect.try({
      try: () => serializeInventory(inventory),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('corrupt', 'inventory is not serializable', { cause }),
    });
    const temporaryPath = join(stateDirectory, `.${basename(inventoryPath)}.${randomUUID()}.tmp`);
    let renamed = false;
    const failure = (cause: unknown) => new MynpmError('operation', `could not write inventory at ${inventoryPath}`, { cause });
    const write = Effect.gen(function*() {
      yield* Effect.acquireUseRelease(
        filesystemOperation(() => open(temporaryPath, 'wx', 0o600), failure),
        handle => Effect.gen(function*() {
          yield* filesystemOperation(signal => handle.writeFile(contents, { encoding: 'utf8', signal }), failure);
          yield* filesystemOperation(() => handle.sync(), failure);
        }),
        handle => filesystemOperation(() => handle.close(), failure),
      );
      yield* filesystemOperation(() => rename(temporaryPath, inventoryPath), failure);
      renamed = true;
      yield* syncDirectory(stateDirectory, failure);
    });
    const result = yield* Effect.match(write, {
      onFailure: cause => ({ _tag: 'failure' as const, cause }),
      onSuccess: () => ({ _tag: 'success' as const }),
    });
    if (result._tag === 'success') return;
    const cleanupErrors: unknown[] = [];
    if (!renamed) {
      const cleanup = yield* Effect.match(
        unlinkIfPresent(temporaryPath, failure),
        {
          onFailure: cause => ({ _tag: 'failure' as const, cause }),
          onSuccess: () => ({ _tag: 'success' as const }),
        },
      );
      if (cleanup._tag === 'failure') cleanupErrors.push(cleanup.cause.cause ?? cleanup.cause);
    }
    if (cleanupErrors.length > 0) {
      return yield* Effect.fail(new MynpmError(
        'operation',
        `inventory write failed and cleanup was incomplete at ${stateDirectory}`,
        { cause: new AggregateError([result.cause.cause ?? result.cause, ...cleanupErrors]) },
      ));
    }
    return yield* Effect.fail(new MynpmError('operation', `could not write inventory at ${inventoryPath}`, { cause: result.cause.cause ?? result.cause }));
  });
}

export function updateInventory(
  stateDirectory: string,
  update: (inventory: Inventory) => Inventory | Promise<Inventory>,
): Effect.Effect<Inventory, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    yield* filesystemOperation(
      () => mkdir(stateDirectory, { recursive: true }),
      cause => new MynpmError('operation', `could not prepare inventory directory: ${stateDirectory}`, { cause }),
    );
    yield* acquireFilesystemLock(stateDirectory, '.inventory.lock', 'inventory');
    const current = yield* loadInventory(stateDirectory);
    const updated = yield* Effect.tryPromise({
      try: () => Promise.resolve(update(current)),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('operation', 'inventory update failed', { cause }),
    });
    const currentText = yield* Effect.try({
      try: () => serializeInventory(current),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('corrupt', 'inventory is not serializable', { cause }),
    });
    const updatedText = yield* Effect.try({
      try: () => serializeInventory(updated),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('corrupt', 'inventory is not serializable', { cause }),
    });
    if (currentText !== updatedText) yield* writeInventory(stateDirectory, updated);
    return updated;
  }));
}

export function saveInventory(stateDirectory: string, inventory: Inventory): Effect.Effect<void, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    yield* filesystemOperation(
      () => mkdir(stateDirectory, { recursive: true }),
      cause => new MynpmError('operation', `could not prepare inventory directory: ${stateDirectory}`, { cause }),
    );
    yield* acquireFilesystemLock(stateDirectory, '.inventory.lock', 'inventory');
    yield* writeInventory(stateDirectory, inventory);
  }));
}
