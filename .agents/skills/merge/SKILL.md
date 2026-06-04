---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 xyz-agent 项目。
---

# merge

执行 8 阶段合并发布流程，最终通过 GitHub Release 交付 Electron 产物（DMG/EXE/AppImage）。

## 前置条件

- feature 分支有已创建的 PR
- GitHub CLI 已认证

## 8 阶段流程

### 阶段 0: 初始化

⚠️ **关键**：第一个参数是 **feature worktree 目录名**（如 `feat-new-feature`），不是 `main`。脚本会自动检测 `$WS_ROOT/main` 用于 bump/tag/push。传 `main` 会导致阶段 7 删除 main worktree。

⚠️ **cwd 隔离**：Pi bash 工具的 cwd 不跨调用保持。所有 stage 脚本必须在 **workspace root** 或 **main worktree** 内执行，不能在 feature worktree 内（阶段 7 会删除它）。

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace
bash ~/.agents/skills/merge-worktree/stages/0-init.sh <worktree-dir> patch
```

参数说明：
- `<worktree-dir>` — feature worktree 目录名（basename），如 `feat-extensions-widget`
- `patch` — 版本级别（patch/minor/major），默认 `patch`

### 阶段 1: 本地验证

```bash
bash ~/.agents/skills/merge-worktree/stages/1-local-check.sh
```

阶段 1 会自动执行 pre-merge-check.sh（依赖安装、类型检查、lint、测试、构建）。

⚠️ **src-electron/ 独立 npm install**：`src-electron/` 是独立 npm project（不在根 workspaces 里）。如果 stage 1 脚本未自动处理，需手动执行：

```bash
cd src-electron && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
```

### 阶段 2: PR CI + 合并

```bash
bash ~/.agents/skills/merge-worktree/stages/2-pr-merge.sh
```

检查 PR CI 状态并通过 PR 合并（使用 `--no-ff`）。

⚠️ **stage 2 后必须 sync 本地 main**：`gh pr merge` 直接合到 github/main，不更新本地 main。后续 bump 需要先 sync：

```bash
git -C $WS_ROOT/main fetch github
git -C $WS_ROOT/main reset --hard github/main
```

### 阶段 3: Post-merge CI

```bash
bash ~/.agents/skills/merge-worktree/stages/3-post-merge-ci.sh
```

等待 main 分支 CI 通过。

### 阶段 4: 版本 bump + 发布

执行全局脚本：

```bash
bash ~/.agents/skills/merge-worktree/stages/4-publish.sh
```

全局脚本会自动：
- 检测项目 `scripts/publish.sh` 存在则委托
- 否则自行 `npm version patch` + tag + push

**Electron 特化说明**：
- Release CI（`release.yml`）由 tag push 触发
- DMG/EXE/AppImage 由 CI 构建，不在本地生成
- 本地构建验证是预防措施，不产生最终交付物

### 阶段 5: Release Notes + Release

```bash
bash ~/.agents/skills/merge-worktree/stages/5-release.sh
```

生成 Release Notes 并创建/更新 GitHub Release。

### 阶段 6: 交付物验证（Electron 特化）

⚠️ **不可跳过**。这是阶段 7 的硬性前置条件。

```bash
bash ~/.agents/skills/merge-worktree/stages/6-verify.sh
```

手动补充验证 Electron 产物完整性：

```bash
# 获取版本号
TAG="v$(node -p "require('./package.json').version")"

# 查看所有 assets
ASSETS=$(gh release view "$TAG" --json assets --jq '.assets[].name')

# 验证各平台产物
echo "$ASSETS" | grep -q "\.dmg$" && echo "macOS .dmg OK" || echo "MISSING .dmg"
echo "$ASSETS" | grep -q "\.exe$" && echo "Windows .exe OK" || echo "MISSING .exe"
echo "$ASSETS" | grep -q "AppImage" && echo "Linux AppImage OK" || echo "MISSING AppImage"
```

可选的本地验证脚本（项目根目录 `scripts/` 下）：

```bash
bash scripts/postbuild-validate.sh
bash scripts/validate-runtime-bundle.sh
```

### 阶段 7: 清理

```bash
bash ~/.agents/skills/merge-worktree/stages/7-cleanup.sh
```

门禁：阶段 7 启动时检查 `deliverables-verified` checkpoint，不存在则拒绝执行。

## AI 操作步骤

### 1. 创建 todo 清单

收到合并指令后立即创建 todo：

| # | 文本 | 阶段脚本 |
|---|------|---------|
| 1 | 初始化环境（0-init） | `stages/0-init.sh` |
| 2 | 本地验证（1-local-check） | `stages/1-local-check.sh` |
| 3 | PR CI + 合并（2-pr-merge） | `stages/2-pr-merge.sh` |
| 4 | Post-merge CI（3-post-merge-ci） | `stages/3-post-merge-ci.sh` |
| 5 | 版本 bump + 发布（4-publish） | `stages/4-publish.sh` |
| 6 | 创建 Release（5-release） | `stages/5-release.sh` |
| 7 | ⚠️ 确认交付物（6-verify） | `stages/6-verify.sh` |
| 8 | 清理 worktree（7-cleanup） | `stages/7-cleanup.sh` |

### 2. 执行约束

- 所有阶段脚本必须在 workspace root 或其子目录（非目标 worktree）内执行
- 阶段 1 和阶段 6 的检查**零容忍**，所有错误必须正面修复
- bash timeout >= 1200s（Release CI 含 Electron build 可能耗时 10 分钟以上）

### 3. 故障恢复

每个阶段独立执行。失败后修复重跑同一阶段即可。

## 项目特化

- **交付方式**：GitHub Release + Electron 产物（DMG/EXE/AppImage）
- **版本管理**：根 `package.json` + `src-electron/package.json`（全局脚本自动同步）
- **构建验证**：本地 `npm run build` + CI 全量构建

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
