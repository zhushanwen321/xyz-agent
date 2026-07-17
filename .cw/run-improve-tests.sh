#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

cd "$ROOT/packages/renderer"
npx vitest run \
  src/__tests__/lib/path-utils-improve.test.ts \
  src/__tests__/composables/markdown-filepath.test.ts \
  src/__tests__/composables/useSearchModal.test.ts \
  src/__tests__/composables/useMarkdownInteractions-fallback.test.ts

cd "$ROOT/apps/electron/main"
npx vitest run test/local-file-protocol.test.ts
