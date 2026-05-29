---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-28T16:00:00"
  target: ".xyz-harness/2026-05-28-plugin-system-frontend-dx/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，2条 MUST FIX，3条 LOW，需修改后重审"

statistics:
  total_issues: 7
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:§FR-B1 & §FR-B4"
    title: "plugin:statusBarUpdate vs plugin:status_bar_update 消息名矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md:§FR-B4"
    title: "状态栏引用未定义的 WS 消息 plugin.executeCommand"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "spec.md:§FR-B1, FR-B2, FR-B4"
    title: "事件监听防重复注册未提及（split mode 风险）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md:§AC-B3"
    title: "AC-B3 '刷新'语义模糊——前端刷新还是插件重启？"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:§AC-A2 & §AC-C3"
    title: "AC-A2 与 AC-C3 测试目标重叠"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "spec.md:§错误场景覆盖"
    title: "前端断连时 Plugin Store 缺少连接状态指示"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "spec.md:§FR-B4"
    title: "plugin:messageDecoration 无消息大小/频率限制"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1 — Spec 完整性审查

## 评审记录
- **评审时间**：2026-05-28 16:00
- **评审类型**：计划评审（Spec 完整性）
- **评审对象**：`.xyz-harness/2026-05-28-plugin-system-frontend-dx/spec.md`
- **参考约束**：项目 CLAUDE.md + Expert Reviewer skill

---

## 1. Spec 六要素完整性

### ✅ Background (通过)
背景清晰，能够在一段话内说明问题：
- Phase 1 羽翼骨架已搭建
- Phase 2 实现 agentAPI、Bridge、权限等核心能力
- 当前三个阶段的问题明确列出（前端缺失、后端 stub、质量缺口）
- 设计文档引用完整

**无问题。**

### ✅ Functional Requirements (通过)
FR 按 4 个域（A/B/C/D）分组，每项均有明确的实现行为描述，无模糊表述。

**特别加分**：FR 之间无功能重叠检查——FR-A2 与 FR-C3 正确标注为同一需求，避免重复实现。

**无问题。**

### ✅ Acceptance Criteria (通过，但有 1 处语义模糊)
13 条 AC 每一条都可量化验证（写测试或用例验证），无"提升用户体验"类模糊描述。

**问题 #4（LOW）**：AC-B3 中 "刷新后值保留" — "刷新"指前端页面刷新（F5/reload）还是插件重新激活？如果指页面刷新，配置持久化需在 sidecar 侧做 KV 持久化，不能仅依赖 PluginStorage（Worker 内存）；如果指插件重启，则无需额外工作。语义不清可能导致实现偏差。

### ✅ Constraints (通过)
约束项全面且与项目规范一致：
- TypeScript 严格模式 ✅
- 前端编码规范 ✅
- WS flat type 模式 ✅
- Pinia store ✅
- 组件复用 ✅
- 不破坏现有接口 ✅
- pi fork 版本 ✅
- Phase 1/2 兼容 ✅

**无问题。**

### ✅ 业务用例 (通过)
5 个用例覆盖了核心用户旅程：
- UC-1: 插件管理（管理员视角）
- UC-2: Tool 执行（LLM 视角）
- UC-3: Hook 阻止（安全视角）
- UC-4: 热重载（开发者视角）
- UC-5: 配置修改（用户视角）

**无问题。**

### ✅ Complexity Assessment (通过)
复杂度评估诚实——标注"高复杂度"，给出 10-15 天估算，分 4 个层次说明原因。

**无问题。**

---

## 2. FR 与 AC 可追踪性

逐条对照 FR → AC：

| FR | 对应 AC | 状态 |
|----|---------|------|
| FR-A1 | AC-A1 | ✅ 直接对应 |
| FR-A2 | AC-A2, AC-A3, AC-C3 | ⚠️ 见问题 #5 |
| FR-B1 | AC-B1, AC-B2 | ✅ 直接对应 |
| FR-B2 | AC-B1, AC-B2 | ✅ 通过 AC-B1/2 间接覆盖 |
| FR-B3 | AC-B3 | ✅ 直接对应 |
| FR-B4 | AC-B4, AC-B5, AC-B6 | ✅ 逐项对应 |
| FR-B5 | AC-B7 | ✅ 直接对应 |
| FR-C1 | AC-C1 | ✅ 直接对应 |
| FR-C2 | AC-C2 | ✅ 直接对应 |
| FR-C3 | AC-A2, AC-A3, AC-C3 | ⚠️ 见问题 #5 |
| FR-C4 | AC-C4 | ✅ 直接对应 |
| FR-C5 | AC-C5 | ✅ 直接对应 |
| FR-D1 | AC-D1 | ✅ 直接对应 |
| FR-D2 | AC-D2 | ✅ 直接对应 |

**整体：全覆盖。** 每个 FR 至少有一条 AC。AC 总数（13 条）略少于 FR 总数（14 项，因 FR-A2=FR-C3 去重后 13 项），数量匹配合理。

**问题 #5（LOW）**：AC-A2 与 AC-C3 两者都测试 executeHooks 串行化场景，测试目标高度重叠。建议明确分工：
- AC-A2 只测"功能正确性"（消息被阻止后不发送）
- AC-C3 只测"质量维度"（性能、串行顺序、超时行为）

---

## 3. 错误场景覆盖

spec 末尾的"错误场景覆盖"表格覆盖了 **7 个场景**：

| 场景 | 状态 | 备注 |
|------|------|------|
| Worker 崩溃（tool 执行时） | ✅ | 有具体 error message 约定 |
| Worker hook 超时（5s） | ✅ | 行为是"视为放行" |
| 前端 WS 断连 | ✅ | 保持最后已知状态 |
| 热重载 deactivate 超时 | ✅ | 强制 terminate |
| sessionData bridge 不可用 | ✅ | 缓存兜底 + dirty 标记 |
| 权限对话框用户拒绝 | ✅ | 保持 discovered 状态 |
| 测试插件文件不存在 | ✅ | 忽略 delete 事件 |

**补充建议（INFO）**：

**问题 #6（INFO）**：前端 WS 断连时，Plugin Store 保持最后已知状态但无连接状态指示。PluginsPane 中的插件状态 badge 在 WS 断连期间应显示"断连"或"未知"标记，避免用户误以为状态是实时的。建议在 store 中增加 `connectionStatus` 字段。

**问题 #7（INFO）**：`plugin:messageDecoration` 缺少消息大小和频率限制的定义。如果某个插件的装饰器频繁推送大量数据（如每 100ms 推送 50KB 装饰数据），前端渲染性能会受影响。建议增加上限约定（如最大 1 次/秒，单次 ≤ 10KB），或至少标注"本期不做限流，Phase 4 补充"。

---

## 4. 与 CLAUDE.md 项目约束的一致性

逐条对照 CLAUDE.md 关键规则：

| CLAUDE.md 规则 | Spec 是否符合 | 说明 |
|----------------|-------------|------|
| 1. emit 只传单个 payload 对象 | ✅ 不相关（WS 消息维度） | WS 消息使用 flat type，天然单个 payload |
| 2. Event bus listener 防重复注册 | ❌ **未提及** | 见问题 #3 |
| 3. 错误必须重置 isGenerating + streamingMessage | ✅ 不相关 | 插件系统不直接涉及 |
| 4. 外部系统对接先验证再编码 | ✅ 不直接相关 | PI Bridge 已在 Phase 2 验证 |
| 5. pi 适配层不信任外部格式 | ✅ 不直接相关 | 但 Bridge 测试（FR-C1）应当注意 |
| 6. pi session 文件延迟写入 | ✅ 不直接相关 | sessionData 缓存兜底已在 FR-C4 |
| 7. Session 隔离：所有消息必须带 sessionId | ✅ WS 协议扩展包含 sessionId | 已验证 |
| 8-9 无直接关联 | ✅ | |
| 10. 数据目录隔离 | ✅ `~/.xyz-agent/plugins/` 正确 | pi 数据目录完全隔离 |

**问题 #3（LOW）**：CLAUDE.md 规则 2 规定"Event bus listener 防重复注册"。本 spec 中 PluginsPane、MessageDecoration、AppStatusbar 等组件都会监听 `plugin:xxx` 事件。在 split mode 下，可能存在多个面板实例同时监听。spec 未提及使用模块级 refCount 保护策略。建议在 Constraints 或 FR-B1 中增加 "前端事件监听必须使用 refCount 保护，避免 split mode 下重复注册" 的约束。

---

## 5. 模糊或矛盾描述

### 🔴 问题 #1（MUST FIX）：plugin:statusBarUpdate vs plugin:status_bar_update 消息名矛盾

**位置**：FR-B1（命名风格章节）vs FR-B4（状态栏章节）

**现象**：
- FR-B1 命名风格章节明确写："现有 AppStatusbar 中的 `plugin:status_bar_update` 需改为 `plugin:statusBarUpdate`"
- FR-B4 状态栏段落写："当前已有基本实现（`pluginItems` ref + `on('plugin:status_bar_update')`），需验证完整性"

即 FR-B1 要求**改名**，FR-B4 仍引用**旧名**。这是前后矛盾。如果后端按 FR-B1 要求改为 `plugin:statusBarUpdate`，前端仍监听 `plugin:status_bar_update`，状态栏更新将永久失效。

**修复方向**：统一两处命名。推荐使用 camelCase `plugin:statusBarUpdate`（与 FR-B1 命名决策一致），并在 FR-B4 中更新引用。

---

### 🔴 问题 #2（MUST FIX）：状态栏点击引用未定义的 WS 消息

**位置**：FR-B4 状态栏段落

**原文**："点击触发插件注册的命令（通过 WS `plugin.executeCommand`）"

**问题**：`plugin.executeCommand` 在 FR-B1 "WS 消息扩展"章节中没有定义。FR-B1 只定义了以下 Client→Server 消息：
- `plugin.install`
- `plugin.uninstall`
- `plugin.approvePermissions`
- `plugin.revokePermissions`

缺少 `plugin.executeCommand`。此外，FR-B4 的 SlashMenu 部分提到 `plugin.executeSlashCommand`，也未在消息扩展表中定义。这两个消息要么需要补充到协议定义中，要么在 FR-B4 中说明使用现有 WS 消息机制（如复用其他命令通道）。

**修复方向**：在 FR-B1 的 WS 消息扩展表中补充：
- `plugin.executeCommand` — `{ pluginId: string, commandId: string }` → 执行插件注册的命令（状态栏点击触发）
- `plugin.executeSlashCommand` — `{ pluginId: string, slashCommand: string }` → 执行插件 slash 命令

或在 FR-B4 中说明：状态栏点击触发的是插件注册的通用 CLI command，slash command 通过 `plugin.executeSlashCommand` 发送，两者均需补充到协议定义。

---

## 发现的问题汇总

| # | 优先级 | 位置 | 描述 | 修改方向 |
|---|--------|------|------|----------|
| 1 | **MUST FIX** | FR-B1 & FR-B4 | `plugin:statusBarUpdate` vs `plugin:status_bar_update` 消息名矛盾 | 统一为 camelCase，更新 FR-B4 引用 |
| 2 | **MUST FIX** | FR-B4 | `plugin.executeCommand` 和 `plugin.executeSlashCommand` 未在 WS 协议扩展中定义 | 补充到 FR-B1 协议定义表 |
| 3 | LOW | FR-B1, FR-B2, FR-B4 | 事件监听防重复注册未提及（违反 CLAUDE.md 规则 2） | 在 Constraints 中增加 refCount 约束 |
| 4 | LOW | AC-B3 | "刷新"语义模糊——前端刷新还是插件重启？ | 明确刷新场景，补充持久化机制 |
| 5 | LOW | AC-A2 & AC-C3 | 两者都测 executeHooks 串行化，目标重叠 | 分层：AC-A2 测功能，AC-C3 测质量/性能 |
| 6 | INFO | 错误场景覆盖 | WS 断连时 Plugin Store 无连接状态指示 | 增加 `connectionStatus` 字段显示"断开" |
| 7 | INFO | FR-B4 | `plugin:messageDecoration` 无大小/频率限制 | 增加上限约束或标注"待定" |

> **优先级定义**：
> - **MUST FIX**：不修复则评审不通过，会导致实现错误或功能不可用
> - **LOW**：建议修复，但不阻塞流程
> - **INFO**：观察记录，无需操作

---

## 结论

**需修改后重审**（verdict: fail）。

2 条 MUST FIX 问题 — 均为 spec 内部矛盾（消息名不一致、WS 消息定义缺失），不修复会导致**集成错误**或**功能缺失**。修复成本低，预期下一轮可以 pass。

3 条 LOW 建议 — 提升 spec 质量和实现鲁棒性，建议一并修复。

2 条 INFO — 记录供参考，无需操作。

### Summary

Spec 评审完成，第1轮，2条MUST FIX，需修改后重审。整体结构良好、六要素完整、FR↔AC 全覆盖，但存在两处内部矛盾必须在实施前解决。
