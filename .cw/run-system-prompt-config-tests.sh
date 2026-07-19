#!/bin/bash
# CW TDD/test runner for cw-2026-07-16-system-prompt-config
set -u
fail=0

cd packages/runtime || exit 1
npx vitest run test/system-prompt-config.test.ts || fail=1
npx vitest run test/settings-message-handler-system-prompt.test.ts || fail=1
npx vitest run test/system-prompt-extension.test.ts || fail=1
npx vitest run test/rpc-client-system-prompt.test.ts || fail=1
npx vitest run test/extension-service-system-prompt.test.ts || fail=1

cd ../renderer || exit 1
npx vitest run src/__tests__/settings/system-prompt-page.test.ts || fail=1

exit $fail
