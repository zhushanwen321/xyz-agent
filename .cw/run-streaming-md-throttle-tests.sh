#!/usr/bin/env bash
# CW testRunner: H2 流式 markdown 节流（perf-streaming-md-throttle）
# 只跑 H2-1~H2-7 节流用例（-t 过滤 H2 describe 块）。
# U14 是 pre-existing baseline failure（认知外 markdown topic 改 filepath 规则导致，非本主题），
# 不纳入本主题 testRunner 范围。
# 退出码 0=全 pass，非0=有 fail
set -euo pipefail
cd "$(dirname "$0")/../packages/renderer"
npx vitest run src/__tests__/composables/markdown-renderer.test.ts -t "H2"
