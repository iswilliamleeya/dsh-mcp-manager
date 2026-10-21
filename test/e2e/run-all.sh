#!/usr/bin/env bash
# E2E entry point for dsh-mcp-manager: runs every repeatable isolated-profile check.
#
#   1. install/activate.sh contract (install, idempotency, remove, real-home guard)
#   2. isolated profile boot: host entry active, mcp_manager_* tools registered,
#      dispose clean, no loader errors (install/verify-plugin.sh)
#   3. real HTTP smoke of /mcp-manager/server.import (cookie/token, manifest shape,
#      duplicate EXISTS, unreachable enabled server containment, admission codes)
#   3b. real HTTP smoke of /mcp-manager/server.importTest + import enabled default
#   4. native @deepseek-ai/dsh-mcp-client host-row discovery/read-only/conflict
#      (test/e2e/native-discovery-smoke.sh; skipped when lib/external.js is absent)
#   5. clean uninstall / delete data / reinstall experiments, including a legacy
#      manifest that still carries removed workspace fields
#   6. env:/credential: references + plaintext storage (self-built encryption removed)
#   7. host unit tests (node --test test/unit), when present
#
# Every step gets its own throwaway DSH_HOME; the live Desktop profile is never touched.
#
# Usage: bash test/e2e/run-all.sh
# Env: KEEP=1 to keep temp homes, DSH_CLI to point at another launcher, SKIP_UNIT=1.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAILED=0
SKIPPED=0

run_step() {
  local label="$1"
  shift
  echo ""
  echo "=== $label ==="
  if "$@"; then
    PASS=$((PASS + 1))
    echo "--- PASS: $label"
  else
    local code=$?
    FAILED=$((FAILED + 1))
    echo "--- FAIL ($code): $label" >&2
  fi
}

skip_step() {
  SKIPPED=$((SKIPPED + 1))
  echo ""
  echo "=== $1 === (SKIP: $2)"
}

echo "dsh-mcp-manager e2e — root: $ROOT"
echo "dsh CLI: ${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"

run_step "install/activate.sh contract" bash "$ROOT/test/e2e/install-scripts.sh"
run_step "isolated profile load + dispose" bash "$ROOT/install/verify-plugin.sh"
run_step "RPC server.import HTTP smoke" bash "$ROOT/test/e2e/rpc-import-smoke.sh"
if grep -q "importTest" "$ROOT"/lib/*.js 2>/dev/null; then
  run_step "server.importTest + import enabled default" bash "$ROOT/test/e2e/import-test-smoke.sh"
else
  skip_step "server.importTest + import enabled default" "no server.importTest in lib/ yet (host task-21 pending)"
fi
if [ -f "$ROOT/lib/external.js" ]; then
  run_step "native host-row discovery + conflict" bash "$ROOT/test/e2e/native-discovery-smoke.sh"
else
  skip_step "native host-row discovery + conflict" "lib/external.js not present yet (host task-9 pending)"
fi
run_step "clean uninstall / delete data / reinstall" bash "$ROOT/test/e2e/clean-reinstall-smoke.sh"
if [ ! -f "$ROOT/lib/secrets.js" ]; then
  run_step "env:/credential: references (encryption removed)" bash "$ROOT/test/e2e/references-smoke.sh"
else
  skip_step "env:/credential: references (encryption removed)" "lib/secrets.js still present (host task-24 pending)"
fi
UNIT_FILES="$(find "$ROOT/test/unit" \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' \) -type f 2>/dev/null | sort)"
if [ "${SKIP_UNIT:-0}" = "1" ]; then
  skip_step "host unit tests" "SKIP_UNIT=1"
elif [ -n "$UNIT_FILES" ]; then
  echo ""
  echo "=== host unit tests ==="
  if (cd "$ROOT" && node --test $UNIT_FILES); then
    PASS=$((PASS + 1))
    echo "--- PASS: host unit tests"
  else
    FAILED=$((FAILED + 1))
    echo "--- FAIL: host unit tests" >&2
  fi
else
  skip_step "host unit tests" "no test/unit/**/*.test.{js,mjs,cjs} yet"
fi

echo ""
echo "================================"
echo "e2e summary: $PASS passed, $FAILED failed, $SKIPPED skipped"
[ "$FAILED" = "0" ] || exit 1
echo "OK: all e2e checks passed."
