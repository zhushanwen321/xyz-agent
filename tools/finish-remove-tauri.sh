#!/bin/bash
# 完成移除 Tauri 后的收尾工作
# 在项目根目录执行: bash tools/finish-remove-tauri.sh

set -e
cd "$(dirname "$0")/.."

echo "=== 清理 node_modules ==="
rm -rf node_modules package-lock.json

echo "=== 重新安装依赖 ==="
npm install

echo "=== 提交所有改动 ==="
git add -A
git status --short

echo ""
echo "=== 上述文件将被提交。按 Ctrl+C 取消，按 Enter 继续 ==="
read
git commit -m "refactor: remove Tauri, keep Electron only

- Remove src-tauri/ (Rust backend)
- Remove src/ (Tauri frontend, used @tauri-apps/api)
- Remove sidecar/ and shared/ (duplicated in src-electron/)
- src-electron/ is now the sole codebase
- Update package.json workspaces and scripts
- Update CLAUDE.md and docs/standards.md
- Update pre-commit hook paths
- Remove check-platform-sync.sh (no longer needed)"

echo "=== 完成 ==="
