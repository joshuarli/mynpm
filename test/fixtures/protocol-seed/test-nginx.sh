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
