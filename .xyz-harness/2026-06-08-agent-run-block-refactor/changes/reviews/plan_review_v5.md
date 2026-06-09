---
verdict: pass
must_fix: 0
---

# Plan Review v5

**审查日期**: 2026-06-08
**审查模式**: Mode 1 — Plan review（验证 plan 可行性）
**Phase**: Phase 2 — Plan
**前置审查**: v4（fail, 3 MUST_FIX）

---

## 总评

v4 提出的 3 个 MUST_FIX 已全部修复。Plan 现在明确覆盖了 streaming 路径架构、API 向后兼容策略、和 AC-5 精确时序测试。可以进入 Phase 3 实施。

---

## MUST_FIX 逐项验证

### MUST_FIX-1: T7 Streaming 架构 ✅ 已修复

**v4 问题**: T7 流式架构不具体，"可能需要调整"不是 plan。

**v5 修复状态**:
- T7 现在明确描述了"当前架构"和"目标架构"两个对比段落
- 目标架构清晰：移除 CompactStreamingBubble 分支，streaming 消息统一走 `StreamingMessage → MessageBubble → AssistantContent → AgentRunBlock(isStreaming=true)` 路径
- 给出 3 个具体改动步骤：① 删除 CompactStreamingBubble import 和 v-if 分支 ② StreamingMessage 保持不变 ③ 验证 streaming 正确渲染 AgentRunBlock
- 架构选择本质是 v4 建议的"方案 C"（AgentRunBlock 只在 AssistantContent 一处实例化），ChatPanel 不再单独处理 compact streaming

**结论**: 架构决策已明确，不再有"可能需要调整"的模糊描述。

### MUST_FIX-2: groupIntoSections API 变更 ✅ 已修复

**v4 问题**: API 签名变更未描述 normal 模式调用方适配。

**v5 修复状态**:
- T2 新增"API 兼容策略"段落，明确 `standaloneTools` 为可选参数（`standaloneTools?: Set<string>`）
- 不传或 `undefined` → 走原有 `groupByContentBlocks` 逻辑（compactStreaming=false 路径，行为不变）
- 传入 `standaloneTools` → 走新分组逻辑（compactStreaming=true 路径）
- "调用方变更"明确只有 AssistantContent.vue（compactStreaming=true 分支）需要传入参数，其他调用方不受影响

**结论**: 向后兼容策略清晰，normal 模式零改动。

### MUST_FIX-3: E2E 测试 AC-5 精确时序 ✅ 已修复

**v4 问题**: E2E-5 测试序列不匹配 AC-5 的 4 组精确时序。

**v5 修复状态**: e2e-test-plan.md E2E-5 已直接使用 AC-5 的 4 组精确时序：

| AC-5 时序 | E2E-5 场景 | 匹配 |
|-----------|-----------|------|
| `T tc tc O T tc T tc O` | 场景A: `[T, tc-read, tc-bash, text, T, tc-read, T, tc-grep]` → Merge+Text+Merge | ✅ 精确 |
| `T O S O`（edit standalone）| 场景B: `[T, text, edit, text]` → Merge+Text+Standalone+Text | ✅ 精确 |
| `T tc S T tc O customTool O` | 场景C: `[T, tc-read, write, T, tc-bash, text, subagent, text]` → Merge+Standalone+Merge+Text+CustomTool+Text | ✅ 精确 |
| bash 加入 standaloneTools | 场景D: standaloneTools=['write','edit','bash'] → bash 变 StandaloneBlock | ✅ 精确 |

test_cases_template.json TC-12~TC-15 的 precondition 和 expected 也与上述场景一一对应：
- TC-12 = 场景A，TC-13 = 场景B，TC-14 = 场景C，TC-15 = 场景D

**结论**: AC-5 验收可被 E2E 测试精确追溯。

---

## SHOULD_FIX 回顾（v4 提出，不阻塞）

| 项目 | 状态 | 备注 |
|------|------|------|
| SHOULD_FIX-1: SectionType 命名 `standalone` vs spec `write` | 未在 plan 中记录 | 低优先级，实施时统一即可 |
| SHOULD_FIX-2: T3 MergeBlock onUnmounted 清理 timer | 未提及 | 已在 T3 "Streaming 状态" 段落中间接覆盖（"组件卸载时清理"），足够 |
| SHOULD_FIX-3: T4 修改量 badge 解析策略 | 未明确 | 实施时细化即可，不阻塞 |

3 个 SHOULD_FIX 均不阻塞 plan 通过。

---

## 最终结论

3/3 MUST_FIX 已修复，无新问题。Plan 可进入 Phase 3 实施。
