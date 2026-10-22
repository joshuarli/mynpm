import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, relative, resolve } from 'node:path';
import { once } from 'node:events';
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import type * as Scope from 'effect/Scope';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.ts';
import { MynpmError } from '../src/errors.ts';
import { createEmptyInventory, mergeProject, recordVerifiedArtifact } from '../src/inventory.ts';
import type { ArtifactRecord, ArtifactVerification, Inventory, PackumentMetadata } from '../src/inventory.ts';
import { parseNpmLock } from '../src/lock-npm.ts';
import { publishSite } from '../src/publish.ts';
import { renderPackumentFiles } from '../src/packument.ts';
import type { PackumentFile } from '../src/packument.ts';
import { saveInventory } from '../src/inventory-store.ts';
import { runProcess } from '../src/process.ts';
import { withScratch } from './support.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workDirectory = join(repositoryRoot, '.work');
const scratchRoot = join(workDirectory, 'tmp');
const config = parseConfig(readFileSync(new URL('./fixtures/mynpm.json', import.meta.url), 'utf8'));
type TestPackage = {
  name: string;
  version: string;
  bytes: Buffer;
  metadata: { name: string; version: string; dependencies: Record<string, string>; dist: { tarball: string; integrity: string; shasum: string } };
  packument: PackumentMetadata;
  artifact: ArtifactVerification;
};
type PackageTarOptions = { name: string; version: string; main?: string; dependencies?: Record<string, string>; source?: string };
type PublishOptions = Parameters<typeof publishSite>[0];
type StaticSite = { server: Server; requests: string[]; port: number };

function tarMember(name: string, content: Buffer): Buffer {
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

function packageTar({ name, version, main = 'index.js', dependencies = {}, source = 'module.exports = true;\n' }: PackageTarOptions): Buffer {
  const manifest = Buffer.from(JSON.stringify({ name, version, main, dependencies, license: 'MIT' }));
  return gzipSync(Buffer.concat([
    tarMember('package/package.json', manifest),
    tarMember('package/index.js', Buffer.from(source)),
    Buffer.alloc(1024),
  ]));
}

function makePackage(name: string, version: string, options: { bytes?: Buffer; dependencies?: Record<string, string>; source?: string } = {}): TestPackage {
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

function makeInventory(packages: TestPackage[], projectId = 'app'): Inventory {
  const lockPackages: Record<string, unknown> = { '': { dependencies: Object.fromEntries(packages.map(pkg => [pkg.name, pkg.version])) } };
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

function saveState(stateDirectory: string, packages: TestPackage[], projectId = 'app'): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
    yield* saveInventory(stateDirectory, makeInventory(packages, projectId));
    for (const pkg of packages) {
      const objectDirectory = join(stateDirectory, 'objects', 'sha512');
      mkdirSync(objectDirectory, { recursive: true });
      writeFileSync(join(objectDirectory, `${pkg.artifact.sha512}.tgz`), pkg.bytes);
    }
  });
}

function promiseEffect<A>(operation: () => PromiseLike<A>): Effect.Effect<A, MynpmError> {
  return Effect.tryPromise({ try: operation, catch: cause => new MynpmError('operation', 'test operation failed', { cause }) });
}

function assertEffectRejects(effect: Effect.Effect<unknown, unknown>, expected: RegExp): Effect.Effect<void> {
  return Effect.gen(function*() {
    const outcome = yield* Effect.result(effect);
    assert.equal(outcome._tag, 'Failure');
    if (outcome._tag === 'Failure') {
      assert.ok(outcome.failure instanceof Error);
      assert.match(outcome.failure.message, expected);
    }
  });
}

function assertFailureCategory(effect: Effect.Effect<unknown, unknown>, category: string): Effect.Effect<void> {
  return Effect.gen(function*() {
    const outcome = yield* Effect.result(effect);
    assert.equal(outcome._tag, 'Failure');
    if (outcome._tag === 'Failure') {
      assert.ok(outcome.failure instanceof MynpmError);
      assert.equal(outcome.failure.category, category);
    }
  });
}

function publishOptions(_directory: string, stateDirectory: string, siteDirectory: string, overrides: Partial<PublishOptions> = {}): PublishOptions {
  return {
    stateDirectory,
    siteDirectory,
    config,
    ...overrides,
  };
}

function currentTarget(siteDirectory: string): string {
  return readlinkSync(join(siteDirectory, 'mirror', 'current'));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalValue(record[key])]));
}

function generationId(publicBaseUrl: string, artifacts: ArtifactRecord[], packuments: PackumentFile[], rendererVersion: number): string {
  const payload = {
    schemaVersion: 1,
    rendererVersion,
    publicBaseUrl,
    artifacts: artifacts.map(record => ({ name: record.name, version: record.version, sha512: record.artifact.sha512 })),
    packuments: packuments.map(file => ({ path: file.path, contents: file.bytes.toString('utf8') })),
  };
  return createHash('sha256').update(`${JSON.stringify(canonicalValue(payload), null, 2)}\n`).digest('hex');
}

it.effect('publish creates complete immutable generations, retains old versions, and no-ops unchanged', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const first = makePackage('flatdemo', '1.2.3');
  const second = makePackage('@scope/demo', '2.3.4');
  yield* saveState(stateDirectory, [first]);

  const published = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  const firstTarget = currentTarget(siteDirectory);
  assert.equal(firstTarget, `generations/${published.generationId}`);
  assert.equal(published.packageCount, 1);
  assert.equal(published.versionCount, 1);
  assert.equal(lstatSync(join(siteDirectory, 'mirror', firstTarget)).isDirectory(), true);
  assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'tarballs', `${first.artifact.sha512}.tgz`)), first.bytes);
  assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'current', 'tarballs', `${first.artifact.sha512}.tgz`)), first.bytes);
  assert.equal(statSync(join(siteDirectory, 'mirror', 'current', 'tarballs', `${first.artifact.sha512}.tgz`)).ino, statSync(join(siteDirectory, 'mirror', 'tarballs', `${first.artifact.sha512}.tgz`)).ino);
  assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'current', '-', 'tarballs', `${first.artifact.sha512}.tgz`)), first.bytes);
  assert.equal(statSync(join(siteDirectory, 'mirror', 'current', '-', 'tarballs', `${first.artifact.sha512}.tgz`)).ino, statSync(join(siteDirectory, 'mirror', 'tarballs', `${first.artifact.sha512}.tgz`)).ino);

  const noOp = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  assert.equal(noOp.noOp, true);
  assert.equal(currentTarget(siteDirectory), firstTarget);

  yield* saveState(stateDirectory, [second], 'web');
  const expanded = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  assert.equal(expanded.noOp, false);
  assert.equal(expanded.packageCount, 2);
  assert.equal(expanded.versionCount, 2);
  assert.notEqual(currentTarget(siteDirectory), firstTarget);
  assert.equal(existsSync(join(siteDirectory, 'mirror', firstTarget, 'manifest.json')), true);
  assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'tarballs', `${first.artifact.sha512}.tgz`)), first.bytes);
  assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'current', 'tarballs', `${first.artifact.sha512}.tgz`)), first.bytes);
  assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'current', '-', 'tarballs', `${first.artifact.sha512}.tgz`)), first.bytes);
  const scoped = JSON.parse(readFileSync(join(siteDirectory, 'mirror', 'current', '@scope', 'demo'), 'utf8'));
  assert.equal(scoped.versions['2.3.4'].dist.tarball, `https://deps.example.net/mirror/current/-/tarballs/${second.artifact.sha512}.tgz`);
  const repeated = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  assert.equal(repeated.noOp, true);
  assert.equal(repeated.generationId, expanded.generationId);
})));

it.effect('publish upgrades renderer-version-1 generations without losing their readable layout', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const pkg = makePackage('flatdemo', '1.2.3');
  yield* saveState(stateDirectory, [pkg]);
  yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));

  const publicBaseUrl = config.publicBaseUrl;
  const artifacts = makeInventory([pkg]).artifacts;
  const packuments = renderPackumentFiles(artifacts, publicBaseUrl, { renderer: 1 });
  const oldGenerationId = generationId(publicBaseUrl, artifacts, packuments, 1);
  const oldGenerationDirectory = join(siteDirectory, 'mirror', 'generations', oldGenerationId);
  mkdirSync(oldGenerationDirectory, { recursive: true });
  for (const file of packuments) writeFileSync(join(oldGenerationDirectory, file.path), file.bytes);
  writeFileSync(join(oldGenerationDirectory, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    rendererVersion: 1,
    publicBaseUrl,
    generationId: oldGenerationId,
    artifacts,
  }, null, 2)}\n`);
  unlinkSync(join(siteDirectory, 'mirror', 'current'));
  symlinkSync(`generations/${oldGenerationId}`, join(siteDirectory, 'mirror', 'current'));

  const upgraded = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  assert.equal(upgraded.noOp, false);
  assert.equal(JSON.parse(readFileSync(join(siteDirectory, 'mirror', 'current', 'manifest.json'), 'utf8')).rendererVersion, 3);
  assert.equal(existsSync(oldGenerationDirectory), true);
  const currentPackument = JSON.parse(readFileSync(join(siteDirectory, 'mirror', 'current', 'flatdemo'), 'utf8'));
  assert.equal(currentPackument.versions['1.2.3'].dist.tarball, `https://deps.example.net/mirror/current/-/tarballs/${pkg.artifact.sha512}.tgz`);
})));

it.effect('publish reads and migrates renderer-version-2 generations', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const pkg = makePackage('flatdemo', '1.2.3');
  yield* saveState(stateDirectory, [pkg]);
  yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));

  const publicBaseUrl = config.publicBaseUrl;
  const artifacts = makeInventory([pkg]).artifacts;
  const packuments = renderPackumentFiles(artifacts, publicBaseUrl, { renderer: 2 });
  const oldGenerationId = generationId(publicBaseUrl, artifacts, packuments, 2);
  const oldGenerationDirectory = join(siteDirectory, 'mirror', 'generations', oldGenerationId);
  mkdirSync(join(oldGenerationDirectory, 'tarballs'), { recursive: true });
  for (const file of packuments) writeFileSync(join(oldGenerationDirectory, file.path), file.bytes);
  writeFileSync(join(oldGenerationDirectory, 'tarballs', `${pkg.artifact.sha512}.tgz`), pkg.bytes);
  writeFileSync(join(oldGenerationDirectory, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    rendererVersion: 2,
    publicBaseUrl,
    generationId: oldGenerationId,
    artifacts,
  }, null, 2)}\n`);
  unlinkSync(join(siteDirectory, 'mirror', 'current'));
  symlinkSync(`generations/${oldGenerationId}`, join(siteDirectory, 'mirror', 'current'));

  const upgraded = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  assert.equal(upgraded.noOp, false);
  assert.equal(JSON.parse(readFileSync(join(siteDirectory, 'mirror', 'current', 'manifest.json'), 'utf8')).rendererVersion, 3);
  assert.equal(existsSync(oldGenerationDirectory), true);
  const currentPackument = JSON.parse(readFileSync(join(siteDirectory, 'mirror', 'current', 'flatdemo'), 'utf8'));
  assert.equal(currentPackument.versions['1.2.3'].dist.tarball, `https://deps.example.net/mirror/current/-/tarballs/${pkg.artifact.sha512}.tgz`);
})));

it.effect('publish rejects extra files in a generation', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const pkg = makePackage('flatdemo', '1.2.3');
  yield* saveState(stateDirectory, [pkg]);
  yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  const unexpectedFile = join(siteDirectory, 'mirror', 'current', 'unexpected.txt');
  writeFileSync(unexpectedFile, 'extra');

  yield* assertFailureCategory(publishSite(publishOptions(directory, stateDirectory, siteDirectory)), 'corrupt');
  assert.equal(readFileSync(unexpectedFile, 'utf8'), 'extra');
})));

it.effect('publish never replaces a competing shared tarball and categorizes digest mismatch as corrupt', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const pkg = makePackage('flatdemo', '1.2.3');
  yield* saveState(stateDirectory, [pkg]);
  const sharedTarball = join(siteDirectory, 'mirror', 'tarballs', `${pkg.artifact.sha512}.tgz`);
  const competingBytes = Buffer.from('competing writer bytes');
  let raceCreated = false;

  yield* assertFailureCategory(publishSite(publishOptions(directory, stateDirectory, siteDirectory), {
    link: async (source, destination) => {
      if (!raceCreated && destination === sharedTarball) {
        raceCreated = true;
        writeFileSync(destination, competingBytes, { flag: 'wx' });
      }
      const { link } = await import('node:fs/promises');
      return link(source, destination);
    },
  }), 'corrupt');

  assert.equal(raceCreated, true);
  assert.deepEqual(readFileSync(sharedTarball), competingBytes);
  assert.equal(existsSync(join(siteDirectory, 'mirror', 'current')), false);
})));

it.effect('publish keeps the current generation active until shared tarballs are linked', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const original = makePackage('flatdemo', '1.2.3');
  const addition = makePackage('next-package', '1.0.0');
  yield* saveState(stateDirectory, [original]);
  yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  const originalTarget = currentTarget(siteDirectory);
  yield* saveState(stateDirectory, [addition], 'next');

  let markTarball = () => {};
  let releaseTarball = () => {};
  const tarballReached = new Promise<void>(resolve => { markTarball = resolve; });
  const tarballBarrier = new Promise<void>(resolve => { releaseTarball = resolve; });
  try {
    const publish = yield* Effect.forkChild(publishSite(publishOptions(directory, stateDirectory, siteDirectory), {
      link: async (source, destination) => {
        if (destination === join(siteDirectory, 'mirror', 'tarballs', `${addition.artifact.sha512}.tgz`)) {
          markTarball();
          await tarballBarrier;
        }
        const { link } = await import('node:fs/promises');
        return link(source, destination);
      },
    }));
    yield* promiseEffect(() => tarballReached);
    assert.equal(currentTarget(siteDirectory), originalTarget);
    assert.equal(existsSync(join(siteDirectory, 'mirror', 'current', 'next-package')), false);
    releaseTarball();
    yield* Fiber.join(publish);
    assert.notEqual(currentTarget(siteDirectory), originalTarget);
    assert.deepEqual(readFileSync(join(siteDirectory, 'mirror', 'current', '-', 'tarballs', `${addition.artifact.sha512}.tgz`)), addition.bytes);
  } finally {
    releaseTarball?.();
  }
})));

it.effect('publish rejects symbolic-link destination components', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  yield* saveState(stateDirectory, []);

  const destination = join(directory, 'destination');
  const alias = join(directory, 'alias');
  mkdirSync(destination);
  symlinkSync(destination, alias);
  yield* assertEffectRejects(
    publishSite(publishOptions(directory, stateDirectory, join(alias, 'site'))),
    /real directory/,
  );
  assert.deepEqual(readdirSync(destination), []);
})));

it.effect('publish leaves current unchanged after validation, rename, and durability failures', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const original = makePackage('flatdemo', '1.2.3');
  const addition = makePackage('next-package', '1.0.0');
  yield* saveState(stateDirectory, [original]);
  yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
  const originalTarget = currentTarget(siteDirectory);

  yield* saveState(stateDirectory, [addition], 'next');
  const badObject = join(stateDirectory, 'objects', 'sha512', `${addition.artifact.sha512}.tgz`);
  writeFileSync(badObject, Buffer.from('corrupt'));
  yield* assertEffectRejects(publishSite(publishOptions(directory, stateDirectory, siteDirectory)), /SHA-512/);
  assert.equal(currentTarget(siteDirectory), originalTarget);
  writeFileSync(badObject, addition.bytes);

  const currentPath = join(siteDirectory, 'mirror', 'current');
  let failedGenerationSync = false;
  const generationsDirectory = join(siteDirectory, 'mirror', 'generations');
  yield* assertEffectRejects(
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

  yield* assertEffectRejects(
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
  yield* assertEffectRejects(
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
})));

it.effect('concurrent publishers read inventory only after acquiring the publication lock', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const first = makePackage('flatdemo', '1.2.3');
  const second = makePackage('other-package', '1.0.0');
  yield* saveState(stateDirectory, [first]);
  let markRead = () => {};
  let releaseRead = () => {};
  const readReached = new Promise<void>(resolve => { markRead = resolve; });
  const readBarrier = new Promise<void>(resolve => { releaseRead = resolve; });
  try {
    const firstPublish = yield* Effect.forkChild(publishSite(publishOptions(directory, stateDirectory, siteDirectory), {
      afterInventoryRead: async () => {
        markRead();
        await readBarrier;
      },
    }));
    yield* promiseEffect(() => readReached);
    yield* saveState(stateDirectory, [second], 'next');
    const conflict = yield* Effect.result(publishSite(publishOptions(directory, stateDirectory, siteDirectory)));
    assert.equal(conflict._tag, 'Failure');
    if (conflict._tag === 'Failure') assert.equal(conflict.failure.category, 'conflict');
    releaseRead();
    yield* Fiber.join(firstPublish);
    const retry = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory));
    assert.equal(retry.packageCount, 2);
    const manifest = JSON.parse(readFileSync(join(siteDirectory, 'mirror', 'current', 'manifest.json'), 'utf8')) as { artifacts: Array<{ name: string; version: string }> };
    assert.deepEqual(manifest.artifacts.map(item => `${item.name}@${item.version}`), ['flatdemo@1.2.3', 'other-package@1.0.0']);
  } finally {
    releaseRead?.();
  }
})));

function startStaticServer(siteDirectory: string): Effect.Effect<StaticSite, MynpmError> {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
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
      const isMetadata = pathname.includes('/current/') && !pathname.includes('/tarballs/');
      response.writeHead(200, {
        'Content-Type': isMetadata ? 'application/json' : 'application/octet-stream',
        'Cache-Control': isMetadata ? 'no-cache' : 'public, max-age=31536000, immutable',
      }).end(bytes);
    } catch (cause) {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
      response.writeHead(code === 'ENOENT' ? 404 : 500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  return promiseEffect(() => once(server, 'listening')).pipe(Effect.map(() => {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    return { server, requests, port: address.port };
  }));
}

function withStaticServer<A, E>(siteDirectory: string, use: (staticSite: StaticSite) => Effect.Effect<A, E, Scope.Scope>): Effect.Effect<A, E | MynpmError, Scope.Scope> {
  return Effect.acquireUseRelease(
    startStaticServer(siteDirectory),
    use,
    ({ server }) => promiseEffect(() => new Promise<void>((resolveServer, rejectServer) => {
      server.closeAllConnections?.();
      server.close(error => error ? rejectServer(error) : resolveServer());
    })),
  );
}

function requestJson(url: string | URL): Effect.Effect<unknown, MynpmError> {
  return Effect.gen(function*() {
    const response = yield* promiseEffect(() => fetch(url));
    assert.equal(response.status, 200);
    const contentType = response.headers.get('content-type');
    assert.ok(contentType);
    assert.match(contentType, /^application\/json/);
    return yield* promiseEffect(() => response.json());
  });
}

function installWithPnpm(projectDirectory: string, registry: string, workspace: string, env: NodeJS.ProcessEnv): Effect.Effect<void, MynpmError> {
  return Effect.gen(function*() {
  const manifest = {
    name: 'consumer-pnpm',
    version: '1.0.0',
    private: true,
    packageManager: 'pnpm@12.15.0',
    dependencies: { '@flatrepo/demo': '2.3.4' },
  };
  writeFileSync(join(projectDirectory, 'package.json'), `${JSON.stringify(manifest)}\n`);
  const lockStore = join(workspace, 'lock-store');
  yield* runProcess('pnpm', ['install', '--lockfile-only', `--registry=${registry}`, `--store-dir=${lockStore}`, '--ignore-scripts'], {
    cwd: projectDirectory,
    env: { ...env, pnpm_config_store_dir: lockStore },
    timeoutMs: 240_000,
  });
  const frozenStore = join(workspace, 'frozen-store');
  yield* runProcess('pnpm', ['install', '--frozen-lockfile', `--registry=${registry}`, `--store-dir=${frozenStore}`, '--ignore-scripts'], {
    cwd: projectDirectory,
    env: { ...env, pnpm_config_store_dir: frozenStore },
    timeoutMs: 240_000,
  });
  yield* runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: projectDirectory,
    env,
    timeoutMs: 30_000,
  });
  const lock = readFileSync(join(projectDirectory, 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(lock, /registry\.npmjs\.org/);
  });
}

it.effect('published root and /mirror/ static URLs serve installable packages and immutable old tarballs', () => withScratch(directory => Effect.gen(function*() {
  const stateDirectory = join(directory, 'state');
  const siteDirectory = join(directory, 'site');
  const flatdemo = makePackage('flatdemo', '1.2.3', { source: "module.exports = 'static registry works';\n" });
  const scoped = makePackage('@flatrepo/demo', '2.3.4', {
    dependencies: { flatdemo: '1.2.3' },
    source: "module.exports = require('flatdemo') + ' (via @flatrepo/demo)';\n",
  });
  yield* saveState(stateDirectory, [flatdemo, scoped]);
  yield* withStaticServer(siteDirectory, staticSite => Effect.gen(function*() {
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
    pnpm_config_pm_on_fail: 'ignore',
  };
  const npmVersion = yield* runProcess('npm', ['--version'], { cwd: directory, env, timeoutMs: 30_000 });
  const prefixPublish = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory), { renderBaseUrl: serverBase });
  assert.equal(prefixPublish.packageCount, 2);
  const oldPackumentUrl = `${serverBase}current/flatdemo`;
  const oldPackument = (yield* requestJson(oldPackumentUrl)) as { versions: Record<string, { dist: { tarball: string } }> };
  yield* requestJson(`${serverBase}current/@flatrepo%2fdemo`);
  const uppercaseScopedRoute = yield* promiseEffect(() => fetch(`${serverBase}current/@flatrepo%2Fdemo`));
  assert.equal(uppercaseScopedRoute.status, 200);
  const scopedContentType = uppercaseScopedRoute.headers.get('content-type');
  assert.ok(scopedContentType);
  assert.match(scopedContentType, /^application\/json/);
  yield* promiseEffect(() => uppercaseScopedRoute.arrayBuffer());
  const missingPackage = yield* promiseEffect(() => fetch(`${serverBase}current/missing-package`));
  assert.equal(missingPackage.status, 404);
  yield* promiseEffect(() => missingPackage.arrayBuffer());
  const oldTarballUrl = oldPackument.versions['1.2.3'].dist.tarball;

  const prefixProject = join(directory, 'prefix-project');
  mkdirSync(prefixProject);
  writeFileSync(join(prefixProject, 'package.json'), '{"name":"consumer-prefix","version":"1.0.0","private":true}\n');
  const prefixCache = join(directory, 'prefix-cache');
  yield* runProcess('npm', ['install', '@flatrepo/demo@2.3.4', `--registry=${serverBase}current/`, `--cache=${prefixCache}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], {
    cwd: prefixProject,
    env: { ...env, npm_config_cache: prefixCache },
    timeoutMs: 240_000,
  });
  const prefixResult = yield* runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: prefixProject,
    env,
    timeoutMs: 30_000,
  });
  assert.equal(prefixResult.stderr, '');
  const pnpmVersionResult = yield* Effect.result(runProcess('pnpm', ['--version'], { cwd: directory, env, timeoutMs: 30_000 }));
  const pnpmVersion = pnpmVersionResult._tag === 'Success' ? pnpmVersionResult.success.stdout.trim().split(/\s+/)[0] : 'unavailable';
  if (process.version === 'v26.12.0' && pnpmVersion === '12.15.0') {
    const prefixPnpmProject = join(directory, 'prefix-pnpm-project');
    mkdirSync(prefixPnpmProject);
    yield* installWithPnpm(prefixPnpmProject, `${serverBase}current/`, join(directory, 'prefix-pnpm'), env);
  } else if (process.env.MYNPM_REQUIRE_STATIC_CLIENTS === '1') {
    assert.fail(`Node 26.12.0 and pnpm 12.15.0 are required; found Node ${process.version}, pnpm ${pnpmVersion}`);
  } else {
    console.info(`pnpm 12.15.0 proof skipped; found Node ${process.version}, pnpm ${pnpmVersion}`);
  }

  const rootBase = `${serverUrl}/`;
  const rootPublish = yield* publishSite(publishOptions(directory, stateDirectory, siteDirectory), { renderBaseUrl: rootBase });
  assert.notEqual(rootPublish.generationId, prefixPublish.generationId);
  const oldTarballResponse = yield* promiseEffect(() => fetch(oldTarballUrl));
  assert.equal(oldTarballResponse.status, 200);
  assert.deepEqual(Buffer.from(yield* promiseEffect(() => oldTarballResponse.arrayBuffer())), flatdemo.bytes);
  const oldTarballHeader = oldTarballResponse.headers.get('content-type');
  assert.ok(oldTarballHeader);
  assert.match(oldTarballHeader, /application\/octet-stream/);

  const rootProject = join(directory, 'root-project');
  mkdirSync(rootProject);
  writeFileSync(join(rootProject, 'package.json'), '{"name":"consumer-root","version":"1.0.0","private":true}\n');
  const rootCache = join(directory, 'root-cache');
  yield* runProcess('npm', ['install', '@flatrepo/demo@2.3.4', `--registry=${rootBase}current/`, `--cache=${rootCache}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], {
    cwd: rootProject,
    env: { ...env, npm_config_cache: rootCache },
    timeoutMs: 240_000,
  });
  yield* runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: rootProject,
    env,
    timeoutMs: 30_000,
  });
  if (process.version === 'v26.12.0' && pnpmVersion === '12.15.0') {
    const rootPnpmProject = join(directory, 'root-pnpm-project');
    mkdirSync(rootPnpmProject);
    yield* installWithPnpm(rootPnpmProject, `${rootBase}current/`, join(directory, 'root-pnpm'), env);
  } else if (process.env.MYNPM_REQUIRE_STATIC_CLIENTS === '1') {
    assert.fail(`Node 26.12.0 and pnpm 12.15.0 are required; found Node ${process.version}, pnpm ${pnpmVersion}`);
  }
  yield* runProcess('npm', ['ci', `--registry=${rootBase}current/`, `--cache=${join(directory, 'root-ci-cache')}`, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], {
    cwd: rootProject,
    env: { ...env, npm_config_cache: join(directory, 'root-ci-cache') },
    timeoutMs: 240_000,
  });
  yield* runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: rootProject,
    env,
    timeoutMs: 30_000,
  });

  const strictProject = join(directory, 'strict-project');
  mkdirSync(strictProject);
  writeFileSync(join(strictProject, 'package.json'), '{"name":"consumer-strict","version":"1.0.0","private":true}\n');
  const strictCache = join(directory, 'strict-cache');
  yield* runProcess('npm', ['install', '@flatrepo/demo@2.3.4', `--registry=${rootBase}current/`, `--cache=${strictCache}`, '--allow-remote=none', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], {
    cwd: strictProject,
    env: { ...env, npm_config_cache: strictCache },
    timeoutMs: 240_000,
  });
  yield* runProcess('npm', ['ci', `--registry=${rootBase}current/`, `--cache=${join(directory, 'strict-ci-cache')}`, '--allow-remote=none', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'], {
    cwd: strictProject,
    env: { ...env, npm_config_cache: join(directory, 'strict-ci-cache') },
    timeoutMs: 240_000,
  });
  yield* runProcess(process.execPath, ['-e', "if (require('@flatrepo/demo') !== 'static registry works (via @flatrepo/demo)') process.exit(1)"], {
    cwd: strictProject,
    env,
    timeoutMs: 30_000,
  });

  const lock = JSON.parse(readFileSync(join(rootProject, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/flatdemo'].resolved, `${rootBase}current/-/tarballs/${flatdemo.artifact.sha512}.tgz`);
  assert.equal(lock.packages['node_modules/@flatrepo/demo'].resolved, `${rootBase}current/-/tarballs/${scoped.artifact.sha512}.tgz`);
  assert.equal(staticSite.requests.some(path => path === '/mirror/current/@flatrepo/demo'), true);
  assert.equal(staticSite.requests.some(path => path === '/current/@flatrepo/demo'), true);
  assert.equal(staticSite.requests.every(path => path.startsWith('/mirror/current/') || path.startsWith('/mirror/tarballs/') || path.startsWith('/current/') || path.startsWith('/tarballs/')), true);
  assert.match(npmVersion.stdout.trim(), /^\d+\.\d+\.\d+/);
  }));
})), 240_000);
