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
