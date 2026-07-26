#!/bin/bash
# scripts/sign-mac-adhoc.sh — 对 mac .app 做 ad-hoc 签名
#
# ad-hoc 签名（codesign --sign -）降低 macOS Sequoia 的「无法验证开发者」弹窗概率，
# 不是真正的 Apple Developer 签名（无 Developer ID 证书 + notarization）。
# best-effort：任何失败都 exit 0 不阻塞 build，仅打印 WARNING。
#
# 用法: ./scripts/sign-mac-adhoc.sh [app-path]
#   app-path 留空则自动在 apps/electron/dist/builder-output 下查找第一个 .app

# 注意：不用 set -e（best-effort 要容忍 codesign 失败）
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

APP_PATH="${1:-}"
if [[ -z "$APP_PATH" ]]; then
  # 自动查找 builder-output 下的 .app
  APP_PATH=$(find apps/electron/dist/builder-output -maxdepth 2 -name "*.app" -type d 2>/dev/null | head -1 || true)
fi

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "[sign-mac-adhoc] No .app found, skipping" >&2
  exit 0
fi

echo "[sign-mac-adhoc] Signing $APP_PATH (ad-hoc)..."
# 不用 --deep：codesign --deep 自 macOS 13 起弃用（且对 ad-hoc 签名无实际增益）。
# 对 .app 顶层签名通常足够：electron-builder 在 build 时已对 helper 进程（Renderer GPU Helper 等）
# 单独签名，本脚本只是 best-effort 给顶层 .app 加 ad-hoc 签名降低「无法验证开发者」弹窗概率，
# 不需要递归重签内部已签名的 helper（重签反而可能破坏其签名结构）。本场景 hack 方案风险低。
if codesign --force --sign - "$APP_PATH" 2>&1; then
  echo "[sign-mac-adhoc] OK, verifying..."
  codesign -dv --verbose=0 "$APP_PATH" 2>&1 || true
else
  echo "[sign-mac-adhoc] WARNING: codesign failed (best-effort, not blocking)" >&2
  exit 0  # 不阻塞
fi
