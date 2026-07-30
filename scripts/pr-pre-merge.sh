#!/usr/bin/env bash
# pr-pre-merge.sh — pre-merge 工程验证一体化（xyz-agent 适配版）
#
# 按顺序执行 typecheck → lint → test → build，任意一步失败立即退出。
# 覆盖三条代码线：extensions/ + packages/runtime + packages/renderer。
#
# 用法:
#   bash scripts/pr-pre-merge.sh
#   bash scripts/pr-pre-merge.sh --quiet   # 只输出最终结果
#
# 退出码:
#   0 = 全部通过
#   1 = 任意一步失败（输出失败步骤的 stderr 末 30 行）
#
# 环境变量:
#   PR_PRE_MERGE_SKIP_BUILD=1   跳过 build 步骤（Electron build 耗时较长）
#   PR_PRE_MERGE_QUIET=1        静默模式（只在结束时输出汇总）

set -euo pipefail

QUIET="${PR_PRE_MERGE_QUIET:-0}"
[[ "${1:-}" == "--quiet" ]] && QUIET=1

log() {
    [[ "$QUIET" == "1" ]] || echo "[pr-pre-merge] $*"
}

# 必须在 git 仓库根目录
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "Not a git repo" >&2; exit 2; })"
cd "$GIT_ROOT"

START=$(date +%s)
RESULTS=()

run_step() {
    local name="$1"; shift
    log "▸ Step: $name"
    local step_start=$(date +%s)
    local exit_code=0
    local output_file
    output_file="$(mktemp -t pr-pre-merge.XXXXXX)"

    # 同时捕获 stdout+stderr；只对命令本身静默
    if [[ "$QUIET" == "1" ]]; then
        "$@" >"$output_file" 2>&1 || exit_code=$?
    else
        "$@" 2>&1 | tee "$output_file"
        exit_code=${PIPESTATUS[0]}
    fi

    local step_end=$(date +%s)
    local elapsed=$((step_end - step_start))

    if [[ $exit_code -eq 0 ]]; then
        RESULTS+=("PASS $name ${elapsed}s")
        log "  ✓ $name passed in ${elapsed}s"
        rm -f "$output_file"
    else
        RESULTS+=("FAIL $name ${elapsed}s (exit=$exit_code)")
        log "  ✗ $name failed in ${elapsed}s (exit=$exit_code)"
        log "  --- last 30 lines of output ---"
        tail -30 "$output_file" >&2 || true
        log "  -------------------------------"
        rm -f "$output_file"
        write_result_marker "FAIL"
        return $exit_code
    fi
}

# 写入 stage gate marker（供 pr-status.sh 读取）
write_result_marker() {
    local result="$1"
    mkdir -p .review
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    cat > .review/premerge-result <<MARKER
timestamp="$ts"
result="$result"
MARKER
}

# ── Step 1: typecheck（extensions 独立 tsconfig + 项目层）
# extensions/ 有独立 tsconfig.json（noEmit），项目层暂无全局 typecheck script
run_step "typecheck:extensions" bash -c 'cd "$0" && npx tsc --noEmit' extensions

# ── Step 2: lint（根 eslint 覆盖全局含 extensions）
run_step "lint" npm run lint

# ── Step 3: test（extensions + runtime + renderer 三条线）
# extensions 测试（pnpm -r --filter @zhushanwen/pi-* test = vitest run）
run_step "test:extensions" pnpm extensions:test
# runtime 测试（vitest config 在 packages/runtime/）
run_step "test:runtime" bash -c 'cd packages/runtime && npx vitest run'
# renderer 测试（vitest config 在 packages/renderer/，含 @ alias）
run_step "test:renderer" bash -c 'cd packages/renderer && npx vitest run'

# ── Step 4: build（可选，Electron build 耗时较长，默认跳过除非显式要求）
if [[ "${PR_PRE_MERGE_SKIP_BUILD:-1}" == "1" ]]; then
    log "  ↷ build skipped (PR_PRE_MERGE_SKIP_BUILD=1, default for Electron project)"
    RESULTS+=("SKIP build 0s")
else
    run_step "build" npm run build
fi

END=$(date +%s)
TOTAL=$((END - START))

echo ""
echo "[pr-pre-merge] === SUMMARY (${TOTAL}s total) ==="
for r in "${RESULTS[@]}"; do
    echo "  $r"
done
echo "[pr-pre-merge] all checks passed ✓"

write_result_marker "PASS"

exit 0
