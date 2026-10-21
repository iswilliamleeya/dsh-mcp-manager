#!/usr/bin/env bash
# E2E: `env:` / `credential:` references after the self-built encryption was removed.
#
# Product contract: manifest header/env values are stored as plaintext or as
# `env:NAME` / `credential:NAME` references; the references are NOT expanded in
# RPC state (the client sees the reference string), but ARE resolved where they
# are used (bridge mount, connectivity test). There is no `enc:v1:` payload,
# no `state.encryption`, no `secrets.encryptExisting`.
#
# Isolated DSH_HOME + web profile. The manifest is pre-seeded with five stdio
# live-echo servers:
#   env-ref      env ECHO_TOKEN=env:TEST_MCP_REF          (boot env supplies it)
#   cred-ref     env ECHO_TOKEN=credential:TEST_MCP_CRED  ($DSH_HOME/.credentials.yaml supplies it)
#   plain-ref    env ECHO_TOKEN=plain-value-abc           (plaintext stays visible)
#   env-missing  env X=env:MCP_E2E_MISSING_VAR            (mount must fail with lastError)
#   cred-missing env X=credential:MCP_E2E_MISSING_CRED    (mount must fail with lastError)
# Assertions:
#   - state returns the reference strings verbatim and the plaintext value; no
#     resolved secret value leaks; rows have no `secret` flag; no `encryption` key;
#   - reference servers mount (toolCount>=1) → mount-time resolution worked;
#   - missing env/credential servers fail with a classified lastError, host stays up;
#   - server.test resolves stored references (ok for env-ref/cred-ref, classified
#     failure for the missing ones);
#   - server.add with a plaintext header succeeds and state shows it verbatim;
#   - manifest contains no `enc:v1:`; `secrets.encryptExisting` → UNKNOWN_ENDPOINT.
#
# No macOS Keychain/security shim is involved anymore.
#
# Usage: bash test/e2e/references-smoke.sh
# Env: DSH_CLI, KEEP=1, TEMPLATE (default web), BOOT_TIMEOUT (default 90)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
TEMPLATE="${TEMPLATE:-web}"
PROFILE="mcp-manager-e2e-references"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-90}"
NODE_BIN="$(command -v node || true)"
ECHO_SERVER="$ROOT/test/e2e/fixtures/live-echo-server.mjs"
ENV_VALUE="env-value-123"
CRED_VALUE="credential-value-xyz"
PLAIN_VALUE="plain-value-abc"
PLAIN_ADD="Bearer PLAIN-ADD-SECRET-42"

[ -x "$CLI" ] || { echo "FAIL: dsh CLI not executable at $CLI" >&2; exit 1; }
[ -n "$NODE_BIN" ] || { echo "FAIL: node not on PATH" >&2; exit 1; }
[ -f "$ECHO_SERVER" ] || { echo "FAIL: fixture MCP server missing at $ECHO_SERVER" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mcp-manager-e2e-references.XXXXXX")"
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
# 0-2. profile + seeded credentials + seeded manifest + install + boot
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

say "2/8 seed $DSH_HOME/.credentials.yaml + a manifest with env:/credential:/plaintext refs"
cat > "$HOME_DIR/.credentials.yaml" <<YAML
version: 1
refs:
  TEST_MCP_CRED: $CRED_VALUE
YAML
chmod 600 "$HOME_DIR/.credentials.yaml"
node - "$MANIFEST" "$NODE_BIN" "$ECHO_SERVER" "$ENV_VALUE" "$CRED_VALUE" "$PLAIN_VALUE" <<'NODE'
const fs = require('node:fs');
const [file, nodeBin, echoServer] = process.argv.slice(2);
const server = (serverName, env) => ({
  serverName,
  transport: 'stdio',
  enabled: true,
  toolCallTimeoutMs: 10000,
  command: nodeBin,
  args: [echoServer],
  env,
  cwd: '',
});
fs.writeFileSync(file, `${JSON.stringify({
  version: 2,
  servers: [
    server('env-ref', { ECHO_TOKEN: 'env:TEST_MCP_REF' }),
    server('cred-ref', { ECHO_TOKEN: 'credential:TEST_MCP_CRED' }),
    server('plain-ref', { ECHO_TOKEN: 'plain-value-abc' }),
    server('env-missing', { X: 'env:MCP_E2E_MISSING_VAR' }),
    server('cred-missing', { X: 'credential:MCP_E2E_MISSING_CRED' }),
  ],
}, null, 2)}\n`, { mode: 0o600 });
NODE
grep -q 'env:TEST_MCP_REF' "$MANIFEST" && grep -q 'credential:TEST_MCP_CRED' "$MANIFEST" \
  && pass "seeded manifest carries env:/credential:/plaintext values" || fail "could not seed manifest"

say "3/8 boot the isolated profile (env TEST_MCP_REF=$ENV_VALUE; missing refs intentionally unset)"
env -i \
  PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$HOME_DIR" \
  TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" \
  LOGNAME="${LOGNAME:-$(id -un)}" \
  LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" \
  TEST_MCP_REF="$ENV_VALUE" \
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
  rpcId: `ref-${endpoint}-${Date.now()}`,
  method: endpoint,
  payload: JSON.parse(fs.readFileSync(payloadPath, 'utf8')),
}));
NODE
  curl -sS --max-time 60 -b "$JAR" -c "$JAR" \
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

rpc_payload() { # $1=out $2=json-string
  node - "$1" "$2" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify(JSON.parse(process.argv[3])));
NODE
}

# ---------------------------------------------------------------------------
# 4. state: references stay references, plaintext stays plaintext, no secrets
# ---------------------------------------------------------------------------
say "4/8 state returns reference strings verbatim; no resolved secret, mask or encryption field"
if wait_state refs '
  if (r?.ok !== true) return "state not ok";
  const value = r.value ?? {};
  if (Object.hasOwn(value, "encryption")) return "state still exposes encryption";
  const servers = value.servers ?? [];
  if (servers.length !== 5) return `servers=${JSON.stringify(servers.map((s) => s.serverName))}`;
  const byName = new Map(servers.map((s) => [s.serverName, s]));
  const entry = (name, field) => (byName.get(name)?.[field] ?? []).find((e) => e.name === (field === "env" ? "ECHO_TOKEN" : "X"));
  const problems = [];
  const envToken = entry("env-ref", "env");
  if (envToken?.value !== "env:TEST_MCP_REF") problems.push(`env-ref.env.ECHO_TOKEN=${JSON.stringify(envToken)}`);
  const credToken = entry("cred-ref", "env");
  if (credToken?.value !== "credential:TEST_MCP_CRED") problems.push(`cred-ref.env.ECHO_TOKEN=${JSON.stringify(credToken)}`);
  const plainToken = entry("plain-ref", "env");
  if (plainToken?.value !== "plain-value-abc") problems.push(`plain-ref.env.ECHO_TOKEN=${JSON.stringify(plainToken)}`);
  for (const s of servers) {
    for (const e of [...(s.env ?? []), ...(s.headers ?? [])]) {
      if (Object.hasOwn(e, "secret")) problems.push(`${s.serverName}: entry still has secret flag`);
    }
  }
  const body = JSON.stringify(value);
  if (body.includes("env-value-123")) problems.push("state leaked the resolved env value");
  if (body.includes("credential-value-xyz")) problems.push("state leaked the resolved credential value");
  const status = value.status ?? {};
  for (const name of ["env-ref", "cred-ref", "plain-ref"]) {
    if (!(status[name]?.toolCount >= 1)) problems.push(`${name} status=${JSON.stringify(status[name])}`);
  }
  if (status["env-missing"]?.lastError == null) problems.push("env-missing has no lastError");
  if (status["cred-missing"]?.lastError == null) problems.push("cred-missing has no lastError");
  return problems.length ? problems.join("; ") : null;' 90; then
  pass "state: references/plaintext visible verbatim; no secret mask, no encryption, references resolved only where used"
else
  fail "state reference/plaintext shape mismatch"
fi
node -e 'const r=require(process.argv[1]).result; const v=r.value; console.log(JSON.stringify({keys:Object.keys(v),status:v.status,envRef:v.servers.find(s=>s.serverName==="env-ref").env},null,2))' "$TMP/state-refs.json"

say "   missing references are classified in status.lastError"
if assert_result "missing-reference lastError" "$TMP/state-refs.json" '
  const status = r.value?.status ?? {};
  const envErr = String(status["env-missing"]?.lastError ?? "");
  const credErr = String(status["cred-missing"]?.lastError ?? "");
  const problems = [];
  if (!/environment variable|ENV_MISSING|MCP_E2E_MISSING_VAR/i.test(envErr)) problems.push(`env-missing.lastError=${envErr}`);
  if (!/credential|CREDENTIAL/i.test(credErr)) problems.push(`cred-missing.lastError=${credErr}`);
  if (status["env-missing"]?.mounted !== false) problems.push("env-missing is mounted");
  if (status["cred-missing"]?.mounted !== false) problems.push("cred-missing is mounted");
  return problems.length ? problems.join("; ") : null;'; then
  pass "missing env/credential → unmounted + classified lastError (host stays up)"
else
  fail "missing-reference classification mismatch"
fi

# ---------------------------------------------------------------------------
# 5. server.test resolves stored references
# ---------------------------------------------------------------------------
say "5/8 server.test resolves stored env:/credential: references (and classifies missing ones)"
for name in env-ref cred-ref; do
  rpc_payload "$TMP/payload-test-$name.json" "{\"serverName\":\"$name\"}"
  rpc_call server.test "$TMP/payload-test-$name.json" "$TMP/res-test-$name.json"
  if assert_result "test $name" "$TMP/res-test-$name.json" '
    if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
    if (!Array.isArray(r.value?.tools) || !r.value.tools.some((t) => t.name === "echo")) return `tools=${JSON.stringify(r.value?.tools)}`;
    return null;'; then
    pass "server.test $name ok (reference resolved at test time)"
  else
    fail "server.test $name failed"
  fi
done
for name in env-missing cred-missing; do
  rpc_payload "$TMP/payload-test-$name.json" "{\"serverName\":\"$name\"}"
  rpc_call server.test "$TMP/payload-test-$name.json" "$TMP/res-test-$name.json"
  if assert_result "test $name" "$TMP/res-test-$name.json" '
    // The RPC envelope itself is ok:true; the probe outcome is r.value.
    if (r?.ok !== true) return `rpc ok=${r?.ok}`;
    const probe = r.value ?? {};
    if (probe.ok !== false) return `probe ok=${probe.ok} (missing reference test unexpectedly succeeded)`;
    const message = String(probe.error?.message ?? "");
    const code = String(probe.error?.code ?? "");
    if (!/environment variable|ENV_MISSING|credential|CREDENTIAL/i.test(`${code} ${message}`)) return `error=${JSON.stringify(probe.error)}`;
    return null;'; then
    pass "server.test $name reports a classified missing-reference failure"
  else
    fail "server.test $name classification mismatch"
  fi
done

# ---------------------------------------------------------------------------
# 6. plaintext add/update is saved and visible (no encryption anymore)
# ---------------------------------------------------------------------------
say "6/8 server.add with a plaintext header succeeds and state shows it verbatim"
rpc_payload "$TMP/payload-add.json" "{\"serverName\":\"plain-add\",\"transport\":\"streamable-http\",\"url\":\"http://127.0.0.1:9/mcp\",\"headers\":[{\"name\":\"Authorization\",\"value\":\"$PLAIN_ADD\"}],\"enabled\":false}"
rpc_call server.add "$TMP/payload-add.json" "$TMP/res-add.json"
if assert_result "plaintext add" "$TMP/res-add.json" '
  if (r?.ok !== true) return `ok=${r?.ok} error=${JSON.stringify(r?.error)}`;
  if (r.value?.serverName !== "plain-add") return `serverName=${JSON.stringify(r.value?.serverName)}`;
  return null;'; then
  pass "server.add plaintext header accepted (no ENCRYPTION_UNAVAILABLE)"
else
  fail "plaintext header add was rejected"
fi
if wait_state refs2 '
  const row = (r.value?.servers ?? []).find((s) => s.serverName === "plain-add");
  const header = (row?.headers ?? []).find((e) => e.name === "Authorization");
  if (!header) return "plain-add header missing";
  if (header.value !== "'"$PLAIN_ADD"'") return `header=${JSON.stringify(header)}`;
  if (Object.hasOwn(header, "secret")) return "header still masked";
  return null;' 30; then
  pass "state shows the added plaintext header verbatim (no mask)"
else
  fail "added plaintext header not visible in state"
fi

# ---------------------------------------------------------------------------
# 7. no encryption artifacts remain
# ---------------------------------------------------------------------------
say "7/8 no enc:v1 artifacts, no state.encryption, encryptExisting removed"
if grep -q 'enc:v1:' "$MANIFEST" 2>/dev/null; then fail "manifest contains enc:v1:"; else pass "manifest contains no enc:v1:"; fi
if grep -q 'plain-value-abc' "$MANIFEST" 2>/dev/null; then pass "manifest keeps plaintext values"; else fail "manifest lost the plaintext value"; fi
printf '{}' > "$TMP/payload-empty.json"
rpc_call secrets.encryptExisting "$TMP/payload-empty.json" "$TMP/res-encrypt.json"
if assert_result "encryptExisting removed" "$TMP/res-encrypt.json" '
  if (r?.ok !== false) return `ok=${r?.ok} (encryptExisting still exists)`;
  if (r.error?.code !== "UNKNOWN_ENDPOINT") return `code=${r.error?.code} message=${r.error?.message}`;
  return null;'; then
  pass "removed RPC secrets.encryptExisting → UNKNOWN_ENDPOINT"
else
  fail "secrets.encryptExisting did not return UNKNOWN_ENDPOINT"
fi
if assert_result "no state.encryption" "$TMP/state-refs2.json" '
  if (Object.hasOwn(r.value ?? {}, "encryption")) return "state.encryption still present";
  return null;'; then
  pass "state still has no encryption field after mutation"
else
  fail "state.encryption reappeared"
fi
if [ -f "$HOME_DIR/mcp-manager.json" ]; then
  if node - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const [file] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const bad = [];
for (const s of m.servers ?? []) {
  for (const [field, rec] of [['env', s.env], ['headers', s.headers]]) {
    for (const [k, v] of Object.entries(rec ?? {})) {
      if (typeof v !== 'string') bad.push(`${s.serverName}.${field}.${k} is not a stored string`);
      if (v.includes('enc:v1:')) bad.push(`${s.serverName}.${field}.${k} is encrypted`);
    }
  }
}
if (bad.length) { console.error(`FAIL: manifest codec: ${bad.join('; ')}`); process.exit(1); }
NODE
  then pass "manifest values are plain strings / references (env:, credential:, plaintext)"; else fail "manifest codec still transforms values"; fi
fi

# ---------------------------------------------------------------------------
# 8. teardown
# ---------------------------------------------------------------------------
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
echo "OK: env:/credential: references + plaintext storage contract holds (encryption fully removed)."
