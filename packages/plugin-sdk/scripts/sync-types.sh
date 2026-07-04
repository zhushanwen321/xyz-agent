#!/usr/bin/env bash
# Sync types from runtime plugin-types.ts to SDK package.
# Strips relative imports (runtime-internal) and replaces referenced
# interfaces with `unknown` so the SDK stays standalone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/../../runtime/src/services/plugin-service/plugin-types.ts"
TARGET="$SCRIPT_DIR/../src/types.ts"

if [ ! -f "$SOURCE" ]; then
  echo "Error: Source file not found at $SOURCE" >&2
  exit 1
fi

# Strip relative import lines, replace runtime-internal interfaces with unknown.
# Also collapse inline dynamic-import type references like
#   import('../../interfaces.js').IModelService
# (the first rule only drops top-level `import type` lines; inline refs survive
#  unless given their own rule, which would otherwise leave a broken import in
#  the published .d.ts — TS2307).
sed -e '/^import type .* from .*'\''\.\.\/.*$/d' \
    -e 's/ISessionService/unknown/g' \
    -e 's/IConfigService/unknown/g' \
    -e 's/import('\''\.\.\/\.\.\/interfaces\.js'\'')\.IModelService/unknown/g' \
    "$SOURCE" > "$TARGET"

echo "Synced types from plugin-types.ts to packages/plugin-sdk/src/types.ts"
