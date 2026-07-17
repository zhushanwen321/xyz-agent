#!/usr/bin/env bash
# perf-c-rpc-type-pairing 红灯/绿灯测试运行器。
# 跑 renderer 的 rpc-type-pairing 契约测试（类型断言 + grep 结构断言）。
# 退出码：0=全绿，非0=有失败（含红灯）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== renderer: rpc-type-pairing 契约测试 ==="
cd "$ROOT/packages/renderer"
npx vitest run src/__tests__/api/rpc-type-pairing.test.ts

echo "=== all done ==="
