import { MynpmError } from './errors.mjs';
import { validateArtifactRecord } from './inventory.mjs';

export const rendererVersion = 1;

function invalid(message) {
  throw new MynpmError('corrupt', message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

function prettyJson(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, 'utf8');
}

function validateBaseUrl(value) {
  let url;
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

function latestSnapshot(records) {
  return [...records].sort((left, right) => {
    const leftModified = typeof left.packument.modified === 'string' ? left.packument.modified : '';
    const rightModified = typeof right.packument.modified === 'string' ? right.packument.modified : '';
    return leftModified.localeCompare(rightModified) || canonicalStringify(left.packument).localeCompare(canonicalStringify(right.packument));
  }).at(-1).packument;
}

function packageTime(records, selectedVersions, snapshot) {
  const values = {};
  for (const record of records) {
    const time = record.packument.time;
    if (!time || typeof time !== 'object' || Array.isArray(time)) continue;
    for (const version of selectedVersions) {
      if (time[version] === undefined) continue;
      if (values[version] !== undefined && canonicalStringify(values[version]) !== canonicalStringify(time[version])) {
        invalid(`upstream publish time conflicts for ${record.name}@${version}`);
      }
      values[version] = time[version];
    }
  }
  const snapshotTime = snapshot.time;
  if (snapshotTime && typeof snapshotTime === 'object' && !Array.isArray(snapshotTime)) {
    for (const field of ['created', 'modified']) {
      if (snapshotTime[field] !== undefined) values[field] = snapshotTime[field];
    }
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function versionDocument(record, publicBaseUrl) {
  const metadata = structuredClone(record.metadata);
  const dist = { ...metadata.dist };
  delete dist.signatures;
  delete dist.attestations;
  dist.tarball = new URL(`tarballs/${record.artifact.sha512}.tgz`, publicBaseUrl).href;
  dist.integrity = record.artifact.integrity;
  if (record.artifact.shasum === null) delete dist.shasum;
  else dist.shasum = record.artifact.shasum;
  metadata.dist = dist;
  return metadata;
}

function renderPackage(name, records, publicBaseUrl) {
  const versions = Object.fromEntries(records.map(record => [record.version, versionDocument(record, publicBaseUrl)]));
  const selected = new Set(Object.keys(versions));
  const snapshot = latestSnapshot(records);
  const upstreamTags = snapshot['dist-tags'];
  const distTags = upstreamTags && typeof upstreamTags === 'object' && !Array.isArray(upstreamTags)
    ? Object.fromEntries(Object.entries(upstreamTags).filter(([, version]) => typeof version === 'string' && selected.has(version)))
    : {};
  const result = { ...snapshot, name, 'dist-tags': distTags, versions };
  const time = packageTime(records, selected, snapshot);
  if (time === undefined) delete result.time;
  else result.time = time;
  return result;
}

export function renderPackumentFiles(artifactRecords, publicBaseUrl) {
  const baseUrl = validateBaseUrl(publicBaseUrl);
  if (!Array.isArray(artifactRecords)) throw new MynpmError('input', 'verified artifacts must be an array');
  const records = artifactRecords.map(validateArtifactRecord).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const identities = records.map(record => `${record.name}\0${record.version}`);
  if (new Set(identities).size !== identities.length) throw new MynpmError('conflict', 'verified artifacts contain duplicate package identities');
  const grouped = new Map();
  for (const record of records) {
    const versions = grouped.get(record.name) ?? [];
    versions.push(record);
    grouped.set(record.name, versions);
  }
  return [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([name, packageRecords]) => ({
    name,
    path: name,
    route: name.startsWith('@') ? `${name.slice(0, name.indexOf('/'))}%2f${name.slice(name.indexOf('/') + 1)}` : name,
    bytes: prettyJson(renderPackage(name, packageRecords, baseUrl)),
  }));
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}
