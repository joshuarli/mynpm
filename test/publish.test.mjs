import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, relative, resolve } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.mjs';
import { createEmptyInventory, mergeProject, recordVerifiedArtifact } from '../src/inventory.mjs';
import { parseNpmLock } from '../src/lock-npm.mjs';
import { publishSite } from '../src/publish.mjs';
import { saveInventory } from '../src/inventory-store.mjs';
import { runProcess } from '../src/process.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workDirectory = join(repositoryRoot, '.work');
const scratchRoot = join(workDirectory, 'tmp');
const config = parseConfig(readFileSync(new URL('./fixtures/mynpm.json', import.meta.url), 'utf8'));

function tarMember(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

function packageTar({ name, version, main = 'index.js', dependencies = {}, source = 'module.exports = true;\n' }) {
  const manifest = Buffer.from(JSON.stringify({ name, version, main, dependencies, license: 'MIT' }));
  return gzipSync(Buffer.concat([
    tarMember('package/package.json', manifest),
    tarMember('package/index.js', Buffer.from(source)),
    Buffer.alloc(1024),
  ]));
}

function makePackage(name, version, options = {}) {
  const bytes = options.bytes ?? packageTar({ name, version, dependencies: options.dependencies, source: options.source });
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  const shasum = createHash('sha1').update(bytes).digest('hex');
  const encodedName = name.startsWith('@') ? `${name.slice(0, name.indexOf('/'))}%2f${name.slice(name.indexOf('/') + 1)}` : name;
  const sourceUrl = `https://registry.npmjs.org/${encodedName}/-/${name.split('/').at(-1)}-${version}.tgz`;
  const metadata = {
    name,
    version,
    dependencies: options.dependencies ?? {},
    dist: {
      tarball: sourceUrl,
      integrity: `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`,
      shasum,
    },
  };
  const packument = {
    name,
    'dist-tags': { latest: version },
    modified: '2026-02-01T00:00:00.000Z',
    time: { created: '2026-01-01T00:00:00.000Z', modified: '2026-02-01T00:00:00.000Z', [version]: '2026-01-15T00:00:00.000Z' },
  };
  return {
    name,
    version,
    bytes,
    metadata,
    packument,
    artifact: {
      sha512,
      integrity: `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`,
      shasum,
      sourceUrl,
      legacySha1Only: false,
    },
  };
}

function makeInventory(packages, projectId = 'app') {
  const lockPackages = { '': { dependencies: Object.fromEntries(packages.map(pkg => [pkg.name, pkg.version])) } };
  for (const pkg of packages) {
    lockPackages[`node_modules/${pkg.name}`] = {
      version: pkg.version,
      resolved: pkg.metadata.dist.tarball,
      integrity: pkg.metadata.dist.integrity,
    };
  }
  const project = parseNpmLock({ lockfileVersion: 3, packages: lockPackages }, {
    projectId,
    lockfilePath: `${projectId}/package-lock.json`,
    targetIds: ['linux-x64-gnu'],
  });
  return packages.reduce((inventory, pkg) => recordVerifiedArtifact(inventory, {
    name: pkg.name,
    version: pkg.version,
    packument: pkg.packument,
    metadata: pkg.metadata,
    artifact: pkg.artifact,
  }), mergeProject(createEmptyInventory(), project));
}

async function saveState(stateDirectory, packages, projectId = 'app') {
  await saveInventory(stateDirectory, makeInventory(packages, projectId));
  for (const pkg of packages) {
    const objectDirectory = join(stateDirectory, 'objects', 'sha512');
    mkdirSync(objectDirectory, { recursive: true });
    writeFileSync(join(objectDirectory, `${pkg.artifact.sha512}.tgz`), pkg.bytes);
  }
}

async function withScratch(run) {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'publish-'));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function publishOptions(directory, stateDirectory, siteDirectory, overrides = {}) {
  return {
    stateDirectory,
    siteDirectory,
    config,
    ...overrides,
  };
}

function currentTarget(siteDirectory) {
  return readlinkSync(join(siteDirectory, 'mirror', 'current'));
}

test('publish creates complete immutable generations, retains old versions, and no-ops unchanged', async () => withScratch(async directory => {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const first = makePackage('flatdemo', '1.2.3');
  const second = makePackage('@scope/demo', '2.3.4');
  await saveState(stateDirectory, [first]);

  const published = await publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  const firstTarget = currentTarget(siteDirectory);
  assert.equal(firstTarget, `generations/${published.generationId}`);
  assert.equal(published.packageCount, 1);
  assert.equal(published.versionCount, 1);
  assert.equal(lstatSync(join(siteDirectory, 'mirror', firstTarget)).isDirectory(), true);
  assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'tarballs', `${first.artifact.sha512}.tgz`)), first.bytes);

  const noOp = await publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  assert.equal(noOp.noOp, true);
  assert.equal(currentTarget(siteDirectory), firstTarget);

  await saveState(stateDirectory, [second], 'web');
  const expanded = await publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  assert.equal(expanded.noOp, false);
  assert.equal(expanded.packageCount, 2);
  assert.equal(expanded.versionCount, 2);
  assert.notEqual(currentTarget(siteDirectory), firstTarget);
  assert.equal(existsSync(join(siteDirectory, 'mirror', firstTarget, 'manifest.json')), true);
  assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'tarballs', `${first.artifact.sha512}.tgz`)), first.bytes);
  const scoped = JSON.parse(readFileSync(join(siteDirectory, 'mirror', 'current', '@scope', 'demo'), 'utf8'));
  assert.equal(scoped.versions['2.3.4'].dist.tarball, `https://deps.example.net/mirror/tarballs/${second.artifact.sha512}.tgz`);
  const repeated = await publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  assert.equal(repeated.noOp, true);
  assert.equal(repeated.generationId, expanded.generationId);
}));

test('publish rejects symbolic-link destination components', async () => withScratch(async directory => {
  const stateDirectory = join(directory, 'state');
  await saveState(stateDirectory, []);

  const destination = join(directory, 'destination');
  const alias = join(directory, 'alias');
  mkdirSync(destination);
  symlinkSync(destination, alias);
  await assert.rejects(
    publishSite(publishOptions(directory, stateDirectory, join(alias, 'site'))),
    /real directory/,
  );
  assert.deepEqual(readdirSync(destination), []);
}));

test('publish leaves current unchanged after validation, rename, and durability failures', async () => withScratch(async directory => {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const original = makePackage('flatdemo', '1.2.3');
  const addition = makePackage('next-package', '1.0.0');
  await saveState(stateDirectory, [original]);
  await publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  const originalTarget = currentTarget(siteDirectory);

  await saveState(stateDirectory, [addition], 'next');
  const badObject = join(stateDirectory, 'objects', 'sha512', `${addition.artifact.sha512}.tgz`);
  writeFileSync(badObject, Buffer.from('corrupt'));
  await assert.rejects(publishSite(publishOptions(directory, stateDirectory, siteDirectory)), /SHA-512/);
  assert.equal(currentTarget(siteDirectory), originalTarget);
  writeFileSync(badObject, addition.bytes);

  const currentPath = join(siteDirectory, 'mirror', 'current');
  let failedGenerationSync = false;
  const generationsDirectory = join(siteDirectory, 'mirror', 'generations');
  await assert.rejects(
    publishSite(publishOptions(directory, stateDirectory, siteDirectory), {
      syncDirectory: async path => {
        if (!failedGenerationSync && path.startsWith(join(generationsDirectory, '.mynpm-generation-'))) {
          failedGenerationSync = true;
          throw Object.assign(new Error('injected generation fsync failure'), { code: 'EIO' });
        }
        const { open } = await import('node:fs/promises');
        const handle = await open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      },
    }),
    /finalize generation/,
  );
  assert.equal(failedGenerationSync, true);
  assert.equal(currentTarget(siteDirectory), originalTarget);

  await assert.rejects(
    publishSite(publishOptions(directory, stateDirectory, siteDirectory), {
      rename: async (from, to) => {
        if (to === currentPath) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
        const { rename } = await import('node:fs/promises');
        return rename(from, to);
      },
    }),
    /atomically switch/,
  );
  assert.equal(currentTarget(siteDirectory), originalTarget);

  let failedCurrentSync = false;
  await assert.rejects(
    publishSite(publishOptions(directory, stateDirectory, siteDirectory), {
      syncDirectory: async path => {
        if (path === join(siteDirectory, 'mirror') && !failedCurrentSync) {
          failedCurrentSync = true;
          throw Object.assign(new Error('injected current fsync failure'), { code: 'EIO' });
        }
        const { open } = await import('node:fs/promises');
        const handle = await open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      },
    }),
    /durably switch/,
  );
  assert.equal(currentTarget(siteDirectory), originalTarget);
}));

test('concurrent publishers read inventory only after acquiring the publication lock', async () => withScratch(async directory => {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const first = makePackage('flatdemo', '1.2.3');
  const second = makePackage('other-package', '1.0.0');
  await saveState(stateDirectory, [first]);
  let markRead;
  let releaseRead;
  const readReached = new Promise(resolve => { markRead = resolve; });
  const readBarrier = new Promise(resolve => { releaseRead = resolve; });
  try {
    const firstPublish = publishSite(publishOptions(directory, stateDirectory, siteDirectory), {
      afterInventoryRead: async () => {
        markRead();
        await readBarrier;
      },
    });
    await readReached;
    await saveState(stateDirectory, [second], 'next');
    await assert.rejects(publishSite(publishOptions(directory, stateDirectory, siteDirectory)), error => error.category === 'conflict');
    releaseRead();
    await firstPublish;
    const retry = await publishSite(publishOptions(directory, stateDirectory, siteDirectory));
    assert.equal(retry.packageCount, 2);
    const manifest = JSON.parse(readFileSync(join(siteDirectory, 'mirror', 'current', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.artifacts.map(item => `${item.name}@${item.version}`), ['flatdemo@1.2.3', 'other-package@1.0.0']);
  } finally {
    releaseRead?.();
  }
}));

async function startStaticServer(siteDirectory) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    requests.push(pathname);
    const prefix = pathname.startsWith('/mirror/') ? '' : pathname.startsWith('/current/') || pathname.startsWith('/tarballs/') ? 'mirror' : null;
    if (prefix === null) {
      response.writeHead(404).end();
      return;
    }
    const sitePath = resolve(siteDirectory, prefix, pathname.replace(/^\//, ''));
    const relativePath = relative(resolve(siteDirectory), sitePath);
    if (relativePath === '..' || relativePath.startsWith('../')) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = readFileSync(sitePath);
      const isMetadata = pathname.includes('/current/');
      response.writeHead(200, {
        'Content-Type': isMetadata ? 'application/json' : 'application/octet-stream',
        'Cache-Control': isMetadata ? 'no-cache' : 'public, max-age=31536000, immutable',
      }).end(bytes);
    } catch (cause) {
      response.writeHead(cause.code === 'ENOENT' ? 404 : 500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { server, requests, port: address.port };
}

async function requestJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  return response.json();
}

async function installWithPnpm(projectDirectory, registry, workspace, env) {
  const manifest = {
    name: 'consumer-pnpm',
    version: '1.0.0',
    private: true,
    packageManager: 'pnpm@12.15.0',
    dependencies: { '@flatrepo/demo': '2.3.4' },
  };
  writeFileSync(join(projectDirectory, 'package.json'), `${JSON.stringify(manifest)}\n`);
  const lockStore = join(workspace, 'lock-store');
  await runProcess('pnpm', ['install', '--lockfile-only', `--registry=${registry}`, `--store-dir=${lockStore}`, '--ignore-scripts'], {
    cwd: projectDirectory,
    env: { ...env, pnpm_config_store_dir: lockStore },
    timeoutMs: 240_000,
  });
  const frozenStore = join(workspace, 'frozen-store');
  await runProcess('pnpm', ['install', '--frozen-lockfile', `--registry=${registry}`, `--store-dir=${frozenStore}`, '--ignore-scripts'], {
    cwd: projectDirectory,
    env: { ...env, pnpm_config_store_dir: frozenStore },
    timeoutMs: 240_000,
  });
  await runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: projectDirectory,
    env,
    timeoutMs: 30_000,
  });
  const lock = readFileSync(join(projectDirectory, 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(lock, /registry\.npmjs\.org/);
}

test('published root and /mirror/ static URLs serve installable packages and immutable old tarballs', { timeout: 240_000 }, async testContext => withScratch(async directory => {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const flatdemo = makePackage('flatdemo', '1.2.3', { source: "module.exports = 'static registry works';\n" });
  const scoped = makePackage('@flatrepo/demo', '2.3.4', {
    dependencies: { flatdemo: '1.2.3' },
    source: "module.exports = require('flatdemo') + ' (via @flatrepo/demo)';\n",
  });
  await saveState(stateDirectory, [flatdemo, scoped]);
  const staticSite = await startStaticServer(siteDirectory);
  testContext.after(async () => {
    staticSite.server.closeAllConnections?.();
    await new Promise((resolveServer, rejectServer) => staticSite.server.close(error => error ? rejectServer(error) : resolveServer()));
  });
  const serverUrl = `http://127.0.0.1:${staticSite.port}`;
  const serverBase = `${serverUrl}/mirror/`;
  const envDirectory = join(directory, 'env');
  mkdirSync(envDirectory);
  const userConfig = join(envDirectory, 'user.npmrc');
  const globalConfig = join(envDirectory, 'global.npmrc');
  const home = join(envDirectory, 'home');
  mkdirSync(home);
  writeFileSync(userConfig, '');
  writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: scratchRoot,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
  };
  const npmVersion = await runProcess('npm', ['--version'], { cwd: directory, env, timeoutMs: 30_000 });
  const prefixPublish = await publishSite(publishOptions(directory, stateDirectory, siteDirectory), { renderBaseUrl: serverBase });
  assert.equal(prefixPublish.packageCount, 2);
  const oldPackumentUrl = `${serverBase}current/flatdemo`;
  const oldPackument = await requestJson(oldPackumentUrl);
  await requestJson(`${serverBase}current/@flatrepo%2fdemo`);
  const uppercaseScopedRoute = await fetch(`${serverBase}current/@flatrepo%2Fdemo`);
  assert.equal(uppercaseScopedRoute.status, 200);
  assert.match(uppercaseScopedRoute.headers.get('content-type'), /^application\/json/);
  await uppercaseScopedRoute.arrayBuffer();
  const missingPackage = await fetch(`${serverBase}current/missing-package`);
  assert.equal(missingPackage.status, 404);
  await missingPackage.arrayBuffer();
  const oldTarballUrl = oldPackument.versions['1.2.3'].dist.tarball;

  const prefixProject = join(directory, 'prefix-project');
  mkdirSync(prefixProject);
  writeFileSync(join(prefixProject, 'package.json'), '{"name":"consumer-prefix","version":"1.0.0","private":true}\n');
  const prefixCache = join(directory, 'prefix-cache');
  await runProcess('npm', ['install', '@flatrepo/demo@2.3.4', `--registry=${serverBase}current/`, `--cache=${prefixCache}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], {
    cwd: prefixProject,
    env: { ...env, npm_config_cache: prefixCache },
    timeoutMs: 240_000,
  });
  const prefixResult = await runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: prefixProject,
    env,
    timeoutMs: 30_000,
  });
  assert.equal(prefixResult.stderr, '');
  const pnpmVersionResult = await runProcess('pnpm', ['--version'], { cwd: directory, env, timeoutMs: 30_000 }).catch(() => null);
  const pnpmVersion = pnpmVersionResult?.stdout.trim().split(/\s+/)[0] ?? 'unavailable';
  if (process.version === 'v24.22.0' && pnpmVersion === '12.15.0') {
    const prefixPnpmProject = join(directory, 'prefix-pnpm-project');
    mkdirSync(prefixPnpmProject);
    await installWithPnpm(prefixPnpmProject, `${serverBase}current/`, join(directory, 'prefix-pnpm'), env);
  } else {
    testContext.diagnostic(`pnpm 12.15.0 proof skipped; found Node ${process.version}, pnpm ${pnpmVersion}`);
  }

  const rootBase = `${serverUrl}/`;
  const rootPublish = await publishSite(publishOptions(directory, stateDirectory, siteDirectory), { renderBaseUrl: rootBase });
  assert.notEqual(rootPublish.generationId, prefixPublish.generationId);
  const oldTarballResponse = await fetch(oldTarballUrl);
  assert.equal(oldTarballResponse.status, 200);
  assert.deepEqual(Buffer.from(await oldTarballResponse.arrayBuffer()), flatdemo.bytes);
  const oldTarballHeader = oldTarballResponse.headers.get('content-type');
  assert.match(oldTarballHeader, /application\/octet-stream/);

  const rootProject = join(directory, 'root-project');
  mkdirSync(rootProject);
  writeFileSync(join(rootProject, 'package.json'), '{"name":"consumer-root","version":"1.0.0","private":true}\n');
  const rootCache = join(directory, 'root-cache');
  await runProcess('npm', ['install', '@flatrepo/demo@2.3.4', `--registry=${rootBase}current/`, `--cache=${rootCache}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], {
    cwd: rootProject,
    env: { ...env, npm_config_cache: rootCache },
    timeoutMs: 240_000,
  });
  await runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: rootProject,
    env,
    timeoutMs: 30_000,
  });
  if (process.version === 'v24.22.0' && pnpmVersion === '12.15.0') {
    const rootPnpmProject = join(directory, 'root-pnpm-project');
    mkdirSync(rootPnpmProject);
    await installWithPnpm(rootPnpmProject, `${rootBase}current/`, join(directory, 'root-pnpm'), env);
  }
  await runProcess('npm', ['ci', `--registry=${rootBase}current/`, `--cache=${join(directory, 'root-ci-cache')}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], {
    cwd: rootProject,
    env: { ...env, npm_config_cache: join(directory, 'root-ci-cache') },
    timeoutMs: 240_000,
  });
  await runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: rootProject,
    env,
    timeoutMs: 30_000,
  });

  const lock = JSON.parse(readFileSync(join(rootProject, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/flatdemo'].resolved, `${rootBase}tarballs/${flatdemo.artifact.sha512}.tgz`);
  assert.equal(lock.packages['node_modules/@flatrepo/demo'].resolved, `${rootBase}tarballs/${scoped.artifact.sha512}.tgz`);
  assert.equal(staticSite.requests.some(path => path === '/mirror/current/@flatrepo/demo'), true);
  assert.equal(staticSite.requests.some(path => path === '/current/@flatrepo/demo'), true);
  assert.equal(staticSite.requests.every(path => path.startsWith('/mirror/current/') || path.startsWith('/mirror/tarballs/') || path.startsWith('/current/') || path.startsWith('/tarballs/')), true);
  assert.match(npmVersion.stdout.trim(), /^\d+\.\d+\.\d+/);
}));
