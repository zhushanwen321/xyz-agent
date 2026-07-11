# 方案 A：streaming 期间末位 text 走 summary 位，消除停止时样式跳变

## 根因回顾

streaming 时末位 assistant 的 text 在 trace text 块里渲染（`Block.vue:32`：12.5px / muted 灰 / 虚线下划线），停止瞬间 `traceBlocks` 把末位 text 从 trace 移除 + summary 位的 `v-if` 激活，同一段文本跳到 `Turn.vue:182`（13.5px / fg 正常色 / 无线），产生字号、颜色、行高突变。

## 改动思路

让末位 assistant 的 text **从头到尾都在 summary 位渲染**（streaming 和 complete 一致），trace 内只放过程块（thinking / tool / 中间 text）。停止时文本位置和样式零变化，只是光标消失 + trace 折叠。

## 具体改动（2 个文件）

### 1. `Turn.vue` — 3 处

**a) `traceBlocks`：始终跳过末位 text（不再区分 working/complete）**

```ts
function traceBlocks(msg: Message, idx: number): OrderedBlock[] {
  const blocks = expandAssistantBlocks(msg)
  // 末位 assistant 的 text 始终在底部 summary 位渲染（streaming 带 cursor / complete 终态），
  // trace 内跳过末位 text，只保留过程块（thinking / tool / 中间 text）。
  if (idx === lastAssistantIdx.value) {
    return blocks.filter((b) => b.kind !== 'text')
  }
  return blocks
}
```

删除 `!props.turn.isWorking` 条件——无论 streaming 还是 complete，末位 text 都不在 trace 里。

**b) summary 区 v-if：去掉 `!turn.isWorking` 守卫 + streaming 时光标挂到 summary 末尾**

```html
<!-- 收尾 summary：streaming 和 complete 都渲染。
     streaming 态 text 在此实时展示 + 末尾光标（与 trace 块同位）；
     complete 态光标消失，仅文本。消除停止时 text 从 trace(12.5px/muted) → summary(13.5px/fg) 的样式跳变。 -->
<div v-if="summaryText" class="turn-summary group/ai pt-3 text-[13.5px] leading-7 text-fg">
  <MarkdownRenderer :content="summaryText" :session-id="sessionId" />
  <!-- streaming 光标：行内闪烁竖条，紧跟 summary 末尾（原 trace 末尾 streaming-tail 移入此处） -->
  <span v-if="turn.isWorking" class="streaming-cursor ml-0.5 inline-block h-3.5 w-[7px] rounded-[1px] bg-accent align-middle animate-blink" />
  <!-- hover actions：仅 complete 态（streaming 不显示） -->
  ...
</div>
```

**c) trace 末尾的 `streaming-tail` 光标：删除**（已移入 summary 位）。删除模板 173-175 行的 `<div v-if="turn.isWorking" class="streaming-tail ...">` 整块。

### 2. `turn-working.test.ts` — 更新受影响断言（U15–U18）

| 用例 | 原断言 | 改后断言 |
|------|--------|----------|
| U15 | streaming trace 含 2 块（text + tool），断言第一块非 tool | streaming trace 只含 tool 块（末位 text 跳过），断言 trace 只 1 块且是 tool。summary 存在 |
| U16 | streaming trace 含 2 块（tool + text） | 同上，trace 只剩 tool 块。summary 存在 |
| U17 | streaming 态 `.turn-summary` 不存在 | **反转**：streaming 态 `.turn-summary` **存在** |
| U18 | streaming 时 summary 不存在 → complete 后出现 | streaming 时 summary 就存在（含 text），complete 后仍存在 |
| U19 | complete 态 trace 跳过末位 text | **不变**（行为一致） |

另外新增一条回归用例（首屏冒烟）：streaming 态 summary 存在 + streaming-cursor 存在；complete 后 cursor 消失但 summary 仍在。

## 不改动的部分

- `Block.vue`：不改。text 块的样式（12.5px/muted/虚线）保留给**中间 text 块**（多 assistant 回合中非末位的 assistant text），它们是过程性信息，小字号灰色合理。
- `MarkdownRenderer.vue`：不改。
- `messageTurns.ts`：不改。

## 边界处理

- **多 assistant 回合**：非末位 assistant 的 text 块仍在 trace 内（`traceBlocks` 只跳过 `idx === lastAssistantIdx`），保留过程性样式。
- **summaryText 为空**（streaming 初始阶段 text 还没到）：`v-if="summaryText"` 守卫，summary 不渲染。光标此时无处可挂——这是可接受的，因为 text_delta 到达后 summary 立即出现 + 带光标。如果需要在 text 到达前就显示光标，可加 `v-if="summaryText || turn.isWorking"` + 空内容时单独渲染光标，但这会让 summary 容器在无文本时空着——先不加，看实际效果。
- **complete 态但 summary 文本和 trace 内中间 text 内容相同的情况**：不存在，`summaryText` 只取最后一条 assistant 的 content，中间 assistant 的 content 在各自的 trace text 块里。