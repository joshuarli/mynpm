# mynpm campaign plan

**Status:** campaign active. P0 through P4 implementation is provisional; no phase is accepted.

**Goal:** implement the owner-approved `mynpm` design below as a small static npm archive with curated inventory, verified immutable artifacts, deterministic packuments, fail-closed validation, and atomic local publication.

**Deliverables:**

1. A Node.js ESM CLI with the exact commands, configuration, defaults, and behavior in the owner design. Proof: focused CLI/config tests and `npm test`.
2. npm and pnpm lockfile import, target-aware inventory, and exact-pin resolution. Proof: the lockfile corpus and target-specific resolution tests in Acceptance.
3. Bounded acquisition, integrity verification, package inspection, and durable local storage. Proof: integrity, malformed-input, interruption, and retry tests in Acceptance.
4. Complete static metadata generations and crash-safe local publication. Proof: real static-server client tests plus atomicity, concurrency, and recovery tests in Acceptance.
5. `validate` and `doctor`, operational documentation, and CI that never publishes or deploys. Proof: pinned npm/pnpm installs, migration-copy checks, CI configuration review, and the final acceptance commands.

**Last accepted checkpoint:** none. P0 awaits its pinned Node.js 22.16.0/npm 10.9.2 run. P1 awaits YAML parsing and exact npm/pnpm resolution with the pinned clients. P2 through P4 await their named pinned consumer and public-smoke proofs.

**Provisional work:** P0 scaffold, unchanged fixture, static-install test, and read-only CI workflow. P1 configuration, npm and pnpm lock semantics, inventory, CLI reporting, atomic state, and fake-client npm resolution pass offline tests on Node.js 26.12.0. P2 bounded acquisition and durable artifact storage, P3 deterministic rendering and atomic publication, and P4 validation, `doctor`, documentation, and CI definitions are implemented. The local full suite passes 65 tests and skips three YAML-dependent tests because `yaml@2.9.1` is not installed. The pinned client matrix, real lockfile restoration, and public `typescript@5.9.3`/`esbuild@0.28.2` smoke remain pending.

**Current steering ruling:** use one serial executor in the existing checkout. The owner identified two correctness gaps: pnpm peer-context snapshot keys differ from package artifact keys, and validation must restore original project lockfiles. The importer now matches snapshot paths to artifact IDs after removing peer context. Inventory v2 preserves project manifests, lockfiles, and workspace importer manifests. Validation rewrites only registry tarball URLs in a disposable copy, runs the pinned frozen client, and compares the complete resulting graph. Keep P1 and P4 provisional until exact YAML parsing, pinned client, and public-smoke proofs pass. Do not substitute Node.js 26.12.0/npm 11.20.0/pnpm 11.0.2 for the pinned clients. Preserve phase acceptance order and do not claim a checkpoint without its required evidence. Defer optimization.

**Next substantive milestone:** collect Node.js 22.16.0/npm 10.9.2, Node.js 24.22.0/npm 12.2.1, Node.js 24.22.0/pnpm 12.15.0, and macOS arm64 static-client results from the configured CI jobs; then run the manually opted-in public closure smoke for both managers. Keep all checkpoints provisional until those results and the YAML-dependent acceptance tests pass.

## Charter

The owner design in Reference is authoritative for product behavior. This plan supplies sequence, proof, and execution bounds. It does not grant permission beyond the owner’s implementation request.

- Implement code, tests, operational examples, docs, and repository-local CI requested by the owner design. Do not push, deploy, publish to npm, change GitHub settings, access credentials, or run `mynpm publish` against a site outside `.work/`.
- Public-registry access is limited to unauthenticated reads from the configured public npm registry and its verified tarball redirects for `add`, `fetch`, and the opt-in real-world smoke test. Never run third-party lifecycle scripts. Do not write to a user project; `doctor` reads it and performs migration checks only on a copy in `.work/`.
- Keep the exact PoC files in the owner design as the initial protocol fixture. Do not edit their bytes. Run them with `TMPDIR` set to the absolute repository path `.work/tmp`, so their temporary project and tarball scratch stay in `.work/`.
- Before the first campaign write under `.work/`, ensure `.work/` is excluded in `.git/info/exclude`, not a tracked ignore file. Keep all campaign state, test projects, caches, generated state, and local sites under `.work/`. Do not create worktrees or child agents. Commits are not authorized.
- Do not add comments to implementation code. The unchanged owner-supplied PoC is the only fixture exception because its exact bytes are a deliverable; do not copy its comments into implementation code.
- Keep one writer per active item. The executor is also the coordinator. At each phase boundary, and after five attempted items with no phase accepted, compare delivered capabilities with remaining obligations, inspect a representative accepted and rejected result, name the limiting stage, and revise tactics within the fixed contract. Record the ruling and next substantive milestone here.
- Keep the feedback loop narrow. Run the named behavior test for each change. Run the full offline suite at the end of P0, P1, P3, and P4. Do not run a workspace-wide build, formatter, release build, or unrelated CI.
- If a focused local check takes more than five minutes, reproduce and identify the bottleneck before adding features. Repair only the loop needed for the next substantive delivery. A failing item gets at most three distinct, falsifiable root-cause hypotheses. After three refuted hypotheses, recheck the binary, version, configuration, and input, then park the item with evidence and a retry condition. Never retry an unchanged failure.
- Keep feature completeness and protocol parity ahead of polish. Record product timing and size after the first complete pilot; optimize only in P5 when a measured bottleneck supports it. No product performance target or binary-size gate exists in the repository.
- Every campaign commit remains unauthorized. If the owner later authorizes commits, use Conventional Commits with the work area as scope and the item ID in the body. Pushing remains forbidden.
- Run the final `ultrareview`, fix all P1 and P2 findings, and remove campaign scratch created by this task. Do not remove user data or retained package objects.

## Decisions

### Owner-decided

- Use Node.js ESM at Node.js >=22.13. Use built-in modules except for the single `yaml` parser dependency. Use pinned npm and pnpm clients where resolution requires them.
- Implement only the listed CLI commands and global options. Keep `plan` and `doctor` nonmutating. `fetch` may download and stage. `publish` may write a local site from validated state without contacting upstream.
- Use the exact JSON configuration and the default macOS arm64 and Linux x64 glibc targets. Support the other listed Linux and macOS targets only when configured and exercised. Do not add Windows.
- Reject non-public and non-registry sources by default. Report lifecycle-script and native-download risks. Reject SHA-1-only inputs unless the explicit audited downgrade is enabled.
- Serve full packuments with absolute same-origin tarball URLs. Keep immutable tarballs outside `/current/`. Use POSIX generation promotion, retain old generations and referenced tarballs, and do not perform automatic garbage collection.
- Keep the complete non-goals in Reference. In particular, do not add a registry daemon, npm publish/authentication, audit endpoints, search, signatures, dynamic negotiation, or `/-/all`.
- **2026-10-21:** use these fixed acquisition and archive limits: 64 MiB per metadata response, 1 GiB per compressed tarball, 2 GiB unpacked per tarball, 100,000 archive entries, five redirects, ten minutes per request, one hour per fetch operation, four concurrent downloads, and 10 GiB of newly downloaded bytes per fetch. Exceeding any limit is an actionable hard failure. Do not add configuration knobs for these limits.
- **2026-10-21:** keep the `publish` command usable for a caller-selected local site directory; the campaign itself writes and tests all generated sites only under `.work`. Reject symlink path components for the local output.
- **2026-10-21:** run package-manager resolution with an isolated temporary home and only the required process path, locale, and explicit public npm settings. Do not inherit caller authentication tokens, registry overrides, or ambient npm configuration.

### Prescribed

- The current tree contains only the campaign draft. Treat all application behavior as new; do not claim compatibility with code that is not present.
- Keep the owner’s PoC byte-for-byte as a test fixture and run it under a `.work/tmp` `TMPDIR`. The current preflight smoke passed the static Python server path; it does not replace the pinned client matrix.
- Pin `yaml@2.9.1` in the project lockfile. At preflight, npm lists it under the ISC license with no runtime dependencies. Recheck the exact package metadata when creating the lockfile. Add no other runtime dependency without an owner decision. The Node tool has no compile step or standalone binary, so build time and binary size are not applicable; report the parser package’s installed size and CLI startup only if measured later.
- Give `mynpm.json` schema version 1 and `state/inventory.json` schema version 2. Inventory v2 stores project snapshots required for restoration. Reject unknown schema versions and malformed fields. Inventory v1 is pre-release state and is rejected. Do not add a migration reader before a prior released format exists. A later schema change requires a migration and old-format fixture before writing the new format.
- Serialize JSON deterministically as UTF-8 with recursively sorted object keys, stable array ordering, and one trailing newline. Keep timestamps out of generated metadata unless copied from verified upstream data. Derive generation identity from the complete canonical generated representation, public URL, renderer version, and referenced artifact digests.
- Use one CLI presentation boundary. Exit 0 on success, 2 on usage or invalid configuration/input, and 1 on operational, conflict, or corrupt-state failure. Send diagnostics to stderr once. Treat cancellation separately and clean up owned child processes and temporary files before returning.
- For `doctor`, report findings and print the safe migration command. Keep it read-only. Run that command only against a disposable project copy under `.work/`; compare exact package/version/integrity selections before and after.
- Treat `publish` as a local filesystem operation. Acceptance tests may set `--site-dir` only to `.work/` paths. Never interpret the implementation of `publish` as authority to deploy.
- Keep optional product measurements out of acceptance. If a time comparison is needed, use the same pinned real-world closure, record completed packages and bytes, take five alternating baseline/candidate runs, and report median and range. Run `perf-gate-ready` before and with `-1` immediately after; if either readiness check fails, say `perf gate deferred: host busy` and make no timing claim.

### Delegated within bounds

- Choose private module boundaries from the owner’s recommended list. Merge modules when they share ownership. Export only the CLI entry point; keep parsers, storage records, and effect adapters private.
- Choose internal type and error names that encode the approved states. Keep lockfile versions, package identities, target IDs, integrity algorithms, and publication outcomes as distinct validated values where conflation would lose data.
- Use standard-library filesystem, crypto, HTTPS, child-process, and test modules. Use the system `tar` only as a bounded, read-only child process. Do not introduce an abstraction unless a test needs controlled time, filesystem, process, or network behavior.
- If the exact pinned client cannot be obtained, do not silently substitute. Run independent offline work, park only the affected client proof, and record the missing version and condition required to retry.

## Baseline

At the starting tree, `plan.md` is the only tracked file. There is no `package.json`, source tree, test suite, workflow, or local `AGENTS.md`; no application failures are known. The repository has no performance, memory, or binary-size gate.

The owner-supplied PoC was extracted unchanged under `.work/` and run on macOS arm64 with Node.js 26.12.0, npm 11.20.0, and Python 3.9.6. `TMPDIR="$PWD/.work/tmp" bash .work/campaign-preflight-poc/test.sh` passed: two local packuments and tarballs were generated; scoped and transitive packages installed; npm install and npm ci both passed with separate fresh caches; logged metadata and tarball requests stayed on the local static server. The command took 2.46 seconds real time, 1.49 seconds user time, and 0.81 seconds system time in one run. This is a loop timing, not a product performance comparison.

The installed nginx, Node.js 22.16.0/npm 10.9.2, Node.js 24.22.0/npm 12.2.1, and pnpm 12.15.0 are unavailable in this environment. `test-nginx.sh` was not run. The required pinned client matrix remains unverified here.

Use npm 10.9.2 with Node.js 22.16.0 for the compatibility smoke. Use npm 12.2.1 and pnpm 12.15.0 with Node.js 24.22.0 for the principal client checks. The listed versions were released by the official [npm CLI](https://github.com/npm/cli/releases), [pnpm](https://github.com/pnpm/pnpm/releases), and [Node.js](https://nodejs.org/en/blog/release/v24.22.0) projects. Recheck the pinned executable versions in the CI job before use; never replace them with a floating `latest` tag.

## Sequence

### P0. Ground the loop and preserve the protocol pilot

**Size:** one end-to-end seed slice. **Prerequisites:** none. **Owner:** serial executor. **Paths:** `package.json`, the exact seed fixture under `test/fixtures/protocol-seed/`, `test/static-install.test.mjs`, and the offline CI workflow.

Create the Node project with `node --test`, the exact pinned `yaml` dependency, and no build step. Copy the fixture in Reference byte-for-byte before generalizing the implementation. Adapt only the invocation environment: set `TMPDIR` to the absolute `.work/tmp` path. Keep at least one CI test against the derived real static server. CI defaults must be offline and read-only; public npm smoke is manual or explicitly opted in.

Run the seed with npm 10.9.2 on Node 22.16.0. If that pinned toolchain is unavailable locally, use the CI matrix and park only that proof until the runner is available. Verify `npm install` and `npm ci` with separate fresh caches, `--ignore-scripts`, and `--no-audit`. Verify scoped route encoding, transitive install, package execution, and the request log. Do not add registry-server code.

**Accept when:** the protocol test passes on the pinned compatibility client; one static-server CI test exists; the full offline test suite passes; and the local check loop remains below five minutes.

### P1. Deliver configuration, CLI, inventory, and lockfile parity

**Size:** one cohesive catalog capability. **Prerequisites:** P0. **Paths:** `src/`, parser and CLI tests under `test/`, and the documented config and command references.

Implement the versioned JSON configuration, exact CLI surface, error boundary, inventory, `plan`, `import-lock`, `add`, and `doctor` reporting. Inventory schema v2 stores the original manifest and lockfile plus workspace importer manifests. Import npm lockfile v2/v3 and pnpm lockfile v9. For pnpm 12, parse and validate every YAML document; union installed registry packages from both documents and distinguish package artifact IDs from peer-context snapshot paths. A snapshot path may add peer context without adding another tarball identity. Honor `packageManager` pins and resolve each configured target separately before taking the selected package union. Do not write to user projects.

Use the exact lockfile corpus in Acceptance. Use `typescript@5.9.3` for the TypeScript-only real-world closure and `esbuild@0.28.2` for the optional native package family. Generate and retain exact lock selections in test fixtures. These pinned versions are present on npm as of 2026-10-21; use their package metadata only through the public registry and preserve integrity claims.

**Accept when:** command and config behavior is covered; all listed npm and pnpm fixtures pass or reject precisely; target union and alias identity are verified; the project snapshot round-trips and conflicts never replace an existing snapshot; `plan` and `doctor` do not mutate their inputs; `npm test` passes.

### P2. Deliver acquisition, verification, and durable artifact state

**Size:** one end-to-end verified-artifact capability. **Prerequisites:** P1. **Paths:** acquisition, archive inspection, state persistence, and corresponding tests under `src/` and `test/`.

Implement `fetch` and `verify` around the owner-approved limits. Check existing verified objects first. Fetch exact metadata and artifact bytes only from the configured HTTPS registry policy. Verify redirects, response bounds, operation timeouts, integrity claims, package identity, archive entries, and platform metadata before promotion. Write downloads to private staging, then atomically promote verified bytes to content-addressed storage. Never execute package scripts or extract an untrusted archive into the worktree.

Exercise SHA-512 and SHA-1, SHA-1-only rejection and explicit downgrade, corrupt bytes, mismatched package manifests, malformed or traversing paths, symlinks, oversized bodies, rejected redirects, aborted downloads, interrupted staging, parallel acquisition, repeated matching fetches, and conflicting digests. Rejected artifacts must never appear in verified or public storage.

**Accept when:** focused tests cover each failure boundary; a successful fetch produces the exact expected inventory/object set; a repeated fetch is a no-op; `verify` detects corruption; the offline suite passes.

### P3. Deliver deterministic packuments and atomic local publication

**Size:** one end-to-end static-generation capability. **Prerequisites:** P2. **Paths:** renderer, manifest, publisher, and corresponding tests under `src/` and `test/`.

Render full packuments from verified metadata, preserving the owner-listed resolution fields and only dist-tags whose versions are present. Generate absolute URLs from `publicBaseUrl`, including arbitrary base prefixes. Validate lowercase and uppercase scoped slash escapes. Reject malicious names and path traversal. Keep immutable tarballs globally addressable outside `/current/`.

Under the exclusive publication lock, read the current inventory, merge retained validated data, check complete target closure and every advertised digest, copy new tarballs with no-clobber semantics, durably write a new complete generation on the same filesystem, and atomically replace `current`. Do not hold the lock over network work. Preserve old generations and tarballs. Do not overwrite a finalized generation or run destructive GC.

Test identical no-op publication after staging cleanup; stale-snapshot concurrent publishers with controlled barriers; collisions; fsync, rename, and validation failures that must leave `current` unchanged; old metadata followed by a new-generation pointer switch and an old tarball request; correct full JSON content type; 404 for missing packages; and root plus `/mirror/` static URLs.

**Accept when:** the real static server serves the generated files to npm and pnpm; all atomicity and race tests pass; `npm test` passes.

### P4. Complete client validation, migration safety, docs, and CI

**Size:** one end-to-end consumer and operations capability. **Prerequisites:** P3. **Paths:** validator, doctor migration output, README and examples, CI workflow, and corresponding tests.

Restore each saved project manifest and lockfile in a temporary copy. Rewrite only registry tarball URLs in that copy. Run npm `ci` or pnpm `install --frozen-lockfile` against a temporary static server with neutral HOME/config and fresh manager caches. Require the client to preserve the migrated lockfile graph, including dependency edges, placements, peer contexts, overrides, and workspace importers. Compare exact package/version/integrity selections as a secondary check. Disable scripts for the registry-only guarantee. Use `--no-audit` for npm. Check request logs so every registry metadata and tarball request targets only the local static site. Test the site root and `/mirror/` prefix. Confirm both TypeScript and the selected platform binary execute.

Test `doctor` against npm and pnpm project copies. Detect registry, private-host, third-party-download, and non-registry `resolved` sources; recommend a safe migration without changing the user’s project. Run migration only in `.work/`; compare exact selected package/version/integrity sets and prove the result with fresh-cache npm ci. Identify lifecycle scripts and known browser/native download risks. Claim registry independence only. Do not claim true air-gapping without restricted script-enabled evidence.

CI must run fast offline tests by default, use minimal read-only permissions, keep production publishing and deployment absent, and expose real public-registry smoke only as an explicit opt-in. Run Linux x64 checks. Run macOS arm64 checks when a runner is accessible; report unavailable native targets as unverified instead of substituting a different architecture.

**Accept when:** pinned npm 10.9.2, npm 12.2.1, and pnpm 12.15.0 consumer tests pass on their named Node versions; real static integration tests pass; user projects remain byte-identical; docs state only verified commands and limitations; CI has no publish/deploy effect; the full offline suite passes.

### P5. Measure only after parity, then close

Do not schedule optimization before P0 through P4 pass. Record the first complete pilot’s command timings, peak memory when a supported measurement exists, artifact count, and total artifact size. Do not compare the expanded tool with the smaller PoC as if they performed the same work. Optimize only when a reproducible bottleneck affects the user workflow. Keep the measured workflow, input, expected output, and policy fixed; use five alternating runs and report median and range. Product timing is deferred when `perf-gate-ready` is not ready.

At close, run `npm test`, the pinned static-client acceptance matrix, and `ultrareview`. Fix all P1/P2 findings. Inspect the exact changed tree and search callers, tests, docs, scripts, and config before removing any experimental or dead implementation path. Keep the protocol fixture because CI depends on it. Remove only campaign scratch created under `.work/`. Report every skipped native or online check as unverified with its retry condition.

## Acceptance

`npm test` must be offline and independent of global caches, public npm, and developer npmrc files. Run the focused test for each item before advancing; run the full suite at P0, P1, P3, P4, and close. Use exact test names so an intentional wrong value makes the relevant test fail. Keep fixture expectations literal rather than deriving them from the parser under test.

| Deliverable | Required proof |
| --- | --- |
| CLI, config, state | Exact command/option tests; defaults; schema-version rejection; unknown-field rejection; `plan`/`doctor` nonmutation; stable exit codes; inventory snapshot round-trip, safe paths, credential scrubbing, and digest conflict. |
| npm and pnpm inventory | npm lockfile v2 and v3 with nested packages, scopes, aliases, flags, integrity, and every listed non-registry source; v1 rejection. pnpm v9 fixture with `packages`, peer-variant `snapshots`, importer aliases, and optional dependencies; pnpm 12.15 two-document fixture with first-document config and package-manager dependencies, each document’s packages unioned, no importer overwrite, and revision handling. |
| Targets and resolution | macOS arm64 and Linux x64 glibc defaults; explicit supported macOS x64, Linux arm64 glibc, and Linux x64/arm64 musl; exact target-specific optional package union; `packageManager` pin honored; no target claimed without executing it. |
| Acquisition and storage | Existing-object reuse; exact identity/version/integrity agreement; SHA-512 and historical SHA-1 checks; SHA-1-only default rejection and explicit downgrade; redirect/source rejection including loopback/private destinations; response/time/byte/concurrency limits; corrupt, aborted, oversized, mismatched, malicious-path, and archive-manifest negatives; cleanup and no promotion of rejected bytes. |
| Rendering and publication | Full JSON fidelity for all required package fields; filtered tags; lowercase/uppercase scoped URLs; arbitrary prefix; content types; missing package 404; immutable absolute tarball URLs; complete closure and digest checks; stale concurrent publishers; idempotent no-op; generation immutability; old-metadata/new-pointer fetch; durability failures leave `current` unchanged; old generations retained. |
| Client and operations | Restore original projects with fresh-cache npm ci on npm 10.9.2 and npm 12.2.1; restore original workspaces with pnpm frozen install on pnpm 12.15.0; complete lockfile graph unchanged after migration and client install; registry requests only to local static server; test at root and `/mirror/`; imported packages run; doctor flags all listed source classes. |
| Completeness and delivery | Real-world `typescript@5.9.3` closure and `esbuild@0.28.2` optional-binary family fetched online, then installed from the static site; script-risk report; no air-gap claim; offline default CI, explicit opt-in online smoke, no publishing/deploy; changed tree, exact tool versions, commands/results, artifact count/size, request traces, unsupported modes, and skipped proofs in final report. |

The npm lockfile corpus must cover nested versions, alias identity from package metadata, scopes, dev/optional/peer flags, workspaces, and `file:`, `link:`, `workspace:`, `git:`, GitHub shorthand, absolute tarball URL, private registry, and unknown sources. Local workspace links may be classified as local, but every external required package must be explicitly handled or publication must fail.

The pnpm corpus must use real fixture lockfiles. Parse all YAML documents with `yaml.parseAllDocuments()`. Test pnpm v9’s documented schema separately from pnpm 12’s environment-first two-document shape. Test the v12 manager/config packages in the first document and the project graph in the last. Treat peer suffixes as dependency instances, not separate tarballs. Reject invalid/unknown schema elements and nonzero unsupported pnpm 12 registry revisions with a precise error. Never silently omit a package because a parser found only one document.

The real-world lockfiles must be generated from exact roots on each default target, then unioned from the observed selections. Use no lifecycle scripts. Include the optional `@esbuild/darwin-arm64` and `@esbuild/linux-x64` artifacts on their respective targets. If public npm is unreachable, finish offline work and park only this proof with the failed command and retry condition.

## Execution boundary

The owner’s draft requests implementation, tests, operational examples, docs, and CI acceptance. That request covers repository-local changes and read-only public npm access for the specified acquisition and smoke tests. It does not cover commits, pushes, external publication, deployment, GitHub settings, credentials, user project writes, or execution of third-party scripts.

The campaign introduces public CLI, JSON config, inventory, packument, static URL, and local publication contracts. The owner has already specified these in Reference. Implement them without silent substitutions. If a requirement cannot be met inside the granted repository and public-read scope, park the affected item and continue independent work. Do not change a public contract, data format, permission, or transaction boundary to make acceptance pass.

## Non-goals

- Do not build a runtime registry server, Verdaccio replacement, npm publish flow, registry authentication, user API, package search, audit endpoint, signature-key endpoint, dynamic content negotiation, or `/-/all`.
- Do not mirror the entire npm registry, infer missing versions, implement a custom npm semver/peer resolver, or silently drop source types.
- Do not edit a user lockfile in place, merge project dependency trees, or run third-party lifecycle scripts during resolution, fetch, or registry-only validation.
- Do not promise true air-gapped installs, preserve upstream registry signatures after rehosting, add Windows, deploy to S3/arbitrary FTP/incompatible CDN, or automatically delete old generations or tarballs.
- Do not add optional abstractions, public commands, configuration knobs, or runtime dependencies beyond the owner design and the fixed limits above.

## Reference: owner-approved design

The following section preserves the owner’s architecture, data model, protocol fixture, complete test scenarios, and non-goals. Read it as the detailed product contract for P0 through P4. The campaign decisions above resolve its operational gaps without waiving its requirements.

### Research conclusions to accept as design inputs

I already checked the upstream npm registry metadata documentation, npm's lockfile/configuration documentation, pnpm's modern lockfile documentation, and the available prior art:

- `davglass/registry-static` already proved flat-file JSON + `.tgz` serving from nginx. Its whole-registry replication, skimdb following, and old Node dependencies are unnecessary for a curated archive. Source: https://github.com/davglass/registry-static
- `romellogoodman/npm-offline-mirror` demonstrates lockfile inventory, deduplicated checksummed downloads, and detection of non-registry/native-binary dependencies. It is an acquisition reference, not the chosen serving architecture. Source: https://github.com/romellogoodman/npm-offline-mirror
- Official npm packuments are JSON at `GET /<name>` or `GET /@scope%2fname`; the client requests either full JSON or abbreviated JSON via an Accept header. The initial archive will return **full** JSON with `Content-Type: application/json` for either request. No content negotiation backend. Source: https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md
- Clients dereference `dist.tarball`; these must be **absolute HTTP(S) URLs**, served by the same registry origin. A path such as `/mirror/tarballs/x.tgz` was verified with npm 10 to be misinterpreted as `file:/mirror/tarballs/x.tgz`, failing with ENOENT.
- npm's `replace-registry-host` and `omit-lockfile-registry-resolved` change how lockfile URLs are handled, but do not guarantee that an arbitrary pre-existing lockfile can be used without alteration. Source: https://docs.npmjs.com/cli/v11/using-npm/config/
- pnpm 12 may write **two YAML documents**: the first records manager/config dependencies; the last contains the project graph. Both can contain real packages, and `packages` plus `snapshots` have different roles. A parser reading only the first document silently loses the project dependencies. Source: https://github.com/pnpm/pnpm/blob/main/pnpm/docs/lockfile.md
- npm `audit` is a POST API, not part of this static index. Preserve separate security auditing where appropriate; install tests must use `--no-audit`. Source: https://docs.npmjs.com/cli/commands/npm-audit/
- The latest verified versions on 2026-10-21 are npm **12.2.1** and pnpm **12.15.0**; use Node.js **24.22.0** for the principal compatibility CI jobs. Also keep a npm **10.9.2** / Node **22.16.0** compatibility smoke test because the PoC below passed on it. pnpm 12 is distributed as a native executable and can be used on macOS/Linux. See https://github.com/npm/cli/releases and https://github.com/pnpm/pnpm/releases.

The full PoC at the end of this prompt has already passed with **Python's plain static HTTP server** and separately with **nginx 1.26.3**; scoped names, transitive dependencies, fresh-cache npm install, and fresh-cache npm ci all worked. It uses no registry application. Treat it as a protocol fixture, **not** hardened production code. pnpm compatibility has NOT been tested by the PoC and must be proven in this implementation.

### Final architecture: immutable tarballs, versioned JSON packuments

Choose **Node.js ESM** for the tool, not TypeScript requiring a compiler to run the tool. Target Node.js >=22.13 (production CI on 24.22.0). Prefer built-ins (`node:fs`, `node:crypto`, `node:https`, `node:child_process`, `node:test`). Allow precisely one audited YAML library, `yaml`, for parsing pnpm lockfiles; do not hand-write a YAML parser and do not add a large npm dependency stack. You may use the system `tar` command to inspect archives in a bounded, read-only subprocess. Do not build an npm semver or peer resolver: invoke pinned npm/pnpm where resolution is required.

The on-disk model is:

```text
mynpm.json                       # configuration (no giant duplicate version catalog)
state/
  inventory.json                    # exact package/version/target provenance and project snapshots
  objects/sha512/<hex>.tgz          # downloaded and verified original bytes
  tmp/                              # untrusted downloads; never consumable as artifacts
site/
  mirror/
    tarballs/<sha512-hex>.tgz        # globally stable immutable public URLs
    generations/<generation-id>/
      react                          # full JSON packument, extensionless
      typescript
      @types/node                    # scoped JSON packument, extensionless
      manifest.json                  # hash-bound complete snapshot
    current -> generations/<id>      # POSIX atomic pointer replacement
```

For public origin `https://deps.example.net/mirror/`:

- Registry base URL: `https://deps.example.net/mirror/current/`
- GET unscoped: `https://deps.example.net/mirror/current/react`
- GET scoped: `https://deps.example.net/mirror/current/@types%2fnode` (also tolerate `%2F`)
- Download: `https://deps.example.net/mirror/tarballs/<sha512-hex>.tgz`

The encoded slash in a scoped name is decoded by the static server to the physical directory separator; the filesystem path is still validated against the site root. Do not add a JSON file extension to the requested npm packument route. No registry root listing or npm `/-/` endpoints are required for installation.

**Crucial:** immutable tarballs are outside `/current/` and must remain retrievable after pointer promotion. A consumer can fetch old metadata, then fetch its tarball after a newer generation is live. Never rewrite an object at an existing digest filename.

Use one public origin for metadata and tarballs. In npm 12, restrictions on remote URL dependencies make a different-host tarball CDN undesirable. Changing scheme/host/base path means regenerating packuments/generation identities; no tarball redownload is needed.

### Exact configuration and defaults

Use a small JSON file (Node can parse it without a TOML library):

```json
{
  "schemaVersion": 1,
  "publicBaseUrl": "https://deps.example.net/mirror/",
  "upstreamRegistry": "https://registry.npmjs.org/",
  "targets": [
    { "id": "mac-arm64", "os": "darwin", "cpu": "arm64", "node": "24.22.0" },
    { "id": "linux-x64-gnu", "os": "linux", "cpu": "x64", "libc": "glibc", "node": "24.22.0" }
  ],
  "policy": {
    "externalSources": "reject",
    "remoteInstallScripts": "report",
    "allowLegacySha1Only": false
  }
}
```

Those two default targets match the useful macOS and Linux minimum. The data model must additionally support macOS x64, Linux arm64/glibc, and Linux x64/arm64 musl when explicitly configured; do not claim a target tested without executing that target. Add Windows only on request. Project `packageManager` pins must be honored and logged; do not silently resolve a pnpm project with npm.

### Exact CLI

Use one binary named `mynpm` and these commands:

```sh
mynpm import-lock ../app/package-lock.json --project app
mynpm import-lock ../web/pnpm-lock.yaml --project web
mynpm add 'typescript@5.9.3' 'react@19.2.0' --manager npm
mynpm plan [--json]
mynpm fetch
mynpm verify
mynpm publish
mynpm validate --client npm
mynpm validate --client pnpm
mynpm doctor ../app
```

Global options: `--config`, `--state-dir`, `--site-dir`; command-specific `--target`. `plan` and `doctor` must be nonmutating; `fetch` is networked and stages artifacts; `publish` uses staged and retained validated artifacts **without reaching upstream**. `validate` may spin up a disposable loopback *static* server, but must leave no resident daemon. Do not add additional public commands just for abstractions or experimentation.

`add` resolves selected exact root pins in a disposable project using the declared manager's **lockfile-only**, **ignore-scripts** operations. It adds roots to the local inventory and may fetch metadata during resolution. Do not install or execute third-party lifecycle scripts during dependency resolution. Do not change user projects or mix their dependency trees together. Resolve each target separately where metadata is target dependent, then take the union of actual selected packages, not a single global satisfiability problem.

### Inventory and import rules

The authoritative inventory consists of **observed lockfile package identities and digests**, roots, target applicability, source URLs, originating projects, and provenance. It is not a custom dependency graph solver and not a giant hand-edited list of packages. Multiple historical versions of a package are allowed. Each exact `name@version` has one canonical published tarball digest; a conflicting digest requires an explicit conflict, not a silent overwrite.

#### npm package-lock v2 and v3

Parse `packages` entries, including nested `node_modules`, scoped keys, aliases (`npm:`), optional/dev/peer flags, workspaces, and `integrity`/`resolved`. Derive **real** package identities from metadata, not by taking the last slash of a path blindly. Preserve requested aliases for reproducibility while archiving the actual distribution. Build a union of verified exact registry artifacts across projects. Reject v1 lockfiles with an actionable error; do not partially ingest them.

Treat `file:`, `link:`, `workspace:`, `git:`, GitHub source shorthands, absolute tarball URLs, private registries, and other non-public-registry sources explicitly. They are not regular npm registry tarballs and must not silently disappear. Local workspaces do not need a published tarball for intra-workspace links; document that limitation. Strict publication fails if a required external item is neither explicitly classified as local nor handled by a deliberate allowed policy.

#### pnpm lockfiles, including current pnpm 12

Use `yaml.parseAllDocuments()` and validate every document. `pnpm-lock.yaml` can contain two documents: do not use a naive one-document YAML parse. Union actual registry package inventory across both, including manager/config dependencies if present. Read `packages` entries for identity, resolution, integrity and platform metadata. Interpret `snapshots` as dependency-instance relationships, including peer suffixes; do not treat each peer instance as a new tarball. Respect importer roots and dependency aliases. Reject invalid/unknown schema elements rather than omitting them.

When pnpm 12 indicates a nonzero `resolution.revision` or tar-registry-specific artifact semantics, do not substitute ordinary same-version bytes. In v1 fail with a precise unsupported-revision diagnostic unless equivalent bytes/semantics are proven. Do not claim pnpm lockfile import complete merely because `packages` contained some entries.

#### Target handling

Respect `os`, `cpu`, `libc`, `engines`, optional dependencies and exclusions. Packages such as `@esbuild/darwin-arm64`, `@esbuild/linux-x64`, `@img/sharp-linux-*`, and `@swc/core-*` are first-class packages, not “extra binaries” outside the registry. A macOS lockfile may omit packages needed on Linux; do not infer cross-platform closure without per-target lock generation/verification or a supported cross-architecture resolution command. Keep target-specific exclusions reasoned, explicit and tested.

### Acquisition algorithm (no npm runtime dependency)

1. For each exact inventory identity/target, inspect existing verified objects first. If already present with the expected digest, do nothing.
2. For missing artifacts, fetch the version's authoritative metadata from the allowlisted upstream HTTPS origin. Require exact name, version and integrity agreement with the lockfile/other upstream evidence; preserve fields needed for resolution.
3. Select the upstream `dist.tarball` URL. Allow its HTTPS destination and redirect chain only after verifying that every hop meets the configured source policy (no `file:`, plain HTTP, loopback/internal-host SSRF, unexpected private registry, or credential leakage). Impose streaming body-size bounds, per-request and whole-operation timeouts, redirect limits, and bounded concurrency.
4. Download into private staging, never directly to the public object store. Check all known integrity claims: SHA-512 SRI when supplied, historical SHA-1 shasum when supplied, and lockfile integrity if supplied. By default reject SHA-1-only upstream inputs; allow an explicit audited downgrade only when configured, record it, and still calculate SHA-512 for storage and for the generated packument.
5. Inspect the actual npm-format `.tgz`, including `package/package.json`. Ensure package name/version match, archive contents are bounded, and no unsafe paths/symlink escapes are admitted. Archive parsing may use a bounded `tar` subprocess; do not extract arbitrary paths into the working tree or execute any package scripts. Do not claim a plain gzip hash establishes package authenticity.
6. Promote verified bytes under `state/objects/sha512/<hex>.tgz`. Reject an existing different blob under the same identity; treat repeated matching fetches as no-op. Record provenance separately from packuments. Retry only transient network errors, not integrity violations.
7. Preserve upstream deprecation, versions, constraints, peer metadata and optional dependency fields. Never synthesize invalid registry signatures/attestations or claim that rehosting retains original registry-signature verification.

Never rewrite upstream package tarballs to “fix” URL metadata. Rewrite only the generated packument's `dist.tarball` field. This preserves bytes and upstream integrity.

### Packument renderer

Produce **one full JSON packument file** per package and return it regardless of whether the HTTP client's Accept prefers `application/vnd.npm.install-v1+json`. Configure production serving to return `Content-Type: application/json`; an ordinary Python `http.server` also passed npm 10 in the PoC even with extensionless files.

Top level: `name`, `dist-tags`, `versions`, optionally `time`, `modified` and other safe upstream fields needed by clients. For each mirrored version preserve at least `name`, `version`, `dependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`, `engines`, `os`, `cpu`, `libc`, `bin`, `deprecated`, `bundleDependencies` / `bundledDependencies`, relevant shrinkwrap indicators and resolution-relevant metadata. Set `dist.tarball` to the exact absolute public URL for the immutable SHA-512 object. Include `dist.integrity = sha512-<base64>` and verified historical `dist.shasum` where available. Keep original manifest fields needed for npm/pnpm resolution; never project away metadata merely because the PoC did not need it.

Tag policy: preserve upstream dist-tags only if their target versions are mirrored. If upstream `latest` is not mirrored, do **not** invent a new `latest`; allow an explicit user-curated tag. Resolve exact pins and supported semver ranges only from curated versions. No implicit proxy for missing versions.

Render stable JSON with stable key ordering and no incidental timestamps. Validate percent-encoded scoped routes (`%2f`, `%2F`), arbitrary URL path prefix, malicious package names, and path traversal. Metadata should be short-cache/no-cache when routed through `/current/`, while digest tarballs can be cached indefinitely.

### Transactional publisher

Create staged generation G containing all packuments plus a canonical `manifest.json` for a **complete candidate**. Its identity is the SHA-256 of the canonical complete generated representation including metadata bytes, configuration's public URL, schema/renderer version, and referenced content digests. No extra timestamp or random generation IDs.

`publish` must:

- Check the complete candidate package/version and target closure. Every advertised `dist.tarball` must exist and match the claimed SHA-512. No dangling metadata, missing required package, or unverified blob is allowed.
- Put immutable tarballs in the globally stable public `/mirror/tarballs/` directory first, using no-clobber verified copy/link, durability flush and collision checking.
- Atomically write/finalize a **new** metadata generation on the same filesystem. Do not overwrite a previously finalized generation in place.
- Acquire an exclusive filesystem publication lock **before reading the current inventory**, merge with retained entries and generations, and atomically replace the `current` symlink. Avoid the stale-snapshot lost-update race. Do not hold this lock over network fetches.
- Preserve old generations and all tarballs they might reference. Recovery is conservative; no automatic destructive GC.
- Return no-op on unchanged publication, including when intermediate staging was cleaned up.
- Fail without changing `current` when validation, inventory completeness, collision or fsync checks fail.

Generation promotion is a POSIX-filesystem contract. Don't pretend S3, arbitrary FTP or incompatible static CDNs provide the same atomic symlink semantics. An optional rsync/SSH deployment recipe can copy completed snapshots, but adds no runtime requirement.

### Validator and lockfile migration

Validation restores each retained project manifest and lockfile into a temporary copy and gives the pinned client a fresh cache and neutral HOME/config. It changes only registry tarball URLs in the copied lockfile, then runs npm `ci` or pnpm `install --frozen-lockfile` against a temporary **static** server. Compare the full lockfile graph before and after migration and client installation, then compare package/version/integrity selections. Re-render metadata with an equivalent loopback base if the configured production origin is not locally reachable; validate object hashes and production URL invariants separately. The temporary server must exit cleanly; no registry server is present in production.

Demonstrate: restore original project manifests and lockfiles in temporary copies; rewrite only registry tarball URLs; then run npm `ci` or pnpm `install --frozen-lockfile` with pinned versions and `--ignore-scripts`. Compare the complete lockfile graph before and after each client, then compare package/version/integrity selections. Test `--no-audit` for npm because auditing requires POST endpoints. Verify through request logs that all packument and tarball URLs target only the static site. Test both URL root and `/mirror/` prefix. Verify packages run/import correctly.

Implement `doctor <project>` to flag lockfile `resolved` URLs going to npmjs.org, private hosts or third-party download services, and recommend a safe registry-migration operation in a **copy** of the project that preserves exact selected package versions and integrities. Do not modify the user's lockfiles in place. Test the resulting lockfile with fresh-cache npm ci; fail if the selected version graph changed unexpectedly. Report manager-specific behavior of npm's `replace-registry-host` and `omit-lockfile-registry-resolved` rather than relying blindly on them.

Keep two distinct guarantees:

- **Registry-independent**: all registry metadata and `.tgz` downloads come from our static site. This is required.
- **Truly air-gapped**: install scripts and native build tools do not download *anything* from outside. This is NOT automatic and must not be claimed absent evidence.

Identify packages with install/postinstall/prepare scripts and known browser/native download behavior (Electron, Playwright, Puppeteer, Cypress, Prisma, node-gyp/node headers, native prebuilds). Report static risk; a script can initiate arbitrary network access, so detection is not a formal sandbox proof. Test scriptless mode reliably, and separate script-enabled testing in a restricted environment. Bundled deps live in their parent tarballs; do not invent independent package tarballs for bundled internals.

No `npm publish`, registry authentication, user API, search, `npm audit`, `npm audit signatures`, full signature-key API, dynamic content negotiation or `/-/all`. These are explicit non-goals.

### Tests and CI acceptance

- Use `node:test` for offline unit/fixture tests. Tests must not depend on public npm, global caches or developer `~/.npmrc`.
- Test npm package-lock v2/v3: nested versions, alias, scopes, dep flags, integrity and nonregistry sources; reject v1 explicitly.
- Test the pnpm v9 schema and pnpm 12's two-document layout separately, including `packages` vs peer-variant `snapshots`, optional/config manager dependencies, and `revision` conflict/rejection. Use fixture lockfiles, not a dummy handwaved YAML parser.
- Test exact root resolution using actual npm/pnpm CLI in isolated temporary workspaces; no scripts. Test target union and optional native package families on the configured platforms.
- Test integrity checks (SHA-512/SHA-1), corrupt tarball, path traversal, bad archive manifest, bad redirects, oversized response, and aborted download; rejected artifacts never reach public state.
- Test packument metadata fidelity, `dist-tags`, scoped encoding in lowercase/uppercase, full JSON content type, unknown/missing packages returning 404, path prefixes, immutable tarballs and absolute URLs.
- Test parallel fetch, idempotent existing blobs, interrupted staging cleanup, atomic generation commit, versioned renderer migration, stale-snapshot concurrent publisher race using barriers, unchanged no-op, and old-metadata/new-generation tarball requests.
- Include real HTTP npm **10.9.2** smoke from the PoC, and additionally test pinned **npm 12.2.1** + **pnpm 12.15.0** on Node **24.22.0**. Test on Linux x64 and macOS arm64 when runners are accessible. Report skipped native test targets as unverified.
- Do not claim complete self sufficiency merely because a single synthetic npm install passed. Test a small representative real-world set (one TS-only dependency closure and one platform-specific optional-binary family) from public npm when online, then repeat strict installs from the static site with fresh caches.
- CI must never push to production or publish artifacts automatically, should use minimal permissions, and should have small fast offline defaults. Public-registry smoke can be an explicit CI opt-in.

Recommended implementation modules (combine if simpler): `cli.mjs`, `config.mjs`, `lock-npm.mjs`, `lock-pnpm.mjs`, `resolve.mjs`, `acquire.mjs`, `inventory.mjs`, `packument.mjs`, `publish.mjs`, `validate.mjs`. Keep cohesive pure code separate from I/O, but do not introduce classes/interfaces for their own sake.

Document only the concrete commands and verified limitations. At completion show the changed tree, exact Node/npm/pnpm versions, executed unit and end-to-end commands and outcomes, artifact count and size, integrity and concurrency tests, HTTP request traces, external-source exceptions, and known unsupported modes. If a test cannot run, explicitly say so; do not replace evidence with optimistic descriptions.

### Mandatory seed: use my actual runnable static protocol PoC

Copy the following **exactly as the initial test fixture** before generalizing the system. This is executable and was verified, not pseudocode. You can refactor after preserving its protocol test. It establishes the true URL layout, scoped routing, checksum construction, nginx static configuration, fresh-cache npm installation and npm ci. It does NOT itself implement production hardening, lockfile ingestion, or pnpm compatibility.

Run `bash test.sh` and, if nginx is available, `bash test-nginx.sh` from the PoC directory. Keep at least one continuous integration test against a real static server derived from this fixture. The file contents follow.


#### `fixtures/flatdemo/package.json`

````json
{
  "name": "flatdemo",
  "version": "1.2.3",
  "main": "index.js",
  "license": "MIT",
  "description": "Small unscoped package for a static npm registry PoC"
}
````

#### `fixtures/flatdemo/index.js`

````javascript
module.exports = 'static registry works';
````

#### `fixtures/scoped-demo/package.json`

````json
{
  "name": "@flatrepo/demo",
  "version": "2.3.4",
  "main": "index.js",
  "license": "MIT",
  "description": "Scoped package depending on another package in the static registry",
  "dependencies": { "flatdemo": "1.2.3" }
}
````

#### `fixtures/scoped-demo/index.js`

````javascript
module.exports = require('flatdemo') + ' (via @flatrepo/demo)';
````

#### `build.mjs`

````javascript
#!/usr/bin/env node
// Fully offline PoC generator. Requires only Node.js and npm. No runtime npm deps.
// Usage: node build.mjs /absolute/output/site http://127.0.0.1:PORT/mirror/
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [, , siteArg, baseArg] = process.argv;
if (!siteArg || !baseArg) {
  console.error('Usage: node build.mjs /absolute/output/site http://127.0.0.1:PORT/mirror/');
  process.exit(2);
}
const site = resolve(siteArg);
const base = new URL(baseArg);
if (!base.pathname.endsWith('/mirror/')) throw new Error('For the PoC, base URL must end in /mirror/');
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Base URL must use HTTP(S)');
const registryRoot = join(site, 'mirror');
const generation = join(registryRoot, 'generations', 'demo-v1');
const blobDir = join(registryRoot, 'tarballs');
const scratch = mkdtempSync(join(tmpdir(), 'npm-static-pack-'));
const projects = [join(import.meta.dirname, 'fixtures', 'flatdemo'), join(import.meta.dirname, 'fixtures', 'scoped-demo')];
const manifest = [];
try {
  mkdirSync(blobDir, { recursive: true });
  mkdirSync(generation, { recursive: true });
  for (const project of projects) {
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    const pack = spawnSync('npm', ['pack', project, '--ignore-scripts', '--offline', '--json', '--pack-destination', scratch], {
      encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr || pack.stdout}`);
    const [result] = JSON.parse(pack.stdout);
    const tarBytes = readFileSync(join(scratch, result.filename));
    const sha512 = createHash('sha512').update(tarBytes).digest();
    const digestHex = sha512.toString('hex');
    const integrity = 'sha512-' + sha512.toString('base64');
    const shasum = createHash('sha1').update(tarBytes).digest('hex');
    const blobName = digestHex + '.tgz';
    const blobPath = join(blobDir, blobName);
    if (existsSync(blobPath)) {
      if (!readFileSync(blobPath).equals(tarBytes)) throw new Error('Digest collision');
    } else {
      writeFileSync(blobPath, tarBytes, { flag: 'wx' });
    }
    const version = {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies ?? {},
      optionalDependencies: pkg.optionalDependencies ?? {},
      peerDependencies: pkg.peerDependencies ?? {},
      peerDependenciesMeta: pkg.peerDependenciesMeta ?? {},
      engines: pkg.engines ?? {},
      dist: {
        tarball: new URL('tarballs/' + blobName, base).href,
        integrity,
        shasum,
      },
    };
    const packument = {
      _id: pkg.name,
      name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: { [pkg.version]: version },
      time: { [pkg.version]: '2026-01-01T00:00:00.000Z' },
    };
    const dest = join(generation, ...pkg.name.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(packument, null, 2) + '\n');
    manifest.push({ name: pkg.name, version: pkg.version, integrity, tarball: version.dist.tarball });
  }
  writeFileSync(join(generation, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const current = join(registryRoot, 'current');
  const next = join(registryRoot, '.current-next');
  rmSync(next, { force: true });
  symlinkSync('generations/demo-v1', next);
  renameSync(next, current);  // Atomic pointer switch on POSIX filesystems.
  console.log(`Generated ${manifest.length} packuments with absolute tarball URLs; public registry: ${new URL('current/', base)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
````

#### `test.sh`

````bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP="$(mktemp -d)"
SERVER_PID=''
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TEMP"
}
trap cleanup EXIT
PORT="${PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')}"
BASE="http://127.0.0.1:${PORT}/mirror/"
mkdir -p "$TEMP/home" "$TEMP/project"
node "$ROOT/build.mjs" "$TEMP/site" "$BASE"
python3 -u -m http.server "$PORT" --bind 127.0.0.1 --directory "$TEMP/site" >"$TEMP/http.log" 2>&1 &
SERVER_PID=$!
for i in {1..50}; do
  if curl -fsS "${BASE}current/flatdemo" -o /dev/null 2>/dev/null; then break; fi
  sleep .1
done
curl -fsS "${BASE}current/@flatrepo%2fdemo" -o "$TEMP/scoped.json"
node -e 'const m=require(process.argv[1]); if(m.name!=="@flatrepo/demo") process.exit(1)' "$TEMP/scoped.json"
printf '{"name":"consumer","version":"1.0.0","private":true}\n' > "$TEMP/project/package.json"
cd "$TEMP/project"
touch "$TEMP/home/user.npmrc" "$TEMP/home/global.npmrc"
export HOME="$TEMP/home" npm_config_userconfig="$TEMP/home/user.npmrc" npm_config_globalconfig="$TEMP/home/global.npmrc"
npm install '@flatrepo/demo@2.3.4' \
  --registry "${BASE}current/" --cache "$TEMP/cache1" \
  --ignore-scripts --no-audit --no-fund --fetch-retries=0
node -e 'const assert = require("node:assert/strict"); assert.equal(require("@flatrepo/demo"), "static registry works (via @flatrepo/demo)"); console.log("PASS scoped + transitive dependency (npm install)")'
grep -q "127.0.0.1:${PORT}/mirror/tarballs/" package-lock.json
! grep -q 'registry.npmjs.org' package-lock.json
rm -rf node_modules
npm ci --registry "${BASE}current/" --cache "$TEMP/cache2" \
  --ignore-scripts --no-audit --no-fund --fetch-retries=0
node -e 'const assert = require("node:assert/strict"); assert.equal(require("@flatrepo/demo"), "static registry works (via @flatrepo/demo)"); console.log("PASS fresh cache + lockfile (npm ci)")'
echo '--- Static HTTP server requests ---'
grep -E 'GET .*(current/|tarballs/)' "$TEMP/http.log" || cat "$TEMP/http.log"
echo 'PASS generated site served entirely from files; no dynamic registry application'
````

#### `nginx.conf.example`

````nginx
# Replace __SITE_ROOT__ with the absolute path to the generated site.
# Replace __PORT__ with a suitable HTTP port for local testing.
worker_processes 1;
pid __PID_FILE__;
error_log __ERROR_LOG__;
events { worker_connections 128; }
http {
  access_log __ACCESS_LOG__;
  server {
    listen 127.0.0.1:__PORT__;
    root __SITE_ROOT__;
    # Static metadata (no .json suffix), including encoded scoped names.
    location ^~ /mirror/current/ {
      default_type application/json;
      add_header Cache-Control "no-cache";
      try_files $uri =404;
    }
    # Tarballs are named by SHA-512 content digest and never change.
    location ^~ /mirror/tarballs/ {
      default_type application/octet-stream;
      add_header Cache-Control "public, max-age=31536000, immutable";
      try_files $uri =404;
    }
  }
}
````

#### `test-nginx.sh`

````bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP="$(mktemp -d)"
cleanup() { nginx -s stop -c "$TEMP/nginx.conf" 2>/dev/null || true; rm -rf "$TEMP"; }
trap cleanup EXIT
chmod 755 "$TEMP"
PORT="${PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')}"
BASE="http://127.0.0.1:${PORT}/mirror/"
node "$ROOT/build.mjs" "$TEMP/site" "$BASE"
python3 - "$ROOT/nginx.conf.example" "$TEMP/nginx.conf" "$TEMP" "$PORT" <<'PY'
from pathlib import Path
import sys
src, dest, tmp, port = sys.argv[1:]
conf=Path(src).read_text()
for name,value in {'__SITE_ROOT__':str(Path(tmp)/'site'), '__PID_FILE__':str(Path(tmp)/'nginx.pid'), '__ERROR_LOG__':str(Path(tmp)/'nginx-error.log'), '__ACCESS_LOG__':str(Path(tmp)/'nginx-access.log'), '__PORT__':port}.items():
  conf=conf.replace(name,value)
Path(dest).write_text(conf)
PY
nginx -t -c "$TEMP/nginx.conf"
nginx -c "$TEMP/nginx.conf"
for i in {1..30}; do curl -fsS "${BASE}current/flatdemo" -o /dev/null 2>/dev/null && break; sleep 0.1; done
for URL in 'flatdemo' '@flatrepo%2fdemo'; do
  HEADER="$(curl -sSI "${BASE}current/$URL")"
  echo "$HEADER" | grep -iq 'HTTP/1.1 200'
  echo "$HEADER" | grep -iq 'Content-Type: application/json'
  echo "PASS nginx scoped JSON route ${URL}"
done
mkdir "$TEMP/project"
printf '{"name":"consumer","version":"1.0.0","private":true}\n' > "$TEMP/project/package.json"
cd "$TEMP/project"
export HOME="$TEMP" npm_config_userconfig="$TEMP/user.npmrc" npm_config_globalconfig="$TEMP/global.npmrc"
touch "$TEMP/user.npmrc" "$TEMP/global.npmrc"
npm install '@flatrepo/demo@2.3.4' --registry "${BASE}current/" --cache "$TEMP/cache" --ignore-scripts --no-audit --no-fund --fetch-retries=0
node -e 'const assert=require("node:assert/strict"); assert.equal(require("@flatrepo/demo"), "static registry works (via @flatrepo/demo)"); console.log("PASS nginx static npm install")'
cat "$TEMP/nginx-access.log"
````

#### `README.md`

````markdown
# Static npm registry proof of concept

This is a tested *installation protocol* PoC, **not** a hardened production publisher. It requires Node.js, npm, Python 3, and (optionally) nginx. `build.mjs` has no runtime npm dependencies. It runs `npm pack --offline --ignore-scripts` on two local fixtures, computes SHA-512 and SHA-1, writes JSON npm packuments and SHA-512-addressed `.tgz` files, and points `current` at a generation directory. No registry backend is required at install time.

```sh
bash test.sh            # standard-library Python static HTTP server; npm install + clean-cache npm ci
bash test-nginx.sh      # optional; nginx static server and encoded scoped URL test
```

Successful results on 2026-10-21: Node.js 22.16.0, npm 10.9.2, Python 3.13.5, nginx 1.26.3 (when testing nginx). The following were tested: `/mirror/current/@flatrepo%2fdemo`, `/mirror/current/flatdemo`, `/mirror/tarballs/<sha512>.tgz`, a transitive dependency, `npm install` with an empty cache, and `npm ci` using a *second* empty cache. The nginx test checked `Content-Type: application/json` even though metadata filenames have no suffix.

The generator uses a non-root `/mirror/` path intentionally and generates **absolute** `dist.tarball` URLs. It is not a full registry mirror or dependency resolver.

Generated layout:

```text
site/
  mirror/
    current -> generations/demo-v1
    generations/
      demo-v1/
        flatdemo                  (JSON packument)
        @flatrepo/demo           (JSON packument)
        manifest.json
    tarballs/
      <sha512-hex>.tgz            (immutable content-addressed data)
```

A real implementation must additionally implement strict catalog closure, upstream integrity verification, artifact inspection, incremental acquisition, locking and crash-durable atomic publication, malicious-path rejection, per-platform policy, and client interoperability with pinned modern npm/pnpm versions. The PoC does **not** provide these security and completeness properties. It exercises only local synthetic packages with scripts disabled. pnpm was not installed in this test environment and has not been verified by this PoC.
````


## Decision log

- **2026-10-21:** The owner approved the acquisition and archive limits in Decisions. Exceeding a fixed cap rejects that artifact or fetch operation; the implementation adds no limit knobs.
- **2026-10-21:** Use the exact real-world roots `typescript@5.9.3` and `esbuild@0.28.2`. Preserve each generated target lock selection as a test fixture.
- **2026-10-21:** Treat the repository as a greenfield implementation because the tracked tree contains only this plan. The embedded PoC is the only runnable protocol reference.

## Campaign log

**2026-10-21 — P0 implementation delivered; pinned proof parked.** Added the Node ESM scaffold, `yaml@2.9.1` lock entry, unchanged nine-file PoC fixture, static-install test, and read-only CI workflow. The local command `TMPDIR="$PWD/.work/tmp" npm_config_cache="$PWD/.work/tmp/npm-cache" npm test` passed on Node.js 26.12.0/npm 11.20.0 in 3.04 seconds real time. The test verifies scoped and transitive installation, fresh-cache `npm install` and `npm ci`, and local metadata/tarball request paths. The required Node.js 22.16.0/npm 10.9.2 workflow run remains unverified because that toolchain and a CI runner are unavailable here. Proceed with independent P1 work; do not substitute another version for that proof.

**2026-10-21 — P1 offline foundation provisional.** Added strict configuration parsing, npm lockfile v2/v3 import, target-aware inventory records, stable plan output, read-only npm `doctor`, and durable atomic inventory writes. `TMPDIR="$PWD/.work/tmp" node --test test/*.test.mjs` passed all 20 tests on Node.js 26.12.0 in 3.15 seconds real time. P1 is not accepted: pnpm import and `add` resolution are not implemented. `yaml@2.9.1`, npm 12.2.1, and pnpm 12.15.0 are unavailable locally. The installed pnpm is 11.0.2 and was not substituted. The plan's public-read boundary does not include fetching the parser for local development, so that fetch remains unperformed.

**2026-10-21 — P1 follow-up and steering.** Added pnpm v9/v12 document semantics, importer path persistence, package-manager pin validation, read-only pnpm `doctor`, exact-client version checks, and target-separated `add`. A fake npm 12.2.1 client resolved the fixed lock fixture for both configured targets; a fake npm 11.20.0 client was rejected before state changed. `TMPDIR="$PWD/.work/tmp" node --test test/*.test.mjs` passed 26 tests and skipped the YAML decode test because `yaml@2.9.1` is absent. Real resolver behavior and pnpm YAML decoding remain unverified. The limiting stage is unavailable parser/client proof, not the offline inventory loop. Continue P2/P3 implementation against inventory v1 while preserving P1 as unaccepted.

**2026-10-21 — P2/P3 implementation provisional.** Added bounded public-registry acquisition, artifact integrity and archive checks, locked atomic inventory updates, deterministic full packuments, immutable content-addressed tarballs, and durable generation publication. Focused P2/P3 tests passed, including local npm installs at `/` and `/mirror/`, transitive package execution, publication idempotence, old-tarball retrieval, and concurrency/failure cases. The full offline suite passed before P4 work; P3 remains unaccepted because the pinned npm 12.2.1 and pnpm 12.15.0 static-client results are not available locally.

**2026-10-21 — P4 implementation provisional.** Added `validate`, exact temporary root pins (including aliases), strict loopback request routing, a pnpm two-document YAML fixture, read-only npm/pnpm `doctor` coverage, operational documentation, Linux/macOS static-client jobs, and an explicit public-smoke dispatch input. The resolver now excludes inherited auth and custom registry settings; publisher output can target a local directory while campaign tests remain under `.work` and symlink components are rejected. `TMPDIR="$PWD/.work/tmp" npm_config_cache="$PWD/.work/tmp/npm-cache" npm_config_update_notifier=false npm_config_registry=https://registry.npmjs.org/ npm test` passed 58 tests and skipped three YAML-dependent tests on Node.js 26.12.0/npm 11.20.0; the static integration reported pnpm 12.15.0 skipped because Node.js 24.22.0/pnpm 12.15.0 are unavailable. `jaq --from yaml` parsed the workflow and the two-document fixture, and `git diff --check` passed. `actionlint` and `ultrareview` are unavailable locally. The validator success path, pinned client matrix, exact pnpm YAML decode, migration-copy proof, workflow semantic lint, final review, and opt-in public closure remain unverified. No phase checkpoint is accepted.

**2026-10-21 — P1/P4 restoration correction provisional.** Corrected pnpm peer-suffix matching and its fixture so `packages` contains the artifact ID while `snapshots` contains peer-context paths. Inventory schema v2 stores the original manifest, lockfile, and available workspace manifests; saved lockfile credentials and query strings are scrubbed. `validate` now runs npm `ci` or pnpm frozen install from the saved project graph after changing only registry tarball URLs in a temporary copy, then compares the complete lockfile structure and package selections. The full offline suite passed 65 tests and skipped three YAML-dependent tests on Node.js 26.12.0/npm 11.20.0. Real pinned consumers, real pnpm YAML decode, and public closure smoke remain unverified. Inventory v1 has no migration reader because no v1 format has been released. No phase checkpoint is accepted.

The host's default npm registry is `https://sfw.security.sentry.io/npm/`. One initial metadata lookup used that configured registry before the mismatch was detected; it returned metadata only and no tarball was fetched. A later outer `npm test` printed an npm update notice while using the same default configuration. I cannot tell whether npm used cached metadata or contacted the configured registry. The full suite was rerun with `node --test`; its package-manager subprocesses use the local static test server. The lock entry uses the canonical public npm tarball URL and integrity returned by an explicit public-registry metadata query.

## For the owner afterwards

Review the changed tree, `README.md`, the exact command/client versions, the acceptance results, artifact counts and sizes, HTTP request traces, external-source exceptions, and skipped checks. Review the new CLI, JSON config, inventory, packument, static URL, and local publication contracts together. No commits or cherry-picks are authorized by this plan.
