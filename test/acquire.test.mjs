import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.ts';
import { createEmptyInventory, mergeProject } from '../src/inventory.ts';
import { parseNpmLock } from '../src/lock-npm.ts';
import { loadInventory, saveInventory } from '../src/inventory-store.ts';
import { fetchInventory, verifyInventory } from '../src/acquire.ts';
import { limits } from '../src/limits.ts';

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

function withScratch(run) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      mkdirSync(scratchRoot, { recursive: true });
      return mkdtempSync(join(scratchRoot, 'acquire-'));
    }),
    run,
    directory => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
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

it.effect('fetch verifies, stores and records one artifact; repeated fetch reuses it and verify detects corruption', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg]));
  const dependencies = dependenciesFor([pkg]);
  yield* fetchInventory({ stateDirectory, config }, dependencies);

  const inventory = yield* loadInventory(stateDirectory);
  const record = inventory.artifacts[0];
  const objectPath = join(stateDirectory, 'objects', 'sha512', `${record.artifact.sha512}.tgz`);
  assert.deepEqual(readFileSync(objectPath), bytes);
  assert.equal(record.metadata.name, 'flatdemo');
  assert.deepEqual(record.metadata.dependencies, { nested: '^1.0.0' });
  assert.deepEqual(record.metadata.engines, { node: '>=22' });
  assert.deepEqual(record.packument['dist-tags'], { latest: '1.2.3' });
  assert.equal(record.artifact.sha512, createHash('sha512').update(bytes).digest('hex'));
  assert.equal((yield* verifyInventory({ stateDirectory, config })).verifiedCount, 1);

  const inventoryBytes = readFileSync(join(stateDirectory, 'inventory.json'));
  yield* fetchInventory({ stateDirectory, config }, {
    exchange: async () => { throw new Error('matching fetch made a request'); },
    resolveAddresses: async () => { throw new Error('matching fetch resolved DNS'); },
  });
  assert.equal((yield* verifyInventory({ stateDirectory, config })).verifiedCount, 1);
  assert.deepEqual(readFileSync(join(stateDirectory, 'inventory.json')), inventoryBytes);
  unlinkSync(objectPath);
  const retryUrls = [];
  const recovered = yield* fetchInventory({ stateDirectory, config }, {
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
  const corruptFailure = yield* Effect.flip(verifyInventory({ stateDirectory, config }));
  assert.match(corruptFailure.message, /SHA-512/);
  unlinkSync(objectPath);
  const outside = join(directory, 'outside.tgz');
  writeFileSync(outside, bytes);
  symlinkSync(outside, objectPath);
  const symlinkFailure = yield* Effect.flip(verifyInventory({ stateDirectory, config }));
  assert.match(symlinkFailure.message, /regular file/);
})));

it.effect('fetch rejects corrupt bytes and a tarball whose package manifest has another identity', () => withScratch(directory => Effect.gen(function*() {
  const expected = packageTar('flatdemo', '1.2.3');
  const wrongIdentity = packageTar('other', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes: expected };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, expected);
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg], { integrity: false }));
  const corrupt = dependenciesFor([{ ...pkg, bytes: Buffer.from('corrupt') }]);

  const corruptFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, corrupt));
  assert.match(corruptFailure.message, /integrity/);
  assert.equal(existsSync(join(stateDirectory, 'objects')), false);
  const afterCorrupt = yield* loadInventory(stateDirectory);
  assert.equal(afterCorrupt.artifacts.length, 0);

  const mismatched = dependenciesFor([{ ...pkg, bytes: wrongIdentity, metadata: packageMetadata(pkg.name, pkg.version, wrongIdentity) }]);
  const identityFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, mismatched));
  assert.match(identityFailure.message, /identity mismatch/);
  assert.equal((yield* loadInventory(stateDirectory)).artifacts.length, 0);
})));

it.effect('SHA-1-only artifacts require the explicit legacy policy and never reach storage on rejection', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('legacy', '1.0.0');
  const pkg = { name: 'legacy', version: '1.0.0', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes, { sha512: false });
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg], { integrity: false }));
  const dependencies = dependenciesFor([pkg]);

  const legacyFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, dependencies));
  assert.match(legacyFailure.message, /SHA-1-only/);
  assert.equal((yield* loadInventory(stateDirectory)).artifacts.length, 0);
  const legacyConfig = structuredClone(config);
  legacyConfig.policy.allowLegacySha1Only = true;
  yield* fetchInventory({ stateDirectory, config: legacyConfig }, dependencies);
  const record = (yield* loadInventory(stateDirectory)).artifacts[0];
  assert.equal(record.artifact.legacySha1Only, true);
  assert.equal((yield* verifyInventory({ stateDirectory, config: legacyConfig })).verifiedCount, 1);
})));

it.effect('fetch does not invent historical SHA-1 metadata when upstream supplies none', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('no-sha1', '1.0.0');
  const pkg = { name: 'no-sha1', version: '1.0.0', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes, { shasum: false });
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg]));

  yield* fetchInventory({ stateDirectory, config }, dependenciesFor([pkg]));
  const record = (yield* loadInventory(stateDirectory)).artifacts[0];
  assert.equal(record.artifact.shasum, null);
  assert.equal((yield* verifyInventory({ stateDirectory, config })).verifiedCount, 1);
})));

it.effect('fetch requests scoped metadata with an encoded slash', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('@scope/demo', '1.0.0');
  const pkg = { name: '@scope/demo', version: '1.0.0', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg]));
  const urls = [];
  const dependencies = dependenciesFor([pkg], {
    exchange: async (url, options) => {
      urls.push(url.href);
      return dependenciesFor([pkg]).exchange(url, options);
    },
  });

  yield* fetchInventory({ stateDirectory, config }, dependencies);
  assert.match(urls[0], /@scope%2fdemo$/);
  assert.equal((yield* verifyInventory({ stateDirectory, config })).verifiedCount, 1);
})));

it.effect('fetch rejects unsafe redirects and oversized response declarations before writing objects', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg]));
  const redirects = dependenciesFor([pkg], {
    exchange: async url => url.pathname.endsWith('.tgz')
      ? response(302, '', { location: 'https://registry-user:sensitive-secret@127.0.0.1/private.tgz?token=sensitive-token' })
      : response(200, JSON.stringify({ name: 'flatdemo', versions: { '1.2.3': pkg.metadata } })),
  });
  const redirectFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, redirects));
  assert.match(redirectFailure.message, /allowlisted HTTPS registry/);
  assert.doesNotMatch(redirectFailure.message, /sensitive-secret|sensitive-token/);
  assert.equal(existsSync(join(stateDirectory, 'objects')), false);

  let redirectCount = 0;
  const tooManyRedirects = dependenciesFor([pkg], {
    exchange: async url => {
      if (!url.pathname.endsWith('.tgz')) return response(200, JSON.stringify({ name: 'flatdemo', versions: { '1.2.3': pkg.metadata } }));
      redirectCount += 1;
      return response(302, '', { location: `https://registry.npmjs.org/redirect-${redirectCount}.tgz` });
    },
  });
  const redirectLimitFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, tooManyRedirects));
  assert.match(redirectLimitFailure.message, /5 redirect limit/);
  assert.equal(redirectCount, 6);

  const privateResolution = dependenciesFor([pkg], { resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }] });
  const privateAddressFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, privateResolution));
  assert.match(privateAddressFailure.message, /non-public address/);

  const oversized = dependenciesFor([pkg], {
    exchange: async url => url.pathname.endsWith('.tgz')
      ? response(200, '', { 'content-length': String(1024 ** 3 + 1) })
      : response(200, JSON.stringify({ name: 'flatdemo', versions: { '1.2.3': pkg.metadata } })),
  });
  const oversizedFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, oversized));
  assert.match(oversizedFailure.message, /1 GiB/);
  assert.equal((yield* loadInventory(stateDirectory)).artifacts.length, 0);

  const oversizedMetadata = dependenciesFor([pkg], {
    exchange: async _url => response(200, '{}', { 'content-length': String(64 * 1024 ** 2 + 1) }),
  });
  const oversizedMetadataFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, oversizedMetadata));
  assert.match(oversizedMetadataFailure.message, /64 MiB/);
  assert.equal((yield* loadInventory(stateDirectory)).artifacts.length, 0);
})));

it.effect('fetch enforces the metadata limit while streaming when Content-Length is absent', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg]));
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

  const oversizedFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, oversized));
  assert.match(oversizedFailure.message, /64 MiB/);
  assert.equal((yield* loadInventory(stateDirectory)).artifacts.length, 0);
  assert.equal(existsSync(join(stateDirectory, 'objects')), false);
})));

it.effect('fetch stops aborted streams and removes private staging files', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg]));
  const bodyStarted = yield* Deferred.make();
  const dependencies = dependenciesFor([pkg], {
    exchange: async (url, { signal }) => {
      if (!url.pathname.endsWith('.tgz')) return response(200, JSON.stringify({ name: 'flatdemo', versions: { '1.2.3': pkg.metadata } }));
      return {
        statusCode: 200,
        headers: { 'content-length': String(bytes.length) },
        body: Readable.from((async function* () {
          Effect.runSync(Deferred.succeed(bodyStarted, undefined));
          yield bytes.subarray(0, 4);
          await new Promise((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        })()),
        close() {},
      };
    },
  });
  const fetching = yield* Effect.forkChild(fetchInventory({ stateDirectory, config }, dependencies));
  yield* Deferred.await(bodyStarted);
  yield* Fiber.interrupt(fetching);
  const exit = yield* Fiber.await(fetching);
  assert.equal(exit._tag, 'Failure');
  assert.deepEqual(readdirSync(join(stateDirectory, 'tmp')), []);
  assert.equal(existsSync(join(stateDirectory, 'objects')), false);
})));

it.effect('fetch removes interrupted staging from a dead fetch process before acquiring artifacts', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  const stagingRoot = join(stateDirectory, 'tmp');
  const interrupted = join(stagingRoot, 'mynpm-fetch-2147483647-interrupted');
  mkdirSync(interrupted, { recursive: true });
  writeFileSync(join(interrupted, 'partial.part'), Buffer.from('unverified'));
  yield* saveInventory(stateDirectory, makeInventory([pkg]));

  yield* fetchInventory({ stateDirectory, config }, dependenciesFor([pkg]));
  assert.deepEqual(readdirSync(stagingRoot), []);
  assert.equal((yield* verifyInventory({ stateDirectory, config })).verifiedCount, 1);
})));

it.effect('fetch enforces per-request and whole-operation timeouts through controlled timers', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory([pkg]));
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
  const requestTimeout = yield* Effect.flip(fetchInventory({ stateDirectory, config }, waitingRequest));
  assert.equal(requestTimeout.category, 'operation');
  assert.match(requestTimeout.message, /10 minutes/);

  const fetchTimeout = yield* Effect.flip(fetchInventory({ stateDirectory, config }, {
    ...dependenciesFor([pkg]),
    ...controlled(limits.fetchMilliseconds),
  }));
  assert.equal(fetchTimeout.category, 'operation');
  assert.match(fetchTimeout.message, /1 hour/);
  assert.equal((yield* loadInventory(stateDirectory)).artifacts.length, 0);
})));

it.effect('fetch rejects symbolic-link staging and object-store directories without writing through them', () => withScratch(directory => Effect.gen(function*() {
  const bytes = packageTar('flatdemo', '1.2.3');
  const pkg = { name: 'flatdemo', version: '1.2.3', bytes };
  pkg.metadata = packageMetadata(pkg.name, pkg.version, bytes);
  const stateDirectory = join(directory, 'state');
  const outside = join(directory, 'outside');
  mkdirSync(stateDirectory);
  mkdirSync(outside);
  yield* saveInventory(stateDirectory, makeInventory([pkg]));
  symlinkSync(outside, join(stateDirectory, 'tmp'));

  const stagingFailure = yield* Effect.flip(fetchInventory({ stateDirectory, config }, dependenciesFor([pkg])));
  assert.match(stagingFailure.message, /managed directory is not a real directory/);
  assert.deepEqual(readdirSync(outside), []);

  const objectState = join(directory, 'object-state');
  const objectOutside = join(directory, 'object-outside');
  mkdirSync(objectState);
  mkdirSync(objectOutside);
  yield* saveInventory(objectState, makeInventory([pkg]));
  symlinkSync(objectOutside, join(objectState, 'objects'));
  const objectFailure = yield* Effect.flip(fetchInventory({ stateDirectory: objectState, config }, dependenciesFor([pkg])));
  assert.match(objectFailure.message, /object store directory is not a real directory/);
  assert.deepEqual(readdirSync(objectOutside), []);
})));

it.effect('fetch caps active acquisition at four concurrent packages', () => withScratch(directory => Effect.gen(function*() {
  const packages = Array.from({ length: 5 }, (_, index) => {
    const name = `package-${index}`;
    const version = '1.0.0';
    const bytes = packageTar(name, version);
    return { name, version, bytes, metadata: packageMetadata(name, version, bytes) };
  });
  const stateDirectory = join(directory, 'state');
  yield* saveInventory(stateDirectory, makeInventory(packages));
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
      const close = result.close?.bind(result);
      result.close = () => { active -= 1; close?.(); };
      return result;
    },
  };
  const fetching = yield* Effect.forkChild(fetchInventory({ stateDirectory, config }, dependencies));
  yield* Effect.tryPromise(() => firstBatch);
  assert.equal(peak, 4);
  releaseBatch();
  yield* Fiber.join(fetching);
  assert.equal(peak, 4);
  assert.equal((yield* verifyInventory({ stateDirectory, config })).verifiedCount, 5);
})));
