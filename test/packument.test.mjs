import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { renderPackumentFiles } from '../src/packument.ts';

function artifactRecord(name, version, bytes, packument, metadataOverrides = {}) {
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  const shasum = createHash('sha1').update(bytes).digest('hex');
  const packagePath = name.startsWith('@') ? `${name.slice(0, name.indexOf('/'))}%2f${name.slice(name.indexOf('/') + 1)}` : name;
  const sourceUrl = `https://registry.npmjs.org/${packagePath}/-/${name.split('/').at(-1)}-${version}.tgz`;
  const metadata = {
    name,
    version,
    dependencies: { runtime: '^1.0.0' },
    optionalDependencies: { optional: '^2.0.0' },
    peerDependencies: { peer: '^3.0.0' },
    peerDependenciesMeta: { peer: { optional: true } },
    engines: { node: '>=22' },
    os: ['darwin', 'linux'],
    cpu: ['arm64', 'x64'],
    libc: ['glibc'],
    bin: { tool: 'bin/tool.js' },
    deprecated: 'use the next release',
    bundleDependencies: ['bundled'],
    _hasShrinkwrap: true,
    dist: {
      tarball: sourceUrl,
      integrity: `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`,
      shasum,
      unpackedSize: bytes.length,
      fileCount: 2,
      signatures: [{ keyid: 'old-signing-key', sig: 'invalid-after-url-change' }],
      attestations: { url: 'https://registry.npmjs.org/attestations' },
    },
    ...metadataOverrides,
  };
  return {
    name,
    version,
    packument,
    metadata,
    artifact: {
      sha512,
      integrity: `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`,
      shasum,
      sourceUrl,
      legacySha1Only: false,
    },
  };
}

test('packument preserves resolver metadata and emits only mirrored tags with stable absolute tarball URLs', () => {
  const name = '@scope/demo';
  const olderPackument = {
    name,
    _id: name,
    modified: '2026-01-01T00:00:00.000Z',
    'dist-tags': { latest: '1.2.3', beta: '1.2.3', future: '9.0.0' },
    time: { created: '2025-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', '1.2.3': '2025-12-01T00:00:00.000Z' },
    maintainers: [{ name: 'owner' }],
  };
  const currentPackument = {
    ...olderPackument,
    modified: '2026-02-01T00:00:00.000Z',
    'dist-tags': { latest: '1.2.4', future: '9.0.0' },
    time: { ...olderPackument.time, modified: '2026-02-01T00:00:00.000Z', '1.2.4': '2026-02-01T00:00:00.000Z' },
  };
  const records = [
    artifactRecord(name, '1.2.3', Buffer.from('old tarball'), olderPackument),
    artifactRecord(name, '1.2.4', Buffer.from('new tarball'), currentPackument),
  ];
  const files = renderPackumentFiles(records, 'https://deps.example.net/team/repo/');
  assert.equal(files.length, 1);
  assert.equal(files[0].path, '@scope/demo');
  assert.equal(decodeURIComponent(files[0].route), name);
  assert.equal(decodeURIComponent(files[0].route.replace('%2f', '%2F')), name);
  const rendered = JSON.parse(files[0].bytes.toString('utf8'));
  assert.deepEqual(rendered['dist-tags'], { latest: '1.2.4' });
  assert.deepEqual(Object.keys(rendered.versions), ['1.2.3', '1.2.4']);
  assert.deepEqual(rendered.versions['1.2.4'].dependencies, { runtime: '^1.0.0' });
  assert.deepEqual(rendered.versions['1.2.4'].optionalDependencies, { optional: '^2.0.0' });
  assert.deepEqual(rendered.versions['1.2.4'].peerDependencies, { peer: '^3.0.0' });
  assert.deepEqual(rendered.versions['1.2.4'].peerDependenciesMeta, { peer: { optional: true } });
  assert.deepEqual(rendered.versions['1.2.4'].engines, { node: '>=22' });
  assert.deepEqual(rendered.versions['1.2.4'].os, ['darwin', 'linux']);
  assert.deepEqual(rendered.versions['1.2.4'].cpu, ['arm64', 'x64']);
  assert.deepEqual(rendered.versions['1.2.4'].libc, ['glibc']);
  assert.deepEqual(rendered.versions['1.2.4'].bin, { tool: 'bin/tool.js' });
  assert.equal(rendered.versions['1.2.4'].deprecated, 'use the next release');
  assert.deepEqual(rendered.versions['1.2.4'].bundleDependencies, ['bundled']);
  assert.equal(rendered.versions['1.2.4']._hasShrinkwrap, true);
  assert.equal(rendered.versions['1.2.4'].dist.tarball, `https://deps.example.net/team/repo/current/-/tarballs/${records[1].artifact.sha512}.tgz`);
  assert.equal(rendered.versions['1.2.4'].dist.integrity, records[1].artifact.integrity);
  assert.equal(rendered.versions['1.2.4'].dist.shasum, records[1].artifact.shasum);
  assert.equal(Object.hasOwn(rendered.versions['1.2.4'].dist, 'signatures'), false);
  assert.equal(Object.hasOwn(rendered.versions['1.2.4'].dist, 'attestations'), false);
  assert.deepEqual(rendered.time, {
    '1.2.3': '2025-12-01T00:00:00.000Z',
    '1.2.4': '2026-02-01T00:00:00.000Z',
    created: '2025-01-01T00:00:00.000Z',
    modified: '2026-02-01T00:00:00.000Z',
  });
  assert.deepEqual(renderPackumentFiles([...records].reverse(), 'https://deps.example.net/team/repo/')[0].bytes, files[0].bytes);
});

test('renderer version 1 retains its original tarball URL layout', () => {
  const record = artifactRecord('flatdemo', '1.2.3', Buffer.from('tarball'), { name: 'flatdemo', 'dist-tags': {}, time: {} });
  const files = renderPackumentFiles([record], 'https://deps.example.net/team/repo/', { renderer: 1 });
  const packument = JSON.parse(files[0].bytes.toString('utf8'));
  assert.equal(packument.versions['1.2.3'].dist.tarball, `https://deps.example.net/team/repo/tarballs/${record.artifact.sha512}.tgz`);
});

test('renderer version 2 retains its current tarball URL layout', () => {
  const record = artifactRecord('flatdemo', '1.2.3', Buffer.from('tarball'), { name: 'flatdemo', 'dist-tags': {}, time: {} });
  const files = renderPackumentFiles([record], 'https://deps.example.net/team/repo/', { renderer: 2 });
  const packument = JSON.parse(files[0].bytes.toString('utf8'));
  assert.equal(packument.versions['1.2.3'].dist.tarball, `https://deps.example.net/team/repo/current/tarballs/${record.artifact.sha512}.tgz`);
});

test('packument rendering rejects unsafe package names and invalid public bases', () => {
  const record = artifactRecord('../escape', '1.0.0', Buffer.from('bytes'), { name: '../escape', 'dist-tags': {}, time: {} });
  assert.throws(() => renderPackumentFiles([record], 'https://deps.example.net/mirror/'), /invalid package identity/);
  assert.throws(() => renderPackumentFiles([], 'http://example.net/mirror/'), /HTTPS URL/);
});
