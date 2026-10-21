import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limits } from '../src/limits.mjs';

test('acquisition limits match the approved fixed policy', () => {
  assert.deepEqual(limits, {
    metadataBytes: 64 * 1024 ** 2,
    tarballBytes: 1024 ** 3,
    unpackedBytes: 2 * 1024 ** 3,
    archiveEntries: 100_000,
    redirects: 5,
    requestMilliseconds: 10 * 60 * 1000,
    fetchMilliseconds: 60 * 60 * 1000,
    concurrentDownloads: 4,
    fetchBytes: 10 * 1024 ** 3,
  });
});
