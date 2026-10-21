import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseNpmLock } from '../src/lock-npm.mjs';

const lockPath = new URL('./fixtures/locks/package-lock-v3.json', import.meta.url);
const v3Lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const v2Lock = JSON.parse(readFileSync(new URL('./fixtures/locks/package-lock-v2.json', import.meta.url), 'utf8'));

function parse(lock = v3Lock) {
  return parseNpmLock(lock, {
    projectId: 'web',
    lockfilePath: 'web/package-lock.json',
    targetIds: ['linux-x64-gnu'],
  });
}

test('npm v2 and v3 lockfiles preserve nested, scoped, and aliased identities', () => {
  const v3 = parse();
  const v2 = parse(v2Lock);

  assert.equal(v3.manager, 'npm');
  assert.equal(v3.lockfileVersion, 3);
  assert.equal(v2.lockfileVersion, 2);
  assert.equal(v2.packages[0].name, 'flatdemo');
  assert.equal(v3.packages.find(pkg => pkg.key === 'node_modules/catalog-alias').name, 'real-package');
  assert.equal(v3.packages.find(pkg => pkg.key === 'node_modules/catalog-alias').aliases[0], 'catalog-alias');
  assert.deepEqual(v3.packages.filter(pkg => pkg.name === 'nested').map(pkg => pkg.version).sort(), ['1.0.4', '2.1.0']);
  assert.equal(v3.packages.find(pkg => pkg.name === '@scope/direct').version, '2.0.1');
});

test('npm roots preserve requested aliases and dependency groups', () => {
  const imported = parse();
  const alias = imported.roots.find(root => root.requestedName === 'catalog-alias');
  const optional = imported.roots.find(root => root.requestedName === '@esbuild/linux-x64');

  assert.deepEqual(alias, {
    importer: '.',
    requestedName: 'catalog-alias',
    specifier: 'npm:real-package@^1.2.0',
    packageName: 'real-package',
    packageVersion: '1.2.3',
    group: 'dependencies',
    packageKey: 'node_modules/catalog-alias',
  });
  assert.equal(optional.group, 'optionalDependencies');
});

test('npm package flags and platform restrictions remain explicit', () => {
  const imported = parse();
  const dev = imported.packages.find(pkg => pkg.name === 'dev-only');
  const peer = imported.packages.find(pkg => pkg.name === 'peer-only');
  const optional = imported.packages.find(pkg => pkg.name === '@esbuild/linux-x64');

  assert.equal(dev.flags.dev, true);
  assert.equal(peer.flags.peer, true);
  assert.equal(peer.flags.peerOptional, true);
  assert.equal(optional.flags.optional, true);
  assert.deepEqual(optional.platform, { os: ['linux'], cpu: ['x64'], libc: null });
  assert.deepEqual(optional.targets, ['linux-x64-gnu']);
});

test('npm non-registry sources receive explicit classifications', () => {
  const packages = parse().packages;
  const kind = name => packages.find(pkg => pkg.name === name).sourceKind;

  assert.equal(kind('workspace-link'), 'local');
  assert.equal(kind('local-file'), 'local');
  assert.equal(kind('git-source'), 'git');
  assert.equal(kind('github-source'), 'git');
  assert.equal(kind('external-tarball'), 'external-url');
  assert.equal(kind('private-package'), 'external-url');
  assert.equal(kind('credential-url'), 'external-url');
  assert.equal(packages.find(pkg => pkg.name === 'credential-url').resolved, 'https://registry.npmjs.org/credential-url/-/credential-url-1.0.0.tgz');
  assert.doesNotMatch(JSON.stringify(packages.find(pkg => pkg.name === 'credential-url')), /secret/);
});

test('npm import rejects v1 and malformed package maps', () => {
  assert.throws(() => parse({ ...v3Lock, lockfileVersion: 1 }), error => error.category === 'input');
  assert.throws(() => parse({ ...v3Lock, packages: [] }), error => error.category === 'input');
  assert.throws(
    () => parse({ ...v3Lock, packages: { ...v3Lock.packages, 'node_modules/bad': { version: '../1' } } }),
    error => error.category === 'input',
  );
});
