# mynpm

`mynpm` creates a static npm archive from exact package versions and imported lockfiles. It verifies each upstream tarball, stores it by SHA-512, renders npm packuments, and publishes immutable generations. It does not run package lifecycle scripts during resolution, acquisition, or validation.

The generated site contains static files. Serve it from an HTTP server that follows the `current` generation link. The server must support encoded scoped paths such as `current/@types%2fnode`. It must return packuments as `application/json` and `current/tarballs/` files as binary. Packuments point to content-addressed tarballs under `current/`, so npm 12 accepts them with its default remote-fetch policy. The canonical SHA-512 tarballs remain in `tarballs/` across generations. Metadata and tarball URLs use the same origin. This repository does not deploy the site.

## Requirements

- Node.js 22.13 or newer to run the CLI.
- npm 12.2.1 or pnpm 12.15.0 with Node.js 24.22.0 for `add` and `validate`.

Install the locked dependencies without running package scripts:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

Run `pnpm check` to type-check the CLI with TypeScript 7, lint the source and tests, and run the test suite.

## Configuration

Copy [`test/fixtures/mynpm.json`](test/fixtures/mynpm.json) to `mynpm.json` and set `publicBaseUrl` to the HTTPS origin and path where the generated site will be served. The fixture uses `https://deps.example.net/mirror/` as a placeholder. Keep `upstreamRegistry` at `https://registry.npmjs.org/` and the fixed policy values unchanged.

The default targets are macOS arm64 and Linux x64 glibc. Additional supported targets are macOS x64, Linux arm64 glibc, and Linux x64 or arm64 musl. Each target pins the Node.js version used for resolution. Only claim a target after running its client validation on that target.

## Create an archive

```sh
mkdir -p .work/tmp
export TMPDIR="$PWD/.work/tmp"

mynpm() { node --experimental-strip-types src/cli.ts "$@"; }

mynpm --config mynpm.json --state-dir .work/state \
  import-lock ../app/package-lock.json --project app
mynpm --config mynpm.json --state-dir .work/state \
  add typescript@5.9.3 esbuild@0.28.2 --manager npm
mynpm --config mynpm.json --state-dir .work/state plan
mynpm --config mynpm.json --state-dir .work/state fetch
mynpm --config mynpm.json --state-dir .work/state verify
mynpm --config mynpm.json --state-dir .work/state \
  publish --site-dir .work/site
```

`import-lock` records the observed packages and a snapshot of the project manifest, lockfile, and workspace manifests. It never edits the project; saved lockfile credentials and query strings are removed. `add` resolves exact root pins with the selected package manager and does not run scripts. `fetch` verifies public npm metadata, tarballs, and archive contents. `publish` writes a static site from verified local state without contacting npm. The default site path is `.work/site`; `--site-dir` can select another local path, and symlink path components are rejected.

The hard limits are 64 MiB per metadata response, 1 GiB per compressed tarball, 2 GiB unpacked per tarball, 100,000 archive entries, five redirects, ten minutes per request, one hour per fetch, four concurrent downloads, and 10 GiB of newly downloaded data per fetch. Exceeding a limit rejects the operation.

## Inspect and validate

`plan` prints the current inventory; `plan --json` emits stable JSON. `doctor` reads a project and reports non-registry sources, install hooks, and known browser or native-download risks. It suggests a migration but never changes the project. Local workspace links are restored from saved workspace manifests, but workspace source files are not archived. Make migrations in a disposable copy and compare exact package/version/integrity selections before changing the original project.

Run the pinned client validation against imported npm or pnpm projects for the current configured target:

```sh
node --experimental-strip-types src/cli.ts --config mynpm.json --state-dir .work/state validate --client npm
node --experimental-strip-types src/cli.ts --config mynpm.json --state-dir .work/state validate --client pnpm
```

Validation restores the saved manifest, lockfile, and workspace files in a temporary copy. It directs registry tarball requests to the local archive, then runs `npm ci` or `pnpm install --frozen-lockfile` with scripts disabled and fresh caches. It compares the complete resulting lockfile graph and package/version/integrity selections. It checks both `/` and `/mirror/`, keeps package-manager requests on the loopback site, and runs TypeScript or esbuild when directly selected. It does not write to the original project.

This archive provides registry independence for the package metadata and tarballs that it contains. It does not guarantee a true air-gapped install: application lifecycle scripts may access the network when a consumer later runs them, and native or browser packages can download extra files outside the registry.
