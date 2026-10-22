# mynpm

`mynpm` builds a curated, static npm archive from exact package versions and imported lockfiles. It verifies upstream tarballs, stores them by SHA-512, renders full npm packuments, and publishes immutable generations to a local directory. It does not run package lifecycle scripts during resolution, acquisition, or validation.

The generated site is a set of static files. Serve the directory with a static HTTP server that supports encoded scoped paths such as `current/@types%2fnode`, returns JSON files as `application/json`, and serves tarballs as binary files. Metadata and tarballs use absolute URLs on the same origin. A production deployment is outside this tool and this repository's CI.

## Requirements

- Node.js 22.13 or newer to run the CLI and offline suite.
- `yaml@2.9.1`, installed from the lockfile for pnpm lockfile parsing.
- npm 12.2.1 or pnpm 12.15.0 with Node.js 24.22.0 for `add` and `validate`.
- npm 10.9.2 with Node.js 22.16.0 is the compatibility client covered by the CI matrix.

Install the one locked runtime dependency without running package scripts:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

The offline test suite is `npm test`. Tests use local HTTP static servers and fresh package-manager caches; they do not contact npm. The workflow installs its pinned parser dependency before starting that offline suite.

## Configuration

Copy [`test/fixtures/mynpm.json`](test/fixtures/mynpm.json) to `mynpm.json` and set `publicBaseUrl` to the HTTPS origin and path where the generated site will be served. The fixture uses `https://deps.example.net/mirror/` as a placeholder. Keep `upstreamRegistry` at `https://registry.npmjs.org/` and the fixed policy values unchanged.

The default targets are macOS arm64 and Linux x64 glibc. Additional supported targets are macOS x64, Linux arm64 glibc, and Linux x64 or arm64 musl. Each target pins the Node.js version used for resolution. Only claim a target after running its client validation on that target.

## Build an archive

Keep campaign state and generated sites under `.work` when following these examples:

```sh
mkdir -p .work/tmp
export TMPDIR="$PWD/.work/tmp"

node src/cli.mjs --config mynpm.json --state-dir .work/state \
  import-lock ../app/package-lock.json --project app
node src/cli.mjs --config mynpm.json --state-dir .work/state \
  add typescript@5.9.3 esbuild@0.28.2 --manager npm
node src/cli.mjs --config mynpm.json --state-dir .work/state plan
node src/cli.mjs --config mynpm.json --state-dir .work/state fetch
node src/cli.mjs --config mynpm.json --state-dir .work/state verify
node src/cli.mjs --config mynpm.json --state-dir .work/state \
  publish --site-dir .work/site
```

`import-lock` reads the supplied lockfile and records its observed packages and an immutable snapshot of the project manifest, lockfile, and workspace importer manifests. It does not edit the project. Inventory schema version 2 stores these snapshots. Schema version 1 state is rejected because it predates project snapshots. Lockfile URL credentials and query strings are removed from the saved snapshot. `add` resolves only exact root pins with the selected pinned package manager, lockfile-only mode, and scripts disabled. The resolver gets a temporary home and registry configuration; caller npm tokens, custom registries, and other ambient npm settings are not passed to it. `fetch` reads metadata and tarballs from public npm, verifies their integrity and archive contents, and stages verified bytes. `publish` reads local verified state and writes a static site without contacting upstream. The default site path is `.work/site`; `--site-dir` can select another local path, and any symlink component is rejected. Campaign examples and tests keep the site under `.work`.

The hard limits are 64 MiB per metadata response, 1 GiB per compressed tarball, 2 GiB unpacked per tarball, 100,000 archive entries, five redirects, ten minutes per request, one hour per fetch, four concurrent downloads, and 10 GiB of newly downloaded data per fetch. Exceeding a limit rejects the operation.

## Inspect and validate

`plan` prints the current inventory; `plan --json` emits stable JSON. `doctor` reads a project and reports non-registry sources, root and package install hooks, and known browser or native-download risks. It prints a suggested migration command but never changes the project. Local workspace links do not become archived registry packages. Inventory snapshots retain their workspace manifests so validation can restore those links, but they do not archive workspace source files. Make any migration in a disposable `.work` copy, then compare exact package/version/integrity selections and install with fresh caches before considering it for the original project.

Run the pinned client validation against imported npm or pnpm projects for the current configured target:

```sh
node src/cli.mjs --config mynpm.json --state-dir .work/state validate --client npm
node src/cli.mjs --config mynpm.json --state-dir .work/state validate --client pnpm
```

Validation creates a temporary static site, restores each saved manifest and lockfile in a project copy, and uses fresh caches under `.work/tmp`. It rewrites only registry tarball URLs in the copied lockfile, then runs `npm ci` or `pnpm install --frozen-lockfile`. It compares the client’s resulting lockfile with the migrated snapshot and checks exact package/version/integrity selections. It checks both `/` and `/mirror/`, verifies that client requests reached the loopback site, and runs TypeScript or esbuild when directly selected. It disables scripts and npm audit. It requires Node.js 24.22.0 with the exact client version.

npm's `replace-registry-host` behavior only rewrites the npm registry host by default. `omit-lockfile-registry-resolved` can remove registry URLs from a newly generated npm lockfile, but it does not establish that a rewritten project kept the same graph. See the official [npm configuration reference](https://docs.npmjs.com/cli/v12/using-npm/config/). pnpm lockfiles can contain explicit tarball URLs; inspect them and compare exact selections after migration.

This archive provides registry independence for the package metadata and tarballs that it contains. It does not guarantee a true air-gapped install: application lifecycle scripts may access the network when a consumer later runs them, and native or browser packages can download extra files outside the registry.

## CI

Pushes and pull requests run the offline suite on Node.js 22.16.0/npm 10.9.2, plus static-client integration on Linux x64 and macOS arm64 with Node.js 24.22.0/npm 12.2.1 and pnpm 12.15.0. Workflow permissions are read-only. There are no npm publish or deployment jobs; the manual smoke writes only a local site under `.work`.

The public-registry smoke is disabled by default. To run it, manually dispatch the `CI` workflow with `public_smoke` enabled. It resolves `typescript@5.9.3` and `esbuild@0.28.2`, fetches and verifies their public npm artifacts, writes publication output only under `.work`, and validates the temporary local static site with fresh caches. It does not execute package scripts or publish externally.

## Current proof status

Offline implementation and protocol tests have passed locally on Node.js 26.12.0/npm 11.20.0. The exact pinned parser dependency is not installed in this local environment, so three YAML-dependent tests are skipped. The pinned npm and pnpm consumer matrix and real public smoke still require the configured CI runners; no local version is substituted for those proofs.
