#!/usr/bin/env bash
# cw manual gate: 校验 docs/page-design/session-trace/manual-checks.md 中指定条目已勾选并附验证记录
# 用法: manual-gate.sh <unit> <ids>   ids 为逗号分隔, 如 "P2" 或 "V1,V4"
set -euo pipefail
unit="${1:?usage: manual-gate.sh <unit> <ids>}"
ids="${2:?usage: manual-gate.sh <unit> <ids>}"
doc="$(cd "$(dirname "$0")/../.." && pwd)/docs/page-design/session-trace/manual-checks.md"
[ -f "$doc" ] || { echo "manual-checks.md not found: $doc"; exit 2; }

fail=0
IFS=',' read -ra arr <<< "$ids"
for id in "${arr[@]}"; do
  # 找到 "- [ ] <id>:" 或 "- [x] <id>:" 条目行号
  line=$(grep -n "^- \[.\] ${id}:" "$doc" | head -1 | cut -d: -f1) || true
  if [ -z "$line" ]; then
    echo "$id FAIL (条目不存在于 manual-checks.md)"
    fail=1; continue
  fi
  if sed -n "${line}p" "$doc" | grep -q '^- \[ \]'; then
    echo "$id FAIL (未勾选)"
    fail=1; continue
  fi
  # 下一条非空行须是 "- 记录：" 且记录内容非空（模板缩进 2 空格，兼容前导空白）
  rec=$(sed -n "$((line+1)),+3p" "$doc" | grep -m1 '^[[:space:]]*- 记录：' || true)
  if [ -z "$rec" ] || [ "$rec" = "- 记录：" ]; then
    echo "$id FAIL (勾选但无验证记录)"
    fail=1; continue
  fi
  echo "$id PASS"
done
exit $fail
