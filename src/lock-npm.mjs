import { MynpmError } from './errors.mjs';

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const integrityAlgorithms = new Map([['sha1', 20], ['sha256', 32], ['sha384', 48], ['sha512', 64]]);
const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new MynpmError('input', `${label} must be an object`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new MynpmError('input', `${label} must be a non-empty string`);
  }
  return value;
}

function requirePackageName(value, label) {
  requireText(value, label);
  if (!packageNamePattern.test(value)) throw new MynpmError('input', `${label} is not a valid package name`);
  return value;
}

function requireVersion(value, label, nullable) {
  if (nullable && value === undefined) return null;
  requireText(value, label);
  if (!versionPattern.test(value)) throw new MynpmError('input', `${label} is not an exact package version`);
  return value;
}

function requireIntegrity(value, label) {
  if (value === undefined) return null;
  requireText(value, label);
  const tokens = value.split(/\s+/);
  if (tokens.length === 0) throw new MynpmError('input', `${label} is malformed`);
  const claims = new Map();
  for (const token of tokens) {
    const [claim] = token.split('?', 1);
    const separator = claim.indexOf('-');
    const algorithm = claim.slice(0, separator);
    const digest = claim.slice(separator + 1);
    const expectedLength = integrityAlgorithms.get(algorithm);
    if (!expectedLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) {
      throw new MynpmError('input', `${label} contains an unsupported integrity token`);
    }
    const bytes = Buffer.from(digest, 'base64');
    if (bytes.length !== expectedLength || bytes.toString('base64') !== digest) {
      throw new MynpmError('input', `${label} contains a malformed ${algorithm} digest`);
    }
    const hex = bytes.toString('hex');
    if (claims.has(algorithm) && claims.get(algorithm) !== hex) throw new MynpmError('input', `${label} contains conflicting ${algorithm} claims`);
    claims.set(algorithm, hex);
  }
  return value;
}

function packageNameFromKey(key) {
  const marker = 'node_modules/';
  const offset = key.lastIndexOf(marker);
  if (offset < 0) return null;
  const segments = key.slice(offset + marker.length).split('/');
  if (segments[0]?.startsWith('@')) {
    if (segments.length < 2 || segments[1] === '') throw new MynpmError('input', `invalid package key: ${key}`);
    return `${segments[0]}/${segments[1]}`;
  }
  if (!segments[0]) throw new MynpmError('input', `invalid package key: ${key}`);
  return segments[0];
}

function sanitizeResolved(value, label) {
  if (value === null || !/^(?:https?|git\+https?):/i.test(value)) return { resolved: value, hadCredentials: false };
  const prefix = value.startsWith('git+') ? 'git+' : '';
  let url;
  try {
    url = new URL(prefix ? value.slice(prefix.length) : value);
  } catch (cause) {
    throw new MynpmError('input', `${label} is not a valid URL`, { cause });
  }
  const hadCredentials = url.username !== '' || url.password !== '' || url.search !== '';
  if (hadCredentials) {
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
  }
  return { resolved: `${prefix}${url.href}`, hadCredentials };
}

function classifySource(resolved, isLink, hadCredentials) {
  if (isLink || /^(?:file|link|workspace):/i.test(resolved ?? '')) return 'local';
  if (hadCredentials) return 'external-url';
  if (/^(?:git\+|git:|github:|ssh\+git:)/i.test(resolved ?? '')) return 'git';
  if (resolved === null) return 'unknown';
  if (/^https?:/i.test(resolved)) {
    let url;
    try {
      url = new URL(resolved);
    } catch (cause) {
      throw new MynpmError('input', `invalid resolved URL: ${resolved}`, { cause });
    }
    if (url.protocol === 'https:' && url.hostname === 'registry.npmjs.org') return 'registry';
    return 'external-url';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(resolved)) return 'external-url';
  return 'local';
}

function parsePlatform(entry, label) {
  const result = {};
  for (const field of ['os', 'cpu', 'libc']) {
    const value = entry[field];
    if (value === undefined) {
      result[field] = null;
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.some(item => typeof item !== 'string' || item.length === 0)) {
      throw new MynpmError('input', `${label}.${field} must be a string or non-empty string array`);
    }
    result[field] = [...new Set(values)].sort();
  }
  return result;
}

function parseFlags(entry, label) {
  const flags = {};
  for (const field of ['dev', 'optional', 'peer', 'peerOptional', 'link']) {
    const value = field === 'link' ? entry.link : entry[field];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new MynpmError('input', `${label}.${field} must be a boolean`);
    }
    flags[field] = value ?? false;
  }
  return flags;
}

function exactTargetIds(targetIds) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    throw new MynpmError('input', 'at least one target ID is required for npm lockfile import');
  }
  const values = targetIds.map((targetId, index) => requireText(targetId, `targetIds[${index}]`));
  if (new Set(values).size !== values.length) throw new MynpmError('input', 'target IDs must be unique');
  return values.sort();
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeSpecifier(specifier, requestedName) {
  if (!specifier.startsWith('npm:')) return requestedName;
  const target = specifier.slice(4);
  let splitAt;
  if (target.startsWith('@')) splitAt = target.lastIndexOf('@');
  else splitAt = target.indexOf('@');
  return splitAt > 0 ? target.slice(0, splitAt) : target;
}

export function parseNpmLock(lock, { projectId, packageManagerPin = null, lockfilePath, targetIds }) {
  requireRecord(lock, 'npm lockfile');
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    throw new MynpmError('input', `npm lockfileVersion must be 2 or 3; received ${String(lock.lockfileVersion)}`);
  }
  requireText(projectId, 'project ID');
  requireText(lockfilePath, 'lockfile path');
  const targets = exactTargetIds(targetIds);
  const lockPackages = requireRecord(lock.packages, 'npm lockfile packages');
  const rootEntry = requireRecord(lockPackages[''], 'npm lockfile root package entry');
  const entries = Object.entries(lockPackages);
  const workspaceEntries = new Map(entries.filter(([key]) => packageNameFromKey(key) === null));
  const recordsByKey = new Map();
  const packages = [];

  for (const [key, entryValue] of entries) {
    const requestedName = packageNameFromKey(key);
    if (requestedName === null) continue;
    const label = `npm lockfile packages[${JSON.stringify(key)}]`;
    const entry = requireRecord(entryValue, label);
    const linkTarget = entry.link && typeof entry.resolved === 'string'
      ? workspaceEntries.get(entry.resolved.replace(/^file:/, ''))?.[1]
      : undefined;
    const name = requirePackageName(entry.name ?? linkTarget?.name ?? requestedName, `${label}.name`);
    const version = requireVersion(entry.version ?? linkTarget?.version, `${label}.version`, entry.link === true);
    const resolvedValue = entry.resolved === undefined ? null : requireText(entry.resolved, `${label}.resolved`);
    const { resolved, hadCredentials } = sanitizeResolved(resolvedValue, `${label}.resolved`);
    const integrity = requireIntegrity(entry.integrity, `${label}.integrity`);
    const link = entry.link ?? false;
    if (typeof link !== 'boolean') throw new MynpmError('input', `${label}.link must be a boolean`);
    const aliases = name === requestedName ? [] : [requestedName];
    const packageRecord = {
      key,
      name,
      version,
      integrity,
      resolved,
      sourceKind: classifySource(resolved, link, hadCredentials),
      aliases,
      flags: parseFlags(entry, label),
      platform: parsePlatform(entry, label),
      targets,
    };
    packages.push(packageRecord);
    recordsByKey.set(key, packageRecord);
  }

  const roots = [];
  for (const group of dependencyGroups) {
    const dependencies = rootEntry[group];
    if (dependencies === undefined) continue;
    requireRecord(dependencies, `npm lockfile root ${group}`);
    for (const [requestedName, specifierValue] of Object.entries(dependencies)) {
      requirePackageName(requestedName, `npm lockfile root ${group} package name`);
      const specifier = requireText(specifierValue, `npm lockfile root ${group}.${requestedName}`);
      const packageKey = `node_modules/${requestedName}`;
      const installed = recordsByKey.get(packageKey);
      const packageName = installed?.name ?? requirePackageName(normalizeSpecifier(specifier, requestedName), `npm lockfile root ${group}.${requestedName} target`);
      roots.push({
        importer: '.',
        requestedName,
        specifier,
        packageName,
        packageVersion: installed?.version ?? null,
        group,
        packageKey: installed ? packageKey : null,
      });
    }
  }

  packages.sort((left, right) => left.key.localeCompare(right.key));
  roots.sort((left, right) => left.group.localeCompare(right.group) || left.requestedName.localeCompare(right.requestedName));
  return freezeDeep({
    id: projectId,
    manager: 'npm',
    packageManagerPin,
    lockfilePath,
    lockfileVersion: lock.lockfileVersion,
    targets,
    roots,
    packages,
  });
}
