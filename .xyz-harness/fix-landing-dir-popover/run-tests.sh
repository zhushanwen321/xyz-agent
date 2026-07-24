#!/usr/bin/env bash
# CW testRunner：跑 fix-landing-dir-popover topic 的全部相关测试文件。
# exit_zero case 共享本次执行结果（exit 0 → 全 pass）。
# 设计：CW custom mode 跑 `bash <path>`，cwd=workspacePath（worktree root）。实测 ~2.2s，远低于 30s 超时。
set -e

# runtime 测试（MAX_RECORDS=6 + detectBare RPC）
cd packages/runtime
npx vitest run test/recent-workspaces-store.test.ts test/workspace-detect-bare-handler.test.ts > /dev/null 2>&1

# renderer 测试（popover slice + landing isBare + initApp session cwd）
cd ../renderer
npx vitest run \
  src/__tests__/new-task/dir-select-popover.test.ts \
  src/__tests__/new-task/landing-isbare-pending-cwd.test.ts \
  src/__tests__/new-task/initapp-default-cwd-session.test.ts \
  > /dev/null 2>&1

exit 0
