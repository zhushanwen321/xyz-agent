#!/usr/bin/env bash
# CW testRunner：跑 session-active-ssot wave 的全部相关测试。
# 本 wave 全部改动在 renderer 侧（store/composable/component），无 runtime 改动。
# grep -v 'Test Files' 规避 cw 正则误取文件数（/(\d+)\s+passed/ 贪婪匹配第一个）。
set -e

cd packages/renderer
npx vitest run \
  src/__tests__/stores/extension-ui.test.ts \
  src/__tests__/composables/derive-status-ask-user.test.ts \
  src/__tests__/useConnection-clear-pending.test.ts \
  src/__tests__/composables/useExtensionUI.test.ts \
  src/__tests__/panel/turn-working.test.ts \
  src/__tests__/fg5-message-stream.test.ts \
  2>&1 | grep -v "Test Files"

exit 0
