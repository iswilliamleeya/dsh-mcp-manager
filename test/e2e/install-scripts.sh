#!/usr/bin/env bash
# E2E: install/activate.sh contract, in a throwaway DSH_HOME.
#
# Asserts:
#   1. install copies the package and appends exactly one mcp-manager row;
#   2. re-running install is idempotent (duplicate guard, still one row);
#   3. --remove deletes the row, keeps a timestamped backup, and restores the
#      explicit `[]` empty-array placeholder (a comments-only patch parses as null);
#   4. a second --remove says "nothing to remove" and exits 0;
#   5. the real-home safety guard refuses ~/.dsh without DSH_MCP_MANAGER_ALLOW_REAL=1.
#
# Usage: bash test/e2e/install-scripts.sh
# Env:
#   DSH_CLI   path to the dsh launcher (default: macOS app bundle path)
#   KEEP=1    keep the temp DSH_HOME
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
TEMPLATE="${TEMPLATE:-web}"
PROFILE="mcp-manager-e2e-install"

[ -x "$CLI" ] || { echo "FAIL: dsh CLI not executable at $CLI" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mcp-manager-e2e-install.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR"
PATCH="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
DEST="$HOME_DIR/profiles/$PROFILE/node_modules/dsh-mcp-manager"
PASS=0
FAILED=0

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then echo "kept: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
echo "TMP=$TMP"

pass() { PASS=$((PASS + 1)); echo "  PASS: $*"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $*" >&2; }
row_count() { grep -cE '^[[:space:]]*- id: mcp-manager$' "$PATCH" 2>/dev/null || true; }
activate() { DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" "$@"; }

echo "0/5 materialize '$PROFILE' from the shipped '$TEMPLATE' profile"
if ! env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME_DIR" TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" "$CLI" "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >"$TMP/dump.log" 2>&1; then
  echo "FAIL: could not materialize profile" >&2
  cat "$TMP/dump.log" >&2
  exit 1
fi

echo "1/5 install"
activate >"$TMP/install.log" 2>&1 || { cat "$TMP/install.log" >&2; fail "activate.sh failed"; }
[ -f "$DEST/package.json" ] && pass "package copied to node_modules" || fail "package copy missing"
[ -f "$DEST/lib/index.js" ] && pass "lib/index.js copied" || fail "lib/index.js missing"
[ -f "$DEST/cordis.patch.yml" ] && pass "bundle patch copied" || fail "cordis.patch.yml missing"
[ "$(row_count)" = "1" ] && pass "exactly one mcp-manager row appended" || fail "row count is $(row_count)"
compgen -G "$PATCH.before-dsh-mcp-manager-*" >/dev/null && pass "timestamped patch backup created" || fail "no patch backup"
# The row must carry the bundle's config block, not a second hand-written copy.
[ "$(grep -c 'manifestFile: ""' "$PATCH")" = "1" ] && pass "row config taken from cordis.patch.yml" || fail "row config drifted from cordis.patch.yml"

echo "2/5 idempotent reinstall"
activate >"$TMP/install2.log" 2>&1 || { cat "$TMP/install2.log" >&2; fail "second activate.sh failed"; }
[ "$(row_count)" = "1" ] && pass "still exactly one row" || fail "row count is $(row_count) after reinstall"
grep -q "SKIP: 'mcp-manager' row already present" "$TMP/install2.log" && pass "duplicate guard reported" || fail "no duplicate-guard message"

echo "3/5 --remove"
activate --remove >"$TMP/remove.log" 2>&1 || { cat "$TMP/remove.log" >&2; fail "--remove failed"; }
[ "$(row_count)" = "0" ] && pass "row removed" || fail "row still present after --remove"
compgen -G "$PATCH.before-dsh-mcp-manager-remove-*" >/dev/null && pass "remove-time backup created" || fail "no remove-time backup"
if [ "$(grep -vE '^[[:space:]]*(#|$)' "$PATCH")" = "[]" ]; then
  pass "patch restored to explicit [] placeholder"
else
  fail "patch does not end with the [] placeholder: $(grep -vE '^[[:space:]]*(#|$)' "$PATCH" | tr '\n' ' ')"
fi
[ -f "$DEST/package.json" ] && pass "package left in place (documented)" || fail "package unexpectedly deleted"
# A reinstall after remove must work again.
activate >"$TMP/install3.log" 2>&1 && [ "$(row_count)" = "1" ] && pass "reinstall after remove works" || fail "reinstall after remove failed"
activate --remove >"$TMP/remove2.log" 2>&1

echo "4/5 second --remove is a no-op"
activate --remove >"$TMP/remove3.log" 2>&1
[ $? -eq 0 ] && pass "second --remove exits 0" || fail "second --remove exited non-zero"
grep -q "nothing to remove" "$TMP/remove3.log" && pass "reports nothing to remove" || fail "no nothing-to-remove message"

echo "5/5 real-home safety guard"
REAL_HOME="$HOME/.dsh"
if DSH_HOME="$REAL_HOME" bash "$ROOT/install/activate.sh" >"$TMP/guard.log" 2>&1; then
  fail "guard allowed a write to the real ~/.dsh home"
elif grep -q "refusing to modify the live DSH home" "$TMP/guard.log"; then
  pass "refuses the real ~/.dsh home without DSH_MCP_MANAGER_ALLOW_REAL=1"
else
  fail "guard failed for an unexpected reason: $(head -2 "$TMP/guard.log")"
fi

echo ""
echo "summary: $PASS passed, $FAILED failed"
[ "$FAILED" = "0" ] || exit 1
echo "OK: install/activate.sh contract holds (install, idempotency, remove, safety)."
