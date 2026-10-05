#!/usr/bin/env bash
# Builds brick-blue.mcpb — the one-file Claude Desktop extension — from this folder.
# Usage: server/build-mcpb.sh [out-dir]   (run from the repository root)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/../dist}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$here/server.js" "$here/package.json" "$here/package-lock.json" "$here/manifest.json" "$here/README.md" "$work/"
cp "$here/../logo-400.png" "$work/icon.png"
(cd "$work" && npm ci --omit=dev --no-audit --no-fund --silent)
mkdir -p "$out"
npx -y @anthropic-ai/mcpb@2 validate "$work/manifest.json"
npx -y @anthropic-ai/mcpb@2 pack "$work" "$out/brick-blue.mcpb"
