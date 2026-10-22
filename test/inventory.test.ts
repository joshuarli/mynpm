import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { parseNpmLock } from '../src/lock-npm.ts';
import { createEmptyInventory, mergeProject, parseInventory, recordVerifiedArtifact, serializeInventory } from '../src/inventory.ts';
import { hasErrorCategory } from './support.ts';

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
  assert.equal(inventory.schemaVersion, 2);
});

test('inventory imports are idempotent and conflicting digests fail', () => {
  const inventory = mergeProject(createEmptyInventory(), project());
  assert.deepEqual(mergeProject(inventory, project()), inventory);

  const conflict = structuredClone(lock);
  conflict.packages['node_modules/catalog-alias'].integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
  assert.throws(
    () => mergeProject(inventory, project(conflict)),
    hasErrorCategory('conflict'),
  );
});

test('inventory rejects unknown schema versions and malformed fields', () => {
  assert.throws(() => parseInventory('{"schemaVersion":1,"projects":[],"artifacts":[]}'), hasErrorCategory('corrupt'));
  assert.throws(() => parseInventory('{"schemaVersion":2,"projects":[],"artifacts":[],"extra":true}'), hasErrorCategory('corrupt'));
  assert.throws(() => parseInventory('{'), hasErrorCategory('corrupt'));
  const invalidImporter = structuredClone(mergeProject(createEmptyInventory(), project()));
  invalidImporter.projects[0].roots[0].importer = '../outside';
  assert.throws(() => parseInventory(JSON.stringify(invalidImporter)), hasErrorCategory('corrupt'));
});

test('inventory retains immutable project snapshots and rejects unsafe snapshot paths', () => {
  const imported = project();
  const snapshot = {
    manifest: '{"name":"web"}\n',
    lockfile: `${JSON.stringify(lock)}\n`,
    workspaceFiles: [{ path: 'packages/web/package.json', contents: '{"name":"web"}\n' }],
    npmInstallOptions: { legacyPeerDeps: true, installLinks: false },
  };
  const inventory = mergeProject(createEmptyInventory(), { ...imported, snapshot });
  assert.deepEqual(inventory.projects[0].snapshot, snapshot);

  const unsafe = structuredClone(inventory);
  const unsafeSnapshot = unsafe.projects[0]?.snapshot;
  assert.ok(unsafeSnapshot);
  unsafeSnapshot.workspaceFiles[0].path = '../package.json';
  assert.throws(() => parseInventory(JSON.stringify(unsafe)), hasErrorCategory('corrupt'));

  const unknownImporter = structuredClone(inventory);
  unknownImporter.projects[0].importers = [];
  assert.throws(() => parseInventory(JSON.stringify(unknownImporter)), hasErrorCategory('corrupt'));

  const unexpectedFile = structuredClone(inventory);
  const unexpectedFileSnapshot = unexpectedFile.projects[0]?.snapshot;
  assert.ok(unexpectedFileSnapshot);
  unexpectedFileSnapshot.workspaceFiles.push({ path: '.npmrc', contents: 'registry=https://example.invalid/' });
  assert.throws(() => parseInventory(JSON.stringify(unexpectedFile)), hasErrorCategory('corrupt'));
});

test('inventory defaults old project snapshots and validates saved npm install options', () => {
  const imported = structuredClone(mergeProject(createEmptyInventory(), {
    ...project(),
    snapshot: {
      manifest: '{"name":"web"}\n',
      lockfile: `${JSON.stringify(lock)}\n`,
      workspaceFiles: [],
      npmInstallOptions: { legacyPeerDeps: null, installLinks: null },
    },
  }));
  const importedSnapshot = imported.projects[0]?.snapshot;
  assert.ok(importedSnapshot);
  delete (importedSnapshot as unknown as { npmInstallOptions?: unknown }).npmInstallOptions;
  const oldShape = parseInventory(JSON.stringify(imported));
  const oldShapeSnapshot = oldShape.projects[0]?.snapshot;
  assert.ok(oldShapeSnapshot);
  assert.deepEqual(oldShapeSnapshot.npmInstallOptions, { legacyPeerDeps: null, installLinks: null });

  const malformed = structuredClone(oldShape);
  const malformedSnapshot = malformed.projects[0]?.snapshot;
  assert.ok(malformedSnapshot);
  (malformedSnapshot.npmInstallOptions as unknown as Record<string, unknown>).installLinks = 'false';
  assert.throws(() => parseInventory(JSON.stringify(malformed)), hasErrorCategory('corrupt'));

  const pnpmOptions = structuredClone(oldShape);
  pnpmOptions.projects[0].manager = 'pnpm';
  pnpmOptions.projects[0].lockfileVersion = '9.0';
  const pnpmSnapshot = pnpmOptions.projects[0]?.snapshot;
  assert.ok(pnpmSnapshot);
  pnpmSnapshot.npmInstallOptions.legacyPeerDeps = true;
  assert.throws(() => parseInventory(JSON.stringify(pnpmOptions)), hasErrorCategory('corrupt'));
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
  assert.ok(packageRecords[0]);
  assert.equal(Object.hasOwn(packageRecords[0], 'artifact'), false);
  assert.deepEqual(recorded.artifacts[0], { name: 'real-package', version: '1.2.3', packument, metadata, artifact });
  assert.deepEqual(parseInventory(serializeInventory(recorded)), recorded);
  const secondProject = structuredClone(project());
  secondProject.id = 'another';
  secondProject.lockfilePath = 'another/package-lock.json';
  const merged = mergeProject(recorded, secondProject);
  const retainedProject = merged.projects.find(item => item.id === 'another');
  assert.ok(retainedProject);
  const retained = retainedProject.packages.find(item => item.name === 'real-package');
  assert.ok(retained);
  assert.equal(Object.hasOwn(retained, 'artifact'), false);
  assert.deepEqual(merged.artifacts[0].artifact, artifact);
  assert.throws(
    () => recordVerifiedArtifact(recorded, { name: 'real-package', version: '1.2.3', packument, metadata, artifact: {
      ...artifact,
      sha512: Buffer.alloc(64, 1).toString('hex'),
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    } }),
    hasErrorCategory('conflict'),
  );
});
