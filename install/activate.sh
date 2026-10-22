#!/usr/bin/env bash
# Install / remove the dsh-mcp-manager host plugin in a DSH profile **as a formal
# profile bundle**, so it appears in DSH Desktop's「插件 → 已安装插件」list.
#
# Previous versions only copied the package and appended a loader row to the
# profile patch layer: the plugin worked, but it was not registered as a bundle,
# so the installed-plugins list did not show it. This version instead:
#
#   1. copies the package into $DSH_HOME/profiles/<profile>/node_modules/dsh-mcp-manager
#   2. backs up profile package.json / cordis.patch.yml (timestamped, permissions kept)
#   3. records the dependency and selects the bundle in profile package.json:
#        "dependencies": { "dsh-mcp-manager": "github:iswilliamleeya/dsh-mcp-manager" }
#        "dsh": { "profile": { "bundles": [ ..., "dsh-mcp-manager" ] } }
#      (the package's own dsh.bundle.patch is what the loader applies)
#   4. removes the legacy `- insert: [- id: mcp-manager ...]` row from the profile
#      patch layer (old installs) and restores the `[]` placeholder
#   5. prints that the bundle is registered and should appear after refresh/restart
#
# `--remove` reverses 3 and 4 (keeping the package directory), with backups, and
# is a no-op when nothing is registered.
#
# Usage:
#   DSH_HOME=/tmp/dsh-home bash install/activate.sh                 # profile desktop
#   DSH_HOME=/tmp/dsh-home DSH_PROFILE=web bash install/activate.sh
#   DSH_HOME=/tmp/dsh-home bash install/activate.sh --remove
#
# Env:
#   DSH_HOME   DSH home whose profiles/<profile> to change (default: ~/.dsh)
#   DSH_PROFILE  profile name (default: desktop)
#   DSH_MCP_MANAGER_ALLOW_REAL=1  allow modifying the real ~/.dsh home
#
# Safety: refuses to write the live ~/.dsh home unless DSH_MCP_MANAGER_ALLOW_REAL=1.
# Installing into a live Desktop profile reloads the plugin tree; do it when no
# critical session is running.
set -euo pipefail

ROW_ID="mcp-manager"
PACKAGE_NAME="dsh-mcp-manager"
DEPENDENCY_SPEC="github:iswilliamleeya/dsh-mcp-manager"
PROFILE="${DSH_PROFILE:-desktop}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
PACKAGE_JSON="$PROFILE_DIR/package.json"
PATCH="$PROFILE_DIR/cordis.patch.yml"
DEST="$PROFILE_DIR/node_modules/$PACKAGE_NAME"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

REAL_HOME="$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")/.dsh"
WANT_HOME="$(cd "$HOME_DIR" 2>/dev/null && pwd -P || printf '%s' "$HOME_DIR")"
if [ "$WANT_HOME" = "$REAL_HOME" ] && [ "${DSH_MCP_MANAGER_ALLOW_REAL:-0}" != "1" ]; then
  fail "refusing to modify the live DSH home ($REAL_HOME) without DSH_MCP_MANAGER_ALLOW_REAL=1; pass an isolated DSH_HOME for verification"
fi

[ -d "$PROFILE_DIR" ] || fail "profile '$PROFILE' not found at $PROFILE_DIR"
[ -f "$PACKAGE_JSON" ] || fail "profile package.json missing; is '$PROFILE' a dsh profile?"
[ -f "$PATCH" ] || fail "patch layer not found at $PATCH"

# --- helpers ---------------------------------------------------------------

# Remove the legacy loader row (and an emptied `- insert:` line), keeping every
# other patch entry intact. Restores the explicit `[]` placeholder when the file
# ends up with only comments (a comments-only YAML file parses as null, not []).
# Exit: 0 when a row was removed, 1 when the file already had none.
remove_legacy_patch_row() { # $1 = patch file
  python3 - "$1" "$ROW_ID" <<'PY'
import sys

path, row_id = sys.argv[1], sys.argv[2]
lines = open(path, encoding='utf-8').read().splitlines(keepends=True)
out, skip, removed = [], False, False
for line in lines:
    if line.strip().startswith('- insert:'):
        skip = False
    if line.strip() == f'- id: {row_id}':
        removed = True
        skip = True
        if out and out[-1].strip() == '- insert:':
            out.pop()
        continue
    if skip:
        if line.startswith('    ') or line.startswith('      ') or line.strip() == '':
            continue
        skip = False
    out.append(line)
if not any(line.strip() and not line.strip().startswith('#') for line in out):
    out.append('[]\n')
open(path, 'w', encoding='utf-8').write(''.join(out))
sys.exit(0 if removed else 1)
PY
}

# Print one of: "missing" (no dependency/bundle), "partial" (one of the two), or
# "registered" (exact dependency spec + bundle selected). Never fails.
registration_state() {
  python3 - "$PACKAGE_JSON" "$PACKAGE_NAME" "$DEPENDENCY_SPEC" <<'PY'
import json
import sys

path, package, spec = sys.argv[1:4]
try:
    with open(path, encoding='utf-8') as handle:
        manifest = json.load(handle)
except Exception:
    print('missing')
    sys.exit(0)
dependency = (manifest.get('dependencies') or {}).get(package)
selected = package in ((manifest.get('dsh') or {}).get('profile') or {}).get('bundles', [])
if dependency == spec and selected:
    print('registered')
elif dependency is None and not selected:
    print('missing')
else:
    print('partial')
PY
}

# Edit profile package.json (dependency + bundle selection) in place.
# $1 = "install" | "remove". Preserves field order, 2-space indent, trailing
# newline, and the existing file mode.
edit_package_json() { # $1 = mode
  python3 - "$PACKAGE_JSON" "$1" "$PACKAGE_NAME" "$DEPENDENCY_SPEC" <<'PY'
import json
import os
import sys

path, mode, package, spec = sys.argv[1:5]
with open(path, encoding='utf-8') as handle:
    manifest = json.load(handle)

dependencies = manifest.get('dependencies')
if not isinstance(dependencies, dict):
    dependencies = {}
manifest['dependencies'] = dependencies
dsh = manifest.get('dsh')
if not isinstance(dsh, dict):
    dsh = {}
manifest['dsh'] = dsh
profile = dsh.get('profile')
if not isinstance(profile, dict):
    profile = {}
dsh['profile'] = profile
bundles = profile.get('bundles')
if not isinstance(bundles, list):
    bundles = []
profile['bundles'] = bundles

if mode == 'install':
    dependencies[package] = spec
    if package not in bundles:
        bundles.append(package)
elif mode == 'remove':
    dependencies.pop(package, None)
    profile['bundles'] = [name for name in bundles if name != package]
else:
    sys.exit(2)

mode_bits = os.stat(path).st_mode & 0o777
with open(path, 'w', encoding='utf-8') as handle:
    handle.write(json.dumps(manifest, indent=2) + '\n')
os.chmod(path, mode_bits)
PY
}

backup_file() { # $1 = file to back up; echoes the backup path (never overwrites)
  local base="$1.before-$PACKAGE_NAME-$STAMP"
  local backup="$base"
  local suffix=0
  while [ -e "$backup" ]; do
    suffix=$((suffix + 1))
    backup="$base-$suffix"
  done
  cp -p "$1" "$backup"
  printf '%s' "$backup"
}

# ---------------------------------------------------------------------------
# --remove
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--remove" ]; then
  STATE="$(registration_state)"
  HAS_PATCH_ROW=0
  if grep -qE "^[[:space:]]*- id: $ROW_ID$" "$PATCH"; then HAS_PATCH_ROW=1; fi

  if [ "$STATE" = "missing" ] && [ "$HAS_PATCH_ROW" = "0" ]; then
    say "nothing to remove: '$PACKAGE_NAME' is not registered in profile '$PROFILE'"
    exit 0
  fi

  if [ "$STATE" != "missing" ]; then
    BACKUP_PKG="$(backup_file "$PACKAGE_JSON")"
    edit_package_json remove || fail "failed to update $PACKAGE_JSON"
    say "removed dependency '$PACKAGE_NAME' and its bundle selection from $PACKAGE_JSON"
    say "   backup: $BACKUP_PKG"
  fi
  if [ "$HAS_PATCH_ROW" = "1" ]; then
    BACKUP_PATCH="$(backup_file "$PATCH")"
    remove_legacy_patch_row "$PATCH" || true
    say "removed legacy '$ROW_ID' patch row from $PATCH"
    say "   backup: $BACKUP_PATCH"
  fi
  say "the package copy at $DEST was left in place; delete it if you want a clean removal."
  say "refresh/restart DSH to unload the plugin and update 插件 → 已安装插件."
  exit 0
fi

# ---------------------------------------------------------------------------
# install (default)
# ---------------------------------------------------------------------------
[ -f "$SRC_DIR/package.json" ] || fail "package.json missing in $SRC_DIR"
[ -f "$SRC_DIR/cordis.patch.yml" ] || fail "cordis.patch.yml missing in $SRC_DIR (the package must carry its bundle patch)"
grep -qE "^[[:space:]]*- id: $ROW_ID$" "$SRC_DIR/cordis.patch.yml" || fail "$SRC_DIR/cordis.patch.yml has no '- id: $ROW_ID' insert row"

say "1/4 copying package -> $DEST"
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
[ -f "$DEST/cordis.patch.yml" ] || fail "package copy failed: $DEST/cordis.patch.yml missing"

say "2/4 registering the profile bundle in $PACKAGE_JSON"
# Back up both files the install may touch before any edit (timestamped, mode kept).
PKG_BACKUP="$(backup_file "$PACKAGE_JSON")"
PATCH_BACKUP="$(backup_file "$PATCH")"
STATE="$(registration_state)"
if [ "$STATE" = "registered" ]; then
  say "   already registered (dependency + bundle entry present); nothing to change"
else
  edit_package_json install || fail "failed to update $PACKAGE_JSON"
  say "   registered dependency '$PACKAGE_NAME' -> $DEPENDENCY_SPEC"
  say "   selected bundle '$PACKAGE_NAME' in dsh.profile.bundles"
fi
say "   package.json backup: $PKG_BACKUP"

say "3/4 clearing legacy patch rows from $PATCH"
if grep -qE "^[[:space:]]*- id: $ROW_ID$" "$PATCH"; then
  remove_legacy_patch_row "$PATCH" || true
  say "   removed legacy '$ROW_ID' row (the bundle layer now provides the entry)"
else
  say "   no legacy '$ROW_ID' row (ok)"
fi
say "   cordis.patch.yml backup: $PATCH_BACKUP"

say "4/4 syntax-checking the installed entry"
if command -v node >/dev/null 2>&1; then
  node --check "$DEST/lib/index.js" && say "   OK: $DEST/lib/index.js parses"
else
  say "   WARN: node not on PATH; skipped syntax check"
fi

say ""
say "已注册为 profile bundle：刷新/重启后应出现在「插件 → 已安装插件」列表。"
say "Profile: $PROFILE   DSH_HOME: $HOME_DIR"
say "Bundle:  $PACKAGE_NAME   dependency: $DEPENDENCY_SPEC"
say "Manifest: \$DSH_HOME/mcp-manager.json (config manifestFile: \"\" means the plugin default)"
say "Verify in isolation:  bash \"$SRC_DIR/install/verify-plugin.sh\""
say "package.json backup: $PKG_BACKUP"
say "cordis.patch.yml backup: $PATCH_BACKUP"
say "Undo:   DSH_HOME=\"$HOME_DIR\" DSH_PROFILE=\"$PROFILE\" bash \"$SRC_DIR/install/activate.sh\" --remove"
