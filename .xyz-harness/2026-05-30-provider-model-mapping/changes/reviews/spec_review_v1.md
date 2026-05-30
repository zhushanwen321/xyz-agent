---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-30T16:00:00"
  target: ".xyz-harness/2026-05-30-provider-model-mapping/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，2条 MUST FIX，需修改后重审"

statistics:
  total_issues: 3
  must_fix: 2
  must_fix_resolved: 0
  low: 1
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > FR-2 #2, AC-3 #3"
    title: "序列化策略歧义：'或' 导致两种行为均可接受"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-3, 整体缺少错误场景章节"
    title: "缺少保存失败的错误处理场景描述"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md > Constraints #1"
    title: "shared types 中 thinkingLevelMap 缺少 TypeScript 类型签名"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-30 16:00
- 评审类型：计划评审（仅 spec，无 plan.md）
- 评审对象：`.xyz-harness/2026-05-30-provider-model-mapping/spec.md`

## 检查维度 1：spec 完整性

### 1.1 目标明确性 ✅

目标清晰：在 Provider 设置页面的模型列表中增加 `thinkingLevelMap` 的可视化配置能力，包括展开/折叠、Toggle 启禁、API 参数编辑、预设模板。一段话可说清。

### 1.2 范围合理性 ✅

范围边界明确：
- **内**：ProviderModal 中模型行的 thinkingLevelMap 编辑、保存、预设、与 InputToolbar 的联动
- **外**：不涉及新的 API 端点、数据库变更、外部依赖
- 复杂度评估为 Medium 合理（4 层变更但每层量小）

### 1.3 验收标准可量化 ⚠️

5 组 AC 总体可测试，但存在以下问题：

| AC | 可测试性 | 备注 |
|----|---------|------|
| AC-1 展开折叠 | ✅ | 明确：chevron、动画、多行同时展开 |
| AC-2 Toggle 与输入 | ✅ | 明确：7 个 level、默认状态、置灰行为 |
| AC-3 数据持久化 | ⚠️ | **见 MUST FIX #1**：序列化策略有歧义 |
| AC-4 过滤联动 | ✅ | 明确：ds-flash 配置后只显示 3 个 level |
| AC-5 预设模板 | ✅ | 明确：每个预设的具体 toggle/输入值 |

### 1.4 `[待决议]` 项 ⚠️

未显式标记 `[待决议]`，但 FR-2 #2 和 AC-3 #3 的"或"表述实质上是待决议状态。**见 MUST FIX #1**。

### 1.5 约束与架构合规

| 约束 | 合规 | 备注 |
|------|------|------|
| 数据格式（7 key + string/null） | ✅ | Constraints #1 明确 |
| 向后兼容 | ✅ | Constraints #2/3 明确可选字段 |
| xyz-ui 组件 | ✅ | Constraints #4 明确 |
| Tailwind 规范 | ✅ | Constraints #5 明确 |
| ProviderModal 行数限制 | ✅ | Constraints #6 明确抽取 ThinkingLevelConfig.vue |
| CLAUDE.md 规则 #7 Session 隔离 | N/A | 本功能不涉及 session 消息 |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md > FR-2 #2, AC-3 #3 | 序列化策略歧义：两处使用"或"字，导致两种行为均可接受 | 统一为一种明确策略（建议方式见下方） |
| 2 | MUST FIX | spec.md > FR-3, 缺错误场景 | 缺少保存失败时的 UI 行为描述 | 补充错误场景章节（建议方式见下方） |
| 3 | LOW | spec.md > Constraints #1 | shared types 中缺少 thinkingLevelMap 的 TypeScript 类型签名 | 建议补充类型定义 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

### MUST FIX #1：序列化策略歧义

**位置**：FR-2 #2 第二条、AC-3 #3

**问题描述**：

FR-2 #2 写：
> **Toggle ON + 输入框为空**：等同于透传，`thinkingLevelMap` 中**不写该 key（或写为 key 的同名值）**

AC-3 #3 写：
> 无 `thinkingLevelMap` 的模型，如果所有 toggle 都是 ON 且输入框为空，**不写入 `thinkingLevelMap` 字段（或写入空对象）**

两处使用"或"，意味着两种行为均可接受。这导致：
1. 开发者和审查者无法判断实现是否正确（两种都对？）
2. 不同开发路径可能采用不同策略，行为不一致
3. `不写该 key` 和 `写为 key 的同名值` 对下游消费者（InputToolbar）的语义相同，但对 models.json 的可读性不同

**修改建议**：

推荐统一为以下策略（或明确选择另一种，但必须消除"或"）：

```markdown
- **Toggle ON + 输入框为空**：thinkingLevelMap 中不写该 key（透传语义）
- **Toggle ON + 输入框有值**："level": "api_value"
- **Toggle OFF**："level": null

当所有 toggle 均为 ON 且所有输入框为空时，不写入 thinkingLevelMap 字段（等同于不配置，即全部透传）。
```

---

### MUST FIX #2：缺少保存失败的错误处理场景

**位置**：FR-3 缺少错误场景描述

**问题描述**：

spec 描述了保存路径 `SetProviderData → ConfigService → pi-config-bridge → models.json`，但未覆盖保存失败时的行为：

- models.json 写入权限错误
- WS 断连导致 ConfigService 不可达
- pi-config-bridge 执行异常

CLAUDE.md 规则 #3 要求"错误必须重置状态"。对于此功能，如果保存失败但 UI 未提示，用户会误以为配置已保存，导致**数据丢失**（用户关闭 ProviderModal 后配置丢失）。

**修改建议**：

在 FR-3 后补充错误场景子项：

```markdown
### FR-3.5: 保存失败处理
1. 保存失败时，ProviderModal 不关闭，显示错误提示（toast 或 inline error）
2. 用户的编辑内容保留在 UI 中，不回滚（允许用户修复后重试）
3. 错误信息包含具体原因（如"models.json 写入失败：权限不足"）
```

---

### LOW #1：shared types 缺少 TypeScript 类型签名

**位置**：Constraints #1

**问题描述**：

Constraints #1 描述了 key/value 约束，但未给出 TypeScript 类型签名。开发者需要在 `src-electron/shared/src/` 中自行推导类型，可能产生不一致。

**修改建议**：

在 Constraints 或 FR-2 中补充：

```typescript
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>
```

---

## 结论

**需修改后重审** — 2 条 MUST FIX 均为 spec 歧义/缺失，不影响功能设计方向，修复成本低。

### Summary

Spec 评审完成，第1轮，2条 MUST FIX，需修改后重审。
