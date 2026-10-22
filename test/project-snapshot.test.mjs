import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { fileURLToPath } from 'node:url';
import { parseNpmLock } from '../src/lock-npm.ts';
import { parsePnpmLock } from '../src/lock-pnpm.ts';
import { captureProjectSnapshot } from '../src/project-snapshot.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = join(repositoryRoot, '.work', 'tmp');
const npmLockFixture = JSON.parse(readFileSync(new URL('./fixtures/locks/package-lock-v3.json', import.meta.url), 'utf8'));
const pnpmLockText = readFileSync(new URL('./fixtures/locks/pnpm-v12-two-documents.yaml', import.meta.url), 'utf8');

function withScratch(run) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      mkdirSync(scratchRoot, { recursive: true });
      return mkdtempSync(join(scratchRoot, 'mynpm-snapshot-'));
    }),
    run,
    directory => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
}

function npmLockWithoutCredentials() {
  const lock = structuredClone(npmLockFixture);
  delete lock.packages['node_modules/credential-url'];
  return lock;
}

function npmProject(lock) {
  return parseNpmLock(lock, {
    projectId: 'web',
    lockfilePath: 'package-lock.json',
    targetIds: ['linux-x64-gnu'],
  });
}

function captureNpm(projectDirectory, lock, manifest = '{"name":"web"}\n') {
  writeFileSync(join(projectDirectory, 'package.json'), manifest);
  writeFileSync(join(projectDirectory, 'package-lock.json'), `${JSON.stringify(lock)}\n`);
  return captureProjectSnapshot({
    manager: 'npm',
    projectDirectory,
    lockfileText: `${JSON.stringify(lock)}\n`,
    lock,
    project: npmProject(lock),
  });
}

function capturePnpm(projectDirectory, lockfileText = pnpmLockText) {
  return Effect.gen(function*() {
    writeFileSync(join(projectDirectory, 'package.json'), '{"name":"web","packageManager":"pnpm@12.15.0"}\n');
    writeFileSync(join(projectDirectory, 'pnpm-lock.yaml'), lockfileText);
    const project = yield* parsePnpmLock(lockfileText, {
      projectId: 'web',
      packageManagerPin: 'pnpm@12.15.0',
      lockfilePath: 'pnpm-lock.yaml',
      targetIds: ['linux-x64-gnu'],
    });
    return yield* captureProjectSnapshot({
      manager: 'pnpm',
      projectDirectory,
      lockfileText,
      lock: null,
      project,
    });
  });
}

it.effect('snapshot captures allowlisted npm install settings without copying other config', () => withScratch(directory => Effect.gen(function*() {
  const projectDirectory = join(directory, 'project');
  mkdirSync(projectDirectory);
  const lock = npmLockWithoutCredentials();
  writeFileSync(join(projectDirectory, '.npmrc'), '# local install shape\nlegacy-peer-deps=true\ninstall-links=false\n');
  mkdirSync(join(projectDirectory, 'packages', 'workspace'), { recursive: true });
  writeFileSync(join(projectDirectory, 'packages', 'workspace', 'package.json'), '{"name":"workspace-link","version":"1.0.0"}\n');

  const snapshot = yield* captureNpm(projectDirectory, lock);

  assert.deepEqual(snapshot.npmInstallOptions, { legacyPeerDeps: true, installLinks: false });
  assert.deepEqual(snapshot.workspaceFiles, [{
    path: 'packages/workspace/package.json',
    contents: '{"name":"workspace-link","version":"1.0.0"}\n',
  }]);
})));

it.effect('snapshot rejects unsupported npm project configuration without exposing values', () => withScratch(directory => Effect.gen(function*() {
  const projectDirectory = join(directory, 'project');
  mkdirSync(projectDirectory);
  const lock = npmLockWithoutCredentials();
  writeFileSync(join(projectDirectory, '.npmrc'), 'registry=https://user:secret@example.invalid/\n');
  writeFileSync(join(projectDirectory, 'package.json'), '{"name":"web"}\n');
  const lockText = `${JSON.stringify(lock)}\n`;
  writeFileSync(join(projectDirectory, 'package-lock.json'), lockText);

  const result = yield* Effect.result(captureProjectSnapshot({
    manager: 'npm',
    projectDirectory,
    lockfileText: lockText,
    lock,
    project: npmProject(lock),
  }));

  assert.equal(result._tag, 'Failure');
  if (result._tag === 'Failure') {
    assert.match(result.failure.message, /unsupported \.npmrc setting registry/);
    assert.doesNotMatch(result.failure.message, /secret|example\.invalid/);
  }
  assert.equal(readFileSync(join(projectDirectory, '.npmrc'), 'utf8'), 'registry=https://user:secret@example.invalid/\n');
  assert.equal(readFileSync(join(projectDirectory, 'package.json'), 'utf8'), '{"name":"web"}\n');
  assert.equal(readFileSync(join(projectDirectory, 'package-lock.json'), 'utf8'), lockText);
})));

it.effect('snapshot rejects credential-bearing URLs in manifests, workspaces, and locks', () => withScratch(directory => Effect.gen(function*() {
  const lock = npmLockWithoutCredentials();
  const cases = [
    {
      label: 'manifest',
      manifest: '{"name":"web","dependencies":{"private":"https://user:secret@example.invalid/pkg.tgz?token=secret"}}\n',
      workspace: null,
      locked: false,
    },
    {
      label: 'workspace manifest',
      manifest: '{"name":"web"}\n',
      workspace: '{"name":"workspace-link","dependencies":{"private":"git+https://user:secret@example.invalid/repo.git"}}\n',
      locked: false,
    },
    {
      label: 'lockfile',
      manifest: '{"name":"web"}\n',
      workspace: null,
      locked: true,
    },
  ];

  for (const item of cases) {
    const projectDirectory = join(directory, item.label.replaceAll(' ', '-'));
    mkdirSync(projectDirectory);
    const currentLock = structuredClone(lock);
    if (item.locked) {
      currentLock.packages['node_modules/private'] = {
        version: '1.0.0',
        resolved: 'https://user:secret@registry.npmjs.org/private/-/private-1.0.0.tgz?token=secret',
      };
    }
    writeFileSync(join(projectDirectory, 'package.json'), item.manifest);
    if (item.workspace !== null) {
      mkdirSync(join(projectDirectory, 'packages', 'workspace'), { recursive: true });
      writeFileSync(join(projectDirectory, 'packages', 'workspace', 'package.json'), item.workspace);
    }
    const lockText = `${JSON.stringify(currentLock)}\n`;
    writeFileSync(join(projectDirectory, 'package-lock.json'), lockText);
    const result = yield* Effect.result(captureProjectSnapshot({
      manager: 'npm',
      projectDirectory,
      lockfileText: lockText,
      lock: currentLock,
      project: npmProject(currentLock),
    }));

    assert.equal(result._tag, 'Failure', item.label);
    if (result._tag === 'Failure') {
      assert.match(result.failure.message, /credential-bearing URL/);
      assert.doesNotMatch(result.failure.message, /secret|example\.invalid/);
    }
  }
})));

it.effect('pnpm snapshot rejects executable, registry, runtime, and patch configuration', () => withScratch(directory => Effect.gen(function*() {
  const hookMarker = join(directory, 'hook-executed');
  const cases = [
    { label: 'pnpmfile', setup: projectDirectory => writeFileSync(join(projectDirectory, '.pnpmfile.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(hookMarker)}, 'ran');\n`) },
    { label: 'registry', setup: projectDirectory => writeFileSync(join(projectDirectory, 'pnpm-workspace.yaml'), 'registry: https://registry.example.invalid/\n') },
    { label: 'runtime', setup: projectDirectory => writeFileSync(join(projectDirectory, 'pnpm-workspace.yaml'), 'runtime: node@24.0.0\n') },
    { label: 'patches', setup: projectDirectory => writeFileSync(join(projectDirectory, 'pnpm-workspace.yaml'), 'patchedDependencies:\n  private-package@1.0.0: patches/private.patch\n') },
    { label: 'npmrc', setup: projectDirectory => writeFileSync(join(projectDirectory, '.npmrc'), 'registry=https://registry.example.invalid/\n') },
  ];

  for (const item of cases) {
    const projectDirectory = join(directory, item.label);
    mkdirSync(projectDirectory);
    item.setup(projectDirectory);
    const result = yield* Effect.result(capturePnpm(projectDirectory));
    assert.equal(result._tag, 'Failure', item.label);
    if (result._tag === 'Failure') assert.match(result.failure.message, /unsupported pnpm project configuration|unsupported \.npmrc setting/);
    if (item.label === 'pnpmfile') assert.match(readFileSync(join(projectDirectory, '.pnpmfile.cjs'), 'utf8'), /hook-executed/);
  }
  assert.equal(existsSync(hookMarker), false);
})));

it.effect('pnpm snapshot rejects config dependencies, lock patches, and credential URLs in workspace configuration', () => withScratch(directory => Effect.gen(function*() {
  const cases = [
    {
      label: 'configuration dependency',
      lockText: pnpmLockText.replace('configDependencies: {}', 'configDependencies:\n      executable-config: 1.0.0'),
      workspaceText: null,
    },
    {
      label: 'lock patches',
      lockText: pnpmLockText.replace('packages:\n', 'patchedDependencies:\n  private-package@1.0.0:\n    hash: abc\n    path: patches/private.patch\npackages:\n'),
      workspaceText: null,
    },
    {
      label: 'workspace URL',
      lockText: pnpmLockText,
      workspaceText: 'catalog:\n  private: https://user:secret@example.invalid/private.tgz?token=secret\n',
    },
  ];

  for (const item of cases) {
    const projectDirectory = join(directory, item.label.replaceAll(' ', '-'));
    mkdirSync(projectDirectory);
    if (item.workspaceText !== null) writeFileSync(join(projectDirectory, 'pnpm-workspace.yaml'), item.workspaceText);
    const result = yield* Effect.result(capturePnpm(projectDirectory, item.lockText));
    assert.equal(result._tag, 'Failure', item.label);
    if (result._tag === 'Failure') {
      assert.match(result.failure.message, /unsupported pnpm project configuration|credential-bearing URL/);
      assert.doesNotMatch(result.failure.message, /secret|example\.invalid/);
    }
    assert.equal(readFileSync(join(projectDirectory, 'pnpm-lock.yaml'), 'utf8'), item.lockText);
  }
})));
