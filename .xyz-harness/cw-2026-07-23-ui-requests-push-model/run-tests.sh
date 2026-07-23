#!/usr/bin/env bash
# CW testRunner：跑 ui-requests-push-model topic 的全部相关测试。
# v1 cw.config.json 的 testRunner.command 调此脚本，cwd=workspacePath（worktree root）。
# 跨 runtime + renderer 双包，内部 cd 到各子包跑（monorepo vitest 配置在子包内）。
# exit 0 → 全 pass；非 0 → 有失败（cw gate 据此判定）。
#
# 输出处理：cw 解析器用正则 /(\d+)\s+passed/ 取「第一个」匹配。
# vitest 默认输出先打 "Test Files N passed" 再打 "Tests M passed"，
# cw 会误取文件数 N 而非测试数 M。用 grep -v 过滤掉 "Test Files" 行，
# 确保 cw 第一次 match 命中的是 "Tests M passed"（真实测试数）。
set -e

# runtime 测试：pending 缓存（非破坏快照/respond 收缩/销毁清理）+ RPC handler（非破坏）
cd packages/runtime
npx vitest run \
  test/extension-timeout-manager.test.ts \
  test/extension-message-handler.test.ts \
  2>&1 | grep -v "Test Files"

# renderer 测试：useExtensionUI（requestId 去重双向时序 + 既有 per-session 隔离）+ Dialog 组件
cd ../renderer
npx vitest run \
  src/__tests__/composables/useExtensionUI.test.ts \
  src/__tests__/components/ExtensionUIDialog.test.ts \
  2>&1 | grep -v "Test Files"

exit 0
