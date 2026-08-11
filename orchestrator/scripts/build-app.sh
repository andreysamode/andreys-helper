#!/bin/bash
# build-app.sh — assemble a launchable, ad-hoc-signed AndreysOrchestrator.app (PLAN.md
# Phase 3, item 4). Idempotent: safe to re-run; it rebuilds the bundle from
# scratch each time.
#
# Produces: orchestrator/build/AndreysOrchestrator.app
#   Contents/MacOS/AndreysOrchestrator         release binary (swift build -c release)
#   Contents/Resources/ah.js         bundled `ah` CLI (npm run build:cli)
#   Contents/Resources/ah            wrapper: exec node ah.js "$@"
#   Contents/Info.plist              LSUIElement (no dock icon), bundle id, version
#
# NOTE: No Developer ID signing identity exists on this machine, so the bundle is
# ad-hoc signed (`codesign -s -`). That is enough to launch locally. Real
# distribution requires Developer ID signing + notarization — see INTEGRATION.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ORCHESTRATOR_DIR/.." && pwd)"

BUNDLE_ID="team.aligned.andreys-helper.orchestrator"
APP_NAME="AndreysOrchestrator"
VERSION="${ORCHESTRATOR_VERSION:-0.1.0}"
BUILD_DIR="$ORCHESTRATOR_DIR/build"
APP="$BUILD_DIR/$APP_NAME.app"

echo "==> Building release binary (swift build -c release)"
( cd "$ORCHESTRATOR_DIR" && swift build -c release )
BIN_PATH="$(cd "$ORCHESTRATOR_DIR" && swift build -c release --show-bin-path)"
EXE="$BIN_PATH/$APP_NAME"
[ -x "$EXE" ] || { echo "ERROR: release binary not found at $EXE" >&2; exit 1; }

echo "==> Building bundled ah CLI (npm run build:cli)"
( cd "$REPO_ROOT" && npm run build:cli >/dev/null )
AH_JS="$REPO_ROOT/dist/ah.js"
[ -f "$AH_JS" ] || { echo "ERROR: dist/ah.js not found (npm run build:cli failed)" >&2; exit 1; }

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$EXE" "$APP/Contents/MacOS/$APP_NAME"
chmod +x "$APP/Contents/MacOS/$APP_NAME"

# SwiftPM resource bundles (AndreysOrchestrator_AndreysOrchestrator.bundle holds
# moon.png for moon mode; dependencies may contribute their own). They are built
# next to the binary and MUST land in Contents/Resources — that is the only place
# MoonArt looks once the app is bundled.
shopt -s nullglob
BUNDLES=("$BIN_PATH"/*.bundle)
shopt -u nullglob
if [ ${#BUNDLES[@]} -gt 0 ]; then
  echo "==> Copying ${#BUNDLES[@]} resource bundle(s)"
  for b in "${BUNDLES[@]}"; do
    cp -R "$b" "$APP/Contents/Resources/"
  done
fi
[ -d "$APP/Contents/Resources/${APP_NAME}_${APP_NAME}.bundle" ] || {
  echo "ERROR: ${APP_NAME}_${APP_NAME}.bundle missing — moon mode would have no artwork" >&2
  exit 1
}

cp "$AH_JS" "$APP/Contents/Resources/ah.js"
cat > "$APP/Contents/Resources/ah" <<'WRAP'
#!/bin/sh
# Bundled `ah` CLI wrapper — execs the sibling ah.js via node. Resolves its own
# symlink first so it works when installed as /usr/local/bin/ah -> this file.
SELF="$0"
while [ -h "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")" && pwd)"
exec /usr/bin/env node "$DIR/ah.js" "$@"
WRAP
chmod +x "$APP/Contents/Resources/ah"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>AndreysOrchestrator</string>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleVersion</key>
    <string>$VERSION</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST

echo "==> Ad-hoc signing (no Developer ID identity on this machine)"
codesign --force --deep --sign - "$APP"

echo "==> Verifying signature"
codesign --verify --verbose "$APP"

echo "==> Gatekeeper assessment (expected: rejected — unsigned for distribution)"
spctl --assess --type execute --verbose "$APP" || true

echo ""
echo "Built: $APP"
echo "Launch locally with: open \"$APP\"   (ad-hoc signed; local use only)"
