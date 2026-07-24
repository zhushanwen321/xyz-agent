#!/bin/bash
# fix-node-pty-permissions.sh
#
# 修复 node-pty 1.1.0 上游打包 bug：prebuild tarball 内 spawn-helper 丢了 +x 权限位
# （npm registry 的 node-pty-1.1.0.tgz 里 prebuilds/*/spawn-helper 是 644，应为 755）。
# 现象：runtime 调 pty.spawn 时报 "posix_spawnp failed"（node-pty fork 需 exec helper）。
#
# 触发：pnpm install 后自动执行（根 package.json postinstall）。
# 幂等：找不到文件或已是 755 都不报错。
#
# 上游 issue：https://github.com/nicknisi/node-pty （1.1.0 prebuild 权限）
# 本地复现：tar -tvf <node-pty tarball> | grep spawn-helper  → -rw-r--r--

set -euo pipefail

# 定位 node-pty prebuilds（pnpm hoist 到根 node_modules，跨平台 glob）
NODE_PTY_DIR=""

# 优先 pnpm 结构（.pnpm/ 下），fallback 顶层 node_modules
for candidate in \
  node_modules/node-pty \
  node_modules/.pnpm/node-pty@*/node_modules/node-pty; do
  if [ -d "$candidate/prebuilds" ]; then
    NODE_PTY_DIR="$candidate"
    break
  fi
done

if [ -z "$NODE_PTY_DIR" ]; then
  # node-pty 未安装（如纯 renderer 开发），静默退出
  exit 0
fi

# 给所有平台的 spawn-helper 加 +x（unix 平台需要；win 的不在此 glob）
FIXED=0
while IFS= read -r -d '' helper; do
  if [ ! -x "$helper" ]; then
    chmod +x "$helper"
    FIXED=$((FIXED + 1))
  fi
done < <(find "$NODE_PTY_DIR/prebuilds" -name spawn-helper -print0 2>/dev/null || true)

if [ "$FIXED" -gt 0 ]; then
  echo "[fix-node-pty] chmod +x $FIXED spawn-helper binary(ies) (upstream 1.1.0 tarball permission bug)"
fi
