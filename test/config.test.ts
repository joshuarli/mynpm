import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseConfig } from '../src/config.ts';
import { MynpmError } from '../src/errors.ts';
import { hasErrorCategory } from './support.ts';

const baseConfig = {
  schemaVersion: 1,
  publicBaseUrl: 'https://deps.example.net/mirror/',
  upstreamRegistry: 'https://registry.npmjs.org/',
  targets: [
    { id: 'mac-arm64', os: 'darwin', cpu: 'arm64', node: '26.12.0' },
    { id: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc', node: '26.12.0' },
  ],
  policy: {
    externalSources: 'reject',
    remoteInstallScripts: 'report',
    allowLegacySha1Only: false,
  },
};

function parse(overrides: Record<string, unknown> = {}) {
  return parseConfig(JSON.stringify({ ...baseConfig, ...overrides }));
}

const inputError = (error: unknown): boolean => error instanceof MynpmError && error.category === 'input';

test('config accepts the exact schema and freezes validated values', () => {
  const config = parse();

  assert.deepEqual(config, baseConfig);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.targets), true);
  assert.equal(Object.isFrozen(config.targets[0]), true);
  assert.equal(Object.isFrozen(config.policy), true);
});

test('config rejects unknown top-level fields and schema versions', () => {
  assert.throws(() => parse({ extra: true }), inputError);
  assert.throws(() => parse({ schemaVersion: 2 }), inputError);
});

test('config rejects private registries and unsafe publication URLs', () => {
  assert.throws(
    () => parse({ upstreamRegistry: 'https://registry.example.net/' }),
    inputError,
  );
  assert.throws(
    () => parse({ publicBaseUrl: 'http://deps.example.net/mirror/' }),
    inputError,
  );
  assert.throws(
    () => parse({ publicBaseUrl: 'https://user:pass@deps.example.net/mirror/' }),
    inputError,
  );
});

test('config rejects unsupported, duplicate, and malformed targets', () => {
  assert.throws(
    () => parse({ targets: [{ id: 'windows-x64', os: 'win32', cpu: 'x64', node: '26.12.0' }] }),
    inputError,
  );
  assert.throws(
    () => parse({ targets: [baseConfig.targets[0], baseConfig.targets[0]] }),
    inputError,
  );
  assert.throws(
    () => parse({ targets: [{ ...baseConfig.targets[1], libc: 'musl', extra: true }] }),
    hasErrorCategory('input'),
  );
});

test('config rejects malformed JSON and policy values', () => {
  assert.throws(() => parseConfig('{'), inputError);
  assert.throws(
    () => parse({ policy: { ...baseConfig.policy, externalSources: 'allow' } }),
    inputError,
  );
});
