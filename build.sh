#!/usr/bin/env bash
#
# Build and package Andrey's Helper into a .vsix.
#
# Steps: install deps (if missing) -> type-check -> production bundle ->
# vsce package. Produces andreys-helper-<version>.vsix in the project root.
#
# Usage: ./build.sh
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -x node_modules/.bin/vsce ]; then
  echo "==> Installing dependencies"
  npm install
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
echo "    Install: cursor --install-extension ${vsix}"
echo "         or: code   --install-extension ${vsix}"
