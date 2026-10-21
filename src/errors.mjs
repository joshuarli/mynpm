const exitCodes = Object.freeze({
  usage: 2,
  input: 2,
  operation: 1,
  conflict: 1,
  corrupt: 1,
  cancelled: 130,
});

export class MynpmError extends Error {
  constructor(category, message, options = {}) {
    super(message, options);
    if (!(category in exitCodes)) throw new TypeError(`unknown error category: ${category}`);
    this.name = 'MynpmError';
    this.category = category;
  }
}

export function exitCodeFor(error) {
  return error instanceof MynpmError ? exitCodes[error.category] : 1;
}
