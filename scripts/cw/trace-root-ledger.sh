#!/usr/bin/env bash
# R2 的一部分: cw 账本一致性 — 5 个子单元全部 closed。
# 注意: cw status 按执行 cwd 定位账本; verify 在临时 checkout 内运行时 cwd 不同,
# 因此显式回到本 worktree 的真实路径读账本(账本本身是机器本地的, 硬编码可接受)。
set -uo pipefail
CANONICAL_REPO="${CW_CANONICAL_REPO:-/Users/zhushanwen/Code/xyz-agent-workspace/feat-trace-view}"
out=$(cd "$CANONICAL_REPO" && cw status 2>/dev/null)
fail=0
for u in trace-ext trace-core trace-runtime trace-ui trace-i18n; do
  if echo "$out" | grep -q "^$u  closed"; then echo "$u closed" >&2; else echo "$u NOT closed" >&2; fail=1; fi
done
exit $fail
