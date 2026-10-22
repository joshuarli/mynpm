# Static npm registry proof of concept

This is a tested *installation protocol* PoC, **not** a hardened production publisher. It requires Node.js, npm, Python 3, and (optionally) nginx. `build.mjs` has no runtime npm dependencies. It runs `npm pack --offline --ignore-scripts` on two local fixtures, computes SHA-512 and SHA-1, writes JSON npm packuments and SHA-512-addressed `.tgz` files, and points `current` at a generation directory. No registry backend is required at install time.

```sh
bash test.sh            # standard-library Python static HTTP server; npm install + clean-cache npm ci
bash test-nginx.sh      # optional; nginx static server and encoded scoped URL test
```

`test.sh` and `test-nginx.sh` cover `/mirror/current/@flatrepo%2fdemo`, `/mirror/current/flatdemo`, and `/mirror/current/-/tarballs/<sha512>.tgz`. They install a transitive dependency with `npm install` and run `npm ci` with a second empty cache. The nginx test checks `Content-Type: application/json` for metadata paths without a file suffix.

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
        -/
          tarballs/
            <sha512-hex>.tgz      (hard link to shared tarball)
        manifest.json
    tarballs/
      <sha512-hex>.tgz            (immutable content-addressed data)
```

A real implementation must additionally implement strict catalog closure, upstream integrity verification, artifact inspection, incremental acquisition, locking and crash-durable atomic publication, malicious-path rejection, per-platform policy, and client interoperability with pinned modern npm/pnpm versions. The PoC does **not** provide these security and completeness properties. It exercises only local synthetic packages with scripts disabled. pnpm was not installed in this test environment and has not been verified by this PoC.
