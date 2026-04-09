#!/bin/bash
# check_deps.sh — 检测 src-tauri/src/ 中的依赖方向规则
# 规则定义：
#   api/    -> engine/, types/, store/   (唯一可导入 tauri crate 的层)
#   engine/ -> types/, store/
#   store/  -> types/
#   types/  -> 无依赖（不允许 crate:: import）

set -e

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
SRC_DIR="$ROOT_DIR/src-tauri/src"
ERRORS=0

echo "=== Dependency Direction Check ==="

# Rule 1: engine/ 不能依赖 api/
echo "Checking: engine/ -> api/ (forbidden)..."
if grep -rn "use crate::api" "$SRC_DIR/engine/" 2>/dev/null; then
    echo "  ERROR: engine/ imports api/"
    ERRORS=$((ERRORS + 1))
fi

# Rule 2: store/ 不能依赖 engine/
echo "Checking: store/ -> engine/ (forbidden)..."
if grep -rn "use crate::engine" "$SRC_DIR/store/" 2>/dev/null; then
    echo "  ERROR: store/ imports engine/"
    ERRORS=$((ERRORS + 1))
fi

# Rule 3: types/ 不能依赖 api/, engine/, store/
echo "Checking: types/ -> other layers (forbidden)..."
if grep -rn "use crate::\(api\|engine\|store\)" "$SRC_DIR/types/" 2>/dev/null; then
    echo "  ERROR: types/ imports other layers"
    ERRORS=$((ERRORS + 1))
fi

# Rule 4: 只有 api/ 可以导入 tauri crate
echo "Checking: tauri imports outside api/ (forbidden)..."
for dir in engine types store; do
    if [ -d "$SRC_DIR/$dir" ]; then
        if grep -rn "use tauri" "$SRC_DIR/$dir/" 2>/dev/null; then
            echo "  ERROR: tauri imported in $dir/"
            ERRORS=$((ERRORS + 1))
        fi
    fi
done

# Rule 5: types/ 纯净性 — 不允许 async fn, std::fs, tokio::
echo "Checking: types/ purity (no async fn, std::fs, tokio::)..."
VIOLATION=""
if grep -rn "async fn" "$SRC_DIR/types/" 2>/dev/null; then
    VIOLATION="$VIOLATION async fn"
fi
if grep -rn "std::fs" "$SRC_DIR/types/" 2>/dev/null; then
    VIOLATION="$VIOLATION std::fs"
fi
if grep -rn "tokio::" "$SRC_DIR/types/" 2>/dev/null; then
    VIOLATION="$VIOLATION tokio::"
fi
if [ -n "$VIOLATION" ]; then
    echo "  ERROR: types/ contains forbidden patterns:$VIOLATION"
    ERRORS=$((ERRORS + 1))
fi

# Rule 6: prompts/ 不能作为 Rust 模块导入
echo "Checking: prompts/ module import (forbidden)..."
PROMPTS_VIOLATION=""
for f in "$SRC_DIR/lib.rs" "$SRC_DIR/api/mod.rs" "$SRC_DIR/engine/mod.rs"; do
    if [ -f "$f" ] && grep -q "mod prompts" "$f" 2>/dev/null; then
        PROMPTS_VIOLATION="$PROMPTS_VIOLATION $f"
    fi
done
if [ -n "$PROMPTS_VIOLATION" ]; then
    echo "  ERROR: 'mod prompts' found in:$PROMPTS_VIOLATION"
    ERRORS=$((ERRORS + 1))
fi

echo ""
if [ $ERRORS -eq 0 ]; then
    echo "All dependency checks PASSED"
    exit 0
else
    echo "DEPENDENCY CHECK FAILED: $ERRORS violation(s) found"
    exit 1
fi
