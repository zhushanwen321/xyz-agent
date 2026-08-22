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
# [HISTORICAL] bare repo + worktree 模式下，git 读 hook 从 commondir（即 .bare/）的 hooks，
# 不是 per-worktree 的 git-dir。曾用 --git-dir 导致 hook 写到 worktree 局部目录，git 根本不读，
# 整个项目的 pre-commit 静默失效（2026-06-20 v3 重建审查发现）。改用 --git-common-dir。
if [ -f "$PROJECT_ROOT/.git" ]; then
    # worktree 模式（.git 是文件）→ 用 commondir（bare repo 根），所有 worktree 共享 hook
    GIT_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir)
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
# 原则：无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。
# SKIP_* 环境变量仅为经明确批准的紧急逃生口，不应作为常规手段。

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
FRONTEND_FILES=$(echo "$STAGED_FILES" | grep "^packages/renderer/src/" || true)
EXTENSION_FILES=$(echo "$STAGED_FILES" | grep -E "^extensions/.*\.ts$" | grep -vE "__tests__|\.test\.|/workflows/|/examples/|\.d\.ts$" || true)

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
            ESLINT_OUTPUT=$(npx eslint --max-warnings=0 --no-warn-ignored $ESLINT_FILES 2>&1)
            ESLINT_EXIT_CODE=$?

            if [ $ESLINT_EXIT_CODE -ne 0 ]; then
                echo -e "${RED}[ERROR] ESLint 检查失败:${NC}"
                echo "$ESLINT_OUTPUT"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi

            # 自动添加修复后的文件
            FIXED_FILES=$(git diff --cached --name-only --diff-filter=M | grep "^packages/renderer/src/" || true)
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

            if ! (cd packages/renderer && npx vue-tsc --noEmit 2>&1); then
                echo ""
                echo -e "${RED}[ERROR] vue-tsc 类型检查失败${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
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
# 2b. pi extensions ESLint + tsc 类型检查
#    extensions 是无构建的 TS 源码（pi 运行时加载），用 extensions/tsconfig.json
#    + eslint.config.mjs 的 extensions/ override 块检查。
#    ESLint 只拦 error（--quiet），warning 是迁入时已有的技术债标记（no-magic-numbers
#    等，源项目基线即 warn），不阻断提交。
# ============================================================================

if [ -n "$EXTENSION_FILES" ]; then
    print_section "[pi extensions ESLint + 类型检查]"

    if [ "$SKIP_EXTENSION_LINT" != "1" ]; then
        ESLINT_EXT_FILES=$(echo "$EXTENSION_FILES" | tr '\n' ' ')
        echo -e "${BLUE}[INFO] 运行 ESLint 检查（仅拦 error）...${NC}"
        ESLINT_EXT_OUTPUT=$(npx eslint --quiet --no-warn-ignored $ESLINT_EXT_FILES 2>&1)
        ESLINT_EXT_EXIT=$?
        if [ $ESLINT_EXT_EXIT -ne 0 ]; then
            echo -e "${RED}[ERROR] extensions ESLint 检查失败:${NC}"
            echo "$ESLINT_EXT_OUTPUT"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] extensions ESLint 检查通过（warning 为技术债标记，不阻断）${NC}"

        echo -e "${BLUE}[INFO] 运行 tsc 类型检查（extensions 全量）...${NC}"
        if ! (cd extensions && npx tsc --noEmit 2>&1); then
            echo ""
            echo -e "${RED}[ERROR] extensions tsc 类型检查失败${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] extensions tsc 类型检查通过${NC}"
    else
        echo -e "${YELLOW}[SKIP] extensions 检查已跳过${NC}"
    fi
fi

# ============================================================================
# 2c. pi extensions manifest & convention 检查
#    迁自 xyz-pi-extensions 仓库的 pre-commit，针对已迁移的 extensions/ 包：
#      (1) 禁止废弃 namespace @mariozechner/pi-*（Pi SDK 已重命名为 @earendil-works/pi-*）
#      (2) 禁止 extensions 代码用 console.log/info（会泄漏到 TUI，见 standards.md §10）
#      (3) pi manifest + package.json 深度检查（保 pi.extensions/type/keyword/
#          peerDependencies/包名/files 字段完整）
#    仅在 staged extensions/ 文件变更时触发，与 2b 共用 SKIP_EXTENSION_LINT 跳过开关。
# ============================================================================

# [HISTORICAL] 原一层模式 ^extensions/[^/]+/package\.json$ 在 2026-08-22 目录分组
# （taiji/universal）后恒空匹配——纯 package.json 变更（版本 bump / pi manifest / role
# 字段）静默跳过本段检查。改为结构无关的两段式：任意分组两段深 + 排除 shared/
# （共享库无 pi manifest，通配两层会误报）——新增分组时本模式零维护，不再依赖
# 与目录结构同步的组名清单（清单式写法正是当年恒空匹配 bug 的形态）。
EXTENSION_PKG_FILES=$(echo "$STAGED_FILES" | grep -E "^extensions/[^/]+/[^/]+/package\.json$" | grep -v "^extensions/shared/" || true)

if [ -n "$EXTENSION_FILES" ] || [ -n "$EXTENSION_PKG_FILES" ]; then
    print_section "[pi extensions manifest & convention 检查]"

    if [ "$SKIP_EXTENSION_LINT" != "1" ]; then

        # ── (1) 废弃 namespace 检查：staged extensions .ts + package.json ──
        echo -e "${BLUE}[INFO] 检查废弃 namespace @mariozechner/pi-*...${NC}"
        NS_SCAN_TARGETS=""
        for f in $EXTENSION_FILES $EXTENSION_PKG_FILES; do
            NS_SCAN_TARGETS="$NS_SCAN_TARGETS $f"
        done
        NS_HITS=""
        for f in $NS_SCAN_TARGETS; do
            [ -z "$f" ] && continue
            [ -f "$f" ] || continue
            hit=$(grep -nE '@mariozechner/pi-' "$f" 2>/dev/null || true)
            if [ -n "$hit" ]; then
                while IFS= read -r line; do
                    NS_HITS="${NS_HITS}  ${f}:${line}\n"
                done <<< "$hit"
            fi
        done
        if [ -n "$NS_HITS" ]; then
            echo -e "${RED}[ERROR] 发现废弃 namespace @mariozechner/pi-*（应改用 @earendil-works/pi-*）:${NC}"
            echo -e "$NS_HITS"
            echo -e "${YELLOW}[FIX] find extensions -type f \\( -name '*.ts' -o -name '*.json' \\) -exec sed -i '' 's|@mariozechner/pi-|@earendil-works/pi-|g' {} +${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] namespace 检查通过（无 @mariozechner/pi-* 引用）${NC}"

        # ── (2) console.log/info 禁止检查（extensions/**/*.ts，排除 .d.ts/test）──
        echo -e "${BLUE}[INFO] 检查 extensions 代码 console.log/info...${NC}"
        CONSOLE_VIOLATIONS=""
        for f in $EXTENSION_FILES; do
            [ -z "$f" ] && continue
            [ -f "$f" ] || continue
            hits=$(grep -nE 'console\.(log|info)\(' "$f" 2>/dev/null || true)
            if [ -n "$hits" ]; then
                while IFS= read -r line; do
                    CONSOLE_VIOLATIONS="${CONSOLE_VIOLATIONS}  ${f}:${line}\n"
                done <<< "$hits"
            fi
        done
        if [ -n "$CONSOLE_VIOLATIONS" ]; then
            echo -e "${RED}[ERROR] extensions 中禁止使用 console.log/info（会泄漏到 TUI）:${NC}"
            echo -e "$CONSOLE_VIOLATIONS"
            echo -e "${YELLOW}[FIX] 用户可见消息 → ctx.ui.notify；内部诊断 → console.warn/error('[ext] ...')；不可恢复错误 → throw${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] console.log/info 检查通过${NC}"

        # ── (3) pi manifest + package.json 深度检查（仅 staged extensions/*/package.json）──
        if [ -n "$EXTENSION_PKG_FILES" ]; then
            echo -e "${BLUE}[INFO] 检查 pi manifest + package.json 字段完整性...${NC}"
            MANIFEST_FAIL=0
            while IFS= read -r pkg_json; do
                [ -z "$pkg_json" ] && continue
                [ -f "$pkg_json" ] || continue
                pkg_dir=$(dirname "$pkg_json")
                pkg_name_short=$(basename "$pkg_dir")

                # 跳过 private 包
                is_private=$(python3 -c "import json; print(json.load(open('$pkg_json')).get('private', False))" 2>/dev/null || echo "False")
                [ "$is_private" = "True" ] && continue

                # 检查 pi.extensions 字段（值须为 ["./index.ts"]，入口文件须存在）
                pi_result=$(python3 -c "
import json, os
d=json.load(open('$pkg_json'))
exts=d.get('pi',{}).get('extensions',[])
if exts != ['./index.ts']:
    print('BAD_VALUE:' + repr(exts)); exit(0)
entry=os.path.join('$pkg_dir', 'index.ts')
if not os.path.isfile(entry):
    print('MISSING_ENTRY:./index.ts'); exit(0)
print('OK')
" 2>/dev/null || echo "PARSE_ERROR")
                case "$pi_result" in
                    OK) ;;
                    BAD_VALUE:*)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: pi.extensions 值非 [\"./index.ts\"]（${pi_result#BAD_VALUE:}）"
                        MANIFEST_FAIL=1 ;;
                    MISSING_ENTRY:*)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: pi.extensions 入口 ./index.ts 不存在"
                        MANIFEST_FAIL=1 ;;
                    *)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: package.json 解析失败或缺少 pi.extensions"
                        echo -e "         ${YELLOW}修复：添加 \"pi\": { \"extensions\": [\"./index.ts\"] }${NC}"
                        MANIFEST_FAIL=1 ;;
                esac

                # 检查 type: module
                has_type_module=$(python3 -c "import json; print(json.load(open('$pkg_json')).get('type') == 'module')" 2>/dev/null || echo "False")
                [ "$has_type_module" != "True" ] && {
                    echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: 缺少 \"type\": \"module\""
                    MANIFEST_FAIL=1
                }

                # 检查 pi-package keyword
                has_kw=$(python3 -c "import json; print('pi-package' in json.load(open('$pkg_json')).get('keywords',[]))" 2>/dev/null || echo "False")
                [ "$has_kw" != "True" ] && {
                    echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: keywords 缺少 \"pi-package\""
                    MANIFEST_FAIL=1
                }

                # 检查包名格式 @zhushanwen/pi-*
                pkg_name=$(python3 -c "import json; print(json.load(open('$pkg_json')).get('name',''))" 2>/dev/null || echo "")
                case "$pkg_name" in
                    @zhushanwen/pi-*) ;;
                    *)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: 包名 '$pkg_name' 不符合 @zhushanwen/pi-* 格式"
                        MANIFEST_FAIL=1 ;;
                esac

                # 检查 peerDependencies 含 @earendil-works/pi-coding-agent（且不含旧 namespace）
                peer_result=$(python3 -c "
import json
d=json.load(open('$pkg_json'))
peers=d.get('peerDependencies',{})
if '@mariozechner/pi-coding-agent' in peers:
    print('LEGACY')
elif '@earendil-works/pi-coding-agent' not in peers:
    print('MISSING')
else:
    print('OK')
" 2>/dev/null || echo "MISSING")
                case "$peer_result" in
                    OK) ;;
                    LEGACY)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: peerDependencies 用旧 namespace @mariozechner/pi-coding-agent"
                        MANIFEST_FAIL=1 ;;
                    *)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: peerDependencies 缺少 @earendil-works/pi-coding-agent"
                        MANIFEST_FAIL=1 ;;
                esac

                # 检查 files 字段包含入口 ./index.ts
                files_result=$(python3 -c "
import json
d=json.load(open('$pkg_json'))
files=d.get('files',[])
matched=any('index.ts'==f or 'index.ts'.startswith(f.rstrip('/')) for f in files) if files else False
print('OK' if matched else 'MISSING')
" 2>/dev/null || echo "MISSING")
                [ "$files_result" != "OK" ] && {
                    echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: files 未包含入口 index.ts（npm publish 后会丢失）"
                    MANIFEST_FAIL=1
                }
            done <<< "$EXTENSION_PKG_FILES"

            if [ $MANIFEST_FAIL -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] pi manifest + package.json 检查失败${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
            echo -e "${GREEN}[OK] pi manifest + package.json 检查通过${NC}"
        fi
    else
        echo -e "${YELLOW}[SKIP] extensions manifest & convention 检查已跳过${NC}"
    fi
fi

# ============================================================================
# 2d. extension 结构一致性检查（分组目录 / role 字段 / 依赖台账 / 一层路径残留）
#     scripts/check-extension-dependencies.mjs：①目录 ↔ xyz-agent.role 一致
#     ②taiji/ ⊆ mandatory 清单 ③extensions/ 一层禁放包 ④extension-dependencies.json
#     双向一致 ⑤活文件一层路径残留。零第三方依赖，实测 ~0.3s（~2500 文件全仓扫描，
#     随仓库线性增长）。CI 侧同一脚本由 preflight-check.sh 调用，此处提前到提交时
#     拦截。复用 SKIP_EXTENSION_LINT 开关（不新增逃生口）。
# ============================================================================

if echo "$STAGED_FILES" | grep -qE "^extensions/|^extension-dependencies\.json$|^packages/shared/src/mandatory-extensions\.json$"; then
    print_section "[extension 结构一致性检查]"

    if [ "$SKIP_EXTENSION_LINT" != "1" ]; then
        if ! node scripts/check-extension-dependencies.mjs; then
            echo -e "${RED}[ERROR] extension 结构一致性检查失败，按上方 ✗ 明细修复后重试${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${YELLOW}[SKIP] extension 结构检查已跳过${NC}"
    fi
fi

# ============================================================================
# 3. 自定义代码规范检查（原生 HTML 元素、Emoji、自定义 CSS）
# ============================================================================

print_section "[代码规范检查]"

RULES_CHECKER=".githooks/vue_rules_checker.py"

if [ "$SKIP_CODE_RULES_CHECK" != "1" ]; then
    STAGED_FRONTEND_FILES=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/src/.*\.(vue|ts)$" || true)

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
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
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
SIDECAR_SERVER="apps/electron/sidecar/src/server.ts"

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
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
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
CSS_FILE="packages/renderer/src/style.css"

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
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] CSS tokens 检查已跳过${NC}"
fi

# ============================================================================
# CSS token SSOT 一致性检查（style.css vs design-tokens.md）
# ============================================================================

CSS_SSOT_CHECKER=".githooks/check_css_token_ssot.py"
CSS_SSOT_FILES="packages/renderer/src/style.css docs/page-design/design-tokens.md"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_CSS_TOKEN_SSOT_CHECK" != "1" ]; then
    # 仅当 style.css 或 design-tokens.md 变更时才检查
    SSOT_CHANGED=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/src/style\.css$|^docs/page-design/design-tokens\.md$" || true)
    if [ -n "$SSOT_CHANGED" ]; then
        echo -e "${BLUE}[INFO] 运行 CSS token SSOT 一致性检查...${NC}"

        if [ ! -f "$CSS_SSOT_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $CSS_SSOT_CHECKER${NC}"
        else
            python3 "$CSS_SSOT_CHECKER"
            EXIT_CODE=$?

            if [ $EXIT_CODE -eq 2 ]; then
                echo ""
                echo -e "${RED}[ERROR] CSS token SSOT 检查失败：style.css 含 design-tokens.md 未收录的 token${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] CSS token SSOT 检查已跳过${NC}"
fi

# ============================================================================
# Renderer 依赖完整性检查（import vs package.json）
# ============================================================================

RENDERER_DEPS_CHECKER=".githooks/check_renderer_deps.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_RENDERER_DEPS_CHECK" != "1" ]; then
    # 仅当 renderer src 或 package.json 变更时才检查
    DEPS_CHANGED=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/(src/.*\.(ts|vue|tsx)|package\.json)$" || true)
    if [ -n "$DEPS_CHANGED" ]; then
        echo -e "${BLUE}[INFO] 运行 Renderer 依赖完整性检查...${NC}"

        if [ ! -f "$RENDERER_DEPS_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $RENDERER_DEPS_CHECKER${NC}"
        else
            python3 "$RENDERER_DEPS_CHECKER"
            EXIT_CODE=$?

            if [ $EXIT_CODE -eq 2 ]; then
                echo ""
                echo -e "${RED}[ERROR] Renderer 依赖完整性检查失败：存在 import 了但 package.json 未声明的包${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] Renderer 依赖完整性检查已跳过${NC}"
fi

# ============================================================================
# ENV_WHITELIST_PREFIXES SSOT 单一性检查
# ============================================================================

ENV_WHITELIST_CHECKER=".githooks/check_env_whitelist_sync.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_ENV_WHITELIST_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 ENV_WHITELIST_PREFIXES SSOT 检查..."

    if [ ! -f "$ENV_WHITELIST_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $ENV_WHITELIST_CHECKER${NC}"
    else
        python3 "$ENV_WHITELIST_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] ENV_WHITELIST_PREFIXES SSOT 检查失败${NC}"
            echo -e "${YELLOW}[INFO] 定义点应在 shared/constants.ts，main/runtime 只能 import${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] ENV_WHITELIST_PREFIXES SSOT 检查已跳过${NC}"
fi

# ============================================================================
# Pi extension tool schema 顶层 Object 合规检查（OpenAI 兼容性）
# ============================================================================

TOOL_SCHEMA_CHECKER=".githooks/check_tool_schema.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_TOOL_SCHEMA_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 Pi extension tool schema 顶层 Object 合规检查...${NC}"

    if [ ! -f "$TOOL_SCHEMA_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $TOOL_SCHEMA_CHECKER${NC}"
    else
        python3 "$TOOL_SCHEMA_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] Pi extension tool schema 合规检查失败${NC}"
            echo -e "${YELLOW}[INFO] parameters 顶层必须 Type.Object（OpenAI 兼容），禁止顶层 Type.Union${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] Pi extension tool schema 合规检查已跳过${NC}"
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
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] 路径白名单动态化检查已跳过${NC}"
fi

# ============================================================================
# R1 pi session JSONL 直写检查（data-source-governance P0.3）
#   拦截 runtime/scripts 代码对 pi session JSONL 本体的直写，报错指向登记表。
#   注：不设独立跳过开关——新增 SKIP_* 逃生口须同步登记 AGENTS.md 的 SKIP_* 清单
#   （W3 改动范围仅限本文件与 checker 本体），故本段仅受既有 SKIP_ALL_CHECKS 总闸管辖。
# ============================================================================

PI_DIRECT_WRITE_CHECKER=".githooks/check_pi_direct_write.py"

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    print_section "[R1 pi session 直写检查]"
    echo -e "${BLUE}[INFO] 运行 pi session JSONL 直写检查（R1）...${NC}"

    if [ ! -f "$PI_DIRECT_WRITE_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $PI_DIRECT_WRITE_CHECKER${NC}"
    else
        python3 "$PI_DIRECT_WRITE_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] R1 pi session JSONL 直写检查失败${NC}"
            echo -e "${YELLOW}[INFO] session JSONL 本体唯一写方 = pi；例外与豁免登记见 docs/architecture/data-source-registry.md${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] R1 pi session 直写检查通过${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] R1 pi session 直写检查已跳过${NC}"
fi

# ============================================================================
# ws-client send 直调检查（D3 统一门面）
# ============================================================================

WS_SEND_CHECKER=".githooks/check_no_direct_ws_send.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_WS_SEND_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 ws-client send 直调检查...${NC}"

    if [ ! -f "$WS_SEND_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $WS_SEND_CHECKER${NC}"
    else
        python3 "$WS_SEND_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] ws-client send 直调检查失败${NC}"
            echo -e "${YELLOW}[INFO] renderer 禁止直调 ws-client.send，统一走 api client${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] ws-client send 直调检查已跳过${NC}"
fi

# ============================================================================
# runtime services 循环依赖检查（D6c 防护）
# ============================================================================

SERVICE_CYCLE_CHECKER=".githooks/check_no_service_cycle.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_NO_SERVICE_CYCLE_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 runtime services 循环依赖检查...${NC}"

    if [ ! -f "$SERVICE_CYCLE_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $SERVICE_CYCLE_CHECKER${NC}"
    else
        python3 "$SERVICE_CYCLE_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] runtime services 循环依赖检查失败（D6c）${NC}"
            echo -e "${YELLOW}[INFO] service 间不得具体类循环 import，改用接口/事件解耦${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] runtime services 循环依赖检查已跳过${NC}"
fi

# ============================================================================
# ============================================================================
# 架构约束登记检查（docs/constraints.json SSOT 的 machine enforcement 前置拦截）
#   - check_pi_type_leak.py         C-comm-02：services/transport 禁 PiXxx 类型（allowlist=存量待治理）
#   - check_services_infra_import.py C-comm-03：services 禁白名单外 infra value import
#   - check_shared_node_builtin.py  C-state-05：shared 禁 node: 内置 import
#   - check_runtime_meta_url.py     C-build-01：runtime 禁无 guard 的 import.meta.url / globalThis.__dirname
#   - check_staged_forbidden_lines.py C-ext-07/C-proc-04：staged 新增行禁 extensions console.warn/error
#                                    与无说明的 eslint-disable（行级增量，存量不拦）
#   注：与 R1 同例不设独立跳过开关，仅受 SKIP_ALL_CHECKS 总闸管辖。
# ============================================================================

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    print_section "[架构约束登记检查]"

    for CONSTRAINT_CHECKER in check_pi_type_leak.py check_services_infra_import.py check_shared_node_builtin.py check_runtime_meta_url.py check_staged_forbidden_lines.py; do
        CHECKER_PATH=".githooks/$CONSTRAINT_CHECKER"
        if [ ! -f "$CHECKER_PATH" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $CHECKER_PATH${NC}"
            continue
        fi
        echo -e "${BLUE}[INFO] 运行 $CONSTRAINT_CHECKER ...${NC}"
        python3 "$CHECKER_PATH"
        EXIT_CODE=$?
        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] $CONSTRAINT_CHECKER 检查失败${NC}"
            echo -e "${YELLOW}[INFO] 约束登记见 docs/constraints.json / docs/constraints.md（机器 SSOT + 人读视图）${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    done
    echo -e "${GREEN}[OK] 架构约束登记检查通过${NC}"
else
    echo -e "${YELLOW}[SKIP] 架构约束登记检查已跳过${NC}"
fi

# ============================================================================
# 约束登记 SSOT 一致性（constraints.json 改动时触发）
#   改 docs/constraints.json 后必须重跑 node scripts/render-constraints.mjs
#   生成 docs/constraints.md，防止 json/md 双份漂移。
# ============================================================================

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^docs/constraints\.json$"; then
        echo -e "${BLUE}[INFO] constraints.json 有变更，校验 md 同步...${NC}"
        node scripts/render-constraints.mjs --check
        EXIT_CODE=$?
        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] docs/constraints.md 与 constraints.json 不同步${NC}"
            echo -e "${YELLOW}[INFO] 运行 node scripts/render-constraints.mjs 重新生成后提交${NC}"
            exit 1
        fi
    fi
fi

# ============================================================================
# CSP 能力一致性检查（源码敏感 API vs index.html CSP 指令）
# ============================================================================

CSP_COMPAT_CHECKER=".githooks/check_csp_compatibility.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_CSP_COMPAT_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 CSP 能力一致性检查...${NC}"

    if [ ! -f "$CSP_COMPAT_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $CSP_COMPAT_CHECKER${NC}"
    else
        python3 "$CSP_COMPAT_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -eq 2 ]; then
            echo ""
            echo -e "${RED}[ERROR] CSP 能力一致性检查失败${NC}"
            echo -e "${YELLOW}[INFO] 源码出现 eval/WebAssembly 用法但 CSP script-src 'self' 未放行——运行时会抛 CompileError${NC}"
            echo -e "${YELLOW}[INFO] 曾因此致全部 markdown 渲染静默降级纯文本（2026-08 v0.9.3+ 事故），改用无该能力的实现或显式改 CSP + 白名单${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] CSP 能力一致性检查已跳过${NC}"
fi

# ============================================================================
# Runtime Bundle 验证（runtime 源码有变更时触发）
# ============================================================================

RUNTIME_BUNDLE_CHECKER="scripts/validate-runtime-bundle.sh"
RUNTIME_SRC="packages/runtime/src"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_RUNTIME_BUNDLE_CHECK" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^$RUNTIME_SRC/"; then
        print_section "[Runtime Bundle 验证]"
        echo -e "${BLUE}[INFO] runtime 源码有变更，运行 Bundle 验证...${NC}"

        if [ ! -f "$RUNTIME_BUNDLE_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到验证脚本: $RUNTIME_BUNDLE_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        bash "$RUNTIME_BUNDLE_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] Runtime Bundle 验证失败${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] runtime 源码无变更，跳过 Bundle 验证${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] Runtime Bundle 验证已跳过${NC}"
fi

# ============================================================================
# AC7 extension-host 边界检查（packages/core 源码有变更时触发）
# ============================================================================

BOUNDARY_CHECKER="scripts/verify-extension-host-boundaries.mjs"
CORE_SRC="packages/core/src"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_BOUNDARY_CHECK" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^$CORE_SRC/"; then
        print_section "[AC7 extension-host 边界检查]"
        echo -e "${BLUE}[INFO] core 源码有变更，运行 AC7 边界检查...${NC}"

        if [ ! -f "$BOUNDARY_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到验证脚本: $BOUNDARY_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        node "$BOUNDARY_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] AC7 边界检查失败：extension-host 消费端不得 import domain/stores/composables${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] core 源码无变更，跳过 AC7 边界检查${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] AC7 边界检查已跳过${NC}"
fi

# ============================================================================
# 打包配置预检查（electron-builder.yml / tsup.config.ts / resources/pi 有变更时触发）
# ============================================================================

PREFLIGHT_CHECKER="scripts/preflight-check.sh"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_PREFLIGHT_CHECK" != "1" ]; then
    if echo "$STAGED_FILES" | grep -qE "^apps/electron/electron-builder\.yml$|^packages/runtime/tsup\.config\.ts$|^resources/pi/[^/]+$"; then
        print_section "[打包配置预检查]"
        echo -e "${BLUE}[INFO] 打包配置有变更，运行 preflight 检查...${NC}"

        if [ ! -f "$PREFLIGHT_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到验证脚本: $PREFLIGHT_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        bash "$PREFLIGHT_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] 打包配置预检查失败${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        # electron-builder.yml 或 tsup.config.ts 变更时，额外运行 runtime bundle 验证
        # 包含 CJS smoke test（第 6 步），能拦截 files/asarUnpack 不一致等打包配置错误
        if echo "$STAGED_FILES" | grep -qE '^apps/electron/electron-builder\.yml$|^packages/runtime/tsup\.config\.ts$'; then
            echo -e "${BLUE}[INFO] 打包配置变更，额外运行 runtime bundle 验证（含 smoke test）...${NC}"
            bash "$RUNTIME_BUNDLE_CHECKER"
            if [ $? -ne 0 ]; then
                echo -e "${RED}[ERROR] Runtime bundle 验证失败（可能需要重新 build）${NC}"
                echo -e "${YELLOW}[FIX] cd packages/runtime && pnpm run build，然后重新 commit${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
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
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] 目录规范检查已跳过${NC}"
fi

# ============================================================================
# i18n CJK 残留检测（.vue 模板不得含硬编码中文）
# ============================================================================

I18N_CJK_CHECKER=".githooks/check_i18n_cjk.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_I18N_CJK_CHECK" != "1" ]; then
    # 仅当 staged 含 .vue 文件时检查
    STAGED_VUE=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/src/.*\.vue$" || true)
    if [ -n "$STAGED_VUE" ]; then
        echo -e "${BLUE}[INFO] 运行 i18n CJK 残留检测...${NC}"

        if [ ! -f "$I18N_CJK_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $I18N_CJK_CHECKER${NC}"
        else
            ABSOLUTE_VUE=""
            for FILE in $STAGED_VUE; do
                ABSOLUTE_VUE="$ABSOLUTE_VUE $PROJECT_ROOT/$FILE"
            done

            python3 "$I18N_CJK_CHECKER" $ABSOLUTE_VUE
            EXIT_CODE=$?

            if [ $EXIT_CODE -eq 2 ]; then
                echo ""
                echo -e "${RED}[ERROR] i18n CJK 残留检测失败：模板含硬编码中文${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] i18n CJK 残留检测已跳过${NC}"
fi

# ============================================================================
# i18n locale 双侧 key 对齐检查（zh-CN === en-US）
# ============================================================================

I18N_LOCALE_CHECKER=".githooks/check_i18n_locale_sync.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_I18N_LOCALE_SYNC_CHECK" != "1" ]; then
    # 仅当 staged 含 locale .ts 文件时检查
    LOCALE_CHANGED=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/src/i18n/locales/.*\.ts$" || true)
    if [ -n "$LOCALE_CHANGED" ]; then
        echo -e "${BLUE}[INFO] 运行 i18n locale 双侧 key 对齐检查...${NC}"

        if [ ! -f "$I18N_LOCALE_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $I18N_LOCALE_CHECKER${NC}"
        else
            python3 "$I18N_LOCALE_CHECKER"
            EXIT_CODE=$?

            if [ $EXIT_CODE -eq 2 ]; then
                echo ""
                echo -e "${RED}[ERROR] i18n locale 双侧 key 不一致：zh-CN 与 en-US key 集合 desync${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] i18n locale 双侧对齐检查已跳过${NC}"
fi

# ============================================================================
# 全部通过
# ============================================================================

print_section "[所有检查通过]"

echo -e "${GREEN}代码质量检查全部通过！${NC}"
echo ""
echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
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
echo -e "  ${GREEN}[+]${NC} pi extensions ESLint + tsc 类型检查（extensions/ 目录）"
echo -e "  ${GREEN}[+]${NC} pi extensions manifest & convention 检查（禁废弃 namespace / 禁 console.log / pi manifest 字段）"
echo -e "  ${GREEN}[+]${NC} extension 结构一致性检查（分组/role/依赖台账/一层路径残留）"
echo -e "  ${GREEN}[+]${NC} Vue 组件规范检查（禁止原生 HTML、Emoji、自定义 CSS）"
echo -e "  ${GREEN}[+]${NC} Sidecar session 隔离检查"
echo -e "  ${GREEN}[+]${NC} CSS tokens 检查"
echo -e "  ${GREEN}[+]${NC} ENV_WHITELIST_PREFIXES SSOT 单一性检查"
echo -e "  ${GREEN}[+]${NC} Pi extension tool schema 顶层 Object 合规检查（OpenAI 兼容性）"
echo -e "  ${GREEN}[+]${NC} 路径白名单动态化检查"
echo -e "  ${GREEN}[+]${NC} R1 pi session JSONL 直写检查（data-source-governance，指向 data-source-registry.md）"
echo -e "  ${GREEN}[+]${NC} 目录规范检查（禁止 demos/impeccable + 外部 symlink）"
echo -e "  ${GREEN}[+]${NC} ws-client send 直调检查（D3 统一门面）"
echo -e "  ${GREEN}[+]${NC} runtime services 循环依赖检查（D6c 防护）"
echo -e "  ${GREEN}[+]${NC} CSP 能力一致性检查（源码 eval/WebAssembly vs index.html CSP 指令）"
echo -e "  ${GREEN}[+]${NC} Runtime Bundle 验证（依赖打包 + CJS 兼容 + 健康检查）"
echo -e "  ${GREEN}[+]${NC} AC7 extension-host 边界检查（core 变更时触发，禁 domain/stores import）"
echo -e "  ${GREEN}[+]${NC} 打包配置预检查（asarUnpack/files 一致性 + symlink 检查）"
echo -e "  ${GREEN}[+]${NC} i18n CJK 残留检测（.vue 模板不得含硬编码中文）"
echo -e "  ${GREEN}[+]${NC} i18n locale 双侧 key 对齐检查（zh-CN === en-US）"
echo ""
echo -e "${CYAN}Hook 脚本位置:${NC} .githooks/"
echo ""