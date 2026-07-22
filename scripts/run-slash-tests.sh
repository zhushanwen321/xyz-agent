#!/bin/bash
# CW testRunner for unify-slash-command-source (multi-workspace)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/runtime"
npx vitest run test/skill-registry.test.ts test/reload-orchestrator.test.ts
exit $?
