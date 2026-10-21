import { MynpmError } from './errors.mjs';
import { formatBytes, limits } from './limits.mjs';

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sourceKinds = new Set(['registry', 'local', 'git', 'external-url', 'unknown']);
const managers = new Set(['npm', 'pnpm']);
const groups = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
const integrityLengths = new Map([['sha1', 20], ['sha256', 32], ['sha384', 48], ['sha512', 64]]);
const packageManagerPinPattern = /^(npm|pnpm)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)(?:\+sha512\.[A-Za-z0-9+/=_-]+)?$/;
const sha512Pattern = /^[a-f0-9]{128}$/;
const sha1Pattern = /^[a-f0-9]{40}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message, category = 'corrupt') {
  throw new MynpmError(category, message);
}

function requireRecord(value, label, category) {
  if (!isRecord(value)) invalid(`${label} must be an object`, category);
  return value;
}

function exactKeys(value, keys, label, category) {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  const missing = keys.find(key => !Object.hasOwn(value, key));
  if (unknown !== undefined) invalid(`${label} has unknown field ${unknown}`, category);
  if (missing !== undefined) invalid(`${label} is missing field ${missing}`, category);
}

function requireText(value, label, category) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    invalid(`${label} must be a non-empty string`, category);
  }
  return value;
}

function requireList(value, label, category, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalid(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`, category);
  }
  if (value.some(item => typeof item !== 'string' || item.length === 0)) {
    invalid(`${label} must contain non-empty strings`, category);
  }
  if (new Set(value).size !== value.length) invalid(`${label} must not contain duplicates`, category);
  return [...value].sort();
}

function requireNullableText(value, label, category) {
  if (value !== null && typeof value !== 'string') invalid(`${label} must be a string or null`, category);
  return value === null ? null : requireText(value, label, category);
}

function normalizeImporter(value, label, category) {
  const importer = requireText(value, label, category);
  if (importer === '.') return importer;
  if (importer.startsWith('/') || importer.includes('\\') || importer.split('/').some(part => part === '' || part === '.' || part === '..')) {
    invalid(`${label} must be a safe project-relative path`, category);
  }
  return importer;
}

function validateIntegrity(value, label, category) {
  if (value === null) return null;
  requireText(value, label, category);
  const claims = new Map();
  for (const token of value.split(/\s+/)) {
    const [claim] = token.split('?', 1);
    const separator = claim.indexOf('-');
    const algorithm = claim.slice(0, separator);
    const digest = claim.slice(separator + 1);
    const length = integrityLengths.get(algorithm);
    if (!length || !/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) {
      invalid(`${label} contains an unsupported integrity token`, category);
    }
    const bytes = Buffer.from(digest, 'base64');
    if (bytes.length !== length || bytes.toString('base64') !== digest) {
      invalid(`${label} contains a malformed ${algorithm} digest`, category);
    }
    const hex = bytes.toString('hex');
    if (claims.has(algorithm) && claims.get(algorithm) !== hex) invalid(`${label} contains conflicting ${algorithm} claims`, category);
    claims.set(algorithm, hex);
  }
  return value;
}

function normalizeFlags(value, label, category) {
  requireRecord(value, label, category);
  const keys = ['dev', 'optional', 'peer', 'peerOptional', 'link'];
  exactKeys(value, keys, label, category);
  for (const key of keys) {
    if (typeof value[key] !== 'boolean') invalid(`${label}.${key} must be a boolean`, category);
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function normalizePlatform(value, label, category) {
  requireRecord(value, label, category);
  const keys = ['os', 'cpu', 'libc'];
  exactKeys(value, keys, label, category);
  return Object.fromEntries(keys.map(key => {
    if (value[key] === null) return [key, null];
    return [key, requireList(value[key], `${label}.${key}`, category)];
  }));
}

function normalizeMetadata(value, label, category, name, version) {
  if (value === null) return null;
  requireRecord(value, label, category);
  if (value.name !== name || value.version !== version) invalid(`${label} identity does not match ${name}@${String(version)}`, category);
  if (value.dist !== undefined) {
    requireRecord(value.dist, `${label}.dist`, category);
    if (value.dist.integrity !== undefined) validateIntegrity(value.dist.integrity, `${label}.dist.integrity`, category);
    if (value.dist.shasum !== undefined && (typeof value.dist.shasum !== 'string' || !sha1Pattern.test(value.dist.shasum))) {
      invalid(`${label}.dist.shasum must be a lowercase SHA-1 hex digest`, category);
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new MynpmError(category, `${label} is not JSON serializable`, { cause });
  }
  if (Buffer.byteLength(serialized, 'utf8') > limits.metadataBytes) invalid(`${label} exceeds the ${formatBytes(limits.metadataBytes)} metadata limit`, category);
  return canonicalValue(JSON.parse(serialized));
}

function normalizePackumentMetadata(value, label, category, name) {
  if (value === null) return null;
  requireRecord(value, label, category);
  if (value.name !== name || Object.hasOwn(value, 'versions')) invalid(`${label} identity or shape does not match ${name}`, category);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new MynpmError(category, `${label} is not JSON serializable`, { cause });
  }
  if (Buffer.byteLength(serialized, 'utf8') > limits.metadataBytes) invalid(`${label} exceeds the ${formatBytes(limits.metadataBytes)} metadata limit`, category);
  return canonicalValue(JSON.parse(serialized));
}

function normalizeArtifact(value, label, category, metadata) {
  if (value === null) return null;
  requireRecord(value, label, category);
  exactKeys(value, ['sha512', 'integrity', 'shasum', 'sourceUrl', 'legacySha1Only'], label, category);
  const sha512 = requireText(value.sha512, `${label}.sha512`, category);
  if (!sha512Pattern.test(sha512)) invalid(`${label}.sha512 must be a lowercase SHA-512 hex digest`, category);
  const integrity = requireText(value.integrity, `${label}.integrity`, category);
  const expectedIntegrity = `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;
  if (integrity !== expectedIntegrity) invalid(`${label}.integrity does not match ${label}.sha512`, category);
  const shasum = requireNullableText(value.shasum, `${label}.shasum`, category);
  if (shasum !== null && !sha1Pattern.test(shasum)) invalid(`${label}.shasum must be a lowercase SHA-1 hex digest`, category);
  const sourceUrl = requireText(value.sourceUrl, `${label}.sourceUrl`, category);
  let url;
  try {
    url = new URL(sourceUrl);
  } catch (cause) {
    throw new MynpmError(category, `${label}.sourceUrl must be a public npm HTTPS URL`, { cause });
  }
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    invalid(`${label}.sourceUrl must be a public npm HTTPS URL`, category);
  }
  if (metadata?.dist?.tarball !== sourceUrl) invalid(`${label}.sourceUrl does not match upstream metadata`, category);
  if (metadata?.dist?.shasum !== undefined && metadata.dist.shasum !== shasum) invalid(`${label}.shasum does not match upstream metadata`, category);
  if (typeof value.legacySha1Only !== 'boolean') invalid(`${label}.legacySha1Only must be a boolean`, category);
  return { sha512, integrity, shasum, sourceUrl, legacySha1Only: value.legacySha1Only };
}

function normalizeArtifactRecord(value, label, category) {
  requireRecord(value, label, category);
  exactKeys(value, ['name', 'version', 'packument', 'metadata', 'artifact'], label, category);
  const name = requireText(value.name, `${label}.name`, category);
  const version = requireText(value.version, `${label}.version`, category);
  if (!packageNamePattern.test(name) || !versionPattern.test(version)) invalid(`${label} has an invalid package identity`, category);
  const packument = normalizePackumentMetadata(value.packument, `${label}.packument`, category, name);
  const metadata = normalizeMetadata(value.metadata, `${label}.metadata`, category, name, version);
  const artifact = normalizeArtifact(value.artifact, `${label}.artifact`, category, metadata);
  if (packument === null || metadata === null || artifact === null) invalid(`${label} must include packument metadata, version metadata, and a verified artifact`, category);
  const metadataBytes = Buffer.byteLength(JSON.stringify({ packument, metadata }), 'utf8');
  if (metadataBytes > limits.metadataBytes) invalid(`${label} exceeds the ${formatBytes(limits.metadataBytes)} metadata limit`, category);
  return { name, version, packument, metadata, artifact };
}

function validateArtifactRecordDigests(record, category) {
  const claims = digestClaims(record.metadata.dist.integrity ?? null, `upstream metadata for ${record.name}@${record.version}`, category);
  if (record.metadata.dist.shasum !== undefined) {
    addDigestClaims(claims, new Map([['sha1', record.metadata.dist.shasum]]), `${record.name}@${record.version}`, category);
  }
  const legacySha1Only = claims.size > 0 && [...claims.keys()].every(algorithm => algorithm === 'sha1');
  if (record.artifact.legacySha1Only !== legacySha1Only) invalid(`legacy SHA-1 policy marker is inconsistent for ${record.name}@${record.version}`, category);
  addDigestClaims(claims, new Map([['sha512', record.artifact.sha512]]), `${record.name}@${record.version}`, category);
  if (record.artifact.shasum !== null) addDigestClaims(claims, new Map([['sha1', record.artifact.shasum]]), `${record.name}@${record.version}`, category);
}

export function validateArtifactRecord(value) {
  const record = normalizeArtifactRecord(value, 'verified artifact', 'corrupt');
  validateArtifactRecordDigests(record, 'corrupt');
  return freezeDeep(record);
}

function normalizePackage(value, label, category) {
  requireRecord(value, label, category);
  const keys = ['key', 'name', 'version', 'integrity', 'resolved', 'sourceKind', 'aliases', 'flags', 'platform', 'targets'];
  exactKeys(value, keys, label, category);
  const name = requireText(value.name, `${label}.name`, category);
  if (!packageNamePattern.test(name)) invalid(`${label}.name is not a valid package name`, category);
  const version = requireNullableText(value.version, `${label}.version`, category);
  if (version !== null && !versionPattern.test(version)) invalid(`${label}.version is not an exact package version`, category);
  const sourceKind = requireText(value.sourceKind, `${label}.sourceKind`, category);
  if (!sourceKinds.has(sourceKind)) invalid(`${label}.sourceKind is unsupported`, category);
  return {
    key: requireText(value.key, `${label}.key`, category),
    name,
    version,
    integrity: validateIntegrity(value.integrity, `${label}.integrity`, category),
    resolved: requireNullableText(value.resolved, `${label}.resolved`, category),
    sourceKind,
    aliases: requireList(value.aliases, `${label}.aliases`, category, true),
    flags: normalizeFlags(value.flags, `${label}.flags`, category),
    platform: normalizePlatform(value.platform, `${label}.platform`, category),
    targets: requireList(value.targets, `${label}.targets`, category),
  };
}

function normalizeRoot(value, label, category) {
  requireRecord(value, label, category);
  exactKeys(value, ['importer', 'requestedName', 'specifier', 'packageName', 'packageVersion', 'group', 'packageKey'], label, category);
  const requestedName = requireText(value.requestedName, `${label}.requestedName`, category);
  const packageName = requireText(value.packageName, `${label}.packageName`, category);
  if (!packageNamePattern.test(requestedName) || !packageNamePattern.test(packageName)) {
    invalid(`${label} contains an invalid package name`, category);
  }
  const packageVersion = requireNullableText(value.packageVersion, `${label}.packageVersion`, category);
  if (packageVersion !== null && !versionPattern.test(packageVersion)) {
    invalid(`${label}.packageVersion is not an exact package version`, category);
  }
  const group = requireText(value.group, `${label}.group`, category);
  if (!groups.has(group)) invalid(`${label}.group is unsupported`, category);
  return {
    importer: normalizeImporter(value.importer, `${label}.importer`, category),
    requestedName,
    specifier: requireText(value.specifier, `${label}.specifier`, category),
    packageName,
    packageVersion,
    group,
    packageKey: requireNullableText(value.packageKey, `${label}.packageKey`, category),
  };
}

function normalizeProject(value, label, category) {
  requireRecord(value, label, category);
  exactKeys(value, ['id', 'manager', 'packageManagerPin', 'lockfilePath', 'lockfileVersion', 'targets', 'roots', 'packages'], label, category);
  const manager = requireText(value.manager, `${label}.manager`, category);
  if (!managers.has(manager)) invalid(`${label}.manager is unsupported`, category);
  const packageManagerPin = requireNullableText(value.packageManagerPin, `${label}.packageManagerPin`, category);
  if (packageManagerPin !== null) {
    const match = packageManagerPinPattern.exec(packageManagerPin);
    if (!match || match[1] !== manager) invalid(`${label}.packageManagerPin does not match its package manager`, category);
  }
  if (manager === 'npm' && value.lockfileVersion !== 2 && value.lockfileVersion !== 3) {
    invalid(`${label}.lockfileVersion must be 2 or 3 for npm`, category);
  }
  if (manager === 'pnpm' && (typeof value.lockfileVersion !== 'string' || !/^\d+\.\d+$/.test(value.lockfileVersion))) {
    invalid(`${label}.lockfileVersion must be a major.minor string for pnpm`, category);
  }
  if (!Array.isArray(value.roots) || !Array.isArray(value.packages)) invalid(`${label} roots and packages must be arrays`, category);
  const roots = value.roots.map((root, index) => normalizeRoot(root, `${label}.roots[${index}]`, category));
  roots.sort((left, right) => left.importer.localeCompare(right.importer) || left.group.localeCompare(right.group) || left.requestedName.localeCompare(right.requestedName) || left.specifier.localeCompare(right.specifier));
  const packages = value.packages.map((pkg, index) => normalizePackage(pkg, `${label}.packages[${index}]`, category));
  packages.sort((left, right) => left.key.localeCompare(right.key) || left.name.localeCompare(right.name) || String(left.version).localeCompare(String(right.version)));
  const packageKeys = packages.map(pkg => pkg.key);
  if (new Set(packageKeys).size !== packageKeys.length) invalid(`${label}.packages contains duplicate lockfile keys`, category);
  return {
    id: requireText(value.id, `${label}.id`, category),
    manager,
    packageManagerPin,
    lockfilePath: requireText(value.lockfilePath, `${label}.lockfilePath`, category),
    lockfileVersion: value.lockfileVersion,
    targets: requireList(value.targets, `${label}.targets`, category),
    roots,
    packages,
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

function digestClaims(integrity, label, category) {
  const claims = new Map();
  if (integrity === null) return claims;
  for (const token of integrity.split(/\s+/)) {
    const [claim] = token.split('?', 1);
    const separator = claim.indexOf('-');
    const algorithm = claim.slice(0, separator);
    const digest = Buffer.from(claim.slice(separator + 1), 'base64').toString('hex');
    if (claims.has(algorithm) && claims.get(algorithm) !== digest) invalid(`${label} contains conflicting ${algorithm} claims`, category);
    claims.set(algorithm, digest);
  }
  return claims;
}

function addDigestClaims(target, source, label, category) {
  for (const [algorithm, digest] of source) {
    const existing = target.get(algorithm);
    if (existing !== undefined && existing !== digest) invalid(`conflicting ${algorithm} integrity for ${label}`, category);
    target.set(algorithm, digest);
  }
}

function validateDigestConflicts(projects, artifacts, category) {
  const claimsByIdentity = new Map();
  const sourcesByIdentity = new Map();
  for (const project of projects) {
    for (const pkg of project.packages) {
      if (pkg.version === null) continue;
      const identity = `${pkg.name}\0${pkg.version}`;
      const claims = claimsByIdentity.get(identity) ?? new Map();
      addDigestClaims(claims, digestClaims(pkg.integrity, `${pkg.name}@${pkg.version}`, category), `${pkg.name}@${pkg.version}`, category);
      claimsByIdentity.set(identity, claims);
      const sources = sourcesByIdentity.get(identity) ?? new Set();
      sources.add(pkg.sourceKind);
      sourcesByIdentity.set(identity, sources);
    }
  }
  for (const artifact of artifacts) {
    const identity = `${artifact.name}\0${artifact.version}`;
    const sources = sourcesByIdentity.get(identity);
    if (!sources || !sources.has('registry')) invalid(`verified artifact has no registry package record for ${artifact.name}@${artifact.version}`, category);
    if ([...sources].some(source => source !== 'registry')) invalid(`verified artifact conflicts with a non-registry source for ${artifact.name}@${artifact.version}`, category);
    const claims = claimsByIdentity.get(identity) ?? new Map();
    const upstreamClaims = digestClaims(artifact.metadata.dist.integrity ?? null, `upstream metadata for ${artifact.name}@${artifact.version}`, category);
    if (artifact.metadata.dist.shasum !== undefined) {
      if (typeof artifact.metadata.dist.shasum !== 'string' || !sha1Pattern.test(artifact.metadata.dist.shasum)) invalid(`upstream shasum is malformed for ${artifact.name}@${artifact.version}`, category);
      addDigestClaims(upstreamClaims, new Map([['sha1', artifact.metadata.dist.shasum]]), `${artifact.name}@${artifact.version}`, category);
    }
    addDigestClaims(claims, upstreamClaims, `${artifact.name}@${artifact.version}`, category);
    const legacySha1Only = claims.size > 0 && [...claims.keys()].every(algorithm => algorithm === 'sha1');
    if (artifact.artifact.legacySha1Only !== legacySha1Only) invalid(`legacy SHA-1 policy marker is inconsistent for ${artifact.name}@${artifact.version}`, category);
    for (const [algorithm, digest] of [['sha512', artifact.artifact.sha512], ['sha1', artifact.artifact.shasum]]) {
      if (digest === null) continue;
      addDigestClaims(claims, new Map([[algorithm, digest]]), `${artifact.name}@${artifact.version}`, category);
    }
    claimsByIdentity.set(identity, claims);
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function createEmptyInventory() {
  return freezeDeep({ schemaVersion: 1, projects: [], artifacts: [] });
}

export function parseInventory(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('corrupt', 'inventory is not valid JSON', { cause });
  }
  requireRecord(value, 'inventory', 'corrupt');
  exactKeys(value, ['schemaVersion', 'projects', 'artifacts'], 'inventory', 'corrupt');
  if (value.schemaVersion !== 1) invalid(`unsupported inventory schemaVersion: ${String(value.schemaVersion)}`, 'corrupt');
  if (!Array.isArray(value.projects) || !Array.isArray(value.artifacts)) invalid('inventory projects and artifacts must be arrays', 'corrupt');
  const projects = value.projects.map((project, index) => normalizeProject(project, `inventory.projects[${index}]`, 'corrupt'));
  projects.sort((left, right) => left.id.localeCompare(right.id) || left.lockfilePath.localeCompare(right.lockfilePath) || left.manager.localeCompare(right.manager) || String(left.lockfileVersion).localeCompare(String(right.lockfileVersion)) || left.targets.join(',').localeCompare(right.targets.join(',')));
  const artifacts = value.artifacts.map((artifact, index) => normalizeArtifactRecord(artifact, `inventory.artifacts[${index}]`, 'corrupt'));
  artifacts.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const artifactIdentities = artifacts.map(artifact => `${artifact.name}\0${artifact.version}`);
  if (new Set(artifactIdentities).size !== artifactIdentities.length) invalid('inventory contains duplicate verified artifact identities', 'corrupt');
  validateDigestConflicts(projects, artifacts, 'corrupt');
  const identities = projects.map(stableStringify);
  if (new Set(identities).size !== identities.length) invalid('inventory contains duplicate project imports', 'corrupt');
  return freezeDeep({ schemaVersion: 1, projects, artifacts });
}

export function mergeProject(inventory, project) {
  const checkedInventory = isRecord(inventory) && typeof inventory.schemaVersion === 'number'
    ? parseInventory(JSON.stringify(inventory))
    : invalid('inventory is malformed', 'corrupt');
  const checkedProject = normalizeProject(project, 'imported project', 'input');
  if (checkedInventory.projects.some(existing => stableStringify(existing) === stableStringify(checkedProject))) return checkedInventory;
  const projects = [...checkedInventory.projects, checkedProject];
  validateDigestConflicts(projects, checkedInventory.artifacts, 'conflict');
  return parseInventory(JSON.stringify({ schemaVersion: 1, projects, artifacts: checkedInventory.artifacts }));
}

export function recordVerifiedArtifact(inventory, value) {
  const checkedInventory = isRecord(inventory) && typeof inventory.schemaVersion === 'number'
    ? parseInventory(JSON.stringify(inventory))
    : invalid('inventory is malformed', 'corrupt');
  const checkedArtifact = normalizeArtifactRecord(value, 'verified artifact', 'input');
  const identity = `${checkedArtifact.name}\0${checkedArtifact.version}`;
  const existing = checkedInventory.artifacts.find(item => `${item.name}\0${item.version}` === identity);
  if (existing && stableStringify(existing) !== stableStringify(checkedArtifact)) {
    throw new MynpmError('conflict', `verified artifact conflicts for ${checkedArtifact.name}@${checkedArtifact.version}`);
  }
  const artifacts = existing ? checkedInventory.artifacts : [...checkedInventory.artifacts, checkedArtifact];
  validateDigestConflicts(checkedInventory.projects, artifacts, 'conflict');
  return parseInventory(JSON.stringify({ schemaVersion: 1, projects: checkedInventory.projects, artifacts }));
}

export function serializeInventory(inventory) {
  const checked = isRecord(inventory) && typeof inventory.schemaVersion === 'number'
    ? parseInventory(JSON.stringify(inventory))
    : invalid('inventory is malformed', 'corrupt');
  return `${JSON.stringify(canonicalValue(checked), null, 2)}\n`;
}
