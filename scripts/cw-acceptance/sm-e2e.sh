#!/usr/bin/env bash
# sm-e2e.sh — cw acceptance wrapper for sm-e2e unit (E1-E9)
# e2e-real 型：每个 id 分支输出 "<id> PASS"/"<id> FAIL" 标记行，exit code 与标记一致。
# e2e 探针为 packages/runtime/test/e2e/scoped-model.e2e.mjs（node ≥22 内置 WebSocket）。
# E9 unit 型由 vitest 直接执行。
#
# 用法：bash scripts/cw-acceptance/sm-e2e.sh <E1|E2|E3|E4|E5|E6|E7|E8|E9>

set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FAIL: cannot cd to repo root"; exit 1; }

ID="${1:?Usage: $0 <E1|E2|...|E9|all>}"

# ── all 模式：循环 E1-E8 并汇总输出 R2 标记行（root unit R2 集成验收用）──
# R2 的名字级比对要求产物含 "R2" 词边界行；E1-E8 各自的标记行保留作细节。
if [ "$ID" = "all" ]; then
  overall=0
  for sub in E1 E2 E3 E4 E5 E6 E7 E8; do
    if bash "$0" "$sub"; then :; else overall=1; fi
  done
  if [ "$overall" -eq 0 ]; then echo "R2 PASS"; else echo "R2 FAIL"; fi
  exit "$overall"
fi

# ── 公共前置 ────────────────────────────────────────────────────

# 1. 依赖就绪
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "[sm-e2e] node_modules missing, installing..." >&2
  env ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --silent || { echo "$ID FAIL"; exit 1; }
fi

# 2. 隔离数据目录
DATA_DIR=$(mktemp -d -t xyz-sm-e2e-XXXXXX)
trap 'rm -rf "$DATA_DIR"' EXIT

# 隔离性断言：DATA_DIR 不能是 ~/.xyz-agent
if [ "$DATA_DIR" = "$HOME/.xyz-agent" ] || [ "$DATA_DIR" = "$HOME/.xyz-agent/" ]; then
  echo "[sm-e2e] FATAL: DATA_DIR equals real ~/.xyz-agent" >&2
  echo "$ID FAIL"
  exit 1
fi

export XYZ_AGENT_DATA_DIR="$DATA_DIR"
export XYZ_RUNTIME_TOKEN="test-token-sm-e2e"

# ── E9: 单测（vitest 直接执行，不需要 e2e 探针）─────────────────
if [ "$ID" = "E9" ]; then
  if (cd "$REPO_ROOT/packages/runtime" && npx vitest run test/scoped-model-e9.test.ts -t "E9"); then
    echo "E9 PASS"
    exit 0
  else
    echo "E9 FAIL"
    exit 1
  fi
fi

# ── E7: 全量回归（冒烟 + lint + vitest）─────────────────────────
if [ "$ID" = "E7" ]; then
  # (1) scoped 实现存在性冒烟
  echo "[sm-e2e] E7: scoped smoke test..." >&2
  SMOKE_DIR=$(mktemp -d -t xyz-sm-e2e-smoke-XXXXXX)
  trap 'rm -rf "$SMOKE_DIR" "$DATA_DIR"' EXIT
  export XYZ_AGENT_DATA_DIR="$SMOKE_DIR"
  if ! node "$REPO_ROOT/packages/runtime/test/e2e/scoped-model.e2e.mjs" smoke 2>/dev/null; then
    echo "[sm-e2e] E7 FAIL: scoped smoke failed (implementation missing?)" >&2
    echo "E7 FAIL"
    exit 1
  fi
  export XYZ_AGENT_DATA_DIR="$DATA_DIR"

  # (2) lint 预检
  echo "[sm-e2e] E7: lint check..." >&2
  BASE_COMMIT="75f596069"
  if ! git merge-base --is-ancestor "$BASE_COMMIT" HEAD 2>/dev/null; then
    echo "E7 FAIL: base commit $BASE_COMMIT not reachable"
    exit 1
  fi
  LINT_OUTPUT=$(pnpm run lint 2>&1) || true
  CHANGED_FILES=$(git diff --name-only "$BASE_COMMIT" HEAD -- '*.ts' '*.tsx' '*.vue' '*.mts' 2>/dev/null || true)
  if [ -n "$CHANGED_FILES" ]; then
    # 检查改动文件中是否有新增 lint error
    while IFS= read -r f; do
      if echo "$LINT_OUTPUT" | grep -q "$f.*error"; then
        echo "[sm-e2e] E7 FAIL: lint error in changed file $f" >&2
        echo "E7 FAIL"
        exit 1
      fi
    done <<< "$CHANGED_FILES"
  fi

  # (3) 受影响测试集（增量口径，2026-08-22 CPU 打满复盘）
  # 原四包全量 vitest（runtime 3500+ 用例）在 runner 并行 + 干净 checkout 下打满 CPU
  # 且诱发 real-pi 时序翻转。改为 affected-tests.sh 推导：diff 中测试文件 ∪ 改动源
  # 文件同名测试，逐包串行跑。全量回归归 PR pre-merge 管线（pr-cr-fix pre-push）兜底。
  # XYZ_SKIP_REAL_PI=1 保留：增量集若含 real-pi 组文件，仍走双轨 skip。
  export XYZ_SKIP_REAL_PI=1
  echo "[sm-e2e] E7: running affected tests..." >&2
  if ! bash "$REPO_ROOT/scripts/cw-acceptance/affected-tests.sh" "$BASE_COMMIT" --run; then
    echo "[sm-e2e] E7 FAIL: affected tests failed" >&2
    echo "E7 FAIL"
    exit 1
  fi

  echo "E7 PASS"
  exit 0
fi

# ── E1-E6, E8: e2e 探针 ────────────────────────────────────────
E2E_PROBE="$REPO_ROOT/packages/runtime/test/e2e/scoped-model.e2e.mjs"

if [ ! -f "$E2E_PROBE" ]; then
  echo "[sm-e2e] e2e probe not found: $E2E_PROBE" >&2
  echo "$ID FAIL"
  exit 1
fi

PROBE_OUTPUT=$(node "$E2E_PROBE" "$ID" "$DATA_DIR" 2>&1)
PROBE_STATUS=$?
echo "$PROBE_OUTPUT"
if [ "$PROBE_STATUS" -ne 0 ]; then
  # 探针 exit non-zero：确保有 FAIL 标记行（探针 crash 未输出标记时补齐，不重跑探针）
  if ! grep -q "^${ID} FAIL" <<< "$PROBE_OUTPUT"; then
    echo "$ID FAIL"
  fi
  exit 1
fi
exit 0
