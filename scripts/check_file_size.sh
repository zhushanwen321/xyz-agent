#!/bin/bash
# check_file_size.sh — 检测单个 .rs 文件不超过 500 行（排除注释和空行）

set -e

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
SRC_DIR="$ROOT_DIR/src-tauri/src"
LIMIT=500
ERRORS=0

echo "=== File Size Check (max $LIMIT lines, excluding comments and blanks) ==="

while IFS= read -r -d '' file; do
    # 过滤注释行（// 和 /* */ 块注释）和空行，计数有效行
    # 简单方案：用 sed 移除单行注释和空行，然后计数
    effective_lines=$(sed 's|//.*||; /^[[:space:]]*$/d; /\/\*/,/\*\//d' "$file" | wc -l | tr -d ' ')

    if [ "$effective_lines" -gt "$LIMIT" ]; then
        rel_path="${file#$ROOT_DIR/}"
        echo "  ERROR: $rel_path has $effective_lines effective lines (limit: $LIMIT)"
        ERRORS=$((ERRORS + 1))
    fi
done < <(find "$SRC_DIR" -name "*.rs" -print0 2>/dev/null)

echo ""
if [ $ERRORS -eq 0 ]; then
    echo "All file size checks PASSED"
    exit 0
else
    echo "FILE SIZE CHECK FAILED: $ERRORS file(s) exceeded limit"
    exit 1
fi
