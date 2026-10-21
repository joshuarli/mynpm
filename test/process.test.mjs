import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MynpmError } from '../src/errors.mjs';
import { runProcess } from '../src/process.mjs';

test('process output rejection terminates the child and preserves the validation error', async () => {
  const failure = new MynpmError('input', 'archive entry rejected');

  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stdout.write("entry\\n"); setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      onStdout() {
        throw failure;
      },
    }),
    error => error === failure,
  );
});

test('an already aborted signal terminates a process as soon as it starts', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: process.env,
      signal: controller.signal,
      timeoutMs: 10_000,
    }),
    error => error.category === 'cancelled',
  );
});
