import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEmptyInventory } from '../src/inventory.mjs';
import { loadInventory, saveInventory, updateInventory } from '../src/inventory-store.mjs';

const scratchRoot = fileURLToPath(new URL('../.work/tmp/', import.meta.url));

test('missing inventory reads as empty without creating state', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'inventory-read-'));
  try {
    assert.deepEqual(await loadInventory(directory), createEmptyInventory());
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inventory reads and writes reject symbolic-link files without following them', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'inventory-symlink-'));
  try {
    const outside = join(directory, 'outside.json');
    const inventoryPath = join(directory, 'inventory.json');
    writeFileSync(outside, '{"schemaVersion":2,"projects":[],"artifacts":[]}\n');
    symlinkSync(outside, inventoryPath);
    await assert.rejects(loadInventory(directory), error => error.category === 'corrupt' && /symbolic link/.test(error.message));
    await assert.rejects(saveInventory(directory, createEmptyInventory()), error => error.category === 'corrupt');
    assert.equal(readFileSync(outside, 'utf8'), '{"schemaVersion":2,"projects":[],"artifacts":[]}\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inventory updates reject a concurrent writer and release the lock on completion', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'inventory-lock-'));
  let startUpdate;
  let releaseUpdate;
  const started = new Promise(resolve => { startUpdate = resolve; });
  const barrier = new Promise(resolve => { releaseUpdate = resolve; });
  try {
    const first = updateInventory(directory, async inventory => {
      startUpdate();
      await barrier;
      return inventory;
    });
    await started;
    await assert.rejects(
      updateInventory(directory, inventory => inventory),
      error => error.category === 'conflict',
    );
    releaseUpdate();
    await first;
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    releaseUpdate?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inventory update recovers a lock left by a dead process', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'inventory-stale-lock-'));
  try {
    writeFileSync(join(directory, '.inventory.lock'), JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' }));
    await updateInventory(directory, inventory => inventory);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inventory writes replace atomically and round-trip', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'inventory-write-'));
  try {
    await saveInventory(directory, createEmptyInventory());
    const inventoryPath = join(directory, 'inventory.json');
    assert.equal(readFileSync(inventoryPath, 'utf8'), '{\n  "artifacts": [],\n  "projects": [],\n  "schemaVersion": 2\n}\n');
    assert.deepEqual(await loadInventory(directory), createEmptyInventory());
    assert.deepEqual(readdirSync(directory), ['inventory.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
