#!/usr/bin/env bash
# full-regression.sh — R3 e2e-real wrapper: E9 单测聚合
# e2e-real 型：输出 "R3 PASS"/"R3 FAIL" 标记行，exit code 与标记一致。
# 复用 sm-e2e.sh E9 分支的隔离环境 + vitest 执行逻辑。

set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "R3 FAIL"; exit 1; }

# 依赖就绪
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "[full-regression] node_modules missing, installing..." >&2
  env ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --silent || { echo "R3 FAIL"; exit 1; }
fi

# E9 单测（vitest 直接执行）
if (cd "$REPO_ROOT/packages/runtime" && npx vitest run test/scoped-model-e9.test.ts 2>&1); then
  echo "R3 PASS"
  exit 0
else
  echo "R3 FAIL"
  exit 1
fi
