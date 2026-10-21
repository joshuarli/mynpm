import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectPackageArchive } from '../src/archive.mjs';

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

async function withScratch(run) {
  const directory = mkdtempSync(join(scratchRoot, 'archive-'));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('archive inspection accepts the expected package and reports bounded contents', async () => {
  const inspected = await inspectPackageArchive(validArchive, { name: 'flatdemo', version: '1.2.3' });

  assert.equal(inspected.manifest.name, 'flatdemo');
  assert.equal(inspected.manifest.version, '1.2.3');
  assert.equal(inspected.entries.some(entry => entry.path === 'package/package.json'), true);
  assert.equal(inspected.compressedBytes, readFileSync(validArchive).length);
  assert.ok(inspected.unpackedBytes > 0);
});

test('archive inspection rejects a mismatched package identity', async () => {
  await assert.rejects(
    inspectPackageArchive(validArchive, { name: 'other', version: '1.2.3' }),
    error => error.category === 'input' && /identity mismatch/.test(error.message),
  );
});

test('archive inspection rejects an archive path that is a symbolic link', async () => withScratch(async directory => {
  const link = join(directory, 'linked.tgz');
  symlinkSync(validArchive, link);

  await assert.rejects(
    inspectPackageArchive(link, { name: 'flatdemo', version: '1.2.3' }),
    error => error.category === 'input' && /regular file/.test(error.message),
  );
}));

test('archive inspection rejects traversal and symbolic-link entries before promotion', async () => withScratch(async directory => {
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

  await assert.rejects(
    inspectPackageArchive(traversal, { name: 'flatdemo', version: '1.2.3' }),
    error => error.category === 'input' && /unsafe path/.test(error.message),
  );
  await assert.rejects(
    inspectPackageArchive(symlink, { name: 'flatdemo', version: '1.2.3' }),
    error => error.category === 'input' && /unsupported entry type/.test(error.message),
  );
}));
