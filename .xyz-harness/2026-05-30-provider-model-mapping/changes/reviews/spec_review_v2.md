---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-30T17:30:00"
  target: ".xyz-harness/2026-05-30-provider-model-mapping/spec.md"
  verdict: pass
  summary: "Spec 评审完成，第2轮增量审查，0条 open MUST FIX，通过"

statistics:
  total_issues: 3
  must_fix: 0
  must_fix_resolved: 2
  low: 1
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > FR-2 #2, AC-3 #3"
    title: "序列化策略歧义：'或' 导致两种行为均可接受"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-3, 缺错误场景"
    title: "缺少保存失败的错误处理场景描述"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: LOW
    location: "spec.md > Constraints #1"
    title: "shared types 中 thinkingLevelMap 缺少 TypeScript 类型签名"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-30 17:30
- 评审类型：计划评审（spec 增量审查）
- 评审对象：`.xyz-harness/2026-05-30-provider-model-mapping/spec.md`
- 审查模式：增量审查（v1 MUST FIX 修复验证 + 回归检查）

## 增量审查：v1 MUST FIX 修复验证

### [FIXED] #1：序列化策略歧义 — 已解决 ✅

**v1 问题**：FR-2 #2 和 AC-3 #3 使用"或"字，导致两种序列化策略均可接受。

**当前状态**：

- FR-2 #2 现在写法明确：
  > **Toggle ON + 输入框为空**：`thinkingLevelMap` 中**不写该 key**（省略 = 透传，pi 会使用 key 的原始值）

  消除了"或写为 key 的同名值"的歧义。策略统一为：ON + 空 = 不写 key。

- AC-3 #3 现在写法明确：
  > 无 `thinkingLevelMap` 的模型，如果所有 toggle 都是 ON 且输入框为空，**不写入 `thinkingLevelMap` 字段**（省略该字段 = 透传，与手动编辑 models.json 的行为一致）

  消除了"或写入空对象"的歧义。策略统一为：全透传时不写字段。

**结论**：歧义已消除，开发者只有一种正确实现方式。✅

### [FIXED] #2：缺少保存失败的错误处理场景 — 已解决 ✅

**v1 问题**：FR-3 只描述了保存成功路径，缺少保存失败时的 UI 行为。

**当前状态**：

新增 AC-4（保存失败处理）：
> - 保存时如果 WS 断连或服务端返回错误，显示错误提示（toast 或 inline message），不关闭 Modal
> - 保存成功后 Modal 自动关闭，provider store 刷新

**结论**：错误场景有了明确的验收标准，覆盖了 WS 断连和服务端错误两种情况。与 CLAUDE.md 规则 #3（错误必须重置状态）一致——保存失败不关闭 Modal 即保留了编辑状态。✅

## 回归检查

检查修复过程中是否引入新问题：

| 检查项 | 结果 |
|--------|------|
| FR-2 映射值规则与 AC-3 一致性 | ✅ 无矛盾：FR-2 规定行级行为，AC-3 规定整体序列化策略，逻辑自洽 |
| 新增 AC-4 与现有 AC 排列 | ✅ AC 编号连续（AC-1~AC-6），无遗漏无重复 |
| AC-4 与 FR-3 的关系 | ✅ FR-3 描述保存路径（happy path），AC-4 补充错误行为，职责清晰 |
| FR-1 #3 `mapped` badge 在 AC 中未显式测试 | ℹ️ 轻微覆盖缺口，badge 是辅助视觉指示器，不影响核心功能，不阻塞 |

**无回归问题。**

## 沿用项（v1 LOW，未修改）

### LOW #1（沿用）：shared types 缺少 TypeScript 类型签名

**状态**：仍为 open。Constraints #1 描述了 key/value 约束但未给出 TS 类型。

**影响**：开发者需自行推导类型，可能导致 `thinkingLevelMap` 在 shared types 中的定义与 spec 描述不一致。

**建议**（不阻塞）：

```typescript
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>
```

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | ~~MUST FIX~~ | ~~FR-2 #2, AC-3 #3~~ | ~~序列化策略歧义~~ | ✅ v2 已修复 |
| 2 | ~~MUST FIX~~ | ~~FR-3, 缺错误场景~~ | ~~缺少保存失败行为~~ | ✅ v2 已修复 |
| 3 | LOW | spec.md > Constraints #1 | shared types 缺少 TS 类型签名 | 补充 ThinkingLevel + ThinkingLevelMap 类型定义 |

> 本轮无新增问题。

## 结论

**通过** — v1 的 2 条 MUST FIX 均已修复，修复质量良好，无回归。剩余 1 条 LOW 不阻塞流程。

### Summary

Spec 评审完成，第2轮增量审查，0条 open MUST FIX，通过。
