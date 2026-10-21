#!/usr/bin/env bash
# E2E: discovery of a HOST-CONFIGURED native `@deepseek-ai/dsh-mcp-client` row
# (read-only external MCP + conflict handling). Workspace scoping has been removed
# from the product, so this script only checks discovery/read-only/conflict.
#
# Throwaway DSH_HOME + web profile, two boots:
#   A. a native dsh-mcp-client row `native-echo` running
#      test/e2e/fixtures/live-echo-server.mjs + dsh-mcp-manager installed with
#      install/activate.sh:
#        - state.servers has exactly one `native-echo` row with source:'host',
#          readOnly:true, entryId, active:true, scope:'profile', no `workspaces`
#          field; status.mounted/toolCount>=1; no manager-side duplicate;
#        - the external row is not editable: server.update (even with the removed
#          `workspaces` field) / server.remove / server.toggle → EXTERNAL_READONLY;
#          server.add with the same name → EXISTS_HOST_CONFIG;
#        - the state value exposes no `workspaces`/`externalScopes` legacy fields.
#   B. a manager manifest entry with the same serverName is pre-seeded:
#        - state merges it into ONE row (source:'manager', conflict:'host',
#          readOnly) carrying the host entry metadata;
#        - status marks the conflict with an explanatory lastError;
#        - only one copy of the native tools exists (toolCount === 1).
#
# The live Desktop profile is never touched.
#
# Usage: bash test/e2e/native-discovery-smoke.sh
# Env: DSH_CLI, KEEP=1, TEMPLATE (default web), BOOT_TIMEOUT (default 90)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
TEMPLATE="${TEMPLATE:-web}"
PROFILE="mcp-manager-e2e-native"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-90}"
NODE_BIN="$(command -v node || true)"
ECHO_SERVER="$ROOT/test/e2e/fixtures/live-echo-server.mjs"

[ -x "$CLI" ] || { echo "FAIL: dsh CLI not executable at $CLI" >&2; exit 1; }
[ -n "$NODE_BIN" ] || { echo "FAIL: node not on PATH" >&2; exit 1; }
[ -f "$ECHO_SERVER" ] || { echo "FAIL: fixture MCP server missing at $ECHO_SERVER" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mcp-manager-e2e-native.XXXXXX")"
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

boot() { # $1 = tag
  local tag="$1"
  local log="$TMP/boot-$tag.log"
  env -i \
    PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$HOME_DIR" \
    TMPDIR="${TMPDIR:-/tmp}" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-$(id -un)}" \
    LANG="${LANG:-en_US.UTF-8}" \
    DSH_HOME="$HOME_DIR" \
    "$CLI" "$PROFILE" --no-open --port 0 < /dev/null > "$log" 2>&1 &
  BOOT_PID=$!
  URL=""
  for _ in $(seq 1 $((BOOT_TIMEOUT * 2))); do
    URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$log" 2>/dev/null | head -1 || true)"
    [ -n "$URL" ] && break
    kill -0 "$BOOT_PID" 2>/dev/null || break
    sleep 0.5
  done
  [ -n "$URL" ] || { echo "boot $tag: no URL" >&2; tail -20 "$log" >&2; return 1; }
  PORT="${URL#http://127.0.0.1:}"; PORT="${PORT%%/*}"
  BASE="http://127.0.0.1:$PORT"
  JAR="$TMP/cookies-$tag.txt"
  rm -f "$JAR"
  curl -fsS -L --max-time 15 -c "$JAR" -b "$JAR" "$URL" -o "$TMP/index-$tag.html" 2>"$TMP/curl-$tag.err" || { echo "boot $tag: cookie exchange failed" >&2; return 1; }
  echo "   serving on 127.0.0.1:$PORT"
  return 0
}

stop() {
  local code=0
  if [ -n "${BOOT_PID:-}" ] && kill -0 "$BOOT_PID" 2>/dev/null; then
    kill -TERM "$BOOT_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$BOOT_PID" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$BOOT_PID" 2>/dev/null; then kill -9 "$BOOT_PID" 2>/dev/null || true; fi
  fi
  wait "$BOOT_PID" 2>/dev/null
  code=$?
  BOOT_PID=""
  return "$code"
}

rpc_call() { # $1=endpoint $2=payload-json-file $3=out-file
  node - "$1" "$2" "$TMP/envelope.json" <<'NODE'
const fs = require('node:fs');
const [endpoint, payloadPath, outPath] = process.argv.slice(2);
fs.writeFileSync(outPath, JSON.stringify({
  type: 'client-request',
  rpcId: `native-${endpoint}-${Date.now()}`,
  method: endpoint,
  payload: JSON.parse(fs.readFileSync(payloadPath, 'utf8')),
}));
NODE
  curl -sS --max-time 45 -b "$JAR" -c "$JAR" \
    -H 'content-type: application/json' \
    --data-binary "@$TMP/envelope.json" "$BASE/mcp-manager/$1" -o "$3"
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

wait_state() { # $1=tag $2=js-check(reads r) $3=timeout-seconds
  local tag="$1" check="$2" timeout="$3"
  printf '{}' > "$TMP/payload-empty.json"
  for _ in $(seq 1 $((timeout * 2))); do
    rpc_call state "$TMP/payload-empty.json" "$TMP/state-$tag.json" 2>/dev/null || true
    if node - "$TMP/state-$tag.json" "$check" <<'NODE' 2>/dev/null
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
  return 1
}

# ---------------------------------------------------------------------------
# 0-2. profile + native row + plugin
# ---------------------------------------------------------------------------
say "0/9 materialize '$PROFILE' from the shipped '$TEMPLATE' profile"
if ! env -i PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME_DIR" TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" "$CLI" "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >"$TMP/dump.log" 2>&1; then
  echo "FAIL: could not materialize profile" >&2; cat "$TMP/dump.log" >&2; exit 1
fi
PATCH="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
if [ "$(grep -vE '^[[:space:]]*(#|$)' "$PATCH" | tr -d '[:space:]')" = "[]" ]; then
  grep -vE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH" > "$PATCH.tmp" || true
  mv "$PATCH.tmp" "$PATCH"
fi

say "1/9 install the native '@deepseek-ai/dsh-mcp-client' row (serverName native-echo)"
cat >> "$PATCH" <<YAML

- insert:
    - id: native-echo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: native-echo
        transport: stdio
        command: '$NODE_BIN'
        args:
          - '$ECHO_SERVER'
        toolCallTimeoutMs: 10000
        failOnStartupError: false
YAML

say "2/9 install dsh-mcp-manager via install/activate.sh"
if ! DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" >"$TMP/activate.log" 2>&1; then
  echo "FAIL: activate.sh failed" >&2; cat "$TMP/activate.log" >&2; exit 1
fi
MANIFEST="$HOME_DIR/mcp-manager.json"

# ---------------------------------------------------------------------------
# A. discovery + read-only
# ---------------------------------------------------------------------------
say "3/9 boot A (native row + manager)"
if ! boot a; then echo "FAIL: phase A boot failed" >&2; exit 1; fi

if wait_state a '
  if (r?.ok !== true) return "state not ok";
  const servers = r.value?.servers ?? [];
  const matches = servers.filter((s) => s.serverName === "native-echo");
  if (matches.length !== 1) return `expected exactly 1 native-echo row, got ${matches.length}`;
  const row = matches[0];
  if (row.source !== "host") return `source=${row.source}`;
  if (row.readOnly !== true) return `readOnly=${row.readOnly}`;
  if (typeof row.entryId !== "string" || row.entryId.length === 0) return `entryId=${JSON.stringify(row.entryId)}`;
  if (row.active !== true) return `active=${row.active}`;
  if (row.scope !== "profile") return `scope=${row.scope}`;
  if (!(r.value?.status?.["native-echo"]?.toolCount >= 1)) return `status=${JSON.stringify(r.value?.status?.["native-echo"])}`;
  return null;' 90; then
  pass "state discovers the host row (source:host, readOnly, entryId, active, scope:profile, toolCount>=1)"
else
  fail "host row discovery/status did not match"
fi

if assert_result "state legacy fields removed" "$TMP/state-a.json" '
  const servers = r.value?.servers ?? [];
  if (servers.length !== 1) return `servers=${JSON.stringify(servers.map((s) => s.serverName))}`;
  const row = servers[0];
  if (Object.hasOwn(row, "workspaces")) return `row still exposes workspaces=${JSON.stringify(row.workspaces)}`;
  if (Object.hasOwn(r.value, "externalScopes")) return "state still exposes externalScopes";
  if (JSON.stringify(r.value).includes("externalScopes")) return "state body mentions externalScopes";
  return null;'; then
  pass "external row and state expose no workspace-scope fields"
else
  fail "state still exposes workspace-scope fields"
fi

say "4/9 external row is read-only"
cat > "$TMP/payload-legacy-update.json" <<JSON
{"serverName":"native-echo","workspaces":[]}
JSON
rpc_call server.update "$TMP/payload-legacy-update.json" "$TMP/res-legacy-update.json"
if assert_result "update external row" "$TMP/res-legacy-update.json" '
  if (r?.ok !== false) return `ok=${r?.ok} (external row was edited)`;
  if (r.error?.code !== "EXTERNAL_READONLY") return `code=${r.error?.code} message=${r.error?.message}`;
  return null;'; then
  pass "server.update external row (legacy workspaces payload) → EXTERNAL_READONLY"
else
  fail "server.update external row was not rejected with EXTERNAL_READONLY"
fi

cat > "$TMP/payload-name.json" <<JSON
{"serverName":"native-echo"}
JSON
rpc_call server.remove "$TMP/payload-name.json" "$TMP/res-remove.json"
if assert_result "remove external row" "$TMP/res-remove.json" '
  if (r?.ok !== false) return `ok=${r?.ok}`;
  if (r.error?.code !== "EXTERNAL_READONLY") return `code=${r.error?.code}`;
  return null;'; then pass "server.remove external row → EXTERNAL_READONLY"; else fail "server.remove not EXTERNAL_READONLY"; fi

cat > "$TMP/payload-toggle.json" <<JSON
{"serverName":"native-echo","enabled":false}
JSON
rpc_call server.toggle "$TMP/payload-toggle.json" "$TMP/res-toggle.json"
if assert_result "toggle external row" "$TMP/res-toggle.json" '
  if (r?.ok !== false) return `ok=${r?.ok}`;
  if (r.error?.code !== "EXTERNAL_READONLY") return `code=${r.error?.code}`;
  return null;'; then pass "server.toggle external row → EXTERNAL_READONLY"; else fail "server.toggle not EXTERNAL_READONLY"; fi

cat > "$TMP/payload-add.json" <<JSON
{"serverName":"native-echo","transport":"stdio","command":"$NODE_BIN","args":["$ECHO_SERVER"]}
JSON
rpc_call server.add "$TMP/payload-add.json" "$TMP/res-add.json"
if assert_result "add colliding name" "$TMP/res-add.json" '
  if (r?.ok !== false) return `ok=${r?.ok} (manager accepted a duplicate of the host row)`;
  if (r.error?.code !== "EXISTS_HOST_CONFIG") return `code=${r.error?.code} message=${r.error?.message}`;
  return null;'; then pass "server.add same name → EXISTS_HOST_CONFIG"; else fail "server.add colliding name not EXISTS_HOST_CONFIG"; fi

say "5/9 stop profile A"
stop; A_EXIT=$?
[ "$A_EXIT" = "0" ] && pass "profile A exited cleanly on SIGTERM" || fail "profile A exit=$A_EXIT"

# ---------------------------------------------------------------------------
# B. conflict with a manager manifest entry of the same name
# ---------------------------------------------------------------------------
say "6/9 pre-seed a manager manifest entry named native-echo (conflict)"
node - "$MANIFEST" "$NODE_BIN" "$ECHO_SERVER" <<'NODE'
const fs = require('node:fs');
const [file, nodeBin, echoServer] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  version: 2,
  servers: [{
    serverName: 'native-echo',
    transport: 'stdio',
    enabled: true,
    toolCallTimeoutMs: 10000,
    command: nodeBin,
    args: [echoServer],
    env: {},
    cwd: '',
  }],
}, null, 2)}\n`, { mode: 0o600 });
NODE

say "7/9 boot B (conflict) and assert a single merged row"
if ! boot b; then echo "FAIL: phase B boot failed" >&2; exit 1; fi
if wait_state b '
  if (r?.ok !== true) return "state not ok";
  const matches = (r.value?.servers ?? []).filter((s) => s.serverName === "native-echo");
  if (matches.length !== 1) return `expected 1 merged row, got ${matches.length}: ${JSON.stringify(matches.map((m) => m.source))}`;
  const row = matches[0];
  if (row.source !== "manager") return `source=${row.source}`;
  if (row.conflict !== "host") return `conflict=${JSON.stringify(row.conflict)}`;
  if (row.readOnly !== true) return `readOnly=${row.readOnly}`;
  if (typeof row.entryId !== "string" || row.entryId.length === 0) return `entryId=${JSON.stringify(row.entryId)}`;
  if (row.active !== true) return `active=${row.active}`;
  if (Object.hasOwn(row, "workspaces")) return "merged row still exposes workspaces";
  const status = r.value?.status?.["native-echo"];
  if (!status) return "missing status";
  if (status.conflict !== "host") return `status.conflict=${JSON.stringify(status.conflict)}`;
  if (typeof status.lastError !== "string" || status.lastError.length === 0) return `status.lastError=${JSON.stringify(status.lastError)}`;
  if (status.toolCount !== 1) return `status.toolCount=${status.toolCount} (duplicate mount?)`;
  return null;' 90; then
  pass "conflict boot: one merged row (source:manager, conflict:host, readOnly) + status conflict/lastError, toolCount=1"
else
  fail "conflict boot state did not match"
fi
node - "$TMP/state-b.json" <<'NODE'
const fs = require('node:fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).result;
const row = (r.value?.servers ?? []).find((s) => s.serverName === 'native-echo') ?? null;
const status = r.value?.status?.['native-echo'] ?? null;
console.log(JSON.stringify({ mergedRow: row, statusNativeEcho: status }, null, 2));
NODE

say "8/9 stop profile B"
stop; B_EXIT=$?
[ "$B_EXIT" = "0" ] && pass "profile B exited cleanly on SIGTERM" || fail "profile B exit=$B_EXIT"

echo ""
echo "summary: $PASS passed, $FAILED failed"
[ "$FAILED" = "0" ] || exit 1
echo "OK: native dsh-mcp-client discovery/read-only/conflict contract holds (workspace scoping removed)."
