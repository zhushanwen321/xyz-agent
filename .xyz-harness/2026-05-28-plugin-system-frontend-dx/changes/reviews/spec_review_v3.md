---
review:
  type: spec_review
  round: 3
  timestamp: "2026-05-28T23:50:00"
  target: ".xyz-harness/2026-05-28-plugin-system-frontend-dx/spec.md"
  verdict: pass
  summary: "Spec 评审完成，第3轮，0条MUST FIX，全部已修复，通过"

statistics:
  total_issues: 10
  must_fix: 0
  must_fix_resolved: 3
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:§FR-B1 & §FR-B4"
    title: "plugin:statusBarUpdate vs plugin:status_bar_update 消息名矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md:§FR-B4"
    title: "状态栏引用未定义的 WS 消息 plugin.executeCommand"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "spec.md:§FR-B1, FR-B2, FR-B4"
    title: "事件监听防重复注册未提及（split mode 风险）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

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
    title: "前端 WS 断连时 Plugin Store 缺少连接状态指示"
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

  - id: 8
    severity: MUST_FIX
    location: "spec.md:§AC-B2 & §FR-B1 WS 消息扩展"
    title: "plugin.toggle WS 消息被引用但未在协议列表中定义"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3

  - id: 9
    severity: MUST_FIX
    location: "spec.md:§FR-B1 (Pinia Store) & §FR-B1 WS 消息扩展"
    title: "plugin.list WS 消息被引用但未在协议列表中定义"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3

  - id: 10
    severity: MUST_FIX
    location: "spec.md:§FR-B3 (PluginSettingsForm)"
    title: "plugin.config.get/set WS 消息归属不明确"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3
---

# 计划评审 v3 — Spec 增量审查

## 评审记录
- **评审时间**：2026-05-28 23:50
- **评审类型**：增量计划评审（Spec 完整性，第 3 轮）
- **评审对象**：`.xyz-harness/2026-05-28-plugin-system-frontend-dx/spec.md`
- **模式**：增量审查 — 验证 v2 MUST FIX 修复

---

## 1. 上一轮 MUST FIX 修复验证

### ✅ 问题 #8（MUST FIX → 已修复）：plugin.toggle 加入协议列表

**检查位置**：FR-B1 WS 消息扩展 + AC-B2 + 命名风格示例

| 检查项 | 结果 |
|--------|------|
| Client→Server 已有列表 | ✅ `plugin.toggle — { pluginId, enabled }` |
| AC-B2 引用 | ✅ "点击 Toggle 禁用插件 → `plugin.toggle` 发送" |
| 命名风格示例 | ✅ "`plugin.list`、`plugin.toggle`、`plugin.install`" |

**验证细节**：
- `plugin.toggle` 归入「已有（本期前端首次接入）」分组，标注状态准确——消息已在 sidecar 侧实现，前端首次接入 ✓
- 参数类型 `{ pluginId, enabled }` 与 FR-B1 store action `togglePlugin(id, enabled)` 签名一致 ✓
- AC-B2 可追踪：`plugin.toggle` 定义 → store action 调用 → 实现 ✓

### ✅ 问题 #9（MUST FIX → 已修复）：plugin.list 加入协议列表

**检查位置**：FR-B1 Pinia Store + WS 消息扩展

| 检查项 | 结果 |
|--------|------|
| Client→Server 已有列表 | ✅ `plugin.list — Record<string, never>` |
| Store 初始化引用 | ✅ "初始化时发送 `plugin.list` 获取插件列表" |
| Server→Client 响应链路 | ✅ `config.plugins` 已标注为"`plugin.list` 回复和初始化推送" |
| 错误场景覆盖 | ✅ "重连后自动 `plugin.list` 刷新" |

**验证细节**：
- `plugin.list` 归入「已有」分组，与 `config.plugins` 形成 request-response 配对 ✓
- Store 初始化、重连逻辑均有引用，无遗漏路径 ✓
- 注意：`plugin.list` 无参数的约定（`Record<string, never>`）意味着返回值全部插件——如果未来需要分页需要扩展，本期无此需求 ✓

### ✅ 问题 #10（MUST FIX → 已修复）：plugin.config.get/set 明确归属

**检查位置**：FR-B1 WS 消息扩展 + FR-B3 + 命名风格

| 检查项 | 结果 |
|--------|------|
| Client→Server 新增列表 | ✅ `plugin.config.get — { pluginId, key }` |
| Client→Server 新增列表 | ✅ `plugin.config.set — { pluginId, key, value }` |
| Server→Client 响应 | ✅ `plugin:config — { pluginId, config }`（对应 get/set） |
| FR-B3 引用 | ✅ "配置值通过 `plugin.config.get/set` WS 命令读写（sidecar → Worker RPC）" |

**验证细节**：
- 前端 → sidecar 的 WS 消息路径已经明确定义（`plugin.config.get`/`plugin.config.set`）✓
- sidecar → Worker 的内部 RPC 转发也在 FR-B3 中有说明（括号内 "(sidecar → Worker RPC)"）✓
- Server→Client 的 `plugin:config` 响应为配置 get/set 的返回通道 ✓
- "WS 命令" 的表述已不再误导——现在既有 WS 消息定义，又有内部 RPC 说明 ✓
- 响应消息名 `plugin:config` 使用冒号分隔，符合命名约定 ✓

---

## 2. 等级判定校准

根据校准规则验证「无 MUST FIX」结论的合理性：

| 规则 | 检查对象 | 判定 |
|------|---------|------|
| 1. 数据丢失 | 所有消息路径 | ✅ 无断裂—`plugin.list→config.plugins`、`plugin.toggle→config.plugins`、`plugin.config.get/set→plugin:config` 均完整 |
| 2. 功能失效 | 所有 FR | ✅ 每个 FR 的 WS 消息均有定义，无调用未定义消息的情况 |
| 3. 数据语义错误 | 消息参数类型 | ✅ 所有消息参数类型合理 |
| 4. 重复副作用 | 不适用 | — |
| 5. 时序错误 | 不适用 | — |

**判断口诀验证**：无任何问题会在生产环境导致功能不可用或数据错误。✅

---

## 3. 新增 MUST FIX 检查

增量审查模式下，重点检查 v2 修复是否引入回归或新 MUST FIX。

### 3.1 协议分组变更的完整性

`plugin.list` 和 `plugin.toggle` 从"新增"改为"已有"分组后，检查所有交叉引用：

| 引用位置 | 原文 | 是否仍然有效 | 说明 |
|---------|------|-------------|------|
| FR-B1 Store | "初始化时发送 `plugin.list`" | ✅ | 归入已有后，store 初始化逻辑不变 |
| FR-B1 WS 命名示例 | "`plugin.list`、`plugin.toggle`" | ✅ | 示例不区分已有/新增，仅作格式参考 |
| AC-B1 | "前端启动后 `plugin.list` 返回数据" | ✅ | 验收标准不变 |
| AC-B2 | "`plugin.toggle` 发送" | ✅ | 验收标准不变 |
| 错误场景覆盖 | "重连后自动 `plugin.list` 刷新" | ✅ | 错误处理逻辑不变 |

**结论**：分组归类调整不影响任何交叉引用。✓

### 3.2 `plugin:config` 新增消息验证

| 检查项 | 结果 |
|--------|------|
| 消息名格式 | ✅ `plugin:config` — 冒号分隔，符合 plugin 前缀约定 |
| 对应请求 | ✅ `plugin.config.get`（读）、`plugin.config.set`（写）共享一个响应通道 |
| 分组位置 | ✅ Server→Client 新增列表 |
| FR-B3 引用 | ✅ 配置读写逻辑已同步 |

**结论**：新增消息引用完整，无断裂。✓

### 3.3 未发现新增问题

对 spec 全量检查后，未发现新的 MUST FIX 问题：

- 所有 FR → AC 可追踪性保持完整 ✓
- WS 消息定义无遗漏（所有被引用的消息名均在列表中）✓
- 命名约定跨章节一致 ✓
- 错误场景覆盖齐全 ✓
- Constraints 章节完整 ✓

---

## 4. 仍开启的 LOW / INFO 问题（不阻碍通过）

以下 LOW/INFO 问题从 v1 保留至今。根据评审规则，LOW/INFO **不影响 verdict**：

### ⚠️ 问题 #4（LOW）：AC-B3 "刷新"语义模糊
AC-B3 中"刷新后值保留"——"刷新"指前端页面刷新还是插件重启，未明确。建议明确为"页面刷新后值保留（需 sidecar 侧持久化）"或补充持久化机制说明。

### ⚠️ 问题 #5（LOW）：AC-A2 与 AC-C3 测试目标重叠
两者都围绕 executeHooks 串行化。AC-A2 攻功能正确性（阻止生效），AC-C3 攻质量维度（串行顺序、超时、链终止）。建议在 spec 中明确分层，或合并为一条 AC。

### 📝 问题 #6（INFO）：WS 断连时 Plugin Store 无连接状态指示
建议在 Plugin Store 中增加 `connectionStatus: 'connected' | 'disconnected' | 'reconnecting'` 字段。

### 📝 问题 #7（INFO）：plugin:messageDecoration 无大小/频率限制
建议增加上限约定（如 ≤1次/秒，单次 ≤10KB），或标注"本期不做限流"。

---

## 5. 循环上限检查

本 spec 评审已达第 3 轮（循环上限 ≤ 3 轮）。本轮 verdict 为 **pass**，无需升级决策。

---

## 6. 结论

**通过**（verdict: pass）。

**本轮修复评估**：
- 3 条 MUST FIX（#8, #9, #10）全部已修复 ✓
- `plugin.list` / `plugin.toggle` 已正确定位为"已有"消息并加入协议列表 ✓
- `plugin.config.get` / `plugin.config.set` / `plugin:config` 已加入协议列表，归属明确 ✓
- 已有 Server→Client 消息（`config.plugins`、`plugin:crashed`、`plugin:notification`）已正确分组 ✓
- 分组调整未引入任何交叉引用断裂 ✓
- 无新增 MUST FIX 问题 ✓

**历史总结**：
- 第 1 轮: 2 条 MUST FIX → 第 2 轮修复
- 第 2 轮: 3 条新 MUST FIX → 本轮修复
- 第 3 轮: 0 条 MUST FIX → **pass** 🟢

### Summary

Spec 增量评审完成，第3轮，0条MUST FIX，全部已修复，通过。3 轮累计 5 条 MUST FIX 全部关闭，spec 完整度、一致性、可实施性符合要求。
