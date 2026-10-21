import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.mjs';
import { createEmptyInventory, mergeProject } from '../src/inventory.mjs';
import { parseNpmLock } from '../src/lock-npm.mjs';
import { saveInventory } from '../src/inventory-store.mjs';
import { managerVersions } from '../src/resolve.mjs';
import { validateInventory } from '../src/validate.mjs';

const scratchRoot = fileURLToPath(new URL('../.work/tmp/', import.meta.url));
const config = parseConfig(readFileSync(new URL('./fixtures/mynpm.json', import.meta.url), 'utf8'));

function currentTarget() {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = process.arch === 'arm64' ? 'arm64' : 'x64';
  const libc = os === 'linux' ? process.report?.getReport()?.header?.glibcVersionRuntime ? 'glibc' : 'musl' : null;
  return config.targets.find(target => target.os === os && target.cpu === cpu && (target.libc ?? null) === libc);
}

test('validate fails before package acquisition when the pinned Node or package-manager toolchain differs', async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, 'validate-version-'));
  try {
    const target = currentTarget();
    const lock = JSON.parse(readFileSync(new URL('./fixtures/locks/package-lock-add.json', import.meta.url), 'utf8'));
    const project = parseNpmLock(lock, {
      projectId: 'validation',
      lockfilePath: 'validation/package-lock.json',
      targetIds: [target.id],
    });
    const stateDirectory = join(directory, 'state');
    await saveInventory(stateDirectory, mergeProject(createEmptyInventory(), project));

    if (process.version !== `v${target.node}`) {
      await assert.rejects(
        validateInventory({ client: 'npm', stateDirectory, config }),
        error => error.category === 'operation' && error.message.includes(`requires Node.js ${target.node}`),
      );
    } else {
      const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim();
      if (npmVersion !== managerVersions.npm) {
        await assert.rejects(
          validateInventory({ client: 'npm', stateDirectory, config }),
          error => error.category === 'operation' && error.message.includes(`npm ${managerVersions.npm} is required`),
        );
      } else {
        await assert.rejects(validateInventory({ client: 'npm', stateDirectory, config }), /no verified artifact/);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
