export const limits = Object.freeze({
  metadataBytes: 64 * 1024 ** 2,
  tarballBytes: 1024 ** 3,
  unpackedBytes: 2 * 1024 ** 3,
  archiveEntries: 100_000,
  redirects: 5,
  requestMilliseconds: 10 * 60 * 1000,
  fetchMilliseconds: 60 * 60 * 1000,
  concurrentDownloads: 4,
  fetchBytes: 10 * 1024 ** 3,
} as const);

export function formatBytes(bytes: number): string {
  const units: readonly (readonly [string, number])[] = [['GiB', 1024 ** 3], ['MiB', 1024 ** 2], ['KiB', 1024]];
  for (const [unit, size] of units) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size} ${unit}`;
  }
  return `${bytes} bytes`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000} hour${milliseconds === 3_600_000 ? '' : 's'}`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000} minute${milliseconds === 60_000 ? '' : 's'}`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000} second${milliseconds === 1_000 ? '' : 's'}`;
  return `${milliseconds} milliseconds`;
}
