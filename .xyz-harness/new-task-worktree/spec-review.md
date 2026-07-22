# Spec Review · new-task-worktree

**审查方法**：禁读重建（派 fresh subagent 不读 specSections，仅从 objective + clarifyRecords 重建 spec，与初稿 diff）。

## 审查结论

初稿 spec 覆盖了核心流程（入口/modal/三态/立即生效/RPC/submitFirstMessage 零改动），但禁读重建揭示了 5 个遗漏点。其中 2 个 must-fix（影响核心可用性），3 个 should-fix（边界完整性）。

## 发现的问题

### [must-fix] SR1 · 分支名 git ref 合法性校验缺失

**维度**：completeness / reasonableness

**问题**：FR-2 只说「分支名空时创建按钮 disabled」，但没提 git ref 合法性校验。git worktree add 遇到非法 ref 名（含空格、`..`、`~^:`、以 `-` 开头、已存在分支名）会直接报错，前端应在提交前拦截，否则用户填了非法名走完 3 步进度才在 step 1 失败，体验差。

**修复**：FR-2 补充校验规则——分支名非空 + 合法 git ref（禁用 `..` / `~` / `^` / `:` / 空格 / 开头 `-`）+ 不与现有分支重名。校验失败时 input 边框转 danger + 行内提示 + 创建按钮 disabled。

### [must-fix] SR2 · 「目录已存在」case 在 spec FR 中未体现

**维度**：completeness

**问题**：demo ④态设计了「目录已存在 → 直接在此开始会话」的零摩擦复用路径，但 spec FR 没有对应条目。边界场景：用户首次创建失败（如 setup 脚本失败，worktree 目录已保留），重试时 `git worktree add` 因目录已存在而失败。spec 需明确这个 case 的处理。

**修复**：新增 FR 或在 FR-5 error 态补充——检测到 `git worktree add` 因目录已存在失败时，modal 转「已存在」态，提示「该 worktree 已存在，是否直接在此目录开始会话？」→ 选是则走 `flow.selectWorkspace(existingCwd)`（不重新创建）。

### [should-fix] SR3 · 超时阈值未写入 spec

**维度**：completeness

**问题**：CL2 answer 提了 120s timeout，但 spec FR 没体现这个边界。setup-worktree.sh 可能 hang（如 npm install 网络问题），需要超时机制。

**修复**：FR-3 progress 态补充——IShellRunner execute timeout 默认 120s，超时则杀进程 + 报错 + 保留 worktree 目录。

### [should-fix] SR4 · base 分支数据源未明确

**维度**：reasonableness

**问题**：FR-2 说 segmented control「当前分支 / origin/main」，但没说这两个值的数据来源。「当前分支」从哪读（session.gitBranch? GitInfoReader?）？「origin/main」是否需要 fetch？如果本地没有 origin/main ref 会怎样？

**修复**：FR-2 补充——「当前分支」从 `flow.gitInfo.branch` 读取；「origin/main」是固定字符串选项，实际传给 `git worktree add` 时若 origin/main ref 不存在则 fallback 到本地 main 分支。MVP 不做 dynamic base 分支列表（YAGNI）。

### [should-fix] SR5 · 跨窗口状态同步未评估

**维度**：completeness

**问题**：Electron 多窗口场景，A 窗口建了 worktree，B 窗口的 DirSelectPopover 最近列表是否刷新？现有 session list broadcast 机制是否覆盖 worktree 创建的目录？

**修复**：评估后若现有 `workspace.record` + broadcastSessionList 机制已覆盖（worktree 创建后调 `flow.selectWorkspace` 会触发 record），则标注「已由现有机制覆盖」；若不覆盖则纳入 out-of-scope 或新增 FR。倾向前者（selectWorkspace 已调 workspaceStore.record 热更新列表）。

## 未发现问题（重建担心但实际已覆盖）

- setup 脚本不存在的处理 → FR-6 方案 A 已覆盖
- 目录名映射规则 → FR-2 已覆盖（/ 转 -）
- service 不直接 spawn 的硬约束 → CL2 + FR-7 已覆盖
- submitFirstMessage 零改动 → FR-8 已覆盖
- 回滚策略 → D5 明确「不自动删除」，与重建 D-7 的「应回滚」是刻意相反选择（有理由，不矛盾）

## 第 2 轮审查（spec_review_fix 后确认）

5 个 issue 修复均已落进 spec（CL3 specSections）：

| Issue | 修复落点 | 状态 |
|-------|---------|------|
| SR1 分支名校验 | CL3 → FR-2 补全（git ref 合法性 + 重名 + danger 边框） | 已闭环 |
| SR2 目录已存在 | CL3 → FR-5 补全（已存在态 + selectWorkspace 复用）+ D9 | 已闭环 |
| SR3 超时 | CL3 → FR-3 补全（120s timeout + 保留目录）+ D10 | 已闭环 |
| SR4 base 数据源 | CL3 → FR-2 补全（flow.gitInfo.branch + origin/main fallback）+ D8 | 已闭环 |
| SR5 跨窗口同步 | 评估结论：已由 selectWorkspace → workspaceStore.record 覆盖 | 已闭环 |

决策树完整对齐：D1-D10 全部有理由记录，无悬空分支。spec 可进 plan 阶段。
