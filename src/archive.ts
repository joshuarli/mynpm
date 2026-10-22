import { lstat } from 'node:fs/promises';
import { Effect } from 'effect';
import { MynpmError } from './errors.ts';
import { formatBytes, limits } from './limits.ts';
import { runProcess } from './process.ts';

const lineLimit = 4096;
const tarExecutable = '/usr/bin/tar';
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PackageIdentity {
  name: string;
  version: string;
}

export interface ArchiveEntry {
  type: '-' | 'd';
  size: number;
  path: string;
}

export interface InspectedPackageArchive {
  manifest: Record<string, unknown>;
  entries: ArchiveEntry[];
  compressedBytes: number;
  unpackedBytes: number;
}

interface RawArchiveEntry {
  type: string;
  size: number;
  path: string;
}

interface ArchiveInspection {
  entries: ArchiveEntry[];
  unpackedBytes: number;
}

function invalid(message: string, options?: ErrorOptions): never {
  throw new MynpmError('input', message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseListingLine(line: string): RawArchiveEntry {
  const date = /\s(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?|[A-Za-z]{3}\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}))\s/.exec(line);
  if (!date) invalid('package archive has an unsupported tar listing format');
  const fields = line.slice(0, date.index).trim().split(/\s+/);
  const permissions = fields[0];
  if (fields.length < 2 || permissions === undefined || permissions.length < 10) {
    invalid('package archive has a malformed tar entry');
  }
  const type = permissions[0] ?? '';
  const size = Number(fields.at(-1));
  if (!Number.isSafeInteger(size) || size < 0) invalid('package archive contains an invalid entry size');
  const reportedPath = line.slice(date.index + date[0].length);
  const path = type === 'l' ? reportedPath.replace(/ -> .*$/, '') : reportedPath;
  const hasControlCharacter = Array.from(path, character => character.charCodeAt(0)).some(code => code <= 0x1f || code === 0x7f);
  if (path.length === 0 || path !== path.trim() || path.includes('\\') || path.includes('"') || path.includes("'") || hasControlCharacter) {
    invalid('package archive contains an unsupported entry path');
  }
  return { type, size, path };
}

function validateEntry(entry: RawArchiveEntry, seen: Set<string>): ArchiveEntry {
  const path = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
  if (path !== 'package' && !path.startsWith('package/')) {
    invalid(`package archive entry is outside package/: ${path}`);
  }
  if (path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    invalid(`package archive entry has an unsafe path: ${path}`);
  }
  if (entry.type !== '-' && entry.type !== 'd') {
    invalid(`package archive contains an unsupported entry type at ${path}`);
  }
  if (seen.has(path)) invalid(`package archive contains duplicate entry ${path}`);
  if (path === 'package' && entry.type !== 'd') invalid('package archive root must be a directory');
  seen.add(path);
  return { type: entry.type, size: entry.size, path };
}

function archiveProcessError(cause: MynpmError, message: string): MynpmError {
  return cause.category === 'input' ? cause : new MynpmError('input', message, { cause });
}

function parseManifest(text: string, expectedIdentity: PackageIdentity): Record<string, unknown> {
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(text);
  } catch (cause) {
    invalid('package archive package/package.json is not valid JSON', { cause });
  }
  if (!isRecord(parsedManifest)) invalid('package archive package.json must contain an object');
  const name = parsedManifest.name;
  const version = parsedManifest.version;
  if (name !== expectedIdentity.name || version !== expectedIdentity.version) {
    invalid(`package archive identity mismatch: expected ${expectedIdentity.name}@${expectedIdentity.version}, found ${String(name)}@${String(version)}`);
  }
  if (typeof name !== 'string' || typeof version !== 'string') {
    invalid('package archive package.json has an invalid identity');
  }
  if (!packageNamePattern.test(name) || !versionPattern.test(version)) invalid('package archive package.json has an invalid identity');
  return parsedManifest;
}

function inspectEntries(archivePath: string): Effect.Effect<ArchiveInspection, MynpmError> {
  return Effect.gen(function*() {
    const entries: ArchiveEntry[] = [];
    const seen = new Set<string>();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = Buffer.alloc(0);
    let unpackedBytes = 0;
    const consumeLine = (bytes: Buffer): void => {
      let line: string;
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
        if (unpackedBytes > limits.unpackedBytes) {
          invalid(`package archive exceeds the ${formatBytes(limits.unpackedBytes)} unpacked size limit`);
        }
      }
      entries.push(entry);
      if (entries.length > limits.archiveEntries) {
        invalid(`package archive exceeds the ${limits.archiveEntries.toLocaleString('en-US')} entry limit`);
      }
    };
    yield* Effect.mapError(
      runProcess(tarExecutable, ['-tvzf', archivePath], {
        cwd: process.cwd(),
        env: { LC_ALL: 'C', TAR_OPTIONS: '' },
        timeoutMs: limits.requestMilliseconds,
        onStdout(chunk) {
          pending = Buffer.concat([pending, chunk]);
          let newline: number;
          while ((newline = pending.indexOf(10)) >= 0) {
            consumeLine(pending.subarray(0, newline));
            pending = pending.subarray(newline + 1);
          }
          if (pending.length > lineLimit) invalid('package archive entry path exceeds the supported path limit');
        },
      }),
      cause => archiveProcessError(cause, 'package archive could not be inspected by tar'),
    );
    if (pending.length > 0) consumeLine(pending);
    if (entries.length === 0) yield* Effect.fail(new MynpmError('input', 'package archive is empty'));
    const manifestEntries = entries.filter(entry => entry.path === 'package/package.json' && entry.type === '-');
    if (manifestEntries.length !== 1) {
      yield* Effect.fail(new MynpmError('input', 'package archive must contain exactly one package/package.json file'));
    }
    return { entries, unpackedBytes };
  });
}

export function inspectPackageArchive(
  archivePath: string,
  expectedIdentity: PackageIdentity,
): Effect.Effect<InspectedPackageArchive, MynpmError> {
  return Effect.gen(function*() {
    const info = yield* Effect.tryPromise({
      try: () => lstat(archivePath),
      catch: cause => new MynpmError('input', `could not inspect package archive ${archivePath}`, { cause }),
    });
    if (!info.isFile() || info.isSymbolicLink()) {
      yield* Effect.fail(new MynpmError('input', 'package archive is not a regular file'));
    }
    if (info.size > limits.tarballBytes) {
      yield* Effect.fail(new MynpmError('input', `package archive exceeds the ${formatBytes(limits.tarballBytes)} compressed size limit`));
    }
    const inspected = yield* inspectEntries(archivePath);
    const extracted: Buffer[] = [];
    let manifestSize = 0;
    yield* Effect.mapError(
      runProcess(tarExecutable, ['-xOzf', archivePath, 'package/package.json'], {
        cwd: process.cwd(),
        env: { LC_ALL: 'C', TAR_OPTIONS: '' },
        timeoutMs: limits.requestMilliseconds,
        onStdout(chunk) {
          manifestSize += chunk.length;
          if (manifestSize > limits.metadataBytes) {
            invalid(`package/package.json exceeds the ${formatBytes(limits.metadataBytes)} metadata limit`);
          }
          extracted.push(Buffer.from(chunk));
        },
      }),
      cause => archiveProcessError(cause, 'package archive manifest could not be read'),
    );
    const manifest = yield* Effect.tryPromise({
      try: () => Promise.resolve(parseManifest(Buffer.concat(extracted).toString('utf8'), expectedIdentity)),
      catch: cause => cause instanceof MynpmError
        ? cause
        : new MynpmError('input', 'package archive package/package.json is not valid JSON', { cause }),
    });
    return {
      manifest,
      entries: inspected.entries,
      compressedBytes: info.size,
      unpackedBytes: inspected.unpackedBytes,
    };
  });
}
