import { MynpmError } from './errors.mjs';

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const integrityLengths = new Map([['sha1', 20], ['sha256', 32], ['sha384', 48], ['sha512', 64]]);
const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function invalid(message) {
  throw new MynpmError('input', message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePackageName(value, label) {
  requireText(value, label);
  if (!packageNamePattern.test(value)) invalid(`${label} is not a valid package name`);
  return value;
}

function parseIntegrity(value, label) {
  if (value === undefined) return null;
  requireText(value, label);
  const tokens = value.split(/\s+/);
  const claims = new Map();
  for (const token of tokens) {
    const [claim] = token.split('?', 1);
    const separator = claim.indexOf('-');
    const algorithm = claim.slice(0, separator);
    const digest = claim.slice(separator + 1);
    const length = integrityLengths.get(algorithm);
    if (!length || !/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) invalid(`${label} contains an unsupported integrity token`);
    const bytes = Buffer.from(digest, 'base64');
    if (bytes.length !== length || bytes.toString('base64') !== digest) invalid(`${label} contains a malformed ${algorithm} digest`);
    const hex = bytes.toString('hex');
    if (claims.has(algorithm) && claims.get(algorithm) !== hex) invalid(`${label} contains conflicting ${algorithm} claims`);
    claims.set(algorithm, hex);
  }
  return value;
}

function packageIdentity(key, label) {
  requireText(key, label);
  const normalizedKey = key.startsWith('/') ? key.slice(1) : key;
  const slash = normalizedKey.startsWith('@') ? normalizedKey.indexOf('/') : -1;
  const separator = normalizedKey.indexOf('@', slash >= 0 ? slash + 1 : 0);
  if (separator <= 0 || separator === normalizedKey.length - 1) invalid(`${label} has no package reference`);
  const name = requirePackageName(normalizedKey.slice(0, separator), `${label} package name`);
  const reference = normalizedKey.slice(separator + 1);
  const version = reference.split('(', 1)[0];
  return { name, version: versionPattern.test(version) ? version : null, reference };
}

function sanitizeUrl(value, label) {
  if (value === undefined) return { url: null, hadCredentials: false };
  requireText(value, label);
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new MynpmError('input', `${label} is not a valid absolute URL`, { cause });
  }
  const hadCredentials = url.username !== '' || url.password !== '' || url.search !== '';
  if (hadCredentials) {
    url.username = '';
    url.password = '';
    url.search = '';
  }
  url.hash = '';
  return { url: url.href, hadCredentials };
}

function sourceKind(resolution, reference, url, hadCredentials) {
  if (resolution.type === 'directory' || typeof resolution.directory === 'string' || /^(?:file|link|workspace):/i.test(reference)) return 'local';
  if (hadCredentials) return 'external-url';
  if (resolution.type === 'git' || typeof resolution.commit === 'string' || /^(?:git\+|git:|github:|ssh\+git:)/i.test(reference)) return 'git';
  if (url === null) return 'registry';
  if (url.startsWith('file:')) return 'local';
  let parsed;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new MynpmError('input', 'pnpm lockfile contains an invalid tarball URL', { cause });
  }
  return parsed.protocol === 'https:' && parsed.hostname === 'registry.npmjs.org' ? 'registry' : 'external-url';
}

function parsePlatform(entry, label) {
  const platform = {};
  for (const field of ['os', 'cpu', 'libc']) {
    const value = entry[field];
    if (value === undefined) {
      platform[field] = null;
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.some(item => typeof item !== 'string' || item.length === 0)) {
      invalid(`${label}.${field} must be a string or non-empty string array`);
    }
    platform[field] = [...new Set(values)].sort();
  }
  return platform;
}

function parseFlags(entry, label) {
  const flags = {};
  for (const field of ['dev', 'optional', 'peer', 'peerOptional']) {
    const value = entry[field];
    if (value !== undefined && typeof value !== 'boolean') invalid(`${label}.${field} must be a boolean`);
    flags[field] = value ?? false;
  }
  flags.link = entry.resolution?.type === 'directory';
  return flags;
}

function normalizeTargets(targetIds) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) invalid('at least one target ID is required for pnpm lockfile import');
  const targets = targetIds.map((id, index) => requireText(id, `targetIds[${index}]`));
  if (new Set(targets).size !== targets.length) invalid('target IDs must be unique');
  return targets.sort();
}

function lockfileDocuments(values) {
  if (!Array.isArray(values) || values.length === 0) invalid('pnpm lockfile must contain at least one YAML document');
  const documents = values.map((value, index) => requireRecord(value, `pnpm lockfile document ${index + 1}`));
  const version = documents[0].lockfileVersion;
  if (version !== '9.0') invalid(`pnpm lockfileVersion must be '9.0'; received ${String(version)}`);
  for (const [index, document] of documents.entries()) {
    if (document.lockfileVersion !== version) invalid(`pnpm lockfile document ${index + 1} has a different lockfileVersion`);
    if (document.packages !== undefined) requireRecord(document.packages, `pnpm lockfile document ${index + 1}.packages`);
    if (document.snapshots !== undefined) requireRecord(document.snapshots, `pnpm lockfile document ${index + 1}.snapshots`);
    if (document.importers !== undefined) requireRecord(document.importers, `pnpm lockfile document ${index + 1}.importers`);
  }
  return documents;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function snapshotReference(key) {
  requireText(key, 'pnpm snapshot key');
  return key.startsWith('/') ? key.slice(1) : key;
}

function packageReferenceMatches(reference, requestedName, packageRecord) {
  const packageKey = packageRecord.key.startsWith('/') ? packageRecord.key.slice(1) : packageRecord.key;
  const candidate = reference.startsWith('npm:') ? reference.slice(4) : reference;
  if (candidate === packageKey || candidate === `/${packageKey}`) return true;
  const identity = packageIdentity(packageRecord.key, 'pnpm package key');
  if (candidate.includes('@')) {
    try {
      const referenced = packageIdentity(candidate, 'pnpm importer package reference');
      return referenced.name === identity.name && referenced.reference === identity.reference;
    } catch (error) {
      if (!(error instanceof MynpmError)) throw error;
    }
  }
  if (identity.name === requestedName && candidate === identity.reference) return true;
  return candidate === identity.version && identity.name === requestedName;
}

function parsePackageEntry(key, entryValue, targets) {
  const label = `pnpm lockfile packages[${JSON.stringify(key)}]`;
  const identity = packageIdentity(key, label);
  const entry = requireRecord(entryValue, label);
  const resolution = requireRecord(entry.resolution, `${label}.resolution`);
  if (resolution.revision !== undefined && (!Number.isInteger(resolution.revision) || resolution.revision < 0)) {
    invalid(`${label}.resolution.revision must be a non-negative integer`);
  }
  if (resolution.revision !== undefined && resolution.revision !== 0) {
    invalid(`${label} uses unsupported resolution revision ${resolution.revision}`);
  }
  const integrity = parseIntegrity(resolution.integrity, `${label}.resolution.integrity`);
  const { url, hadCredentials } = sanitizeUrl(resolution.tarball, `${label}.resolution.tarball`);
  const name = requirePackageName(entry.name ?? identity.name, `${label}.name`);
  const versionValue = entry.version ?? identity.version;
  const version = versionValue === null || versionValue === undefined ? null : requireText(versionValue, `${label}.version`);
  if (version !== null && !versionPattern.test(version)) invalid(`${label}.version is not an exact package version`);
  const source = sourceKind(resolution, identity.reference, url, hadCredentials);
  const aliases = name === identity.name ? [] : [identity.name];
  return {
    key,
    name,
    version,
    integrity,
    resolved: url,
    sourceKind: source,
    aliases,
    flags: parseFlags(entry, label),
    platform: parsePlatform(entry, label),
    targets,
  };
}

function importerRoots(document, packageEntries, importerLabel) {
  const roots = [];
  const importers = document.importers ?? {};
  requireRecord(importers, `${importerLabel}.importers`);
  for (const [importerPath, importerValue] of Object.entries(importers)) {
    requireText(importerPath, `${importerLabel}.importers path`);
    const importer = requireRecord(importerValue, `${importerLabel}.importers[${JSON.stringify(importerPath)}]`);
    for (const group of dependencyGroups) {
      const dependencies = importer[group];
      if (dependencies === undefined) continue;
      requireRecord(dependencies, `${importerLabel}.importers[${JSON.stringify(importerPath)}].${group}`);
      for (const [requestedName, entryValue] of Object.entries(dependencies)) {
        requirePackageName(requestedName, `${importerLabel}.importers dependency name`);
        const dependency = typeof entryValue === 'string' ? { specifier: entryValue, version: entryValue } : requireRecord(entryValue, `${importerLabel}.importers dependency`);
        const specifier = requireText(dependency.specifier, `${importerLabel}.importers dependency specifier`);
        const reference = requireText(dependency.version, `${importerLabel}.importers dependency version`);
        const match = [...packageEntries.values()].find(pkg => packageReferenceMatches(reference, requestedName, pkg));
        let packageName = requestedName;
        let packageVersion = null;
        let packageKey = null;
        if (match) {
          packageName = match.name;
          packageVersion = match.version;
          packageKey = match.key;
        } else if (/^(?:link|file|workspace):/i.test(reference)) {
          packageVersion = null;
        } else {
          const target = reference.startsWith('npm:') ? reference.slice(4) : reference;
          const separator = target.startsWith('@') ? target.indexOf('@', target.indexOf('/') + 1) : target.indexOf('@');
          if (separator > 0) {
            packageName = requirePackageName(target.slice(0, separator), `${importerLabel} dependency target`);
            packageVersion = target.slice(separator + 1).split('(', 1)[0];
            if (!versionPattern.test(packageVersion)) packageVersion = null;
          } else if (versionPattern.test(target)) {
            packageVersion = target;
          }
        }
        roots.push({ importer: importerPath, requestedName, specifier, packageName, packageVersion, group, packageKey });
      }
    }
  }
  return roots;
}

function parsePnpmDocuments(values, { projectId, packageManagerPin = null, lockfilePath, targetIds }) {
  const documents = lockfileDocuments(values);
  const targets = normalizeTargets(targetIds);
  const packagesByKey = new Map();
  const snapshotKeys = new Set();
  const roots = [];
  for (const [index, document] of documents.entries()) {
    const documentPackages = document.packages ?? {};
    requireRecord(documentPackages, `pnpm lockfile document ${index + 1}.packages`);
    for (const [key, entry] of Object.entries(documentPackages)) {
      const parsed = parsePackageEntry(key, entry, targets);
      const prior = packagesByKey.get(key);
      if (prior && JSON.stringify(canonicalValue(prior)) !== JSON.stringify(canonicalValue(parsed))) {
        throw new MynpmError('conflict', `pnpm lockfile documents disagree about package ${key}`);
      }
      packagesByKey.set(key, parsed);
    }
    const snapshots = document.snapshots ?? {};
    requireRecord(snapshots, `pnpm lockfile document ${index + 1}.snapshots`);
    for (const [key, snapshotValue] of Object.entries(snapshots)) {
      const snapshot = requireRecord(snapshotValue, `pnpm lockfile snapshots[${JSON.stringify(key)}]`);
      for (const group of ['dependencies', 'optionalDependencies']) {
        if (snapshot[group] !== undefined) requireRecord(snapshot[group], `pnpm lockfile snapshots[${JSON.stringify(key)}].${group}`);
      }
      snapshotKeys.add(snapshotReference(key));
    }
    roots.push(...importerRoots(document, packagesByKey, `pnpm lockfile document ${index + 1}`));
  }
  for (const snapshot of snapshotKeys) {
    if (![...packagesByKey.keys()].some(key => snapshotReference(key) === snapshot)) {
      invalid(`pnpm snapshot has no matching package entry: ${snapshot}`);
    }
  }
  const uniqueRoots = new Map();
  for (const root of roots) {
    const key = JSON.stringify(root);
    uniqueRoots.set(key, root);
  }
  return {
    id: requireText(projectId, 'project ID'),
    manager: 'pnpm',
    packageManagerPin,
    lockfilePath: requireText(lockfilePath, 'lockfile path'),
    lockfileVersion: documents[0].lockfileVersion,
    targets,
    roots: [...uniqueRoots.values()].sort((left, right) => left.importer.localeCompare(right.importer) || left.group.localeCompare(right.group) || left.requestedName.localeCompare(right.requestedName)),
    packages: [...packagesByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

async function decodePnpmDocuments(text) {
  let yaml;
  try {
    yaml = await import('yaml');
  } catch (cause) {
    if (cause.code === 'ERR_MODULE_NOT_FOUND') {
      throw new MynpmError('operation', 'pnpm lockfile import requires the pinned yaml@2.9.1 dependency; install locked project dependencies', { cause });
    }
    throw cause;
  }
  let documents;
  try {
    documents = yaml.parseAllDocuments(text, { uniqueKeys: true });
  } catch (cause) {
    throw new MynpmError('input', 'pnpm lockfile is not valid YAML', { cause });
  }
  const parseErrors = documents.flatMap(document => document.errors);
  if (parseErrors.length > 0) throw new MynpmError('input', `pnpm lockfile contains invalid YAML: ${parseErrors[0].message}`, { cause: parseErrors[0] });
  const values = documents.map((document, index) => {
    if (document.contents === null) invalid(`pnpm lockfile document ${index + 1} is empty`);
    try {
      return document.toJS({ maxAliasCount: 100 });
    } catch (cause) {
      throw new MynpmError('input', `pnpm lockfile document ${index + 1} cannot be decoded`, { cause });
    }
  });
  return values;
}

export async function parsePnpmLock(text, options) {
  return parsePnpmDocuments(await decodePnpmDocuments(text), options);
}

export async function pnpmBuildPackageKeys(text) {
  const documents = await decodePnpmDocuments(text);
  const keys = new Set();
  for (const [index, document] of documents.entries()) {
    const packages = document.packages ?? {};
    requireRecord(packages, `pnpm lockfile document ${index + 1}.packages`);
    for (const [key, entryValue] of Object.entries(packages)) {
      const entry = requireRecord(entryValue, `pnpm lockfile document ${index + 1}.packages[${JSON.stringify(key)}]`);
      if (entry.requiresBuild === true) keys.add(key);
    }
  }
  return [...keys].sort();
}

export { parsePnpmDocuments };
