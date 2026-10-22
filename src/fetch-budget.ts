import { MynpmError } from './errors.ts';
import { formatBytes, limits } from './limits.ts';

export interface FetchByteBudget {
  readonly usedBytes: number;
  consume(bytes: number): number;
}

export function createFetchByteBudget(): FetchByteBudget {
  let usedBytes = 0;
  return Object.freeze({
    get usedBytes() {
      return usedBytes;
    },
    consume(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('download byte count must be a non-negative safe integer');
      if (usedBytes + bytes > limits.fetchBytes) {
        throw new MynpmError('operation', `fetch exceeds the ${formatBytes(limits.fetchBytes)} newly downloaded byte limit`);
      }
      usedBytes += bytes;
      return usedBytes;
    },
  });
}
