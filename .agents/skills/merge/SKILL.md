---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 xyz-agent 项目。
---

# merge

执行 9 阶段合并发布流程，最终通过 GitHub Release 交付 Electron 产物（DMG/EXE/AppImage）。

## 前置条件

- feature 分支有已创建的 PR
- GitHub CLI 已认证

## 9 阶段流程

### 阶段 0: 初始化

⚠️ **关键**：第一个参数是 **feature worktree 目录名**（如 `feat-new-feature`），不是 `main`。脚本会自动检测 `$WS_ROOT/main` 用于 bump/tag/push。传 `main` 会导致阶段 7 删除 main worktree。

⚠️ **cwd 隔离**：Pi bash 工具的 cwd 不跨调用保持。所有阶段脚本必须在 **workspace root** 或 **main worktree** 内执行，不能在 feature worktree 内（阶段 7 会删除它）。

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace
bash .agents/skills/merge/scripts/init.sh <worktree-dir>
```

参数说明：
- `<worktree-dir>` — feature worktree 目录名（basename），如 `feat-extensions-widget`

脚本输出 `WS_ROOT`、`BRANCH_NAME`、`PR_NUMBER`，后续阶段需要这些值。

### 阶段 1: 本地验证

```bash
bash .agents/skills/merge/scripts/pre-merge-check.sh <worktree-dir>
```

阶段 1 调用项目内 pre-merge-check.sh（依赖安装、类型检查、lint、测试、构建）。脚本自包含在项目 skill 目录内，不依赖全局脚本。

ℹ️ **pnpm workspace 单步安装**：项目使用 pnpm workspace（`packages/* + apps/*`），`pnpm install` 一次装完所有依赖，无需手动 cd 子目录。如果 pre-merge-check.sh 未自动处理依赖安装，需手动执行：

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
```

### 阶段 2: PR CI + 合并

```bash
bash .agents/skills/merge/scripts/pr-merge.sh <branch-name> <pr-number>
```

检查 PR CI 状态并通过 PR 合并（`gh pr merge --merge --delete-branch`，使用 merge commit 绝不 squash）。

脚本内部自动 sync 本地 main（`git fetch github && git reset --hard github/main`），无需手动执行。

### 阶段 3: Post-merge CI

```bash
cd $WS_ROOT/main
git fetch github
MAIN_SHA=$(git rev-parse github/main)
bash .agents/skills/merge/scripts/wait-for-ci.sh "$MAIN_SHA"
```

等待 main 分支 CI 通过。wait-for-ci.sh 在项目 skill 目录内（CI 轮询），需传入 commit SHA。

### [MANDATORY] 阶段 3.5: 版本校验

在 bump 版本之前，必须确认代码版本与最新正式 release 一致。
此校验防止版本号被跳过（例如从 v0.4.6 直接跳到 v0.4.8）。

```bash
cd $WS_ROOT/main
bash scripts/check-version-bump.sh
```

- **Exit 0（通过）**：代码版本 == 最新正式 release，可以安全 bump
- **Exit 1（失败）**：版本不匹配，会输出期望版本和实际版本

失败时需要检查：
1. 是否有 prerelease（`-beta.N`）占用了目标版本号？清理后重试
2. 是否已经手动 bump 过版本？执行 `npm version <latest_release_version> --no-git-tag-version` 回退
3. 可能是之前的 pre-release 测试未还原？运行 `cd $WS_ROOT/main && git reset --hard github/main` 重置

### 阶段 4: 版本 bump + 发布

```bash
cd $WS_ROOT/main

# ⚠️ 先确认当前分支是 main（pr-merge.sh 的 sync 会强制 checkout main，
#    但阶段 4 执行前必须二次确认，防止意外）
git branch --show-current  # 必须输出 main，否则 git checkout main

# ⚠️ 必须使用 --no-git-tag-version：所有 package.json 的变更必须在同一个
#    commit 中，否则第二次 version 因 tag 已存在而失败，导致 apps/electron
#    的版本号未提交，CI 从 apps/electron/package.json 读取到旧版本号。

# 1. 纯修改文件，不创建 commit 和 tag（pnpm workspace 递归 bump 所有包）
npm version patch --no-git-tag-version
cd apps/electron && npm version patch --no-git-tag-version && cd ../..

# 2. 原子提交：两个 package.json 在同一个 commit
VERSION=$(node -p "require('./package.json').version")
git add package.json apps/electron/package.json
git commit -m "chore: bump version to ${VERSION}"

# 3. 手动打 tag，确保指向包含两个文件变更的 commit
git tag "v${VERSION}"

# 4. 推送 commit + tag
git push github HEAD
git push github "v${VERSION}"

# [MANDATORY] 等待 CI 完成并验证产物
# 此命令会轮询 CI 直到完成，验证 dmg/exe/AppImage 全部存在
# exit 非 0 则必须修复直到通过
bash scripts/verify-ci-release.sh "v$(node -p "require('./package.json').version")"
```

**Electron 特化说明**：
- Release CI（`release.yml`）由 tag push 触发
- DMG/EXE/AppImage 由 CI 构建，不在本地生成
- 本地构建验证是预防措施，不产生最终交付物

### 阶段 5: Release Notes + Release

```bash
bash .agents/skills/merge/scripts/release.sh
```

从 conventional commits 自动生成 Release Notes（feat/fix/perf/breaking 分组）并创建/更新 GitHub Release。也可指定 tag 和 notes 文件：`bash .agents/skills/merge/scripts/release.sh v0.6.5 --notes ./my-notes.md`。

### 阶段 6: 交付物验证（Electron 特化）

⚠️ **不可跳过**。这是阶段 7 的硬性前置条件。

```bash
cd $WS_ROOT/main
bash scripts/verify-ci-release.sh "v$(node -p "require('./package.json').version")"
```

脚本会自动：
- 轮询 CI workflow 直到完成
- 等待 GitHub Release 创建
- 验证所有平台产物（dmg + exe + AppImage）完整性

**exit 0 前不得进入阶段 7。** exit 非 0 必须修复。

可选的本地验证脚本（项目根目录 `scripts/` 下）：

```bash
bash scripts/postbuild-validate.sh
bash scripts/validate-runtime-bundle.sh
```

### 阶段 7: 清理

```bash
bash .agents/skills/merge/scripts/remove-worktree.sh <branch-name> --force --skip-sync
```

调用项目内 remove-worktree.sh 清理 feature worktree 和本地分支。`--force` 因为分支已删除（远程 delete-branch），本地 `git branch --merged` 检查会误判。`--skip-sync` 因为 pr-merge.sh 已 sync 过 main。

门禁：阶段 7 启动前**必须**确认阶段 6（`verify-ci-release.sh`）已 exit 0。

⚠️ **cwd 隔离**：bash 工具的 cwd 在调用间持久。脚本内部有 `cd "$WORKSPACE_ROOT"` 自我保护，但只在子 shell 生效，脚本退出后调用方 cwd 不变。若 cwd 在待删 worktree 内，脚本删除目录后后续 bash 命令将报 ENOENT。**执行前先 `cd $WS_ROOT`**。

## AI 操作步骤

### 1. 创建 todo 清单

收到合并指令后立即创建 todo：

| # | 文本 | 命令 |
|---|------|------|
| 1 | 初始化环境（阶段 0） | |
| 2 | 本地验证（阶段 1） | |
| 3 | PR CI + 合并（阶段 2） | |
| 4 | Post-merge CI（阶段 3） | |
| 5 | ⚠️ 版本校验（阶段 3.5） | `bash scripts/check-version-bump.sh` |
| 6 | 版本 bump + 发布（阶段 4） | `bash scripts/verify-ci-release.sh ...` (在 push 后调用) |
| 7 | 创建 Release（阶段 5） | |
| 8 | ⚠️ 确认交付物（阶段 6） | `bash scripts/verify-ci-release.sh ...` |
| 9 | 清理 worktree（阶段 7） | |

### 2. 执行约束

- 所有阶段脚本必须在 workspace root 或其子目录（非目标 worktree）内执行
- 阶段 1 和阶段 6 的检查**零容忍**，所有错误必须正面修复
- bash timeout >= 1200s（Release CI 含 Electron build 可能耗时 10 分钟以上）

### 3. 故障恢复

每个阶段独立执行。失败后修复重跑同一阶段即可。

## [HISTORICAL] 禁止跳过检查

所有 githooks 和自动化检查（lint、ruff、脚本检查、pre-commit hook、CI 检查等）报告的问题，**必须正面修复**。绝不允许通过 `SKIP_*` 环境变量、`--no-verify`、`eslint-disable`、`# noqa` 等方式绕过或静默。检查不通过 = 流程中止，唯一的出路是修复代码让检查通过。

此规则来源于多次事故：跳过检查掩盖了真实 bug，上线后才发现问题，修复成本远高于当时正面解决。

## 项目特化

- **交付方式**：GitHub Release + Electron 产物（DMG/EXE/AppImage）
- **版本管理**：根 `package.json` + `apps/electron/package.json`（阶段 4 内联命令原子 bump 两个文件）
- **构建验证**：本地 `npm run build` + CI 全量构建

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史经验总结的规则。来自实际事故和教训，经验证有效后固化为规则 | **不允许删除或削弱**。修改时只能在原有基础上补充，不能降低要求 |
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
