import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { fileURLToPath } from 'node:url';
import { inspectPackageArchive } from '../src/archive.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = join(repositoryRoot, '.work', 'tmp');
const validArchive = fileURLToPath(new URL('./fixtures/tarballs/flatdemo-1.2.3.tgz', import.meta.url));

function tarMember(name, content = Buffer.alloc(0), type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const paddedContent = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(paddedContent);
  return Buffer.concat([header, paddedContent]);
}

function createTar(entries) {
  const content = Buffer.concat([...entries.map(entry => tarMember(entry.name, entry.content, entry.type)), Buffer.alloc(1024)]);
  return gzipSync(content);
}

function withScratch(run) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(scratchRoot, 'archive-'))),
    run,
    directory => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
}

it.effect('archive inspection accepts the expected package and reports bounded contents', () => Effect.gen(function*() {
  const inspected = yield* inspectPackageArchive(validArchive, { name: 'flatdemo', version: '1.2.3' });

  assert.equal(inspected.manifest.name, 'flatdemo');
  assert.equal(inspected.manifest.version, '1.2.3');
  assert.equal(inspected.entries.some(entry => entry.path === 'package/package.json'), true);
  assert.equal(inspected.compressedBytes, readFileSync(validArchive).length);
  assert.ok(inspected.unpackedBytes > 0);
}));

it.effect('archive inspection rejects a mismatched package identity', () => Effect.gen(function*() {
  const outcome = yield* Effect.result(inspectPackageArchive(validArchive, { name: 'other', version: '1.2.3' }));
  assert.equal(outcome._tag, 'Failure');
  if (outcome._tag === 'Failure') assert(outcome.failure.category === 'input' && /identity mismatch/.test(outcome.failure.message));
}));

it.effect('archive inspection rejects an archive path that is a symbolic link', () => withScratch(directory => Effect.gen(function*() {
  const link = join(directory, 'linked.tgz');
  symlinkSync(validArchive, link);

  const outcome = yield* Effect.result(inspectPackageArchive(link, { name: 'flatdemo', version: '1.2.3' }));
  assert.equal(outcome._tag, 'Failure');
  if (outcome._tag === 'Failure') assert(outcome.failure.category === 'input' && /regular file/.test(outcome.failure.message));
})));

it.effect('archive inspection rejects traversal and symbolic-link entries before promotion', () => withScratch(directory => Effect.gen(function*() {
  const manifest = Buffer.from('{"name":"flatdemo","version":"1.2.3"}');
  const traversal = join(directory, 'traversal.tgz');
  const symlink = join(directory, 'symlink.tgz');
  writeFileSync(traversal, createTar([
    { name: 'package/package.json', content: manifest },
    { name: 'package/../escape', content: Buffer.from('outside') },
  ]));
  writeFileSync(symlink, createTar([
    { name: 'package/package.json', content: manifest },
    { name: 'package/link', type: '2' },
  ]));

  const traversalOutcome = yield* Effect.result(inspectPackageArchive(traversal, { name: 'flatdemo', version: '1.2.3' }));
  assert.equal(traversalOutcome._tag, 'Failure');
  if (traversalOutcome._tag === 'Failure') assert(traversalOutcome.failure.category === 'input' && /unsafe path/.test(traversalOutcome.failure.message));
  const symlinkOutcome = yield* Effect.result(inspectPackageArchive(symlink, { name: 'flatdemo', version: '1.2.3' }));
  assert.equal(symlinkOutcome._tag, 'Failure');
  if (symlinkOutcome._tag === 'Failure') assert(symlinkOutcome.failure.category === 'input' && /unsupported entry type/.test(symlinkOutcome.failure.message));
})));
