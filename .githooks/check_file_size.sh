#!/bin/bash
# check_file_size.sh — 检测文件和方法行数限制
# Rust: 有效行数 ≤ 500（排除注释/空行/test 块）
# .ts 文件: 有效行数 ≤ 500
# .vue 文件: <script> 部分有效行数 ≤ 500
# 单方法/函数: ≤ 300 行（Rust fn / TS function）

set -e

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
FILE_LIMIT=500
FN_LIMIT=300
ERRORS=0

echo "=== File Size Check (max $FILE_LIMIT lines, excluding comments, blanks, and tests) ==="

# ─── Rust 文件检查 ───

count_rs_effective_lines() {
    local file="$1"
    awk '
    /^#\[cfg\(test\)\]/ { in_test = 1; next }
    in_test && /mod tests/ { brace_depth = 0; next }
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
    /^[ \t]*$/ { next }
    /^[ \t]*\/\// { next }
    { count++ }
    END { print count + 0 }
    ' "$file"
}

while IFS= read -r -d '' file; do
    effective_lines=$(count_rs_effective_lines "$file")
    if [ "$effective_lines" -gt "$FILE_LIMIT" ]; then
        rel_path="${file#$ROOT_DIR/}"
        echo "  ERROR: $rel_path has $effective_lines effective lines (limit: $FILE_LIMIT)"
        ERRORS=$((ERRORS + 1))
    fi
done < <(find "$ROOT_DIR/src-tauri/src" -name "*.rs" -print0 2>/dev/null)

# ─── TypeScript 文件检查 ───

count_ts_effective_lines() {
    local file="$1"
    awk '
    /^[ \t]*$/ { next }
    /^[ \t]*\/\// { next }
    /^[ \t]*\*/ { next }
    { count++ }
    END { print count + 0 }
    ' "$file"
}

while IFS= read -r -d '' file; do
    effective_lines=$(count_ts_effective_lines "$file")
    if [ "$effective_lines" -gt "$FILE_LIMIT" ]; then
        rel_path="${file#$ROOT_DIR/}"
        echo "  ERROR: $rel_path has $effective_lines effective lines (limit: $FILE_LIMIT)"
        ERRORS=$((ERRORS + 1))
    fi
done < <(find "$ROOT_DIR/src" -name "*.ts" -not -path "*/node_modules/*" -not -name "*.d.ts" -print0 2>/dev/null)

# ─── Vue 文件 <script> 部分检查 ───

count_vue_script_lines() {
    local file="$1"
    awk '
    /<script/ { in_script = 1; next }
    /<\/script>/ { in_script = 0; next }
    in_script && /^[ \t]*$/ { next }
    in_script && /^[ \t]*\/\// { next }
    in_script { count++ }
    END { print count + 0 }
    ' "$file"
}

while IFS= read -r -d '' file; do
    script_lines=$(count_vue_script_lines "$file")
    if [ "$script_lines" -gt "$FILE_LIMIT" ]; then
        rel_path="${file#$ROOT_DIR/}"
        echo "  ERROR: $rel_path <script> section has $script_lines effective lines (limit: $FILE_LIMIT)"
        ERRORS=$((ERRORS + 1))
    fi
done < <(find "$ROOT_DIR/src" -name "*.vue" -not -path "*/node_modules/*" -print0 2>/dev/null)

echo ""

# ─── 单方法/函数行数检查 ───

echo "=== Function Size Check (max $FN_LIMIT lines) ==="

# Rust: 统计 fn 块行数
check_rs_fn_sizes() {
    local file="$1"
    local rel_path="$2"
    awk -v limit="$FN_LIMIT" -v file="$rel_path" '
    /^(\s*pub\s+)?(\(\s*\))?\s*fn\s+/ || /^\s*fn\s+/ {
        if (fn_start != 0 && fn_lines > limit) {
            printf "  ERROR: %s:%d fn spans %d lines (limit: %d)\n", file, fn_start, fn_lines, limit
        }
        fn_start = NR
        fn_lines = 1
        brace_depth = 0
        found_brace = 0
    }
    fn_start != 0 {
        for (i = 1; i <= length($0); i++) {
            c = substr($0, i, 1)
            if (c == "{") { brace_depth++; found_brace = 1 }
            if (c == "}") {
                brace_depth--
                if (found_brace && brace_depth <= 0) {
                    fn_lines = NR - fn_start + 1
                    if (fn_lines > limit) {
                        printf "  ERROR: %s:%d fn spans %d lines (limit: %d)\n", file, fn_start, fn_lines, limit
                    }
                    fn_start = 0
                    fn_lines = 0
                }
            }
        }
    }
    ' "$file"
}

while IFS= read -r -d '' file; do
    rel_path="${file#$ROOT_DIR/}"
    check_rs_fn_sizes "$file" "$rel_path"
done < <(find "$ROOT_DIR/src-tauri/src" -name "*.rs" -print0 2>/dev/null)

# TypeScript/Vue script: 统计 function 块行数
check_ts_fn_sizes() {
    local file="$1"
    local rel_path="$2"
    # 匹配 function 声明、箭头函数赋值 const xxx = () =>
    awk -v limit="$FN_LIMIT" -v file="$rel_path" '
    /function\s+\w+/ || /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*(=>|:\s*\{)/ || /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?function/ {
        if (fn_start != 0 && fn_lines > limit) {
            printf "  ERROR: %s:%d function spans %d lines (limit: %d)\n", file, fn_start, fn_lines, limit
        }
        fn_start = NR
        fn_lines = 1
        brace_depth = 0
        found_brace = 0
    }
    fn_start != 0 {
        for (i = 1; i <= length($0); i++) {
            c = substr($0, i, 1)
            if (c == "{") { brace_depth++; found_brace = 1 }
            if (c == "}") {
                brace_depth--
                if (found_brace && brace_depth <= 0) {
                    fn_lines = NR - fn_start + 1
                    if (fn_lines > limit) {
                        printf "  ERROR: %s:%d function spans %d lines (limit: %d)\n", file, fn_start, fn_lines, limit
                    }
                    fn_start = 0
                    fn_lines = 0
                }
            }
        }
    }
    ' "$file"
}

while IFS= read -r -d '' file; do
    rel_path="${file#$ROOT_DIR/}"
    check_ts_fn_sizes "$file" "$rel_path"
done < <(find "$ROOT_DIR/src" \( -name "*.ts" -o -name "*.vue" \) -not -path "*/node_modules/*" -not -name "*.d.ts" -print0 2>/dev/null)

echo ""
if [ $ERRORS -eq 0 ]; then
    echo "All file size checks PASSED"
    exit 0
else
    echo "FILE SIZE CHECK FAILED: $ERRORS file(s) exceeded limit"
    echo ""
    echo "Suggested fixes:"
    echo "  Rust: Extract tests to separate file, or split module into sub-modules"
    echo "  TS/Vue: Extract composable, split component, or extract helper functions"
    exit 1
fi
