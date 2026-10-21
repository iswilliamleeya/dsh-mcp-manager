#!/usr/bin/env bash
# Install / remove the dsh-mcp-manager host plugin in a DSH profile.
#
# The DSH Desktop real install is normally done with `plugin_manager install_bundle`
# (DESIGN.md §8.4). This script is the deterministic, file-level equivalent used by
# the isolated verification flow (install/verify-plugin.sh) and by manual recovery:
# it copies the package into the profile and appends the profile patch row. No pnpm.
#
# Usage:
#   DSH_HOME=/tmp/dsh-home bash install/activate.sh                 # profile desktop
#   DSH_HOME=/tmp/dsh-home DSH_PROFILE=web bash install/activate.sh
#   DSH_HOME=/tmp/dsh-home bash install/activate.sh --remove        # remove the row only
#
# Env:
#   DSH_HOME   DSH home whose profiles/<profile> to change (default: ~/.dsh)
#   DSH_PROFILE  profile name (default: desktop)
#   DSH_MCP_MANAGER_ALLOW_REAL=1  allow modifying the real ~/.dsh home
#
# What it does:
#   1. copies this package into $DSH_HOME/profiles/<profile>/node_modules/dsh-mcp-manager
#      (without test/docs/node_modules; in-box peers resolve through the DSH loader)
#   2. appends the bundle's insert row (taken verbatim from this package's
#      cordis.patch.yml) to the profile patch layer, with a timestamped backup and
#      a duplicate guard; the harness watches the patch layer and hot-loads the plugin
#   3. prints how to verify and how to undo
#
# Safety: refuses to write the live ~/.dsh home unless DSH_MCP_MANAGER_ALLOW_REAL=1.
# This is deliberate: installing into a live Desktop profile disposes running
# sessions when the patch watcher reloads the tree.
set -euo pipefail

ROW_ID="mcp-manager"
PACKAGE_NAME="dsh-mcp-manager"
PROFILE="${DSH_PROFILE:-desktop}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
DEST="$HOME_DIR/profiles/$PROFILE/node_modules/$PACKAGE_NAME"
BUNDLE_PATCH="$SRC_DIR/cordis.patch.yml"

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REAL_HOME="$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")/.dsh"
WANT_HOME="$(cd "$HOME_DIR" 2>/dev/null && pwd -P || printf '%s' "$HOME_DIR")"
if [ "$WANT_HOME" = "$REAL_HOME" ] && [ "${DSH_MCP_MANAGER_ALLOW_REAL:-0}" != "1" ]; then
  fail "refusing to modify the live DSH home ($REAL_HOME) without DSH_MCP_MANAGER_ALLOW_REAL=1; pass an isolated DSH_HOME for verification"
fi

[ -d "$HOME_DIR/profiles/$PROFILE" ] || fail "profile '$PROFILE' not found at $HOME_DIR/profiles/$PROFILE"
[ -f "$HOME_DIR/profiles/$PROFILE/package.json" ] || fail "profile package.json missing; is '$PROFILE' a dsh profile?"
[ -f "$PATCH" ] || fail "patch layer not found at $PATCH"

if [ "${1:-}" = "--remove" ]; then
  grep -qE "^[[:space:]]*- id: $ROW_ID$" "$PATCH" || { say "nothing to remove: no '$ROW_ID' row in $PATCH"; exit 0; }
  BACKUP="$PATCH.before-$PACKAGE_NAME-remove-$(date +%Y%m%d-%H%M%S)"
  cp "$PATCH" "$BACKUP"
  # Remove the single insert row block by id, leaving every other row untouched.
  python3 - "$PATCH" "$ROW_ID" <<'PY'
import sys

path, row_id = sys.argv[1], sys.argv[2]
lines = open(path, encoding='utf-8').read().splitlines(keepends=True)
out, skip = [], False
for line in lines:
    if line.strip().startswith('- insert:'):
        skip = False
    if line.strip() == f'- id: {row_id}':
        skip = True
        # Drop the '- insert:' line immediately above when it becomes empty.
        if out and out[-1].strip() == '- insert:':
            out.pop()
        continue
    if skip:
        # Skip the row's body until the next top-level or insert entry.
        if line.startswith('    ') or line.startswith('      ') or line.strip() == '':
            continue
        skip = False
    out.append(line)
# A patch layer of only comments parses as YAML null, not the empty array the
# loader expects: restore the explicit `[]` placeholder when nothing else is left.
if not any(line.strip() and not line.strip().startswith('#') for line in out):
    out.append('[]\n')
open(path, 'w', encoding='utf-8').write(''.join(out))
PY
  say "removed '$ROW_ID' from $PATCH (backup: $BACKUP)"
  say "restart DSH (or let the live patch watcher reload) to unload the plugin."
  say "the package copy at $DEST was left in place; delete it if you want a clean removal."
  exit 0
fi

[ -f "$SRC_DIR/package.json" ] || fail "package.json missing in $SRC_DIR"
[ -f "$BUNDLE_PATCH" ] || fail "cordis.patch.yml missing in $SRC_DIR (it is the insert row source)"
grep -qE "^[[:space:]]*- id: $ROW_ID$" "$BUNDLE_PATCH" || fail "$BUNDLE_PATCH has no '- id: $ROW_ID' insert row"

say "1/3 copying package -> $DEST"
mkdir -p "$(dirname "$DEST")"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude 'test' --exclude 'docs' --exclude 'state' \
    --exclude 'node_modules' --exclude '*.log' --exclude '.DS_Store' \
    "$SRC_DIR/" "$DEST/"
else
  fail "rsync not found"
fi
[ -f "$DEST/package.json" ] || fail "package copy failed: $DEST/package.json missing"
[ -f "$DEST/lib/index.js" ] || fail "package copy failed: $DEST/lib/index.js missing"

say "2/3 appending plugin row to $PATCH"
if grep -qE "^[[:space:]]*- id: $ROW_ID$" "$PATCH"; then
  say "   SKIP: '$ROW_ID' row already present (package re-copied)"
else
  BACKUP="$PATCH.before-$PACKAGE_NAME-$(date +%Y%m%d-%H%M%S)"
  cp "$PATCH" "$BACKUP"
  say "   backup: $BACKUP"
  # An empty-sequence patch file `[]` would become two YAML documents when a list
  # item is appended: drop the placeholder first.
  if [ "$(grep -vE '^[[:space:]]*(#|$)' "$PATCH" | tr -d '[:space:]')" = "[]" ]; then
    grep -vE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH" > "$PATCH.tmp" || true
    mv "$PATCH.tmp" "$PATCH"
  fi
  # Take the insert row (and its config) verbatim from the bundle patch file, so
  # this script cannot drift from cordis.patch.yml.
  if ! awk 'found || /^[[:space:]]*- insert:/ { found = 1; print }' "$BUNDLE_PATCH" >> "$PATCH"; then
    fail "failed to append the insert row"
  fi
  grep -qE "^[[:space:]]*- id: $ROW_ID$" "$PATCH" || fail "insert row did not land in $PATCH"
fi

say "3/3 syntax-checking the installed entry"
if command -v node >/dev/null 2>&1; then
  node --check "$DEST/lib/index.js" && say "   OK: $DEST/lib/index.js parses"
else
  say "   WARN: node not on PATH; skipped syntax check"
fi

say ""
say "The harness watches the patch layer, so the plugin should load within a few seconds."
say "Profile: $PROFILE   DSH_HOME: $HOME_DIR"
say "Manifest: \$DSH_HOME/mcp-manager.json (config manifestFile: \"\" means the plugin default)"
say "Verify in isolation:  bash \"$SRC_DIR/install/verify-plugin.sh\""
say "Undo:                 DSH_HOME=\"$HOME_DIR\" DSH_PROFILE=\"$PROFILE\" bash \"$SRC_DIR/install/activate.sh\" --remove"
