import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it, test } from '@effect/vitest';
import { Effect } from 'effect';
import { parsePnpmLock, parsePnpmDocuments, pnpmBuildPackageKeys } from '../src/lock-pnpm.ts';
import { MynpmError } from '../src/errors.ts';

const fixture = new URL('./fixtures/locks/pnpm-v9-local.yaml', import.meta.url);
const twoDocumentFixture = new URL('./fixtures/locks/pnpm-v12-two-documents.yaml', import.meta.url);
const peerFixture = new URL('./fixtures/locks/pnpm-v12-peer.yaml', import.meta.url);
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
let yamlAvailable = true;

try {
  await import('yaml');
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') yamlAvailable = false;
  else throw error;
}

it.effect.skipIf(!yamlAvailable)('pnpm v9 fixture is imported with the YAML document parser', () => Effect.gen(function*() {
  const text = yield* Effect.tryPromise(() => readFile(fixture, 'utf8'));
  const project = yield* parsePnpmLock(text, {
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
}));

it.effect.skipIf(!yamlAvailable)('pnpm two-document YAML preserves manager and project packages for doctor and import', () => Effect.gen(function*() {
  const text = yield* Effect.tryPromise(() => readFile(twoDocumentFixture, 'utf8'));
  const project = yield* parsePnpmLock(text, {
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
  ]);
  assert.deepEqual(yield* pnpmBuildPackageKeys(text), ['private-download@1.0.0']);
}));

it.effect.skipIf(!yamlAvailable)('pnpm-generated peer fixture keeps peer context on snapshots and plain artifact keys', () => Effect.gen(function*() {
  const text = yield* Effect.tryPromise(() => readFile(peerFixture, 'utf8'));
  const project = yield* parsePnpmLock(text, {
    projectId: 'peer-fixture',
    lockfilePath: 'pnpm-lock.yaml',
    targetIds: ['linux-x64-gnu'],
  });

  assert.equal(project.roots[0].requestedName, '@effect/vitest');
  assert.equal(project.roots[0].packageKey, '@effect/vitest@4.0.5');
  assert.ok(project.packages.some(pkg => pkg.key === '@effect/vitest@4.0.5'));
  assert.ok(!project.packages.some(pkg => pkg.key.includes('(effect@')));
  assert.match(text, /'@effect\/vitest@4\.0\.5\(effect@4\.0\.5\)\(vitest@/);
}));

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

  assert.ok(optional);
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

test('pnpm roots resolve peer-qualified aliases to plain artifact keys and preserve peer snapshots', () => {
  const packageKeys = {
    '@scope/app@2.0.0': { name: '@scope/app', resolution: { integrity } },
    '@scope/peer@1.0.0': { name: '@scope/peer', resolution: { integrity } },
    '@scope/nested@3.0.0': { name: '@scope/nested', resolution: { integrity } },
  };
  const project = parsePnpmDocuments([{
    lockfileVersion: '9.0',
    importers: {
      '.': {
        dependencies: {
          'app-alias': {
            specifier: 'npm:@scope/app@^2.0.0',
            version: '@scope/app@2.0.0(@scope/peer@1.0.0(@scope/nested@3.0.0))',
          },
        },
      },
    },
    packages: packageKeys,
    snapshots: {
      '@scope/app@2.0.0(@scope/peer@1.0.0(@scope/nested@3.0.0))': {
        dependencies: { '@scope/peer': '1.0.0(@scope/nested@3.0.0)' },
      },
      '@scope/app@2.0.0(@scope/peer@1.0.0(@scope/other@4.0.0))': {
        dependencies: { '@scope/peer': '1.0.0(@scope/other@4.0.0)' },
      },
      '@scope/peer@1.0.0(@scope/nested@3.0.0)': {
        dependencies: { '@scope/nested': '3.0.0' },
      },
      '@scope/peer@1.0.0(@scope/other@4.0.0)': {
        dependencies: { '@scope/nested': '3.0.0' },
      },
      '@scope/nested@3.0.0': {},
    },
  }], {
    projectId: 'peer-roots',
    lockfilePath: 'pnpm-lock.yaml',
    targetIds: ['linux-x64-gnu'],
  });

  assert.deepEqual(project.roots[0], {
    importer: '.',
    requestedName: 'app-alias',
    specifier: 'npm:@scope/app@^2.0.0',
    packageName: '@scope/app',
    packageVersion: '2.0.0',
    group: 'dependencies',
    packageKey: '@scope/app@2.0.0',
  });
  assert.deepEqual(project.packages.map(pkg => pkg.key), [
    '@scope/app@2.0.0',
    '@scope/nested@3.0.0',
    '@scope/peer@1.0.0',
  ]);
});

test('pnpm peer-qualified root resolves its plain artifact package key', () => {
  const project = parsePnpmDocuments([{
    lockfileVersion: '9.0',
    importers: {
      '.': { dependencies: { button: { specifier: '1.0.0', version: '1.0.0(react@19.0.0)' } } },
    },
    packages: {
      'button@1.0.0': { resolution: { integrity } },
      'react@19.0.0': { resolution: { integrity } },
    },
    snapshots: {
      'button@1.0.0(react@19.0.0)': { dependencies: { react: '19.0.0' } },
      'react@19.0.0': {},
    },
  }], {
    projectId: 'button-peer-root',
    lockfilePath: 'pnpm-lock.yaml',
    targetIds: ['linux-x64-gnu'],
  });

  assert.equal(project.roots[0].packageName, 'button');
  assert.equal(project.roots[0].packageVersion, '1.0.0');
  assert.equal(project.roots[0].packageKey, 'button@1.0.0');
  assert.deepEqual(project.packages.map(pkg => pkg.key), ['button@1.0.0', 'react@19.0.0']);
});

test('pnpm rejects peer-qualified snapshot dependencies with nonexistent refs', () => {
  const lock = {
    lockfileVersion: '9.0',
    packages: {
      'app@1.0.0': { resolution: { integrity } },
      'peer@1.0.0': { resolution: { integrity } },
    },
    snapshots: {
      'app@1.0.0(peer@1.0.0)': { dependencies: { peer: '1.0.0(peer@2.0.0)' } },
      'peer@1.0.0': {},
    },
  };

  assert.throws(() => parsePnpmDocuments([lock], {
    projectId: 'missing-peer',
    lockfilePath: 'pnpm-lock.yaml',
    targetIds: ['linux-x64-gnu'],
  }), /snapshot dependency has no matching snapshot: peer@1\.0\.0\(peer@2\.0\.0\)/);
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
  assert.throws(() => parsePnpmDocuments([base, changed], options), error => error instanceof MynpmError && error.category === 'conflict');
});
