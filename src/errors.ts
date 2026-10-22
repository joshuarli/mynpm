const errorCategories = ['usage', 'input', 'operation', 'conflict', 'corrupt', 'cancelled'] as const;

export type ErrorCategory = typeof errorCategories[number];

const exitCodes: Record<ErrorCategory, number> = Object.freeze({
  usage: 2,
  input: 2,
  operation: 1,
  conflict: 1,
  corrupt: 1,
  cancelled: 130,
});

export class MynpmError extends Error {
  readonly category: ErrorCategory;

  constructor(category: ErrorCategory, message: string, options?: ErrorOptions) {
    super(message, options);
    if (!Object.hasOwn(exitCodes, category)) throw new TypeError(`unknown error category: ${category}`);
    this.name = 'MynpmError';
    this.category = category;
  }
}

export function errorCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== 'object' || !('code' in cause)) return undefined;
  return typeof cause.code === 'string' ? cause.code : undefined;
}

export function exitCodeFor(error: unknown): number {
  return error instanceof MynpmError ? exitCodes[error.category] : 1;
}
