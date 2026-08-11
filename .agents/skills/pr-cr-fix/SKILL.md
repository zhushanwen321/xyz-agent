---
name: pr-cr-fix
description: >-
  Use when finishing a worktree branch and wanting all three — open the PR,
  run a multi-dim review on its diff, fix must-fix issues, and re-push —
  in one coordinated run. Triggers "review and open PR", "review 完开 PR",
  "把 review 问题修了开 PR", "pr-cr-fix", "review → PR". 路由 skill：PR 操作委托
  pull-request，review+fix 委托 code-review（路径 1 调 review-fix-loop workflow）。
  Only for xyz-agent worktree. Not for non-PR review (use code-review skill),
  not for raw PR submission without review (use pull-request skill), not for
  other projects.
---

# Pr-Cr-Fix — 路由 skill：开 PR → review+fix → 推 PR

3 阶段 PR 生命周期编排。本 skill 是**路由 skill**，不自行编排 review：

- PR 操作（开 PR / 推 update）→ 委托 `pull-request` skill
- review + fix → 委托 `code-review` skill（路径 1 调 `review-fix-loop` builtin workflow）

本 skill 只做阶段编排 + Gate 校验。review 的 SSOT 是 code-review，执行引擎是 review-fix-loop workflow。

## 前置条件 [MANDATORY]

- xyz-agent git worktree 中
- 当前分支相对 main 有 commits（`git log main..HEAD` 非空）

## 调用约定

- `cwd`：git 根目录绝对路径（`git rev-parse --show-toplevel`）
- 阶段 1 / 3a 派 subagent 执行；阶段 2 由主 agent **直接**派 workflow（不经 subagent 封装，见 code-review 路径 1 [MANDATORY]）；主 agent 全程只做编排 + Gate 校验
- review-fix-loop workflow 自带 run 目录与 aggregated 报告，本 skill 不另定义 runId/路径

## 流程

### 阶段 1：打开 PR（路由 pull-request）

```text
agent:     "general-purpose"
skillPath: "<skill 目录>/pull-request/SKILL.md"
cwd:       <git 根>
task:      "按 pull-request SKILL.md 开 PR；返回 JSON { pr_url, force_push }"
```

**Gate-1**：`pr_url` 匹配 `^https://github\.com/.+/pull/\d+$`。`force_push=true` 时，阶段 3b 推 PR 加 `--force-with-lease`。

### 阶段 2：review + fix（路由 code-review）

**不派 subagent**。主 agent 直接读 code-review SKILL.md（`<skill 目录>/code-review/SKILL.md`），按其【路径 1：pi 环境】执行：直接用 workflow 工具跑 `review-fix-loop`（args 以 code-review SKILL 路径 1 的配置为准——batch1 七个 review agent 的 .md 绝对路径、autoCommit=true 等）。

workflow 自动 review → aggregate → fix → 重审直到 clean/converge/stuck；notifyDone 自动注入结果，主 agent 取 `terminated/rounds/aggregated_file`。

**Gate-2**：workflow `terminated` ∈ {`clean`, `converged`, `stuck`} → 进阶段 3。`terminated=needs-redesign` = 结构性问题需人工介入，**停手上报用户**。

> review-fix-loop 的 `autoCommit=true` 会自动 commit fix。本 skill **不手动分组 fix**（review+fix 全权委托 workflow）。

### 阶段 3：pre-merge + 推 PR

#### 3a — pre-merge 验证

```text
agent: "general-purpose"
cwd:   <git 根>
task:  "跑 bash scripts/pr-pre-merge.sh --quiet
        （按序 typecheck → lint → test：extensions + runtime + renderer；全绿写 .review/premerge-result marker result=PASS；任意 FAIL 写 result=FAIL 非零退出）。
        禁止 --no-verify / SKIP_LINT=1 / SKIP_EXTENSION_LINT=1。
        完成后返回 JSON { result: 'PASS'|'FAIL', failed_step?, changeset_missing? }"
```

**Gate-3a**（硬 gate）：`result === 'PASS'` 才继续。FAIL 按 `failed_step` 对应工种重派 worker 修复后重跑 pr-pre-merge.sh。

**Gate-3a.5**（changeset 软提醒）：`changeset_missing` 非空（extension 改了 src/ 但无 changeset）→ AskUserQuestion：现在补 changeset（推荐）/ 跳过直接推。

#### 3b — 推 PR（主 agent 直接 commit + push）

PR 已在阶段 1 开好，**同分支 push 即自动更新 PR**，无需派 subagent / 加载 pull-request skill（`pr-submit.sh` 适合首次开 PR 或需把 aggregated 报告作为 PR comment；更新已有 PR 用纯 git push）。主 agent 直接：

1. commit 剩余改动（若有，如本 skill 自身的修改）
2. `git push github HEAD:<branch>`（`force_push=true` 时加 `--force-with-lease`）

push 后可选跑 `scripts/pr-status.sh`（只读）确认 PR 健康。

**Gate-3 双层判定**：

| 层 | 判定 | 来源 |
|----|------|------|
| 硬 gate | `stage0_pr.pr_exists && stage0_pr.local_ahead_of_origin == 0 && stage2_premerge.result == "PASS"` | `pr-status.sh` 的 `ready_to_submit` |
| 软 gate | 阶段 2 workflow `terminated` 非 `needs-redesign` + 阶段 3a pre-merge PASS | workflow 结果 + Gate-3a |

## 关键约束 [MANDATORY]

1. **阶段顺序不可调换**：1 (PR) → 2 (review+fix) → 3 (pre-merge + 推)
2. **主 agent 不跑 review/fix 实现命令**：review 委托 code-review（workflow）。但 PR 生命周期操作（commit / push / pr-status.sh / pr-pre-merge.sh）主 agent 可直接跑——简单命令、输出少，派 subagent 反而浪费 context
3. **review 委托 code-review，不自行编排**：禁止手写 review subagent 并行/分批/aggregate，**也禁止派 subagent 封装 workflow**（subagent 内再调 review-fix-loop 是多余中转）——workflow 由主 agent 直接用 workflow 工具派（code-review 路径 1 [MANDATORY]）。review 执行引擎是 review-fix-loop workflow，编排 SSOT 是 code-review skill
4. **force-push 决策传递**：阶段 1 `force_push=true` → 阶段 3b 必须用 `--force-with-lease`
5. **禁止 skip 开关**：`SKIP_LINT=1` / `SKIP_EXTENSION_LINT=1` / `--no-verify` / `git push --force`
6. **pr-pre-merge.sh 是 stage2 marker 唯一写入方**：阶段 3a 必须调它，不能直接跑 `npx vitest run` 替代（marker 不写则 Gate-3 stage2 恒 not_run）

## 反模式

| 反模式 | 后果 |
|--------|------|
| 主 agent 自己跑 pr-submit.sh / pr-pre-merge.sh | 浪费主 agent 上下文；派 subagent |
| 阶段 2 手写 review subagent 并行/分批（绕过 code-review） | 复现 review-fix-loop workflow 已有能力，漂移风险；违反规则 #11（模式名先锚定可执行 workflow 入口） |
| 阶段 2 派 subagent 封装 workflow（subagent 内再调 review-fix-loop） | 多一层无增益中转、白耗 context；违反 code-review 路径 1 [MANDATORY]「主 agent 直接派」 |
| 阶段 3a 直接跑 vitest 替代 pr-pre-merge.sh | marker 不写，Gate-3 stage2 恒 not_run |
| 阶段 2 后再手动分组 fix（旧阶段 3a 手写编排） | 与 review-fix-loop 的 autoCommit fix 重叠冲突；fix 已由 workflow 完成 |
| 删/改 code-review SKILL.md 或 review-*.md | 破坏 review 维度完整性 |

## 失败恢复

| 失败 | 动作 |
|------|------|
| Gate-1 拿不到 URL | 重试阶段 1 subagent；gh 认证问题先 `gh auth login` |
| Gate-2 `terminated=needs-redesign` | 结构性问题，上报用户决策（不自动重试） |
| Gate-2 `terminated=stuck` | 连续 N 轮 must_fix 不降，看 aggregated.md 判断是 reviewer 误报还是真问题；误报可人工 ack 后进阶段 3，真问题上报用户 |
| Gate-3a pre-merge FAIL | 按 `failed_step`（typecheck/lint/test:*）重派 worker 修复后重跑 pr-pre-merge.sh |
| 阶段 3b push 冲突 | `git fetch && git rebase` 后重试 |

## 与现有 skill 的关系

| skill | 关系 |
|-------|------|
| `pull-request` | 阶段 1 路由目标（开 PR）。阶段 3b 推 update 不需要——已有 PR 同分支 push 即更新 |
| `code-review` | 阶段 2 路由目标（review+fix 编排；双路径：pi 环境调 review-fix-loop workflow / 非 pi 手工 2 轮） |
| `review-fix-loop` | code-review 路径 1 调用的 builtin workflow（review → aggregate → fix → 重审，review 的执行引擎） |

> 三层职责：pr-cr-fix = PR 生命周期编排；code-review = review 编排 SSOT（维度映射 + 双路径）；review-fix-loop = review 执行引擎（builtin workflow）。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求，不遵守会导致 gate 失效 | 必须严格遵守 |
