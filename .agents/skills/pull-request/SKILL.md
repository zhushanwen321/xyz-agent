---
name: pull-request
description: >-
  提交 Pull Request。触发词："提交 PR"、"创建 PR"、"push"、
  "提交代码"、"pr-worktree"。仅用于 xyz-agent 项目。
---

# pull-request

提交代码并创建 Pull Request 的完整流程。

## 前置条件

- 当前在 worktree 分支上(不在 main/master)
- 所有改动已 stage(`git add`)
- 有 GitHub CLI(`gh`)认证

## 流程

### [MANDATORY] 1. Pre-merge 硬 gate

**在当前 feature worktree 内执行**（不是 main worktree）。验证的是待 PR 的代码。

用 `scripts/pr-pre-merge.sh` 一体化验证（typecheck → lint → test，任意步骤 FAIL 即 exit 非 0）。与 pr-cr-fix skill 阶段 3b 共用同一个 gate 脚本，行为一致。

```bash
bash scripts/pr-pre-merge.sh
```

**Gate 语义 [MANDATORY]**：
- exit 0 = 全绿，继续下一步
- exit 非 0 = 有步骤失败，**必须修复后才能 push**。看输出的 `FAIL <step>` 行定位失败步骤（typecheck:extensions / lint / test:extensions / test:runtime / test:renderer），修复对应代码后重跑 `pr-pre-merge.sh` 直到全绿
- **禁止** `SKIP_*` 环境变量、`--no-verify`、`eslint-disable`、删 pre-commit 等绕过手段。检查不通过 = 流程中止，唯一的出路是修复代码让检查通过

**说明**：
- build 默认跳过（`PR_PRE_MERGE_SKIP_BUILD=1`），Electron build 耗时，CI 会跑完整打包
- changeset 完整性检查由 pr-pre-merge.sh Step 5 覆盖（见下方「changeset 说明」）

**[MANDATORY] changeset 说明**

pr-pre-merge.sh Step 5 会自动检测 changeset 完整性（改了 `extensions/*/src/` 但无对应 changeset → 输出 `WARN`，**不导致 FAIL**）。看到 WARN 时：

- **需要发布** → 运行 `pnpm changeset` 创建声明文件（声明包名 + patch/minor/major），commit 后重跑 pr-pre-merge.sh
- **纯文档/测试/重构改动，不需要发布** → 可忽略。但建议运行 `pnpm changeset add --empty` 创建空 changeset，避免 merge 时 `changeset version` 误报

⚠️ **缺失 changeset 的后果**：merge 阶段 4N 的 `changeset version` 不会 bump 该包版本 → `changeset publish` 不会发布 → bug fix 静默丢失。

### 2. 提交改动

```bash
# 查看当前改动
git status
git diff --stat

# 提交(确保 message 清晰描述改动)
git commit -m "<描述性 commit message>"
```

### 3. 自动生成 PR title 和 body

**[MANDATORY] 自动从分支所有 commit 生成，无需用户提供。全部使用英文。**

流程：
1. 收集分支相对于 base（main）的所有 commit：
   ```bash
   git log main..HEAD --format="%s%n%b---"
   git diff main..HEAD --stat
   ```
2. 分析所有 commit message 和变更文件，总结本次 PR 的核心改动
3. 生成 PR title：
   - 格式：`fix(scope): short summary` 或 `feat(scope): short summary`（conventional commit 风格）
   - 若涉及多个 scope，用最核心的那个，或用 `fix: short summary` 不带 scope
   - 简洁一行，概括整个分支的改动
4. 生成 PR body（英文）：
   - 用 `## Summary` 段落概括改动目的和内容
   - 用 `## Changes` 列表逐条列出各 commit 的关键改动（合并相关条目，不重复）
   - 若有 changeset 文件（`.changeset/*.md`），读取其内容一并展示
   - 包含 `## Test plan` 列出验证方式（如已有的 typecheck/test/lint 结果）

### 4. Push 并创建/更新 PR

**bare repo workspace 注意**：`origin` 指向本地 bare repo，GitHub 的 remote 叫 `github`。

推荐用 `scripts/pr-submit.sh` 一体化推送 + 创建/更新 PR：

```bash
# 方式 A：用 pr-submit.sh（自动检测 PR 是否已存在、仅内容变化时更新）
bash scripts/pr-submit.sh \
  --title "$PR_TITLE" \
  --body "$PR_BODY" \
  --base main

# 方式 B：直接 gh 命令（bare repo workspace 需显式指定 repo 和 head）
git push github HEAD

# PR 不存在时创建
gh pr create \
  --repo zhushanwen321/xyz-agent \
  --head "zhushanwen321:$(git branch --show-current)" \
  --title "$PR_TITLE" \
  --body "$PR_BODY"

# PR 已存在时更新（仅在 title/body 有变化时）
gh pr edit <PR_NUMBER> \
  --repo zhushanwen321/xyz-agent \
  --title "$PR_TITLE" \
  --body "$PR_BODY"
```

如果 worktree 内 `gh` 能自动发现 repo（`.git` 文件追溯到 bare repo），可省略 `--repo` 和 `--head`。

**force-push 场景**：如果分支已被 force-push 过（如 rebase 后），用 `--force-with-lease`：
```bash
git push github HEAD --force-with-lease
```

## [HISTORICAL] 禁止跳过检查

所有 githooks 和自动化检查（lint、ruff、脚本检查、pre-commit hook 等）报告的问题，**必须正面修复**。绝不允许通过 `SKIP_*` 环境变量、`--no-verify`、`eslint-disable`、`# noqa` 等方式绕过或静默。检查不通过 = 流程中止，唯一的出路是修复代码让检查通过。

此规则来源于多次事故：跳过检查掩盖了真实 bug，上线后才发现问题，修复成本远高于当时正面解决。

## 项目特化约束

- **Electron 打包验证**:本地 build 通过即可,全量 DMG/EXE 产物由 CI 生成
- **构建产物路径**:`apps/electron/dist/`,`.agents/skills/` 不参与构建
- **预发布检查脚本**（项目 `scripts/` 目录下）:
  - `scripts/preflight-check.sh` - 综合预检
  - `scripts/postbuild-validate.sh` - 构建后验证
  - `scripts/validate-runtime-bundle.sh` - 运行时 bundle 验证

## 注意事项

- PR 描述中应列出改动文件和改动原因
- 如有 breaking changes 必须在描述中标明
- 确保 `.agents/skills/` 目录的改动也纳入提交

### 可选：YAML / extension 规范校验

本 skill 目录含两个校验脚本，PR 创建前可按需运行：

```bash
# 校验 skill SKILL.md 的 frontmatter（name/description 必填，description 双引号包裹）
python3 .agents/skills/pull-request/validate-skill-yaml.py <skill-paths>

# 校验 extension package.json 的 pi 字段（pi.extensions/keywords/type）
python3 .agents/skills/pull-request/validate-extensions-yaml.py <extension-dirs>
```

修改了 `.agents/skills/` 或 `extensions/*/package.json` 时建议运行对应校验。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史经验总结的规则。来自实际事故和教训，经验证有效后固化为规则 | **不允许删除或削弱**。修改时只能在原有基础上补充，不能降低要求 |
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
