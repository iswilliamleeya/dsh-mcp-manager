#!/usr/bin/env bash
# E2E: install/activate.sh contract (formal profile-bundle registration), in a
# throwaway DSH_HOME.
#
# Asserts:
#   1. install copies the package and registers a profile bundle:
#        profile package.json gets dependencies["dsh-mcp-manager"] =
#        "github:iswilliamleeya/dsh-mcp-manager" and `dsh.profile.bundles`
#        gains "dsh-mcp-manager" exactly once (base/web-app entries kept), with
#        2-space indent + trailing newline;
#        the legacy `- id: mcp-manager` patch row is absent and the patch layer
#        keeps the explicit `[]` placeholder;
#        timestamped package.json AND cordis.patch.yml backups exist;
#        the output says the plugin should appear in「插件 → 已安装插件」.
#   2. re-running install is idempotent (single dependency/bundle entry, no row,
#      "already registered" message).
#   3. installing over an OLD-style install (legacy patch row, no bundle entry)
#      migrates it: registers the bundle and removes the legacy row.
#   4. --remove clears dependency + bundle selection + any legacy row, keeps
#      base/web-app bundles and the package directory, restores `[]`, and backs
#      up package.json.
#   5. reinstall after remove works; a second --remove is a no-op (exit 0,
#      "nothing to remove") and creates no new backups.
#   6. the real-home safety guard refuses ~/.dsh without
#      DSH_MCP_MANAGER_ALLOW_REAL=1.
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
DEPENDENCY_SPEC="github:iswilliamleeya/dsh-mcp-manager"

[ -x "$CLI" ] || { echo "FAIL: dsh CLI not executable at $CLI" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-mcp-manager-e2e-install.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR"
PATCH="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
PACKAGE_JSON="$HOME_DIR/profiles/$PROFILE/package.json"
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
backup_count() { ls "$1".before-dsh-mcp-manager-* 2>/dev/null | wc -l | tr -d ' '; }
activate() { DSH_HOME="$HOME_DIR" DSH_PROFILE="$PROFILE" bash "$ROOT/install/activate.sh" "$@"; }

# Assert one package.json state. $1=label $2=mode(registered|removed)
assert_registration() {
  local label="$1" mode="$2"
  if node - "$PACKAGE_JSON" "$mode" "$DEPENDENCY_SPEC" <<'NODE'
const fs = require('node:fs');
const [file, mode, spec] = process.argv.slice(2);
const raw = fs.readFileSync(file, 'utf8');
const m = JSON.parse(raw);
const bundles = m.dsh?.profile?.bundles ?? [];
const dep = (m.dependencies ?? {})['dsh-mcp-manager'];
const problems = [];
if (!raw.endsWith('\n')) problems.push('missing trailing newline');
if (!/^\s{2}"/m.test(raw)) problems.push('not 2-space indented');
if (!bundles.includes('@deepseek-ai/dsh-base')) problems.push('base bundle dropped');
if (!bundles.includes('@deepseek-ai/dsh-web-app')) problems.push('web-app bundle dropped');
if (mode === 'registered') {
  if (dep !== spec) problems.push(`dependency=${JSON.stringify(dep)}`);
  const count = bundles.filter((name) => name === 'dsh-mcp-manager').length;
  if (count !== 1) problems.push(`bundle count=${count}`);
  if (bundles[bundles.length - 1] !== 'dsh-mcp-manager') problems.push('bundle entry is not appended last');
} else {
  if (dep !== undefined) problems.push(`dependency still present: ${JSON.stringify(dep)}`);
  if (bundles.includes('dsh-mcp-manager')) problems.push('bundle entry still present');
}
if (problems.length) { console.error(`FAIL: ${label}: ${problems.join('; ')}`); process.exit(1); }
NODE
  then pass "$label"; else fail "$label"; fi
}

assert_patch_empty() {
  local label="$1"
  if [ "$(row_count)" = "0" ] && [ "$(grep -vE '^[[:space:]]*(#|$)' "$PATCH" | tr -d '[:space:]')" = "[]" ]; then
    pass "$label"
  else
    fail "$label (rows=$(row_count), tail=$(grep -vE '^[[:space:]]*(#|$)' "$PATCH" | tr '\n' ' '))"
  fi
}

echo "0/7 materialize '$PROFILE' from the shipped '$TEMPLATE' profile"
if ! env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME_DIR" TMPDIR="${TMPDIR:-/tmp}" \
  USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}" \
  DSH_HOME="$HOME_DIR" "$CLI" "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >"$TMP/dump.log" 2>&1; then
  echo "FAIL: could not materialize profile" >&2
  cat "$TMP/dump.log" >&2
  exit 1
fi
BASE_BACKUPS_PKG="$(backup_count "$PACKAGE_JSON")"
BASE_BACKUPS_PATCH="$(backup_count "$PATCH")"

echo "1/7 install registers the profile bundle"
activate >"$TMP/install.log" 2>&1 || { cat "$TMP/install.log" >&2; fail "activate.sh failed"; }
[ -f "$DEST/package.json" ] && pass "package copied to node_modules" || fail "package copy missing"
[ -f "$DEST/lib/index.js" ] && pass "lib/index.js copied" || fail "lib/index.js missing"
[ -f "$DEST/cordis.patch.yml" ] && pass "bundle patch copied with the package" || fail "cordis.patch.yml missing in the package copy"
assert_registration "package.json: dependency + dsh.profile.bundles registered (2-space, trailing newline)" registered
assert_patch_empty "patch layer has no legacy mcp-manager row and keeps the [] placeholder"
[ "$(backup_count "$PACKAGE_JSON")" -gt "$BASE_BACKUPS_PKG" ] && pass "timestamped package.json backup created" || fail "no package.json backup"
[ "$(backup_count "$PATCH")" -gt "$BASE_BACKUPS_PATCH" ] && pass "timestamped cordis.patch.yml backup created" || fail "no patch backup"
grep -q "已注册为 profile bundle" "$TMP/install.log" && grep -q "已安装插件" "$TMP/install.log" \
  && pass "install output mentions the bundle registration + 插件 → 已安装插件" \
  || fail "install output lacks the explicit bundle-registration message"

echo "2/7 idempotent reinstall"
activate >"$TMP/install2.log" 2>&1 || { cat "$TMP/install2.log" >&2; fail "second activate.sh failed"; }
assert_registration "after reinstall: single dependency/bundle entry" registered
assert_patch_empty "after reinstall: no legacy row" 
grep -q "already registered" "$TMP/install2.log" && pass "reinstall reports 'already registered'" || fail "no already-registered message on reinstall"

echo "3/7 migrating an OLD-style install (legacy patch row, no bundle selection)"
node - "$PACKAGE_JSON" <<'NODE'
const fs = require('node:fs');
const [file] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
if (m.dependencies) delete m.dependencies['dsh-mcp-manager'];
if (m.dsh?.profile?.bundles) m.dsh.profile.bundles = m.dsh.profile.bundles.filter((name) => name !== 'dsh-mcp-manager');
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
NODE
# old-style patch: drop the [] placeholder, append the legacy row
grep -vE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH" > "$PATCH.tmp" || true
mv "$PATCH.tmp" "$PATCH"
cat >> "$PATCH" <<'YAML'

- insert:
    - id: mcp-manager
      name: dsh-mcp-manager
      config:
        manifestFile: ""
        autoMount: true
YAML
[ "$(row_count)" = "1" ] && pass "legacy install simulated (patch row present, no bundle entry)" || fail "could not simulate a legacy install"
activate >"$TMP/install3.log" 2>&1 || { cat "$TMP/install3.log" >&2; fail "install over legacy failed"; }
assert_registration "legacy install migrated: bundle selected + dependency recorded" registered
assert_patch_empty "legacy patch row removed during migration"
grep -q "removed legacy 'mcp-manager' row" "$TMP/install3.log" && pass "migration reports the legacy row removal" || fail "migration did not report the legacy row removal"

echo "4/7 --remove"
activate --remove >"$TMP/remove.log" 2>&1 || { cat "$TMP/remove.log" >&2; fail "--remove failed"; }
assert_registration "--remove clears dependency + bundle selection (base/web-app kept)" removed
assert_patch_empty "after --remove: no legacy row, [] placeholder"
[ -f "$DEST/package.json" ] && pass "package left in place (documented)" || fail "package unexpectedly deleted"
[ "$(backup_count "$PACKAGE_JSON")" -gt 0 ] && pass "remove-time package.json backup exists" || fail "no package.json backup after remove"

echo "5/7 reinstall + second --remove no-op"
activate >"$TMP/install4.log" 2>&1 && assert_registration "reinstall after remove works" registered || fail "reinstall after remove failed"
PKG_BACKUPS_BEFORE_REMOVE="$(backup_count "$PACKAGE_JSON")"
PATCH_BACKUPS_BEFORE_REMOVE="$(backup_count "$PATCH")"
activate --remove >"$TMP/remove2.log" 2>&1
[ $? -eq 0 ] && pass "first --remove after reinstall exits 0" || fail "--remove after reinstall exited non-zero"
[ "$(backup_count "$PACKAGE_JSON")" -gt "$PKG_BACKUPS_BEFORE_REMOVE" ] && pass "--remove created a new package.json backup" || fail "--remove did not back up package.json"
[ "$(backup_count "$PATCH")" -ge "$PATCH_BACKUPS_BEFORE_REMOVE" ] && pass "patch backups retained" || fail "patch backups disappeared"

PKG_BACKUPS_BEFORE_NOOP="$(backup_count "$PACKAGE_JSON")"
PATCH_BACKUPS_BEFORE_NOOP="$(backup_count "$PATCH")"
activate --remove >"$TMP/remove3.log" 2>&1
[ $? -eq 0 ] && pass "second --remove exits 0" || fail "second --remove exited non-zero"
grep -q "nothing to remove" "$TMP/remove3.log" && pass "second --remove reports nothing to remove" || fail "no nothing-to-remove message"
[ "$(backup_count "$PACKAGE_JSON")" = "$PKG_BACKUPS_BEFORE_NOOP" ] && [ "$(backup_count "$PATCH")" = "$PATCH_BACKUPS_BEFORE_NOOP" ] \
  && pass "no-op remove creates no new backups" || fail "no-op remove created backups"

echo "6/7 reinstall after no-op still works (bundle re-selected)"
activate >"$TMP/install5.log" 2>&1 && assert_registration "final reinstall registers the bundle again" registered || fail "final reinstall failed"
activate --remove >"$TMP/remove4.log" 2>&1 || fail "final cleanup remove failed"

echo "7/7 real-home safety guard"
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
echo "OK: install/activate.sh registers a formal profile bundle (list-visible), migrates legacy installs, and removes cleanly."
