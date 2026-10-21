#!/usr/bin/env bash
# E2E: `server.importTest` (batch connectivity test) and `server.import` enabled
# default, over the real authenticated `/mcp-manager` HTTP RPC in an isolated
# web profile.
#
# Covers:
#   A. importTest bad JSON → the documented invalid-input shape (ok:false /
#      INVALID_INPUT, or ok:true with parseErrors);
#   B. importTest mixed batch (local stdio live-echo + unreachable streamable-http):
#      per-server results, ok entry carries latencyMs + tools[echo], the failed
#      entry carries an error code, one failure does not hide the other;
#   C. importTest with 12 entries: only the first 10 are probed, remaining 2 are
#      reported in `skipped`;
#   D. importTest never persists anything: state/manifest stay empty;
#   E. response bodies do not echo a pasted header secret (importTest never returns
#      header values; import stores plaintext, which the state is expected to show);
#   F. import `enabled` default: payload enabled:false → entries land enabled=false
#      and are not mounted; an entry's own `enabled:true` wins; payload enabled:true
#      applies to entries without their own value; invalid type → INVALID_INPUT.
#
# Usage: bash test/e2e/import-test-smoke.sh
# Env: DSH_CLI, KEEP=1, TEMPLATE (default web), BOOT_TIMEOUT (default 90)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
TEMPLATE="${TEMPLATE:-web}"
PROFILE="mcp-manager-e2e-importtest"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-90}"
NODE_BIN="$(command -v node || true)"
ECHO_SERVER="$ROOT/test/e2e/fixtures/live-echo-server.mjs"
DEAD_URL="http://127.0.0.1:9/mcp"
SECRET="Bearer IMPORTTEST-SECRET-9f2c"

[ -x "$CLI" ] || { echo "FAIL: dsh CLI not executable at $CLI" >&2; exit 1; }
[ -n "$NODE_BIN" ] || { echo "FAIL: node not on PATH" >&2; exit 1; }
[ -f "$ECHO_SERVER" ] || { echo "FAIL: fixture MCP server missing at $ECHO_SERVER" >&2; exit 1; }
if ! grep -q "importTest" "$ROOT"/lib/*.js 2>/dev/null; then
  echo "WARN: no server.importTest in lib/ yet (host task-21 pending); run will fail on the importTest assertions." >&2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mcp-manager-e2e-importtest.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR"
PASS=0
FAILED=0
BOOT_PID=""

cleanup() {
  if [ -n "$BOOT_PID" ] && kill -0 "$BOOT_PID" 2>/dev/null; then
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
say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# 0-2. throwaway profile + plugin + boot
# ---------------------------------------------------------------------------
say "0/8 materialize '$PROFILE' from the shipped '$TEMPLATE' profile"
if ! env -i PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME_DIR" TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" "$CLI" "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >"$TMP/dump.log" 2>&1; then
  echo "FAIL: could not materialize profile" >&2; cat "$TMP/dump.log" >&2; exit 1
fi

say "1/8 install dsh-mcp-manager via install/activate.sh"
if ! DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" >"$TMP/activate.log" 2>&1; then
  echo "FAIL: activate.sh failed" >&2; cat "$TMP/activate.log" >&2; exit 1
fi
MANIFEST="$HOME_DIR/mcp-manager.json"

say "2/8 boot the isolated profile (--port 0, stdin closed)"
env -i \
  PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$HOME_DIR" \
  TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" \
  LOGNAME="${LOGNAME:-$(id -un)}" \
  LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" \
  "$CLI" "$PROFILE" --no-open --port 0 < /dev/null > "$TMP/boot.log" 2>&1 &
BOOT_PID=$!

URL=""
for _ in $(seq 1 $((BOOT_TIMEOUT * 2))); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$TMP/boot.log" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$BOOT_PID" 2>/dev/null || break
  sleep 0.5
done
if [ -z "$URL" ]; then echo "FAIL: no served URL in boot log" >&2; tail -30 "$TMP/boot.log" >&2; exit 1; fi
PORT="${URL#http://127.0.0.1:}"; PORT="${PORT%%/*}"
BASE="http://127.0.0.1:$PORT"
JAR="$TMP/cookies.txt"
echo "   serving on 127.0.0.1:$PORT"
if ! curl -fsS -L --max-time 15 -c "$JAR" -b "$JAR" "$URL" -o "$TMP/index.html" 2>"$TMP/curl.err"; then
  echo "FAIL: cookie exchange failed: $(head -1 "$TMP/curl.err")" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
rpc_call() { # $1=endpoint $2=payload-json-file $3=out-file
  node - "$1" "$2" "$TMP/envelope.json" <<'NODE'
const fs = require('node:fs');
const [endpoint, payloadPath, outPath] = process.argv.slice(2);
fs.writeFileSync(outPath, JSON.stringify({
  type: 'client-request',
  rpcId: `it-${endpoint}-${Date.now()}`,
  method: endpoint,
  payload: JSON.parse(fs.readFileSync(payloadPath, 'utf8')),
}));
NODE
  curl -sS --max-time 90 -b "$JAR" -c "$JAR" \
    -H 'content-type: application/json' \
    --data-binary "@$TMP/envelope.json" "$BASE/mcp-manager/$1" -o "$3"
}

# make_payload <out> <inner-json-file> <extra-json-object>
make_payload() {
  node - "$1" "$2" "$3" <<'NODE'
const fs = require('node:fs');
const [out, innerPath, extra] = process.argv.slice(2);
const payload = { json: fs.readFileSync(innerPath, 'utf8'), ...JSON.parse(extra) };
fs.writeFileSync(out, JSON.stringify(payload));
NODE
}

assert_result() { # $1=label $2=response-file $3=js-body
  node - "$1" "$2" "$3" <<'NODE'
const fs = require('node:fs');
const [label, file, check] = process.argv.slice(2);
let envelope;
try { envelope = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
  console.error(`FAIL: ${label}: response is not JSON: ${String(e.message)}`); process.exit(1);
}
if (envelope.type !== 'server-response' || typeof envelope.rpcId !== 'string') {
  console.error(`FAIL: ${label}: bad envelope: ${JSON.stringify(envelope).slice(0, 300)}`); process.exit(1);
}
const message = new Function('r', check)(envelope.result);
if (message) { console.error(`FAIL: ${label}: ${message}`); process.exit(1); }
NODE
}

wait_state() { # $1=js-check(reads r) $2=timeout-seconds $3=out-file $4=label
  local check="$1" timeout="$2" out="$3" label="$4"
  printf '{}' > "$TMP/payload-empty.json"
  for _ in $(seq 1 $((timeout * 2))); do
    rpc_call state "$TMP/payload-empty.json" "$out" 2>/dev/null || true
    if node - "$out" "$check" <<'NODE' 2>/dev/null
const fs = require('node:fs');
const [file, check] = process.argv.slice(2);
let r;
try { r = JSON.parse(fs.readFileSync(file, 'utf8')).result; } catch { process.exit(1); }
const message = new Function('r', check)(r);
process.exit(message ? 1 : 0);
NODE
    then return 0; fi
    sleep 0.5
  done
  echo "  (timed out waiting for state: $label)" >&2
  return 1
}

secret_scan() { # $1=label; remaining = filenames
  local label="$1"; shift
  if grep -qF -- "$SECRET" "$@" 2>/dev/null; then
    fail "$label: response body contains the plaintext secret"
  else
    pass "$label: response body contains no plaintext secret"
  fi
}

# ---------------------------------------------------------------------------
# A. importTest bad JSON
# ---------------------------------------------------------------------------
say "3/8 importTest with broken JSON"
printf '{not valid json' > "$TMP/inner-bad.json"
make_payload "$TMP/payload-importtest-bad.json" "$TMP/inner-bad.json" '{}'
rpc_call server.importTest "$TMP/payload-importtest-bad.json" "$TMP/res-importtest-bad.json"
if assert_result "importTest bad JSON" "$TMP/res-importtest-bad.json" '
  if (r?.ok === false) {
    if (r.error?.code !== "INVALID_INPUT") return `ok=false code=${r.error?.code}`;
    return null;
  }
  if (r?.ok === true) {
    const parseErrors = r.value?.parseErrors ?? [];
    if (!Array.isArray(parseErrors) || parseErrors.length === 0) return "ok=true but no parseErrors";
    return null;
  }
  return `unexpected result: ${JSON.stringify(r)}`;'; then
  pass "importTest broken JSON → ok:false/INVALID_INPUT (or parseErrors)"
else
  fail "importTest broken JSON shape mismatch"
fi

# ---------------------------------------------------------------------------
# B. importTest mixed batch: local stdio live-echo + unreachable endpoint
# ---------------------------------------------------------------------------
say "4/8 importTest mixed batch (probe-ok stdio live-echo + probe-dead unreachable)"
cat > "$TMP/inner-mixed.json" <<JSON
{"mcpServers":{"probe-ok":{"type":"stdio","command":"$NODE_BIN","args":["$ECHO_SERVER"]},"probe-dead":{"type":"streamable-http","url":"$DEAD_URL","headers":{"Authorization":"$SECRET"}}}}
JSON
make_payload "$TMP/payload-importtest-mixed.json" "$TMP/inner-mixed.json" '{"toolCallTimeoutMs":10000,"enabled":false}'
rpc_call server.importTest "$TMP/payload-importtest-mixed.json" "$TMP/res-importtest-mixed.json"
if assert_result "importTest mixed" "$TMP/res-importtest-mixed.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  const results = r.value?.results ?? [];
  if (!Array.isArray(results) || results.length !== 2) return `results=${JSON.stringify(results)}`;
  const okEntry = results.find((x) => x.serverName === "probe-ok");
  const deadEntry = results.find((x) => x.serverName === "probe-dead");
  if (!okEntry) return "probe-ok result missing";
  if (okEntry.ok !== true) return `probe-ok.ok=${okEntry.ok} error=${JSON.stringify(okEntry.error)}`;
  if (!(typeof okEntry.latencyMs === "number" && okEntry.latencyMs >= 0)) return `probe-ok.latencyMs=${JSON.stringify(okEntry.latencyMs)}`;
  if (!Array.isArray(okEntry.tools) || !okEntry.tools.some((t) => t.name === "echo")) return `probe-ok.tools=${JSON.stringify(okEntry.tools)}`;
  if (!deadEntry) return "probe-dead result missing";
  if (deadEntry.ok !== false) return `probe-dead.ok=${deadEntry.ok} (unreachable endpoint must fail)`;
  if (typeof deadEntry.error?.code !== "string" || deadEntry.error.code.length === 0) return `probe-dead.error=${JSON.stringify(deadEntry.error)}`;
  if (okEntry.serverName === deadEntry.serverName) return "results collapsed";
  return null;'; then
  pass "importTest mixed: ok entry has latencyMs+tools[echo]; unreachable entry failed independently"
else
  fail "importTest mixed results mismatch"
fi
secret_scan "importTest mixed" "$TMP/res-importtest-mixed.json"
node -e 'const r=require(process.argv[1]).result; console.log("   importTest mixed:", JSON.stringify(r.value).slice(0,700))' "$TMP/res-importtest-mixed.json"

say "4b/8 importTest separates parseErrors from probed results"
cat > "$TMP/inner-mixed-parse.json" <<JSON
{"mcpServers":{"probe-dead2":{"type":"streamable-http","url":"$DEAD_URL"},"bad-entry":{"type":"stdio"}}}
JSON
make_payload "$TMP/payload-importtest-parse.json" "$TMP/inner-mixed-parse.json" '{"toolCallTimeoutMs":5000}'
rpc_call server.importTest "$TMP/payload-importtest-parse.json" "$TMP/res-importtest-parse.json"
if assert_result "importTest parseErrors" "$TMP/res-importtest-parse.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  const results = r.value?.results ?? [];
  const parseErrors = r.value?.parseErrors ?? [];
  if (results.length !== 1 || results[0]?.serverName !== "probe-dead2") return `results=${JSON.stringify(results)}`;
  if (parseErrors.length !== 1 || parseErrors[0]?.serverName !== "bad-entry") return `parseErrors=${JSON.stringify(parseErrors)}`;
  if (typeof parseErrors[0]?.message !== "string" || parseErrors[0].message.length === 0) return `parseError message=${JSON.stringify(parseErrors[0])}`;
  return null;'; then
  pass "importTest keeps an unconvertible entry in parseErrors while still probing the valid one"
else
  fail "importTest parseErrors/results separation mismatch"
fi

say "4c/8 importTest rejects a replace field"
make_payload "$TMP/payload-importtest-replace.json" "$TMP/inner-mixed.json" '{"replace":false}'
rpc_call server.importTest "$TMP/payload-importtest-replace.json" "$TMP/res-importtest-replace.json"
if assert_result "importTest replace" "$TMP/res-importtest-replace.json" '
  if (r?.ok !== false) return `ok=${r?.ok} (importTest accepted replace)`;
  if (r.error?.code !== "INVALID_INPUT") return `code=${r.error?.code} message=${r.error?.message}`;
  return null;'; then
  pass "importTest payload with replace → INVALID_INPUT"
else
  fail "importTest did not reject replace"
fi

# ---------------------------------------------------------------------------
# C. importTest >10 entries → first 10 probed, rest in skipped
# ---------------------------------------------------------------------------
say "5/8 importTest with 12 unreachable entries (only 10 probed)"
node - "$TMP/inner-many.json" <<'NODE'
const fs = require('node:fs');
const [out] = process.argv.slice(2);
const mcpServers = {};
for (let i = 1; i <= 12; i += 1) {
  mcpServers[`many-${String(i).padStart(2, '0')}`] = { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' };
}
fs.writeFileSync(out, JSON.stringify({ mcpServers }));
NODE
make_payload "$TMP/payload-importtest-many.json" "$TMP/inner-many.json" '{"toolCallTimeoutMs":2000}'
rpc_call server.importTest "$TMP/payload-importtest-many.json" "$TMP/res-importtest-many.json"
if assert_result "importTest >10" "$TMP/res-importtest-many.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  const results = r.value?.results ?? [];
  const skipped = r.value?.skipped ?? [];
  if (!Array.isArray(results)) return "results not an array";
  if (results.length !== 10) return `results.length=${results.length} (expected first 10)`;
  if (!Array.isArray(skipped) || skipped.length !== 2) return `skipped=${JSON.stringify(skipped)}`;
  const skippedNames = skipped.map((s) => (typeof s === "string" ? s : s?.serverName ?? JSON.stringify(s)));
  for (const expected of ["many-11", "many-12"]) {
    if (!skippedNames.includes(expected)) return `skipped does not name ${expected}: ${JSON.stringify(skipped)}`;
  }
  return null;'; then
  pass "importTest limits probing to 10 entries and lists the remaining 2 in skipped"
else
  fail "importTest >10 limit/skipped mismatch"
fi
secret_scan "importTest 12 entries" "$TMP/res-importtest-many.json"

# ---------------------------------------------------------------------------
# D. importTest does not persist anything
# ---------------------------------------------------------------------------
say "6/8 importTest must not persist servers or create a manifest"
if wait_state '
  if (r?.ok !== true) return "state not ok";
  const servers = r.value?.servers ?? [];
  if (servers.length !== 0) return `state persisted ${JSON.stringify(servers.map((s) => s.serverName))}`;
  return null;' 30 "$TMP/state-after-importtest.json" "state empty after importTest"; then
  pass "state still has 0 servers after all importTest calls"
else
  fail "importTest persisted servers (state not empty)"
fi
if [ -f "$MANIFEST" ]; then fail "importTest created a manifest file"; else pass "importTest did not create a manifest file"; fi

# ---------------------------------------------------------------------------
# E/F. server.import enabled default
# ---------------------------------------------------------------------------
say "7/8 server.import enabled default (payload false; entry's own value wins)"
cat > "$TMP/inner-enabled.json" <<JSON
{"mcpServers":{"default-a":{"type":"stdio","command":"$NODE_BIN","args":["$ECHO_SERVER"]},"override-b":{"type":"stdio","command":"$NODE_BIN","args":["$ECHO_SERVER"],"enabled":true},"explicit-false-c":{"type":"stdio","command":"$NODE_BIN","args":["$ECHO_SERVER"],"enabled":false}}}
JSON
make_payload "$TMP/payload-import-enabled.json" "$TMP/inner-enabled.json" '{"enabled":false,"replace":false}'
rpc_call server.import "$TMP/payload-import-enabled.json" "$TMP/res-import-enabled.json"
if assert_result "import enabled default" "$TMP/res-import-enabled.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  const added = r.value?.added ?? [];
  if (JSON.stringify(added.slice().sort()) !== JSON.stringify(["default-a","explicit-false-c","override-b"])) return `added=${JSON.stringify(added)}`;
  return null;'; then
  pass "server.import accepted a batch with payload enabled:false"
else
  fail "server.import enabled default batch failed"
fi
secret_scan "server.import enabled batch" "$TMP/res-import-enabled.json"

if node - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const [file] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const byName = new Map((m.servers ?? []).map((s) => [s.serverName, s]));
const problems = [];
if (byName.get('default-a')?.enabled !== false) problems.push(`default-a.enabled=${JSON.stringify(byName.get('default-a')?.enabled)}`);
if (byName.get('override-b')?.enabled !== true) problems.push(`override-b.enabled=${JSON.stringify(byName.get('override-b')?.enabled)}`);
if (byName.get('explicit-false-c')?.enabled !== false) problems.push(`explicit-false-c.enabled=${JSON.stringify(byName.get('explicit-false-c')?.enabled)}`);
if (problems.length) { console.error(`FAIL: manifest enabled values: ${problems.join('; ')}`); process.exit(1); }
NODE
then pass "manifest: payload default false applied, entry's own enabled:true/false wins"; else fail "manifest enabled values wrong"; fi

if wait_state '
  if (r?.ok !== true) return "state not ok";
  const status = r.value?.status ?? {};
  if (!(status["override-b"]?.toolCount >= 1)) return `override-b status=${JSON.stringify(status["override-b"])}`;
  if (status["default-a"]?.mounted !== false) return `default-a status=${JSON.stringify(status["default-a"])}`;
  if (status["explicit-false-c"]?.mounted !== false) return `explicit-false-c status=${JSON.stringify(status["explicit-false-c"])}`;
  return null;' 60 "$TMP/state-enabled.json" "import enabled mount state"; then
  pass "state: entry with enabled:true mounted; payload-default-false entries not mounted"
else
  fail "state mount status does not match the enabled defaults"
fi

say "   server.import enabled:true applies to entries without their own value"
printf '{"mcpServers":{"default-true-d":{"type":"stdio","command":"%s","args":["%s"]}}}' "$NODE_BIN" "$ECHO_SERVER" > "$TMP/inner-default-true.json"
make_payload "$TMP/payload-import-true.json" "$TMP/inner-default-true.json" '{"enabled":true}'
rpc_call server.import "$TMP/payload-import-true.json" "$TMP/res-import-true.json"
if assert_result "import enabled:true" "$TMP/res-import-true.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  if (JSON.stringify(r.value?.added) !== JSON.stringify(["default-true-d"])) return `added=${JSON.stringify(r.value?.added)}`;
  return null;' && node - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const [file] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = (m.servers ?? []).find((x) => x.serverName === 'default-true-d');
if (s?.enabled !== true) { console.error(`FAIL: default-true-d.enabled=${JSON.stringify(s?.enabled)}`); process.exit(1); }
NODE
then pass "payload enabled:true applies to an entry without its own enabled"; else fail "payload enabled:true not applied"; fi

say "   server.import rejects a non-boolean enabled with INVALID_INPUT"
make_payload "$TMP/payload-import-invalid.json" "$TMP/inner-default-true.json" '{"enabled":"yes"}'
rpc_call server.import "$TMP/payload-import-invalid.json" "$TMP/res-import-invalid.json"
if assert_result "import invalid enabled type" "$TMP/res-import-invalid.json" '
  if (r?.ok !== false) return `ok=${r?.ok} (non-boolean enabled was accepted)`;
  if (r.error?.code !== "INVALID_INPUT") return `code=${r.error?.code} message=${r.error?.message}`;
  return null;'; then
  pass "server.import enabled:\"yes\" → INVALID_INPUT"
else
  fail "server.import did not reject a non-boolean enabled"
fi

say "8/8 stop the isolated profile"
kill -TERM "$BOOT_PID" 2>/dev/null || true
for _ in $(seq 1 20); do kill -0 "$BOOT_PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$BOOT_PID" 2>/dev/null; then kill -9 "$BOOT_PID" 2>/dev/null || true; fi
wait "$BOOT_PID" 2>/dev/null
BOOT_EXIT=$?
BOOT_PID=""
[ "$BOOT_EXIT" = "0" ] && pass "isolated profile exited cleanly on SIGTERM" || fail "boot exit=$BOOT_EXIT"

echo ""
echo "summary: $PASS passed, $FAILED failed"
[ "$FAILED" = "0" ] || exit 1
echo "OK: server.importTest + server.import enabled-default contract holds in an isolated web profile."
