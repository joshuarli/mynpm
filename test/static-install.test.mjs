import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fileURLToPath(new URL('./fixtures/protocol-seed/', import.meta.url));
const workDirectory = new URL('../.work/tmp/', import.meta.url);

test('npm installs the seed from a local static site with fresh caches', () => {
  const temporaryDirectory = fileURLToPath(workDirectory);
  mkdirSync(temporaryDirectory, { recursive: true });

  const result = spawnSync('bash', ['test.sh'], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      TMPDIR: temporaryDirectory,
      npm_config_cache: fileURLToPath(new URL('../.work/tmp/npm-cache/', import.meta.url)),
    },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 240_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

  assert.equal(result.error, undefined, result.error?.message ?? output);
  assert.equal(result.status, 0, output);
  assert.match(output, /PASS scoped \+ transitive dependency \(npm install\)/);
  assert.match(output, /PASS fresh cache \+ lockfile \(npm ci\)/);
  assert.match(output, /GET .*\/mirror\/current\/flatdemo/);
  assert.match(output, /GET .*\/mirror\/current\/@flatrepo%2fdemo/);
  assert.match(output, /GET .*\/mirror\/current\/-\/tarballs\/[a-f0-9]{128}\.tgz/);
});
