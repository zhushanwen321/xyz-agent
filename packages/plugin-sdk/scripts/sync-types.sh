#!/usr/bin/env bash
# Sync types from runtime plugin-types.ts to SDK package.
# Strips relative imports (runtime-internal) and replaces referenced
# interfaces with `unknown` so the SDK stays standalone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/../../../src-electron/runtime/src/services/plugin-service/plugin-types.ts"
TARGET="$SCRIPT_DIR/../src/types.ts"

if [ ! -f "$SOURCE" ]; then
  echo "Error: Source file not found at $SOURCE" >&2
  exit 1
fi

# Strip relative import lines, replace runtime-internal interfaces with unknown
sed -e '/^import type .* from .*'\''\.\.\/.*$/d' \
    -e 's/ISessionService/unknown/g' \
    -e 's/IConfigService/unknown/g' \
    "$SOURCE" > "$TARGET"

echo "Synced types from plugin-types.ts to packages/plugin-sdk/src/types.ts"
