#!/usr/bin/env bash
#
# Build and package Andrey's Helper into a .vsix.
#
# Steps: install deps (if missing) -> build + stage AndreysOrchestrator.app ->
# type-check -> production bundle -> vsce package. Produces
# andreys-helper-<version>.vsix in the project root.
#
# The orchestrator app rides along inside the .vsix (resources/orchestrator/),
# so installing the extension is the only install step for whoever gets it —
# the Source+ title-bar toggle stages and launches that copy (src/orchestratorApp.ts).
#
# Usage: ./build.sh
#   SKIP_ORCHESTRATOR=1 ./build.sh   package the extension alone (no app inside)
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -x node_modules/.bin/vsce ]; then
  echo "==> Installing dependencies"
  npm install
fi

APP_SRC="orchestrator/build/AndreysOrchestrator.app"
APP_DEST_DIR="resources/orchestrator"

if [ "${SKIP_ORCHESTRATOR:-0}" = "1" ]; then
  echo "==> Skipping the orchestrator app (SKIP_ORCHESTRATOR=1)"
  rm -rf "${APP_DEST_DIR}"
elif [ "$(uname -s)" != "Darwin" ]; then
  echo "!! Not macOS — packaging without AndreysOrchestrator.app" >&2
  rm -rf "${APP_DEST_DIR}"
else
  if command -v swift >/dev/null 2>&1; then
    echo "==> Building AndreysOrchestrator.app"
    orchestrator/scripts/build-app.sh
  elif [ -d "${APP_SRC}" ]; then
    echo "!! No swift toolchain — reusing the existing ${APP_SRC}" >&2
  fi

  if [ ! -x "${APP_SRC}/Contents/MacOS/AndreysOrchestrator" ]; then
    echo "!! ${APP_SRC} is missing — the packaged extension will have no app to launch." >&2
    echo "!! Install a Swift toolchain, or re-run with SKIP_ORCHESTRATOR=1 to silence this." >&2
    exit 1
  fi

  echo "==> Staging the app into ${APP_DEST_DIR}"
  rm -rf "${APP_DEST_DIR}"
  mkdir -p "${APP_DEST_DIR}"
  # ditto (not cp) so the bundle arrives byte-identical, signature intact.
  ditto "${APP_SRC}" "${APP_DEST_DIR}/AndreysOrchestrator.app"
  codesign --verify "${APP_DEST_DIR}/AndreysOrchestrator.app"
fi

echo "==> Type-checking (tsc --noEmit)"
npm run compile

echo "==> Bundling (esbuild, production)"
npm run build

echo "==> Packaging .vsix"
# --allow-missing-repository: this extension isn't published to a git host.
# vsce re-runs the production build via the vscode:prepublish script.
node_modules/.bin/vsce package --allow-missing-repository

vsix="$(ls -t andreys-helper-*.vsix 2>/dev/null | head -1)"
if [ -z "${vsix}" ]; then
  echo "!! vsce reported success but no .vsix was found" >&2
  exit 1
fi

echo
echo "==> Done: ${vsix}"
echo
echo "    Reinstall (--force overwrites the same version already installed):"
echo "      cursor --install-extension ${vsix} --force"
echo "      code   --install-extension ${vsix} --force"
echo
echo "    Then reload the editor to pick up the new build:"
echo "      Command Palette -> Developer: Reload Window"
echo "    (A full quit + reopen is needed to test the onStartupFinished behavior.)"
