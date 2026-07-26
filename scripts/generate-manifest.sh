#!/bin/bash
# scripts/generate-manifest.sh — 生成 sha256 + size 清单（manifest.json）
#
# 遍历 builder-output 目录的产物，计算 sha256 + size，组装 manifest.json。
# 供 app 内自动升级做完整性校验，以及 release 页面透明展示文件指纹。
#
# 用法: ./scripts/generate-manifest.sh [builder-output-dir]
#   builder-output-dir 默认 apps/electron/dist/builder-output

set -euo pipefail

# 检查失败原则：任何非 0 退出都输出（不管从哪个 exit 点）
trap '[ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。" >&2' EXIT

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# 接受 builder-output 目录参数，默认 apps/electron/dist/builder-output
BUILDER_DIR="${1:-apps/electron/dist/builder-output}"

if [ ! -d "$BUILDER_DIR" ]; then
  echo "[generate-manifest] ERROR: builder-output 目录不存在: $BUILDER_DIR" >&2
  exit 1
fi

# version 从 apps/electron/package.json 读
VERSION=$(node -p "require('./apps/electron/package.json').version")
RELEASED_AT=$(date -u +%FT%TZ)

# 用 node 生成 JSON（shell 拼 JSON 易错）
node -e '
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const dir = process.argv[1];
const version = process.argv[2];
const releasedAt = process.argv[3];
const assets = {};
for (const file of fs.readdirSync(dir)) {
  const fullPath = path.join(dir, file);
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) continue;
  if (file === "manifest.json") continue;  // 排除自身
  // 只对实际产物算（.dmg/.zip/.exe/.AppImage/.deb）
  if (!/\.(dmg|zip|exe|AppImage|deb)$/.test(file)) continue;
  const buf = fs.readFileSync(fullPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  assets[file] = { sha256, size: stat.size };
}
const manifest = { version, releasedAt, assets };
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("[generate-manifest] Generated manifest.json with", Object.keys(assets).length, "assets");
' "$BUILDER_DIR" "$VERSION" "$RELEASED_AT"
