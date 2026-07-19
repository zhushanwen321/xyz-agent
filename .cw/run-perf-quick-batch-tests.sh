#!/usr/bin/env bash
# perf-quick-batch 红灯/绿灯测试运行器。
# 跑 runtime + renderer 两侧的相关测试文件。
# 退出码：0=全绿，非0=有失败（含红灯）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== runtime: message-broker (L6) + event-interpreter-watchdog (M8) ==="
cd "$ROOT/packages/runtime"
npx vitest run test/message-broker.test.ts test/event-interpreter-watchdog.test.ts

echo "=== renderer: use-chat-scroll (M4) ==="
cd "$ROOT/packages/renderer"
npx vitest run src/__tests__/effects/use-chat-scroll.test.ts

echo "=== all done ==="
