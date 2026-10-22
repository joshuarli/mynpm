import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { parseConfig } from '../src/config.ts';
import type { MynpmConfig, TargetConfig } from '../src/config.ts';
import { MynpmError } from '../src/errors.ts';
import { createEmptyInventory, mergeProject, parseInventory, recordVerifiedArtifact } from '../src/inventory.ts';
import { parseNpmLock } from '../src/lock-npm.ts';
import { parsePnpmLock } from '../src/lock-pnpm.ts';
import { saveInventory } from '../src/inventory-store.ts';
import { managerVersions } from '../src/resolve.ts';
import { runProcess } from '../src/process.ts';
import type { RunProcessOptions } from '../src/process.ts';
import { validateInventory } from '../src/validate.ts';
import { hasErrorCategory, withScratch } from './support.ts';

const config = parseConfig(readFileSync(new URL('./fixtures/mynpm.json', import.meta.url), 'utf8'));
type MutablePackageEntry = { [key: string]: unknown; version?: string; resolved?: string; integrity?: string; link?: boolean; dependencies?: Record<string, unknown> };
type NpmTestLock = { [key: string]: unknown; lockfileVersion?: number; packages: Record<string, MutablePackageEntry>; dependencies?: Record<string, unknown> };
type SavedNpmProject = {
  stateDirectory: string;
  config: MynpmConfig;
  bytes: Buffer;
  lock: NpmTestLock;
  lockText: string;
  manifestText: string;
  target: TargetConfig;
  optionalSha512: string | null;
  nestedBytes: Buffer | null;
  nestedSha512: string | null;
};
type PostInstallCheck = (lock: NpmTestLock, projectDirectory: string) => Effect.Effect<void, never>;

function currentTarget(): TargetConfig {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = process.arch === 'arm64' ? 'arm64' : 'x64';
  const report = process.report?.getReport() as unknown as { header?: { glibcVersionRuntime?: string } } | undefined;
  const libc = os === 'linux' && report?.header?.glibcVersionRuntime !== undefined ? 'glibc' : 'musl';
  const target = config.targets.find(candidate => candidate.os === os && candidate.cpu === cpu && ('libc' in candidate ? candidate.libc === libc : os === 'darwin'));
  if (target === undefined) throw new Error(`fixture config does not include the current target ${os}-${cpu}`);
  return target;
}

function configForCurrentNode(targetId: string): MynpmConfig {
  return parseConfig(JSON.stringify({
    ...config,
    targets: config.targets.map(target => target.id === targetId ? { ...target, node: process.versions.node } : target),
  }));
}

function assertFailure(effect: Effect.Effect<unknown, unknown>, check: (error: unknown) => boolean): Effect.Effect<void> {
  return Effect.gen(function*() {
    const result = yield* Effect.result(effect);
    assert.equal(result._tag, 'Failure');
    if (result._tag === 'Failure') assert(check(result.failure));
  });
}

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

function packageTarball(name: string, version: string, { dependencies = {}, peerDependencies = {}, os }: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; os?: string[] } = {}): Buffer {
  const manifest = Buffer.from(JSON.stringify({ name, version, main: 'index.js', dependencies, peerDependencies, ...(os === undefined ? {} : { os }) }));
  return gzipSync(Buffer.concat([
    tarMember('package/package.json', manifest),
    tarMember('package/index.js', Buffer.from('module.exports = true;\n')),
    Buffer.alloc(1024),
  ]));
}

function savedNpmProject(directory: string, { optionalPackage = false, nestedPackage = false, aliasPackage = false, workspacePackage = false, lockVersion = 3 }: { optionalPackage?: boolean; nestedPackage?: boolean; aliasPackage?: boolean; workspacePackage?: boolean; lockVersion?: 2 | 3 } = {}): Effect.Effect<SavedNpmProject, MynpmError> {
  return Effect.gen(function*() {
    const target = currentTarget();
    const bytes = nestedPackage
      ? packageTarball('flatdemo', '1.2.3', { dependencies: { nesteddep: '^1.0.0' } })
      : readFileSync(new URL('./fixtures/tarballs/flatdemo-1.2.3.tgz', import.meta.url));
    const sha512 = createHash('sha512').update(bytes).digest('hex');
    const shasum = createHash('sha1').update(bytes).digest('hex');
    const integrity = `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;
    const sourceUrl = 'https://registry.npmjs.org/flatdemo/-/flatdemo-1.2.3.tgz';
    const nestedBytes = nestedPackage ? packageTarball('nesteddep', '2.0.0') : null;
    const nestedSha512 = nestedBytes === null ? null : createHash('sha512').update(nestedBytes).digest('hex');
    const nestedIntegrity = nestedSha512 === null ? null : `sha512-${Buffer.from(nestedSha512, 'hex').toString('base64')}`;
    const nestedSourceUrl = 'https://registry.npmjs.org/nesteddep/-/nesteddep-2.0.0.tgz';
    const aliasBytes = aliasPackage ? packageTarball('real-package', '1.2.3') : null;
    const aliasSha512 = aliasBytes === null ? null : createHash('sha512').update(aliasBytes).digest('hex');
    const aliasIntegrity = aliasSha512 === null ? null : `sha512-${Buffer.from(aliasSha512, 'hex').toString('base64')}`;
    const aliasSourceUrl = 'https://registry.npmjs.org/real-package/-/real-package-1.2.3.tgz';
    const workspaceManifest = workspacePackage ? `${JSON.stringify({ name: 'workspace-link', version: '1.0.0', private: true }, null, 2)}\n` : null;
    const manifest = {
      name: 'original-web',
      version: '1.0.0',
      packageManager: 'npm@12.2.1',
      description: 'original project metadata',
      dependencies: {
        flatdemo: '1.2.3',
        ...(aliasPackage ? { 'catalog-alias': 'npm:real-package@1.2.3' } : {}),
        ...(workspacePackage ? { 'workspace-link': '1.0.0' } : {}),
      },
      ...(nestedPackage ? { overrides: { flatdemo: { nesteddep: '2.0.0' } } } : {}),
      ...(workspacePackage ? { workspaces: ['packages/*'] } : {}),
      ...(optionalPackage ? { optionalDependencies: { optdep: '1.0.0' } } : {}),
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const packageEntries: Record<string, MutablePackageEntry> = {
      '': {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
        ...(workspacePackage ? { workspaces: manifest.workspaces } : {}),
        ...(optionalPackage ? { optionalDependencies: { optdep: '1.0.0' } } : {}),
      },
      'node_modules/flatdemo': {
        version: '1.2.3',
        resolved: sourceUrl,
        integrity,
        ...(nestedPackage ? { dependencies: { nesteddep: '^1.0.0' } } : {}),
      },
    };
    if (aliasPackage && aliasIntegrity !== null) {
      packageEntries['node_modules/catalog-alias'] = {
        name: 'real-package',
        version: '1.2.3',
        resolved: aliasSourceUrl,
        integrity: aliasIntegrity,
      };
    }
    if (workspacePackage) {
      packageEntries['node_modules/workspace-link'] = { resolved: 'packages/workspace-link', link: true };
      packageEntries['packages/workspace-link'] = { version: '1.0.0' };
    }
    if (nestedPackage && nestedIntegrity !== null) {
      packageEntries['node_modules/flatdemo/node_modules/nesteddep'] = {
        version: '2.0.0',
        resolved: nestedSourceUrl,
        integrity: nestedIntegrity,
      };
    }
    let optionalSha512 = null;
    let optionalBytes = null;
    if (optionalPackage) {
      optionalBytes = packageTarball('optdep', '1.0.0');
      optionalSha512 = createHash('sha512').update(optionalBytes).digest('hex');
      const optionalIntegrity = `sha512-${Buffer.from(optionalSha512, 'hex').toString('base64')}`;
      packageEntries['node_modules/optdep'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/optdep/-/optdep-1.0.0.tgz',
        integrity: optionalIntegrity,
        optional: true,
      };
    }
    const lock: NpmTestLock = {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: lockVersion,
      requires: true,
      packages: packageEntries,
    };
    if (lockVersion === 2) {
      lock.dependencies = {
        flatdemo: {
          version: '1.2.3',
          resolved: sourceUrl,
          integrity,
          ...(nestedPackage ? { dependencies: { nesteddep: { version: '2.0.0', resolved: nestedSourceUrl, integrity: nestedIntegrity } } } : {}),
        },
        ...(optionalPackage ? { optdep: { version: '1.0.0', resolved: 'https://registry.npmjs.org/optdep/-/optdep-1.0.0.tgz', integrity: packageEntries['node_modules/optdep'].integrity, optional: true } } : {}),
      };
    }
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    const project = parseNpmLock(lock, {
      projectId: 'original-web',
      packageManagerPin: 'npm@12.2.1',
      lockfilePath: 'package-lock.json',
      targetIds: [target.id],
      snapshot: {
        manifest: manifestText,
        lockfile: lockText,
        workspaceFiles: workspaceManifest === null ? [] : [{ path: 'packages/workspace-link/package.json', contents: workspaceManifest }],
        npmInstallOptions: { legacyPeerDeps: null, installLinks: null },
      },
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
    if (aliasBytes !== null && aliasSha512 !== null && aliasIntegrity !== null) {
      const aliasShasum = createHash('sha1').update(aliasBytes).digest('hex');
      inventory = recordVerifiedArtifact(inventory, {
        name: 'real-package',
        version: '1.2.3',
        packument: { name: 'real-package', 'dist-tags': { latest: '1.2.3' } },
        metadata: { name: 'real-package', version: '1.2.3', dist: { tarball: aliasSourceUrl, integrity: aliasIntegrity, shasum: aliasShasum } },
        artifact: { sha512: aliasSha512, integrity: aliasIntegrity, shasum: aliasShasum, sourceUrl: aliasSourceUrl, legacySha1Only: false },
      });
    }
    if (nestedBytes !== null && nestedSha512 !== null && nestedIntegrity !== null) {
      const nestedShasum = createHash('sha1').update(nestedBytes).digest('hex');
      inventory = recordVerifiedArtifact(inventory, {
        name: 'nesteddep',
        version: '2.0.0',
        packument: { name: 'nesteddep', 'dist-tags': { latest: '2.0.0' } },
        metadata: { name: 'nesteddep', version: '2.0.0', dist: { tarball: nestedSourceUrl, integrity: nestedIntegrity, shasum: nestedShasum } },
        artifact: { sha512: nestedSha512, integrity: nestedIntegrity, shasum: nestedShasum, sourceUrl: nestedSourceUrl, legacySha1Only: false },
      });
    }
    if (optionalBytes !== null && optionalSha512 !== null) {
      const optionalShasum = createHash('sha1').update(optionalBytes).digest('hex');
      const optionalIntegrity = `sha512-${Buffer.from(optionalSha512, 'hex').toString('base64')}`;
      const optionalSourceUrl = 'https://registry.npmjs.org/optdep/-/optdep-1.0.0.tgz';
      inventory = recordVerifiedArtifact(inventory, {
        name: 'optdep',
        version: '1.0.0',
        packument: { name: 'optdep', 'dist-tags': { latest: '1.0.0' } },
        metadata: { name: 'optdep', version: '1.0.0', dist: { tarball: optionalSourceUrl, integrity: optionalIntegrity, shasum: optionalShasum } },
        artifact: { sha512: optionalSha512, integrity: optionalIntegrity, shasum: optionalShasum, sourceUrl: optionalSourceUrl, legacySha1Only: false },
      });
    }
    const stateDirectory = join(directory, 'state');
    const objectDirectory = join(stateDirectory, 'objects', 'sha512');
    mkdirSync(objectDirectory, { recursive: true });
    writeFileSync(join(objectDirectory, `${sha512}.tgz`), bytes);
    if (aliasBytes !== null && aliasSha512 !== null) writeFileSync(join(objectDirectory, `${aliasSha512}.tgz`), aliasBytes);
    if (nestedBytes !== null && nestedSha512 !== null) writeFileSync(join(objectDirectory, `${nestedSha512}.tgz`), nestedBytes);
    if (optionalBytes !== null && optionalSha512 !== null) writeFileSync(join(objectDirectory, `${optionalSha512}.tgz`), optionalBytes);
    yield* saveInventory(stateDirectory, inventory);
    const testConfig = configForCurrentNode(target.id);
    return { stateDirectory, config: testConfig, bytes, lock, lockText, manifestText, target, optionalSha512, nestedBytes, nestedSha512 };
  });
}

function savedPnpmWorkspace(directory: string, { optionalPackage = false, optionalPlatform = false }: { optionalPackage?: boolean; optionalPlatform?: boolean } = {}) {
  return Effect.gen(function*() {
    const target = currentTarget();
    const bytes = readFileSync(new URL('./fixtures/tarballs/flatdemo-1.2.3.tgz', import.meta.url));
    const sha512 = createHash('sha512').update(bytes).digest('hex');
    const shasum = createHash('sha1').update(bytes).digest('hex');
    const integrity = `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;
    const sourceUrl = 'https://registry.npmjs.org/flatdemo/-/flatdemo-1.2.3.tgz';
    const optionalBytes = optionalPackage ? packageTarball('optdep', '1.0.0', optionalPlatform ? { os: ['linux'] } : {}) : null;
    const optionalSha512 = optionalBytes === null ? null : createHash('sha512').update(optionalBytes).digest('hex');
    const optionalIntegrity = optionalSha512 === null ? null : `sha512-${Buffer.from(optionalSha512, 'hex').toString('base64')}`;
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
      ...(optionalPackage ? { optionalDependencies: { optdep: '1.0.0' } } : {}),
    }, null, 2)}\n`;
    const workspaceManifest = 'packages:\n  - apps/*\n';
    const lockText = `---
lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
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
${optionalPackage ? `    optionalDependencies:
      optdep:
        specifier: 1.0.0
        version: 1.0.0
` : ''}packages:
  flatdemo@1.2.3:
    resolution:
      integrity: ${integrity}
${optionalPackage ? `  optdep@1.0.0:
    resolution:
      integrity: ${optionalIntegrity}
    optional: true
${optionalPlatform ? '    os: [linux]\n' : ''}
` : ''}snapshots:
  flatdemo@1.2.3: {}
${optionalPackage ? '  optdep@1.0.0: {}\n' : ''}
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
        npmInstallOptions: { legacyPeerDeps: null, installLinks: null },
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
    if (optionalBytes !== null && optionalSha512 !== null && optionalIntegrity !== null) {
      const optionalShasum = createHash('sha1').update(optionalBytes).digest('hex');
      const optionalSourceUrl = 'https://registry.npmjs.org/optdep/-/optdep-1.0.0.tgz';
      inventory = recordVerifiedArtifact(inventory, {
        name: 'optdep',
        version: '1.0.0',
        packument: { name: 'optdep', 'dist-tags': { latest: '1.0.0' } },
        metadata: { name: 'optdep', version: '1.0.0', dist: { tarball: optionalSourceUrl, integrity: optionalIntegrity, shasum: optionalShasum } },
        artifact: { sha512: optionalSha512, integrity: optionalIntegrity, shasum: optionalShasum, sourceUrl: optionalSourceUrl, legacySha1Only: false },
      });
    }
    const stateDirectory = join(directory, 'state');
    const objectDirectory = join(stateDirectory, 'objects', 'sha512');
    mkdirSync(objectDirectory, { recursive: true });
    writeFileSync(join(objectDirectory, `${sha512}.tgz`), bytes);
    if (optionalBytes !== null && optionalSha512 !== null) writeFileSync(join(objectDirectory, `${optionalSha512}.tgz`), optionalBytes);
    yield* saveInventory(stateDirectory, inventory);
    const testConfig = configForCurrentNode(target.id);
    return { stateDirectory, config: testConfig, target, optionalSha512 };
  });
}

function savedPnpmPeerProject(directory: string) {
  return Effect.gen(function*() {
    const target = currentTarget();
    const packages = [
      { name: 'button', version: '1.0.0', bytes: packageTarball('button', '1.0.0', { peerDependencies: { react: '^19.0.0' } }) },
      { name: 'react', version: '19.0.0', bytes: packageTarball('react', '19.0.0') },
    ].map(pkg => {
      const sha512 = createHash('sha512').update(pkg.bytes).digest('hex');
      const shasum = createHash('sha1').update(pkg.bytes).digest('hex');
      const integrity = `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;
      const sourceUrl = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
      return { ...pkg, sha512, shasum, integrity, sourceUrl };
    });
    const [button, react] = packages;
    const manifestText = `${JSON.stringify({
      name: 'peer-root',
      version: '1.0.0',
      private: true,
      packageManager: 'pnpm@12.15.0',
      dependencies: { button: '1.0.0' },
    }, null, 2)}\n`;
    const lockText = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      button:
        specifier: 1.0.0
        version: 1.0.0(react@19.0.0)
packages:
  button@1.0.0:
    resolution:
      integrity: ${button.integrity}
    peerDependencies:
      react: ^19.0.0
  react@19.0.0:
    resolution:
      integrity: ${react.integrity}
snapshots:
  button@1.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0
  react@19.0.0: {}
`;
    const project = yield* parsePnpmLock(lockText, {
      projectId: 'peer-root',
      packageManagerPin: 'pnpm@12.15.0',
      lockfilePath: 'pnpm-lock.yaml',
      targetIds: [target.id],
      snapshot: { manifest: manifestText, lockfile: lockText, workspaceFiles: [], npmInstallOptions: { legacyPeerDeps: null, installLinks: null } },
    });
    let inventory = mergeProject(createEmptyInventory(), project);
    for (const pkg of packages) {
      inventory = recordVerifiedArtifact(inventory, {
        name: pkg.name,
        version: pkg.version,
        packument: { name: pkg.name, 'dist-tags': { latest: pkg.version } },
        metadata: { name: pkg.name, version: pkg.version, dist: { tarball: pkg.sourceUrl, integrity: pkg.integrity, shasum: pkg.shasum } },
        artifact: { sha512: pkg.sha512, integrity: pkg.integrity, shasum: pkg.shasum, sourceUrl: pkg.sourceUrl, legacySha1Only: false },
      });
    }
    const stateDirectory = join(directory, 'state');
    const objectDirectory = join(stateDirectory, 'objects', 'sha512');
    mkdirSync(objectDirectory, { recursive: true });
    for (const pkg of packages) writeFileSync(join(objectDirectory, `${pkg.sha512}.tgz`), pkg.bytes);
    yield* saveInventory(stateDirectory, inventory);
    const testConfig = configForCurrentNode(target.id);
    return { stateDirectory, config: testConfig, button, react };
  });
}

function testRequest<A>(operation: () => Promise<A>): Effect.Effect<A, MynpmError> {
  return Effect.tryPromise({ try: operation, catch: cause => new MynpmError('operation', 'test request failed', { cause }) });
}

function fakeNpm(restore: SavedNpmProject, afterInstall: PostInstallCheck = () => Effect.void, { installPackage = true, report = true }: { installPackage?: boolean; report?: boolean } = {}): typeof runProcess {
  return (command: string, args: readonly string[], options: RunProcessOptions) => Effect.gen(function*() {
    if (args[0] === '--version') return { stdout: '12.2.1\n', stderr: '' };
    assert.equal(command, 'npm');
    if (args[0] === 'ls') {
      const manifest = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8'));
      return report
        ? { stdout: JSON.stringify({ name: manifest.name, version: manifest.version, dependencies: { flatdemo: { version: '1.2.3' } } }), stderr: '' }
        : { stdout: JSON.stringify({ name: manifest.name, version: manifest.version, dependencies: {} }), stderr: '' };
    }
    assert.equal(args[0], 'ci');
    const manifest = readFileSync(join(options.cwd, 'package.json'), 'utf8');
    assert.equal(manifest, restore.manifestText);
    const lockText = readFileSync(join(options.cwd, 'package-lock.json'), 'utf8');
    const lock = JSON.parse(lockText) as NpmTestLock;
    const resolved = lock.packages['node_modules/flatdemo'].resolved;
    assert.ok(resolved);
    assert.match(resolved, /^http:\/\/127\.0\.0\.1:\d+\/(?:mirror\/)?current\/-\/tarballs\/[a-f0-9]{128}\.tgz$/);
    assert.deepEqual(lock.packages[''].dependencies, { flatdemo: '1.2.3' });
    const registry = options.env.npm_config_registry;
    assert.ok(registry);
    const metadataResponse = yield* testRequest(() => fetch(`${registry}flatdemo`));
    assert.equal(metadataResponse.status, 200);
    const metadata = yield* testRequest(() => metadataResponse.json() as Promise<{ versions: Record<string, { dist: { tarball: string } }> }>);
    assert.equal(resolved, metadata.versions['1.2.3'].dist.tarball);
    const tarballResponse = yield* testRequest(() => fetch(resolved));
    assert.equal(tarballResponse.status, 200);
    const tarball = yield* testRequest(() => tarballResponse.arrayBuffer());
    assert.deepEqual(Buffer.from(tarball), restore.bytes);
    if (restore.nestedBytes !== null) {
      const nestedResolved = lock.packages['node_modules/flatdemo/node_modules/nesteddep'].resolved;
      assert.ok(nestedResolved);
      const nestedResponse = yield* testRequest(() => fetch(nestedResolved));
      assert.equal(nestedResponse.status, 200);
      assert.deepEqual(Buffer.from(yield* testRequest(() => nestedResponse.arrayBuffer())), restore.nestedBytes);
    }
    yield* afterInstall(lock, options.cwd);
    if (installPackage) {
      const packageDirectory = join(options.cwd, 'node_modules', 'flatdemo');
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: 'flatdemo', version: '1.2.3' }));
    }
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
      error => hasErrorCategory('operation')(error) && error.message.includes(`requires Node.js ${target.node}`),
    );
  } else {
    const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim();
    if (npmVersion !== managerVersions.npm) {
      yield* assertFailure(
        validateInventory({ client: 'npm', stateDirectory, config }),
        error => hasErrorCategory('operation')(error) && error.message.includes(`npm ${managerVersions.npm} is required`),
      );
    } else {
      yield* assertFailure(
        validateInventory({ client: 'npm', stateDirectory, config }),
        error => error instanceof Error && /requires an imported package.json snapshot/.test(error.message),
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

it.effect('validate forwards captured npm install-shaping settings to npm ci', () => withScratch('validate-npm-install-options-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  const inventory = structuredClone(parseInventory(readFileSync(join(restore.stateDirectory, 'inventory.json'), 'utf8')));
  const project = inventory.projects[0];
  assert.ok(project);
  assert.ok(project.snapshot);
  project.snapshot.npmInstallOptions = { legacyPeerDeps: true, installLinks: false };
  yield* saveInventory(restore.stateDirectory, inventory);
  let sawInstallOptions = false;
  const client = fakeNpm(restore);

  const result = yield* validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
    runProcess: (command, args, options) => {
      if (command === 'npm' && args[0] === 'ci') {
        assert.ok(args.includes('--legacy-peer-deps=true'));
        assert.ok(args.includes('--install-links=false'));
        sawInstallOptions = true;
      }
      return client(command, args, options);
    },
  });
  assert.equal(result.projectCount, 1);
  assert.equal(sawInstallOptions, true);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.2.1'))('validate restores the original npm project with the pinned client and local tarballs', () => withScratch('validate-npm-client-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  const result = yield* validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 1);
  assert.ok(result.requestCount >= 2);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.2.1'))('validate preserves npm aliases, nested versions, overrides, and workspace links', () => withScratch('validate-npm-complete-graph-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory, { nestedPackage: true, aliasPackage: true, workspacePackage: true });
  const inventory = parseInventory(readFileSync(join(restore.stateDirectory, 'inventory.json'), 'utf8'));
  const project = inventory.projects[0];
  assert.ok(project);
  assert.ok(project.snapshot);
  const lock = JSON.parse(project.snapshot.lockfile);
  const alias = project.packages.find(item => item.key === 'node_modules/catalog-alias');
  assert.ok(alias);
  assert.equal(alias.name, 'real-package');
  const nested = project.packages.find(item => item.key === 'node_modules/flatdemo/node_modules/nesteddep');
  assert.ok(nested);
  assert.equal(nested.version, '2.0.0');
  assert.ok(project.snapshot.manifest);
  assert.deepEqual(JSON.parse(project.snapshot.manifest).overrides, { flatdemo: { nesteddep: '2.0.0' } });
  assert.deepEqual(project.snapshot.workspaceFiles.map(file => file.path), ['packages/workspace-link/package.json']);
  assert.equal(lock.packages['node_modules/workspace-link'].resolved, 'packages/workspace-link');

  const result = yield* validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 3);
  assert.ok(result.requestCount >= 6);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.2.1'))('validate migrates an npm v2 lockfile and its legacy dependency URLs', () => withScratch('validate-npm-v2-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory, { nestedPackage: true, lockVersion: 2 });
  const result = yield* validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 2);
  assert.ok(result.requestCount >= 3);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.2.1'))('validate migrates npm ci to canonical tarballs with allow-remote none', () => withScratch('validate-npm-allow-none-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  const result = yield* validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
    runProcess: (command, args, options) => runProcess(command, command === 'npm' && args[0] === 'ci' ? [...args, '--allow-remote=none'] : args, options),
  });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 1);
  assert.ok(result.requestCount >= 2);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.2.1'))('validate rejects npm ci success after an applicable optional tarball returns 404', () => withScratch('validate-npm-optional-404-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory, { optionalPackage: true });
  let npmCiSucceeded = false;
  const result = yield* Effect.result(validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
    runProcess: (command, args, options) => {
      if (command !== 'npm' || args[0] !== 'ci') return runProcess(command, args, options);
      const workspace = resolve(options.cwd, '..', '..');
      unlinkSync(join(workspace, 'site', 'mirror', 'current', '-', 'tarballs', `${restore.optionalSha512}.tgz`));
      return runProcess(command, args, options).pipe(Effect.tap(() => Effect.sync(() => { npmCiSucceeded = true; })));
    },
  }));
  assert.equal(result._tag, 'Failure');
  if (result._tag === 'Failure') {
    assert.equal(result.failure.category, 'conflict');
    assert.match(result.failure.message, /HTTP 404.*optdep/);
  }
  assert.equal(npmCiSucceeded, true);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.2.1'))('validate rejects corrupt bytes for an applicable optional tarball', () => withScratch('validate-npm-optional-corrupt-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory, { optionalPackage: true });
  const result = yield* Effect.result(validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
    runProcess: (command, args, options) => {
      if (command !== 'npm' || args[0] !== 'ci') return runProcess(command, args, options);
      const workspace = resolve(options.cwd, '..', '..');
      const tarball = join(workspace, 'site', 'mirror', 'current', '-', 'tarballs', `${restore.optionalSha512}.tgz`);
      unlinkSync(tarball);
      writeFileSync(tarball, Buffer.from('corrupt optional tarball bytes'));
      return runProcess(command, args, options);
    },
  }));
  assert.equal(result._tag, 'Failure');
  if (result._tag === 'Failure') {
    assert.equal(result.failure.category, 'corrupt');
    assert.match(result.failure.message, /corrupted tarball bytes.*optdep/);
  }
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.15.0'))('validate restores a pnpm workspace and frozen lock graph through local tarballs', () => withScratch('validate-pnpm-workspace-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmWorkspace(directory);
  const result = yield* validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 1);
  assert.equal(result.rootCount, 1);
  assert.ok(result.requestCount >= 2);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.15.0'))('validate restores a peer-qualified pnpm root from its plain artifact key', () => withScratch('validate-pnpm-peer-root-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmPeerProject(directory);
  const inventory = JSON.parse(readFileSync(join(restore.stateDirectory, 'inventory.json'), 'utf8'));
  const root = inventory.projects[0].roots[0];
  assert.deepEqual([root.packageName, root.packageVersion, root.packageKey], ['button', '1.0.0', 'button@1.0.0']);
  assert.match(inventory.projects[0].snapshot.lockfile, /version: 1\.0\.0\(react@19\.0\.0\)/);

  const result = yield* validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config });
  assert.equal(result.projectCount, 1);
  assert.equal(result.packageCount, 2);
  assert.equal(result.rootCount, 1);
  assert.ok(result.requestCount >= 3);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.15.0'))('validate rejects changed pnpm peer links after a successful frozen install', () => withScratch('validate-pnpm-peer-link-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmPeerProject(directory);
  let altered = false;
  const result = yield* Effect.result(validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config }, {
    runProcess: (command, args, options) => {
      const install = runProcess(command, args, options);
      if (command !== 'pnpm' || args[0] !== 'install') return install;
      return install.pipe(Effect.tap(() => Effect.sync(() => {
        const buttonPath = realpathSync(join(options.cwd, 'node_modules', 'button'));
        const reactLink = resolve(buttonPath, '..', 'react');
        unlinkSync(reactLink);
        symlinkSync(join(options.cwd, 'node_modules', 'missing-react'), reactLink);
        altered = true;
      })));
    },
  }));
  assert.equal(result._tag, 'Failure');
  if (result._tag === 'Failure') {
    assert.equal(result.failure.category, 'conflict');
    assert.match(result.failure.message, /installed dependency|missing from the installed tree/);
  }
  assert.equal(altered, true);
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.15.0'))('validate rejects a pnpm install after an applicable optional tarball returns 404', () => withScratch('validate-pnpm-optional-404-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmWorkspace(directory, { optionalPackage: true });
  const result = yield* Effect.result(validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config }, {
    runProcess: (command, args, options) => {
      if (command !== 'pnpm' || args[0] !== 'install') return runProcess(command, args, options);
      const workspace = resolve(options.cwd, '..', '..');
      unlinkSync(join(workspace, 'site', 'mirror', 'current', '-', 'tarballs', `${restore.optionalSha512}.tgz`));
      return runProcess(command, args, options);
    },
  }));
  assert.equal(result._tag, 'Failure');
  if (result._tag === 'Failure') {
    assert.equal(result.failure.category, 'conflict');
    assert.match(result.failure.message, /HTTP 404.*optdep/);
  }
})));

it.effect.skipIf(process.env.MYNPM_REQUIRE_STATIC_CLIENTS !== '1' && (Number(process.versions.node.split('.')[0]) < 26 || spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() !== '12.15.0'))('validate reports a platform-inapplicable pnpm optional as skipped', () => withScratch('validate-pnpm-platform-skip-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmWorkspace(directory, { optionalPackage: true, optionalPlatform: true });
  const result = yield* validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config });
  assert.equal(result.packageCount, 1);
  assert.equal(result.platformSkippedCount, 2);
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
    error => hasErrorCategory('conflict')(error) && error.message.includes('changed the saved dependency graph'),
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
  const testConfig = configForCurrentNode(target.id);

  yield* assertFailure(
    validateInventory({ client: 'npm', stateDirectory, config: testConfig }, {
      runProcess: () => Effect.succeed({ stdout: '12.2.1\n', stderr: '' }),
    }),
    error => hasErrorCategory('input')(error) && error.message.includes('requires an imported package.json snapshot'),
  );
})));

it.effect('validate rejects an imported project pinned to another package-manager version', () => withScratch('validate-manager-pin-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  const inventoryPath = join(restore.stateDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  inventory.projects[0].packageManagerPin = 'npm@10.9.2';
  inventory.projects[0].snapshot.manifest = inventory.projects[0].snapshot.manifest.replace('npm@12.2.1', 'npm@10.9.2');
  yield* saveInventory(restore.stateDirectory, inventory);
  const commands: [string, string | undefined][] = [];

  yield* assertFailure(
    validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: (command, args) => Effect.sync(() => {
        commands.push([command, args[0]]);
        return { stdout: '12.2.1\n', stderr: '' };
      }),
    }),
    error => hasErrorCategory('input')(error) && error.message.includes('validation requires npm@12.2.1'),
  );
  assert.deepEqual(commands, []);
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
    error => hasErrorCategory('corrupt')(error) && error.message.includes('no longer matches imported project'),
  );
})));

it.effect('validate rejects saved pnpm hooks before invoking a client', () => withScratch('validate-pnpm-hook-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmWorkspace(directory);
  const inventoryPath = join(restore.stateDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const workspaceFile = inventory.projects[0].snapshot.workspaceFiles.find((file: { path: string; contents: string }) => file.path === 'pnpm-workspace.yaml');
  assert.ok(workspaceFile);
  workspaceFile.contents = `${workspaceFile.contents}hooks:\n  readPackage: plugins/marker.cjs\n`;
  yield* saveInventory(restore.stateDirectory, inventory);
  const commands: [string, string | undefined][] = [];

  yield* assertFailure(
    validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: (command, args) => Effect.sync(() => {
        commands.push([command, args[0]]);
        return { stdout: '12.15.0\n', stderr: '' };
      }),
    }),
    error => hasErrorCategory('input')(error) && error.message.includes('executable hook'),
  );
  assert.deepEqual(commands, []);
})));

it.effect('validate rejects saved pnpm config dependencies before invoking a client', () => withScratch('validate-pnpm-plugin-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmWorkspace(directory);
  const inventoryPath = join(restore.stateDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  inventory.projects[0].snapshot.lockfile = inventory.projects[0].snapshot.lockfile.replace(
    'configDependencies: {}',
    'configDependencies:\n      marker-plugin: 1.0.0',
  );
  yield* saveInventory(restore.stateDirectory, inventory);
  const commands: [string, string | undefined][] = [];

  yield* assertFailure(
    validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: (command, args) => Effect.sync(() => {
        commands.push([command, args[0]]);
        return { stdout: '12.15.0\n', stderr: '' };
      }),
    }),
    error => hasErrorCategory('input')(error) && error.message.includes('configuration dependency'),
  );
  assert.deepEqual(commands, []);
})));

it.effect('validate rejects saved pnpm package-manager boot dependencies before invoking a client', () => withScratch('validate-pnpm-boot-', directory => Effect.gen(function*() {
  const restore = yield* savedPnpmWorkspace(directory);
  const inventoryPath = join(restore.stateDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  inventory.projects[0].snapshot.lockfile = inventory.projects[0].snapshot.lockfile.replace(
    'configDependencies: {}',
    'configDependencies: {}\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.15.0\n        version: 12.15.0',
  );
  yield* saveInventory(restore.stateDirectory, inventory);
  const commands: [string, string | undefined][] = [];

  yield* assertFailure(
    validateInventory({ client: 'pnpm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: (command, args) => Effect.sync(() => {
        commands.push([command, args[0]]);
        return { stdout: '12.15.0\n', stderr: '' };
      }),
    }),
    error => hasErrorCategory('input')(error) && error.message.includes('package-manager boot dependency'),
  );
  assert.deepEqual(commands, []);
})));

it.effect('validate rejects a correct npm lockfile when a selected package is missing from disk', () => withScratch('validate-missing-package-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  yield* assertFailure(
    validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: fakeNpm(restore, () => Effect.void, { installPackage: false }),
    }),
    error => hasErrorCategory('conflict')(error) && error.message.includes('flatdemo@1.2.3 is missing from the installed tree'),
  );
})));

it.effect('validate rejects a successful npm ci process that performs no installation or requests', () => withScratch('validate-no-install-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory);
  let ciSucceeded = false;
  const result = yield* Effect.result(validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
    runProcess: (command, args) => {
      if (args[0] === '--version') return Effect.succeed({ stdout: '12.2.1\n', stderr: '' });
      if (args[0] === 'ci') {
        ciSucceeded = true;
        return Effect.succeed({ stdout: '', stderr: '' });
      }
      return Effect.succeed({ stdout: JSON.stringify({ name: 'original-web', version: '1.0.0', dependencies: {} }), stderr: '' });
    },
  }));
  assert.equal(result._tag, 'Failure');
  if (result._tag === 'Failure') {
    assert.equal(result.failure.category, 'conflict');
    assert.match(result.failure.message, /did not fetch expected applicable artifact/);
  }
  assert.equal(ciSucceeded, true);
})));

it.effect('validate rejects a wrong installed nested package version', () => withScratch('validate-wrong-nested-version-', directory => Effect.gen(function*() {
  const restore = yield* savedNpmProject(directory, { nestedPackage: true });
  yield* assertFailure(
    validateInventory({ client: 'npm', stateDirectory: restore.stateDirectory, config: restore.config }, {
      runProcess: fakeNpm(restore, (lock, projectDirectory) => Effect.sync(() => {
        const nestedDirectory = join(projectDirectory, 'node_modules', 'flatdemo', 'node_modules', 'nesteddep');
        mkdirSync(nestedDirectory, { recursive: true });
        writeFileSync(join(nestedDirectory, 'package.json'), JSON.stringify({ name: 'nesteddep', version: '9.9.9' }));
      })),
    }),
    error => hasErrorCategory('conflict')(error) && error.message.includes('expected nesteddep@2.0.0'),
  );
})));
