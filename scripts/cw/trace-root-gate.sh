#!/usr/bin/env bash
# 根 unit session-trace 总 gate: R1 = 全部机器验收套件; R2 = 全部手工 gate 勾选
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0

# R1: 4 个机器测试套件
if pnpm --filter @xyz-agent/core exec vitest run session-trace > /tmp/trace-root-r1a.log 2>&1 \
   && pnpm --filter @xyz-agent/runtime exec vitest run session-trace trace-parity > /tmp/trace-root-r1b.log 2>&1 \
   && pnpm --filter @xyz-agent/frontend exec vitest run session-trace trace-i18n > /tmp/trace-root-r1c.log 2>&1 \
   && pnpm -C extensions/system-prompt-trace exec vitest run > /tmp/trace-root-r1d.log 2>&1; then
  echo "R1 PASS"
else
  echo "R1 FAIL (见 /tmp/trace-root-r1*.log)"
  fail=1
fi

# R2: 全部 manual gate（P1 附注已勾, 其余待 dev app 实测）
m_fail=0
for spec in "trace-ext P2" "trace-runtime P3,P1 附注" "trace-ui V1,V3,V4,V5,V6" "trace-i18n V2,V7"; do
  set -- $spec; unit="$1"; ids="${*:2}"
  if ! bash scripts/cw/manual-gate.sh "$unit" "$ids" > /tmp/trace-root-r2.log 2>&1; then m_fail=1; fi
  grep -E 'FAIL' /tmp/trace-root-r2.log && true
done
if [ $m_fail -eq 0 ]; then echo "R2 PASS"; else echo "R2 FAIL (存在未勾选/未记录的手工条目)"; fail=1; fi

exit $fail
