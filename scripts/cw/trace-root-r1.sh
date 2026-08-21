#!/usr/bin/env bash
# R1: 全部机器验收套件 + gate 标记行契约(e2e-sh MARKER_RE 行尾锚定)。
# 单一 install 锚: 本脚本是根 unit 唯一执行 pnpm install 的验收, 避免并发 install 竞态。
# stdout 只输出干净标记行; 细节一律 stderr。
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0

pnpm install --prefer-offline --frozen-lockfile > /tmp/trace-root-install.log 2>&1 || {
  echo "R1 FAIL" ; echo "R1 FAIL (pnpm install 失败, 明细 /tmp/trace-root-install.log)" >&2; exit 1; }

run_suite() { # name, cmd...
  local name="$1"; shift
  if "$@" > "/tmp/trace-root-$name.log" 2>&1; then
    echo "suite $name PASS" >&2
  else
    echo "suite $name FAIL (明细 /tmp/trace-root-$name.log)" >&2; fail=1
  fi
}
run_suite core   pnpm --filter @xyz-agent/core exec vitest run session-trace
run_suite runtime pnpm --filter @xyz-agent/runtime exec vitest run session-trace trace-parity
run_suite frontend pnpm --filter @xyz-agent/frontend exec vitest run session-trace trace-i18n
run_suite ext    pnpm -C extensions/system-prompt-trace exec vitest run

if [ $fail -eq 0 ]; then echo "R1 PASS"; else echo "R1 FAIL"; fi
exit $fail
