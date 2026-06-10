# Draft Release + Version Guard 实现计划

> **给 agentic worker：** 使用 subagent-driven-development 或 executing-plans 逐任务执行。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 建立预发布测试机制（用 `-beta.N` 后缀 TAG 替代占用正式版本号），并在正式发布时校验版本号严格 +1。

**架构：** 两个独立脚本 + 一个 skill + 两处修改。`scripts/prerelease-test.sh` 编排预发布流程（bump → push → CI → 验证 → revert），`scripts/check-version-bump.sh` 在 merge 阶段 4 前做版本校验。CI 的 `release.yml` 改为根据 TAG 是否含 `-` 自动判断 prerelease/draft。

**技术栈：** Bash, `gh` CLI, `jq`, `node -p`

---

## 涉及文件

| 操作 | 路径 | 说明 |
|------|------|------|
| 修改 | `.github/workflows/release.yml` | prerelease 根据 tag 内容动态判断 |
| 新建 | `scripts/check-version-bump.sh` | 版本号校验：当前代码版本必须 == 最新正式 release |
| 新建 | `scripts/prerelease-test.sh` | 预发布测试编排：bump → CI → verify → revert |
| 新建 | `.agents/skills/draft-release/SKILL.md` | 预发布测试 skill |
| 修改 | `.agents/skills/merge/SKILL.md` | 阶段 4 前插入版本校验步骤 |

---

## 版本命名约定

```
正式版：  v0.4.6              （不含 -）
测试版：  v0.4.7-beta.1       （含 -beta.N 后缀）
         v0.4.7-beta.2       （同版本多次测试迭代）
```

- CI 自动检测：tag 含 `-` → `prerelease: true`，不含 → `prerelease: false`
- `gh release list` 查询最新正式版时过滤条件：`isDraft == false AND isPrerelease == false`
- 多次测试迭代：脚本自动检测已有 beta 序号，递增 `+1`

---

### 任务 1: 修改 CI `release.yml`

**文件：** `.github/workflows/release.yml`

**改动点：**

1. 在 `softprops/action-gh-release@v2` 步骤中，将硬编码的 `draft: true` 改为：
   - `draft: false`（prerelease 本身已标记，无需隐藏）
   - `prerelease: ${{ contains(github.ref, '-') }}`（tag 含 `-` 则为 prerelease）

**修改前：**
```yaml
      - name: Create Draft Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.changelog.outputs.version }}
          name: xyz-agent v${{ steps.changelog.outputs.version }}
          body: ${{ steps.changelog.outputs.body }}
          draft: true
          files: release-artifacts/**/*
```

**修改后：**
```yaml
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ steps.changelog.outputs.version }}
          name: xyz-agent v${{ steps.changelog.outputs.version }}
          body: ${{ steps.changelog.outputs.body }}
          draft: false
          prerelease: ${{ contains(github.ref, '-') }}
          files: release-artifacts/**/*
```

**验证方法：** 检查语法正确性 `yamllint`（可选），review diff 确认逻辑。

---

### 任务 2: 创建 `scripts/check-version-bump.sh`

**文件：** `scripts/check-version-bump.sh`

**职责：** 在 merge 阶段 4 bump 之前，校验当前代码版本 == 最新正式 release 版本。不匹配则拒绝继续。

**脚本逻辑：**

```bash
#!/bin/bash
# 校验代码版本与最新正式 release 一致
# Exit: 0 = 可以 bump, 1 = 版本不匹配
set -euo pipefail

REPO="zhushanwen321/xyz-agent"
WS_ROOT="${WS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# 获取最新正式 release（排除 draft 和 prerelease）
LATEST=$(gh release list --repo "$REPO" --limit 30 \
  --json tagName,isDraft,isPrerelease \
  | jq -r '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' \
  | head -1)

if [ -z "$LATEST" ]; then
  echo "ERROR: 未找到任何正式 release"
  exit 1
fi

LATEST_VER="${LATEST#v}"
CURRENT_VER=$(node -p "require('${WS_ROOT}/package.json').version")

if [ "$LATEST_VER" != "$CURRENT_VER" ]; then
  echo "ERROR: 版本不匹配！"
  echo "  最新正式 release: v${LATEST_VER}"
  echo "  当前代码版本:     v${CURRENT_VER}"
  echo ""
  echo "当前代码版本必须等于最新正式 release 版本。"
  echo "Bump 后才能保证新版本 = ${LATEST_VER} + 1。"
  exit 1
fi

echo "OK: 当前代码版本 (${CURRENT_VER}) == 最新正式 release (${LATEST_VER})"
echo "可以执行版本 bump。"
```

**验证方法：**
- 在 main worktree 运行 `bash scripts/check-version-bump.sh`
- 预期输出 "OK" + exit 0（因为当前 0.4.6 == 最新 v0.4.6）

---

### 任务 3: 创建 `scripts/prerelease-test.sh`

**文件：** `scripts/prerelease-test.sh`

**职责：** 编排完整的预发布测试流程。分 6 个阶段，每个阶段独立可重试。

**阶段设计：**

| 阶段 | 操作 | 失败处理 |
|------|------|---------|
| 1. 前置检查 | 确认在 main、工作区干净、gh 已认证 | 修复后重试 |
| 2. 计算版本 | 从最新正式 release 计算 beta 版本号（自动检测已有 beta 递增） | 无 |
| 3. Bump + Push | 修改 package.json → commit → tag → push（触发 CI） | revert 后重试 |
| 4. 等待 CI | poll CI workflow run 直到完成 | 等待或手动检查 |
| 5. 验证产物 | 检查 prerelease 的 assets（dmg/exe/AppImage）存在 | 修复 CI 问题 |
| 6. 还原版本 | revert 版本到原始值，删除 beta tag 和 prerelease（可选保留） | 手动处理 |

**脚本框架：**

```bash
#!/bin/bash
# 预发布测试：创建 -beta.N 版本触发 CI，验证产物，还原代码
# Usage: scripts/prerelease-test.sh
set -euo pipefail

REPO="zhushanwen321/xyz-agent"
WS_ROOT="${WS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
GITHUB_REMOTE="github"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[PRERELEASE]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }

# ── 阶段 1: 前置检查 ──
log "=== 阶段 1/6: 前置检查 ==="
BRANCH=$(git -C "$WS_ROOT" branch --show-current)
if [ "$BRANCH" != "main" ]; then
  err "必须在 main 分支上运行，当前: $BRANCH"; exit 1
fi
if ! git -C "$WS_ROOT" diff-index --quiet HEAD --; then
  err "工作区不干净，请先 commit 或 stash"; exit 1
fi
if ! gh auth status --repo "$REPO" &>/dev/null; then
  err "gh CLI 未认证或无法访问 $REPO"; exit 1
fi

# ── 阶段 2: 计算 beta 版本号 ──
log "=== 阶段 2/6: 计算 beta 版本号 ==="

# 2a. 获取最新正式 release
LATEST=$(gh release list --repo "$REPO" --limit 30 \
  --json tagName,isDraft,isPrerelease \
  | jq -r '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' \
  | head -1)

if [ -z "$LATEST" ]; then
  err "未找到正式 release"; exit 1
fi
LATEST_VER="${LATEST#v}"
log "最新正式 release: v${LATEST_VER}"

# 2b. 确认代码版本匹配
CURRENT_VER=$(node -p "require('${WS_ROOT}/package.json').version")
if [ "$LATEST_VER" != "$CURRENT_VER" ]; then
  err "代码版本 (${CURRENT_VER}) != 最新 release (${LATEST_VER})"; exit 1
fi

# 2c. 计算下一个正式版本号（patch +1）
IFS='.' read -r MAJOR MINOR PATCH <<< "$LATEST_VER"
NEXT_PATCH=$((PATCH + 1))
BASE_NEXT="${MAJOR}.${MINOR}.${NEXT_PATCH}"

# 2d. 检测已有 beta 版本，递增序号
EXISTING_BETA=$(gh release list --repo "$REPO" --limit 30 \
  --json tagName,isPrerelease \
  | jq -r ".[] | select(.isPrerelease == true) | .tagName | select(startswith(\"v${BASE_NEXT}-beta.\"))" \
  | sort -V | tail -1)

if [ -n "$EXISTING_BETA" ]; then
  LAST_NUM=$(echo "$EXISTING_BETA" | sed 's/.*-beta\.//')
  BETA_NUM=$((LAST_NUM + 1))
else
  BETA_NUM=1
fi

BETA_VERSION="${BASE_NEXT}-beta.${BETA_NUM}"
BETA_TAG="v${BETA_VERSION}"
log "beta 版本: ${BETA_TAG}"

# ── 阶段 3: Bump + Push ──
log "=== 阶段 3/6: Bump 版本并推送 ==="

# 保存原始版本用于还原
ORIGINAL_VERSION="$CURRENT_VER"

cd "$WS_ROOT"
npm version "$BETA_VERSION" --no-git-tag-version
cd src-electron
npm version "$BETA_VERSION" --no-git-tag-version
cd "$WS_ROOT"

git add package.json src-electron/package.json
git commit -m "chore: prerelease ${BETA_TAG}"
git tag "$BETA_TAG"
git push "$GITHUB_REMOTE" HEAD
git push "$GITHUB_REMOTE" "$BETA_TAG"

log "Tag ${BETA_TAG} 已推送，CI 将开始构建..."

# ── 阶段 4: 等待 CI ──
log "=== 阶段 4/6: 等待 CI 完成 ==="

# 查找由当前 tag 触发的 workflow run
WORKFLOW_NAME="Release"
sleep 5  # 给 GitHub 一点时间创建 workflow run

for i in $(seq 1 60); do
  RUN=$(gh run list --repo "$REPO" --workflow "$WORKFLOW_NAME" \
    --branch main --limit 5 --json status,headBranch,conclusion,databaseId \
    | jq -r ".[] | select(.headBranch == \"${BETA_TAG}\") | \"\(.databaseId) \(.status) \(.conclusion)\"" | head -1)
  
  if [ -z "$RUN" ]; then
    log "等待 workflow 启动... ($i/60)"
    sleep 30
    continue
  fi
  
  RUN_ID=$(echo "$RUN" | awk '{print $1}')
  RUN_STATUS=$(echo "$RUN" | awk '{print $2}')
  RUN_CONCLUSION=$(echo "$RUN" | awk '{print $3}')
  
  if [ "$RUN_STATUS" = "completed" ]; then
    if [ "$RUN_CONCLUSION" = "success" ]; then
      log "CI 构建成功！"
      break
    else
      err "CI 构建失败 (conclusion: $RUN_CONCLUSION)"
      err "详情: https://github.com/${REPO}/actions/runs/${RUN_ID}"
      log "=== 阶段 6/6: 自动还原版本 ==="
      cd "$WS_ROOT"
      git reset --hard HEAD~1
      git push "$GITHUB_REMOTE" HEAD --force
      git push "$GITHUB_REMOTE" --delete "$BETA_TAG" 2>/dev/null || true
      gh release delete "$BETA_TAG" --repo "$REPO" --yes 2>/dev/null || true
      log "版本已还原到 ${ORIGINAL_VERSION}"
      exit 1
    fi
  fi
  
  log "CI 运行中... ($i/60)"
  sleep 30
done

# ── 阶段 5: 验证产物 ──
log "=== 阶段 5/6: 验证产物 ==="

# 等待 GitHub Release 创建完成（CI 最后一步）
sleep 10

ASSETS=$(gh release view "$BETA_TAG" --repo "$REPO" --json assets \
  --jq '.assets[].name' 2>/dev/null || echo "")

if [ -z "$ASSETS" ]; then
  warn "未找到任何产物，请手动检查"
  warn "https://github.com/${REPO}/releases/tag/${BETA_TAG}"
else
  echo "$ASSETS"
  
  MISSING=0
  echo "$ASSETS" | grep -q "\.dmg$" || { warn "缺少 macOS .dmg"; MISSING=1; }
  echo "$ASSETS" | grep -q "\.exe$" || { warn "缺少 Windows .exe"; MISSING=1; }
  echo "$ASSETS" | grep -q "AppImage" || { warn "缺少 Linux AppImage"; MISSING=1; }
  
  if [ "$MISSING" -eq 0 ]; then
    log "所有平台产物已生成"
  fi
fi

# ── 阶段 6: 还原版本 ──
log "=== 阶段 6/6: 还原版本 ==="

echo ""
warn "产物已生成，请下载测试："
warn "  https://github.com/${REPO}/releases/tag/${BETA_TAG}"
echo ""
read -p "测试通过？输入 yes 还原版本（输入 no 保留 beta 版本）: " CONFIRM

if [ "$CONFIRM" = "yes" ]; then
  cd "$WS_ROOT"
  
  # 还原代码版本
  git reset --hard HEAD~1
  git push "$GITHUB_REMOTE" HEAD --force
  
  # 删除 beta tag 和 release
  git push "$GITHUB_REMOTE" --delete "$BETA_TAG" 2>/dev/null || true
  gh release delete "$BETA_TAG" --repo "$REPO" --yes 2>/dev/null || true
  
  log "版本已还原到 ${ORIGINAL_VERSION}，beta tag 和 release 已清理"
else
  log "保留 beta 版本 ${BETA_TAG}，版本未还原"
  log "手动还原时运行: git reset --hard HEAD~1 && git push github HEAD --force"
fi
```

**验证方法：** `bash -n scripts/prerelease-test.sh`（语法检查），不在真实环境执行。

---

### 任务 4: 创建 `.agents/skills/draft-release/SKILL.md`

**文件：** `.agents/skills/draft-release/SKILL.md`

**触发条件：** 用户说"发测试版"、"draft release"、"pre-release test"、"构建 DMG 测试"、"生成测试包"等。

**内容设计要点（参考 meta-sk-skill-writer）：**
- Description 只写触发条件，不写流程
- 流程写伪代码而非具体 bash（具体脚本已有）
- 标记章节：`[MANDATORY]` 标注不可跳过步骤

```markdown
---
name: draft-release
description: >-
  Use when creating a pre-release test build to verify Electron artifacts
  (DMG/EXE/AppImage) locally before official release. Triggers: "发测试版",
  "draft release", "构建测试 DMG", "pre-release test", "生成测试包",
  "beta release". Not for official releases — use merge skill instead.
---

# draft-release

## 概述

创建 `-beta.N` 后缀的预发布版本，触发 CI 构建产物（DMG/EXE/AppImage），
供本地安装测试。测试通过后自动还原代码版本号，不占用正式版本号。

## 核心流程

1. 确认当前在 main 分支，工作区干净
2. 从最新正式 release 计算 beta 版本（自动递增序号）
3. 临时 bump 版本 + commit + tag + push → 触发 CI
4. 轮询 CI 直到完成
5. 验证产物完整性
6. **用户确认测试通过后**，还原代码版本，删除 beta tag 和 release

## AI 操作步骤

### [MANDATORY] 1. 执行预发布脚本

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/main
bash scripts/prerelease-test.sh
```

脚本会依次执行所有阶段。AI 只需执行这一步。

### [MANDATORY] 2. 产物下载和测试指导

脚本阶段 5 完成后会输出产物链接。指导用户：
- macOS: 下载 `.dmg` 安装测试
- Windows: 下载 `.exe` 安装测试
- Linux: 下载 `.AppImage` 运行测试

### [MANDATORY] 3. 版本还原

脚本阶段 6 会询问用户是否通过测试。输入 `yes` 自动还原。

### [OPTIONAL] 4. CI 失败处理

如果 CI 失败，脚本会自动还原版本。检查 CI 日志修复问题后重新运行脚本
（会自动递增 beta 序号，如 `-beta.2`）。

## 原理

| 操作 | 版本变化 |
|------|---------|
| 初始状态 | 代码 v0.4.6, 最新 release v0.4.6 |
| Bump 后 | 代码 v0.4.7-beta.1, tag v0.4.7-beta.1 |
| 还原后 | 代码 v0.4.6（还原），tag 已删除 |
| 正式发布 | v0.4.7（不受影响） |

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据项目需求调整 |
```

---

### 任务 5: 修改 `.agents/skills/merge/SKILL.md`

**文件：** `.agents/skills/merge/SKILL.md`

**改动点：** 在阶段 4 前插入版本校验步骤。

**修改前（阶段 3 → 阶段 4 之间）：**
```markdown
### 阶段 3: Post-merge CI

...

### 阶段 4: 版本 bump + 发布
```

**修改后：**
```markdown
### 阶段 3: Post-merge CI

...

### [MANDATORY] 阶段 3.5: 版本校验

在 bump 版本之前，必须确认代码版本与最新正式 release 一致。
此校验防止版本号被跳过（例如从 v0.4.6 直接跳到 v0.4.8）。

```bash
bash scripts/check-version-bump.sh
```

- **Exit 0（通过）**：代码版本 == 最新正式 release，可以安全 bump
- **Exit 1（失败）**：版本不匹配，输出期望版本和实际版本

失败时需要检查：
1. 是否有 draft/prerelease 占用了目标版本号？清理后重试
2. 是否已经手动 bump 过版本？回退到最新 release 版本

### 阶段 4: 版本 bump + 发布
```

同时更新 todo 清单（插入新步骤）和 8 阶段改为 9 阶段。

**验证方法：** 检查 markdown 结构完整，确认 `[MANDATORY]` 标记正确。

---

### 任务 6: 端到端验证

**验证项：**

1. **脚本语法检查：**
   ```bash
   bash -n scripts/check-version-bump.sh
   bash -n scripts/prerelease-test.sh
   ```

2. **版本校验脚本正确性（真实环境测试）：**
   ```bash
   cd /Users/zhushanwen/Code/xyz-agent-workspace/main
   bash scripts/check-version-bump.sh
   echo "Exit code: $?"
   ```
   预期输出 "OK" + exit 0（当前 v0.4.6 == 最新 release v0.4.6）

3. **release.yml 语法检查（如 yamllint 可用）：**
   ```bash
   yamllint .github/workflows/release.yml || true
   ```

4. **SKILL.md YAML frontmatter 验证：**
   ```bash
   python3 scripts/validate-skill-yaml.py .agents/skills/draft-release/SKILL.md
   ```

5. **review merge SKILL.md 修改：**
   确认阶段 3.5 正确插入，todo 清单已更新。
