---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 10
  issues_found: 5
  must_fix_count: 0
  low_count: 4
  info_count: 1
---

# Standards Review v1-1

**Date**: 2026-06-08
**Scope**: AgentRunBlock refactor — 10 files
  settings.ts, message-layout.ts, useLiveTimer.ts,
  AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue,
  AssistantContent.vue, AssistantSection.vue, ChatPanel.vue, SystemPane.vue
**Basis**: docs/standards.md, CLAUDE.md 前端编码规范, style.css CSS 变量

---

## Phase A: Lint 结果

`npm run lint` — 0 errors / 11 warnings。本次改动文件引入 7 处 warning：

| 文件 | 行 | 规则 | 值 | 说明 |
|------|-----|------|----|------|
| AgentRunBlock.vue | 136 | no-magic-numbers | `200` | useLiveTimer 默认间隔 |
| MergeBlock.vue | 128 | no-magic-numbers | `200` | useLiveTimer 默认间隔 |
| MergeBlock.vue | 167 | no-magic-numbers | `1000` | 毫秒阈值（`ms < 1000`） |
| StandaloneToolCard.vue | 45 | no-magic-numbers | `100` | useLiveTimer 间隔 |
| StandaloneToolCard.vue | 56 ×2 | no-magic-numbers | `50` | 路径截断长度 |
| useLiveTimer.ts | 7 | no-magic-numbers | `200` | 默认 intervalMs |

另有 4 处 pre-existing warning（QueueComponent:3000, SendModeStatusBar:button ×2, extension-service:5），非本次改动。

---

## Phase B: 逐项规范检查

### 1. 禁止 `any` — PASS

全部 10 个文件无 `any` 类型使用。类型导入均来自 `@xyz-agent/shared`，类型标注完整。

### 2. 禁止原生 HTML 表单交互元素 — PASS（有注释）

| 文件 | 元素 | eslint-disable | 理由评估 |
|------|------|----------------|----------|
| StandaloneToolCard.vue:6 | `<button>` | `taste/no-native-html-elements` | 可折叠区域 toggle，xyz-ui Button 的 padding/focus 样式会干扰紧凑行内布局。**理由充分** |
| ChatPanel.vue:111 | `<button>` | — | 滚动到底部 FAB，icon-only 浮动按钮，xyz-ui 无对应组件。**可接受** |
| SystemPane.vue:141 | `<label>` | — | 非交互元素，仅用于 click 传递和可访问性。**不违规** |

无 `<input>`, `<select>`, `<textarea>`, `<form>` 使用。

### 3. 禁止 Emoji — PASS

全部文件无 Emoji。MergeBlock 使用 inline SVG chevron 图标。

### 4. 禁止硬编码颜色 — PASS（1 处可接受例外）

AgentRunBlock.vue:187 `rgba(255, 255, 255, 0.3)` — streaming 状态条 shimmer 渐变叠加层。白色半透明叠加是纯视觉效果，不受主题颜色影响，用 CSS 变量反而语义不清。**可接受**。

其余所有颜色均使用 CSS 变量（`--accent`, `--success`, `--danger`, `--border`, `--surface`, `--muted`, `--fg`, `--bg`, `--muted-dim`, `--agent`）和 `color-mix(in oklch, ...)` 函数。未新增 CSS 变量。**符合 spec 约束 #5**。

### 5. 禁止魔数间距 — 低优先级问题

**Tailwind 模板中的魔数**（需关注）：

| 文件 | 值 | 说明 |
|------|-----|------|
| ChatPanel.vue:84 | `mb-[3px]` | "助手"标签下边距 |
| ChatPanel.vue:21 | `gap-[6px]` | 消息间距微调 |
| SystemPane.vue:86,107 | `py-[9px]` | section header 纵向内边距 |
| SystemPane.vue:91,97 | `min-w-[76px]` | label 最小宽度 |
| SystemPane.vue:165,180 | `py-[6px]` | palette button 纵向内边距 |

**scoped CSS 中的布局值**（低优先级，项目 design-system 未定义对应 token）：

| 文件 | 值 | 说明 |
|------|-----|------|
| MergeBlock.vue | `gap: 6px`, `padding: 5px 8px`, `height: 28px` | merge-bar 布局 |
| MergeBlock.vue | `font-size: 10px`, `11px`, `9px` | 字体大小 |
| StandaloneToolCard.vue | `border-left-width: 2px`, `padding: 3px 0 3px 8px` | 左侧边框卡片布局 |

**评估**：SystemPane.vue 的 `py-[9px]`/`py-[6px]`/`min-w-[76px]` 是 Settings 视觉 demo 的精确还原，属于已有样式。ChatPanel 的微调间距属于 UI 精细调整。scoped CSS 值集中在新组件内部，作为布局微调合理。**不阻塞合并**，后续统一间距 token 时跟进。

### 6. 行数上限（template ≤ 400, script ≤ 300） — PASS

| 文件 | template | script | 总行数 | 状态 |
|------|----------|--------|--------|------|
| AgentRunBlock.vue | ~50 | ~114 | 197 | PASS |
| MergeBlock.vue | ~46 | ~121 | 290 | PASS |
| StandaloneToolCard.vue | ~29 | ~80 | 192 | PASS |
| AssistantContent.vue | ~27 | ~73 | 152 | PASS |
| ChatPanel.vue | ~77 | ~163 | 388 | PASS |
| SystemPane.vue | ~68 | ~80 | 191 | PASS |
| AssistantSection.vue | ~11 | ~21 | 88 | PASS |
| useLiveTimer.ts | — | 18 | 23 | PASS |

### 7. emit 只传单个 payload 对象 — PASS

ChatPanel.vue `defineEmits` 全部使用单参数 payload 签名。`emit('switch-agent', id)` 中 id 是 string（非多参数 emit）。

### 8. v-model 绑定 — PASS

SystemPane.vue standaloneTools checkbox 使用 Toggle 组件 + `@update:checked` 事件处理函数（`toggleStandaloneTool`）。其他 Select 组件均为 v-model 单值绑定。无 `:value + @input` 反模式。

### 9. Promise.allSettled — PASS

全部文件无 `Promise.all` 使用。本次改动不涉及并行请求。

### 10. 样式三层结构 — PASS

- **Design tokens**（style.css）：未新增 CSS 变量
- **Template class**（模板）：组件模板统一使用 Tailwind 工具类
- **Escape hatch**（`<style scoped>`）：MergeBlock / StandaloneToolCard / AgentRunBlock 的 scoped style 用于 Tailwind 无法表达的伪类（`.merge-bar:hover`）、动画 keyframes（`@keyframes run-sweep`、`@keyframes merge-pulse`）、`color-mix()` 背景色。使用合理

`@apply` 使用：**未检测到**。

### 11. border-radius 规范 — PASS

默认使用 `rounded-sm`（1px）。AgentRunBlock 状态条 `rounded-t-sm`、StandaloneToolCard badge `border-radius: 100px`（胶囊形）属特殊场景，**可接受**。

### 12. 禁止 `@apply` — PASS

全部文件未使用 `@apply`。

---

## Phase C: TypeScript 质量

### C1. message-layout.ts

- `ALL_PI_TOOLS` 使用 `as const` 断言，类型安全
- `isMergeBlock` 函数逻辑清晰，参数类型正确
- `groupIntoSections` 签名兼容旧调用方（`standaloneTools?` 可选参数），API 兼容策略合理
- `groupByContentBlocks` 中 `flushMerge` 闭包模式简洁
- `SectionType` 联合类型包含新旧两套（`merge`/`standalone`/`customTool` + `thinking`/`toolCall`），语义有重叠但不影响运行时正确性

### C2. useLiveTimer.ts

- 职责单一，18 行
- `onBeforeUnmount(stop)` 确保清理
- 多组件复用（AgentRunBlock / MergeBlock / StandaloneToolCard），timer 逻辑不重复

### C3. AgentRunBlock.vue — `EnrichedSection.type` 类型安全性

```typescript
interface EnrichedSection {
  type: string  // ← 应为 SectionType
  blocks: ContentBlock[]
  toolCall?: ToolCall
}
```

`type` 使用 `string` 而非从 `message-layout.ts` 导入的 `SectionType`。若 section 类型被拼错（如 `'standlone'`），TypeScript 不会报错。

**建议**：将 `type` 改为 `SectionType`。**低优先级**。

---

## Phase D: 架构一致性

### D1. compactStreaming 开关隔离

AgentRunBlock 仅在 `compactStreaming=true` 时激活。`false` 时走原有 `groupByContentBlocksLegacy` + `AssistantSection` 路径。两条路径完全隔离，无交叉依赖。**符合 spec 约束 #6**。

### D2. 数据流方向

settings store → `standaloneTools` → `groupIntoSections` → sections → AgentRunBlock → MergeBlock/StandaloneToolCard

数据单向流动，无反向修改。**符合规范**。

### D3. 组件复用

- MergeBlock 展开时复用 `ThinkingBlock` 和 `ToolCallCard`
- StandaloneToolCard 展开时复用 `ToolCallCard`
- **符合 spec 约束 #4**

### D4. CSS 变量一致性

新组件使用的 CSS 变量与项目现有变量完全一致（`--accent`, `--success`, `--danger`, `--border`, `--surface`, `--muted`, `--muted-dim`, `--fg`, `--bg`, `--agent`）。**未新增 CSS 变量**。**符合 spec 约束 #5**。

---

## Phase E: spec 合规性（编码规范相关）

| spec 约束 | 状态 | 说明 |
|-----------|------|------|
| #1 不改共享类型 | PASS | Message/ContentBlock 类型未修改 |
| #4 复用现有组件 | PASS | ThinkingBlock/ToolCallCard 正确复用 |
| #5 CSS 变量复用 | PASS | 无新增 CSS 变量 |
| #7 设置存储 | PASS | standaloneTools 通过 settingsStore 持久化，persist.pick 包含 |

---

## 问题汇总

| # | 问题 | 文件 | 严重度 |
|---|------|------|--------|
| 1 | `EnrichedSection.type` 使用 `string` 而非 `SectionType`，降低类型安全性 | AgentRunBlock.vue | 低 |
| 2 | `resolveToolCall` 对同一 block 在 template 中双重调用（v-if 一次 + bind 一次） | MergeBlock.vue:44-46 | 低 |
| 3 | magic numbers 未提取为命名常量（`200`, `1000`, `50`, `60`） | MergeBlock.vue, StandaloneToolCard.vue, useLiveTimer.ts | 低 |
| 4 | `SectionType` 新旧类型共存（`merge`/`standalone` vs `thinking`/`toolCall`），后续维护可能产生混淆 | message-layout.ts | 信息 |
| 5 | MergeBlock streaming 模式缺少 `toolPath` 返回 `"undefined"` 字符串的防护（StandaloneToolCard 已有防护） | MergeBlock.vue:89 | 低 |

---

## 审查总结

**verdict: pass**

全部 MUST-FIX 级别规范项均通过：禁止 `any`、禁止原生表单元素、禁止 Emoji、emit 单 payload、行数上限、样式三层结构、border-radius 规范、禁止 `@apply`。发现 0 个 must-fix 级别问题。

5 个低优先级建议不阻塞合并，可在后续迭代中处理。
