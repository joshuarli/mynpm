import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Effect } from 'effect';
import type { Readable } from 'node:stream';
import { MynpmError } from './errors.ts';

const diagnosticLimit = 16 * 1024;

export interface RunProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onStdout?: (chunk: Buffer) => void;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

type Child = ChildProcessByStdio<null, Readable, Readable>;

function appendTail(current: Buffer, next: Buffer): Buffer {
  const combined = Buffer.concat([current, next]);
  return combined.length > diagnosticLimit ? combined.subarray(combined.length - diagnosticLimit) : combined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function signalChild(child: Child, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return;
    if (process.platform === 'win32') throw error;
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (!hasErrorCode(fallbackError, 'ESRCH')) {
        throw new AggregateError([error, fallbackError], `could not signal ${child.spawnfile}`);
      }
    }
  }
}

function processFailure(cause: unknown, command: string): MynpmError {
  if (cause instanceof MynpmError) return cause;
  const message = cause instanceof AggregateError ? cause.message : `could not run ${command}`;
  return new MynpmError('operation', message, { cause });
}

function releaseChild(child: Child, isClosed: () => boolean, command: string): Effect.Effect<void, MynpmError> {
  if (isClosed() || child.pid === undefined) return Effect.void;
  return Effect.tryPromise({
    try: () => new Promise<void>((resolve, reject) => {
      const failures: unknown[] = [];
      let forceTimer: NodeJS.Timeout;
      const finish = (): void => {
        clearTimeout(forceTimer);
        if (failures.length > 0) {
          reject(new AggregateError(failures, `${command} failed during process cleanup`));
        } else {
          resolve();
        }
      };
      child.once('close', finish);
      forceTimer = setTimeout(() => {
        try {
          signalChild(child, 'SIGKILL');
        } catch (cause) {
          failures.push(cause);
        }
      }, 5_000);
      try {
        signalChild(child, 'SIGTERM');
      } catch (cause) {
        failures.push(cause);
      }
    }),
    catch: cause => processFailure(cause, command),
  });
}

export function runProcess(
  command: string,
  args: readonly string[],
  { cwd, env, timeoutMs, onStdout }: RunProcessOptions,
): Effect.Effect<ProcessResult, MynpmError> {
  return Effect.scoped(Effect.gen(function*() {
    let childClosed = false;
    const child = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => Promise.resolve(spawn(command, args, {
          cwd,
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        })),
        catch: cause => new MynpmError('operation', `could not start ${command}`, { cause }),
      }),
      acquired => Effect.orDie(releaseChild(acquired, () => childClosed, command)),
    );

    return yield* Effect.tryPromise({
      try: signal => new Promise<ProcessResult>((resolve, reject) => {
        let stdout: Buffer = Buffer.alloc(0);
        let stderr: Buffer = Buffer.alloc(0);
        let callbackFailed = false;
        let callbackFailure: unknown;
        let timedOut = false;
        let cancelled = false;
        let terminateTimer: NodeJS.Timeout | undefined;
        const terminationFailures: unknown[] = [];
        const requestTermination = (signalName: NodeJS.Signals): void => {
          try {
            signalChild(child, signalName);
          } catch (error) {
            terminationFailures.push(error);
          }
        };
        const forceTerminate = (): void => requestTermination('SIGKILL');
        const terminateChild = (): void => {
          requestTermination('SIGTERM');
          clearTimeout(terminateTimer);
          if (child.pid === undefined) return;
          terminateTimer = setTimeout(forceTerminate, 5_000);
        };
        const timeout = setTimeout(() => {
          timedOut = true;
          terminateChild();
        }, timeoutMs);
        const abort = (): void => {
          cancelled = true;
          terminateChild();
        };
        const interrupt = (): void => abort();
        const terminate = (): void => abort();
        const cleanup = (): void => {
          clearTimeout(timeout);
          clearTimeout(terminateTimer);
          process.removeListener('SIGINT', interrupt);
          process.removeListener('SIGTERM', terminate);
          signal.removeEventListener('abort', abort);
        };
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', terminate);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        child.once('spawn', () => {
          if (cancelled || timedOut) terminateChild();
        });
        child.stdout.on('data', (chunk: Buffer) => {
          stdout = appendTail(stdout, chunk);
          if (!callbackFailed && onStdout) {
            try {
              onStdout(chunk);
            } catch (error) {
              callbackFailed = true;
              callbackFailure = error;
              terminateChild();
            }
          }
        });
        child.stderr.on('data', (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
        child.on('error', cause => {
          cleanup();
          const failure = new MynpmError('operation', `could not run ${command}`, { cause });
          reject(terminationFailures.length > 0
            ? new AggregateError([failure, ...terminationFailures], `${command} failed during process cleanup`)
            : failure);
        });
        child.on('close', (code: number | null) => {
          childClosed = true;
          cleanup();
          if (terminationFailures.length > 0) {
            const primary = callbackFailed ? callbackFailure : cancelled
              ? new MynpmError('cancelled', `${command} was cancelled`)
              : timedOut
                ? new MynpmError('operation', `${command} exceeded its ${timeoutMs}ms time limit`)
                : new MynpmError('operation', `${command} process cleanup failed`);
            reject(new AggregateError([primary, ...terminationFailures], `${command} failed during process cleanup`));
            return;
          }
          if (callbackFailed) {
            reject(callbackFailure);
          } else if (cancelled) {
            reject(new MynpmError('cancelled', `${command} was cancelled`));
          } else if (timedOut) {
            reject(new MynpmError('operation', `${command} exceeded its ${timeoutMs}ms time limit`));
          } else if (code !== 0) {
            const diagnostic = stderr.toString('utf8').trim() || stdout.toString('utf8').trim();
            reject(new MynpmError('operation', `${command} exited with status ${String(code)}${diagnostic ? `: ${diagnostic}` : ''}`));
          } else {
            resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
          }
        });
      }),
      catch: cause => processFailure(cause, command),
    });
  }));
}
