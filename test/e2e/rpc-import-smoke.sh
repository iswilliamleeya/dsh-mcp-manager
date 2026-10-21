#!/usr/bin/env bash
# E2E: real HTTP smoke of the `/mcp-manager` RPC in an isolated web profile.
#
# Covers the `server.import` endpoint added for paste-a-JSON import:
#   1. exchange the launch token for a browser cookie via the served index;
#   2. POST a real `mcpServers` wrapper for "flomo" with a PLAINTEXT header:
#      encryption was removed, so it is stored verbatim (no enc:v1:), visible in
#      state, and the manifest stays 0600;
#   3. POST the same payload again → skipped reason=EXISTS;
#   4. import a server pointing at an unreachable local endpoint with enabled:true:
#      the import still succeeds and the host stays alive (status/state keep
#      answering);
#   5. GET → 405 and unauthenticated POST → 401 (admission before method).
#
# The profile is throwaway: fresh DSH_HOME under $TMPDIR, web template, plugin
# installed with install/activate.sh. The live Desktop profile is never touched.
#
# Usage: bash test/e2e/rpc-import-smoke.sh
# Env: DSH_CLI, KEEP=1, BOOT_TIMEOUT (default 90), RPC_TIMEOUT (default 45)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
TEMPLATE="${TEMPLATE:-web}"
PROFILE="mcp-manager-e2e-rpc"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-90}"
RPC_TIMEOUT="${RPC_TIMEOUT:-45}"
FLOMO_URL="https://flomoapp.com/mcp"
DEAD_URL="http://127.0.0.1:9/mcp"
NODE_BIN="$(command -v node || true)"
ECHO_SERVER="$ROOT/test/e2e/fixtures/live-echo-server.mjs"

[ -x "$CLI" ] || { echo "FAIL: dsh CLI not executable at $CLI" >&2; exit 1; }
command -v curl >/dev/null || { echo "FAIL: curl not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not on PATH" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mcp-manager-e2e-rpc.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR"
LOG="$TMP/boot.log"
JAR="$TMP/cookies.txt"
PASS=0
FAILED=0

cleanup() {
  if [ -n "${BOOT_PID:-}" ] && kill -0 "$BOOT_PID" 2>/dev/null; then
    kill -TERM "$BOOT_PID" 2>/dev/null || true
    sleep 0.5
    kill -9 "$BOOT_PID" 2>/dev/null || true
    wait "$BOOT_PID" 2>/dev/null
  fi
  if [ "${KEEP:-0}" = "1" ]; then echo "kept: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
echo "TMP=$TMP"

pass() { PASS=$((PASS + 1)); echo "  PASS: $*"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $*" >&2; }

# --- 0. throwaway profile + install -----------------------------------------
echo "0/7 materialize '$PROFILE' from the shipped '$TEMPLATE' profile"
if ! env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME_DIR" TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" "$CLI" "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >"$TMP/dump.log" 2>&1; then
  echo "FAIL: could not materialize profile" >&2
  cat "$TMP/dump.log" >&2
  exit 1
fi
PATCH="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"

echo "1/7 install dsh-mcp-manager via install/activate.sh"
if ! DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" >"$TMP/activate.log" 2>&1; then
  echo "FAIL: activate.sh failed" >&2
  cat "$TMP/activate.log" >&2
  exit 1
fi
MANIFEST="$HOME_DIR/mcp-manager.json"

# --- 2. boot ----------------------------------------------------------------
echo "2/7 boot the isolated profile (--port 0, stdin closed)"
env -i \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$HOME_DIR" \
  TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" \
  LOGNAME="${LOGNAME:-$(id -un)}" \
  LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" \
  "$CLI" "$PROFILE" --no-open --port 0 < /dev/null > "$LOG" 2>&1 &
BOOT_PID=$!

URL=""
for _ in $(seq 1 $((BOOT_TIMEOUT * 2))); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$BOOT_PID" 2>/dev/null || break
  sleep 0.5
done
if [ -z "$URL" ]; then
  echo "FAIL: no served URL in boot log" >&2
  tail -30 "$LOG" >&2
  exit 1
fi
PORT="${URL#http://127.0.0.1:}"
PORT="${PORT%%/*}"
BASE="http://127.0.0.1:$PORT"
echo "   serving on 127.0.0.1:$PORT"

# --- 3. cookie via index ----------------------------------------------------
echo "3/7 exchange launch token for the browser cookie"
if ! curl -fsS -L --max-time 15 -c "$JAR" -b "$JAR" "$URL" -o "$TMP/index.html" 2>"$TMP/curl-index.err"; then
  echo "FAIL: index/token exchange failed: $(head -1 "$TMP/curl-index.err")" >&2
  exit 1
fi
grep -q '__DSH_BOOT__' "$TMP/index.html" && pass "index served with __DSH_BOOT__ + cookie jar" || fail "index missing __DSH_BOOT__"
grep -q 'dsh-mcp-manager/client.js' "$TMP/index.html" && pass "index boot graph advertises dsh-mcp-manager/client.js" || fail "client bundle missing from index"

# Build and POST one `client-request` envelope, writing the full server response.
rpc_call() { # $1=endpoint $2=payload-json-file $3=out-file
  local endpoint="$1" payload_file="$2" out_file="$3"
  node - "$endpoint" "$payload_file" "$TMP/envelope.json" <<'NODE'
const fs = require('node:fs');
const [endpoint, payloadPath, outPath] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
fs.writeFileSync(outPath, JSON.stringify({
  type: 'client-request',
  rpcId: `smoke-${endpoint}-${Date.now()}`,
  method: endpoint,
  payload,
}));
NODE
  curl -sS --max-time "$RPC_TIMEOUT" -b "$JAR" -c "$JAR" \
    -H 'content-type: application/json' \
    --data-binary "@$TMP/envelope.json" "$BASE/mcp-manager/$endpoint" -o "$out_file"
}

# Extract `result` from a server-response file and assert on it with node.
# Usage: assert_result <label> <response-file> <js-expression-on-r-returning-msg|null>
assert_result() {
  local label="$1" file="$2" check="$3"
  node - "$label" "$file" "$check" <<'NODE'
const fs = require('node:fs');
const [label, file, check] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
let envelope;
try { envelope = JSON.parse(text); } catch (e) {
  console.error(`FAIL: ${label}: response is not JSON: ${text.slice(0, 300)}`);
  process.exit(1);
}
if (envelope.type !== 'server-response' || typeof envelope.rpcId !== 'string') {
  console.error(`FAIL: ${label}: bad envelope: ${text.slice(0, 300)}`);
  process.exit(1);
}
const result = envelope.result;
const r = result;
const message = new Function('r', check)(r);
if (message) { console.error(`FAIL: ${label}: ${message}`); process.exit(1); }
NODE
}

# --- 4. plaintext secret import (encryption removed: stored + visible) -------
echo "4/7 server.import flomo with a plaintext header (stored verbatim, no encryption)"
cat > "$TMP/payload-flomo.json" <<JSON
{"json":"{\"mcpServers\":{\"flomo\":{\"type\":\"streamable-http\",\"url\":\"$FLOMO_URL\",\"headers\":{\"Authorization\":\"Bearer TEST\"},\"enabled\":false}}}","replace":false}
JSON
rpc_call server.import "$TMP/payload-flomo.json" "$TMP/res-flomo-1.json"
if assert_result "import #1 flomo" "$TMP/res-flomo-1.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  const v = r.value ?? {};
  if (JSON.stringify(v.added) !== JSON.stringify(["flomo"])) return `added=${JSON.stringify(v.added)}`;
  if ((v.skipped ?? []).length !== 0) return `skipped=${JSON.stringify(v.skipped)}`;
  return null;'; then
  pass "plaintext-header import added flomo (no encryption refusal)"
else
  fail "plaintext-header import failed"
fi

if node - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const [file] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const flomo = (m.servers ?? []).find((s) => s.serverName === 'flomo');
const problems = [];
if (!flomo) problems.push('flomo missing from manifest');
else {
  if (flomo.headers?.Authorization !== 'Bearer TEST') problems.push(`headers.Authorization=${JSON.stringify(flomo.headers)}`);
  if (flomo.transport !== 'streamable-http') problems.push(`transport=${flomo.transport}`);
  if (flomo.enabled !== false) problems.push(`enabled=${flomo.enabled}`);
  if (JSON.stringify(flomo).includes('enc:v1:')) problems.push('manifest contains enc:v1:');
}
const mode = fs.statSync(file).mode & 0o777;
if (mode !== 0o600) problems.push(`manifest mode=${mode.toString(8)}`);
if (problems.length) { console.error(`FAIL: manifest: ${problems.join('; ')}`); process.exit(1); }
NODE
then pass "manifest stores the plaintext header verbatim (0600, no enc:v1:)"; else fail "manifest plaintext header mismatch"; fi

printf '{}' > "$TMP/payload-empty.json"
rpc_call state "$TMP/payload-empty.json" "$TMP/res-state-early.json"
if assert_result "plaintext visible in state" "$TMP/res-state-early.json" '
  const row = (r.value?.servers ?? []).find((s) => s.serverName === "flomo");
  const header = (row?.headers ?? []).find((e) => e.name === "Authorization");
  if (!header) return "flomo header missing from state";
  if (header.value !== "Bearer TEST") return `header=${JSON.stringify(header)}`;
  if (Object.hasOwn(header, "secret")) return "header is still masked with a secret flag";
  if (Object.hasOwn(r.value ?? {}, "encryption")) return "state still has encryption field";
  return null;'; then
  pass "state exposes the plaintext header verbatim, no mask/encryption"
else
  fail "state does not expose the plaintext header"
fi

# --- 5. duplicate import + header-free import ------------------------------
echo "5/7 server.import flomo again (expect skipped reason=EXISTS)"
rpc_call server.import "$TMP/payload-flomo.json" "$TMP/res-flomo-2.json"
if assert_result "import #2 skipped EXISTS" "$TMP/res-flomo-2.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  const v = r.value ?? {};
  if ((v.added ?? []).length !== 0) return `added=${JSON.stringify(v.added)}`;
  const skipped = v.skipped ?? [];
  if (skipped.length !== 1 || skipped[0].serverName !== "flomo" || skipped[0].reason !== "EXISTS") return `skipped=${JSON.stringify(skipped)}`;
  return null;'; then pass "duplicate import is skipped with reason=EXISTS"; else fail "duplicate import result mismatch"; fi

node - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const [file] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const n = (m.servers ?? []).filter((s) => s.serverName === 'flomo').length;
if (n !== 1) { console.error(`FAIL: flomo entries=${n}`); process.exit(1); }
NODE
if [ $? -eq 0 ]; then pass "manifest still has exactly one flomo entry"; else fail "manifest duplicated flomo"; fi

# --- 6. enabled:true unreachable server: import must not crash the host ------
echo "6/7 server.import an enabled:true unreachable server (failure containment)"
cat > "$TMP/payload-dead.json" <<JSON
{"json":"{\"mcpServers\":{\"dead\":{\"type\":\"streamable-http\",\"url\":\"$DEAD_URL\",\"enabled\":true}}}","replace":false}
JSON
rpc_call server.import "$TMP/payload-dead.json" "$TMP/res-dead.json"
if assert_result "import dead (enabled:true)" "$TMP/res-dead.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  const v = r.value ?? {};
  if (!(v.added ?? []).includes("dead")) return `added=${JSON.stringify(v.added)}`;
  return null;'; then pass "import of an unreachable enabled server still returns ok"; else fail "import dead failed"; fi

# Host must keep answering after the failed bridge mount; poll status/state.
printf '{}' > "$TMP/payload-empty.json"
RPC_ALIVE=0
for _ in $(seq 1 30); do
  rpc_call status "$TMP/payload-empty.json" "$TMP/res-status.json" 2>/dev/null || true
  rpc_call state "$TMP/payload-empty.json" "$TMP/res-state.json" 2>/dev/null || true
  if node -e '
const fs = require("node:fs");
const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).result;
if (status?.ok !== true || state?.ok !== true) process.exit(2);
const dead = status.value?.status?.dead;
if (dead === undefined) process.exit(3);
if ((state.value?.servers ?? []).every((s) => s.serverName !== "dead")) process.exit(4);
process.exit(0);' "$TMP/res-status.json" "$TMP/res-state.json"; then
    RPC_ALIVE=1
    break
  fi
  sleep 0.5
done
if [ "$RPC_ALIVE" = "1" ]; then
  pass "host stayed alive after the failed mount (status + state answered)"
else
  fail "host did not answer status/state after importing the unreachable server"
fi
node - "$TMP/res-status.json" "$TMP/res-state.json" "$LOG" <<'NODE'
const fs = require('node:fs');
const [statusFile, stateFile, logFile] = process.argv.slice(2);
const status = JSON.parse(fs.readFileSync(statusFile, 'utf8')).result;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')).result;
const deadStatus = status.value?.status?.dead ?? null;
const deadView = (state.value?.servers ?? []).find((s) => s.serverName === 'dead') ?? null;
const log = fs.readFileSync(logFile, 'utf8');
const bridgeLine = log.split('\n').find((line) => /dead/.test(line) && /(error|fail|refus|retry|ECONN)/i.test(line));
console.log(JSON.stringify({
  statusDead: deadStatus,
  stateDead: deadView,
  bridgeLogLine: bridgeLine ?? null,
}, null, 2));
console.log(`NOTE: lastError is ${deadStatus?.lastError === null || deadStatus?.lastError === undefined ? 'null (bridge handles connection failure with its own retry loop; failOnStartupError:false)' : JSON.stringify(deadStatus.lastError)}`);
NODE
pass "recorded dead-server status/state + bridge log evidence"

# --- 7. admission: GET → 405, unauthenticated → 401 -------------------------
echo "7/7 admission checks"
GET_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -b "$JAR" "$BASE/mcp-manager/state" || true)"
[ "$GET_CODE" = "405" ] && pass "GET /mcp-manager/state → 405" || fail "GET returned $GET_CODE (want 405)"
NOAUTH_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  -H 'content-type: application/json' --data-binary "@$TMP/envelope.json" "$BASE/mcp-manager/state" || true)"
[ "$NOAUTH_CODE" = "401" ] && pass "unauthenticated POST → 401" || fail "unauthenticated POST returned $NOAUTH_CODE (want 401)"

# --- teardown ---------------------------------------------------------------
echo "teardown: SIGTERM the isolated profile"
kill -TERM "$BOOT_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$BOOT_PID" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$BOOT_PID" 2>/dev/null; then
  kill -9 "$BOOT_PID" 2>/dev/null || true
  wait "$BOOT_PID" 2>/dev/null
  BOOT_EXIT=137
else
  wait "$BOOT_PID" 2>/dev/null
  BOOT_EXIT=$?
fi
BOOT_PID=""
[ "$BOOT_EXIT" = "0" ] && pass "isolated profile exited cleanly on SIGTERM (exit 0)" || fail "boot exit=$BOOT_EXIT"

echo ""
echo "summary: $PASS passed, $FAILED failed"
[ "$FAILED" = "0" ] || exit 1
echo "OK: /mcp-manager server.import HTTP contract holds in an isolated web profile."
