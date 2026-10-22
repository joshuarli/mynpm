import { lstat } from 'node:fs/promises';
import { MynpmError } from './errors.mjs';
import { formatBytes, limits } from './limits.mjs';
import { runProcess } from './process.mjs';

const lineLimit = 4096;
const tarExecutable = '/usr/bin/tar';
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function invalid(message, options) {
  throw new MynpmError('input', message, options);
}

function parseListingLine(line) {
  const date = /\s(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?|[A-Za-z]{3}\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}))\s/.exec(line);
  if (!date) invalid('package archive has an unsupported tar listing format');
  const fields = line.slice(0, date.index).trim().split(/\s+/);
  if (fields.length < 2 || fields[0].length < 10) invalid('package archive has a malformed tar entry');
  const type = fields[0][0];
  const size = Number(fields.at(-1));
  if (!Number.isSafeInteger(size) || size < 0) invalid('package archive contains an invalid entry size');
  const reportedPath = line.slice(date.index + date[0].length);
  const path = type === 'l' ? reportedPath.replace(/ -> .*$/, '') : reportedPath;
  if (path.length === 0 || path !== path.trim() || /[\\"'\u0000-\u001f\u007f]/.test(path)) {
    invalid('package archive contains an unsupported entry path');
  }
  return { type, size, path };
}

function validateEntry(entry, seen) {
  const path = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
  if (path !== 'package' && !path.startsWith('package/')) invalid(`package archive entry is outside package/: ${path}`);
  if (path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    invalid(`package archive entry has an unsafe path: ${path}`);
  }
  if (!['-', 'd'].includes(entry.type)) invalid(`package archive contains an unsupported entry type at ${path}`);
  if (seen.has(path)) invalid(`package archive contains duplicate entry ${path}`);
  if (path === 'package' && entry.type !== 'd') invalid('package archive root must be a directory');
  seen.add(path);
  return { ...entry, path };
}

async function inspectEntries(archivePath, { signal }) {
  const entries = [];
  const seen = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = Buffer.alloc(0);
  let unpackedBytes = 0;
  const consumeLine = bytes => {
    let line;
    try {
      line = decoder.decode(bytes);
    } catch (cause) {
      invalid('package archive contains a non-UTF-8 path', { cause });
    }
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) return;
    const entry = validateEntry(parseListingLine(line), seen);
    if (entry.type === '-') {
      unpackedBytes += entry.size;
      if (unpackedBytes > limits.unpackedBytes) invalid(`package archive exceeds the ${formatBytes(limits.unpackedBytes)} unpacked size limit`);
    }
    entries.push(entry);
    if (entries.length > limits.archiveEntries) invalid(`package archive exceeds the ${limits.archiveEntries.toLocaleString('en-US')} entry limit`);
  };
  await runProcess(tarExecutable, ['-tvzf', archivePath], {
    cwd: process.cwd(),
    env: { LC_ALL: 'C', TAR_OPTIONS: '' },
    signal,
    timeoutMs: limits.requestMilliseconds,
    onStdout(chunk) {
      pending = Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        consumeLine(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > lineLimit) invalid('package archive entry path exceeds the supported path limit');
    },
  }).catch(cause => {
    if (cause instanceof MynpmError && cause.category === 'input') throw cause;
    throw new MynpmError('input', 'package archive could not be inspected by tar', { cause });
  });
  if (pending.length > 0) consumeLine(pending);
  if (entries.length === 0) invalid('package archive is empty');
  const manifestEntries = entries.filter(entry => entry.path === 'package/package.json' && entry.type === '-');
  if (manifestEntries.length !== 1) invalid('package archive must contain exactly one package/package.json file');
  return { entries, unpackedBytes };
}

export async function inspectPackageArchive(archivePath, expectedIdentity, { signal } = {}) {
  const info = await lstat(archivePath);
  if (!info.isFile() || info.isSymbolicLink()) invalid('package archive is not a regular file');
  if (info.size > limits.tarballBytes) invalid(`package archive exceeds the ${formatBytes(limits.tarballBytes)} compressed size limit`);
  const inspected = await inspectEntries(archivePath, { signal });
  const extracted = [];
  let manifestSize = 0;
  await runProcess(tarExecutable, ['-xOzf', archivePath, 'package/package.json'], {
    cwd: process.cwd(),
    env: { LC_ALL: 'C', TAR_OPTIONS: '' },
    signal,
    timeoutMs: limits.requestMilliseconds,
    onStdout(chunk) {
      manifestSize += chunk.length;
      if (manifestSize > limits.metadataBytes) {
        invalid(`package/package.json exceeds the ${formatBytes(limits.metadataBytes)} metadata limit`);
      }
      extracted.push(Buffer.from(chunk));
    },
  }).catch(cause => {
    if (cause instanceof MynpmError && cause.category === 'input') throw cause;
    throw new MynpmError('input', 'package archive manifest could not be read', { cause });
  });
  let manifest;
  try {
    manifest = JSON.parse(Buffer.concat(extracted).toString('utf8'));
  } catch (cause) {
    invalid('package archive package/package.json is not valid JSON', { cause });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) invalid('package archive package.json must contain an object');
  if (manifest.name !== expectedIdentity.name || manifest.version !== expectedIdentity.version) {
    invalid(`package archive identity mismatch: expected ${expectedIdentity.name}@${expectedIdentity.version}, found ${String(manifest.name)}@${String(manifest.version)}`);
  }
  if (!packageNamePattern.test(manifest.name) || !versionPattern.test(manifest.version)) invalid('package archive package.json has an invalid identity');
  return { manifest, entries: inspected.entries, compressedBytes: info.size, unpackedBytes: inspected.unpackedBytes };
}

