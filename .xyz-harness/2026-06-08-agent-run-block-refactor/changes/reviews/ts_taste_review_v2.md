# TypeScript 品味审查 v2

**审查范围**: v1 标记的 6 个 must-fix 修复验证
**审查基准**: v1 → 当前代码 diff

---

## 修复验证结果

### MF-1: Timer 重复 → `useLiveTimer` composable — **部分修复**

`useLiveTimer.ts` composable 已创建，API 清晰（`{ now, start, stop }`），`onBeforeUnmount` 自动清理。

| 组件 | 状态 | 说明 |
|------|------|------|
| `AgentRunBlock.vue` | ✅ 已迁移 | `useLiveTimer(200)` |
| `MergeBlock.vue` | ✅ 已迁移 | `useLiveTimer(200)` |
| `StandaloneToolCard.vue` | ❌ 未迁移 | 仍有 15 行内联 timer 逻辑（`TIMER_UPDATE_INTERVAL_MS`、`now`、`startTimer`、`stopTimer`、`onMounted`、`onUnmounted`） |
| `ThinkingBlock.vue` | ❌ 未迁移 | 仍有 ~20 行内联 timer + 额外的 `localStartTime` 状态 |
| `ToolCallCard.vue` | ❌ 未迁移 | 仍有 15 行内联 timer 逻辑 |

**剩余问题**: composable 存在但 3/5 组件未使用。`ThinkingBlock` 有额外的 `localStartTime` 逻辑，需要扩展 composable 或在组件内补充。

**结论**: composable 基础设施就位，但完成度 40%。剩余 3 个组件迁移是纯机械操作。

---

### MF-2: `resolveToolCall` 等重复 → composable 或预解析 — **未修复**

`resolveToolCall` 仍存在于 **4 个组件**中（比 v1 多发现 1 个）：

| 组件 | resolveToolCall | resolveThinking | resolveThinkingContent |
|------|:---:|:---:|:---:|
| `AgentRunBlock.vue` | ✗ | — | — |
| `MergeBlock.vue` | ✗ | ✗ | ✗ |
| `AssistantContent.vue` | ✗ | — | ✗ |
| `CompactSummaryBar.vue` | ✗ | — | — |

全部是 `message.toolCalls?.find(tc => tc.id === refId)` 的复制粘贴。

**结论**: 完全未动。v1 建议了两个方案（composable 或 section 预解析），都没实施。

---

### MF-3: Markdown 文本模板重复 → `<MessageBody>` 组件 — **未修复**

`msg__body` 模板仍在 `AgentRunBlock.vue` 和 `AssistantContent.vue`（2 处）中内联，结构完全相同：

```html
<div class="msg__body select-text py-1 leading-[1.6] text-fg text-xs"
     :data-message-id="..." :data-markdown-source="..." @click="handleBodyClick">
  <span v-html="renderedContent" />
  <span v-if="isStreaming" class="...animate-blink..." />
</div>
```

`<MessageBody>` 组件未创建。

**结论**: 完全未动。

---

### MF-4: `isCustomTool` 死 prop — **已修复 ✅**

`StandaloneToolCard.vue` 的 props 现在只有 `{ toolCall: ToolCall }`，`isCustomTool` 已删除。`AgentRunBlock.vue` 中 `standalone` 和 `customTool` section type 的区分在分组层完成，card 组件无需感知。

---

### MF-5: `!` 非空断言 → v-if 守卫 — **已修复 ✅**

所有 3 处 `resolveToolCall(...)!` 现在都有 v-if / v-else-if 守卫：

```html
<!-- AgentRunBlock.vue -->
v-else-if="section.type === 'standalone' && resolveToolCall(section.blocks[0]?.refId)"
:tool-call="resolveToolCall(section.blocks[0].refId)!"

<!-- MergeBlock.vue -->
v-else-if="block.type === 'toolCall' && resolveToolCall(block.refId)"
:tool-call="resolveToolCall(block.refId)!"

<!-- AssistantContent.vue -->
v-if="resolveToolCall(block.refId)"
:tool-call="resolveToolCall(block.refId)!"
```

`!` 断言仍存在但在守卫保护下是安全的。**附带问题**: 每次渲染调用 `resolveToolCall` 两次（v-if 一次、prop 一次）。在 `ToolCallCard` 的 `v-else-if` 链中不影响正确性，但有微小性能浪费。可通过 section 预解析彻底消除（与 MF-2 同一方案）。

---

### MF-6: `fileEditCount` → `standaloneToolCount` — **已修复 ✅**

- 变量名已改为 `standaloneToolCount`
- Footer 文案：`{{ standaloneToolCount }} 次工具操作`
- 语义与实际计数逻辑（`tcs.filter(tc => standalone.has(tc.toolName)).length`）一致

---

## v1 Should-Fix 额外检查

### SF-1: `groupByContentBlocksLegacy` 命名 — **未修复**

`message-layout.ts:132` 仍为 `groupByContentBlocksLegacy`。函数名暗示"待废弃旧路径"，但实际是"无 standaloneTools 配置时的分组逻辑"。

---

## 总结

| v1 编号 | 问题 | v2 状态 | 说明 |
|---------|------|---------|------|
| MF-1 | Timer 重复 5 次 | **部分修复** | composable 已创建，2/5 组件已迁移，3 个未迁移 |
| MF-2 | resolveToolCall 重复 3 次 | **未修复** | 4 个组件仍有各自独立的 resolver |
| MF-3 | Markdown 模板重复 3 次 | **未修复** | `<MessageBody>` 组件未创建 |
| MF-4 | isCustomTool 死 prop | ✅ 已修复 | — |
| MF-5 | `!` 非空断言 | ✅ 已修复 | v-if 守卫已添加 |
| MF-6 | fileEditCount 命名 | ✅ 已修复 | 改为 `standaloneToolCount` |

**修复率**: 6 个 must-fix 中 3 个完全修复，1 个部分修复，2 个未动。

---

```yaml
verdict: needs_work
must_fix:
  - "MF-1 剩余: StandaloneToolCard、ThinkingBlock、ToolCallCard 三个组件迁移到 useLiveTimer composable（ThinkingBlock 的 localStartTime 逻辑需考虑如何融入）"
  - "MF-2: resolveToolCall/resolveThinking 等 resolver 在 4 个组件中重复（AgentRunBlock、MergeBlock、AssistantContent、CompactSummaryBar），需抽取 composable 或在 section 预解析"
  - "MF-3: msg__body markdown 渲染模板在 AgentRunBlock 和 AssistantContent 中重复，需抽取 MessageBody 组件"
```
