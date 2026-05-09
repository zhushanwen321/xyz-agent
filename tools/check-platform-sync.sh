#!/usr/bin/env bash
# 检查 Tauri/Electron 平台文件同步状态
# sidecar/src/* → src-electron/sidecar/src/*
# src/src/*     → src-electron/renderer/src/*
# shared/src/*  → src-electron/shared/src/*
set -euo pipefail

if [ "${SKIP_PLATFORM_SYNC:-0}" = "1" ]; then
  echo "SKIP_PLATFORM_SYNC=1, skipping platform sync check"
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# 获取 staged 文件（相对于项目根目录）
staged_files=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
if [ -z "$staged_files" ]; then
  echo "No staged files found, checking working tree changes instead..."
  staged_files=$(git diff --name-only --diff-filter=ACMR 2>/dev/null || true)
fi
if [ -z "$staged_files" ]; then
  echo "No changes detected, nothing to check."
  exit 0
fi

DIFF_FOUND=0

# 将源路径映射到对应的 electron 平台路径
# 参数: $1 = 源文件相对路径
# 输出: 对应的 electron 路径（不存在则空）
map_to_electron() {
  local src="$1"

  # sidecar/src/X.ts → src-electron/sidecar/src/X.ts
  if [[ "$src" == sidecar/src/* ]]; then
    echo "src-electron/${src}"
    return
  fi

  # src/src/**/*.vue → src-electron/renderer/src/**/*.vue
  if [[ "$src" == src/src/* ]]; then
    # 去掉 "src/src/" 前缀，拼到 "src-electron/renderer/src/"
    local rest="${src#src/src/}"
    echo "src-electron/renderer/src/${rest}"
    return
  fi

  # shared/src/X.ts → src-electron/shared/src/X.ts
  if [[ "$src" == shared/src/* ]]; then
    echo "src-electron/${src}"
    return
  fi

  # 不在映射范围内，返回空
  echo ""
}

while IFS= read -r file; do
  electron_file=$(map_to_electron "$file")
  if [ -z "$electron_file" ]; then
    continue
  fi

  if [ ! -f "$electron_file" ]; then
    echo "MISSING: $electron_file (no corresponding file for $file)"
    DIFF_FOUND=1
    continue
  fi

  if ! diff -q "$file" "$electron_file" > /dev/null 2>&1; then
    echo "OUT OF SYNC: $file <-> $electron_file"
    DIFF_FOUND=1
  fi
done <<< "$staged_files"

if [ "$DIFF_FOUND" -eq 1 ]; then
  echo ""
  echo "Platform sync check FAILED — see differences above."
  exit 1
fi

echo "Platform sync check PASSED — all files are in sync."
exit 0
