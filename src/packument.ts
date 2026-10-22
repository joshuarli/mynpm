import { MynpmError } from './errors.ts';
import { validateArtifactRecord } from './inventory.ts';
import type { ArtifactRecord, JsonObject, JsonValue, VerifiedVersionMetadata } from './inventory.ts';

export const rendererVersion = 3;

export interface PackumentFile {
  readonly name: string;
  readonly path: string;
  readonly route: string;
  readonly bytes: Buffer;
}

const supportedRendererVersions = new Set<number>([1, 2, rendererVersion]);

function invalid(message: string): never {
  throw new MynpmError('corrupt', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => canonicalValue(item));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
  return result;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? 'undefined';
}

function prettyJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, 'utf8');
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new MynpmError('input', 'publicBaseUrl must be an absolute HTTPS URL', { cause });
  }
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!loopbackHttp && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || !url.pathname.endsWith('/')) {
    throw new MynpmError('input', 'publicBaseUrl must be an HTTPS URL or a loopback HTTP URL with a trailing slash and no credentials, query, or fragment');
  }
  return url.href;
}

function latestSnapshot(records: readonly ArtifactRecord[]): JsonObject {
  const ordered = [...records].sort((left, right) => {
    const leftModified = typeof left.packument.modified === 'string' ? left.packument.modified : '';
    const rightModified = typeof right.packument.modified === 'string' ? right.packument.modified : '';
    return leftModified.localeCompare(rightModified) || canonicalStringify(left.packument).localeCompare(canonicalStringify(right.packument));
  });
  return ordered[ordered.length - 1].packument;
}

function packageTime(
  records: readonly ArtifactRecord[],
  selectedVersions: ReadonlySet<string>,
  snapshot: JsonObject,
): Record<string, JsonValue> | undefined {
  const values: Record<string, JsonValue> = {};
  for (const record of records) {
    const time = record.packument.time;
    if (!isJsonObject(time)) continue;
    for (const version of selectedVersions) {
      if (time[version] === undefined) continue;
      if (values[version] !== undefined && canonicalStringify(values[version]) !== canonicalStringify(time[version])) {
        invalid(`upstream publish time conflicts for ${record.name}@${version}`);
      }
      values[version] = time[version];
    }
  }
  const snapshotTime = snapshot.time;
  if (isJsonObject(snapshotTime)) {
    for (const field of ['created', 'modified']) {
      if (snapshotTime[field] !== undefined) values[field] = snapshotTime[field];
    }
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function versionDocument(record: ArtifactRecord, publicBaseUrl: string, renderVersion: number): VerifiedVersionMetadata {
  const metadata = structuredClone(record.metadata);
  if (!isJsonObject(metadata)) invalid(`verified metadata is invalid for ${record.name}@${record.version}`);
  if (!isJsonObject(metadata.dist)) invalid(`verified distribution metadata is invalid for ${record.name}@${record.version}`);
  const dist: JsonObject = { ...metadata.dist };
  delete dist.signatures;
  delete dist.attestations;
  const tarballPath = renderVersion === 1
    ? 'tarballs'
    : renderVersion === 2
      ? 'current/tarballs'
      : 'current/-/tarballs';
  const tarball = new URL(`${tarballPath}/${record.artifact.sha512}.tgz`, publicBaseUrl).href;
  dist.tarball = tarball;
  dist.integrity = record.artifact.integrity;
  if (record.artifact.shasum === null) delete dist.shasum;
  else dist.shasum = record.artifact.shasum;
  const name = metadata.name;
  const version = metadata.version;
  if (typeof name !== 'string' || typeof version !== 'string') {
    invalid(`verified metadata identity is invalid for ${record.name}@${record.version}`);
  }
  return { ...metadata, name, version, dist: { ...dist, tarball } };
}

function renderPackage(name: string, records: readonly ArtifactRecord[], publicBaseUrl: string, renderVersion: number): JsonObject {
  const versions: Record<string, VerifiedVersionMetadata> = {};
  for (const record of records) versions[record.version] = versionDocument(record, publicBaseUrl, renderVersion);
  const selected = new Set(Object.keys(versions));
  const snapshot = latestSnapshot(records);
  const upstreamTags = snapshot['dist-tags'];
  const distTags: JsonObject = {};
  if (isRecord(upstreamTags)) {
    for (const [tag, version] of Object.entries(upstreamTags)) {
      if (typeof version === 'string' && selected.has(version)) distTags[tag] = version;
    }
  }
  const result: JsonObject = { ...snapshot, name, 'dist-tags': distTags, versions };
  const time = packageTime(records, selected, snapshot);
  if (time === undefined) delete result.time;
  else result.time = time;
  return result;
}

export function renderPackumentFiles(
  artifactRecords: ArtifactRecord[],
  publicBaseUrl: string,
  options: { renderer?: number } = {},
): PackumentFile[] {
  const renderer = options.renderer === undefined ? rendererVersion : options.renderer;
  if (!supportedRendererVersions.has(renderer)) throw new MynpmError('input', `unsupported renderer version: ${renderer}`);
  const baseUrl = validateBaseUrl(publicBaseUrl);
  if (!Array.isArray(artifactRecords)) throw new MynpmError('input', 'verified artifacts must be an array');
  const records = artifactRecords.map(validateArtifactRecord).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const identities = records.map(record => `${record.name}\0${record.version}`);
  if (new Set(identities).size !== identities.length) throw new MynpmError('conflict', 'verified artifacts contain duplicate package identities');
  const grouped = new Map<string, ArtifactRecord[]>();
  for (const record of records) {
    const versions = grouped.get(record.name) ?? [];
    versions.push(record);
    grouped.set(record.name, versions);
  }
  return [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([name, packageRecords]) => ({
    name,
    path: name,
    route: name.startsWith('@') ? `${name.slice(0, name.indexOf('/'))}%2f${name.slice(name.indexOf('/') + 1)}` : name,
    bytes: prettyJson(renderPackage(name, packageRecords, baseUrl, renderer)),
  }));
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}
