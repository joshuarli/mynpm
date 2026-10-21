import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.mjs';
import { createEmptyInventory, mergeProject } from '../src/inventory.mjs';
import { parseNpmLock } from '../src/lock-npm.mjs';
import { loadInventory, saveInventory } from '../src/inventory-store.mjs';
import { fetchInventory, verifyInventory } from '../src/acquire.mjs';
import { limits } from '../src/limits.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = join(repositoryRoot, '.work', 'tmp');
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

function packageTar(name, version) {
  const manifest = Buffer.from(JSON.stringify({ name, version, main: 'index.js' }));
  const source = Buffer.from('module.exports = true;\n');
  return gzipSync(Buffer.concat([
    tarMember('package/package.json', manifest),
    tarMember('package/index.js', source),
    Buffer.alloc(1024),
  ]));
}

function packageMetadata(name, version, bytes, { sha512 = true, shasum = true, tarballUrl } = {}) {
  return {
    name,
    version,
    dependencies: { nested: '^1.0.0' },
    engines: { node: '>=22' },
    dist: {
      tarball: tarballUrl ?? `https://registry.npmjs.org/${name.startsWith('@') ? `${name.slice(0, name.indexOf('/'))}%2f${name.slice(name.indexOf('/') + 1)}` : name}/-/${name.split('/').at(-1)}-${version}.tgz`,
      ...(sha512 ? { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } : {}),
      ...(shasum ? { shasum: createHash('sha1').update(bytes).digest('hex') } : {}),
    },
  };
}

function makeInventory(packages, { integrity = true } = {}) {
  return packages.reduce((inventory, { name, version, bytes }, index) => {
    const lock = {
      name: `project-${index}`,
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { [name]: version } },
        [`node_modules/${name}`]: {
          version,
          resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
          ...(integrity ? { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } : {}),
        },
      },
    };
    return mergeProject(inventory, parseNpmLock(lock, {
      projectId: `project-${index}`,
      lockfilePath: `project-${index}/package-lock.json`,
      targetIds: ['linux-x64-gnu'],
    }));
  }, createEmptyInventory());
}

function response(statusCode, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { statusCode, headers: { 'content-length': String(bytes.length), ...headers }, body: Readable.from([bytes]), close() {} };
}

async function withScratch(run) {
  const directory = mkdtempSync(join(scratchRoot, 'acquire-'));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function dependenciesFor(packages, overrides = {}) {
  const metadata = new Map(packages.map(pkg => [new URL(pkg.name.startsWith('@') ? `${pkg.name.slice(0, pkg.name.indexOf('/'))}%2f${pkg.name.slice(pkg.name.indexOf('/') + 1)}` : pkg.name, config.upstreamRegistry).href, pkg.metadata]));
  const artifacts = new Map(packages.map(pkg => [pkg.metadata.dist.tarball, pkg.bytes]));
  return {
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    exchange: async url => {
      if (metadata.has(url.href)) {
        const version = metadata.get(url.href).version;
        return response(200, JSON.stringify({
          name: metadata.get(url.href).name,
          'dist-tags': { latest: version },
          time: { [version]: '2026-01-01T00:00:00.000Z' },
          versions: { [version]: metadata.get(url.href) },
        }));
      }
      const artifact = artifacts.get(url.href);
      if (!artifact) return response(404, 'missing');
      return response(200, artifact);
    },
    ...overrides,
  };
}

test('fetch verifies, stores and records one artifact; repeated fetch reuses it and verify detects corruption', async () => withScratch(async directory => {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg]));
  const dependencies = dependenciesFor([pkg]);
  await fetchInventory({ stateDirectory, config }, dependencies);

  const inventory = await loadInventory(stateDirectory);
  const record = inventory.artifacts[0];
  const objectPath = join(stateDirectory, 'objects', 'sha512', `${record.artifact.sha512}.tgz`);
  assert.deepEqual(readFileSync(objectPath), bytes);
  assert.equal(record.metadata.name, 'flatdemo');
  assert.deepEqual(record.metadata.dependencies, { nested: '^1.0.0' });
  assert.deepEqual(record.metadata.engines, { node: '>=22' });
  assert.deepEqual(record.packument['dist-tags'], { latest: '1.2.3' });
  assert.equal(record.artifact.sha512, createHash('sha512').update(bytes).digest('hex'));
  assert.equal((await verifyInventory({ stateDirectory, config })).verifiedCount, 1);

  const inventoryBytes = readFileSync(join(stateDirectory, 'inventory.json'));
  await fetchInventory({ stateDirectory, config }, {
    exchange: async () => { throw new Error('matching fetch made a request'); },
    resolveAddresses: async () => { throw new Error('matching fetch resolved DNS'); },
  });
  assert.equal((await verifyInventory({ stateDirectory, config })).verifiedCount, 1);
  assert.deepEqual(readFileSync(join(stateDirectory, 'inventory.json')), inventoryBytes);
  unlinkSync(objectPath);
  const retryUrls = [];
  const recovered = await fetchInventory({ stateDirectory, config }, {
    ...dependencies,
    exchange: async (url, options) => {
      retryUrls.push(url.href);
      return dependencies.exchange(url, options);
    },
  });
  assert.equal(recovered.reusedCount, 0);
  assert.deepEqual(retryUrls, [record.metadata.dist.tarball]);
  assert.deepEqual(readFileSync(objectPath), bytes);
  writeFileSync(objectPath, Buffer.from('corrupt'));
  await assert.rejects(verifyInventory({ stateDirectory, config }), /SHA-512/);
  unlinkSync(objectPath);
  const outside = join(directory, 'outside.tgz');
  writeFileSync(outside, bytes);
  symlinkSync(outside, objectPath);
  await assert.rejects(verifyInventory({ stateDirectory, config }), /regular file/);
}));

test('fetch rejects corrupt bytes and a tarball whose package manifest has another identity', async () => withScratch(async directory => {
  const expected = packageTar('flatdemo', '1.2.3');
  const wrongIdentity = packageTar('other', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes: expected };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, expected);
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg], { integrity: false }));
  const corrupt = dependenciesFor([{ ...pkg, bytes: Buffer.from('corrupt') }]);

  await assert.rejects(fetchInventory({ stateDirectory, config }, corrupt), /integrity/);
  assert.equal(existsSync(join(stateDirectory, 'objects')), false);
  const afterCorrupt = await loadInventory(stateDirectory);
  assert.equal(afterCorrupt.artifacts.length, 0);

  const mismatched = dependenciesFor([{ ...pkg, bytes: wrongIdentity, metadata: packageMetadata(pkg.name, pkg.version, wrongIdentity) }]);
  await assert.rejects(fetchInventory({ stateDirectory, config }, mismatched), /identity mismatch/);
  assert.equal((await loadInventory(stateDirectory)).artifacts.length, 0);
}));

test('SHA-1-only artifacts require the explicit legacy policy and never reach storage on rejection', async () => withScratch(async directory => {
  const bytes = packageTar('legacy', '1.0.0');
  const pkg = { name: 'legacy', version: '1.0.0', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes, { sha512: false });
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg], { integrity: false }));
  const dependencies = dependenciesFor([pkg]);

  await assert.rejects(fetchInventory({ stateDirectory, config }, dependencies), /SHA-1-only/);
  assert.equal((await loadInventory(stateDirectory)).artifacts.length, 0);
  const legacyConfig = structuredClone(config);
  legacyConfig.policy.allowLegacySha1Only = true;
  await fetchInventory({ stateDirectory, config: legacyConfig }, dependencies);
  const record = (await loadInventory(stateDirectory)).artifacts[0];
  assert.equal(record.artifact.legacySha1Only, true);
  assert.equal((await verifyInventory({ stateDirectory, config: legacyConfig })).verifiedCount, 1);
}));

test('fetch does not invent historical SHA-1 metadata when upstream supplies none', async () => withScratch(async directory => {
  const bytes = packageTar('no-sha1', '1.0.0');
  const pkg = { name: 'no-sha1', version: '1.0.0', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes, { shasum: false });
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg]));

  await fetchInventory({ stateDirectory, config }, dependenciesFor([pkg]));
  const record = (await loadInventory(stateDirectory)).artifacts[0];
  assert.equal(record.artifact.shasum, null);
  assert.equal((await verifyInventory({ stateDirectory, config })).verifiedCount, 1);
}));

test('fetch requests scoped metadata with an encoded slash', async () => withScratch(async directory => {
  const bytes = packageTar('@scope/demo', '1.0.0');
  const pkg = { name: '@scope/demo', version: '1.0.0', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg]));
  const urls = [];
  const dependencies = dependenciesFor([pkg], {
    exchange: async (url, options) => {
      urls.push(url.href);
      return dependenciesFor([pkg]).exchange(url, options);
    },
  });

  await fetchInventory({ stateDirectory, config }, dependencies);
  assert.match(urls[0], /@scope%2fdemo$/);
  assert.equal((await verifyInventory({ stateDirectory, config })).verifiedCount, 1);
}));

test('fetch rejects unsafe redirects and oversized response declarations before writing objects', async () => withScratch(async directory => {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg]));
  const redirects = dependenciesFor([pkg], {
    exchange: async url => url.pathname.endsWith('.tgz')
      ? response(302, '', { location: 'https://registry-user:sensitive-secret@127.0.0.1/private.tgz?token=sensitive-token' })
      : response(200, JSON.stringify({ name: 'flatdemo', versions: { '1.2.3': pkg.metadata } })),
  });
  await assert.rejects(fetchInventory({ stateDirectory, config }, redirects), error => {
    assert.match(error.message, /allowlisted HTTPS registry/);
    assert.doesNotMatch(error.message, /sensitive-secret|sensitive-token/);
    return true;
  });
  assert.equal(existsSync(join(stateDirectory, 'objects')), false);

  let redirectCount = 0;
  const tooManyRedirects = dependenciesFor([pkg], {
    exchange: async url => {
      if (!url.pathname.endsWith('.tgz')) return response(200, JSON.stringify({ name: 'flatdemo', versions: { '1.2.3': pkg.metadata } }));
      redirectCount += 1;
      return response(302, '', { location: `https://registry.npmjs.org/redirect-${redirectCount}.tgz` });
    },
  });
  await assert.rejects(fetchInventory({ stateDirectory, config }, tooManyRedirects), /5 redirect limit/);
  assert.equal(redirectCount, 6);

  const privateResolution = dependenciesFor([pkg], { resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(fetchInventory({ stateDirectory, config }, privateResolution), /non-public address/);

  const oversized = dependenciesFor([pkg], {
    exchange: async url => url.pathname.endsWith('.tgz')
      ? response(200, '', { 'content-length': String(1024 ** 3 + 1) })
      : response(200, JSON.stringify({ name: 'flatdemo', versions: { '1.2.3': pkg.metadata } })),
  });
  await assert.rejects(fetchInventory({ stateDirectory, config }, oversized), /1 GiB/);
  assert.equal((await loadInventory(stateDirectory)).artifacts.length, 0);

  const oversizedMetadata = dependenciesFor([pkg], {
    exchange: async url => response(200, '{}', { 'content-length': String(64 * 1024 ** 2 + 1) }),
  });
  await assert.rejects(fetchInventory({ stateDirectory, config }, oversizedMetadata), /64 MiB/);
  assert.equal((await loadInventory(stateDirectory)).artifacts.length, 0);
}));

test('fetch enforces the metadata limit while streaming when Content-Length is absent', async () => withScratch(async directory => {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg]));
  const chunk = Buffer.alloc(1024 ** 2);
  const oversized = dependenciesFor([pkg], {
    exchange: async () => ({
      statusCode: 200,
      headers: {},
      body: Readable.from((async function* () {
        for (let index = 0; index < 65; index += 1) yield chunk;
      })()),
      close() {},
    }),
  });

  await assert.rejects(fetchInventory({ stateDirectory, config }, oversized), /64 MiB/);
  assert.equal((await loadInventory(stateDirectory)).artifacts.length, 0);
  assert.equal(existsSync(join(stateDirectory, 'objects')), false);
}));

test('fetch stops aborted streams and removes private staging files', async () => withScratch(async directory => {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg]));
  const controller = new AbortController();
  let started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const dependencies = dependenciesFor([pkg], {
    exchange: async url => {
      if (!url.pathname.endsWith('.tgz')) return response(200, JSON.stringify({ name: 'flatdemo', versions: { '1.2.3': pkg.metadata } }));
      return {
        statusCode: 200,
        headers: { 'content-length': String(bytes.length) },
        body: Readable.from((async function* () {
          started();
          yield bytes.subarray(0, 4);
          await new Promise((resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          });
        })()),
        close() {},
      };
    },
  });
  const fetching = fetchInventory({ stateDirectory, config, signal: controller.signal }, dependencies);
  await bodyStarted;
  controller.abort();
  await assert.rejects(fetching, error => error.category === 'cancelled');
  assert.deepEqual(readdirSync(join(stateDirectory, 'tmp')), []);
  assert.equal(existsSync(join(stateDirectory, 'objects')), false);
}));

test('fetch removes interrupted staging from a dead fetch process before acquiring artifacts', async () => withScratch(async directory => {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  const stagingRoot = join(stateDirectory, 'tmp');
  const interrupted = join(stagingRoot, 'mynpm-fetch-2147483647-interrupted');
  mkdirSync(interrupted, { recursive: true });
  writeFileSync(join(interrupted, 'partial.part'), Buffer.from('unverified'));
  await saveInventory(stateDirectory, makeInventory([pkg]));

  await fetchInventory({ stateDirectory, config }, dependenciesFor([pkg]));
  assert.deepEqual(readdirSync(stagingRoot), []);
  assert.equal((await verifyInventory({ stateDirectory, config })).verifiedCount, 1);
}));

test('fetch enforces per-request and whole-operation timeouts through controlled timers', async () => withScratch(async directory => {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory([pkg]));
  const controlled = firingDelay => ({
    scheduleTimeout(callback, delay) {
      const timer = { cleared: false };
      if (delay === firingDelay) queueMicrotask(() => { if (!timer.cleared) callback(); });
      return timer;
    },
    clearScheduledTimeout(timer) { timer.cleared = true; },
  });
  const waitingRequest = {
    ...dependenciesFor([pkg]),
    ...controlled(limits.requestMilliseconds),
    exchange: async (_url, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };
  await assert.rejects(
    fetchInventory({ stateDirectory, config }, waitingRequest),
    error => error.category === 'operation' && /10 minutes/.test(error.message),
  );

  await assert.rejects(
    fetchInventory({ stateDirectory, config }, {
      ...dependenciesFor([pkg]),
      ...controlled(limits.fetchMilliseconds),
    }),
    error => error.category === 'operation' && /1 hour/.test(error.message),
  );
  assert.equal((await loadInventory(stateDirectory)).artifacts.length, 0);
}));

test('fetch rejects symbolic-link staging and object-store directories without writing through them', async () => withScratch(async directory => {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  const outside = join(directory, 'outside');
  mkdirSync(stateDirectory);
  mkdirSync(outside);
  await saveInventory(stateDirectory, makeInventory([pkg]));
  symlinkSync(outside, join(stateDirectory, 'tmp'));

  await assert.rejects(fetchInventory({ stateDirectory, config }, dependenciesFor([pkg])), /managed directory is not a real directory/);
  assert.deepEqual(readdirSync(outside), []);

  const objectState = join(directory, 'object-state');
  const objectOutside = join(directory, 'object-outside');
  mkdirSync(objectState);
  mkdirSync(objectOutside);
  await saveInventory(objectState, makeInventory([pkg]));
  symlinkSync(objectOutside, join(objectState, 'objects'));
  await assert.rejects(fetchInventory({ stateDirectory: objectState, config }, dependenciesFor([pkg])), /object store directory is not a real directory/);
  assert.deepEqual(readdirSync(objectOutside), []);
}));

test('fetch caps active acquisition at four concurrent packages', async () => withScratch(async directory => {
  const packages = Array.from({ length: 5 }, (_, index) => {
    const name = `package-${index}`;
    const version = '1.0.0';
    const bytes = packageTar(name, version);
    return { name, version, bytes, metadata: packageMetadata(name, version, bytes) };
  });
  const stateDirectory = join(directory, 'state');
  await saveInventory(stateDirectory, makeInventory(packages));
  let active = 0;
  let peak = 0;
  let notifyBatch;
  let releaseBatch;
  const firstBatch = new Promise(resolve => { notifyBatch = resolve; });
  const batchGate = new Promise(resolve => { releaseBatch = resolve; });
  let held = 0;
  const base = dependenciesFor(packages);
  const dependencies = {
    ...base,
    exchange: async url => {
      active += 1;
      peak = Math.max(peak, active);
      held += 1;
      if (held === 4) notifyBatch();
      if (held <= 4) await batchGate;
      const result = await base.exchange(url);
      const close = result.close;
      result.close = () => { active -= 1; close(); };
      return result;
    },
  };
  const fetching = fetchInventory({ stateDirectory, config }, dependencies);
  await firstBatch;
  assert.equal(peak, 4);
  releaseBatch();
  await fetching;
  assert.equal(peak, 4);
  assert.equal((await verifyInventory({ stateDirectory, config })).verifiedCount, 5);
}));
