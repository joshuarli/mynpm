import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, link, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmptyInventory, parseInventory, serializeInventory } from './inventory.mjs';
import { MynpmError } from './errors.mjs';

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause.code === 'ESRCH') return false;
    if (cause.code === 'EPERM') return true;
    throw cause;
  }
}

async function readLock(lockPath, resourceName) {
  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    if (cause.code === 'ELOOP') throw new MynpmError('corrupt', `${resourceName} lock is a symbolic link at ${lockPath}`);
    throw new MynpmError('operation', `could not inspect ${resourceName} lock at ${lockPath}`, { cause });
  }
  let text;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new MynpmError('corrupt', `${resourceName} lock is not a regular file at ${lockPath}`);
    text = await handle.readFile('utf8');
  } catch (cause) {
    if (cause instanceof MynpmError) throw cause;
    throw new MynpmError('operation', `could not inspect ${resourceName} lock at ${lockPath}`, { cause });
  } finally {
    await handle.close();
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('corrupt', `${resourceName} lock is not valid JSON at ${lockPath}`, { cause });
  }
  if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(owner.pid) || typeof owner.token !== 'string') {
    throw new MynpmError('corrupt', `${resourceName} lock has an invalid owner at ${lockPath}`);
  }
  return owner;
}

export async function acquireFilesystemLock(directory, lockName, resourceName) {
  const lockPath = join(directory, lockName);
  for (;;) {
    const token = randomUUID();
    const temporaryPath = join(directory, `.${lockName.replace(/^\./, '').replace(/\.lock$/, '')}-lock-${token}.tmp`);
    let handle;
    let linked = false;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporaryPath, lockPath);
      linked = true;
      await unlink(temporaryPath);
      await syncDirectory(directory);
      return async () => {
        const owner = await readLock(lockPath, resourceName);
        if (owner?.token !== token) throw new MynpmError('conflict', `${resourceName} lock ownership changed before release`);
        await unlink(lockPath);
        await syncDirectory(directory);
      };
    } catch (cause) {
      const cleanupErrors = [];
      if (handle) {
        try {
          await handle.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (!linked) {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (error.code !== 'ENOENT') cleanupErrors.push(error);
        }
      }
      if (linked) {
        for (const path of [lockPath, temporaryPath]) {
          try {
            await unlink(path);
          } catch (error) {
            if (error.code !== 'ENOENT') cleanupErrors.push(error);
          }
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError([cause, ...cleanupErrors], `${resourceName} lock cleanup failed at ${directory}`);
      if (cause.code !== 'EEXIST') {
        if (cause instanceof MynpmError) throw cause;
        throw new MynpmError('operation', `could not acquire ${resourceName} lock at ${lockPath}`, { cause });
      }
      const owner = await readLock(lockPath, resourceName);
      if (owner === null) continue;
      if (await processIsAlive(owner.pid)) throw new MynpmError('conflict', `another mynpm operation is updating ${resourceName}`);
      const before = await lstat(lockPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const current = await readLock(lockPath, resourceName);
      const after = await lstat(lockPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current?.token === owner.token && before && after && before.dev === after.dev && before.ino === after.ino && !(await processIsAlive(current.pid))) {
        await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
}

export async function loadInventory(stateDirectory) {
  const inventoryPath = join(stateDirectory, 'inventory.json');
  let handle;
  try {
    handle = await open(inventoryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (cause.code === 'ENOENT') return createEmptyInventory();
    if (cause.code === 'ELOOP') throw new MynpmError('corrupt', `inventory is a symbolic link: ${inventoryPath}`);
    throw new MynpmError('operation', `could not read inventory at ${inventoryPath}`, { cause });
  }
  let contents;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new MynpmError('corrupt', `inventory is not a regular file: ${inventoryPath}`);
    contents = await handle.readFile('utf8');
  } catch (cause) {
    if (cause instanceof MynpmError) throw cause;
    throw new MynpmError('operation', `could not read inventory at ${inventoryPath}`, { cause });
  } finally {
    await handle.close();
  }
  return parseInventory(contents);
}

async function writeInventory(stateDirectory, inventory) {
  const inventoryPath = join(stateDirectory, 'inventory.json');
  const existing = await lstat(inventoryPath).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new MynpmError('corrupt', `inventory is not a regular file: ${inventoryPath}`);
  const temporaryPath = join(stateDirectory, `.${basename(inventoryPath)}.${randomUUID()}.tmp`);
  const contents = serializeInventory(inventory);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, inventoryPath);
    renamed = true;
    await syncDirectory(stateDirectory);
  } catch (cause) {
    const cleanupErrors = [];
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!renamed) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (error.code !== 'ENOENT') cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([cause, ...cleanupErrors], `inventory write failed and cleanup was incomplete at ${stateDirectory}`);
    }
    throw new MynpmError('operation', `could not write inventory at ${inventoryPath}`, { cause });
  }
}

export async function updateInventory(stateDirectory, update) {
  await mkdir(stateDirectory, { recursive: true });
  const release = await acquireFilesystemLock(stateDirectory, '.inventory.lock', 'inventory');
  try {
    const current = await loadInventory(stateDirectory);
    const updated = await update(current);
    if (serializeInventory(current) !== serializeInventory(updated)) await writeInventory(stateDirectory, updated);
    return updated;
  } finally {
    await release();
  }
}

export async function saveInventory(stateDirectory, inventory) {
  await mkdir(stateDirectory, { recursive: true });
  const release = await acquireFilesystemLock(stateDirectory, '.inventory.lock', 'inventory');
  try {
    await writeInventory(stateDirectory, inventory);
  } finally {
    await release();
  }
}
