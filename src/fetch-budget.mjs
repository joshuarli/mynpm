import { MynpmError } from './errors.mjs';
import { formatBytes, limits } from './limits.mjs';

export function createFetchByteBudget() {
  let usedBytes = 0;
  return Object.freeze({
    get usedBytes() {
      return usedBytes;
    },
    consume(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('download byte count must be a non-negative safe integer');
      if (usedBytes + bytes > limits.fetchBytes) {
        throw new MynpmError('operation', `fetch exceeds the ${formatBytes(limits.fetchBytes)} newly downloaded byte limit`);
      }
      usedBytes += bytes;
      return usedBytes;
    },
  });
}
