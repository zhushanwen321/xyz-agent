#!/bin/bash
# Git Hooks 安装脚本
#
# 用法: cd .githooks && ./install-hooks.sh
# 或通过 npm prepare 自动执行

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 获取项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}Git Hooks 安装脚本${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Handle both regular repo (.git dir) and worktree (.git file)
if [ -f "$PROJECT_ROOT/.git" ]; then
    GIT_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-dir)
    GIT_HOOKS_DIR="$GIT_DIR/hooks"
elif [ -d "$PROJECT_ROOT/.git" ]; then
    GIT_HOOKS_DIR="$PROJECT_ROOT/.git/hooks"
else
    echo -e "${RED}[ERROR] 未在 Git 仓库中${NC}"
    exit 1
fi

mkdir -p "$GIT_HOOKS_DIR"

# 生成 pre-commit hook
echo -e "${BLUE}[INFO] 安装 pre-commit hook...${NC}"

cat > "$GIT_HOOKS_DIR/pre-commit" << 'HOOK_EOF'
#!/bin/bash
# Git pre-commit hook: 代码质量检查
#
# 环境变量（跳过特定检查）：
#   SKIP_ALL_CHECKS=1         - 跳过所有检查
#   SKIP_FRONTEND_LINT=1      - 跳过前端 ESLint
#   SKIP_TYPE_CHECK=1         - 跳过 vue-tsc 类型检查
#   SKIP_CODE_RULES_CHECK=1   - 跳过自定义代码规范检查

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PROJECT_ROOT="$(git rev-parse --show-toplevel)"
cd "$PROJECT_ROOT"

print_section() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 一键跳过
if [ "$SKIP_ALL_CHECKS" = "1" ]; then
    echo -e "${YELLOW}[WARN] 已跳过所有检查 (SKIP_ALL_CHECKS=1)${NC}"
    exit 0
fi

# 获取变更文件
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR)
FRONTEND_FILES=$(echo "$STAGED_FILES" | grep "^src-electron/renderer/src/" || true)

# ============================================================================
# 1. 前端 ESLint 检查
# ============================================================================

if [ -n "$FRONTEND_FILES" ]; then
    print_section "[前端 ESLint 检查]"

    if [ "$SKIP_FRONTEND_LINT" != "1" ]; then
        echo -e "${BLUE}[INFO] 运行 ESLint 检查...${NC}"

        CHANGED_VUE_TS=$(echo "$FRONTEND_FILES" | grep -E "\.(vue|ts)$" || true)

        if [ -n "$CHANGED_VUE_TS" ]; then
            ESLINT_FILES=$(echo "$CHANGED_VUE_TS" | tr '\n' ' ')

            # 自动修复
            npx eslint --fix $ESLINT_FILES 2>/dev/null || true

            # 重新检查
            ESLINT_OUTPUT=$(npx eslint --max-warnings=0 $ESLINT_FILES 2>&1)
            ESLINT_EXIT_CODE=$?

            if [ $ESLINT_EXIT_CODE -ne 0 ]; then
                echo -e "${RED}[ERROR] ESLint 检查失败:${NC}"
                echo "$ESLINT_OUTPUT"
                exit 1
            fi

            # 自动添加修复后的文件
            FIXED_FILES=$(git diff --name-only --diff-filter=M | grep "^src-electron/renderer/src/" || true)
            if [ -n "$FIXED_FILES" ]; then
                echo -e "${BLUE}[INFO] ESLint 自动修复了以下文件:${NC}"
                echo "$FIXED_FILES" | sed 's/^/  - /'
                git add $FIXED_FILES
            fi

            echo -e "${GREEN}[OK] ESLint 检查通过${NC}"
        else
            echo -e "${GREEN}[OK] 无 .vue/.ts 文件变更${NC}"
        fi
    else
        echo -e "${YELLOW}[SKIP] ESLint 检查已跳过${NC}"
    fi
fi

# ============================================================================
# 2. 前端 vue-tsc 类型检查（与 CI 等价）
# ============================================================================

if [ -n "$FRONTEND_FILES" ]; then
    print_section "[前端 vue-tsc 类型检查]"

    if [ "$SKIP_TYPE_CHECK" != "1" ]; then
        CHANGED_VUE_TS=$(echo "$FRONTEND_FILES" | grep -E "\.(vue|ts)$" || true)

        if [ -n "$CHANGED_VUE_TS" ]; then
            echo -e "${BLUE}[INFO] 执行全量类型检查...${NC}"

            if ! (cd src-electron/renderer && npx vue-tsc --noEmit 2>&1); then
                echo ""
                echo -e "${RED}[ERROR] vue-tsc 类型检查失败${NC}"
                exit 1
            fi

            echo -e "${GREEN}[OK] vue-tsc 类型检查通过${NC}"
        else
            echo -e "${GREEN}[OK] 无 .vue/.ts 文件变更${NC}"
        fi
    else
        echo -e "${YELLOW}[SKIP] vue-tsc 类型检查已跳过${NC}"
    fi
fi

# ============================================================================
# 3. 自定义代码规范检查（原生 HTML 元素、Emoji、自定义 CSS）
# ============================================================================

print_section "[代码规范检查]"

RULES_CHECKER=".githooks/vue_rules_checker.py"

if [ "$SKIP_CODE_RULES_CHECK" != "1" ]; then
    STAGED_FRONTEND_FILES=$(echo "$STAGED_FILES" | grep -E "^src-electron/renderer/src/.*\.(vue|ts)$" || true)

    if [ -n "$STAGED_FRONTEND_FILES" ]; then
        echo -e "${BLUE}[INFO] 运行代码规范检查...${NC}"

        if [ ! -f "$RULES_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $RULES_CHECKER${NC}"
        else
            ABSOLUTE_FILES=""
            for FILE in $STAGED_FRONTEND_FILES; do
                ABSOLUTE_FILES="$ABSOLUTE_FILES $PROJECT_ROOT/$FILE"
            done

            python3 "$RULES_CHECKER" --batch $ABSOLUTE_FILES
            EXIT_CODE=$?

            if [ $EXIT_CODE -eq 2 ]; then
                echo ""
                echo -e "${RED}[ERROR] 代码规范检查失败${NC}"
                echo -e "${YELLOW}[INFO] 设置 SKIP_CODE_RULES_CHECK=1 跳过检查${NC}"
                exit 1
            fi
            echo -e "${GREEN}[OK] 代码规范检查通过${NC}"
        fi
    else
        echo -e "${GREEN}[OK] 无前端源码变更，跳过代码规范检查${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] 代码规范检查已跳过${NC}"
fi

# ============================================================================
# Sidecar session 隔离检查
# ============================================================================

SIDECAR_CHECKER=".githooks/check_sidecar_session.py"
SIDECAR_SERVER="src-electron/sidecar/src/server.ts"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_SIDECAR_SESSION_CHECK" != "1" ]; then
    if [ -f "$SIDECAR_SERVER" ]; then
        echo -e "${BLUE}[INFO] 运行 Sidecar session 隔离检查...${NC}"

        if [ ! -f "$SIDECAR_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $SIDECAR_CHECKER${NC}"
        else
            python3 "$SIDECAR_CHECKER" "$SIDECAR_SERVER"
            EXIT_CODE=$?

            if [ $EXIT_CODE -eq 2 ]; then
                echo ""
                echo -e "${RED}[ERROR] Sidecar session 隔离检查失败${NC}"
                echo -e "${YELLOW}[INFO] 设置 SKIP_SIDECAR_SESSION_CHECK=1 跳过检查${NC}"
                exit 1
            fi
        fi
    else
        echo -e "${GREEN}[OK] 无 sidecar server.ts，跳过 session 隔离检查${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] Sidecar session 隔离检查已跳过${NC}"
fi

# ============================================================================
# CSS tokens 检查（style.css 不含组件级样式）
# ============================================================================

CSS_CHECKER=".githooks/check_css_tokens.py"
CSS_FILE="src-electron/renderer/src/style.css"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_CSS_TOKENS_CHECK" != "1" ]; then
    if [ -f "$CSS_FILE" ]; then
        echo -e "${BLUE}[INFO] 运行 CSS tokens 检查...${NC}"

        if [ ! -f "$CSS_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $CSS_CHECKER${NC}"
        else
            python3 "$CSS_CHECKER" "$CSS_FILE"
            EXIT_CODE=$?

            if [ $EXIT_CODE -eq 2 ]; then
                echo ""
                echo -e "${RED}[ERROR] CSS tokens 检查失败${NC}"
                echo -e "${YELLOW}[INFO] 设置 SKIP_CSS_TOKENS_CHECK=1 跳过检查${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] CSS tokens 检查已跳过${NC}"
fi

# ============================================================================
# ENV_WHITELIST_PREFIXES 同步检查
# ============================================================================

ENV_WHITELIST_CHECKER=".githooks/check_env_whitelist_sync.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_ENV_WHITELIST_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 ENV_WHITELIST_PREFIXES 同步检查..."

    if [ ! -f "$ENV_WHITELIST_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $ENV_WHITELIST_CHECKER${NC}"
    else
        python3 "$ENV_WHITELIST_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] ENV_WHITELIST_PREFIXES 同步检查失败${NC}"
            echo -e "${YELLOW}[INFO] runtime-manager.ts 和 rpc-client.ts 的白名单前缀必须保持同步${NC}"
            echo -e "${YELLOW}[INFO] 设置 SKIP_ENV_WHITELIST_CHECK=1 跳过检查${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] ENV_WHITELIST_PREFIXES 同步检查已跳过${NC}"
fi

# ============================================================================
# 路径白名单动态化检查
# ============================================================================

PATH_WHITELIST_CHECKER=".githooks/check_path_whitelist.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_PATH_WHITELIST_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行路径白名单动态化检查..."

    if [ ! -f "$PATH_WHITELIST_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $PATH_WHITELIST_CHECKER${NC}"
    else
        python3 "$PATH_WHITELIST_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] 路径白名单动态化检查失败${NC}"
            echo -e "${YELLOW}[INFO] 路径白名单必须使用 getConfigDir()/getPiAgentDir() 动态生成${NC}"
            echo -e "${YELLOW}[INFO] 设置 SKIP_PATH_WHITELIST_CHECK=1 跳过检查${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] 路径白名单动态化检查已跳过${NC}"
fi

# ============================================================================
# Runtime Bundle 验证（runtime 源码有变更时触发）
# ============================================================================

RUNTIME_BUNDLE_CHECKER="scripts/validate-runtime-bundle.sh"
RUNTIME_SRC="src-electron/runtime/src"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_RUNTIME_BUNDLE_CHECK" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^$RUNTIME_SRC/"; then
        print_section "[Runtime Bundle 验证]"
        echo -e "${BLUE}[INFO] runtime 源码有变更，运行 Bundle 验证...${NC}"

        if [ ! -f "$RUNTIME_BUNDLE_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到验证脚本: $RUNTIME_BUNDLE_CHECKER${NC}"
            exit 1
        fi

        bash "$RUNTIME_BUNDLE_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] Runtime Bundle 验证失败${NC}"
            echo -e "${YELLOW}[INFO] 设置 SKIP_RUNTIME_BUNDLE_CHECK=1 跳过检查${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] runtime 源码无变更，跳过 Bundle 验证${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] Runtime Bundle 验证已跳过${NC}"
fi

# ============================================================================
# 打包配置预检查（electron-builder.yml / tsup.config.ts / resources/pi 有变更时触发）
# ============================================================================

PREFLIGHT_CHECKER="scripts/preflight-check.sh"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_PREFLIGHT_CHECK" != "1" ]; then
    if echo "$STAGED_FILES" | grep -qE "^src-electron/electron-builder\.yml$|^src-electron/runtime/tsup\.config\.ts$|^resources/pi/"; then
        print_section "[打包配置预检查]"
        echo -e "${BLUE}[INFO] 打包配置有变更，运行 preflight 检查...${NC}"

        if [ ! -f "$PREFLIGHT_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到验证脚本: $PREFLIGHT_CHECKER${NC}"
            exit 1
        fi

        bash "$PREFLIGHT_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] 打包配置预检查失败${NC}"
            echo -e "${YELLOW}[INFO] 设置 SKIP_PREFLIGHT_CHECK=1 跳过检查${NC}"
            exit 1
        fi

        # electron-builder.yml 或 tsup.config.ts 变更时，额外运行 runtime bundle 验证
        # 包含 CJS smoke test（第 6 步），能拦截 files/asarUnpack 不一致等打包配置错误
        if echo "$STAGED_FILES" | grep -qE '^src-electron/electron-builder\.yml$|^src-electron/runtime/tsup\.config\.ts$'; then
            echo -e "${BLUE}[INFO] 打包配置变更，额外运行 runtime bundle 验证（含 smoke test）...${NC}"
            bash "$RUNTIME_BUNDLE_CHECKER"
            if [ $? -ne 0 ]; then
                echo -e "${RED}[ERROR] Runtime bundle 验证失败（可能需要重新 build）${NC}"
                echo -e "${YELLOW}[FIX] cd src-electron/runtime && npm run build，然后重新 commit${NC}"
                exit 1
            fi
        fi
    else
        echo -e "${GREEN}[OK] 打包配置无变更，跳过 preflight 检查${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] 打包配置预检查已跳过${NC}"
fi

# ============================================================================
# 目录规范检查（禁止 demos/impeccable 目录 + 禁止外部 symlink）
# ============================================================================

DIRECTORY_RULES_CHECKER=".githooks/check_directory_rules.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_DIRECTORY_RULES_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行目录规范检查..."

    if [ ! -f "$DIRECTORY_RULES_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $DIRECTORY_RULES_CHECKER${NC}"
    else
        python3 "$DIRECTORY_RULES_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] 目录规范检查失败${NC}"
            echo -e "${YELLOW}[INFO] 设置 SKIP_DIRECTORY_RULES_CHECK=1 跳过检查${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] 目录规范检查已跳过${NC}"
fi

# ============================================================================
# 全部通过
# ============================================================================

print_section "[所有检查通过]"

echo -e "${GREEN}代码质量检查全部通过！${NC}"
echo ""
echo -e "${CYAN}提示: 跳过检查的环境变量:${NC}"
echo -e "  ${YELLOW}SKIP_ALL_CHECKS=1${NC}          - 跳过所有"
echo -e "  ${YELLOW}SKIP_FRONTEND_LINT=1${NC}      - 跳过 ESLint"
echo -e "  ${YELLOW}SKIP_TYPE_CHECK=1${NC}          - 跳过 vue-tsc"
echo -e "  ${YELLOW}SKIP_CODE_RULES_CHECK=1${NC}   - 跳过代码规范"
echo -e "  ${YELLOW}SKIP_SIDECAR_SESSION_CHECK=1${NC} - 跳过 session 隔离"
echo -e "  ${YELLOW}SKIP_CSS_TOKENS_CHECK=1${NC}      - 跳过 CSS tokens"
echo -e "  ${YELLOW}SKIP_RUNTIME_BUNDLE_CHECK=1${NC}  - 跳过 runtime bundle 验证"
echo -e "  ${YELLOW}SKIP_PREFLIGHT_CHECK=1${NC}       - 跳过打包配置预检查"
echo -e "  ${YELLOW}SKIP_ENV_WHITELIST_CHECK=1${NC}   - 跳过 ENV 白名单同步检查"
echo -e "  ${YELLOW}SKIP_PATH_WHITELIST_CHECK=1${NC}   - 跳过路径白名单动态化检查"
echo ""

exit 0
HOOK_EOF

chmod +x "$GIT_HOOKS_DIR/pre-commit"

echo -e "${GREEN}[OK] pre-commit hook 安装完成${NC}"
echo ""

if [ -x "$GIT_HOOKS_DIR/pre-commit" ]; then
    echo -e "${GREEN}[OK] Hook 已正确设置可执行权限${NC}"
fi

echo ""
echo -e "${BLUE}======================================${NC}"
echo -e "${GREEN}[安装完成]${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""
echo -e "${CYAN}已安装的检查项目:${NC}"
echo -e "  ${GREEN}[+]${NC} 前端 ESLint 代码检查"
echo -e "  ${GREEN}[+]${NC} vue-tsc 类型检查（全量，与 CI 等价）"
echo -e "  ${GREEN}[+]${NC} Vue 组件规范检查（禁止原生 HTML、Emoji、自定义 CSS）"
echo -e "  ${GREEN}[+]${NC} Sidecar session 隔离检查"
echo -e "  ${GREEN}[+]${NC} CSS tokens 检查"
echo -e "  ${GREEN}[+]${NC} ENV_WHITELIST_PREFIXES 同步检查"
echo -e "  ${GREEN}[+]${NC} 路径白名单动态化检查"
echo -e "  ${GREEN}[+]${NC} 目录规范检查（禁止 demos/impeccable + 外部 symlink）"
echo -e "  ${GREEN}[+]${NC} Runtime Bundle 验证（依赖打包 + CJS 兼容 + 健康检查）"
echo -e "  ${GREEN}[+]${NC} 打包配置预检查（asarUnpack/files 一致性 + symlink 检查）"
echo ""
echo -e "${CYAN}Hook 脚本位置:${NC} .githooks/"
echo ""