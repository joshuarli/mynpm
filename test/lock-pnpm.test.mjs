import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parsePnpmLock, parsePnpmDocuments, pnpmBuildPackageKeys } from '../src/lock-pnpm.mjs';

const fixture = new URL('./fixtures/locks/pnpm-v9-local.yaml', import.meta.url);
const twoDocumentFixture = new URL('./fixtures/locks/pnpm-v12-two-documents.yaml', import.meta.url);
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
let yamlAvailable = true;

try {
  await import('yaml');
} catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND') yamlAvailable = false;
  else throw error;
}

test('pnpm v9 fixture is imported with the YAML document parser', { skip: !yamlAvailable }, async () => {
  const project = await parsePnpmLock(await readFile(fixture, 'utf8'), {
    projectId: 'local',
    lockfilePath: 'pnpm-lock.yaml',
    targetIds: ['mac-arm64'],
  });

  assert.equal(project.manager, 'pnpm');
  assert.equal(project.lockfileVersion, '9.0');
  assert.deepEqual(project.packages.map(pkg => [pkg.name, pkg.version, pkg.sourceKind]), [
    ['local-dep', null, 'local'],
  ]);
  assert.deepEqual(project.roots.map(root => [root.importer, root.requestedName, root.packageVersion]), [
    ['.', 'local-dep', null],
  ]);
});

test('pnpm two-document YAML preserves manager and project packages for doctor and import', { skip: !yamlAvailable }, async () => {
  const text = await readFile(twoDocumentFixture, 'utf8');
  const project = await parsePnpmLock(text, {
    projectId: 'two-documents',
    lockfilePath: 'pnpm-lock.yaml',
    targetIds: ['linux-x64-gnu'],
  });

  assert.deepEqual(project.packages.map(pkg => [pkg.name, pkg.version, pkg.sourceKind]), [
    ['pnpm', '12.15.0', 'registry'],
    ['private-download', '1.0.0', 'external-url'],
  ]);
  assert.deepEqual(project.roots.map(root => [root.group, root.requestedName, root.packageVersion]), [
    ['dependencies', 'private-download', '1.0.0'],
    ['devDependencies', 'pnpm', '12.15.0'],
  ]);
  assert.deepEqual(await pnpmBuildPackageKeys(text), ['private-download@1.0.0']);
});

test('pnpm documents union packages, roots, aliases, and peer-context snapshots', () => {
  const documents = [
    {
      lockfileVersion: '9.0',
      importers: {
        '.': {
          dependencies: {
            tool: { specifier: '0.1.0', version: '0.1.0' },
          },
          optionalDependencies: {
            'native-optional': { specifier: '1.0.0', version: '1.0.0' },
          },
        },
      },
      packages: {
        'tool@0.1.0': { resolution: { integrity } },
        'native-optional@1.0.0': { resolution: { integrity }, optional: true, os: ['darwin'], cpu: ['arm64'] },
      },
      snapshots: {
        'tool@0.1.0': {},
        'native-optional@1.0.0': {},
      },
    },
    {
      lockfileVersion: '9.0',
      importers: {
        '.': {
          dependencies: {
            'alias-app': { specifier: 'npm:@scope/app@^2.0.0', version: '@scope/app@2.0.0(peer-base@1.0.0)' },
          },
        },
      },
      packages: {
        '@scope/app@2.0.0': { resolution: { integrity } },
        'peer-base@1.0.0': { resolution: { integrity } },
        'another-peer@1.0.0': { resolution: { integrity } },
      },
      snapshots: {
        '@scope/app@2.0.0(peer-base@1.0.0)': { dependencies: { 'peer-base': '1.0.0' } },
        '@scope/app@2.0.0(another-peer@1.0.0)': { dependencies: { 'another-peer': '1.0.0' } },
        'peer-base@1.0.0': {},
        'another-peer@1.0.0': {},
      },
    },
  ];

  const project = parsePnpmDocuments(documents, {
    projectId: 'workspace',
    lockfilePath: 'pnpm-lock.yaml',
    targetIds: ['linux-x64-gnu', 'mac-arm64'],
  });
  const alias = project.roots.find(root => root.requestedName === 'alias-app');
  const optional = project.packages.find(pkg => pkg.name === 'native-optional');

  assert.equal(project.packages.length, 5);
  assert.equal(project.packages.filter(pkg => pkg.name === '@scope/app').length, 1);
  assert.deepEqual(alias, {
    importer: '.',
    requestedName: 'alias-app',
    specifier: 'npm:@scope/app@^2.0.0',
    packageName: '@scope/app',
    packageVersion: '2.0.0',
    group: 'dependencies',
    packageKey: '@scope/app@2.0.0',
  });
  assert.deepEqual(optional.platform.os, ['darwin']);
  assert.deepEqual(optional.targets, ['linux-x64-gnu', 'mac-arm64']);
  assert.ok(project.roots.some(root => root.requestedName === 'tool'));
});

test('pnpm importer paths stay with their roots', () => {
  const project = parsePnpmDocuments([{
    lockfileVersion: '9.0',
    importers: {
      'packages/web': {
        dependencies: { 'peer-base': { specifier: '1.0.0', version: '1.0.0' } },
      },
      'packages/empty': {},
    },
    packages: { 'peer-base@1.0.0': { resolution: { integrity } } },
    snapshots: { 'peer-base@1.0.0': {} },
  }], {
    projectId: 'workspace',
    lockfilePath: 'pnpm-lock.yaml',
    targetIds: ['mac-arm64'],
  });

  assert.equal(project.roots[0].importer, 'packages/web');
  assert.deepEqual(project.importers, ['packages/empty', 'packages/web']);
});

test('pnpm rejects unsupported revisions, unmatched snapshots, and conflicting documents', () => {
  const revision = {
    lockfileVersion: '9.0',
    packages: { 'pkg@1.0.0': { resolution: { integrity, revision: 1 } } },
    snapshots: { 'pkg@1.0.0': {} },
  };
  const unmatched = {
    lockfileVersion: '9.0',
    packages: {},
    snapshots: { 'missing@1.0.0': {} },
  };
  const base = {
    lockfileVersion: '9.0',
    packages: { 'pkg@1.0.0': { resolution: { integrity } } },
    snapshots: { 'pkg@1.0.0': {} },
  };
  const changed = {
    ...base,
    packages: { 'pkg@1.0.0': { resolution: { integrity: `sha512-${Buffer.alloc(64, 8).toString('base64')}` } } },
  };
  const options = { projectId: 'bad', lockfilePath: 'pnpm-lock.yaml', targetIds: ['mac-arm64'] };

  assert.throws(() => parsePnpmDocuments([revision], options), /unsupported resolution revision 1/);
  assert.throws(() => parsePnpmDocuments([unmatched], options), /no matching package entry/);
  assert.throws(() => parsePnpmDocuments([base, changed], options), error => error.category === 'conflict');
});
