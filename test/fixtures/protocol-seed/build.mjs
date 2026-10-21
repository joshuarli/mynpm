#!/usr/bin/env node
// Fully offline PoC generator. Requires only Node.js and npm. No runtime npm deps.
// Usage: node build.mjs /absolute/output/site http://127.0.0.1:PORT/mirror/
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [, , siteArg, baseArg] = process.argv;
if (!siteArg || !baseArg) {
  console.error('Usage: node build.mjs /absolute/output/site http://127.0.0.1:PORT/mirror/');
  process.exit(2);
}
const site = resolve(siteArg);
const base = new URL(baseArg);
if (!base.pathname.endsWith('/mirror/')) throw new Error('For the PoC, base URL must end in /mirror/');
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Base URL must use HTTP(S)');
const registryRoot = join(site, 'mirror');
const generation = join(registryRoot, 'generations', 'demo-v1');
const blobDir = join(registryRoot, 'tarballs');
const scratch = mkdtempSync(join(tmpdir(), 'npm-static-pack-'));
const projects = [join(import.meta.dirname, 'fixtures', 'flatdemo'), join(import.meta.dirname, 'fixtures', 'scoped-demo')];
const manifest = [];
try {
  mkdirSync(blobDir, { recursive: true });
  mkdirSync(generation, { recursive: true });
  for (const project of projects) {
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    const pack = spawnSync('npm', ['pack', project, '--ignore-scripts', '--offline', '--json', '--pack-destination', scratch], {
      encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr || pack.stdout}`);
    const [result] = JSON.parse(pack.stdout);
    const tarBytes = readFileSync(join(scratch, result.filename));
    const sha512 = createHash('sha512').update(tarBytes).digest();
    const digestHex = sha512.toString('hex');
    const integrity = 'sha512-' + sha512.toString('base64');
    const shasum = createHash('sha1').update(tarBytes).digest('hex');
    const blobName = digestHex + '.tgz';
    const blobPath = join(blobDir, blobName);
    if (existsSync(blobPath)) {
      if (!readFileSync(blobPath).equals(tarBytes)) throw new Error('Digest collision');
    } else {
      writeFileSync(blobPath, tarBytes, { flag: 'wx' });
    }
    const version = {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies ?? {},
      optionalDependencies: pkg.optionalDependencies ?? {},
      peerDependencies: pkg.peerDependencies ?? {},
      peerDependenciesMeta: pkg.peerDependenciesMeta ?? {},
      engines: pkg.engines ?? {},
      dist: {
        tarball: new URL('tarballs/' + blobName, base).href,
        integrity,
        shasum,
      },
    };
    const packument = {
      _id: pkg.name,
      name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: { [pkg.version]: version },
      time: { [pkg.version]: '2026-01-01T00:00:00.000Z' },
    };
    const dest = join(generation, ...pkg.name.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(packument, null, 2) + '\n');
    manifest.push({ name: pkg.name, version: pkg.version, integrity, tarball: version.dist.tarball });
  }
  writeFileSync(join(generation, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const current = join(registryRoot, 'current');
  const next = join(registryRoot, '.current-next');
  rmSync(next, { force: true });
  symlinkSync('generations/demo-v1', next);
  renameSync(next, current);  // Atomic pointer switch on POSIX filesystems.
  console.log(`Generated ${manifest.length} packuments with absolute tarball URLs; public registry: ${new URL('current/', base)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
