#!/usr/bin/env bash
# E2E: clean uninstall / data deletion / reinstall, against the host-row discovery
# feature. Answers the user's question: "if I uninstall the plugin and delete its
# leftovers, will the MCP servers come back on reinstall?"
#
# Isolated DSH_HOME + web profile, one repeatable script with four phases:
#
#   A. install the manager via install/activate.sh, add two servers over the RPC
#      (`echo-on` enabled, `echo-off` disabled, both the live-echo stdio fixture),
#      assert `state.servers` has 2 manager rows and `echo-on` is mounted.
#   B. uninstall the plugin (patch row + node_modules removed) but KEEP
#      $DSH_HOME/mcp-manager.json, reinstall, boot a new process:
#      assert `state.servers` is STILL the same 2 rows and the enabled server is
#      mounted again (the manifest is the host-level registry).
#   C. uninstall again and DELETE the manifest too, reinstall, boot:
#      assert `state.servers` is EMPTY and there is no host row to discover
#      (nothing on disk still records those servers).
#   D. contrast: add one native `@deepseek-ai/dsh-mcp-client` row to the profile
#      patch (live-echo), boot: assert exactly one `source:'host'` row is
#      discovered with toolCount >= 1 — i.e. discovery only sees host config, not
#      the deleted manager manifest.
#
# Every phase records exit codes, `state.servers` names/sources, manifest
# presence/content and the patch row state, so the evidence is quotable.
#
# The live Desktop profile is never touched (no ~/.dsh writes).
#
# Usage: bash test/e2e/clean-reinstall-smoke.sh
# Env: DSH_CLI, KEEP=1, TEMPLATE (default web), BOOT_TIMEOUT (default 90)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
TEMPLATE="${TEMPLATE:-web}"
PROFILE="mcp-manager-e2e-clean"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-90}"
NODE_BIN="$(command -v node || true)"
ECHO_SERVER="$ROOT/test/e2e/fixtures/live-echo-server.mjs"

[ -x "$CLI" ] || { echo "FAIL: dsh CLI not executable at $CLI" >&2; exit 1; }
[ -n "$NODE_BIN" ] || { echo "FAIL: node not on PATH" >&2; exit 1; }
[ -f "$ECHO_SERVER" ] || { echo "FAIL: fixture MCP server missing at $ECHO_SERVER" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mcp-manager-e2e-clean.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
MANIFEST="$HOME_DIR/mcp-manager.json"
JAR="$TMP/cookies.txt"
PASS=0
FAILED=0
BOOT_PID=""
TAG=""

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
row_count() { grep -cE '^[[:space:]]*- id: mcp-manager$' "$PATCH" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
install_plugin() {
  DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" >>"$TMP/activate.log" 2>&1
}

uninstall_plugin() {
  DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" --remove >>"$TMP/activate.log" 2>&1
  rm -rf "$PROFILE_DIR/node_modules/dsh-mcp-manager"
}

boot() { # $1 = tag
  TAG="$1"
  local log="$TMP/boot-$1.log"
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
  [ -n "$URL" ] || { echo "boot $1: no URL" >&2; tail -20 "$log" >&2; return 1; }
  PORT="${URL#http://127.0.0.1:}"
  PORT="${PORT%%/*}"
  BASE="http://127.0.0.1:$PORT"
  rm -f "$JAR"
  curl -fsS -L --max-time 15 -c "$JAR" -b "$JAR" "$URL" -o "$TMP/index-$1.html" 2>"$TMP/curl-$1.err" || { echo "boot $1: cookie exchange failed" >&2; return 1; }
  return 0
}

stop() {
  local log="${TAG:+$TMP/boot-$TAG.log}"
  if [ -n "${BOOT_PID:-}" ] && kill -0 "$BOOT_PID" 2>/dev/null; then
    kill -TERM "$BOOT_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$BOOT_PID" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$BOOT_PID" 2>/dev/null; then kill -9 "$BOOT_PID" 2>/dev/null || true; fi
  fi
  wait "$BOOT_PID" 2>/dev/null
  local code=$?
  BOOT_PID=""
  [ -n "$log" ] && echo "  node process exit=$code (log: boot-$TAG.log)"
  return "$code"
}

rpc_call() { # $1=endpoint $2=payload-json-file $3=out-file
  node - "$1" "$2" "$TMP/envelope.json" <<'NODE'
const fs = require('node:fs');
const [endpoint, payloadPath, outPath] = process.argv.slice(2);
fs.writeFileSync(outPath, JSON.stringify({
  type: 'client-request',
  rpcId: `clean-${endpoint}-${Date.now()}`,
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

state_snapshot() { # $1=tag -> fetches state into $TMP/state-<tag>.json
  printf '{}' > "$TMP/payload-empty.json"
  rpc_call state "$TMP/payload-empty.json" "$TMP/state-$1.json"
}

wait_state() { # $1=tag $2=js-check(reads r) $3=timeout
  local timeout="$3"
  for _ in $(seq 1 $((timeout * 2))); do
    state_snapshot "$1" 2>/dev/null || true
    if node - "$TMP/state-$1.json" "$2" <<'NODE' 2>/dev/null
const fs = require('node:fs');
const [file, check] = process.argv.slice(2);
let r;
try { r = JSON.parse(fs.readFileSync(file, 'utf8')).result; } catch { process.exit(1); }
const message = new Function('r', check)(r);
process.exit(message ? 1 : 0);
NODE
    then echo "$(date +%H:%M:%S)"; return 0; fi
    sleep 0.5
  done
  return 1
}

server_names() { # $1=state-file -> "name:source,..." or "(none)"
  node - "$1" <<'NODE'
const fs = require('node:fs');
let r; try { r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).result; } catch { console.log('(unreadable)'); process.exit(0); }
const servers = r.value?.servers ?? [];
console.log(servers.length === 0 ? '(none)' : servers.map((s) => `${s.serverName}:${s.source}`).join(', '));
NODE
}

manifest_summary() { # prints exists + server names / md5
  if [ -f "$MANIFEST" ]; then
    local md5sum names
    md5sum="$(md5 -q "$MANIFEST" 2>/dev/null || shasum "$MANIFEST" | cut -d' ' -f1)"
    names="$(node -e 'try { const m=require(process.argv[1]); console.log((m.servers??[]).map(s=>s.serverName).join(",")||"(empty)") } catch { console.log("(unreadable)") }' "$MANIFEST")"
    echo "exists md5=$md5sum servers=$names"
  else
    echo "absent"
  fi
}

# ---------------------------------------------------------------------------
# 0. throwaway profile + install
# ---------------------------------------------------------------------------
say "0/11 materialize '$PROFILE' from the shipped '$TEMPLATE' profile"
if ! env -i PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME_DIR" TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" "$CLI" "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >"$TMP/dump.log" 2>&1; then
  echo "FAIL: could not materialize profile" >&2; cat "$TMP/dump.log" >&2; exit 1
fi
[ -f "$PATCH" ] || { echo "FAIL: patch layer missing" >&2; exit 1; }

say "1/11 install plugin (phase A)"
install_plugin && pass "activate.sh installs (patch row=$(row_count), package present)" || fail "activate.sh install failed"
[ -d "$PROFILE_DIR/node_modules/dsh-mcp-manager" ] && pass "package copied into profile node_modules" || fail "package missing after install"

say "2/11 L: seed a LEGACY manifest with the removed workspace-scope fields"
node - "$MANIFEST" "$NODE_BIN" "$ECHO_SERVER" <<'NODE'
const fs = require('node:fs');
const [file, nodeBin, echoServer] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  version: 2,
  servers: [{
    serverName: 'legacy-ws',
    transport: 'stdio',
    enabled: true,
    toolCallTimeoutMs: 10000,
    command: nodeBin,
    args: [echoServer],
    env: {},
    cwd: '',
    workspaces: ['stale-workspace-id'],
  }],
  externalScopes: { 'legacy-ws': ['stale-workspace-id'] },
}, null, 2)}\n`, { mode: 0o600 });
NODE
if grep -q 'externalScopes' "$MANIFEST" && grep -q 'workspaces' "$MANIFEST"; then
  pass "L: legacy manifest seeded with workspaces + externalScopes"
else
  fail "L: could not seed the legacy manifest"
fi

say "3/11 L: boot, assert the legacy server still loads and the removed fields are stripped"
if ! boot l; then echo "FAIL: phase L boot failed" >&2; exit 1; fi
if wait_state l '
  if (r?.ok !== true) return "state not ok";
  const servers = r.value?.servers ?? [];
  if (servers.length !== 1) return `servers=${JSON.stringify(servers.map((s) => s.serverName))}`;
  const row = servers[0];
  if (row.serverName !== "legacy-ws") return `serverName=${row.serverName}`;
  if (!(r.value?.status?.["legacy-ws"]?.toolCount >= 1)) return `status=${JSON.stringify(r.value?.status?.["legacy-ws"])}`;
  if (Object.hasOwn(row, "workspaces")) return `row still exposes workspaces=${JSON.stringify(row.workspaces)}`;
  if (Object.hasOwn(r.value, "externalScopes")) return "state still exposes externalScopes";
  if (JSON.stringify(r.value).includes("externalScopes")) return "state body mentions externalScopes";
  return null;' 60; then
  pass "L: legacy server loads/mounts; state exposes no workspaces/externalScopes"
else
  fail "L: legacy manifest did not load cleanly or state still exposes workspace fields"
fi
if node - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const [file] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const problems = [];
if (Object.hasOwn(m, 'externalScopes')) problems.push('manifest.externalScopes still present');
for (const s of m.servers ?? []) {
  if (Object.hasOwn(s, 'workspaces')) problems.push(`server ${s.serverName} still has workspaces`);
}
if (problems.length) { console.error(`FAIL: L manifest: ${problems.join('; ')}`); process.exit(1); }
NODE
then pass "L: manifest file no longer contains externalScopes / workspaces (stripped on load)"; else fail "L: manifest still contains workspace-scope fields"; fi
if node - "$TMP/state-l.json" <<'NODE'
const fs = require('node:fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).result;
const problems = [];
if (Object.hasOwn(r.value ?? {}, 'workspaces')) problems.push('state.workspaces still present');
if ((r.value?.servers ?? []).some((s) => Object.hasOwn(s, 'workspaces'))) problems.push('server.workspaces still present');
if ((r.value?.servers ?? []).some((s) => Object.hasOwn(s, 'staleWorkspaces'))) problems.push('server.staleWorkspaces still present');
if (problems.length) { console.error(`FAIL: L state shape: ${problems.join('; ')}`); process.exit(1); }
NODE
then pass "L: state value exposes no workspaces/staleWorkspaces fields"; else fail "L: state shape still exposes workspace fields"; fi

printf '{}' > "$TMP/payload-empty.json"
rpc_call workspaces.refresh "$TMP/payload-empty.json" "$TMP/res-ws-refresh.json"
if assert_result "workspaces.refresh removed" "$TMP/res-ws-refresh.json" '
  if (r?.ok !== false) return `ok=${r?.ok} (removed endpoint still exists)`;
  if (r.error?.code !== "UNKNOWN_ENDPOINT") return `code=${r.error?.code} message=${r.error?.message}`;
  return null;'; then
  pass "L: removed RPC workspaces.refresh → UNKNOWN_ENDPOINT"
else
  fail "L: workspaces.refresh did not return UNKNOWN_ENDPOINT"
fi
say "   L state.servers: $(server_names "$TMP/state-l.json")"
stop && pass "L process exited cleanly" || fail "L process exit non-zero"
rm -f "$MANIFEST"

# ---------------------------------------------------------------------------
# A. two servers through the RPC
# ---------------------------------------------------------------------------
say "4/11 A: add echo-on (enabled) + echo-off (disabled) over RPC"
if ! boot a; then echo "FAIL: phase A boot failed" >&2; exit 1; fi
cat > "$TMP/payload-on.json" <<JSON
{"serverName":"echo-on","transport":"stdio","command":"$NODE_BIN","args":["$ECHO_SERVER"],"enabled":true}
JSON
rpc_call server.add "$TMP/payload-on.json" "$TMP/res-add-on.json"
assert_result "A add echo-on" "$TMP/res-add-on.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  if (r.value?.serverName !== "echo-on") return `serverName=${JSON.stringify(r.value?.serverName)}`;
  return null;' && pass "RPC server.add echo-on (enabled:true)" || fail "A add echo-on failed"

cat > "$TMP/payload-off.json" <<JSON
{"serverName":"echo-off","transport":"stdio","command":"$NODE_BIN","args":["$ECHO_SERVER"],"enabled":false}
JSON
rpc_call server.add "$TMP/payload-off.json" "$TMP/res-add-off.json"
assert_result "A add echo-off" "$TMP/res-add-off.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  if (r.value?.serverName !== "echo-off") return `serverName=${JSON.stringify(r.value?.serverName)}`;
  return null;' && pass "RPC server.add echo-off (enabled:false)" || fail "A add echo-off failed"

if wait_state a '
  if (r?.ok !== true) return "state not ok";
  const servers = r.value?.servers ?? [];
  const names = servers.map((s) => s.serverName).sort();
  if (JSON.stringify(names) !== JSON.stringify(["echo-off", "echo-on"])) return `names=${JSON.stringify(names)}`;
  if (servers.some((s) => s.source !== "manager")) return `sources=${JSON.stringify(servers.map((s) => s.source))}`;
  const status = r.value?.status ?? {};
  if (!(status["echo-on"]?.toolCount >= 1)) return `echo-on status=${JSON.stringify(status["echo-on"])}`;
  if (status["echo-off"]?.mounted !== false) return `echo-off status=${JSON.stringify(status["echo-off"])}`;
  return null;' 60; then
  pass "A state: 2 manager rows; echo-on mounted toolCount>=1, echo-off not mounted"
else
  fail "A state never matched 2 mounted/disabled rows"
fi
say "   A state.servers: $(server_names "$TMP/state-a.json")"
MF_A="$(manifest_summary)"
say "   A manifest: $MF_A"
MD5_A="$(md5 -q "$MANIFEST" 2>/dev/null || true)"
stop && pass "A process exited cleanly" || fail "A process exit non-zero"

# ---------------------------------------------------------------------------
# B. uninstall but keep the manifest, reinstall, boot
# ---------------------------------------------------------------------------
say "5/11 B: uninstall plugin, KEEP mcp-manager.json, reinstall"
[ -f "$MANIFEST" ] && pass "B precondition: manifest exists before uninstall" || fail "B: manifest missing before uninstall"
uninstall_plugin
[ "$(row_count)" = "0" ] && pass "B after uninstall: patch row removed" || fail "B: patch row still present"
[ ! -d "$PROFILE_DIR/node_modules/dsh-mcp-manager" ] && pass "B after uninstall: package deleted" || fail "B: package still present"
[ -f "$MANIFEST" ] && pass "B after uninstall: manifest survives (it is host-level data)" || fail "B: manifest disappeared with uninstall"
install_plugin && pass "B reinstall: activate.sh reinstalls" || fail "B reinstall failed"

say "6/11 B: boot a NEW process and check the registry is restored"
if ! boot b; then echo "FAIL: phase B boot failed" >&2; exit 1; fi
if wait_state b '
  if (r?.ok !== true) return "state not ok";
  const servers = r.value?.servers ?? [];
  const names = servers.map((s) => s.serverName).sort();
  if (JSON.stringify(names) !== JSON.stringify(["echo-off", "echo-on"])) return `names=${JSON.stringify(names)}`;
  const status = r.value?.status ?? {};
  if (!(status["echo-on"]?.toolCount >= 1)) return `echo-on status=${JSON.stringify(status["echo-on"])}`;
  return null;' 60; then
  pass "B reinstall restores 2 manager rows AND remounts echo-on (manifest is the host-level registry)"
else
  fail "B reinstall did NOT restore the 2 rows"
fi
say "   B state.servers: $(server_names "$TMP/state-b.json")"
MF_B="$(manifest_summary)"
say "   B manifest: $MF_B"
MD5_B="$(md5 -q "$MANIFEST" 2>/dev/null || true)"
[ "$MD5_A" = "$MD5_B" ] && pass "B manifest content unchanged by uninstall/reinstall (same md5)" || fail "B manifest changed ($MD5_A -> $MD5_B)"
stop && pass "B process exited cleanly" || fail "B process exit non-zero"

# ---------------------------------------------------------------------------
# C. uninstall AND delete the manifest, reinstall, boot
# ---------------------------------------------------------------------------
say "7/11 C: uninstall plugin and DELETE mcp-manager.json, reinstall"
uninstall_plugin
rm -f "$MANIFEST"
[ ! -f "$MANIFEST" ] && pass "C: manifest deleted" || fail "C: manifest still present"
install_plugin && pass "C reinstall: activate.sh reinstalls" || fail "C reinstall failed"

say "8/11 C: boot and assert an empty registry (nothing on disk remembers the servers)"
if ! boot c; then echo "FAIL: phase C boot failed" >&2; exit 1; fi
if wait_state c '
  if (r?.ok !== true) return "state not ok";
  const servers = r.value?.servers ?? [];
  if (servers.length !== 0) return `servers=${JSON.stringify(servers.map((s) => s.serverName))}`;
  return null;' 60; then
  pass "C state: 0 servers after clean reinstall (manager data gone, no host rows)"
else
  fail "C state still lists servers after deleting the manifest"
fi
say "   C state.servers: $(server_names "$TMP/state-c.json")"
MF_C="$(manifest_summary)"
say "   C manifest: $MF_C"
stop && pass "C process exited cleanly" || fail "C process exit non-zero"

# ---------------------------------------------------------------------------
# D. contrast: one native @deepseek-ai/dsh-mcp-client row in the profile patch
# ---------------------------------------------------------------------------
say "9/11 D: add native '@deepseek-ai/dsh-mcp-client' row (serverName native-echo)"
if [ "$(grep -vE '^[[:space:]]*(#|$)' "$PATCH" | tr -d '[:space:]')" = "[]" ]; then
  grep -vE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH" > "$PATCH.tmp" || true
  mv "$PATCH.tmp" "$PATCH"
fi
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

say "10/11 D: boot and assert exactly one discovered source:'host' row"
if ! boot d; then echo "FAIL: phase D boot failed" >&2; exit 1; fi
if wait_state d '
  if (r?.ok !== true) return "state not ok";
  const servers = r.value?.servers ?? [];
  if (servers.length !== 1) return `servers=${JSON.stringify(servers.map((s) => `${s.serverName}:${s.source}`))}`;
  const row = servers[0];
  if (row.source !== "host") return `source=${row.source}`;
  if (row.serverName !== "native-echo") return `serverName=${row.serverName}`;
  if (row.readOnly !== true) return `readOnly=${row.readOnly}`;
  if (row.active !== true) return `active=${row.active}`;
  const status = r.value?.status?.["native-echo"];
  if (!(status?.toolCount >= 1)) return `status=${JSON.stringify(status)}`;
  return null;' 90; then
  pass "D state: exactly one source:'host' row (native-echo), readOnly, active, toolCount>=1"
else
  fail "D native row was not discovered as the only row"
fi
say "   D state.servers: $(server_names "$TMP/state-d.json")"
MF_D="$(manifest_summary)"
say "   D manifest: $MF_D"
stop && pass "D process exited cleanly" || fail "D process exit non-zero"

echo ""
echo "experiment summary (quotable):"
echo "  A install+add:   servers=$(server_names "$TMP/state-a.json") manifest=${MF_A:-?}"
echo "  B keep manifest: servers=$(server_names "$TMP/state-b.json") manifest=${MF_B:-?}"
echo "  C delete data:   servers=$(server_names "$TMP/state-c.json") manifest=${MF_C:-?}"
echo "  D native row:    servers=$(server_names "$TMP/state-d.json") manifest=${MF_D:-?}"
echo ""
echo "summary: $PASS passed, $FAILED failed"
[ "$FAILED" = "0" ] || exit 1
echo "OK: clean-reinstall experiments hold (manifest = host-level registry; discovery only sees native rows)."
