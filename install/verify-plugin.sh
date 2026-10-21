#!/usr/bin/env bash
# Verify dsh-mcp-manager loads and disposes cleanly in a REAL harness profile,
# without touching the live app profile or its patch layer.
#
# It creates a throwaway DSH_HOME, materializes the shipped `web` profile, installs
# this package with install/activate.sh, adds a liveness probe as the last patch row,
# boots the profile with stdin closed, and asserts:
#
#   - the manager's loader entry exists and its fiber is ACTIVE (apply succeeded);
#   - the manager registered its model-facing `mcp_manager_*` tools;
#   - disposing the manager fiber throws nothing and unwinds its tool registrations;
#   - the client half is discoverable: ctx.clientModules.graph() contains a
#     `dsh-mcp-manager` row whose url is `.../dsh-mcp-manager/client.js` with
#     `dsh.client.inject` intact, and the served index boot graph advertises it
#     (this decides whether copy-package + loader-row is a valid install path);
#   - the boot log has no loader/module/TypeError failure.
#
# The liveness probe lives in test/e2e/verify-probe/ and reports one
# `MCP_MANAGER_VERIFY {json}` line. This check does not depend on the plugin's own
# log wording, so it keeps working as the host implementation evolves.
#
# Usage: bash install/verify-plugin.sh
# Env:
#   DSH_CLI        path to the `dsh` launcher (default: macOS app bundle path)
#   TEMPLATE       shipped profile template to materialize (default: web)
#   BOOT_TIMEOUT   seconds to wait for the probe marker (default: 120)
#   KEEP=1         keep the temp DSH_HOME and print its path
#   DSH_VERIFY_TOOL_PREFIX  expected model-tool prefix (default: mcp_manager_)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
TEMPLATE="${TEMPLATE:-web}"
PROFILE="mcp-manager-verify"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-120}"
TOOL_PREFIX="${DSH_VERIFY_TOOL_PREFIX:-mcp_manager_}"
PROBE_SRC="$ROOT/test/e2e/verify-probe"

[ -x "$CLI" ] || { echo "FAIL: dsh CLI not executable at $CLI (set DSH_CLI)" >&2; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not on PATH" >&2; exit 1; }
[ -f "$PROBE_SRC/index.js" ] || { echo "FAIL: liveness probe missing at $PROBE_SRC" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mcp-manager-verify.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR"
LOG="$TMP/boot.log"
MARKER="$TMP/verify.json"
PATCH="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "kept: $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT
echo "TMP=$TMP"

# Scrub inherited DSH_* variables: this script is usually started from inside a live
# DSH session, and its DSH_PROFILE/DSH_PROFILE_DIR must not leak into the child.
child_env() {
  env -i \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$HOME_DIR" \
    TMPDIR="${TMPDIR:-/tmp}" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-$(id -un)}" \
    LANG="${LANG:-en_US.UTF-8}" \
    DSH_HOME="$HOME_DIR" \
    "$@"
}

echo "1/6 materialize '$PROFILE' from the shipped '$TEMPLATE' profile"
if ! child_env "$CLI" "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >"$TMP/dump.log" 2>&1; then
  echo "FAIL: --from-default-profile $TEMPLATE --dump-config failed" >&2
  cat "$TMP/dump.log" >&2
  exit 1
fi
[ -f "$PATCH" ] || { echo "FAIL: profile '$PROFILE' was not materialized" >&2; exit 1; }

echo "2/6 install dsh-mcp-manager via install/activate.sh"
if ! DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" >"$TMP/activate.log" 2>&1; then
  echo "FAIL: install/activate.sh failed" >&2
  cat "$TMP/activate.log" >&2
  exit 1
fi
tail -n 3 "$TMP/activate.log" | sed 's/^/   /'

echo "3/6 idempotency: re-run activate.sh, expect the row to stay single"
DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" >"$TMP/activate2.log" 2>&1 || {
  echo "FAIL: second activate.sh run failed" >&2
  cat "$TMP/activate2.log" >&2
  exit 1
}
ROW_COUNT="$(grep -cE '^[[:space:]]*- id: mcp-manager$' "$PATCH")"
[ "$ROW_COUNT" = "1" ] || { echo "FAIL: expected 1 mcp-manager row after reinstall, got $ROW_COUNT" >&2; cat "$PATCH" >&2; exit 1; }
grep -q "SKIP: 'mcp-manager' row already present" "$TMP/activate2.log" || {
  echo "FAIL: second activate.sh run did not report the duplicate guard" >&2
  cat "$TMP/activate2.log" >&2
  exit 1
}
echo "   OK: single row, duplicate guard reported"

echo "4/6 install the liveness probe (test/e2e/verify-probe) as the last patch row"
PROBE_DEST="$HOME_DIR/profiles/$PROFILE/node_modules/dsh-mcp-verify-probe"
mkdir -p "$PROBE_DEST"
cp "$PROBE_SRC/index.js" "$PROBE_SRC/package.json" "$PROBE_DEST/"
cat >> "$PATCH" <<'YAML'

- insert:
    - id: mcp-verify-probe
      name: dsh-mcp-verify-probe
YAML

echo "5/6 boot the profile with stdin closed (--port 0, marker: $MARKER)"
env -i \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$HOME_DIR" \
  TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" \
  LOGNAME="${LOGNAME:-$(id -un)}" \
  LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" \
  DSH_VERIFY_OUT="$MARKER" \
  DSH_VERIFY_TOOL_PREFIX="$TOOL_PREFIX" \
  "$CLI" "$PROFILE" --no-open --port 0 < /dev/null > "$LOG" 2>&1 &
BOOT_PID=$!

FOUND=0
for _ in $(seq 1 $((BOOT_TIMEOUT * 2))); do
  if grep -q "MCP_MANAGER_VERIFY {" "$LOG" 2>/dev/null; then FOUND=1; break; fi
  kill -0 "$BOOT_PID" 2>/dev/null || break
  sleep 0.5
done
[ "$FOUND" = "1" ] || echo "WARN: marker not seen; boot log tail follows" >&2

# End-to-end client half: fetch the index the Web carrier serves and check that the
# boot graph injected into it advertises dsh-mcp-manager/client.js. This is the
# evidence that a plain "copy package + append loader row" install reaches the GUI.
INDEX_HTML=""
URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | head -1 || true)"
if [ -n "$URL" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsS -L --max-time 10 -c "$TMP/cookies.txt" -b "$TMP/cookies.txt" "$URL" -o "$TMP/index.html" 2>"$TMP/curl.err"; then
    INDEX_HTML="$TMP/index.html"
    echo "   index fetched: $(wc -c < "$INDEX_HTML" | tr -d ' ') bytes from ${URL%%\?*}"
  else
    echo "   WARN: index fetch failed: $(cat "$TMP/curl.err" 2>/dev/null | head -1)"
  fi
else
  echo "   WARN: no web URL in boot log (or curl missing); skipping index check"
fi

# SIGTERM lets the harness stop the host before we kill it; the web app does not
# exit on stdin EOF. Dispose correctness is already asserted via the probe's own
# fiber.dispose() call, so SIGKILL here only ends the idle server.
sleep 0.5
SHUTDOWN="graceful"
if kill -0 "$BOOT_PID" 2>/dev/null; then kill -TERM "$BOOT_PID" 2>/dev/null || true; fi
for _ in $(seq 1 40); do
  kill -0 "$BOOT_PID" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$BOOT_PID" 2>/dev/null; then
  SHUTDOWN="killed"
  kill -9 "$BOOT_PID" 2>/dev/null || true
fi
wait "$BOOT_PID" 2>/dev/null
BOOT_EXIT=$?
echo "   boot process: shutdown=$SHUTDOWN exit=$BOOT_EXIT"
tail -n 4 "$LOG" | sed 's/^/   /'

echo "6/6 assertions"
node - "$LOG" "$MARKER" "$SHUTDOWN" "$BOOT_EXIT" "$TOOL_PREFIX" "$INDEX_HTML" <<'NODE'
const fs = require('node:fs');
const [logPath, markerPath, shutdown, bootExit, toolPrefix, indexHtmlPath] = process.argv.slice(2);
const log = fs.readFileSync(logPath, 'utf8');

const failures = [];
const fail = (message) => failures.push(message);

if (!fs.existsSync(markerPath)) {
  console.error('FAIL: liveness probe wrote no marker; boot log tail:');
  console.error(log.split('\n').slice(-30).join('\n'));
  process.exit(1);
}
let report;
try {
  report = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
} catch (e) {
  fail(`liveness marker is not valid JSON: ${e.message}`);
}
const summary = report ? {
  complete: report.complete,
  target: report.target,
  targetEntryFound: report.targetEntryFound,
  targetActive: report.targetActive,
  toolWaitMs: report.toolWaitMs,
  targetToolCount: report.targetToolCount,
  targetTools: report.targetTools,
  targetDisposeOk: report.targetDisposeOk,
  targetDisposeMs: report.targetDisposeMs,
  targetDisposeError: report.targetDisposeError ?? null,
  targetToolsUnwound: report.targetToolsUnwound,
  targetToolsAfterDispose: report.targetToolsAfterDispose,
  targetEntryAfterDispose: report.targetEntryAfterDispose,
  clientEntryPresent: report.clientEntryPresent,
  clientGraph: report.clientGraph ? {
    rev: report.clientGraph.rev,
    release: report.clientGraph.release,
    entryCount: report.clientGraph.entryCount,
    targetIdPresent: report.clientGraph.targetIdPresent,
    targetEntry: report.clientGraph.targetEntry,
    targetIndex: report.clientGraph.targetIndex,
  } : null,
  clientGraphWaitMs: report.clientGraphWaitMs,
  clientGraphError: report.clientGraphError ?? null,
  clientBundlePath: report.clientBundlePath ?? null,
  entryCount: report.entryCount,
  dshHomeFiles: report.dshHomeFiles,
  fatal: report.fatal ?? null,
  loaderError: report.loaderError ?? null,
} : null;
console.log(JSON.stringify({ boot: { shutdown, exit: bootExit }, report: summary }, null, 2));

if (report) {
  if (report.complete !== true) fail(`liveness probe did not complete: ${JSON.stringify(report.fatal)}`);
  if (report.targetEntryFound !== true) fail(`loader entry '${report.target?.id}' not found (plugin was not mounted)`);
  if (report.targetActive !== true) fail(`loader entry '${report.target?.id}' is not active (apply failed or was disposed early)`);
  if (!Array.isArray(report.targetTools) || report.targetTools.length === 0) {
    fail(`no '${toolPrefix}' tools registered by the manager (host apply did not register model tools)`);
  }
  if (report.targetDisposeOk !== true) fail(`manager fiber disposal threw or timed out: ${JSON.stringify(report.targetDisposeError)}`);

  // Client half discovery via ctx.clientModules.graph().
  if (report.clientGraphError) fail(`reading ctx.clientModules.graph() failed: ${JSON.stringify(report.clientGraphError)}`);
  if (report.clientEntryPresent !== true) {
    fail(`client boot graph has no '${report.target?.name}' entry — copying the package into profile/node_modules was not enough for the GUI half`);
  }
  const clientEntry = report.clientGraph?.targetEntry;
  if (!clientEntry || typeof clientEntry.url !== 'string' || !clientEntry.url.includes('dsh-mcp-manager/client.js')) {
    fail(`client boot graph entry has an unexpected url: ${JSON.stringify(clientEntry)}`);
  }
  if (!clientEntry.inject || !clientEntry.inject.includes('@deepseek-ai/dsh-client-connection')) {
    fail(`client boot graph entry lost dsh.client.inject: ${JSON.stringify(clientEntry.inject)}`);
  }
  if (typeof report.clientBundlePath !== 'string' || !report.clientBundlePath.endsWith('/lib/client.js')) {
    fail(`ctx.clientModules.clientPath() did not resolve lib/client.js: ${JSON.stringify(report.clientBundlePath)}`);
  }

  // Served-HTML evidence: the boot graph injected into the index advertises the bundle.
  if (indexHtmlPath) {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    if (!html.includes('__DSH_BOOT__')) fail('served index has no __DSH_BOOT__ injection');
    if (!html.includes('dsh-mcp-manager/client.js')) {
      fail('served index boot graph does not advertise dsh-mcp-manager/client.js');
    }
  } else {
    console.error('WARN: index HTML check skipped (no URL/fetch); clientModules graph check still ran');
  }
  if (report.targetToolsUnwound !== true) {
    fail(`manager tool registrations were not unwound on dispose: ${JSON.stringify(report.targetToolsAfterDispose)}`);
  }
}

// Fail on the loader/plugin failure shapes that indicate a broken entry.
const errorPatterns = [
  /did not activate/i,
  /Cannot find module/i,
  /ERR_MODULE_NOT_FOUND/i,
  /failed to load/i,
  /failed to apply/i,
  /is not a function/i,
  /is not a constructor/i,
  /TypeError:/,
  /ReferenceError:/,
  /SyntaxError:/,
];
const logLines = log.split('\n');
for (const pattern of errorPatterns) {
  const hit = logLines.find((line) => pattern.test(line));
  if (hit) fail(`boot log matches ${pattern}: ${hit.trim().slice(0, 300)}`);
}

if (String(bootExit) !== '0') fail(`boot process exited with ${bootExit} (shutdown=${shutdown})`);

if (failures.length > 0) {
  console.error('FAIL:');
  for (const message of failures) console.error(`  - ${message}`);
  console.error('--- boot log (last 40 lines) ---');
  console.error(logLines.slice(-40).join('\n'));
  process.exit(1);
}
console.log('RESULT: PASS — host entry active, model tools registered, dispose clean, no loader errors.');
NODE
ASSERT_EXIT=$?

if [ "$ASSERT_EXIT" = "0" ]; then
  echo "OK: dsh-mcp-manager loaded and disposed cleanly in the isolated '$PROFILE' profile."
  echo "    patch layer: $PATCH"
else
  echo "FAIL: see boot log: $LOG" >&2
fi
exit "$ASSERT_EXIT"
