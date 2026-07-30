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

# ── Step 5: changeset 完整性检查（WARNING 级别，不阻断）
# 检测：改了 extensions/ 发布包但无对应 changeset → 提醒（不发版的改动可忽略）
check_changeset() {
    log "▸ Step: changeset check"

    # 只在 feature 分支（有 main 可对比）时检查
    if ! git rev-parse --verify main >/dev/null 2>&1 && ! git rev-parse --verify github/main >/dev/null 2>&1; then
        log "  ↷ skip（找不到 main 分支，无法对比）"
        RESULTS+=("SKIP changeset-check 0s (no main)")
        return 0
    fi

    # 找出改了 src/ 的 extension 包（只改 docs/test/examples 的不算）
    local changed_pkgs=()
    while IFS= read -r file; do
        # 提取包目录（extensions/<name>/src/ 或 extensions/shared/<name>/src/）
        local pkg_dir
        pkg_dir=$(echo "$file" | grep -oE '^extensions/(shared/)?[^/]+/' | sed 's:/$::' || true)
        [ -z "$pkg_dir" ] && continue

        # 只关心改了 src/ 的（排除 README、docs、examples、workflows）
        echo "$file" | grep -qE '^extensions/(shared/)?[^/]+/src/' || continue

        # 读 package.json 的 name 字段
        local pkg_name
        pkg_name=$(node -p "require('./$pkg_dir/package.json').name" 2>/dev/null || echo "")
        [ -z "$pkg_name" ] && continue

        # 去重
        local found=0
        for p in "${changed_pkgs[@]:-}"; do [ "$p" = "$pkg_name" ] && found=1 && break; done
        [ "$found" = "0" ] && changed_pkgs+=("$pkg_name")
    done < <(git diff main...HEAD --name-only 2>/dev/null || git diff github/main...HEAD --name-only 2>/dev/null)

    if [ "${#changed_pkgs[@]}" -eq 0 ]; then
        log "  ✓ 无 extension src/ 改动，跳过 changeset 检查"
        RESULTS+=("PASS changeset-check 0s (no ext changes)")
        return 0
    fi

    # 收集 changeset 文件中声明的包名
    local declared_pkgs
    declared_pkgs=$(grep -rh '"@' .changeset/*.md 2>/dev/null | grep -oE '"@[^"]+"' | tr -d '"' | sort -u || echo "")

    # 找出改了但没声明 changeset 的包
    local missing=()
    for pkg in "${changed_pkgs[@]}"; do
        if ! echo "$declared_pkgs" | grep -qF "$pkg"; then
            missing+=("$pkg")
        fi
    done

    if [ "${#missing[@]}" -eq 0 ]; then
        log "  ✓ 所有改动的 extension 包都有 changeset（${#changed_pkgs[@]} 个包）"
        RESULTS+=("PASS changeset-check 0s (${#changed_pkgs[@]} pkgs)")
    else
        log "  ⚠ ${#missing[@]} 个 extension 改了 src/ 但无 changeset："
        for pkg in "${missing[@]}"; do
            log "    - $pkg"
        done
        log "  如需发布，运行: pnpm changeset"
        log "  如是纯文档/测试/重构改动无需发布，可忽略此警告"
        RESULTS+=("WARN changeset-check 0s (${#missing[@]} missing)")
    fi
}
check_changeset

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
