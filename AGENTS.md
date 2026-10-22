# Repository guide

`mynpm` is a Node.js ESM CLI; user workflows are in [README.md](README.md).

Run the full offline suite with Node.js 22.16.0/npm 10.9.2: `npm test`. Run static-client checks with Node.js 24.22.0/npm 12.2.1/pnpm 12.15.0: `node --test test/publish.test.mjs test/validate.test.mjs`.

Set `TMPDIR="$PWD/.work/tmp"` for tests and campaign commands; keep generated state and sites under `.work/`. `.github/workflows/ci.yml` runs read-only jobs and exposes its public registry smoke only by manual dispatch.

`src/cli.mjs` owns command parsing; `src/config.mjs` validates configuration. `src/lock-npm.mjs`, `src/lock-pnpm.mjs`, and `src/project-snapshot.mjs` own lock import and project snapshots.

`src/acquire.mjs` verifies artifacts and `src/limits.mjs` owns fixed limits. `src/packument.mjs` renders metadata; `src/publish.mjs` writes immutable generations. `src/validate.mjs` restores saved projects in temporary copies and compares the lock graph.

Never run dependency lifecycle scripts during resolution, acquisition, or registry-only validation.
