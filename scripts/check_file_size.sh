#!/bin/bash
# check_file_size.sh — 检测单个 .rs 文件不超过 500 行（排除注释和空行）

set -e

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
SRC_DIR="$ROOT_DIR/src-tauri/src"
LIMIT=500
ERRORS=0

echo "=== File Size Check (max $LIMIT lines, excluding comments and blanks) ==="

while IFS= read -r -d '' file; do
    # 过滤注释行和空行，计数有效行
    # 移除 // 注释行、空行、单行 /* ... */ 块注释
    effective_lines=$(grep -vE '^\s*(//|/\*.*\*/\s*)?$' "$file" | wc -l | tr -d ' ')

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
