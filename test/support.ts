import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import type * as Scope from 'effect/Scope';

const scratchRoot = fileURLToPath(new URL('../.work/tmp/', import.meta.url));

type ScratchEffect<A, E, R> = (directory: string) => Effect.Effect<A, E, R>;

export function hasErrorCategory<Category extends string>(category: Category): (error: unknown) => error is Error & { category: Category } {
  return (error): error is Error & { category: Category } => error instanceof Error && 'category' in error && error.category === category;
}

export function withScratch<A, E, R>(run: ScratchEffect<A, E, R>): Effect.Effect<A, E, R | Scope.Scope>;
export function withScratch<A, E, R>(prefix: string, run: ScratchEffect<A, E, R>): Effect.Effect<A, E, R | Scope.Scope>;
export function withScratch<A, E, R>(prefixOrRun: string | ScratchEffect<A, E, R>, selectedRun?: ScratchEffect<A, E, R>): Effect.Effect<A, E, R | Scope.Scope> {
  const prefix = typeof prefixOrRun === 'string' ? prefixOrRun : 'mynpm-';
  const run = typeof prefixOrRun === 'string' ? selectedRun : prefixOrRun;
  if (run === undefined) throw new Error('scratch run callback is required');
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      mkdirSync(scratchRoot, { recursive: true });
      return mkdtempSync(join(scratchRoot, prefix));
    }),
    run,
    directory => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
}
