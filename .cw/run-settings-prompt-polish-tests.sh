#!/bin/bash
set -u
fail=0
cd packages/renderer || exit 1
npx vitest run src/__tests__/settings/system-prompt-page.test.ts || fail=1
npx vitest run src/__tests__/settings/default-prompt-reference.test.ts || fail=1
exit $fail
