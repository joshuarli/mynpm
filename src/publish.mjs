import { constants } from 'node:fs';
import { open, mkdir, lstat, readlink, rename, link, unlink, rm, readdir, symlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { acquireFilesystemLock, loadInventory } from './inventory-store.mjs';
import { verifyInventorySnapshot } from './acquire.mjs';
import { canonicalJson, renderPackumentFiles, rendererVersion } from './packument.mjs';
import { validateArtifactRecord } from './inventory.mjs';
import { MynpmError } from './errors.mjs';

function fail(category, message, options) {
  throw new MynpmError(category, message, options);
}

function sortedArtifacts(records) {
  return records.map(validateArtifactRecord).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function generationPayload(publicBaseUrl, artifacts, packuments) {
  return {
    schemaVersion: 1,
    rendererVersion,
    publicBaseUrl,
    artifacts: artifacts.map(record => ({ name: record.name, version: record.version, sha512: record.artifact.sha512 })),
    packuments: packuments.map(file => ({ path: file.path, contents: file.bytes.toString('utf8') })),
  };
}

function generationId(publicBaseUrl, artifacts, packuments) {
  return createHash('sha256').update(canonicalJson(generationPayload(publicBaseUrl, artifacts, packuments))).digest('hex');
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(directory, category = 'operation', publicAccess = false) {
  let created = false;
  try {
    await mkdir(directory, { mode: 0o755 });
    created = true;
  } catch (cause) {
    if (cause.code !== 'EEXIST') throw new MynpmError(category, `could not create directory ${directory}`, { cause });
  }
  let info;
  try {
    info = await lstat(directory);
  } catch (cause) {
    throw new MynpmError(category, `could not inspect directory ${directory}`, { cause });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(category, `managed path is not a real directory: ${directory}`);
  if (created) {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (publicAccess) await handle.chmod(0o755);
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(directory));
  }
}

async function ensureDirectoryTree(targetDirectory, category = 'input') {
  const target = resolve(targetDirectory);
  const root = parse(target).root;
  if (target === root) fail(category, `publish site cannot be a filesystem root: ${target}`);
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    await ensureDirectory(current, category, true);
  }
  return target;
}

async function openRegularFile(path, category, missingAllowed = false) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (missingAllowed && cause.code === 'ENOENT') return null;
    if (cause.code === 'ELOOP') fail(category, `managed file is a symbolic link: ${path}`);
    throw new MynpmError(category, `could not open regular file ${path}`, { cause });
  }
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    fail(category, `managed path is not a regular file: ${path}`);
  }
  return handle;
}

async function readRegularFile(path, category, missingAllowed = false) {
  const handle = await openRegularFile(path, category, missingAllowed);
  if (handle === null) return null;
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function generationFiles(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = prefix === '' ? entry.name : join(prefix, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('corrupt', `generation contains an unsafe entry: ${path}`);
    if (entry.isDirectory()) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('corrupt', `generation contains an unsafe directory: ${path}`);
      found.push(...await generationFiles(path, relativePath));
    } else {
      found.push(relativePath.split(sep).join('/'));
    }
  }
  return found;
}

async function hashRegularFile(path, expectedDigest, category) {
  const handle = await openRegularFile(path, category);
  const digest = createHash('sha512');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
  } catch (cause) {
    throw new MynpmError(category, `could not read artifact ${path}`, { cause });
  } finally {
    await handle.close();
  }
  const actual = digest.digest('hex');
  if (actual !== expectedDigest) fail(category, `SHA-512 mismatch for published artifact ${basename(path)}`);
  return actual;
}

function parseManifest(text, path) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('corrupt', `generation manifest is not valid JSON: ${path}`, { cause });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('corrupt', `generation manifest must be an object: ${path}`);
  const keys = ['schemaVersion', 'rendererVersion', 'publicBaseUrl', 'generationId', 'artifacts'];
  if (Object.keys(manifest).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(manifest, key))) {
    fail('corrupt', `generation manifest has an unsupported shape: ${path}`);
  }
  if (manifest.schemaVersion !== 1 || manifest.rendererVersion !== rendererVersion || typeof manifest.publicBaseUrl !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.generationId) || !Array.isArray(manifest.artifacts)) {
    fail('corrupt', `generation manifest has invalid fields: ${path}`);
  }
  const artifacts = sortedArtifacts(manifest.artifacts);
  const identities = artifacts.map(record => `${record.name}\0${record.version}`);
  if (new Set(identities).size !== identities.length) fail('corrupt', `generation manifest has duplicate package identities: ${path}`);
  return { ...manifest, artifacts };
}

async function validateGeneration(generationsDirectory, id, mirrorRoot, dependencies = {}) {
  const generationDirectory = join(generationsDirectory, id);
  let info;
  try {
    info = await lstat(generationDirectory);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw new MynpmError('operation', `could not inspect generation ${id}`, { cause });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('corrupt', `generation is not a real directory: ${generationDirectory}`);
  const manifestPath = join(generationDirectory, 'manifest.json');
  const manifestBytes = await readRegularFile(manifestPath, 'corrupt');
  const manifest = parseManifest(manifestBytes.toString('utf8'), manifestPath);
  const files = renderPackumentFiles(manifest.artifacts, manifest.publicBaseUrl);
  const computedId = generationIdForManifest(manifest, files);
  if (computedId !== id || manifest.generationId !== id) fail('corrupt', `generation identity does not match its contents: ${id}`);
  const expectedFiles = [...files.map(file => file.path), 'manifest.json'].sort();
  const actualFiles = (await generationFiles(generationDirectory)).sort();
  if (canonicalJson(expectedFiles) !== canonicalJson(actualFiles)) fail('corrupt', `generation file set does not match its manifest: ${id}`);
  for (const file of files) {
    const actual = await readRegularFile(join(generationDirectory, file.path), 'corrupt');
    if (!actual.equals(file.bytes)) fail('corrupt', `generation packument does not match its manifest: ${file.path}`);
  }
  for (const record of manifest.artifacts) {
    await hashRegularFile(join(mirrorRoot, 'tarballs', `${record.artifact.sha512}.tgz`), record.artifact.sha512, 'corrupt');
  }
  return manifest;
}

function generationIdForManifest(manifest, files) {
  return generationId(manifest.publicBaseUrl, manifest.artifacts, files);
}

async function readCurrent(mirrorRoot, generationsDirectory, dependencies) {
  const currentPath = join(mirrorRoot, 'current');
  let info;
  try {
    info = await lstat(currentPath);
  } catch (cause) {
    if (cause.code === 'ENOENT') return { target: null, artifacts: [] };
    throw new MynpmError('operation', `could not inspect current publication at ${currentPath}`, { cause });
  }
  if (!info.isSymbolicLink()) fail('corrupt', `current publication is not a symbolic link: ${currentPath}`);
  const target = await readlink(currentPath);
  const match = /^generations\/([a-f0-9]{64})$/.exec(target);
  if (!match) fail('corrupt', `current publication has an unsafe generation target: ${target}`);
  const manifest = await validateGeneration(generationsDirectory, match[1], mirrorRoot, dependencies);
  if (manifest === null) fail('corrupt', `current publication points to a missing generation: ${match[1]}`);
  return { target, artifacts: manifest.artifacts };
}

function mergeArtifacts(retained, incoming) {
  const merged = new Map(retained.map(record => [`${record.name}\0${record.version}`, record]));
  for (const record of incoming) {
    const key = `${record.name}\0${record.version}`;
    const existing = merged.get(key);
    if (existing && existing.artifact.sha512 !== record.artifact.sha512) {
      fail('conflict', `published digest conflicts for ${record.name}@${record.version}`);
    }
    merged.set(key, record);
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

async function writeFully(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten === 0) throw new Error('file write made no progress');
    offset += bytesWritten;
  }
}

async function copyArtifact(record, stateDirectory, tarballsDirectory, dependencies) {
  const digest = record.artifact.sha512;
  const destination = join(tarballsDirectory, `${digest}.tgz`);
  const existing = await openRegularFile(destination, 'corrupt', true);
  if (existing !== null) {
    await existing.close();
    await hashRegularFile(destination, digest, 'corrupt');
    return;
  }
  const source = join(stateDirectory, 'objects', 'sha512', `${digest}.tgz`);
  const sourceHandle = await openRegularFile(source, 'corrupt');
  const temporaryPath = join(tarballsDirectory, `.mynpm-${randomUUID()}.tmp`);
  let destinationHandle;
  let temporaryExists = false;
  const hash = createHash('sha512');
  try {
    destinationHandle = await open(temporaryPath, 'wx', 0o644);
    temporaryExists = true;
    await destinationHandle.chmod(0o644);
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      await writeFully(destinationHandle, chunk);
    }
    if (hash.digest('hex') !== digest) fail('corrupt', `state artifact digest mismatch for ${record.name}@${record.version}`);
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = undefined;
    await sourceHandle.close();
    await link(temporaryPath, destination);
  } catch (cause) {
    if (cause.code !== 'EEXIST') {
      if (cause instanceof MynpmError) throw cause;
      throw new MynpmError('operation', `could not publish artifact ${record.name}@${record.version}`, { cause });
    }
    await hashRegularFile(destination, digest, 'corrupt');
  } finally {
    if (destinationHandle) await destinationHandle.close();
    if (!sourceHandle.closed) await sourceHandle.close();
    if (temporaryExists) await unlink(temporaryPath).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
  }
  await (dependencies.syncDirectory ?? syncDirectory)(tarballsDirectory);
}

async function writeDurableFile(path, bytes) {
  const handle = await open(path, 'wx', 0o644);
  try {
    await handle.chmod(0o644);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncGenerationTree(directory, sync = syncDirectory) {
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    if (child.isDirectory()) await syncGenerationTree(join(directory, child.name), sync);
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.chmod(0o755);
  } finally {
    await handle.close();
  }
  await sync(directory);
}

async function ensureGeneration(generationsDirectory, id, manifest, files, dependencies) {
  const finalDirectory = join(generationsDirectory, id);
  const existing = await validateGeneration(generationsDirectory, id, dependencies.mirrorRoot, dependencies);
  if (existing !== null) return;
  const temporaryDirectory = join(generationsDirectory, `.mynpm-generation-${id}-${randomUUID()}`);
  await mkdir(temporaryDirectory, { mode: 0o755 });
  let renamed = false;
  try {
    for (const file of files) {
      const path = join(temporaryDirectory, file.path);
      const parent = dirname(path);
      if (parent !== temporaryDirectory) await mkdir(parent, { recursive: true, mode: 0o755 });
      await writeDurableFile(path, file.bytes);
    }
    await writeDurableFile(join(temporaryDirectory, 'manifest.json'), Buffer.from(canonicalJson(manifest), 'utf8'));
    await syncGenerationTree(temporaryDirectory, dependencies.syncDirectory ?? syncDirectory);
    try {
      await (dependencies.rename ?? rename)(temporaryDirectory, finalDirectory);
      renamed = true;
    } catch (cause) {
      if (cause.code !== 'EEXIST' && cause.code !== 'ENOTEMPTY') throw cause;
      const concurrent = await validateGeneration(dependencies.generationsDirectory, id, dependencies.mirrorRoot, dependencies);
      if (concurrent === null) throw cause;
    }
    await (dependencies.syncDirectory ?? syncDirectory)(generationsDirectory);
  } catch (cause) {
    if (cause instanceof MynpmError) throw cause;
    throw new MynpmError('operation', `could not finalize generation ${id}`, { cause });
  } finally {
    if (!renamed) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function switchCurrent(mirrorRoot, nextTarget, oldTarget, dependencies) {
  const currentPath = join(mirrorRoot, 'current');
  const temporaryPath = join(mirrorRoot, `.current-${randomUUID()}`);
  await (dependencies.symlink ?? symlink)(nextTarget, temporaryPath);
  try {
    await (dependencies.rename ?? rename)(temporaryPath, currentPath);
  } catch (cause) {
    await unlink(temporaryPath).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
    throw new MynpmError('operation', 'could not atomically switch the current publication', { cause });
  }
  try {
    await (dependencies.syncDirectory ?? syncDirectory)(mirrorRoot);
  } catch (cause) {
    try {
      if (oldTarget === null) await unlink(currentPath);
      else {
        const rollbackPath = join(mirrorRoot, `.current-rollback-${randomUUID()}`);
        await (dependencies.symlink ?? symlink)(oldTarget, rollbackPath);
        await (dependencies.rename ?? rename)(rollbackPath, currentPath);
      }
      await (dependencies.syncDirectory ?? syncDirectory)(mirrorRoot);
    } catch (rollbackCause) {
      throw new AggregateError([cause, rollbackCause], 'current publication changed but durability failed and rollback was incomplete');
    }
    throw new MynpmError('operation', 'could not durably switch the current publication', { cause });
  }
}

export async function publishSite({ stateDirectory, siteDirectory, config }, dependencies = {}) {
  const siteRoot = await ensureDirectoryTree(siteDirectory);
  const mirrorRoot = join(siteRoot, 'mirror');
  await ensureDirectory(mirrorRoot, 'operation', true);
  const generationsDirectory = join(mirrorRoot, 'generations');
  const tarballsDirectory = join(mirrorRoot, 'tarballs');
  await ensureDirectory(generationsDirectory, 'operation', true);
  await ensureDirectory(tarballsDirectory, 'operation', true);
  const release = await acquireFilesystemLock(mirrorRoot, '.publish.lock', 'publication');
  try {
    await dependencies.beforeInventoryRead?.();
    const inventory = await loadInventory(stateDirectory);
    await dependencies.afterInventoryRead?.(inventory);
    await verifyInventorySnapshot({ stateDirectory, config, inventory });
    const current = await readCurrent(mirrorRoot, generationsDirectory, dependencies);
    const artifacts = mergeArtifacts(current.artifacts, inventory.artifacts);
    const publicBaseUrl = dependencies.renderBaseUrl ?? config.publicBaseUrl;
    const files = renderPackumentFiles(artifacts, publicBaseUrl);
    const id = generationId(publicBaseUrl, artifacts, files);
    const manifest = {
      schemaVersion: 1,
      rendererVersion,
      publicBaseUrl,
      generationId: id,
      artifacts,
    };
    const canonicalManifest = parseManifest(canonicalJson(manifest), 'candidate manifest');
    for (const record of artifacts) await copyArtifact(record, stateDirectory, tarballsDirectory, { ...dependencies, mirrorRoot });
    await ensureGeneration(generationsDirectory, id, canonicalManifest, files, { ...dependencies, mirrorRoot, generationsDirectory });
    const target = `generations/${id}`;
    if (current.target === target) return { generationId: id, packageCount: files.length, versionCount: artifacts.length, noOp: true };
    await switchCurrent(mirrorRoot, target, current.target, dependencies);
    return { generationId: id, packageCount: files.length, versionCount: artifacts.length, noOp: false };
  } finally {
    await release();
  }
}
