import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseInventory } from '../src/inventory.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = join(repositoryRoot, '.work', 'tmp');
const cliPath = join(repositoryRoot, 'src', 'cli.ts');
const configPath = join(repositoryRoot, 'test', 'fixtures', 'mynpm.json');
const lockfilePath = join(repositoryRoot, 'test', 'fixtures', 'locks', 'package-lock-v3.json');
const addLockfilePath = join(repositoryRoot, 'test', 'fixtures', 'locks', 'package-lock-add.json');
const pnpmLockfilePath = join(repositoryRoot, 'test', 'fixtures', 'locks', 'pnpm-v12-two-documents.yaml');
const pnpmPeerLockfilePath = join(repositoryRoot, 'test', 'fixtures', 'locks', 'pnpm-v12-peer.yaml');

let yamlAvailable = true;
try {
  await import('yaml');
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') yamlAvailable = false;
  else throw error;
}

function withScratch<A>(run: (directory: string) => A): A {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'mynpm-cli-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runCli(scratch: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const temporaryDirectory = join(scratch, 'tmp');
  mkdirSync(temporaryDirectory, { recursive: true });
  return spawnSync(process.execPath, ['--experimental-strip-types', cliPath, ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TMPDIR: temporaryDirectory,
      npm_config_cache: join(temporaryDirectory, 'npm-cache'),
      ...overrides,
    },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
}

function importableNpmLockText() {
  const lock = JSON.parse(readFileSync(lockfilePath, 'utf8'));
  delete lock.packages['node_modules/credential-url'];
  return `${JSON.stringify(lock)}\n`;
}

test('plan emits inventory JSON without creating state', () => withScratch(scratch => {
  const stateDirectory = join(scratch, 'state');
  const result = runCli(scratch, [
    '--config', configPath,
    '--state-dir', stateDirectory,
    'plan',
    '--json',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    blockedSources: [],
    packageCount: 0,
    packages: [],
    projectCount: 0,
    publicBaseUrl: 'https://deps.example.net/mirror/',
    schemaVersion: 1,
    targets: ['linux-x64-gnu', 'mac-arm64'],
  });
  assert.throws(() => readdirSync(stateDirectory), { code: 'ENOENT' });
}));

test('import-lock writes a versioned inventory and plan observes it', () => withScratch(scratch => {
  const stateDirectory = join(scratch, 'state');
  const importLockPath = join(scratch, 'package-lock.json');
  writeFileSync(importLockPath, importableNpmLockText());
  const imported = runCli(scratch, [
    '--config', configPath,
    '--state-dir', stateDirectory,
    'import-lock',
    importLockPath,
    '--project', 'web',
    '--target', 'linux-x64-gnu',
  ]);

  assert.equal(imported.status, 0, imported.stderr);
  const inventory = parseInventory(readFileSync(join(stateDirectory, 'inventory.json'), 'utf8'));
  assert.equal(inventory.schemaVersion, 2);
  assert.equal(inventory.projects[0].id, 'web');
  assert.equal(inventory.projects[0].targets[0], 'linux-x64-gnu');

  const planned = runCli(scratch, ['--config', configPath, '--state-dir', stateDirectory, 'plan', '--json']);
  assert.equal(planned.status, 0, planned.stderr);
  const expectedPackageCount = new Set(inventory.projects.flatMap(project => project.packages)
    .filter(item => item.version !== null)
    .map(item => `${item.name}@${item.version}`)).size;
  assert.equal(JSON.parse(planned.stdout).packageCount, expectedPackageCount);
}));

test('import-lock honors and records the project package manager pin', () => withScratch(scratch => {
  const projectDirectory = join(scratch, 'project');
  mkdirSync(join(projectDirectory, 'packages', 'workspace'), { recursive: true });
  const projectLockPath = join(projectDirectory, 'package-lock.json');
  writeFileSync(projectLockPath, importableNpmLockText());
  const manifest = '{"name":"web","packageManager":"npm@12.2.1"}\n';
  const workspaceManifest = '{"name":"workspace-link","version":"1.0.0"}\n';
  writeFileSync(join(projectDirectory, 'package.json'), manifest);
  writeFileSync(join(projectDirectory, 'packages', 'workspace', 'package.json'), workspaceManifest);
  const stateDirectory = join(scratch, 'state');

  const result = runCli(scratch, [
    '--config', configPath,
    '--state-dir', stateDirectory,
    'import-lock',
    projectLockPath,
    '--project',
    'web',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Package manager pin: npm@12\.2\.1/);
  const inventory = JSON.parse(readFileSync(join(stateDirectory, 'inventory.json'), 'utf8'));
  assert.equal(inventory.projects[0].packageManagerPin, 'npm@12.2.1');
  assert.equal(inventory.projects[0].snapshot.manifest, manifest);
  assert.deepEqual(inventory.projects[0].snapshot.npmInstallOptions, { legacyPeerDeps: null, installLinks: null });
  assert.deepEqual(inventory.projects[0].snapshot.workspaceFiles, [{ path: 'packages/workspace/package.json', contents: workspaceManifest }]);
  assert.doesNotMatch(inventory.projects[0].snapshot.lockfile, /user:secret|token=secret/);

  writeFileSync(join(projectDirectory, 'package.json'), '{"name":"web","packageManager":"pnpm@12.15.0"}\n');
  const mismatch = runCli(scratch, [
    '--config', configPath,
    '--state-dir', join(scratch, 'mismatch-state'),
    'import-lock',
    projectLockPath,
    '--project',
    'web',
  ]);
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /does not match npm lockfile/);
}));

test('import-lock rejects lockfile credentials before writing inventory state', () => withScratch(scratch => {
  const projectDirectory = join(scratch, 'project');
  mkdirSync(projectDirectory);
  const projectLockPath = join(projectDirectory, 'package-lock.json');
  const lockBytes = readFileSync(lockfilePath);
  writeFileSync(projectLockPath, lockBytes);
  writeFileSync(join(projectDirectory, 'package.json'), '{"name":"web"}\n');
  const stateDirectory = join(scratch, 'state');

  const result = runCli(scratch, [
    '--config', configPath,
    '--state-dir', stateDirectory,
    'import-lock',
    projectLockPath,
    '--project', 'web',
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /credential-bearing URL/);
  assert.doesNotMatch(result.stderr, /user:secret|token=secret/);
  assert.throws(() => readdirSync(stateDirectory), { code: 'ENOENT' });
  assert.deepEqual(readFileSync(projectLockPath), lockBytes);
}));

test('import-lock rejects symlinked workspace snapshot paths', () => withScratch(scratch => {
  const projectDirectory = join(scratch, 'project');
  const outsideDirectory = join(scratch, 'outside');
  mkdirSync(projectDirectory);
  mkdirSync(outsideDirectory);
  writeFileSync(join(projectDirectory, 'package.json'), '{"name":"web"}\n');
  writeFileSync(join(projectDirectory, 'package-lock.json'), importableNpmLockText());
  writeFileSync(join(outsideDirectory, 'package.json'), '{"name":"outside"}\n');
  mkdirSync(join(projectDirectory, 'packages'));
  symlinkSync(outsideDirectory, join(projectDirectory, 'packages', 'workspace'));

  const result = runCli(scratch, [
    '--config', configPath,
    '--state-dir', join(scratch, 'state'),
    'import-lock',
    join(projectDirectory, 'package-lock.json'),
    '--project', 'web',
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /project snapshot path is not a regular directory/);
  assert.equal(readFileSync(join(outsideDirectory, 'package.json'), 'utf8'), '{"name":"outside"}\n');
}));

test('CLI maps usage, invalid input, and corrupt state to the specified exit codes', () => withScratch(scratch => {
  const usage = runCli(scratch, ['plan', '--unknown']);
  assert.equal(usage.status, 2);
  assert.equal((usage.stderr.match(/mynpm:/g) ?? []).length, 1);

  const invalidInput = runCli(scratch, ['--config', join(scratch, 'missing.json'), 'plan']);
  assert.equal(invalidInput.status, 2);

  const stateDirectory = join(scratch, 'state');
  mkdirSync(stateDirectory);
  writeFileSync(join(stateDirectory, 'inventory.json'), '{');
  const corrupt = runCli(scratch, ['--config', configPath, '--state-dir', stateDirectory, 'plan']);
  assert.equal(corrupt.status, 1);
}));

test('add requires exact root pins and the campaign-pinned package manager', () => withScratch(scratch => {
  const invalid = runCli(scratch, [
    '--config', configPath,
    'add',
    'sample-package@latest',
    '--manager',
    'npm',
  ]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /requires an exact package pin/);

  const fakeBin = join(scratch, 'bin');
  mkdirSync(fakeBin);
  const fakeNpm = join(fakeBin, 'npm');
  writeFileSync(fakeNpm, '#!/bin/sh\nprintf "11.20.0\\n"\n');
  chmodSync(fakeNpm, 0o755);
  const stateDirectory = join(scratch, 'state');
  const unavailable = runCli(scratch, [
    '--config', configPath,
    '--state-dir', stateDirectory,
    'add',
    'sample-package@1.2.3',
    '--manager',
    'npm',
  ], { PATH: `${fakeBin}:${process.env.PATH}` });
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /npm 12\.2\.1 is required for add; found 11\.20\.0/);
  assert.throws(() => readdirSync(stateDirectory), { code: 'ENOENT' });
}));

test('add strips caller auth and registry settings, resolves exact roots, and repeats without state changes', () => withScratch(scratch => {
  const fakeBin = join(scratch, 'bin');
  mkdirSync(fakeBin);
  const fakeNpm = join(fakeBin, 'npm');
  const fakeLock = join(scratch, 'package-lock.json');
  writeFileSync(fakeLock, readFileSync(addLockfilePath));
  writeFileSync(fakeNpm, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then printf "12.2.1\\n"; exit 0; fi',
    'test "${NPM_TOKEN+x}" != x',
    'test "${NODE_AUTH_TOKEN+x}" != x',
    'test "$npm_config_registry" = "https://registry.npmjs.org/"',
    `cp '${fakeLock}' package-lock.json`,
    '',
  ].join('\n'));
  chmodSync(fakeNpm, 0o755);
  const stateDirectory = join(scratch, 'state');
  const arguments_ = [
    '--config', configPath,
    '--state-dir', stateDirectory,
    'add',
    'sample-package@1.2.3',
    '--manager',
    'npm',
  ];
  const environment = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    NPM_TOKEN: 'inherited-secret',
    NODE_AUTH_TOKEN: 'inherited-secret',
    npm_config_registry: 'https://registry.example.invalid/',
  };

  const added = runCli(scratch, arguments_, environment);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /npm@12\.2\.1/);
  const inventoryPath = join(stateDirectory, 'inventory.json');
  const inventoryBytes = readFileSync(inventoryPath);
  const inventory = parseInventory(inventoryBytes.toString('utf8'));
  assert.deepEqual(inventory.projects.map(project => project.targets[0]), ['linux-x64-gnu', 'mac-arm64']);
  assert.ok(inventory.projects.every(project => project.packageManagerPin === 'npm@12.2.1'));
  assert.ok(inventory.projects.every(project => project.packages.map(pkg => `${pkg.name}@${pkg.version}`).join(',') === 'sample-package@1.2.3,transitive@2.0.0'));
  assert.ok(inventory.projects.every(project => project.snapshot?.manifest?.includes('"name": "mynpm-resolution"') === true));
  assert.ok(inventory.projects.every(project => project.snapshot !== null && JSON.parse(project.snapshot.lockfile).lockfileVersion === 3));

  const repeated = runCli(scratch, arguments_, environment);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(readFileSync(inventoryPath), inventoryBytes);
}));

test('add with pnpm preserves peer-qualified snapshots and plain artifact keys', () => withScratch(scratch => {
  const fakeBin = join(scratch, 'bin');
  mkdirSync(fakeBin);
  const fakePnpm = join(fakeBin, 'pnpm');
  writeFileSync(fakePnpm, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then printf "12.15.0\\n"; exit 0; fi',
    'test "$1" = "install"',
    'test "$2" = "--lockfile-only"',
    'test "$3" = "--ignore-scripts"',
    'test "$4" = "@effect/vitest@4.0.5"',
    'test "${NPM_TOKEN+x}" != x',
    'test "${NODE_AUTH_TOKEN+x}" != x',
    'test "$npm_config_registry" = "https://registry.npmjs.org/"',
    `cp '${pnpmPeerLockfilePath}' pnpm-lock.yaml`,
    '',
  ].join('\n'));
  chmodSync(fakePnpm, 0o755);
  const stateDirectory = join(scratch, 'state');
  const result = runCli(scratch, [
    '--config', configPath,
    '--state-dir', stateDirectory,
    '--target', 'linux-x64-gnu',
    'add',
    '@effect/vitest@4.0.5',
    '--manager',
    'pnpm',
  ], {
    PATH: `${fakeBin}:${process.env.PATH}`,
    NPM_TOKEN: 'inherited-secret',
    NODE_AUTH_TOKEN: 'inherited-secret',
    npm_config_registry: 'https://registry.example.invalid/',
  });

  assert.equal(result.status, 0, result.stderr);
  const project = parseInventory(readFileSync(join(stateDirectory, 'inventory.json'), 'utf8')).projects[0];
  assert.ok(project);
  assert.ok(project.snapshot);
  assert.ok(project.snapshot.manifest);
  assert.equal(project.roots[0].packageKey, '@effect/vitest@4.0.5');
  assert.ok(project.packages.some(pkg => pkg.key === '@effect/vitest@4.0.5'));
  assert.ok(project.snapshot.lockfile.includes('@effect/vitest@4.0.5(effect@4.0.5)(vitest@'));
}));

test('doctor reports external sources without changing the project', () => withScratch(scratch => {
  const projectDirectory = join(scratch, 'project');
  mkdirSync(projectDirectory);
  const projectLockPath = join(projectDirectory, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockfilePath, 'utf8'));
  lock.packages['node_modules/private-host'] = {
    version: '1.0.0',
    resolved: 'https://192.168.4.5/npm/private-host/-/private-host-1.0.0.tgz',
    integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    hasInstallScript: true,
  };
  const lockBytes = Buffer.from(`${JSON.stringify(lock)}\n`);
  writeFileSync(projectLockPath, lockBytes);
  writeFileSync(join(projectDirectory, 'package.json'), '{"name":"web","packageManager":"npm@12.2.1","scripts":{"preinstall":"echo pre","postinstall":"echo post"}}\n');

  const result = runCli(scratch, ['--config', configPath, 'doctor', projectDirectory]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /third-party-download: external-tarball/);
  assert.match(result.stdout, /local-source: workspace@1\.0\.0/);
  assert.match(result.stdout, /git-source: git-source/);
  assert.match(result.stdout, /private-host: private-host/);
  assert.match(result.stdout, /install\/build hook: private-host/);
  assert.match(result.stdout, /Root lifecycle scripts: preinstall, postinstall/);
  assert.match(result.stdout, /@esbuild\/linux-x64.*native binary or build/);
  assert.match(result.stdout, /--omit-lockfile-registry-resolved/);
  assert.match(result.stdout, /replace-registry-host defaults to npmjs/);
  assert.match(result.stdout, /Package manager pin: npm@12\.2\.1/);
  assert.match(result.stdout, /copy/i);
  assert.doesNotMatch(result.stdout, /secret/);
  assert.deepEqual(readFileSync(projectLockPath), lockBytes);
  assert.deepEqual(readdirSync(projectDirectory).sort(), ['package-lock.json', 'package.json']);
}));

test.skipIf(!yamlAvailable)('doctor reports pnpm sources and build hooks without changing the project', () => withScratch(scratch => {
  const projectDirectory = join(scratch, 'pnpm-project');
  mkdirSync(projectDirectory);
  const lockBytes = readFileSync(pnpmLockfilePath);
  const manifestBytes = Buffer.from('{"name":"web","packageManager":"pnpm@12.15.0","scripts":{"prepare":"echo prepare"}}\n');
  writeFileSync(join(projectDirectory, 'pnpm-lock.yaml'), lockBytes);
  writeFileSync(join(projectDirectory, 'package.json'), manifestBytes);

  const result = runCli(scratch, ['--config', configPath, 'doctor', projectDirectory]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Package manager pin: pnpm@12\.15\.0/);
  assert.match(result.stdout, /private-host: private-download/);
  assert.match(result.stdout, /Dependency install\/build hooks in lockfile: 1/);
  assert.match(result.stdout, /install\/build hook: private-download@1\.0\.0/);
  assert.match(result.stdout, /Root lifecycle scripts: prepare/);
  assert.match(result.stdout, /pnpm install --lockfile-only --ignore-scripts/);
  assert.deepEqual(readFileSync(join(projectDirectory, 'pnpm-lock.yaml')), lockBytes);
  assert.deepEqual(readFileSync(join(projectDirectory, 'package.json')), manifestBytes);
  assert.deepEqual(readdirSync(projectDirectory).sort(), ['package.json', 'pnpm-lock.yaml']);
}));
