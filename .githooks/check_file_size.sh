#!/bin/bash
# check_file_size.sh — 检测单个 .rs 文件不超过 500 行
# 排除：注释、空行、#[cfg(test)] mod tests { ... } 块

set -e

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
SRC_DIR="$ROOT_DIR/src-tauri/src"
LIMIT=500
ERRORS=0

echo "=== File Size Check (max $LIMIT lines, excluding comments, blanks, and tests) ==="

# 计算有效行数：剔除注释、空行、#[cfg(test)] 块
count_effective_lines() {
    local file="$1"
    awk '
    # 进入 test 块：匹配 #[cfg(test)] 后跟 mod tests {
    /^#\[cfg\(test\)\]/ { in_test = 1; next }
    in_test && /mod tests/ { brace_depth = 0; next }

    # test 块内跟踪花括号深度
    in_test {
        for (i = 1; i <= length($0); i++) {
            c = substr($0, i, 1)
            if (c == "{") brace_depth++
            if (c == "}") {
                brace_depth--
                if (brace_depth <= 0) { in_test = 0; next }
            }
        }
        next
    }

    # 跳过空行和注释行
    /^\s*(\/\/|\/\*.*\*\/\s*)?$/ { next }

    { count++ }
    END { print count + 0 }
    ' "$file"
}

while IFS= read -r -d '' file; do
    effective_lines=$(count_effective_lines "$file")

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
    echo ""
    echo "Suggested fixes (in order of preference):"
    echo "  1. Extract tests to a separate file: #[cfg(test)] #[path = \"xxx_tests.rs\"] mod tests;"
    echo "  2. Split the module into a directory with sub-modules"
    exit 1
fi
