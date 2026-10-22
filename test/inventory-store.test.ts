import assert from 'node:assert/strict';
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { createEmptyInventory } from '../src/inventory.ts';
import { loadInventory, saveInventory, updateInventory } from '../src/inventory-store.ts';
import { withScratch } from './support.ts';

it.effect('missing inventory reads as empty without creating state', () => withScratch('inventory-read-', directory => Effect.gen(function*() {
  assert.deepEqual(yield* loadInventory(directory), createEmptyInventory());
  assert.deepEqual(readdirSync(directory), []);
})));

it.effect('inventory reads and writes reject symbolic-link files without following them', () => withScratch('inventory-symlink-', directory => Effect.gen(function*() {
  const outside = join(directory, 'outside.json');
  const inventoryPath = join(directory, 'inventory.json');
  writeFileSync(outside, '{"schemaVersion":2,"projects":[],"artifacts":[]}\n');
  symlinkSync(outside, inventoryPath);
  const loadFailure = yield* Effect.result(loadInventory(directory));
  assert.equal(loadFailure._tag, 'Failure');
  if (loadFailure._tag === 'Failure') assert(loadFailure.failure.category === 'corrupt' && /symbolic link/.test(loadFailure.failure.message));
  const saveFailure = yield* Effect.result(saveInventory(directory, createEmptyInventory()));
  assert.equal(saveFailure._tag, 'Failure');
  if (saveFailure._tag === 'Failure') assert.equal(saveFailure.failure.category, 'corrupt');
  assert.equal(readFileSync(outside, 'utf8'), '{"schemaVersion":2,"projects":[],"artifacts":[]}\n');
})));

it.effect('inventory updates reject a concurrent writer and release the lock on completion', () => withScratch('inventory-lock-', directory => Effect.gen(function*() {
  let startUpdate = () => {};
  let releaseUpdate = () => {};
  const started = new Promise<void>(resolve => { startUpdate = resolve; });
  const barrier = new Promise<void>(resolve => { releaseUpdate = resolve; });
  const first = yield* Effect.forkChild(updateInventory(directory, async inventory => {
    startUpdate();
    await barrier;
    return inventory;
  }));
  yield* Effect.tryPromise(() => started);
  const second = yield* Effect.result(updateInventory(directory, inventory => inventory));
  assert.equal(second._tag, 'Failure');
  if (second._tag === 'Failure') assert.equal(second.failure.category, 'conflict');
  releaseUpdate();
  yield* Fiber.join(first);
  assert.deepEqual(readdirSync(directory), []);
})));

it.effect('inventory update recovers a lock left by a dead process', () => withScratch('inventory-stale-lock-', directory => Effect.gen(function*() {
  writeFileSync(join(directory, '.inventory.lock'), JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' }));
  yield* updateInventory(directory, inventory => inventory);
  assert.deepEqual(readdirSync(directory), []);
})));

it.effect('inventory writes replace atomically and round-trip', () => withScratch('inventory-write-', directory => Effect.gen(function*() {
  yield* saveInventory(directory, createEmptyInventory());
  const inventoryPath = join(directory, 'inventory.json');
  assert.equal(readFileSync(inventoryPath, 'utf8'), '{\n  "artifacts": [],\n  "projects": [],\n  "schemaVersion": 2\n}\n');
  assert.deepEqual(yield* loadInventory(directory), createEmptyInventory());
  assert.deepEqual(readdirSync(directory), ['inventory.json']);
})));
