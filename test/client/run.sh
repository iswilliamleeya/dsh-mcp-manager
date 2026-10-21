#!/usr/bin/env bash
# Client-half checks for dsh-mcp-manager (no browser required).
set -euo pipefail
cd "$(dirname "$0")/../.."
node --check lib/client.js
node test/client/check-client.mjs
node test/client/render-smoke.mjs
