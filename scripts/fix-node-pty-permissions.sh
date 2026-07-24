#!/bin/bash
# fix-node-pty-permissions.sh
#
# 修复 node-pty 1.1.0 上游打包 bug（两个独立 bug，都在此脚本处理）：
#
# Bug 1 — spawn-helper 丢 +x 权限位
#   prebuild tarball 内 spawn-helper 是 644（应为 755）。
#   现象：runtime 调 pty.spawn 时报 "posix_spawnp failed"（node-pty fork 需 exec helper）。
#   本地复现：tar -tvf <node-pty tarball> | grep spawn-helper  → -rw-r--r--
#
# Bug 2 — helperPath 二次 asar 替换 [HISTORICAL]
#   node-pty lib/unixTerminal.js 计算 helperPath 时无条件做
#     helperPath.replace('app.asar', 'app.asar.unpacked')
#   设计假设：node-pty JS 在 app.asar 内、helper 在 app.asar.unpacked 内。
#   但本项目 electron-builder.yml 的 asarUnpack 把整个 node-pty 都 unpack
#   （含 JS），打包后 __dirname 已含 app.asar.unpacked，replace 二次污染
#   → app.asar.unpacked.unpacked/.../spawn-helper（不存在）
#   → posix_spawn ENOENT → 抛笼统 "posix_spawnp failed."（node-pty 吞了 errno）。
#   上游 issue/PR：https://github.com/microsoft/node-pty/issues/923
#                  https://github.com/microsoft/node-pty/pull/924 （至今未合并）
#   修复 = 等价 PR #924：replace 前加 guard，已含 .unpacked 则跳过。
#
# 触发：pnpm install 后自动执行（根 package.json postinstall）。
# 幂等：找不到文件 / 已是 755 / 已是 patched 形态，都不报错。

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

# ── Bug 2: patch helperPath 二次 asar 替换 guard（等价上游 PR #924）─────────
# 目标文件：lib/unixTerminal.js。node-pty 升级若改了文件结构，匹配失败只 warn 不 fail。
UNIX_TERMINAL="$NODE_PTY_DIR/lib/unixTerminal.js"

if [ ! -f "$UNIX_TERMINAL" ]; then
  echo "[fix-node-pty] WARN: $UNIX_TERMINAL not found, skip helperPath patch"
  exit 0
fi

# 幂等检测：已 patch 则跳过。patched 形态的特征行是 `if (helperPath.indexOf('app.asar.unpacked')`
if grep -q "helperPath.indexOf('app.asar.unpacked')" "$UNIX_TERMINAL"; then
  : # 已 patch，静默跳过
else
  # 原始两行（精确匹配，无前导空格——顶层语句）：
  #   helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
  #   helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');
  # 用 perl 替换（sed 在 macOS BSD 下多行替换转义繁琐，perl 跨平台一致）。
  # 替换为带 guard 的形态（每个 replace 包一层 indexOf 检查）。
  PATCHED=$(perl -0777 -i -pe '
    s{helperPath = helperPath\.replace\('"'"'app\.asar'"'"', '"'"'app\.asar\.unpacked'"'"'\);}
     {if (helperPath.indexOf('"'"'app.asar.unpacked'"'"') === -1) { helperPath = helperPath.replace('"'"'app.asar'"'"', '"'"'app.asar.unpacked'"'"'); }}sg;
    s{helperPath = helperPath\.replace\('"'"'node_modules\.asar'"'"', '"'"'node_modules\.asar\.unpacked'"'"'\);}
     {if (helperPath.indexOf('"'"'node_modules.asar.unpacked'"'"') === -1) { helperPath = helperPath.replace('"'"'node_modules.asar'"'"', '"'"'node_modules.asar.unpacked'"'"'); }}sg;
  ' "$UNIX_TERMINAL")

  # 验证 patch 生效：grep 到 guard 特征行 = 成功
  if grep -q "helperPath.indexOf('app.asar.unpacked')" "$UNIX_TERMINAL"; then
    echo "[fix-node-pty] patched helperPath double-replace guard (upstream #923/#924)"
  else
    # 匹配失败：node-pty 可能升级改了行格式。只 warn 不 fail（postinstall 不应阻断 install）。
    echo "[fix-node-pty] WARN: helperPath patch did not apply — unixTerminal.js format may have changed (node-pty upgraded?)"
  fi
fi
