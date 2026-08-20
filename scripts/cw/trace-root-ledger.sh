#!/usr/bin/env bash
# R3: cw 账本一致性 — 5 个子单元全部 closed
set -uo pipefail
out=$(cw status 2>/dev/null)
fail=0
for u in trace-ext trace-core trace-runtime trace-ui trace-i18n; do
  if echo "$out" | grep -q "^$u  closed"; then echo "$u closed"; else echo "$u NOT closed"; fail=1; fi
done
[ $fail -eq 0 ] && echo "R3 PASS" || echo "R3 FAIL"
exit $fail
