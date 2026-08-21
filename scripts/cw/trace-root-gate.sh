#!/usr/bin/env bash
# 根 unit session-trace 总 gate: R2 = 手工 gate 勾选 + cw 账本一致性
# e2e-sh 契约: stdout 只输出 `^<id> (PASS|FAIL)$` 干净标记行, 细节一律 stderr
set -uo pipefail
cd "$(dirname "$0")/../.."
m_fail=0
: > /tmp/trace-root-r2.log
for spec in "trace-ext P2" "trace-runtime P3,P1 附注" "trace-ui V1,V3,V4,V5,V6" "trace-i18n V2,V7"; do
  set -- $spec; unit="$1"; ids="${*:2}"
  bash scripts/cw/manual-gate.sh "$unit" "$ids" >> /tmp/trace-root-r2.log 2>&1 || m_fail=1
done
bash scripts/cw/trace-root-ledger.sh >> /tmp/trace-root-r2.log 2>&1 || m_fail=1
if [ $m_fail -eq 0 ]; then echo "R2 PASS"; else echo "R2 FAIL"; echo "R2 FAIL (明细 /tmp/trace-root-r2.log)" >&2; fi
exit $m_fail
