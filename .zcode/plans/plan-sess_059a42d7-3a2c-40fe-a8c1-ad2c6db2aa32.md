# Streaming 视觉反馈增强方案

## 问题根因

| 问题 | 根因 |
|---|---|
| **P1 发送后无光标** | `setDispatching` → `message_start` 的空窗期（0.5-2s），MessageStream 内无 assistant message，无任何 streaming 视觉。`dispatchingSessionId` 仅驱动 Composer 的停止按钮，不影响消息流。 |
| **P2 toolCall 在光标下方** | `contentBlocks` 按事件到达顺序 push，但 `text` 块是幂等的（首个 `text_delta` 时 push 一次，位置固定）。当流程是 `文字 → tool_call → 更多文字` 时，text 块始终在 contentBlocks 开头，toolCall 在其后 → 光标（附加在 text 块尾部）渲染在 toolCall 上方。 |
| **P3 streaming 不够显眼** | turn-meta（工作中 Xs）不固定，滚动即消失。光标仅 7px 细竖条，无 spinner。design-system.md §8 规定「流式内容用光标脉冲，不用 spinner」（用户选择推翻此约定）。 |

## 改动总览（3 层）

```
P1 修复：dispatching 空窗期占位 — MessageStream 末尾追加「思考中」占位行
P2 修复：光标永远在最后 — streaming 态光标从 Block 内移到 trace 末尾独立元素
P3 增强：sticky working header + spinner — working turn 的 meta sticky 固定 + 替换为 spinner 样式
```

---

## P1：dispatching 空窗期占位

### 目标
发送消息后到 `message_start` 之间（dispatching 空窗期），在消息流末尾显示「思考中…」占位行，给用户即时反馈。

### 实现

**`packages/renderer/src/components/panel/MessageStream.vue`** — contentEl 末尾追加占位：

```vue
<!-- dispatching 空窗期占位：已发送但 message_start 未到 -->
<div v-if="isDispatching && !hasWorkingTurn" class="flex items-center gap-2 py-2 pl-1 text-[12.5px] text-muted">
  <Loader2 class="size-3 animate-spin text-accent" />
  <span>思考中…</span>
</div>
```

新增 computed：
- `isDispatching`：从 chat store 读 `chat.dispatchingSessionId === props.sessionId`
- `hasWorkingTurn`：`lastRenderTurn.value?.isWorking ?? false`（message_start 到达后，working turn 接管反馈，占位消失）

**逻辑**：`isDispatching && !hasWorkingTurn` —— dispatching 期间且尚无 streaming assistant 消息时显示。`message_start` 到达后 `hasWorkingTurn` 变 true，占位消失，由 working turn 的 sticky header 接管。

### 为什么不改动 Message 数据结构
不在 store 层插入「占位 assistant message」——这会污染消息历史，`message_start` 真正到达后需要清理，增加复杂度和状态不一致风险。占位是纯 UI 层的瞬时反馈，MessageStream 自己判断即可。

---

## P2：光标永远在最后

### 目标
streaming 态下，闪烁光标始终在 trace 的**最后一行**渲染，无论最后是 text 块还是 toolCall 块。

### 根因细节
当前 `isStreamingBlock` 只在末位 assistant 的 text 块显示光标。当 contentBlocks 顺序是 `[text, toolCall]` 时（先有文字后有工具调用），光标在 text 块尾部，toolCall 块在其下方 → 光标不在最后一行。

### 实现方案：trace 末尾追加独立光标行

**`packages/renderer/src/components/panel/message-stream/Turn.vue`** — trace 区末尾追加光标元素：

在 `<div v-if="showTrace">` 内的 `</template>` 之后追加：

```vue
<div v-if="showTrace && turn.isWorking" class="streaming-tail flex items-center gap-1.5 py-2 pl-1">
  <span class="streaming-cursor inline-block h-3.5 w-[7px] rounded-[1px] bg-accent animate-blink" />
</div>
```

**关键变更**：
1. **移除** Block.vue 内 text 块的光标（`Block.vue:34` 的 `v-if="streaming"` span）——光标不再跟随 text 块
2. **移除** Block.vue 内 running tool 详情尾部的光标（`Block.vue:115`）——统一到 trace 末尾
3. **Turn.vue 不再传 `:streaming` prop 给 Block**（prop 保留但不再传入 true，保持向后兼容）
4. **trace 末尾独立光标行**：只要 `turn.isWorking` 就渲染，它在所有 Block 之后，保证永远在最后一行

### 为什么不改 contentBlocks 排序
改 contentBlocks 时序（如每次 text_delta 都把 text 块移到末尾）会导致文字在 trace 内跳跃闪烁，破坏阅读连贯性。光标独立于内容块、固定在 trace 末尾是最干净的解法。

---

## P3：sticky working header + spinner

### 目标
1. streaming 时，turn-meta（工作中 Xs）sticky 固定在消息流顶部，滚动时不消失
2. 用 spinner + 「思考中」替换原来的脉冲点 + 「工作中」文字

### 实现

**`packages/renderer/src/components/panel/message-stream/Turn.vue`** — turn-meta Button 改造：

```vue
<!-- turn-meta：working 态 sticky 固定 -->
<Button
  v-if="turn.assistants.length > 0"
  variant="ghost"
  size="sm"
  class="turn-meta h-auto w-fit items-center justify-start gap-2.5 self-start px-1 py-1 font-sans text-[12.5px] font-medium transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
  :class="[
    turn.isWorking ? 'sticky top-0 z-[1] -mx-1 rounded-md bg-surface/95 px-2 backdrop-blur-sm' : '',
    turn.isWorking || !turn.hasFoldable ? 'cursor-default hover:text-muted' : 'cursor-pointer hover:text-fg',
  ]"
  :disabled="turn.isWorking || !turn.hasFoldable"
  @click="expanded = !expanded"
>
  <!-- working 态：spinner 替换脉冲点 -->
  <Loader2 v-if="turn.isWorking" class="size-3 animate-spin text-accent" />
  <span class="text-[12.5px] font-medium">
    <!-- working 态文案改「思考中」 -->
    <span class="lbl" :class="turn.isWorking ? 'text-accent' : 'text-muted'">{{ turn.isWorking ? '思考中' : '已工作' }}</span>
    <span class="elapsed font-mono font-medium tracking-[0.01em] text-fg">{{ elapsed }}</span>
  </span>
  <!-- chevron / badge 不变 -->
</Button>
```

**改动点**：
1. `sticky top-0 z-[1] bg-surface/95 backdrop-blur-sm`：working 态 sticky（参考 SessionList.vue 的组标题 sticky 约定），`-mx-1 + px-2` 补偿 parent padding 让背景条通栏
2. `<Loader2 animate-spin>` 替换 `<span working-dot animate-working-pulse>`：spinner 更显眼
3. 文案「工作中」→「思考中」（更贴合用户心智）
4. working 态文字加 `text-accent` 强调

**非 working 态不变**：完成态的 turn-meta 正常滚动（无 sticky 类），保持现有行为。

**import 变更**：Turn.vue 新增 `import { Loader2 } from '@lucide/vue'`。

---

## P3 配套：更新 design-system.md §8

**`docs/page-design/design-system.md`** line 68：

```
旧：首屏内容区用骨架屏（shimmer）；按钮/异步动作用行内 spinner（14px accent）；流式内容用光标脉冲，不用 spinner。
新：首屏内容区用骨架屏（shimmer）；按钮/异步动作用行内 spinner（14px accent）；流式态用 spinner（turn-meta sticky header）+ 末尾光标脉冲（内容增长指示），两者配合。
```

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/renderer/src/components/panel/MessageStream.vue` | P1: dispatching 空窗期占位行 + isDispatching/hasWorkingTurn computed |
| `packages/renderer/src/components/panel/message-stream/Turn.vue` | P2: trace 末尾独立光标行，移除 Block streaming prop 传递；P3: turn-meta sticky + spinner + 「思考中」文案 |
| `packages/renderer/src/components/panel/message-stream/Block.vue` | P2: 移除 text 块光标（L34）+ tool running 光标（L115），streaming prop 保留但不再被驱动 |
| `docs/page-design/design-system.md` | P3: 更新 §8 streaming 约定 |

---

## 不做的事

- **不改 contentBlocks 时序逻辑**（P2 用末尾独立光标解决，不改数据层）
- **不引入新 store 字段**（dispatching 空窗期判断纯用现有 `dispatchingSessionId` + `isWorking`）
- **不改 useChatScroll**（sticky 不影响 auto-scroll，sticky 元素在滚动容器内，ResizeObserver 和 stickToBottom 逻辑不变）
- **不改 Block.vue 的 streaming prop 定义**（保留向后兼容，只是不再传 true；未来如需可恢复）

---

## 验证清单

- [ ] 发送消息后（dispatching 空窗期）立即看到「思考中…」+ spinner 占位
- [ ] message_start 到达后占位消失，working turn 的 sticky header 接管
- [ ] streaming 时光标始终在 trace 最后一行（text → toolCall 流程时光标在 toolCall 下方）
- [ ] 向上滚动消息流时，working turn 的「思考中 Xs」sticky 固定在顶部
- [ ] streaming 结束后 sticky 消失，turn-meta 恢复正常滚动 + 「已工作 Xs」文案
- [ ] 完成的 turn 不 sticky（只有 working turn sticky）
- [ ] vue-tsc / lint / 现有测试全绿