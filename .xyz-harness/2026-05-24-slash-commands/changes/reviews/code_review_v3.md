---
review:
  type: code_review
  round: 3
  timestamp: "2026-05-25T17:15:00"
  target: "slash-commands feature (v3 diff: 11 files changed, ~1670 lines added/modified)"
  verdict: fail
  summary: "编码评审完成，第3轮，MUST FIX #2 部分修复但存在时序缺口，需补充后重审"

statistics:
  total_issues: 2
  must_fix: 1
  low: 1

issues:
  - id: 2
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/chat/ChatInput.vue:117-128 + useChat.ts"
    title: "editorText 捕获链路在 in-session navigate 场景下中断（onMounted/watch(sessionId) 均不触发）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "src-electron/renderer/src/components/panel/SessionTreePanel.vue:155-156"
    title: "onMounted 中 fetchTree 和 onPath 计算可能因 buildPathToRoot 延迟导致首次闪烁"
    status: open
    raised_in_round: 3
    resolved_in_round: null
---

# 编码评审 v3（增量审查）

## 评审记录
- 评审时间：2026-05-25 17:15
- 评审类型：编码评审（增量模式，验证 MUST FIX #2 修复）
- 评审对象：v3 diff（11 个文件变更，ChatInput.vue + PanelBar.vue + SessionTreePanel.vue + tree store + event-adapter + session-service + session-tree-reader + types + protocol + extension）

---

## 审查：MUST FIX #2 修复验证

### 修复内容（v3）

**ChatInput.vue 新增**：
- 导入 `onMounted` from `vue`
- 导入 `consumePendingEditorText` from `useChat`
- `watch(() => props.sessionId, ...)` — sessionId 变化时在 `nextTick` 中消费 `pendingEditorText`
- `onMounted` — 首次挂载时消费 `pendingEditorText`

### 验证：修复是否充分

**正向分析**：

| 场景 | 触发器 | 结果 |
|---|---|---|
| Fork 创建新 session + `session.switch` → panel sessionId 变更 | `watch(sessionId)` 触发 | ✅ EditorText 正确填充 |
| 应用首次加载时 `pendingEditorText` 已存在 | `onMounted` 触发 | ✅ EditorText 正确填充 |
| `consumePendingEditorText()` 消费后置 null | 先消费，后调用返回 null | ✅ 无重复填充 |

**覆盖缺口分析**：

核心场景 **in-session navigate** 未被覆盖：

```
用户操作流程：
  1. 用户在当前 session 的另一个 branch 上选中一个 user message node
  2. 点击 "Navigate here" 按钮
  3. sidecar 处理 navigate 请求，返回 editorText
  4. useChat.ts 的 session.tree-navigate-result 处理器：
     a. ✅ pendingEditorText = msg.payload.editorText
     b. ✅ send(session.history)  — 刷新消息列表
     c. ✅ send(session.tree-data) — 刷新树
  5. 但此时：
     ❌ props.sessionId 未变化（in-session navigate，session 不变）
     ❌ ChatInput 已挂载（onMounted 已运行）
     ❌ watch(sessionId) 不触发
  6. ❌ editorText 永不被消费 → 存储泄漏
```

**根本原因**：`pendingEditorText` 是一个模块级普通变量（non-reactive），ChatInput 没有 reactive 机制来感知它在 5 秒后发生了变化。

### 修复建议

两种方案，推荐方案 1：

**方案 1（推荐）**：在 `useChat.ts` 中 `session.tree-navigate-result` 处理器设置 `pendingEditorText` 后，通过 event-bus 触发一个自定义事件。ChatInput.vue 在 `onMounted` 中监听该事件。

```
// useChat.ts — navigate result handler 末尾
emitter.emit('editor-text-pending', editorText)

// ChatInput.vue
import { on } from '../../lib/event-bus'

onMounted(() => {
  // 首次 mount 时检查存量
  const text = consumePendingEditorText()
  if (text) text.value = text

  // 后续 navigate 事件监听
  const unsub = on('editor-text-pending', (editorText: string) => {
    text.value = editorText
  })
  onUnmounted(() => unsub())
})
```

**方案 2（更简单）**：直接把 `pendingEditorText` 做成一个 exported `ref`，ChatInput 用 `watch` 监听。但 `useChat.ts` 是模块级导出非 composable，需要改成 composable 模式或独立导出 ref。

**方案 3（最小改动）**：在 ChatInput 中添加一个 `watch` 或 `computed` 对 ChatStore 中消息长度的变化（navigate 后 `session.history` 刷新会增加消息数），在消息变化时也消费 `pendingEditorText`。但这引入了隐含耦合，不推荐。

---

## 新增问题

### [LOW] Issue #3: SessionTreePanel 首次加载时 onPath 计算时序

**位置**：`src-electron/renderer/src/components/panel/SessionTreePanel.vue:210-211`

```typescript
onMounted(() => {
  if (sessionState.value.tree.length === 0) {
    fetchTree(props.sessionId)
  }
  requestCapability(props.sessionId)
})
```

**问题**：`fetchTree` 在 `onMounted` 中异步调用，返回值通过 `session.tree-data` 事件写入 store。在事件到达前的渲染周期中：
- `flatNodes` 为空数组，`hasNodes` 为 `false`
- UI 显示 "No tree data available"
- 当事件到达后（可能在数十到数百 ms 后），store 更新 → 渲染节点

这是正常的首次加载空白状态，不是 bug。但需要注意：如果 `leafId` 在这个窗口期内尚未到位（它是 `session.tree-data` 的一部分，与 tree 同时返回），`buildPathToRoot` 会构建空路径，所有节点的 `onPath` 属性均为 `false`。虽然这只是一个短暂的闪烁（数据到达后刷新），但后续优化可通过在 `tree-data` 事件到达前显示骨架屏而非 "No tree data available" 来改善体验。

**严重程度**：LOW。功能正确，体验小幅优化空间。

---

## 结论

**MUST FIX #2 的修复代码是正确的（`onMounted` + `watch(sessionId)`），但时序缺口存在：in-session navigate 场景（sessionId 不变）下，editorText 被捕获后永远不会被 ChatInput 消费。**

当前修复覆盖了：
- 跨 session 切换 ✅
- 首次挂载 ✅

但未覆盖：
- 同 session 内 navigate ❌

**状态**：`fail`（1 条 open MUST FIX）。建议采用方案 1（event-bus 事件驱动）补充修复后提交第 4 轮审查。
