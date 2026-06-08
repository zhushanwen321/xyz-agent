---
verdict: pass
must_fix: 0
---

# Plan Review v1: AgentRunBlock 重构

**审查日期**: 2026-06-08
**审查范围**: plan.md, e2e-test-plan.md, test_cases_template.json, use-cases.md, non-functional-design.md
**交叉参考**: spec.md

## 总体评价

Plan 质量较高，任务拆分清晰、依赖关系正确、与 spec 的 AC 覆盖完整。代码结构验证通过——plan 中描述的文件路径、现有 API 签名、组件层级关系均与代码库一致。以下是详细评审。

---

## 1. Spec → Plan 一致性

| Spec AC | Plan 覆盖 | 备注 |
|---------|----------|------|
| AC-1 容器渲染 | T5 + E2E-1 | 完整 |
| AC-2 独立渲染 | T4 + E2E-2 | 完整 |
| AC-3 折叠展开 | T3 + E2E-3 | 完整 |
| AC-4 Streaming | T3 + E2E-4 | 完整 |
| AC-5 分组正确性 | T2 + E2E-5 (4 场景) | 完整，时序精确匹配 spec |
| AC-6 主题兼容 | E2E-6 | 覆盖 |
| AC-7 旧消息兼容 | T2 API 兼容策略 + E2E-7 | 完整 |
| AC-8 Settings | T1 + T8 + E2E-8 | 完整 |

**结论**: 全部 8 个 AC 有 plan task 和 E2E 场景双向覆盖，无遗漏。

---

## 2. 依赖图验证

```
T1 (settings store) ← 无依赖，正确
T2 (message-layout) ← 依赖 T1，正确
T3 (MergeBlock) ← 依赖 T2 section 类型，正确
T4 (StandaloneToolCard) ← 依赖 T2 section 类型，正确
T5 (AgentRunBlock) ← 依赖 T3 + T4，正确
T6 (AssistantContent) ← 依赖 T5，正确
T7 (ChatPanel) ← 依赖 T6（移除 CompactStreamingBubble），正确
T8 (Settings UI) ← 仅依赖 T1，可并行，正确
```

依赖图无环，执行顺序合理。T3+T4 可并行是合理的独立组件。

---

## 3. 代码结构准确性验证

对 plan 描述与实际代码库做了交叉核对：

| Plan 描述 | 实际代码 | 一致性 |
|-----------|---------|--------|
| CompactSummaryBar 在 AssistantContent.vue 中使用 | ✅ line 8: `<CompactSummaryBar>` | 一致 |
| CompactStreamingBubble 在 ChatPanel.vue 中使用 | ✅ line 92: `<CompactStreamingBubble>` | 一致 |
| `groupIntoSections` 当前签名为 `(msg: Message)` | ✅ line 70: `groupIntoSections(msg: Message)` | 一致 |
| 当前 SectionType = `'thinking' \| 'toolCall' \| 'text'` | ✅ line 55 | 一致 |
| StreamingMessage 已走 MessageBubble → AssistantContent 路径 | ✅ 确认 | 一致 |
| settings store 中 compactStreaming 在 persist.pick 中 | ✅ line 59 | 一致 |
| compactStreaming 设置 UI 在 SystemPane.vue | ✅ line 118 | 一致 |

---

## 4. 架构风险评估

### 4.1 低风险 ✅
- **不改 shared types / WS 协议 / useChat.ts**: Plan 严格遵守 spec 约束，影响面限定在渲染层
- **API 兼容策略**: `groupIntoSections` 新增可选参数 `standaloneTools`，不传时走旧逻辑，向后兼容
- **compactStreaming=false 隔离**: 新代码仅在 compactStreaming=true 分支执行

### 4.2 中等关注点
- **T7 ChatPanel streaming 路径统一**: 当前 streaming 消息有两条路径（compactStreaming 走 CompactStreamingBubble，否则走 StreamingMessage）。Plan 移除 CompactStreamingBubble 分支后，所有 streaming 消息统一走 StreamingMessage → MessageBubble → AssistantContent → AgentRunBlock。路径变长，需确认：
  - streaming 消息通过 MessageBubble 时不会触发不必要的事件（如 scroll-to-bottom 重复）
  - MessageBubble 内部对 streaming 状态的处理不依赖 MessageList 的上下文
  
  **风险可控**: StreamingMessage 本身就是 MessageBubble 的薄包装，MessageBubble 已经处理 isStreaming prop。

- **MergeBlock setInterval 清理**: Plan 明确了 `onUnmounted` 清理，non-functional-design 也提到了。实现时注意。

---

## 5. 各交付物评审

### 5.1 plan.md

**优点**:
- 每个 Task 有明确的文件路径、改动描述、验证方法
- T2 的 API 兼容策略是亮点——用可选参数区分新旧路径，不动现有调用方
- Commit 策略合理，每 Task 一个 commit
- 行数预估符合 400/300 行限制

**改进建议**（非阻塞）:
- T5 footer 的"文件修改数"计算用了 `standaloneTools.has(tc.toolName)`，但 spec 定义是"toolName 在 standaloneTools 集合内的总数"。Plan 和 spec 一致，但建议在实现时注意这是去重计数还是原始计数（一个文件可能被多次 edit）
- T8 具体文件路径标为"需确认"，实际已定位到 SystemPane.vue。实现时直接用即可

### 5.2 e2e-test-plan.md

**优点**:
- 8 个 E2E 场景完整覆盖 AC-1 ~ AC-8
- E2E-5 的 4 个分组场景精确匹配 spec AC-5 的时序定义
- 每个场景有明确的步骤和预期结果

**改进建议**（非阻塞）:
- 缺少"空 contentBlocks（Agent 只回复文字无操作）"的边界场景
- 缺少"多个 MergeBlock 交替出现"的 E2E 场景（E2E-5 场景 A 部分覆盖了，但不是 UI 级 E2E）

### 5.3 test_cases_template.json

**优点**:
- 22 个 test case 与 E2E 场景一一对应
- 每个 case 有 id、acRef、precondition、steps、expected
- JSON 格式便于自动化测试框架消费

**改进建议**（非阻塞）:
- TC-3 "文件修改数"的 expected 描述较模糊（"显示步骤数、总耗时、文件修改数"），建议明确具体数值

### 5.4 use-cases.md

**优点**:
- 4 个 use case 覆盖了主要用户场景
- 每个 UC 有 Actor、Preconditions、Main Flow、Alternative Paths、Postconditions、Module Boundaries
- 覆盖映射表清晰

**改进建议**（非阻塞）:
- UC-3（subagent）的 Module Boundaries 写的是 `StandaloneToolCard → isMergeBlock`，但 isMergeBlock 在 message-layout.ts 中，不在 StandaloneToolCard 中。这是分组判断的职责，不是组件的职责

### 5.5 non-functional-design.md

**优点**:
- 正确识别了 setInterval 内存泄漏风险和解决方式
- 正确指出分组逻辑是纯函数、无副作用
- 性能分析合理（O(50) 遍历 + O(1) 渲染）

**改进建议**（非阻塞）:
- "不适用"出现 3 次（数据一致性、业务安全、数据安全），可以简要说明原因（如"本次改动不涉及数据存储"）而非仅写"不适用"——当前已部分做了，可保持

---

## 6. 发现的问题

### SHOULD_FIX（非阻塞）

1. **plan T5 section type 名称与 spec FR-4 不完全对齐**: Plan 使用 `'standalone'` 类型名，spec FR-4 使用 `'write'` 类型名。功能上等价（都表示独立展示的内置工具），但命名不一致可能导致实现时的困惑。建议统一为 `'standalone'`（更通用，因为不只有 write）。

2. **plan T7 缺少 StreamingMessage isStreaming prop 传递说明**: 当前 StreamingMessage 已接收 `isStreaming` prop 并传给 MessageBubble。Plan 描述了移除 CompactStreamingBubble，但未明确 streaming 路径中 isStreaming 如何传递到 AgentRunBlock。实际上路径是 StreamingMessage(isStreaming) → MessageBubble(isStreaming) → AssistantContent(isStreaming) → AgentRunBlock(isStreaming)，每层都已正确传递。建议在 T7 中补充这条链路说明。

---

## 7. Verdict

**PASS** — 0 个 MUST_FIX 问题。

Plan 与 spec 完全对齐，任务拆分粒度合理，依赖图无环，代码结构验证通过。2 个 SHOULD_FIX 均为文档表述问题，不影响实现正确性。
