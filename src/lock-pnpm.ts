import type { DependencyGroup, PackageFlags, PackageManager, PackageRecord, ProjectRecord, ProjectSnapshot, RootDependency } from './inventory.ts';
import { errorCode, MynpmError } from './errors.ts';
import { Effect } from 'effect';

type JsonRecord = Record<string, unknown>;
type PackageIdentity = { name: string; version: string | null; reference: string };
type ParsePnpmLockOptions = {
  projectId: string;
  packageManagerPin?: string | null;
  lockfilePath: string;
  targetIds: readonly string[];
  snapshot?: ProjectSnapshot | null;
};

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const integrityLengths = new Map([['sha1', 20], ['sha256', 32], ['sha384', 48], ['sha512', 64]]);
const dependencyGroups: readonly DependencyGroup[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function invalid(message: string): never {
  throw new MynpmError('input', message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePackageName(value: unknown, label: string): string {
  const name = requireText(value, label);
  if (!packageNamePattern.test(name)) invalid(`${label} is not a valid package name`);
  return name;
}

function parseIntegrity(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  const integrity = requireText(value, label);
  const tokens = integrity.split(/\s+/);
  const claims = new Map<string, string>();
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
  return integrity;
}

function packageIdentity(key: string, label: string): PackageIdentity {
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

function sanitizeUrl(value: unknown, label: string): { url: string | null; hadCredentials: boolean } {
  if (value === undefined) return { url: null, hadCredentials: false };
  const source = requireText(value, label);
  let url: URL;
  try {
    url = new URL(source);
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

function sourceKind(resolution: JsonRecord, reference: string, url: string | null, hadCredentials: boolean): PackageRecord['sourceKind'] {
  if (resolution.type === 'directory' || typeof resolution.directory === 'string' || /^(?:file|link|workspace):/i.test(reference)) return 'local';
  if (hadCredentials) return 'external-url';
  if (resolution.type === 'git' || typeof resolution.commit === 'string' || /^(?:git\+|git:|github:|ssh\+git:)/i.test(reference)) return 'git';
  if (url === null) return 'registry';
  if (url.startsWith('file:')) return 'local';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new MynpmError('input', 'pnpm lockfile contains an invalid tarball URL', { cause });
  }
  return parsed.protocol === 'https:' && parsed.hostname === 'registry.npmjs.org' ? 'registry' : 'external-url';
}

function parsePlatform(entry: JsonRecord, label: string): PackageRecord['platform'] {
  const platform: PackageRecord['platform'] = { os: null, cpu: null, libc: null };
  for (const field of ['os', 'cpu', 'libc'] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    const values: unknown[] = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.some(item => typeof item !== 'string' || item.length === 0)) {
      invalid(`${label}.${field} must be a string or non-empty string array`);
    }
    const strings = values.filter((item): item is string => typeof item === 'string');
    platform[field] = [...new Set(strings)].sort();
  }
  return platform;
}

function parseFlags(entry: JsonRecord, label: string): PackageFlags {
  const flags: PackageFlags = { dev: false, optional: false, peer: false, peerOptional: false, link: false };
  for (const field of ['dev', 'optional', 'peer', 'peerOptional'] as const) {
    const value = entry[field];
    if (value !== undefined && typeof value !== 'boolean') invalid(`${label}.${field} must be a boolean`);
    flags[field] = value === true;
  }
  flags.link = isRecord(entry.resolution) && entry.resolution.type === 'directory';
  return flags;
}

function normalizeTargets(targetIds: unknown): string[] {
  if (!Array.isArray(targetIds) || targetIds.length === 0) invalid('at least one target ID is required for pnpm lockfile import');
  const targets = targetIds.map((id: unknown, index: number) => requireText(id, `targetIds[${index}]`));
  if (new Set(targets).size !== targets.length) invalid('target IDs must be unique');
  return targets.sort();
}

function normalizeImporterPath(value: unknown, label: string): string {
  const importerPath = requireText(value, label);
  if (importerPath !== '.' && (importerPath.startsWith('/') || importerPath.includes('\\') || importerPath.split('/').some(part => part === '' || part === '.' || part === '..'))) {
    invalid(`${label} must be a safe project-relative path`);
  }
  return importerPath;
}

function lockfileDocuments(values: unknown): JsonRecord[] {
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function snapshotReference(key: string): string {
  requireText(key, 'pnpm snapshot key');
  return (key.startsWith('/') ? key.slice(1) : key).split('(', 1)[0];
}

function snapshotDependencyReference(name: string, reference: string): string | null {
  const normalized = reference.startsWith('npm:') ? reference.slice(4) : reference;
  if (/^(?:link|file|workspace):/i.test(normalized)) return null;
  const packageSeparator = normalized.indexOf('@');
  const peerSuffix = normalized.indexOf('(');
  return packageSeparator >= 0 && (peerSuffix < 0 || packageSeparator < peerSuffix)
    ? normalized.startsWith('/') ? normalized.slice(1) : normalized
    : `${name}@${normalized}`;
}

function packageReferenceMatches(reference: string, requestedName: string, packageRecord: PackageRecord): boolean {
  const packageKey = packageRecord.key.startsWith('/') ? packageRecord.key.slice(1) : packageRecord.key;
  const candidate = reference.startsWith('npm:') ? reference.slice(4) : reference;
  if (candidate === packageKey || candidate === `/${packageKey}`) return true;
  const identity = packageIdentity(packageRecord.key, 'pnpm package key');
  if (candidate.includes('@')) {
    try {
      const referenced = packageIdentity(candidate, 'pnpm importer package reference');
      return referenced.name === identity.name && referenced.reference.split('(', 1)[0] === identity.reference.split('(', 1)[0];
    } catch (error) {
      if (!(error instanceof MynpmError)) throw error;
    }
  }
  const candidateBase = candidate.split('(', 1)[0];
  if (identity.name === requestedName && candidateBase === identity.reference.split('(', 1)[0]) return true;
  return candidateBase === identity.version && identity.name === requestedName;
}

function parsePackageEntry(key: string, entryValue: unknown, targets: string[]): PackageRecord {
  const label = `pnpm lockfile packages[${JSON.stringify(key)}]`;
  const identity = packageIdentity(key, label);
  const entry = requireRecord(entryValue, label);
  const resolution = requireRecord(entry.resolution, `${label}.resolution`);
  const revision = resolution.revision;
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0)) {
    invalid(`${label}.resolution.revision must be a non-negative integer`);
  }
  if (revision !== undefined && revision !== 0) {
    invalid(`${label} uses unsupported resolution revision ${String(revision)}`);
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

function importerRoots(document: JsonRecord, packageEntries: Map<string, PackageRecord>, importerLabel: string): RootDependency[] {
  const roots: RootDependency[] = [];
  const importers = requireRecord(document.importers ?? {}, `${importerLabel}.importers`);
  for (const [importerPath, importerValue] of Object.entries(importers)) {
    normalizeImporterPath(importerPath, `${importerLabel}.importers path`);
    const importer = requireRecord(importerValue, `${importerLabel}.importers[${JSON.stringify(importerPath)}]`);
    for (const group of dependencyGroups) {
      const dependencies = importer[group];
      if (dependencies === undefined) continue;
      const dependencyRecords = requireRecord(dependencies, `${importerLabel}.importers[${JSON.stringify(importerPath)}].${group}`);
      for (const [requestedName, entryValue] of Object.entries(dependencyRecords)) {
        requirePackageName(requestedName, `${importerLabel}.importers dependency name`);
        const dependency = typeof entryValue === 'string'
          ? { specifier: entryValue, version: entryValue }
          : requireRecord(entryValue, `${importerLabel}.importers dependency`);
        const specifier = requireText(dependency.specifier, `${importerLabel}.importers dependency specifier`);
        const reference = requireText(dependency.version, `${importerLabel}.importers dependency version`);
        const match = [...packageEntries.values()].find(pkg => packageReferenceMatches(reference, requestedName, pkg));
        let packageName = requestedName;
        let packageVersion: string | null = null;
        let packageKey: string | null = null;
        if (match) {
          packageName = match.name;
          packageVersion = match.version;
          packageKey = match.key;
        } else if (/^(?:link|file|workspace):/i.test(reference)) {
          packageVersion = null;
        } else {
          const target = reference.startsWith('npm:') ? reference.slice(4) : reference;
          const targetBase = target.split('(', 1)[0];
          const separator = targetBase.startsWith('@') ? targetBase.indexOf('@', targetBase.indexOf('/') + 1) : targetBase.indexOf('@');
          if (separator > 0) {
            packageName = requirePackageName(targetBase.slice(0, separator), `${importerLabel} dependency target`);
            const targetVersion = targetBase.slice(separator + 1);
            packageVersion = versionPattern.test(targetVersion) ? targetVersion : null;
          } else if (versionPattern.test(targetBase)) {
            packageVersion = targetBase;
          }
        }
        roots.push({ importer: importerPath, requestedName, specifier, packageName, packageVersion, group, packageKey });
      }
    }
  }
  return roots;
}

function parsePnpmDocuments(values: unknown, { projectId, packageManagerPin = null, lockfilePath, targetIds, snapshot = null }: ParsePnpmLockOptions): ProjectRecord {
  const documents = lockfileDocuments(values);
  const targets = normalizeTargets(targetIds);
  const packagesByKey = new Map<string, PackageRecord>();
  const snapshotKeys = new Set<string>();
  const snapshotEntries = new Set<string>();
  const snapshotReferences = new Set<string>();
  const importerPaths = new Set<string>();
  const roots: RootDependency[] = [];
  for (const [index, document] of documents.entries()) {
    const documentPackages = requireRecord(document.packages ?? {}, `pnpm lockfile document ${index + 1}.packages`);
    for (const [key, entry] of Object.entries(documentPackages)) {
      const parsed = parsePackageEntry(key, entry, targets);
      const prior = packagesByKey.get(key);
      if (prior && JSON.stringify(canonicalValue(prior)) !== JSON.stringify(canonicalValue(parsed))) {
        throw new MynpmError('conflict', `pnpm lockfile documents disagree about package ${key}`);
      }
      packagesByKey.set(key, parsed);
    }
    const snapshots = requireRecord(document.snapshots ?? {}, `pnpm lockfile document ${index + 1}.snapshots`);
    const importers = requireRecord(document.importers ?? {}, `pnpm lockfile document ${index + 1}.importers`);
    for (const importerPath of Object.keys(importers)) {
      importerPaths.add(normalizeImporterPath(importerPath, `pnpm lockfile document ${index + 1}.importers path`));
    }
    for (const [key, snapshotValue] of Object.entries(snapshots)) {
      const snapshotEntry = requireRecord(snapshotValue, `pnpm lockfile snapshots[${JSON.stringify(key)}]`);
      for (const group of ['dependencies', 'optionalDependencies'] as const) {
        if (snapshotEntry[group] === undefined) continue;
        const dependencies = requireRecord(snapshotEntry[group], `pnpm lockfile snapshots[${JSON.stringify(key)}].${group}`);
        for (const [name, referenceValue] of Object.entries(dependencies)) {
          requirePackageName(name, `pnpm lockfile snapshots[${JSON.stringify(key)}].${group} dependency name`);
          const reference = requireText(referenceValue, `pnpm lockfile snapshots[${JSON.stringify(key)}].${group}[${JSON.stringify(name)}]`);
          const normalized = snapshotDependencyReference(name, reference);
          if (normalized !== null) snapshotReferences.add(normalized);
        }
      }
      snapshotKeys.add(snapshotReference(key));
      snapshotEntries.add(key.startsWith('/') ? key.slice(1) : key);
    }
    roots.push(...importerRoots(document, packagesByKey, `pnpm lockfile document ${index + 1}`));
  }
  for (const snapshot of snapshotKeys) {
    if (![...packagesByKey.keys()].some(key => snapshotReference(key) === snapshot)) {
      invalid(`pnpm snapshot has no matching package entry: ${snapshot}`);
    }
  }
  const missingSnapshot = [...snapshotReferences].find(reference => !snapshotEntries.has(reference));
  if (missingSnapshot !== undefined) invalid(`pnpm snapshot dependency has no matching snapshot: ${missingSnapshot}`);
  const uniqueRoots = new Map<string, RootDependency>();
  for (const root of roots) {
    const key = JSON.stringify(root);
    uniqueRoots.set(key, root);
  }
  return {
    id: requireText(projectId, 'project ID'),
    manager: 'pnpm' satisfies PackageManager,
    packageManagerPin,
    lockfilePath: requireText(lockfilePath, 'lockfile path'),
    lockfileVersion: '9.0',
    targets,
    importers: [...importerPaths].sort(),
    roots: [...uniqueRoots.values()].sort((left, right) => left.importer.localeCompare(right.importer) || left.group.localeCompare(right.group) || left.requestedName.localeCompare(right.requestedName)),
    packages: [...packagesByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
    snapshot,
  };
}

function decodeYamlDocuments(text: string, yaml: typeof import('yaml')): unknown[] {
  let documents: ReturnType<typeof yaml.parseAllDocuments>;
  try {
    documents = yaml.parseAllDocuments(text, { uniqueKeys: true });
  } catch (cause) {
    throw new MynpmError('input', 'pnpm lockfile is not valid YAML', { cause });
  }
  const parseErrors = documents.flatMap(document => document.errors);
  if (parseErrors.length > 0) throw new MynpmError('input', `pnpm lockfile contains invalid YAML: ${parseErrors[0].message}`, { cause: parseErrors[0] });
  return documents.map((document, index) => {
    if (document.contents === null) invalid(`pnpm lockfile document ${index + 1} is empty`);
    try {
      const decoded: unknown = document.toJS({ maxAliasCount: 100 });
      return decoded;
    } catch (cause) {
      throw new MynpmError('input', `pnpm lockfile document ${index + 1} cannot be decoded`, { cause });
    }
  });
}

function decodePnpmDocuments(text: string): Effect.Effect<unknown[], MynpmError> {
  return Effect.gen(function*() {
    const yaml = yield* Effect.tryPromise({
      try: () => import('yaml'),
      catch: cause => errorCode(cause) === 'ERR_MODULE_NOT_FOUND'
        ? new MynpmError('operation', 'pnpm lockfile import requires the pinned yaml@2.9.1 dependency; install locked project dependencies', { cause })
        : new MynpmError('operation', 'could not load the pinned yaml@2.9.1 dependency', { cause }),
    });
    return yield* Effect.try({
      try: () => decodeYamlDocuments(text, yaml),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('input', 'pnpm lockfile is not valid YAML', { cause }),
    });
  });
}

export function parsePnpmLock(text: string, options: ParsePnpmLockOptions): Effect.Effect<ProjectRecord, MynpmError> {
  return Effect.gen(function*() {
    const documents = yield* decodePnpmDocuments(text);
    return yield* Effect.try({
      try: () => parsePnpmDocuments(documents, options),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('input', 'pnpm lockfile is invalid', { cause }),
    });
  });
}

function buildPackageKeys(values: unknown): string[] {
  const documents = lockfileDocuments(values);
  const keys = new Set<string>();
  for (const [index, document] of documents.entries()) {
    const packages = requireRecord(document.packages ?? {}, `pnpm lockfile document ${index + 1}.packages`);
    for (const [key, entryValue] of Object.entries(packages)) {
      const entry = requireRecord(entryValue, `pnpm lockfile document ${index + 1}.packages[${JSON.stringify(key)}]`);
      if (entry.requiresBuild === true) keys.add(key);
    }
  }
  return [...keys].sort();
}

export function pnpmBuildPackageKeys(text: string): Effect.Effect<string[], MynpmError> {
  return Effect.gen(function*() {
    const documents = yield* decodePnpmDocuments(text);
    return yield* Effect.try({
      try: () => buildPackageKeys(documents),
      catch: cause => cause instanceof MynpmError ? cause : new MynpmError('input', 'pnpm lockfile is invalid', { cause }),
    });
  });
}

export { parsePnpmDocuments };
