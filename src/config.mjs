import { readFile } from 'node:fs/promises';
import { MynpmError } from './errors.mjs';

const targetOs = new Set(['darwin', 'linux']);
const targetCpu = new Set(['arm64', 'x64']);
const targetLibc = new Set(['glibc', 'musl']);
const targetIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const nodeVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new MynpmError('input', `${label} must be an object`);
  return value;
}

function requireExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (unknown.length > 0) throw new MynpmError('input', `${label} has unknown field ${unknown[0]}`);
  if (missing.length > 0) throw new MynpmError('input', `${label} is missing field ${missing[0]}`);
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new MynpmError('input', `${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function requireHttpsUrl(value, label, trailingSlash) {
  requireText(value, label);
  let url;
  try {
    url = new URL(value);
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

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function parseTarget(value, index) {
  const label = `targets[${index}]`;
  requireRecord(value, label);
  const keys = value.os === 'linux' ? ['id', 'os', 'cpu', 'libc', 'node'] : ['id', 'os', 'cpu', 'node'];
  requireExactKeys(value, keys, label);
  const id = requireText(value.id, `${label}.id`);
  const os = requireText(value.os, `${label}.os`);
  const cpu = requireText(value.cpu, `${label}.cpu`);
  const node = requireText(value.node, `${label}.node`);
  if (!targetIdPattern.test(id)) throw new MynpmError('input', `${label}.id must contain lowercase letters, digits, and hyphens`);
  if (!targetOs.has(os)) throw new MynpmError('input', `${label}.os is unsupported`);
  if (!targetCpu.has(cpu)) throw new MynpmError('input', `${label}.cpu is unsupported`);
  if (os === 'darwin' && cpu !== 'arm64' && cpu !== 'x64') {
    throw new MynpmError('input', `${label} is an unsupported macOS target`);
  }
  if (!nodeVersionPattern.test(node)) throw new MynpmError('input', `${label}.node must be an exact major.minor.patch version`);
  const target = { id, os, cpu };
  if (os === 'linux') {
    const libc = requireText(value.libc, `${label}.libc`);
    if (!targetLibc.has(libc)) throw new MynpmError('input', `${label}.libc must be glibc or musl`);
    target.libc = libc;
  }
  target.node = node;
  return target;
}

function parsePolicy(value) {
  requireRecord(value, 'policy');
  requireExactKeys(value, ['externalSources', 'remoteInstallScripts', 'allowLegacySha1Only'], 'policy');
  if (value.externalSources !== 'reject') throw new MynpmError('input', 'policy.externalSources must be reject');
  if (value.remoteInstallScripts !== 'report') throw new MynpmError('input', 'policy.remoteInstallScripts must be report');
  if (typeof value.allowLegacySha1Only !== 'boolean') {
    throw new MynpmError('input', 'policy.allowLegacySha1Only must be a boolean');
  }
  return {
    externalSources: value.externalSources,
    remoteInstallScripts: value.remoteInstallScripts,
    allowLegacySha1Only: value.allowLegacySha1Only,
  };
}

export function parseConfig(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('input', 'configuration is not valid JSON', { cause });
  }
  requireRecord(value, 'configuration');
  requireExactKeys(value, ['schemaVersion', 'publicBaseUrl', 'upstreamRegistry', 'targets', 'policy'], 'configuration');
  if (value.schemaVersion !== 1) throw new MynpmError('input', `unsupported configuration schemaVersion: ${value.schemaVersion}`);
  const publicBaseUrl = requireHttpsUrl(value.publicBaseUrl, 'publicBaseUrl', true);
  const upstreamRegistry = requireHttpsUrl(value.upstreamRegistry, 'upstreamRegistry', true);
  if (upstreamRegistry !== 'https://registry.npmjs.org/') {
    throw new MynpmError('input', 'upstreamRegistry must be https://registry.npmjs.org/');
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    throw new MynpmError('input', 'targets must be a non-empty array');
  }
  const targets = value.targets.map(parseTarget);
  const ids = targets.map(target => target.id);
  if (new Set(ids).size !== ids.length) throw new MynpmError('input', 'target IDs must be unique');
  const platforms = targets.map(target => `${target.os}/${target.cpu}/${target.libc ?? ''}`);
  if (new Set(platforms).size !== platforms.length) throw new MynpmError('input', 'target platforms must be unique');
  return freezeDeep({
    schemaVersion: 1,
    publicBaseUrl,
    upstreamRegistry,
    targets,
    policy: parsePolicy(value.policy),
  });
}

export async function loadConfig(configPath) {
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new MynpmError('input', `configuration file does not exist: ${configPath}`, { cause });
    throw new MynpmError('operation', `could not read configuration file: ${configPath}`, { cause });
  }
  return parseConfig(text);
}
