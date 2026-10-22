import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.ts';
import { createEmptyInventory, mergeProject, recordVerifiedArtifact } from '../src/inventory.ts';
import { parseNpmLock } from '../src/lock-npm.ts';
import { parsePnpmLock } from '../src/lock-pnpm.ts';
import { saveInventory } from '../src/inventory-store.ts';
import { managerVersions } from '../src/resolve.ts';
import { validateInventory } from '../src/validate.ts';

const scratchRoot = fileURLToPath(new URL('../.work/tmp/', import.meta.url));
const config = parseConfig(readFileSync(new URL('./fixtures/mynpm.json', import.meta.url), 'utf8'));

function currentTarget() {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = process.arch === 'arm64' ? 'arm64' : 'x64';
  const libc = os === 'linux' ? process.report?.getReport()?.header?.glibcVersionRuntime ? 'glibc' : 'musl' : null;
  return config.targets.find(target => target.os === os && target.cpu === cpu && (target.libc ?? null) === libc);
}

function withScratch(prefix, run) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      mkdirSync(scratchRoot, { recursive: true });
      return mkdtempSync(join(scratchRoot, prefix));
    }),
    run,
    directory => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
}

function assertFailure(effect, check) {
  return Effect.gen(function*() {
    const result = yield* Effect.result(effect);
    assert.equal(result._tag, 'Failure');
    if (result._tag === 'Failure') assert(check(result.failure));
  });
}

function savedNpmProject(directory) {
  return Effect.gen(function*() {
    const target = currentTarget();
    const bytes = readFileSync(new URL('./fixtures/tarballs/flatdemo-1.2.3.tgz', import.meta.url));
    const sha512 = createHash('sha512').update(bytes).digest('hex');
    const shasum = createHash('sha1').update(bytes).digest('hex');
    const integrity = `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;
    const sourceUrl = 'https://registry.npmjs.org/flatdemo/-/flatdemo-1.2.3.tgz';
    const manifest = {
      name: 'original-web',
      version: '1.0.0',
      packageManager: 'npm@12.2.1',
      description: 'original project metadata',
      dependencies: { flatdemo: '1.2.3' },
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const lock = {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: manifest.name, version: manifest.version, dependencies: { flatdemo: '1.2.3' } },
        'node_modules/flatdemo': { version: '1.2.3', resolved: sourceUrl, integrity },
      },
    };
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    const project = parseNpmLock(lock, {
      projectId: 'original-web',
      packageManagerPin: 'npm@12.2.1',
      lockfilePath: 'package-lock.json',
      targetIds: [target.id],
      snapshot: { manifest: manifestText, lockfile: lockText, workspaceFiles: [] },
    });
    let inventory = mergeProject(createEmptyInventory(), project);
    inventory = recordVerifiedArtifact(inventory, {
      name: 'flatdemo',
      version: '1.2.3',
      packument: { name: 'flatdemo', 'dist-tags': { latest: '1.2.3' } },
      metadata: {
        name: 'flatdemo',
        version: '1.2.3',
        dist: { tarball: sourceUrl, integrity, shasum },
      },
      artifact: { sha512, integrity, shasum, sourceUrl, legacySha1Only: false },
    });
    const stateDirectory = join(directory, 'state');
    const objectDirectory = join(stateDirectory, 'objects', 'sha512');
    mkdirSync(objectDirectory, { recursive: true });
    writeFileSync(join(objectDirectory, `${sha512}.tgz`), bytes);
    yield* saveInventory(stateDirectory, inventory);
    const testConfig = structuredClone(config);
    testConfig.targets.find(item => item.id === target.id).node = process.versions.node;
    return { stateDirectory, config: testConfig, bytes, lock, lockText, manifestText, target };
  });
}

function savedPnpmWorkspace(directory) {
  return Effect.gen(function*() {
    const target = currentTarget();
    const bytes = readFileSync(new URL('./fixtures/tarballs/flatdemo-1.2.3.tgz', import.meta.url));
    const sha512 = createHash('sha512').update(bytes).digest('hex');
    const shasum = createHash('sha1').update(bytes).digest('hex');
    const integrity = `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;
    const sourceUrl = 'https://registry.npmjs.org/flatdemo/-/flatdemo-1.2.3.tgz';
    const manifestText = `${JSON.stringify({
      name: 'original-workspace',
      version: '1.0.0',
      private: true,
      packageManager: 'pnpm@12.15.0',
    }, null, 2)}\n`;
    const appManifest = `${JSON.stringify({
      name: 'workspace-app',
      version: '1.0.0',
      private: true,
      dependencies: { flatdemo: '1.2.3' },
    }, null, 2)}\n`;
    const workspaceManifest = 'packages:\n  - apps/*\n';
    const lockText = `---
lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.15.0
        version: 12.15.0
packages: {}
snapshots: {}
---
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .: {}
  apps/web:
    dependencies:
      flatdemo:
        specifier: 1.2.3
        version: 1.2.3
packages:
  flatdemo@1.2.3:
    resolution:
      integrity: ${integrity}
snapshots:
  flatdemo@1.2.3: {}
`;
    const project = yield* parsePnpmLock(lockText, {
      projectId: 'original-workspace',
      packageManagerPin: 'pnpm@12.15.0',
      lockfilePath: 'pnpm-lock.yaml',
      targetIds: [target.id],
      snapshot: {
        manifest: manifestText,
        lockfile: lockText,
        workspaceFiles: [
          { path: 'apps/web/package.json', contents: appManifest },
          { path: 'pnpm-workspace.yaml', contents: workspaceManifest },
        ],
      },
    });
    let inventory = mergeProject(createEmptyInventory(), project);
    inventory = recordVerifiedArtifact(inventory, {
      name: 'flatdemo',
      version: '1.2.3',
      packument: { name: 'flatdemo', 'dist-tags': { latest: '1.2.3' } },
      metadata: { name: 'flatdemo', version: '1.2.3', dist: { tarball: sourceUrl, integrity, shasum } },
      artifact: { sha512, integrity, shasum, sourceUrl, legacySha1Only: false },
    });
    const stateDirectory = join(directory, 'state');
    const objectDirectory = join(stateDirectory, 'objects', 'sha512');
    mkdirSync(objectDirectory, { recursive: true });
    writeFileSync(join(objectDirectory, `${sha512}.tgz`), bytes);
    yield* saveInventory(stateDirectory, inventory);
    const testConfig = structuredClone(config);
    testConfig.targets.find(item => item.id === target.id).node = process.versions.node;
    return { stateDirectory, config: testConfig, target };
  });
}

function fakeNpm(restore, afterInstall = () => Effect.void) {
  return (command, args, options) => Effect.gen(function*() {
    if (args[0] === '--version') return { stdout: '12.2.1\n', stderr: '' };
    assert.equal(command, 'npm');
    assert.equal(args[0], 'ci');
    assert.equal(args.includes('--allow-remote=all'), false);
    const manifest = readFileSync(join(options.cwd, 'package.json'), 'utf8');
    assert.equal(manifest, restore.manifestText);
    const lockText = readFileSync(join(options.cwd, 'package-lock.json'), 'utf8');
    const lock = JSON.parse(lockText);
    const resolved = lock.packages['node_modules/flatdemo'].resolved;
    assert.match(resolved, /^http:\/\/127\.0\.0\.1:\d+\/(?:mirror\/)?current\/tarballs\/[a-f0-9]{128}\.tgz$/);
    assert.deepEqual(lock.packages[''].dependencies, { flatdemo: '1.2.3' });
    const metadataResponse = yield* Effect.tryPromise(() => fetch(`${options.env.npm_config_registry}flatdemo`));
    assert.equal(metadataResponse.status, 200);
    const metadata = yield* Effect.tryPromise(() => metadataResponse.json());
    assert.equal(resolved, metadata.versions['1.2.3'].dist.tarball);
    const tarballResponse = yield* Effect.tryPromise(() => fetch(resolved));
    assert.equal(tarballResponse.status, 200);
    const tarball = yield* Effect.tryPromise(() => tarballResponse.arrayBuffer());
    assert.deepEqual(Buffer.from(tarball), restore.bytes);
    yield* afterInstall(lock, options.cwd);
    return { stdout: '', stderr: '' };
  });
}

it.effect('validate fails before package acquisition when the pinned Node or package-manager toolchain differs', () => withScratch('validate-version-', directory => Effect.gen(function*() {
  const target = currentTarget();
  const lock = JSON.parse(readFileSync(new URL('./fixtures/locks/package-lock-add.json', import.meta.url), 'utf8'));
  const project = parseNpmLock(lock, {
    projectId: 'validation',
    lockfilePath: 'validation/package-lock.json',
    targetIds: [target.id],
  });
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, mergeProject(createEmptyInventory(), project));

  if (process.version !== `v${target.node}`) {
    yield* assertFailure(
      validateInventory({ client: 'npm', stateDirectory, config }),
      error => error.category === 'operation' && error.message.includes(`requires Node.js ${target.node}`),
    );
  } else {
    const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim();
    if (npmVersion !== managerVersions.npm) {
      yield* assertFailure(
        validateInventory({ client: 'npm', stateDirectory, config }),
        error => error.category === 'operation' && error.message.includes(`npm ${managerVersions.npm} is required`),
      );
    } else {
      yield* assertFailure(
        validateInventory({ client: 'npm', stateDirectory, config }),
        error => /requires an imported package.json snapshot/.test(error.message),
      );
    }
  }
})));

it.effect('validate restores the original npm manifest and lock graph through local tarballs', () => withScratch('validate-restore-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  const result = yield* validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
    runProcess: fakeNpm(restore),
  });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 1);
  assert.ok(result.requestCount >= 4);
})));

it.effect.skipIf(process.version !== 'v24.22.0' || spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.2.1')('validate restores the original npm project with the pinned client and local tarballs', () => withScratch('validate-npm-client-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  const result = yield* validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 1);
  assert.ok(result.requestCount >= 2);
})));

it.effect.skipIf(process.version !== 'v24.22.0' || spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.15.0')('validate restores a pnpm workspace and frozen lock graph through local tarballs', () => withScratch('validate-pnpm-workspace-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmWorkspace(directory);
  const result = yield* validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 1);
  assert.equal(result.rootCount, 1);
  assert.ok(result.requestCount >= 2);
})));

it.effect('validate rejects an npm client that changes the saved dependency graph', () => withScratch('validate-graph-change-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  yield* assertFailure(
    validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: fakeNpm(restore, (lock, projectDirectory) => Effect.sync(() => {
        lock.packages['node_modules/flatdemo'].version = '9.9.9';
        writeFileSync(join(projectDirectory, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
      })),
    }),
    error => error.category === 'conflict' && error.message.includes('changed the saved dependency graph'),
  );
})));

it.effect('validate refuses to rebuild a project when its imported manifest snapshot is missing', () => withScratch('validate-missing-snapshot-', directory => Effect.gen(function*() {
  const target = currentTarget();
  const lock = JSON.parse(readFileSync(new URL('./fixtures/locks/package-lock-add.json', import.meta.url), 'utf8'));
  const project = parseNpmLock(lock, {
    projectId: 'missing-manifest',
    lockfilePath: 'package-lock.json',
    targetIds: [target.id],
  });
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, mergeProject(createEmptyInventory(), project));
  const testConfig = structuredClone(config);
  testConfig.targets.find(item => item.id === target.id).node = process.versions.node;

  yield* assertFailure(
    validateInventory({ client: 'npm', stateDirectory, config: testConfig }, {
      runProcess: () => Effect.succeed({ stdout: '12.2.1\n', stderr: '' }),
    }),
    error => error.category === 'input' && error.message.includes('requires an imported package.json snapshot'),
  );
})));

it.effect('validate rejects an imported project pinned to another package-manager version', () => withScratch('validate-manager-pin-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  const inventoryPath = join(restore.stateDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  inventory.projects[0].packageManagerPin = 'npm@10.9.2';
  inventory.projects[0].snapshot.manifest = inventory.projects[0].snapshot.manifest.replace('npm@12.2.1', 'npm@10.9.2');
  yield* saveInventory(restore.stateDirectory, inventory);
  const commands = [];

  yield* assertFailure(
    validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: (command, args) => Effect.sync(() => {
        commands.push([command, args[0]]);
        return { stdout: '12.2.1\n', stderr: '' };
      }),
    }),
    error => error.category === 'input' && error.message.includes('validation requires npm@12.2.1'),
  );
  assert.deepEqual(commands, [['npm', '--version']]);
})));

it.effect('validate rejects a saved lockfile that diverges from its imported package records', () => withScratch('validate-tampered-snapshot-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  const inventoryPath = join(restore.stateDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const savedLock = JSON.parse(inventory.projects[0].snapshot.lockfile);
  savedLock.packages[''].dependencies.flatdemo = '9.9.9';
  inventory.projects[0].snapshot.lockfile = `${JSON.stringify(savedLock, null, 2)}\n`;
  yield* saveInventory(restore.stateDirectory, inventory);

  yield* assertFailure(
    validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: () => Effect.succeed({ stdout: '12.2.1\n', stderr: '' }),
    }),
    error => error.category === 'corrupt' && error.message.includes('no longer matches imported project'),
  );
})));
