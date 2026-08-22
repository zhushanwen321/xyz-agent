#!/usr/bin/env bash
# affected-tests.sh — cw 增量验收口径：只跑改动涉及的测试（2026-08-22 CPU 打满复盘）
#
# 背景：cw verify 的 E7/根验收曾跑四包全量 vitest（runtime 3500+ 用例），runner 并行 +
# 干净 checkout 环境下 CPU 打满、real-pi 时序测试随机翻转。分层决策：
#   - unit 级 verify = 各 unit spec 的 A-id 定向测试（本就增量）
#   - 集成级验收（E7 / root R1）= 本脚本推导的「受影响测试集」
#   - 全量回归 = PR pre-merge 管线一次性兜底（pr-cr-fix pre-push），不在 cw 每层跑
#
# 推导规则（机械可审，无依赖图）：
#   受影响测试 = git diff <base>..HEAD 中的所有 *.test.ts(x)
#              ∪ 改动源文件（.ts/.vue/.mts）按 basename 同名的 *.test.ts(x)（包内查找）
#   本次功能的聚合测试（scoped-model-e9 等）本身在 diff 中 → 直接覆盖；
#   非同名既有测试（如 pi-provider-store.ts ↔ finddefault.test.ts）由对应 unit 的
#   A-id 定向验收覆盖，不在此重复推导。
#
# 用法：
#   bash scripts/cw-acceptance/affected-tests.sh <base-commit>          # 列出清单
#   bash scripts/cw-acceptance/affected-tests.sh <base-commit> --run    # 逐包执行
# 退出码：list 0；--run 全部通过 0，任一失败 1。

set -o pipefail

BASE="${1:?usage: affected-tests.sh <base-commit> [--run]}"
MODE="list"
[ "${2:-}" = "--run" ] && MODE="run"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

if ! git merge-base --is-ancestor "$BASE" HEAD 2>/dev/null; then
  echo "affected-tests: base commit $BASE not reachable from HEAD" >&2
  exit 1
fi

# 收集受影响测试文件（仓库根相对路径，去重排序）
collect() {
  git diff --name-only "$BASE"..HEAD -- '*.ts' '*.tsx' '*.mts' '*.vue' | while read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *.test.ts|*.test.tsx)
        [ -f "$f" ] && echo "$f"
        ;;
      *)
        # 包内同名测试：packages/<pkg>/ 内 basename 一致的 *.test.ts(x)
        pkg_root="${f%%/*}/$(echo "$f" | cut -d/ -f2)"
        [ -d "$pkg_root" ] || continue
        base_name="$(basename "${f%.*}")"
        find "$pkg_root" -name "${base_name}.test.ts" -o -name "${base_name}.test.tsx" 2>/dev/null
        ;;
    esac
  done | sort -u
}

FILES=$(collect)
if [ -z "$FILES" ]; then
  echo "affected-tests: no affected test files (base=$BASE)" >&2
  exit 0
fi

# 按包分组输出/执行
PKGS=$(echo "$FILES" | cut -d/ -f1-2 | sort -u)

if [ "$MODE" = "list" ]; then
  echo "$FILES"
  exit 0
fi

# --run：逐包串行（避免四包并行 vitest 打满 CPU——2026-08-22 复盘决策）
overall=0
for pkg in $PKGS; do
  rel_files=$(echo "$FILES" | grep "^$pkg/" | sed "s|^$pkg/||")
  echo "[affected-tests] vitest in $pkg:" >&2
  echo "$rel_files" | sed 's/^/  /' >&2
  if ! (cd "$pkg" && npx vitest run $rel_files 2>&1); then
    echo "[affected-tests] FAIL in $pkg" >&2
    overall=1
  fi
done
exit $overall
