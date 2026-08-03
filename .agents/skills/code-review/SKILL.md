---
name: code-review
description: >-
  审查代码变更。触发词："review"、"审查代码"、"code review"、
  "帮我看看代码"。仅用于 xyz-agent 项目。
---

# code-review（协调器）

审查当前 worktree 的代码变更，聚焦 xyz-agent 的
Electron + Vue 3 + TypeScript + Node.js Runtime 架构。

本 skill 是**协调器**：维度审查已拆分为 5 个独立 review agent
（`.agents/agents/review-*.md`），由本 skill 按「双路径」编排调度。
两种路径共用同一批 agent 实体和维度映射，差异只在编排机制。

## 启动方式

```bash
# 查看待审查的变更范围
git diff main...HEAD --stat
```

## [MANDATORY] 双路径选择

执行 review 前，**必须先判断当前运行环境**，选对应路径：

### 路径 1：pi 环境（有 pi workflow 能力）

**适用条件**：当前主 agent 是 pi agent，且能调用内置 workflow
（检测：pi CLI 可用 + 主 agent 支持 workflow 调用）。

**执行**：跑内置 `review-fix-loop` workflow（5 agent 并行 → 聚合 → 修 → 重审，直到 clean 或 maxRounds）：

```bash
# 主 agent 调用内置 workflow（用名字，不用文件路径）
# targetType=git-diff + target=<baseRef> 指定审查 git 变更
# batch1 传入 5 个维度 agent（pi 从 .agents/agents/review-*.md 解析实体）
# autoCommit=true：fix 后自动 commit（与旧定制版行为一致）
# recheckAfterFix=true：fix 后重审全部 agent（回归防护，等价旧版 reactivateAll）
# skipCleanAgents=true：单轮 clean 的 agent 下轮跳过（省 token）
# maxRounds 默认 10；model 可选，不传则用当前会话模型
pi workflow run review-fix-loop --args '{
  targetType: "git-diff",
  target: "main",
  batch1: "review-arch-boundary,review-business-logic,review-type-safety,review-electron-build,review-test-coverage",
  maxRounds: 10,
  autoCommit: true,
  recheckAfterFix: true,
  skipCleanAgents: true
}'
```

> **如何找到内置版**：内置 workflow 用**名字**调用（不带文件路径），pi 解析顺序为
> 「内置 → npm 包 `@zhushanwen/pi-subagent-workflow/workflows/` → 项目 `.pi/workflows/`」。
> 项目曾有一个同名定制版 `.pi/workflows/review-fix-loop.js` 会覆盖内置版，**现已删除**，内置版直接生效。
> `pi workflow list` 中名为 `review-fix-loop`（无 `.js` 路径后缀）的条目即内置版。

内置 workflow 行为（参数 → 效果）：
- **审查范围**：`targetType=git-diff` + `target=main` → 审查 `git diff main...HEAD`（含未提交的工作区改动）
- **维度 agent**：`batch1` 逗号分隔 5 个 agent 名，全并行单批 review（无 worktree 约束不需分批）。各 agent 的审查焦点已内置于 `.agents/agents/review-*.md` 正文，无需额外注入 focus
- **聚合**：内置 aggregator prompt 合并去重 5 份报告为 `aggregated.md` + `must_fix` 计数（workflow 自带，不依赖 `review-aggregator.md`）
- **clean 判定**：`must_fix === 0` 判 clean；否则 fix agent 批量修复并 `autoCommit` commit，进入下一轮
- **clean 跳过**（`skipCleanAgents`）：单轮 `must_fix===0` 的 agent 下轮跳过；`recheckAfterFix=true` 保证 fix 后重审全部 agent，覆盖"fix 引入回归"
- **stuck 检测**：连续 `stuckThreshold`（默认 3）轮问题数不降则停

> **与旧定制版的差异**（已接受）：旧定制版 S1 conservative 要求「连续 2 轮 clean」才跳过 agent，
> 内置版「单轮 clean」即跳过。配合 `recheckAfterFix=true`，"fix 引入回归"场景已被覆盖；
> 少审一轮换取 token 效率，对审查正确性无影响。

### 路径 2：非 pi 环境（手工编排，固定 2 轮）[本次新增]

**适用条件**：无 pi workflow 能力（ZCode / 其他 agent 框架 / 主 agent 手工编排）。
这是最常见路径——绝大多数 review 在非 pi 环境下触发。

**执行**：主 agent 用 Agent 工具手工编排，**固定 2 轮**（审 → 修 → 再审 → 修）。

#### 第 1 轮

**Step 1 — 确认变更范围**（主 agent 自己跑）：
```bash
git diff <baseRef>...HEAD --stat   # baseRef 默认 main，bare repo workspace 可改
```

**Step 2 — 并行派 5 个 reviewer subagent**（主 agent 在单条消息内并行，subagent_type 用 `reviewer`）：

每个 subagent 的 task 必须包含：
- worktree cwd（绝对路径，避免 multi-worktree cwd 陷阱）
- **focus**（见下方「维度 → Agent 映射」表，对应 agent 的审查焦点）
- `output 路径：<绝对路径>` + `Write report to: <绝对路径>`（双措辞兼容 agent 约定）
- 「审查 `git diff main...HEAD` 的全部变更」
- 「输出格式：YAML frontmatter（verdict/must_fix）+ Findings 表格（优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向），优先级用 MUST_FIX/SUGGESTION/INFO」
- 「完成后用 structured-output 返回 `{report_file, must_fix, suggestion}`」

5 个 subagent 全部 `action:"start"` 在同一消息发出（并行）。派发上限参考全局 AGENTS.md subagent 约束（≤5 个）。

**Step 3 — 主 agent 手工聚合**：
- 收集 5 个 subagent 的结构化结果（report_file + must_fix + suggestion）
- 按 (file, line, description) 三元组去重
- 按优先级排序（MUST_FIX → SUGGESTION → INFO）
- 写 `aggregated.md`（含 `## Summary` + `- Must-fix: N` + `- Suggestions: N` 行——格式关键，便于核对）

**Step 4 — 修复 MUST_FIX**（条件触发，`must_fix > 0` 时）：
- 参照全局 `cr-fix` skill：按文件归属分组，每组派 1 个 `worker` subagent 并行修复
- worker task 含：review 报告原文路径（worker 必须复读原文）+ 本组问题清单 + 「全部修复，不挑 level」+ 「修复后 `pnpm -r typecheck` 通过」
- 修复后 commit：`fix: review round 1 — N must-fix`

#### 第 2 轮（强制）

**不管第 1 轮是否 clean，第 2 轮都必须跑**——验证修复未引入回归。

重复第 1 轮的 Step 2-4（并行 review → 聚合 → 若有 must_fix 则修复）。

**第 2 轮结束即终止**。手工编排下每轮成本高，2 轮（审→修→再审→修）已覆盖绝大多数回归；
不像 pi workflow 那样追求 10 轮内的彻底 clean。第 2 轮残留的 MUST_FIX 直接报告给用户决策。

> **为什么固定 2 轮**：路径 2 的成本/收益平衡点。第 1 轮发现问题，第 2 轮验证修复——这是回归防护的最小完整单元。更多轮需要自动化编排支撑（即路径 1 的 workflow），手工派发的边际收益递减。

## 维度 → Agent 映射（两路径共用）

| 维度 | Agent 实体 | 审查焦点 |
|------|-----------|---------|
| 架构边界 | `review-arch-boundary` | Electron 分层（main/preload/renderer/shared）、runtime 三层（transport/services/infra）、WS session 隔离、IPC/emit 规范、数据目录隔离、路径白名单动态化、ENV SSOT、Extension vs Plugin 边界、v3 视图拓扑 |
| 业务逻辑 | `review-business-logic` | 逻辑正确性、边界条件、异常路径、回归风险、错误状态重置（isGenerating/streamingMessage）、emit 单 payload、Promise.allSettled、streaming 生命周期、session 双状态、文件持久化与 Store 同步 |
| 类型安全 | `review-type-safety` | 完整类型标注、禁止 any（显式/隐式）、类型守卫、tsc/vue-tsc、Pi* 类型分层约束（仅 infra 层可见） |
| Electron 打包 | `review-electron-build` | tsup 配置（noExternal/Worker entry/CJS 兼容）、electron-builder（files/asarUnpack/symlink）、子进程启动、打包验证三阶段 |
| 测试覆盖 | `review-test-coverage` | 新增逻辑有测试、边缘情况覆盖、vitest 合规（禁 node:test）、领域测试点（session 双状态/Extension vs Plugin/ports 接口） |

每个 agent 的完整 checklist 见 `.agents/agents/review-<维度>.md`。

## 严重度分级（与 agent 实体统一）

- **MUST_FIX** — 必须修复，阻塞合并。对应架构约束违规、会导致 bug、违反 [HISTORICAL] 规则的问题。
- **SUGGESTION** — 强烈建议修复。不阻塞但影响代码质量、可维护性。
- **INFO** — 可选改进。代码风格、文档、轻微的品味问题。

> 与旧版 SKILL 的对应：BLOCKER → MUST_FIX，WARNING → SUGGESTION，旧 SUGGESTION → INFO。

## [OPTIONAL] 直接审查（降级路径）

当**无 subagent 派发能力**（或改动极小不值得编排）时，主 agent 可按以下 checklist
自行审查。这是降级路径，覆盖深度不如双路径编排。

### 1. Vue 3 组件规范

- [ ] Composition API + `<script setup>`（禁止 Options API）
- [ ] 模板中禁止直接调用方法做副作用，用 `computed` / `watch` 替代
- [ ] props 用 `defineProps<T>()`，不用无类型版
- [ ] 无内联 styles，用 scoped CSS（仅 Transition/伪元素等 escape hatch）或 Tailwind 类
- [ ] `<template>` ≤ 400 行，`<script setup>` ≤ 300 行

### 2. TypeScript 类型安全

- [ ] 禁止 `any`，用 `unknown` 或具体类型
- [ ] 事件回调参数有明确类型注解
- [ ] 接口定义完整，不在运行时拼凑类型

### 3. Event Bus 防重复注册

- [ ] listener 注册使用 refCount 保护（`addEventListener` / `on` 配对）
- [ ] 组件 unmount 时清理所有 listener
- [ ] 无遗漏的 `removeEventListener` / `off`

### 4. Emit 规范

- [ ] `emit` 只传单个 payload 对象：`emit('update', { id, value })`
- [ ] 禁止 `emit('event', arg1, arg2)` 多参数模式
- [ ] payload 类型用 interface 定义

### 5. UI 状态错误重置

- [ ] 错误路径必须重置 `isGenerating` / `streamingMessage` 等加载状态
- [ ] `finally` 块或显式 error handler 中清理状态
- [ ] 无可能的无限加载态

### 6. 代码质量

- [ ] 无死代码（unused imports / variables）
- [ ] 无 console.log 残留
- [ ] 无硬编码的 magic numbers / strings

### 7. 代码质量扫描（fallow）

在人工审查前，运行 fallow 静态分析获取基线数据：

```bash
pnpm list -g @sourcemeta/fallow 2>/dev/null || pnpm add -g @sourcemeta/fallow
fallow scan $(git diff main...HEAD --name-only)
```

关注：复杂度热点（函数 > 80 行 / 圈复杂度 > 15）、重复代码、未使用导出、循环依赖。

### 8. Electron IPC 安全

- [ ] 通过 preload 桥接，不直接 `require('electron')` 在渲染进程
- [ ] contextBridge 暴露的 API 最小化
- [ ] 无 IPC 通道暴露敏感操作（文件系统全访问、shell 执行等）

### 9. 测试覆盖

- [ ] 新增功能有对应测试
- [ ] 关键路径有边界条件测试
- [ ] 测试描述清晰，不依赖顺序执行

## 审查输出格式

审查结果按严重程度分级：

1. **MUST_FIX** — 必须修复，阻塞合并
2. **SUGGESTION** — 强烈建议修复
3. **INFO** — 可改进，不阻塞

每条条目格式：
```
[SEVERITY] file:line — 问题描述
  → 建议修复方式
```

---

## Pi Extension 接口契约 Checklist

> 以下 checklist 来源于实际 bug 复盘（session_start handler 读错参数、subagent 工具 schema 与描述矛盾）。
> 审查 `extensions/` 目录下的 pi extension 代码时 `[MANDATORY]` 逐条核对。

### 1. SDK 接口契约核对 `[MANDATORY]`

凡调用 `pi.on(...)`、`pi.registerTool(...)`、`pi.registerCommand(...)`、读 `ctx.*` 的代码：

- [ ] **handler 参数签名**：`pi.on(event, handler)` 的 handler 必须对照真实 SDK 的 `ExtensionHandler<E> = (event: E, ctx: ExtensionContext) => ...` 签名。**两个参数**——`modelRegistry`/`cwd`/`ui`/`sessionManager` 在第二个参数 `ctx` 上，不在 event 上。
- [ ] **真实 SDK 类型核对**：打开 `node_modules/@earendil-works/pi-coding-agent/dist/` 对照，不能只凭记忆写签名（SDK 版本升级后 API 可能变）。本项目根 devDependencies 已安装 `@earendil-works/pi-coding-agent@0.82.1`。
- [ ] **ctx.mode 分支**：xyz-agent 以 `--mode rpc` 运行 pi，`ctx.mode === "rpc"`。TUI 相关 API（`ctx.ui.setWidget`、`ctx.ui.custom`、`renderResult`）在 RPC 模式下失效。需要 GUI 渲染参阅 `docs/extensions/gui-protocol-guide.md`。

### 2. spec 偏差记录 `[MANDATORY]`

- [ ] 新增/修改的功能需求是否有对应的 spec 条目？无 spec 的功能不应直接实现。
- [ ] 实现与 spec 描述如有偏差，必须在 spec 末尾「实现偏差说明」补 D 编号记录（决策 + 原因）。偏差记录不是自愿的——未记录的偏差等于违反 spec。

### 3. schema / 描述一致性 `[MANDATORY]`

`registerTool` 的 `parameters` schema 与 `description`/`promptGuidelines` 必须一致：

- [ ] schema 必填字段（无 `Optional` 包裹）是否在所有执行模式下都真的必填？若某模式会忽略其他参数，被忽略的参数不应是 schema 层必填——否则 LLM 被迫传占位值。
- [ ] 条件必填场景：schema 设为 Optional，在 `execute()` 内根据模式做运行时校验（抛清晰错误）。
- [ ] `description` 中 "Ignores X/Y/Z" 之类的描述，必须与 schema 实际行为一致。

### 4. 类型断言（配合 taste/no-unsafe-cast） `[MANDATORY]`

`no-unsafe-cast` 规则会 warn 标记 `as never`/`as any`/`as unknown as`/全可选结构断言。审查时：

- [ ] 每处 warn 的断言，确认是否有**不可替代的理由**（如跨 tsconfig 泛型冲突、SDK 类型 stub 缺失）。
- [ ] 不可替代的断言，必须有配套的**运行时 guard**（参数判空抛错）或**契约测试**兜底——不能让类型断言成为唯一防线。

---

## 与 pr-cr-fix / review agent 的关系

本 skill 是**主会话自查的 checklist**（非 PR 触发），适用于快速 review 当前改动。

对于完整的 PR 级 review（review→fix→PR 统一编排），使用 `pr-cr-fix` skill，它会调度 `.agents/agents/` 下的 7 个 review agent 并行审查（arch-boundary / business-logic / electron-build / extension-api / monorepo-impact / test-coverage / type-safety）+ 1 个聚合器。

| 场景 | 用哪个 |
|------|--------|
| 快速自查当前改动（不提 PR） | 本 skill（code-review checklist） |
| PR 级多维 review + 自动修 must-fix + 推 PR | pr-cr-fix skill |

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
