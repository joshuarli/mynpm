import { spawn } from 'node:child_process';
import { MynpmError } from './errors.mjs';

const diagnosticLimit = 16 * 1024;

function appendTail(current, next) {
  const combined = Buffer.concat([current, next]);
  return combined.length > diagnosticLimit ? combined.subarray(combined.length - diagnosticLimit) : combined;
}

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    if (process.platform === 'win32') throw error;
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (fallbackError.code !== 'ESRCH') throw new AggregateError([error, fallbackError], `could not signal ${child.spawnfile}`);
    }
  }
}

export function runProcess(command, args, { cwd, env, signal, timeoutMs, onStdout }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      reject(new MynpmError('operation', `could not start ${command}`, { cause }));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let callbackFailure = null;
    let timedOut = false;
    let cancelled = false;
    let terminateTimer;
    const terminationFailures = [];
    const requestTermination = signalName => {
      try {
        signalChild(child, signalName);
      } catch (error) {
        terminationFailures.push(error);
      }
    };
    const forceTerminate = () => requestTermination('SIGKILL');
    const terminateChild = () => {
      requestTermination('SIGTERM');
      clearTimeout(terminateTimer);
      if (child.pid === undefined) return;
      terminateTimer = setTimeout(forceTerminate, 5_000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);
    const abort = () => {
      cancelled = true;
      terminateChild();
    };
    const interrupt = () => abort();
    const terminate = () => abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('spawn', () => {
      if (cancelled || timedOut) terminateChild();
    });
    child.stdout.on('data', chunk => {
      stdout = appendTail(stdout, chunk);
      if (!callbackFailure && onStdout) {
        try {
          onStdout(chunk);
        } catch (error) {
          callbackFailure = error;
          terminateChild();
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = appendTail(stderr, chunk); });
    child.on('error', cause => {
      clearTimeout(timeout);
      clearTimeout(terminateTimer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      signal?.removeEventListener('abort', abort);
      const failure = new MynpmError('operation', `could not run ${command}`, { cause });
      reject(terminationFailures.length > 0 ? new AggregateError([failure, ...terminationFailures], `${command} failed during process cleanup`) : failure);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      clearTimeout(terminateTimer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      signal?.removeEventListener('abort', abort);
      if (terminationFailures.length > 0) {
        const primary = callbackFailure ?? (cancelled
          ? new MynpmError('cancelled', `${command} was cancelled`)
          : timedOut
            ? new MynpmError('operation', `${command} exceeded its ${timeoutMs}ms time limit`)
            : new MynpmError('operation', `${command} process cleanup failed`));
        reject(new AggregateError([primary, ...terminationFailures], `${command} failed during process cleanup`));
        return;
      }
      if (callbackFailure) {
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
  });
}
