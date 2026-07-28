#!/usr/bin/env bash
# sync-mobile-from-renderer.sh —— renderer → mobile-renderer 业务核心层同步脚本（spec P4 D2 + 审查 M5）。
#
# 职责：把 renderer 的业务核心层（api/stores/composables/components/lib/i18n/utils 等）copy 到
# mobile-renderer，保持移动端与桌面端业务逻辑同步。缓解 R1（P5/P6/P7 改 renderer 后 mobile-renderer 漂移）。
#
# 用法：
#   scripts/sync-mobile-from-renderer.sh           # 默认 --dry-run（只 diff 不写，安全默认）
#   scripts/sync-mobile-from-renderer.sh --dry-run # 显式 dry-run
#   scripts/sync-mobile-from-renderer.sh --force   # 实际 copy（覆盖目标）
#
# 机制：
#   - COPY_MAP：src→dst 映射（相对仓库根），整目录或单文件
#   - MANUAL_FORK：手动分叉点（useConnection.ts 砍了本地模式），--force 时跳过 + 警告
#   - --dry-run：diff -r 输出每个映射的状态（identical/changed/src-missing），不写文件
#   - --force：cp -r 覆盖目标（跳过 MANUAL_FORK），src 缺失输出警告不中断（ES2）
#
# 退出码：0 成功（--dry-run 恒 0）；--force 时若有 cp 失败 exit 1（ES2）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_BASE="$REPO_ROOT/packages/renderer/src"
DST_BASE="$REPO_ROOT/packages/mobile-renderer/src"

# ── COPY_MAP：src 相对 SRC_BASE → dst 相对 DST_BASE ─────────────────────
# 整目录或单文件映射。覆盖 FR2 copy 清单（spec §二）。
COPY_MAP=(
  "api:api"
  "stores:stores"
  "composables:composables"
  "components/ui:components/ui"
  "components/panel/message-stream:components/panel/message-stream"
  "components/panel/thinking-levels.ts:components/panel/thinking-levels.ts"
  "components/sidebar:components/sidebar"
  "components/new-task:components/new-task"
  "lib/remote:lib/remote"
  "lib/ws-client.ts:lib/ws-client.ts"
  "lib/utils.ts:lib/utils.ts"
  "lib/path-utils.ts:lib/path-utils.ts"
  "lib/platform.ts:lib/platform.ts"
  "lib/terminal-reconnect-signal.ts:lib/terminal-reconnect-signal.ts"
  "lib/search-types.ts:lib/search-types.ts"
  "lib/file-basename.ts:lib/file-basename.ts"
  "lib/file-candidates.ts:lib/file-candidates.ts"
  "lib/file-match.ts:lib/file-match.ts"
  "lib/match-engine.ts:lib/match-engine.ts"
  "lib/internal-command-filter.ts:lib/internal-command-filter.ts"
  "mock:mock"
  "i18n:i18n"
  "utils:utils"
  "types.ts:types.ts"
)

# ── MANUAL_FORK：手动分叉点（--force 时跳过 + 警告）─────────────────────
# useConnection.ts 砍了本地模式分支（spec C3），sync 不自动覆盖，需人工 diff 合并。
MANUAL_FORK=(
  "composables/useConnection.ts"
)

# ── 参数解析 ──────────────────────────────────────────────────────────
MODE="--dry-run"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="--dry-run" ;;
    --force) MODE="--force" ;;
    *) echo "未知参数: $arg（支持 --dry-run / --force）" >&2; exit 2 ;;
  esac
done

# 判断某 dst 相对路径是否在 MANUAL_FORK 列表
is_manual_fork() {
  local dst_rel="$1"
  for fork in "${MANUAL_FORK[@]}"; do
    if [[ "$fork" == "$dst_rel" ]]; then return 0; fi
  done
  return 1
}

echo "=== sync-mobile-from-renderer.sh [$MODE] ==="
echo "src: $SRC_BASE"
echo "dst: $DST_BASE"
echo ""

changed_count=0
identical_count=0
missing_count=0
fork_skipped_count=0
failed_count=0

for mapping in "${COPY_MAP[@]}"; do
  src_rel="${mapping%%:*}"
  dst_rel="${mapping##*:}"
  src="$SRC_BASE/$src_rel"
  dst="$DST_BASE/$dst_rel"

  # MANUAL_FORK 检查（仅 --force 时跳过；--dry-run 仍 diff 提示差异）
  if [[ "$MODE" == "--force" ]] && is_manual_fork "$dst_rel"; then
    echo "[FORK-SKIP] $dst_rel （手动分叉点，--force 跳过，请人工 diff renderer 版本合并远程模式改动）"
    fork_skipped_count=$((fork_skipped_count + 1))
    continue
  fi

  # src 缺失（ES2 韧性）
  if [[ ! -e "$src" ]]; then
    echo "[SRC-MISSING] $src_rel （renderer 重构后此路径已移除，建议从 COPY_MAP 清理）"
    missing_count=$((missing_count + 1))
    continue
  fi

  if [[ "$MODE" == "--dry-run" ]]; then
    # --dry-run：diff -r 判断状态（dst 不存在视为 changed）
    if [[ ! -e "$dst" ]]; then
      echo "[NEW]       $dst_rel （目标不存在，--force 将创建）"
      changed_count=$((changed_count + 1))
    elif diff -rq "$src" "$dst" >/dev/null 2>&1; then
      echo "[IDENTICAL] $dst_rel"
      identical_count=$((identical_count + 1))
    else
      echo "[CHANGED]   $dst_rel （--force 将覆盖）"
      changed_count=$((changed_count + 1))
    fi
  else
    # --force：cp -r 覆盖
    mkdir -p "$(dirname "$dst")"
    if cp -r "$src" "$dst" 2>/dev/null; then
      echo "[COPIED]    $dst_rel"
    else
      echo "[FAILED]    $dst_rel （cp 失败）" >&2
      failed_count=$((failed_count + 1))
    fi
  fi
done

echo ""
echo "=== summary ==="
if [[ "$MODE" == "--dry-run" ]]; then
  echo "identical: $identical_count | changed/new: $changed_count | src-missing: $missing_count | fork-skipped: $fork_skipped_count"
  echo "（--dry-run，未写文件。确认无误后跑 --force 执行同步）"
  exit 0
else
  echo "copied: $((identical_count + changed_count)) | src-missing: $missing_count | fork-skipped: $fork_skipped_count | failed: $failed_count"
  if [[ $failed_count -gt 0 ]]; then
    echo "有 $failed_count 个 cp 失败（exit 1）" >&2
    exit 1
  fi
  echo "同步完成。"
  exit 0
fi
