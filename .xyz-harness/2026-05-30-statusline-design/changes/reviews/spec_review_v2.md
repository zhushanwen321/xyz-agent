---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-30T23:00:00"
  target: ".xyz-harness/2026-05-30-statusline-design/spec.md"
  verdict: pass
  summary: "Spec 评审第 2 轮，4 条 MUST FIX 全部已修复，0 条 open MUST FIX，评审通过"

statistics:
  total_issues: 10
  must_fix: 0
  must_fix_resolved: 4
  low: 3
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-1, FR-2, AC-1"
    title: "setStatus 数据流路径歧义：两条并行通道未指定前端主通道"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md:AC-5"
    title: "Session Strip vs Global Statusbar 的 chip 路由规则缺失"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR-3 (Thinking level picker)"
    title: "Thinking level 6 级定义与现有 ModelInfo.thinkingLevelMap 类型不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: MUST_FIX
    location: "spec.md:FR-3 (Model picker)"
    title: "Model picker 选择后的生效机制未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "spec.md:FR-6"
    title: "updateStatusBarItem 新增参数的向后兼容性未声明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 6
    severity: LOW
    location: "spec.md:FR-4 (Cost)"
    title: "Cost 数据来源 chatStore.cost 的计算和存储逻辑未说明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 7
    severity: LOW
    location: "spec.md:FR-5, AC-4"
    title: "commandId 对应的命令注册和执行机制未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 8
    severity: INFO
    location: "spec.md:Constraints"
    title: "bridge:event 修复在 Constraints 提到但无对应 FR"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 9
    severity: INFO
    location: "spec.md:AC-1"
    title: "AC-1 '1 秒内'的性能要求缺乏自动化验证方法"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 10
    severity: INFO
    location: "spec.md:FR-2"
    title: "statusline plugin 对 setStatus 文本的解析规则未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-30 23:00
- 评审类型：计划评审（Spec 增量审查，第 2 轮）
- 评审对象：`.xyz-harness/2026-05-30-statusline-design/spec.md`
- 审查模式：增量审查——验证第 1 轮 4 条 MUST FIX 是否已修复，检查修复是否引入回归

---

## MUST FIX 修复验证

### #1 [FIXED] 数据流路径歧义

**v1 问题**：两条并行通道（`extension.status_update` 直接广播 vs `plugin:statusBarUpdate` 经过 plugin），未选定主通道，AC-1 第三条与架构图矛盾。

**v2 修复验证**：

| 检查点 | 结果 | 证据 |
|--------|------|------|
| 唯一前端通道声明 | ✅ | 架构图下方关键设计决策 #1："前端只监听 `plugin:statusBarUpdate` 一种消息类型" |
| event-adapter 不直接广播 | ✅ | FR-1 明确："该消息**不直接广播到前端**，而是由 `server.ts` 路由到 `pluginService`" |
| WS 命名约定合规 | ✅ | event-adapter 翻译为 `plugin:statusSetUpdate`（冒号格式），不再是 `extension.status_update`（点号格式） |
| AC-1 修正 | ✅ | AC-1 第 4 条改为"前端通过 `plugin:statusBarUpdate` 消息（唯一通道）接收数据" |
| 端到端路径收敛 | ✅ | pi → RPC → event-adapter → `plugin:statusSetUpdate` → statusline plugin → `plugin:statusBarUpdate` → 前端 |

**结论：已修复。** 数据流路径已收敛为唯一通道 `plugin:statusBarUpdate`，符合 CLAUDE.md WS 命名约定（冒号格式）和 Plugin Service 架构约束。

---

### #2 [FIXED] chip 路由规则缺失

**v1 问题**：AC-5 要求 chip 二选一显示但未定义路由规则，AC 不可验证。

**v2 修复验证**：

| 检查点 | 结果 | 证据 |
|--------|------|------|
| scope 字段定义 | ✅ | 映射表定义了 6 个已知 key 的 scope（goal/todo/workflow → per-session；preset/ssh/model → global）+ 未知 key 默认 scope=global |
| scope 字段传递链 | ✅ | FR-2: plugin 查表获取 scope → FR-6: `updateStatusBarItem()` 新增 `scope` 参数 → 前端通过 `plugin:statusBarUpdate` 接收 scope |
| AC-5 路由规则 | ✅ | AC-5 明确定义：`scope=per-session` + sessionId → Session Strip；`scope=global` → Global Statusbar |
| FR-4/FR-5 消费端 | ✅ | FR-4："来自 pluginStore 中 `scope=per-session` 且 `sessionId` 匹配当前 panel"；FR-5："来自 pluginStore 中 `scope=global`" |

**结论：已修复。** scope 字段从 statusline plugin 映射表 → statusBarUpdate payload → 前端路由，链路完整。AC-5 可测试。

---

### #3 [FIXED] Thinking level 6 级与 thinkingLevelMap 冲突

**v1 问题**：Spec 定义了固定 6 级 thinking level，与代码库中 `ModelInfo.thinkingLevelMap: Record<string, string|null>` 的动态映射类型冲突。

**v2 修复验证**：

| 检查点 | 结果 | 证据 |
|--------|------|------|
| 删除固定枚举 | ✅ | FR-3 不再有 6 级枚举定义，改为"可选级别从当前 model 的 `ModelInfo.thinkingLevelMap`（`Record<string, string|null>`）动态读取 keys，不硬编码枚举" |
| 空值处理 | ✅ | "`thinkingLevelMap` 为空或 model 无此字段时隐藏 picker" |
| AC 同步更新 | ✅ | AC-2 包含"Thinking level picker 的可选级别从 `ModelInfo.thinkingLevelMap` 动态读取，不硬编码" + "为空时 picker 自动隐藏" |
| 数据来源明确 | ✅ | "数据来源：modelStore（model 列表 + thinkingLevelMap）" |

**结论：已修复。** Thinking level picker 现在完全动态化，与 `ModelInfo.thinkingLevelMap` 类型一致，无硬编码枚举。

---

### #4 [FIXED] Model picker 行为未定义

**v1 问题**：Model picker 选择新模型后如何生效（RPC 命令、session 影响、失败回退）未定义。

**v2 修复验证**：

| 检查点 | 结果 | 证据 |
|--------|------|------|
| 切换命令 | ✅ | "选择新模型后发送 `session.switchModel` 命令到 sidecar → sidecar 通过 pi RPC `set_model` 切换" |
| 对 session 影响 | ✅ | "切换仅影响当前 session 的后续请求，不重启 session" |
| 失败回退策略 | ✅ | "切换失败时恢复原模型显示并显示 toast 错误提示" |
| AC 覆盖 | ✅ | AC-2: "Model picker 显示当前 modelId...选择后通过 `session.switchModel` 切换" + "切换失败时恢复原模型显示并显示 toast 错误提示" |
| UC 覆盖 | ✅ | UC-3 描述了完整的用户交互流程 |

**结论：已修复。** Model picker 的完整行为链（命令 → 生效范围 → 失败回退）已定义，AC 可测试。

---

## LOW 级问题处理验证

### #5 [FIXED] 向后兼容性声明

FR-6 现包含明确声明："**向后兼容**：新增参数均为 optional，现有 plugin 调用 `updateStatusBarItem(id, text)` 不传新参数时行为不变（priority=100, scope=global）"。AC-6 也同步覆盖。

### #6 [FIXED] Cost 数据来源

FR-4 的 Cost 描述已改为："暂不实现。当前 chatStore 没有现成的 cost 字段，pi 也不直接返回费用。待后续 model 定价数据就绪后再加入。此处预留位置（不渲染，不占空间）。" Constraints 也列出"Cost 暂不实现"。清晰合理。

### #7 [FIXED] commandId 机制

FR-5 现包含："commandId 的注册和执行机制复用现有 plugin command 系统（Phase 3 已实现）"。指向已有实现，无需重新定义。

---

## INFO 级问题处理验证

### #8 [FIXED] bridge:event 修复无对应 FR

FR-1 已扩展为同时覆盖 setStatus 接入和 bridge:event 修复："同时修复 `server.ts` 中 `bridge:event` case（当前只 `console.log`），改为调用 `pluginService.handleBridgeEvent(eventName, data, sessionId)`。" 并新增 AC-8 专门验证 bridge:event 修复。

### #9 [FIXED] "1 秒内"性能要求

AC-1 已改为"前端在下一个渲染帧内显示对应文本"，去掉了不可自动验证的"1 秒"时间约束。

### #10 [FIXED] setStatus 文本解析规则

FR-2 明确声明："**不做文本解析**：pi extension 的 setStatus 文本直接透传，不做正则匹配或结构化解析。plugin 只附加 metadata，不改变文本内容。"

---

## 回归检查

本轮检查修复是否引入新问题：

| 检查维度 | 结果 | 说明 |
|----------|------|------|
| FR 覆盖完整 | ✅ | FR-1 到 FR-7 完整，bridge:event 修复纳入 FR-1 |
| AC ↔ FR 一致 | ✅ | AC-1 到 AC-8 覆盖所有 FR，无悬空 AC |
| 新增 FR-6 scope/sessionId 参数 | ✅ | 与 CLAUDE.md 规则 7（所有消息必须带 sessionId）一致 |
| 架构图一致性 | ✅ | 架构图与文字描述一致：pi → event-adapter → plugin hooks → statusBarUpdate → 前端 |
| Constraints 一致 | ✅ | 新增 "Cost 暂不实现" 约束与 FR-4 一致 |
| WS 命名约定 | ✅ | 全部使用冒号格式：`plugin:statusSetUpdate`、`plugin:statusBarUpdate` |
| Session 隔离 | ✅ | FR-1 payload 包含 sessionId；FR-4 按 sessionId 路由；FR-6 scope 区分 per-session/global |
| 未知 key 容错 | ✅ | 映射表有默认值（priority=100, scope=global） |

**未发现回归问题。**

---

## FR ↔ AC 覆盖矩阵（更新版）

| FR | AC | 覆盖状态 | 备注 |
|----|-----|---------|------|
| FR-1: Event-adapter 接入 setStatus + bridge:event 修复 | AC-1, AC-8 | ✅ | 数据流路径唯一，bridge:event 有独立 AC |
| FR-2: statusline built-in plugin | AC-1 | ✅ | 纯透传文本，附加 metadata |
| FR-3: Input Toolbar | AC-2 | ✅ | thinking level 动态化，model picker 行为完整 |
| FR-4: Session Strip | AC-3 | ✅ | cost 暂不实现已声明 |
| FR-5: Global Statusbar 重构 | AC-4 | ✅ | commandId 复用现有系统 |
| FR-6: Plugin statusBarUpdate 增强 | AC-5, AC-6 | ✅ | 向后兼容性已声明 |
| FR-7: Built-in Plugin 开发指南 | AC-7 | ✅ | — |

---

## 架构合规性（更新版）

| CLAUDE.md 架构规则 | Spec 合规性 | 说明 |
|---|---|---|
| **规则 5：pi 适配层不信任外部格式** | ✅ | event-adapter 是唯一适配点，翻译 setStatus |
| **规则 7：所有消息必须带 sessionId** | ✅ | FR-1 payload 包含 sessionId；FR-6 scope/sessionId 参数完整；FR-4 按 sessionId 过滤 |
| **规则 11：Plugin Service 是唯一适配层** | ✅ | 前端只监听 `plugin:statusBarUpdate`，经过 PluginService |
| **WS 命名约定：Server→Client 用冒号** | ✅ | `plugin:statusSetUpdate`、`plugin:statusBarUpdate` 均为冒号格式 |
| **数据目录隔离** | ✅ | built-in plugin 在 `resources/plugins/`，不涉及 pi 目录 |
| **前端编码规范** | ✅ | Constraints 引用 xyz-ui、Tailwind、行数上限 |

---

## 结论

**通过。**

第 1 轮的 4 条 MUST FIX 全部已修复，修复质量高，无回归问题。Spec 的数据流路径已收敛为唯一通道（`plugin:statusBarUpdate`），chip 路由规则通过 scope 字段完整定义，thinking level 动态化与代码库类型一致，model picker 行为链完整。3 条 LOW 和 3 条 INFO 问题也均已处理。Spec 可以进入 Phase 2（plan 编写）。

### Summary

Spec 评审完成，第 2 轮，0 条 MUST FIX，评审通过。
