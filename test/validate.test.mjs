import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.mjs';
import { createEmptyInventory, mergeProject, recordVerifiedArtifact } from '../src/inventory.mjs';
import { parseNpmLock } from '../src/lock-npm.mjs';
import { saveInventory } from '../src/inventory-store.mjs';
import { managerVersions } from '../src/resolve.mjs';
import { validateInventory } from '../src/validate.mjs';

const scratchRoot = fileURLToPath(new URL('../.work/tmp/', import.meta.url));
const config = parseConfig(readFileSync(new URL('./fixtures/mynpm.json', import.meta.url), 'utf8'));

function currentTarget() {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = process.arch === 'arm64' ? 'arm64' : 'x64';
  const libc = os === 'linux' ? process.report?.getReport()?.header?.glibcVersionRuntime ? 'glibc' : 'musl' : null;
  return config.targets.find(target => target.os === os && target.cpu === cpu && (target.libc ?? null) === libc);
}

test('validate fails before package acquisition when the pinned Node or package-manager toolchain differs', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'validate-version-'));
  try {
    const target = currentTarget();
    const lock = JSON.parse(readFileSync(new URL('./fixtures/locks/package-lock-add.json', import.meta.url), 'utf8'));
    const project = parseNpmLock(lock, {
      projectId: 'validation',
      lockfilePath: 'validation/package-lock.json',
      targetIds: [target.id],
    });
    const stateDirectory = join(directory, 'state');
    await saveInventory(stateDirectory, mergeProject(createEmptyInventory(), project));

    if (process.version !== `v${target.node}`) {
      await assert.rejects(
        validateInventory({ client: 'npm', stateDirectory, config }),
        error => error.category === 'operation' && error.message.includes(`requires Node.js ${target.node}`),
      );
    } else {
      const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim();
      if (npmVersion !== managerVersions.npm) {
        await assert.rejects(
          validateInventory({ client: 'npm', stateDirectory, config }),
          error => error.category === 'operation' && error.message.includes(`npm ${managerVersions.npm} is required`),
        );
      } else {
        await assert.rejects(validateInventory({ client: 'npm', stateDirectory, config }), /no verified artifact/);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function savedNpmProject(directory) {
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
  await saveInventory(stateDirectory, inventory);
  const testConfig = structuredClone(config);
  testConfig.targets.find(item => item.id === target.id).node = process.versions.node;
  return { stateDirectory, config: testConfig, bytes, lock, lockText, manifestText, target };
}

function fakeNpm(restore, afterInstall = async () => {}) {
  return async (command, args, options) => {
    if (args[0] === '--version') return { stdout: '12.2.1\n', stderr: '' };
    assert.equal(command, 'npm');
    assert.equal(args[0], 'ci');
    const manifest = readFileSync(join(options.cwd, 'package.json'), 'utf8');
    assert.equal(manifest, restore.manifestText);
    const lockText = readFileSync(join(options.cwd, 'package-lock.json'), 'utf8');
    const lock = JSON.parse(lockText);
    const resolved = lock.packages['node_modules/flatdemo'].resolved;
    assert.match(resolved, /^http:\/\/127\.0\.0\.1:\d+\/(?:mirror\/)?tarballs\/[a-f0-9]{128}\.tgz$/);
    assert.deepEqual(lock.packages[''].dependencies, { flatdemo: '1.2.3' });
    const metadataResponse = await fetch(`${options.env.npm_config_registry}flatdemo`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(resolved, metadata.versions['1.2.3'].dist.tarball);
    const tarballResponse = await fetch(resolved);
    assert.equal(tarballResponse.status, 200);
    assert.deepEqual(Buffer.from(await tarballResponse.arrayBuffer()), restore.bytes);
    await afterInstall(lock, options.cwd);
    return { stdout: '', stderr: '' };
  };
}

test('validate restores the original npm manifest and lock graph through local tarballs', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'validate-restore-'));
  try {
    const restore = await savedNpmProject(directory);
    const result = await validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: fakeNpm(restore),
    });
    assert.equal(result.projectCount, 1);
    assert.equal(result.packageCount, 1);
    assert.ok(result.requestCount >= 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validate rejects an npm client that changes the saved dependency graph', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'validate-graph-change-'));
  try {
    const restore = await savedNpmProject(directory);
    await assert.rejects(
      validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
        runProcess: fakeNpm(restore, async (lock, projectDirectory) => {
          lock.packages['node_modules/flatdemo'].version = '9.9.9';
          writeFileSync(join(projectDirectory, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
        }),
      }),
      error => error.category === 'conflict' && error.message.includes('changed the saved dependency graph'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validate refuses to rebuild a project when its imported manifest snapshot is missing', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'validate-missing-snapshot-'));
  try {
    const target = currentTarget();
    const lock = JSON.parse(readFileSync(new URL('./fixtures/locks/package-lock-add.json', import.meta.url), 'utf8'));
    const project = parseNpmLock(lock, {
      projectId: 'missing-manifest',
      lockfilePath: 'package-lock.json',
      targetIds: [target.id],
    });
    const stateDirectory = join(directory, 'state');
    await saveInventory(stateDirectory, mergeProject(createEmptyInventory(), project));
    const testConfig = structuredClone(config);
    testConfig.targets.find(item => item.id === target.id).node = process.versions.node;

    await assert.rejects(
      validateInventory({ client: 'npm', stateDirectory, config: testConfig }, {
        runProcess: async () => ({ stdout: '12.2.1\n', stderr: '' }),
      }),
      error => error.category === 'input' && error.message.includes('requires an imported package.json snapshot'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validate rejects a saved lockfile that diverges from its imported package records', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'validate-tampered-snapshot-'));
  try {
    const restore = await savedNpmProject(directory);
    const inventoryPath = join(restore.stateDirectory, 'inventory.json');
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    const savedLock = JSON.parse(inventory.projects[0].snapshot.lockfile);
    savedLock.packages[''].dependencies.flatdemo = '9.9.9';
    inventory.projects[0].snapshot.lockfile = `${JSON.stringify(savedLock, null, 2)}\n`;
    await saveInventory(restore.stateDirectory, inventory);

    await assert.rejects(
      validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
        runProcess: async () => ({ stdout: '12.2.1\n', stderr: '' }),
      }),
      error => error.category === 'corrupt' && error.message.includes('no longer matches imported project'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
