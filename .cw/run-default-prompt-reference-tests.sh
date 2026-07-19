#!/bin/bash
# CW TDD/test runner for cw-2026-07-17-default-prompt-reference
set -u
fail=0

cd packages/renderer || exit 1
npx vitest run src/__tests__/settings/default-prompt-reference.test.ts || fail=1

exit $fail
