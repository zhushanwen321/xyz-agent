#!/usr/bin/env bash
# CW testRunner: H2 流式 markdown 节流（perf-streaming-md-throttle）
# 跑 markdown-renderer.test.ts（含 H2-1~H2-7 节流用例 + U9~U15 既有 segment 用例）
# 退出码 0=全 pass，非0=有 fail（红灯）
set -euo pipefail
cd "$(dirname "$0")/../packages/renderer"
npx vitest run src/__tests__/composables/markdown-renderer.test.ts
