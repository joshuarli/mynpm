# Repository guide

`mynpm` is a strict TypeScript 7 ESM CLI executed by Node.js; pnpm owns this repository's dependencies. User workflows are in [README.md](README.md).

Use pnpm 12.15.0. Install with `pnpm install --frozen-lockfile`; run `pnpm check` for TypeScript, lint, and tests. Run static-client checks with Node.js 24.22.0/npm 12.2.1/pnpm 12.15.0: `pnpm exec vitest run test/publish.test.mjs test/validate.test.mjs`.

Set `TMPDIR="$PWD/.work/tmp"` for tests and campaign commands; keep generated state and sites under `.work/`. `.github/workflows/ci.yml` runs read-only jobs and exposes its public registry smoke only by manual dispatch.

`src/cli.ts` owns command parsing; `src/config.ts` validates configuration. `src/lock-npm.ts`, `src/lock-pnpm.ts`, and `src/project-snapshot.ts` own lock import and project snapshots.

`src/acquire.ts` verifies artifacts and `src/limits.ts` owns fixed limits. `src/packument.ts` renders metadata; `src/publish.ts` writes immutable generations. `src/validate.ts` restores saved projects in temporary copies and compares the lock graph.

Never run dependency lifecycle scripts during resolution, acquisition, or registry-only validation.
