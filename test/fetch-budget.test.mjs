import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFetchByteBudget } from '../src/fetch-budget.mjs';
import { limits } from '../src/limits.mjs';

test('fetch byte budget accepts the exact cap and rejects the next byte', () => {
  const budget = createFetchByteBudget();

  assert.equal(budget.consume(limits.fetchBytes), limits.fetchBytes);
  assert.equal(budget.usedBytes, limits.fetchBytes);
  assert.throws(() => budget.consume(1), error => error.category === 'operation' && /newly downloaded byte limit/.test(error.message));
  assert.equal(budget.usedBytes, limits.fetchBytes);
});
