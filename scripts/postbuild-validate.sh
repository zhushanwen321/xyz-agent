#!/bin/bash
# scripts/postbuild-validate.sh — 打包后产物验证
#
# 检查项：
# 1. 产物存在性（dmg/zip/exe/AppImage）
# 2. macOS app 结构（Info.plist, main executable, asar, unpacked）
# 3. asar 内容正确性
# 4. 产物大小合理性
#
# 用法: ./scripts/postbuild-validate.sh [--ci]

set -euo pipefail

# 检查失败原则：任何非 0 退出都输出（不管从哪个 exit 点）
trap '[ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。" >&2' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CI_MODE=false
if [ "${1:-}" = "--ci" ]; then
    CI_MODE=true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Postbuild Validation]${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

OUTPUT_DIR="$PROJECT_ROOT/apps/electron/dist/builder-output"
FAILED=0

# ── 1. 产物存在性 ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[1/5] Build artifacts...${NC}"

ARTIFACT_COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 \( -name "*.dmg" -o -name "*.zip" -o -name "*.exe" -o -name "*.AppImage" -o -name "*.deb" \) | wc -l | tr -d ' ')
if [ "$ARTIFACT_COUNT" -eq 0 ]; then
    echo -e "  ${RED}✗ 未找到任何构建产物${NC}"
    FAILED=1
else
    echo -e "  ${GREEN}✓ 找到 $ARTIFACT_COUNT 个产物${NC}"
fi

# ── 2. macOS app 结构 ──────────────────────────────────────────────
if [ -d "$OUTPUT_DIR/mac-arm64" ]; then
    echo ""
    echo -e "${BLUE}[2/5] macOS app structure...${NC}"

    APP_PATH=$(find "$OUTPUT_DIR/mac-arm64" -name "*.app" -maxdepth 1 | head -1)

    if [ -n "$APP_PATH" ] && [ -d "$APP_PATH" ]; then
        # Info.plist
        if [ -f "$APP_PATH/Contents/Info.plist" ]; then
            echo -e "  ${GREEN}✓${NC} Info.plist"
        else
            echo -e "  ${RED}✗${NC} Info.plist 缺失"
            FAILED=1
        fi

        # main executable
        MAIN_EXE=$(find "$APP_PATH/Contents/MacOS" -type f -maxdepth 1 | head -1)
        if [ -n "$MAIN_EXE" ]; then
            echo -e "  ${GREEN}✓${NC} Main: $(basename "$MAIN_EXE")"
        else
            echo -e "  ${RED}✗${NC} 无 main executable"
            FAILED=1
        fi

        # asar
        if [ -f "$APP_PATH/Contents/Resources/app.asar" ]; then
            echo -e "  ${GREEN}✓${NC} app.asar"

            # 检查关键文件在 asar 内
            if npx asar list "$APP_PATH/Contents/Resources/app.asar" 2>/dev/null | grep -q "dist/main/main.cjs"; then
                echo -e "  ${GREEN}✓${NC} dist/main/main.cjs in asar"
            else
                echo -e "  ${RED}✗${NC} dist/main/main.cjs NOT in asar"
                FAILED=1
            fi

            if npx asar list "$APP_PATH/Contents/Resources/app.asar" 2>/dev/null | grep -q "dist/preload/preload.cjs"; then
                echo -e "  ${GREEN}✓${NC} dist/preload/preload.cjs in asar"
            else
                echo -e "  ${RED}✗${NC} dist/preload/preload.cjs NOT in asar"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} app.asar 缺失"
            FAILED=1
        fi

        # asar.unpacked
        if [ -d "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime" ]; then
            echo -e "  ${GREEN}✓${NC} runtime in app.asar.unpacked"
            RUNTIME_SIZE=$(du -sm "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime" | cut -f1)
            echo -e "  ℹ  Runtime size: ${RUNTIME_SIZE}MB"

            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/index.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/index.cjs 缺失"
                FAILED=1
            fi

            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/plugin-bootstrap.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/plugin-bootstrap.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/plugin-bootstrap.cjs 缺失"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} app.asar.unpacked/dist/runtime 缺失"
            FAILED=1
        fi

        # extraResources (pi binary)
        if [ -d "$APP_PATH/Contents/Resources/pi" ]; then
            echo -e "  ${GREEN}✓${NC} pi binary in Resources"

            # 致命：pi 目录中不能有指向外部绝对路径的 symlink
            PI_SYMLINK=$(find "$APP_PATH/Contents/Resources/pi" -maxdepth 1 -type l 2>/dev/null | head -1)
            if [ -n "$PI_SYMLINK" ]; then
                echo -e "  ${RED}✗${NC} Resources/pi 存在 symlink: $(basename "$PI_SYMLINK")"
                FAILED=1
            else
                echo -e "  ${GREEN}✓${NC} Resources/pi 无 symlink"
            fi
        fi

        # extraResources: xyz-agent-extension.js（/xyz-navigate 命令的 pi extension）
        # electron-builder from 路径写错时会静默丢弃（只警告不失败），故在此显式校验。
        # 历史：pnpm workspace 迁移后 projectDir=apps/electron/，from: ../ 解析到 apps/
        # 而非仓库根，导致文件未进产物。
        if [ -f "$APP_PATH/Contents/Resources/xyz-agent-extension.js" ]; then
            echo -e "  ${GREEN}✓${NC} xyz-agent-extension.js in Resources"
        else
            echo -e "  ${RED}✗${NC} xyz-agent-extension.js 缺失（检查 electron-builder.yml from 路径）"
            FAILED=1
        fi
        # extraResources: xyz-system-prompt-extension.js（before_agent_start hook 扩展）
        # 与 xyz-agent-extension.js 同模式校验（规则 #12 打包验证）。
        if [ -f "$APP_PATH/Contents/Resources/xyz-system-prompt-extension.js" ]; then
            echo -e "  ${GREEN}✓${NC} xyz-system-prompt-extension.js in Resources"
        else
            echo -e "  ${RED}✗${NC} xyz-system-prompt-extension.js 缺失（检查 electron-builder.yml from 路径）"
            FAILED=1
        fi
        # extraResources: bin/xyz-settings CLI（tsup 打包的 cli.cjs，pi Skill 引用）
        # 与两个 extension.js 同模式校验（electron-builder from 错误只警告不失败）。
        if [ -f "$APP_PATH/Contents/Resources/bin/xyz-settings" ]; then
            echo -e "  ${GREEN}✓${NC} bin/xyz-settings in Resources"
        else
            echo -e "  ${RED}✗${NC} bin/xyz-settings 缺失（检查 electron-builder.yml from 路径 dist/runtime/cli.cjs）"
            FAILED=1
        fi
    else
        echo -e "  ${YELLOW}⚠ 未找到 .app 目录${NC}"
    fi
else
    echo ""
    echo -e "${YELLOW}[2/5] macOS 结构跳过（非 macOS 构建）${NC}"
fi

# ── 3. 产物大小合理性 ───────────────────────────────────────────────
echo ""
echo -e "${BLUE}[3/5] Artifact sizes...${NC}"

for f in "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.zip "$OUTPUT_DIR"/*.exe "$OUTPUT_DIR"/*.AppImage; do
    if [ -f "$f" ]; then
        SIZE_MB=$(du -m "$f" | cut -f1)
        echo -e "  ℹ  $(basename "$f"): ${SIZE_MB}MB"

        if [[ "$f" == *.dmg ]] && [ "$SIZE_MB" -gt 800 ]; then
            echo -e "  ${YELLOW}⚠ DMG 超过 800MB，检查是否有多余文件${NC}"
        fi
    fi
done

# ── 4. Smoke test ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[4/5] Smoke test (optional)...${NC}"

if [ "$(uname)" = "Darwin" ]; then
    APP_BUNDLE=$(find "$OUTPUT_DIR/mac-arm64" -name "*.app" -maxdepth 1 2>/dev/null | head -1)
    if [ -n "$APP_BUNDLE" ]; then
        echo -e "  ${YELLOW}⚠ Smoke test 需要手动执行：open -a \"$APP_BUNDLE\"${NC}"
    fi
fi

# ── 5. 代码签名状态 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[5/5] Code signature...${NC}"

if [ "$(uname)" = "Darwin" ] && [ -n "${APP_BUNDLE:-}" ]; then
    if command -v codesign &>/dev/null; then
        if codesign --verify --verbose=0 "$APP_BUNDLE" 2>&1; then
            echo -e "  ${GREEN}✓ 代码签名有效${NC}"
        else
            echo -e "  ${YELLOW}⚠ 未签名（本地开发正常，分发需签名）${NC}"
        fi
    else
        echo -e "  ${YELLOW}⚠ codesign 不可用${NC}"
    fi
fi

# ── 结果 ───────────────────────────────────────────────────────────
echo ""
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}[OK] Postbuild 验证全部通过${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
else
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}[FAIL] Postbuild 验证有失败项${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi