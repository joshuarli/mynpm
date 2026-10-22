import { readFile } from 'node:fs/promises';
import { Effect } from 'effect';
import { errorCode, MynpmError } from './errors.ts';

export type TargetOs = 'darwin' | 'linux';
export type TargetCpu = 'arm64' | 'x64';
export type TargetLibc = 'glibc' | 'musl';

export interface DarwinTargetConfig {
  readonly id: string;
  readonly os: 'darwin';
  readonly cpu: TargetCpu;
  readonly node: string;
}

export interface LinuxTargetConfig {
  readonly id: string;
  readonly os: 'linux';
  readonly cpu: TargetCpu;
  readonly libc: TargetLibc;
  readonly node: string;
}

export type TargetConfig = DarwinTargetConfig | LinuxTargetConfig;

export interface MynpmPolicy {
  readonly externalSources: 'reject';
  readonly remoteInstallScripts: 'report';
  readonly allowLegacySha1Only: boolean;
}

export interface MynpmConfig {
  readonly schemaVersion: 1;
  readonly publicBaseUrl: string;
  readonly upstreamRegistry: 'https://registry.npmjs.org/';
  readonly targets: readonly TargetConfig[];
  readonly policy: MynpmPolicy;
}

const targetIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const nodeVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new MynpmError('input', `${label} must be an object`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  const missing = keys.find(key => !Object.hasOwn(value, key));
  if (unknown !== undefined) throw new MynpmError('input', `${label} has unknown field ${unknown}`);
  if (missing !== undefined) throw new MynpmError('input', `${label} is missing field ${missing}`);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new MynpmError('input', `${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function requireHttpsUrl(value: unknown, label: string, trailingSlash: boolean): string {
  const text = requireText(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch (cause) {
    throw new MynpmError('input', `${label} must be an absolute HTTPS URL`, { cause });
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new MynpmError('input', `${label} must be an HTTPS URL without credentials, query, or fragment`);
  }
  if (trailingSlash && !url.pathname.endsWith('/')) {
    throw new MynpmError('input', `${label} must end with a slash`);
  }
  return url.href;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function parseTarget(value: unknown, index: number): TargetConfig {
  const label = `targets[${index}]`;
  const target = requireRecord(value, label);
  const keys = target.os === 'linux' ? ['id', 'os', 'cpu', 'libc', 'node'] : ['id', 'os', 'cpu', 'node'];
  requireExactKeys(target, keys, label);
  const id = requireText(target.id, `${label}.id`);
  const os = requireText(target.os, `${label}.os`);
  const cpu = requireText(target.cpu, `${label}.cpu`);
  const node = requireText(target.node, `${label}.node`);
  if (!targetIdPattern.test(id)) throw new MynpmError('input', `${label}.id must contain lowercase letters, digits, and hyphens`);
  if (os !== 'darwin' && os !== 'linux') throw new MynpmError('input', `${label}.os is unsupported`);
  if (cpu !== 'arm64' && cpu !== 'x64') throw new MynpmError('input', `${label}.cpu is unsupported`);
  if (os === 'darwin' && cpu !== 'arm64' && cpu !== 'x64') {
    throw new MynpmError('input', `${label} is an unsupported macOS target`);
  }
  if (!nodeVersionPattern.test(node)) throw new MynpmError('input', `${label}.node must be an exact major.minor.patch version`);
  if (os === 'darwin') return { id, os, cpu, node };
  const libc = requireText(target.libc, `${label}.libc`);
  if (libc !== 'glibc' && libc !== 'musl') throw new MynpmError('input', `${label}.libc must be glibc or musl`);
  return { id, os, cpu, libc, node };
}

function parsePolicy(value: unknown): MynpmPolicy {
  const policy = requireRecord(value, 'policy');
  requireExactKeys(policy, ['externalSources', 'remoteInstallScripts', 'allowLegacySha1Only'], 'policy');
  if (policy.externalSources !== 'reject') throw new MynpmError('input', 'policy.externalSources must be reject');
  if (policy.remoteInstallScripts !== 'report') throw new MynpmError('input', 'policy.remoteInstallScripts must be report');
  if (typeof policy.allowLegacySha1Only !== 'boolean') {
    throw new MynpmError('input', 'policy.allowLegacySha1Only must be a boolean');
  }
  return {
    externalSources: 'reject',
    remoteInstallScripts: 'report',
    allowLegacySha1Only: policy.allowLegacySha1Only,
  };
}

export function parseConfig(text: string): MynpmConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('input', 'configuration is not valid JSON', { cause });
  }
  const configuration = requireRecord(value, 'configuration');
  requireExactKeys(configuration, ['schemaVersion', 'publicBaseUrl', 'upstreamRegistry', 'targets', 'policy'], 'configuration');
  if (configuration.schemaVersion !== 1) throw new MynpmError('input', `unsupported configuration schemaVersion: ${String(configuration.schemaVersion)}`);
  const publicBaseUrl = requireHttpsUrl(configuration.publicBaseUrl, 'publicBaseUrl', true);
  const upstreamRegistry = requireHttpsUrl(configuration.upstreamRegistry, 'upstreamRegistry', true);
  if (upstreamRegistry !== 'https://registry.npmjs.org/') {
    throw new MynpmError('input', 'upstreamRegistry must be https://registry.npmjs.org/');
  }
  const targetValues = configuration.targets;
  if (!Array.isArray(targetValues) || targetValues.length === 0) {
    throw new MynpmError('input', 'targets must be a non-empty array');
  }
  const targets = targetValues.map((target: unknown, index: number) => parseTarget(target, index));
  const ids = targets.map(target => target.id);
  if (new Set(ids).size !== ids.length) throw new MynpmError('input', 'target IDs must be unique');
  const platforms = targets.map(target => `${target.os}/${target.cpu}/${'libc' in target ? target.libc : ''}`);
  if (new Set(platforms).size !== platforms.length) throw new MynpmError('input', 'target platforms must be unique');
  return freezeDeep({
    schemaVersion: 1,
    publicBaseUrl,
    upstreamRegistry,
    targets,
    policy: parsePolicy(configuration.policy),
  });
}

export function loadConfig(configPath: string): Effect.Effect<MynpmConfig, MynpmError> {
  return Effect.gen(function*() {
    const text = yield* Effect.tryPromise({
      try: signal => readFile(configPath, { encoding: 'utf8', signal }),
      catch: cause => errorCode(cause) === 'ENOENT'
        ? new MynpmError('input', `configuration file does not exist: ${configPath}`, { cause })
        : new MynpmError('operation', `could not read configuration file: ${configPath}`, { cause }),
    });
    return yield* Effect.try({
      try: () => parseConfig(text),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('input', 'configuration is invalid', { cause }),
    });
  });
}
