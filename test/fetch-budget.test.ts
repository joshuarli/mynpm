import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MynpmError } from '../src/errors.ts';
import { createFetchByteBudget } from '../src/fetch-budget.ts';
import { limits } from '../src/limits.ts';

test('fetch byte budget accepts the exact cap and rejects the next byte', () => {
  const budget = createFetchByteBudget();

  assert.equal(budget.consume(limits.fetchBytes), limits.fetchBytes);
  assert.equal(budget.usedBytes, limits.fetchBytes);
  assert.throws(() => budget.consume(1), error => error instanceof MynpmError && error.category === 'operation' && /newly downloaded byte limit/.test(error.message));
  assert.equal(budget.usedBytes, limits.fetchBytes);
});
