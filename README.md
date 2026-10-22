# mynpm

`mynpm` creates a static npm archive from exact package versions and imported lockfiles. It verifies each upstream tarball, stores it by SHA-512, renders npm packuments, and publishes immutable generations. It does not run package lifecycle scripts during resolution, acquisition, or validation.

The generated site contains static files. Serve it from an HTTP server that follows the `current` generation link. The server must support encoded scoped paths such as `current/@types%2fnode`. Return packuments as `application/json` and tarballs as binary. New packuments point to SHA-512 tarballs at `current/-/tarballs/`. The publisher keeps hard links at `current/tarballs/` and immutable shared files at `tarballs/` for older packuments. Metadata and tarballs use the same origin, so npm 12 accepts them with its default remote-fetch policy. This repository does not deploy the site.

## Requirements

- Node.js 26 or newer to run the CLI and package-manager workflows.
- The current npm release for npm workflows, or pnpm 12.15.0 for pnpm workflows.

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

`import-lock` records the observed packages and a snapshot of the project manifest, lockfile, and workspace manifests. It never edits the project; credential-bearing URLs and unsupported install settings are rejected before state is written. `add` resolves exact root pins with the selected package manager and does not run scripts. `fetch` verifies public npm metadata, tarballs, and archive contents. `publish` writes a static site from verified local state without contacting npm. The default site path is `.work/site`; `--site-dir` can select another local path, and symlink path components are rejected.

The hard limits are 64 MiB per metadata response, 1 GiB per compressed tarball, 2 GiB unpacked per tarball, 100,000 archive entries, five redirects, ten minutes per request, one hour per fetch, four concurrent downloads, and 10 GiB of newly downloaded data per fetch. Exceeding a limit rejects the operation.

## Inspect and validate

`plan` prints the current inventory; `plan --json` emits stable JSON. `doctor` reads a project and reports non-registry sources, install hooks, and known browser or native-download risks. It suggests a migration but never changes the project. Local workspace links are restored from saved workspace manifests, but workspace source files are not archived. Make migrations in a disposable copy and compare exact package/version/integrity selections before changing the original project.

Run the pinned client validation against imported npm or pnpm projects for the current configured target:

```sh
node --experimental-strip-types src/cli.ts --config mynpm.json --state-dir .work/state validate --client npm
node --experimental-strip-types src/cli.ts --config mynpm.json --state-dir .work/state validate --client pnpm
```

Validation restores the saved manifest, lockfile, and workspace files in a temporary copy. It directs registry tarball requests to the local archive, then runs `npm ci` or `pnpm install --frozen-lockfile` with scripts disabled and fresh caches. It compares the complete resulting lockfile graph, inspects installed package instances, and checks complete local tarball responses by status, content type, size, and SHA-512. It checks both `/` and `/mirror/` and does not write to the original project. `validate --smoke-executables` separately runs selected TypeScript or esbuild binaries; this executes dependency code.

Linux CI runs the static-client checks in a container with loopback enabled and external networking disabled. The other client jobs check local registry requests without claiming OS-level egress isolation. Snapshot capture supports only `.npmrc` `legacy-peer-deps` and `install-links` booleans; unsupported npm settings, pnpm executable hooks and plugins, package-manager boot dependencies, custom registries, runtime downloads, and patch configurations fail before client execution. Workspace manifests are captured, but workspace source files are not.

This archive provides registry independence for the package metadata and tarballs that it contains. It does not guarantee a true air-gapped install: application lifecycle scripts may access the network when a consumer later runs them, and native or browser packages can download extra files outside the registry.
