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

**适用条件**：当前主 agent 是 pi agent，且能执行 `.pi/workflows/` 下的 workflow
（检测：pi CLI 可用 + 主 agent 支持 workflow 调用）。

**执行**：跑 `review-fix-loop.js` workflow（5 agent 并行 → 聚合 → 修 → 重审，直到 clean 或 maxRounds）：

```bash
# 主 agent 调用 pi workflow（参数可调）
# maxRounds 默认 10；skipFallow 默认 true（未装 fallow 时跳过）；baseRef 默认 main
# model 可选，不传则用当前会话模型
pi workflow run .pi/workflows/review-fix-loop.js --args '{maxRounds:10, baseRef:"main", skipFallow:true}'
```

workflow 内部逻辑（详见 `.pi/workflows/review-fix-loop.js`）：
- 可选 fallow pre-scan（Scan phase，单独预先跑）
- 5 agent 全并行单批 `parallel()`（Review phase，无 worktree 约束不需分批）
- aggregator 聚合去重，产出 `aggregated.md` + `must_fix` 计数
- `must_fix === 0` 判 clean；否则 fix agent 批量修复并 commit，进入下一轮
- S1 conservative：连续 2 轮 clean 的 agent 会被跳过；任何 fix 全部重新启用
- stuck 检测：连续 3 轮问题数不降则停

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
npm list -g @sourcemeta/fallow 2>/dev/null || npm install -g @sourcemeta/fallow
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

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
