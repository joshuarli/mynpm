import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { MynpmError } from '../src/errors.ts';
import { runProcess } from '../src/process.ts';

it.effect('process output rejection terminates the child and preserves the validation error', () => Effect.gen(function*() {
  const failure = new MynpmError('input', 'archive entry rejected');

  const outcome = yield* Effect.result(runProcess(process.execPath, ['-e', 'process.stdout.write("entry\\n"); setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      onStdout() {
        throw failure;
      },
    }));
  assert.equal(outcome._tag, 'Failure');
  if (outcome._tag === 'Failure') assert.equal(outcome.failure, failure);
}));

it.effect('interrupting a process effect terminates the child', () => Effect.gen(function*() {
  const started = yield* Deferred.make();
  const fiber = yield* Effect.forkChild(runProcess(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      onStdout: () => Effect.runSync(Deferred.succeed(started, undefined)),
    }));
  yield* Deferred.await(started);
  yield* Fiber.interrupt(fiber);
  const exit = yield* Fiber.await(fiber);
  assert.equal(exit._tag, 'Failure');
}));
