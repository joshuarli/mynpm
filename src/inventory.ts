import { MynpmError } from './errors.ts';
import type { ErrorCategory } from './errors.ts';
import { formatBytes, limits } from './limits.ts';

const packageManagers = ['npm', 'pnpm'] as const;
const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const packageSourceKinds = ['registry', 'local', 'git', 'external-url', 'unknown'] as const;

export type PackageManager = typeof packageManagers[number];
export type DependencyGroup = typeof dependencyGroups[number];
export type PackageSourceKind = typeof packageSourceKinds[number];
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface PackageFlags {
  dev: boolean;
  optional: boolean;
  peer: boolean;
  peerOptional: boolean;
  link: boolean;
}

export interface PlatformConstraints {
  os: string[] | null;
  cpu: string[] | null;
  libc: string[] | null;
}

export interface ProjectSnapshotFile {
  path: string;
  contents: string;
}

export interface ProjectSnapshot {
  manifest: string | null;
  lockfile: string;
  workspaceFiles: ProjectSnapshotFile[];
}

export interface PackageRecord {
  key: string;
  name: string;
  version: string | null;
  integrity: string | null;
  resolved: string | null;
  sourceKind: PackageSourceKind;
  aliases: string[];
  flags: PackageFlags;
  platform: PlatformConstraints;
  targets: string[];
}

export interface RootDependency {
  importer: string;
  requestedName: string;
  specifier: string;
  packageName: string;
  packageVersion: string | null;
  group: DependencyGroup;
  packageKey: string | null;
}

interface ProjectFields {
  id: string;
  packageManagerPin: string | null;
  lockfilePath: string;
  targets: string[];
  importers: string[];
  roots: RootDependency[];
  packages: PackageRecord[];
  snapshot: ProjectSnapshot | null;
}

export type ProjectRecord = ProjectFields & (
  | { manager: 'npm'; lockfileVersion: 2 | 3 }
  | { manager: 'pnpm'; lockfileVersion: string }
);

export interface PackageDistMetadata extends JsonObject {
  tarball?: JsonValue;
  integrity?: string;
  shasum?: string;
}

export interface VersionMetadata extends JsonObject {
  name: string;
  version: string;
  dist?: PackageDistMetadata;
}

export interface VerifiedVersionMetadata extends VersionMetadata {
  dist: PackageDistMetadata & { tarball: string };
}

export interface PackumentMetadata extends JsonObject {
  name: string;
}

export interface ArtifactVerification {
  sha512: string;
  integrity: string;
  shasum: string | null;
  sourceUrl: string;
  legacySha1Only: boolean;
}

export interface ArtifactRecord {
  name: string;
  version: string;
  packument: PackumentMetadata;
  metadata: VerifiedVersionMetadata;
  artifact: ArtifactVerification;
}

export interface Inventory {
  schemaVersion: 2;
  projects: ProjectRecord[];
  artifacts: ArtifactRecord[];
}

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const inventorySchemaVersion = 2;
const integrityLengths = new Map([['sha1', 20], ['sha256', 32], ['sha384', 48], ['sha512', 64]]);
const packageManagerPinPattern = /^(npm|pnpm)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)(?:\+sha512\.[A-Za-z0-9+/=_-]+)?$/;
const sha512Pattern = /^[a-f0-9]{128}$/;
const sha1Pattern = /^[a-f0-9]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isMemberOf<const Values extends readonly string[]>(value: string, values: Values): value is Values[number] {
  return values.some(candidate => candidate === value);
}

function invalid(message: string, category: ErrorCategory = 'corrupt'): never {
  throw new MynpmError(category, message);
}

function requireRecord(value: unknown, label: string, category: ErrorCategory): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object`, category);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, category: ErrorCategory): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  const missing = keys.find(key => !Object.hasOwn(value, key));
  if (unknown !== undefined) invalid(`${label} has unknown field ${unknown}`, category);
  if (missing !== undefined) invalid(`${label} is missing field ${missing}`, category);
}

function requireText(value: unknown, label: string, category: ErrorCategory): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    invalid(`${label} must be a non-empty string`, category);
  }
  return value;
}

function requireContents(value: unknown, label: string, category: ErrorCategory): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`, category);
  return value;
}

function requireList(value: unknown, label: string, category: ErrorCategory, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalid(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`, category);
  }
  const items: unknown[] = value;
  if (!items.every(isNonEmptyString)) {
    invalid(`${label} must contain non-empty strings`, category);
  }
  const strings = items.map(item => isNonEmptyString(item) ? item : invalid(`${label} must contain non-empty strings`, category));
  if (new Set(strings).size !== strings.length) invalid(`${label} must not contain duplicates`, category);
  return strings.sort();
}

function requireNullableText(value: unknown, label: string, category: ErrorCategory): string | null {
  if (value !== null && typeof value !== 'string') invalid(`${label} must be a string or null`, category);
  return value === null ? null : requireText(value, label, category);
}

function normalizeImporter(value: unknown, label: string, category: ErrorCategory): string {
  const importer = requireText(value, label, category);
  if (importer === '.') return importer;
  if (importer.startsWith('/') || importer.includes('\\') || importer.split('/').some(part => part === '' || part === '.' || part === '..')) {
    invalid(`${label} must be a safe project-relative path`, category);
  }
  return importer;
}

function normalizeSnapshotPath(value: unknown, label: string, category: ErrorCategory): string {
  const path = requireText(value, label, category);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    invalid(`${label} must be a safe project-relative path`, category);
  }
  return path;
}

function normalizeSnapshot(value: unknown, label: string, category: ErrorCategory, manager: PackageManager, lockfileVersion: string | 2 | 3): ProjectSnapshot | null {
  if (value === null) return null;
  const record = requireRecord(value, label, category);
  exactKeys(record, ['manifest', 'lockfile', 'workspaceFiles'], label, category);
  const manifestValue = record.manifest;
  const manifest = manifestValue === null ? null : requireContents(manifestValue, `${label}.manifest`, category);
  if (manifest !== null) {
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(manifest);
    } catch (cause) {
      throw new MynpmError(category, `${label}.manifest is not valid JSON`, { cause });
    }
    if (!isRecord(parsedManifest)) invalid(`${label}.manifest must contain an object`, category);
  }
  const lockfile = requireContents(record.lockfile, `${label}.lockfile`, category);
  if (lockfile.length === 0) invalid(`${label}.lockfile must not be empty`, category);
  if (manager === 'npm') {
    let parsedLockfile: unknown;
    try {
      parsedLockfile = JSON.parse(lockfile);
    } catch (cause) {
      throw new MynpmError(category, `${label}.lockfile is not valid JSON`, { cause });
    }
    if (!isRecord(parsedLockfile) || parsedLockfile.lockfileVersion !== lockfileVersion) {
      invalid(`${label}.lockfile does not match its npm project`, category);
    }
  }
  if (!Array.isArray(record.workspaceFiles)) invalid(`${label}.workspaceFiles must be an array`, category);
  const workspaceFiles: ProjectSnapshotFile[] = record.workspaceFiles.map((file: unknown, index: number): ProjectSnapshotFile => {
    const fileLabel = `${label}.workspaceFiles[${index}]`;
    const fileRecord = requireRecord(file, fileLabel, category);
    exactKeys(fileRecord, ['path', 'contents'], fileLabel, category);
    const path = normalizeSnapshotPath(fileRecord.path, `${fileLabel}.path`, category);
    if (!path.endsWith('/package.json') && !(manager === 'pnpm' && path === 'pnpm-workspace.yaml')) {
      invalid(`${fileLabel}.path is not a workspace manifest or pnpm workspace configuration`, category);
    }
    if (path === 'package.json' || path === (manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml')) {
      invalid(`${fileLabel}.path duplicates a project snapshot file`, category);
    }
    const contents = requireContents(fileRecord.contents, `${fileLabel}.contents`, category);
    if (path.endsWith('/package.json')) {
      let parsedManifest: unknown;
      try {
        parsedManifest = JSON.parse(contents);
      } catch (cause) {
        throw new MynpmError(category, `${fileLabel}.contents is not valid JSON`, { cause });
      }
      if (!isRecord(parsedManifest)) invalid(`${fileLabel}.contents must contain an object`, category);
    }
    return { path, contents };
  });
  workspaceFiles.sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(workspaceFiles.map(file => file.path)).size !== workspaceFiles.length) {
    invalid(`${label}.workspaceFiles contains duplicate paths`, category);
  }
  return { manifest, lockfile, workspaceFiles };
}

function validateIntegrity(value: unknown, label: string, category: ErrorCategory): string | null {
  if (value === null) return null;
  const integrity = requireText(value, label, category);
  const claims = new Map<string, string>();
  for (const token of integrity.split(/\s+/)) {
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
  return integrity;
}

function normalizeFlags(value: unknown, label: string, category: ErrorCategory): PackageFlags {
  const record = requireRecord(value, label, category);
  const keys = ['dev', 'optional', 'peer', 'peerOptional', 'link'] as const;
  exactKeys(record, keys, label, category);
  const dev = record.dev;
  const optional = record.optional;
  const peer = record.peer;
  const peerOptional = record.peerOptional;
  const link = record.link;
  if (typeof dev !== 'boolean') invalid(`${label}.dev must be a boolean`, category);
  if (typeof optional !== 'boolean') invalid(`${label}.optional must be a boolean`, category);
  if (typeof peer !== 'boolean') invalid(`${label}.peer must be a boolean`, category);
  if (typeof peerOptional !== 'boolean') invalid(`${label}.peerOptional must be a boolean`, category);
  if (typeof link !== 'boolean') invalid(`${label}.link must be a boolean`, category);
  return { dev, optional, peer, peerOptional, link };
}

function normalizePlatform(value: unknown, label: string, category: ErrorCategory): PlatformConstraints {
  const record = requireRecord(value, label, category);
  const keys = ['os', 'cpu', 'libc'] as const;
  exactKeys(record, keys, label, category);
  const readConstraint = (key: typeof keys[number]): string[] | null => record[key] === null
    ? null
    : requireList(record[key], `${label}.${key}`, category);
  return { os: readConstraint('os'), cpu: readConstraint('cpu'), libc: readConstraint('libc') };
}

function normalizeJsonValue(value: unknown, label: string, category: ErrorCategory): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item: unknown, index: number) => normalizeJsonValue(item, `${label}[${index}]`, category));
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) result[key] = normalizeJsonValue(item, `${label}.${key}`, category);
    return result;
  }
  invalid(`${label} is not JSON serializable`, category);
}

function normalizeJsonObject(value: unknown, label: string, category: ErrorCategory): JsonObject {
  if (!isRecord(value)) invalid(`${label} must be an object`, category);
  const normalized: JsonObject = {};
  for (const [key, item] of Object.entries(value)) normalized[key] = normalizeJsonValue(item, `${label}.${key}`, category);
  return normalized;
}

function sortJsonObject(value: JsonObject): JsonObject {
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return sorted;
}

function canonicalJsonObject(value: Record<string, unknown>, label: string, category: ErrorCategory): JsonObject {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new MynpmError(category, `${label} is not JSON serializable`, { cause });
  }
  if (serialized === undefined) invalid(`${label} is not JSON serializable`, category);
  const parsed: unknown = JSON.parse(serialized);
  const object = normalizeJsonObject(parsed, label, category);
  return sortJsonObject(object);
}

function normalizeMetadata(value: unknown, label: string, category: ErrorCategory, name: string, version: string): VersionMetadata | null {
  if (value === null) return null;
  const record = requireRecord(value, label, category);
  const canonical = canonicalJsonObject(record, label, category);
  if (canonical.name !== name || canonical.version !== version) invalid(`${label} identity does not match ${name}@${String(version)}`, category);
  let normalizedDist: PackageDistMetadata | undefined;
  if (canonical.dist !== undefined) {
    const dist = normalizeJsonObject(canonical.dist, `${label}.dist`, category);
    normalizedDist = { ...dist };
    if (dist.integrity !== undefined) {
      const integrity = validateIntegrity(dist.integrity, `${label}.dist.integrity`, category);
      if (integrity !== null) normalizedDist.integrity = integrity;
    }
    if (dist.shasum !== undefined) {
      if (typeof dist.shasum !== 'string' || !sha1Pattern.test(dist.shasum)) {
        invalid(`${label}.dist.shasum must be a lowercase SHA-1 hex digest`, category);
      }
      normalizedDist.shasum = dist.shasum;
    }
    canonical.dist = normalizedDist;
  }
  const serialized = JSON.stringify(canonical) ?? invalid(`${label} is not JSON serializable`, category);
  if (Buffer.byteLength(serialized, 'utf8') > limits.metadataBytes) invalid(`${label} exceeds the ${formatBytes(limits.metadataBytes)} metadata limit`, category);
  const normalizedName = canonical.name;
  const normalizedVersion = canonical.version;
  if (typeof normalizedName !== 'string' || typeof normalizedVersion !== 'string') invalid(`${label} identity does not match ${name}@${String(version)}`, category);
  const metadata: VersionMetadata = { ...canonical, name: normalizedName, version: normalizedVersion };
  if (normalizedDist !== undefined) metadata.dist = normalizedDist;
  return metadata;
}

function normalizePackumentMetadata(value: unknown, label: string, category: ErrorCategory, name: string): PackumentMetadata | null {
  if (value === null) return null;
  const record = requireRecord(value, label, category);
  const canonical = canonicalJsonObject(record, label, category);
  if (canonical.name !== name || Object.hasOwn(canonical, 'versions')) invalid(`${label} identity or shape does not match ${name}`, category);
  const serialized = JSON.stringify(canonical) ?? invalid(`${label} is not JSON serializable`, category);
  if (Buffer.byteLength(serialized, 'utf8') > limits.metadataBytes) invalid(`${label} exceeds the ${formatBytes(limits.metadataBytes)} metadata limit`, category);
  const normalizedName = canonical.name;
  if (typeof normalizedName !== 'string') invalid(`${label} identity or shape does not match ${name}`, category);
  return { ...canonical, name: normalizedName };
}

interface NormalizedArtifact {
  metadata: VerifiedVersionMetadata;
  artifact: ArtifactVerification;
}

function normalizeArtifact(value: unknown, label: string, category: ErrorCategory, metadata: VersionMetadata | null): NormalizedArtifact | null {
  if (value === null) return null;
  const record = requireRecord(value, label, category);
  exactKeys(record, ['sha512', 'integrity', 'shasum', 'sourceUrl', 'legacySha1Only'], label, category);
  const sha512 = requireText(record.sha512, `${label}.sha512`, category);
  if (!sha512Pattern.test(sha512)) invalid(`${label}.sha512 must be a lowercase SHA-512 hex digest`, category);
  const integrity = requireText(record.integrity, `${label}.integrity`, category);
  const expectedIntegrity = `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;
  if (integrity !== expectedIntegrity) invalid(`${label}.integrity does not match ${label}.sha512`, category);
  const shasum = requireNullableText(record.shasum, `${label}.shasum`, category);
  if (shasum !== null && !sha1Pattern.test(shasum)) invalid(`${label}.shasum must be a lowercase SHA-1 hex digest`, category);
  const sourceUrl = requireText(record.sourceUrl, `${label}.sourceUrl`, category);
  let url;
  try {
    url = new URL(sourceUrl);
  } catch (cause) {
    throw new MynpmError(category, `${label}.sourceUrl must be a public npm HTTPS URL`, { cause });
  }
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    invalid(`${label}.sourceUrl must be a public npm HTTPS URL`, category);
  }
  if (metadata === null || metadata.dist === undefined || metadata.dist.tarball !== sourceUrl) invalid(`${label}.sourceUrl does not match upstream metadata`, category);
  if (metadata.dist.shasum !== undefined && metadata.dist.shasum !== shasum) invalid(`${label}.shasum does not match upstream metadata`, category);
  const legacySha1Only = record.legacySha1Only;
  if (typeof legacySha1Only !== 'boolean') invalid(`${label}.legacySha1Only must be a boolean`, category);
  return {
    metadata: { ...metadata, dist: { ...metadata.dist, tarball: sourceUrl } },
    artifact: { sha512, integrity, shasum, sourceUrl, legacySha1Only },
  };
}

function normalizeArtifactRecord(value: unknown, label: string, category: ErrorCategory): ArtifactRecord {
  const record = requireRecord(value, label, category);
  exactKeys(record, ['name', 'version', 'packument', 'metadata', 'artifact'], label, category);
  const name = requireText(record.name, `${label}.name`, category);
  const version = requireText(record.version, `${label}.version`, category);
  if (!packageNamePattern.test(name) || !versionPattern.test(version)) invalid(`${label} has an invalid package identity`, category);
  const packument = normalizePackumentMetadata(record.packument, `${label}.packument`, category, name);
  const metadata = normalizeMetadata(record.metadata, `${label}.metadata`, category, name, version);
  const normalizedArtifact = normalizeArtifact(record.artifact, `${label}.artifact`, category, metadata);
  if (packument === null || metadata === null || normalizedArtifact === null) invalid(`${label} must include packument metadata, version metadata, and a verified artifact`, category);
  const metadataBytes = Buffer.byteLength(JSON.stringify({ packument, metadata: normalizedArtifact.metadata }), 'utf8');
  if (metadataBytes > limits.metadataBytes) invalid(`${label} exceeds the ${formatBytes(limits.metadataBytes)} metadata limit`, category);
  return { name, version, packument, metadata: normalizedArtifact.metadata, artifact: normalizedArtifact.artifact };
}

function validateArtifactRecordDigests(record: ArtifactRecord, category: ErrorCategory): void {
  const claims = digestClaims(record.metadata.dist.integrity ?? null, `upstream metadata for ${record.name}@${record.version}`, category);
  if (record.metadata.dist.shasum !== undefined) {
    addDigestClaims(claims, new Map([['sha1', record.metadata.dist.shasum]]), `${record.name}@${record.version}`, category);
  }
  const legacySha1Only = claims.size > 0 && [...claims.keys()].every(algorithm => algorithm === 'sha1');
  if (record.artifact.legacySha1Only !== legacySha1Only) invalid(`legacy SHA-1 policy marker is inconsistent for ${record.name}@${record.version}`, category);
  addDigestClaims(claims, new Map([['sha512', record.artifact.sha512]]), `${record.name}@${record.version}`, category);
  if (record.artifact.shasum !== null) addDigestClaims(claims, new Map([['sha1', record.artifact.shasum]]), `${record.name}@${record.version}`, category);
}

export function validateArtifactRecord(value: unknown): ArtifactRecord {
  const record = normalizeArtifactRecord(value, 'verified artifact', 'corrupt');
  validateArtifactRecordDigests(record, 'corrupt');
  return freezeDeep(record);
}

function normalizePackage(value: unknown, label: string, category: ErrorCategory): PackageRecord {
  const record = requireRecord(value, label, category);
  const keys = ['key', 'name', 'version', 'integrity', 'resolved', 'sourceKind', 'aliases', 'flags', 'platform', 'targets'];
  exactKeys(record, keys, label, category);
  const name = requireText(record.name, `${label}.name`, category);
  if (!packageNamePattern.test(name)) invalid(`${label}.name is not a valid package name`, category);
  const version = requireNullableText(record.version, `${label}.version`, category);
  if (version !== null && !versionPattern.test(version)) invalid(`${label}.version is not an exact package version`, category);
  const sourceKindValue = requireText(record.sourceKind, `${label}.sourceKind`, category);
  if (!isMemberOf(sourceKindValue, packageSourceKinds)) invalid(`${label}.sourceKind is unsupported`, category);
  const sourceKind = sourceKindValue;
  return {
    key: requireText(record.key, `${label}.key`, category),
    name,
    version,
    integrity: validateIntegrity(record.integrity, `${label}.integrity`, category),
    resolved: requireNullableText(record.resolved, `${label}.resolved`, category),
    sourceKind,
    aliases: requireList(record.aliases, `${label}.aliases`, category, true),
    flags: normalizeFlags(record.flags, `${label}.flags`, category),
    platform: normalizePlatform(record.platform, `${label}.platform`, category),
    targets: requireList(record.targets, `${label}.targets`, category),
  };
}

function normalizeRoot(value: unknown, label: string, category: ErrorCategory): RootDependency {
  const record = requireRecord(value, label, category);
  exactKeys(record, ['importer', 'requestedName', 'specifier', 'packageName', 'packageVersion', 'group', 'packageKey'], label, category);
  const requestedName = requireText(record.requestedName, `${label}.requestedName`, category);
  const packageName = requireText(record.packageName, `${label}.packageName`, category);
  if (!packageNamePattern.test(requestedName) || !packageNamePattern.test(packageName)) {
    invalid(`${label} contains an invalid package name`, category);
  }
  const packageVersion = requireNullableText(record.packageVersion, `${label}.packageVersion`, category);
  if (packageVersion !== null && !versionPattern.test(packageVersion)) {
    invalid(`${label}.packageVersion is not an exact package version`, category);
  }
  const groupValue = requireText(record.group, `${label}.group`, category);
  if (!isMemberOf(groupValue, dependencyGroups)) invalid(`${label}.group is unsupported`, category);
  const group = groupValue;
  return {
    importer: normalizeImporter(record.importer, `${label}.importer`, category),
    requestedName,
    specifier: requireText(record.specifier, `${label}.specifier`, category),
    packageName,
    packageVersion,
    group,
    packageKey: requireNullableText(record.packageKey, `${label}.packageKey`, category),
  };
}

function normalizeProject(value: unknown, label: string, category: ErrorCategory): ProjectRecord {
  const record = requireRecord(value, label, category);
  exactKeys(record, ['id', 'manager', 'packageManagerPin', 'lockfilePath', 'lockfileVersion', 'targets', 'importers', 'roots', 'packages', 'snapshot'], label, category);
  const managerValue = requireText(record.manager, `${label}.manager`, category);
  if (!isMemberOf(managerValue, packageManagers)) invalid(`${label}.manager is unsupported`, category);
  const manager = managerValue;
  const packageManagerPin = requireNullableText(record.packageManagerPin, `${label}.packageManagerPin`, category);
  if (packageManagerPin !== null) {
    const match = packageManagerPinPattern.exec(packageManagerPin);
    if (!match || match[1] !== manager) invalid(`${label}.packageManagerPin does not match its package manager`, category);
  }
  let npmLockfileVersion: 2 | 3 | null = null;
  let pnpmLockfileVersion: string | null = null;
  const lockfileVersionValue = record.lockfileVersion;
  if (manager === 'npm') {
    if (lockfileVersionValue !== 2 && lockfileVersionValue !== 3) invalid(`${label}.lockfileVersion must be 2 or 3 for npm`, category);
    npmLockfileVersion = lockfileVersionValue;
  } else {
    if (typeof lockfileVersionValue !== 'string' || !/^\d+\.\d+$/.test(lockfileVersionValue)) {
      invalid(`${label}.lockfileVersion must be a major.minor string for pnpm`, category);
    }
    pnpmLockfileVersion = lockfileVersionValue;
  }
  if (!Array.isArray(record.roots) || !Array.isArray(record.packages)) invalid(`${label} roots and packages must be arrays`, category);
  const roots = record.roots.map((root: unknown, index: number) => normalizeRoot(root, `${label}.roots[${index}]`, category));
  roots.sort((left, right) => left.importer.localeCompare(right.importer) || left.group.localeCompare(right.group) || left.requestedName.localeCompare(right.requestedName) || left.specifier.localeCompare(right.specifier));
  const importers = requireList(record.importers, `${label}.importers`, category, true)
    .map((importer, index) => normalizeImporter(importer, `${label}.importers[${index}]`, category));
  if (roots.some(root => !importers.includes(root.importer))) invalid(`${label}.roots references an unknown importer`, category);
  const packages = record.packages.map((pkg: unknown, index: number) => normalizePackage(pkg, `${label}.packages[${index}]`, category));
  packages.sort((left, right) => left.key.localeCompare(right.key) || left.name.localeCompare(right.name) || String(left.version).localeCompare(String(right.version)));
  const packageKeys = packages.map(pkg => pkg.key);
  if (new Set(packageKeys).size !== packageKeys.length) invalid(`${label}.packages contains duplicate lockfile keys`, category);
  const lockfileVersion = manager === 'npm' ? npmLockfileVersion : pnpmLockfileVersion;
  if (lockfileVersion === null) return invalid(`${label}.lockfileVersion is unsupported`, category);
  const fields: ProjectFields = {
    id: requireText(record.id, `${label}.id`, category),
    packageManagerPin,
    lockfilePath: requireText(record.lockfilePath, `${label}.lockfilePath`, category),
    targets: requireList(record.targets, `${label}.targets`, category),
    importers,
    roots,
    packages,
    snapshot: normalizeSnapshot(record.snapshot, `${label}.snapshot`, category, manager, lockfileVersion),
  };
  if (manager === 'npm' && npmLockfileVersion !== null) return { ...fields, manager, lockfileVersion: npmLockfileVersion };
  if (manager === 'pnpm' && pnpmLockfileVersion !== null) return { ...fields, manager, lockfileVersion: pnpmLockfileVersion };
  return invalid(`${label}.lockfileVersion is unsupported`, category);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalValue(value[key]);
  return canonical;
}

function stableStringify(value: unknown): string | undefined {
  return JSON.stringify(canonicalValue(value));
}

function digestClaims(integrity: string | null, label: string, category: ErrorCategory): Map<string, string> {
  const claims = new Map<string, string>();
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

function addDigestClaims(target: Map<string, string>, source: Map<string, string>, label: string, category: ErrorCategory): void {
  for (const [algorithm, digest] of source) {
    const existing = target.get(algorithm);
    if (existing !== undefined && existing !== digest) invalid(`conflicting ${algorithm} integrity for ${label}`, category);
    target.set(algorithm, digest);
  }
}

function validateDigestConflicts(projects: ProjectRecord[], artifacts: ArtifactRecord[], category: ErrorCategory): void {
  const claimsByIdentity = new Map<string, Map<string, string>>();
  const sourcesByIdentity = new Map<string, Set<PackageSourceKind>>();
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
    addDigestClaims(claims, new Map([['sha512', artifact.artifact.sha512]]), `${artifact.name}@${artifact.version}`, category);
    if (artifact.artifact.shasum !== null) {
      addDigestClaims(claims, new Map([['sha1', artifact.artifact.shasum]]), `${artifact.name}@${artifact.version}`, category);
    }
    claimsByIdentity.set(identity, claims);
  }
}

function freezeDeep<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function createEmptyInventory(): Inventory {
  return freezeDeep({ schemaVersion: inventorySchemaVersion, projects: [], artifacts: [] });
}

export function parseInventory(text: string): Inventory {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new MynpmError('corrupt', 'inventory is not valid JSON', { cause });
  }
  const record = requireRecord(value, 'inventory', 'corrupt');
  exactKeys(record, ['schemaVersion', 'projects', 'artifacts'], 'inventory', 'corrupt');
  if (record.schemaVersion !== inventorySchemaVersion) invalid(`unsupported inventory schemaVersion: ${String(record.schemaVersion)}`, 'corrupt');
  if (!Array.isArray(record.projects) || !Array.isArray(record.artifacts)) invalid('inventory projects and artifacts must be arrays', 'corrupt');
  const projects = record.projects.map((project: unknown, index: number) => normalizeProject(project, `inventory.projects[${index}]`, 'corrupt'));
  projects.sort((left, right) => left.id.localeCompare(right.id) || left.lockfilePath.localeCompare(right.lockfilePath) || left.manager.localeCompare(right.manager) || String(left.lockfileVersion).localeCompare(String(right.lockfileVersion)) || left.targets.join(',').localeCompare(right.targets.join(',')));
  const artifacts = record.artifacts.map((artifact: unknown, index: number) => normalizeArtifactRecord(artifact, `inventory.artifacts[${index}]`, 'corrupt'));
  artifacts.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const artifactIdentities = artifacts.map(artifact => `${artifact.name}\0${artifact.version}`);
  if (new Set(artifactIdentities).size !== artifactIdentities.length) invalid('inventory contains duplicate verified artifact identities', 'corrupt');
  validateDigestConflicts(projects, artifacts, 'corrupt');
  const identities = projects.map(stableStringify);
  if (new Set(identities).size !== identities.length) invalid('inventory contains duplicate project imports', 'corrupt');
  return freezeDeep({ schemaVersion: inventorySchemaVersion, projects, artifacts });
}

export function mergeProject(inventory: Inventory, project: ProjectRecord): Inventory {
  const checkedInventory = isRecord(inventory) && typeof inventory.schemaVersion === 'number'
    ? parseInventory(JSON.stringify(inventory))
    : invalid('inventory is malformed', 'corrupt');
  const checkedProject = normalizeProject(project, 'imported project', 'input');
  if (checkedInventory.projects.some(existing => stableStringify(existing) === stableStringify(checkedProject))) return checkedInventory;
  const projects = [...checkedInventory.projects, checkedProject];
  validateDigestConflicts(projects, checkedInventory.artifacts, 'conflict');
  return parseInventory(JSON.stringify({ schemaVersion: inventorySchemaVersion, projects, artifacts: checkedInventory.artifacts }));
}

export function recordVerifiedArtifact(inventory: Inventory, value: unknown): Inventory {
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
  return parseInventory(JSON.stringify({ schemaVersion: inventorySchemaVersion, projects: checkedInventory.projects, artifacts }));
}

export function serializeInventory(inventory: Inventory): string {
  const checked = isRecord(inventory) && typeof inventory.schemaVersion === 'number'
    ? parseInventory(JSON.stringify(inventory))
    : invalid('inventory is malformed', 'corrupt');
  const serialized = JSON.stringify(canonicalValue(checked), null, 2);
  if (serialized === undefined) invalid('inventory is not JSON serializable', 'corrupt');
  return `${serialized}\n`;
}
