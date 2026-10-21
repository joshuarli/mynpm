import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseNpmLock } from '../src/lock-npm.mjs';
import { createEmptyInventory, mergeProject, parseInventory, recordVerifiedArtifact, serializeInventory } from '../src/inventory.mjs';

const lock = JSON.parse(readFileSync(new URL('./fixtures/locks/package-lock-v3.json', import.meta.url), 'utf8'));

function project(sourceLock = lock) {
  return parseNpmLock(sourceLock, {
    projectId: 'web',
    lockfilePath: 'web/package-lock.json',
    targetIds: ['linux-x64-gnu'],
  });
}

test('inventory is versioned and round-trips in stable JSON form', () => {
  const inventory = mergeProject(createEmptyInventory(), project());
  const serialized = serializeInventory(inventory);

  assert.equal(serialized.endsWith('\n'), true);
  assert.deepEqual(parseInventory(serialized), inventory);
  assert.equal(inventory.schemaVersion, 1);
});

test('inventory imports are idempotent and conflicting digests fail', () => {
  const inventory = mergeProject(createEmptyInventory(), project());
  assert.deepEqual(mergeProject(inventory, project()), inventory);

  const conflict = structuredClone(lock);
  conflict.packages['node_modules/catalog-alias'].integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
  assert.throws(
    () => mergeProject(inventory, project(conflict)),
    error => error.category === 'conflict',
  );
});

test('inventory rejects unknown schema versions and malformed fields', () => {
  assert.throws(() => parseInventory('{"schemaVersion":2,"projects":[]}'), error => error.category === 'corrupt');
  assert.throws(() => parseInventory('{"schemaVersion":1,"projects":[],"extra":true}'), error => error.category === 'corrupt');
  assert.throws(() => parseInventory('{'), error => error.category === 'corrupt');
  const invalidImporter = structuredClone(mergeProject(createEmptyInventory(), project()));
  invalidImporter.projects[0].roots[0].importer = '../outside';
  assert.throws(() => parseInventory(JSON.stringify(invalidImporter)), error => error.category === 'corrupt');
});

test('inventory records matching verified metadata and rejects divergent artifact identities', () => {
  const inventory = mergeProject(createEmptyInventory(), project());
  const metadata = {
    name: 'real-package',
    version: '1.2.3',
    dependencies: { nested: '^1.0.0' },
    dist: {
      tarball: 'https://registry.npmjs.org/real-package/-/real-package-1.2.3.tgz',
      integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      shasum: 'a'.repeat(40),
    },
  };
  const packument = { name: 'real-package', 'dist-tags': { latest: '1.2.3' } };
  const sha512 = Buffer.alloc(64).toString('hex');
  const artifact = {
    sha512,
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    shasum: 'a'.repeat(40),
    sourceUrl: metadata.dist.tarball,
    legacySha1Only: false,
  };

  const recorded = recordVerifiedArtifact(inventory, { name: 'real-package', version: '1.2.3', packument, metadata, artifact });
  const packageRecords = recorded.projects.flatMap(item => item.packages).filter(item => item.name === 'real-package' && item.version === '1.2.3');
  assert.equal(packageRecords.length, 1);
  assert.equal(Object.hasOwn(packageRecords[0], 'artifact'), false);
  assert.deepEqual(recorded.artifacts[0], { name: 'real-package', version: '1.2.3', packument, metadata, artifact });
  assert.deepEqual(parseInventory(serializeInventory(recorded)), recorded);
  const secondProject = structuredClone(project());
  secondProject.id = 'another';
  secondProject.lockfilePath = 'another/package-lock.json';
  const merged = mergeProject(recorded, secondProject);
  const retained = merged.projects.find(item => item.id === 'another').packages.find(item => item.name === 'real-package');
  assert.equal(Object.hasOwn(retained, 'artifact'), false);
  assert.deepEqual(merged.artifacts[0].artifact, artifact);
  assert.throws(
    () => recordVerifiedArtifact(recorded, { name: 'real-package', version: '1.2.3', packument, metadata, artifact: {
      ...artifact,
      sha512: Buffer.alloc(64, 1).toString('hex'),
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    } }),
    error => error.category === 'conflict',
  );
});
