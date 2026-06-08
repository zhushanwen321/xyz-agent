# Standards Review v1-1

**Date**: 2026-06-08
**Scope**: AgentRunBlock refactor — 10 files (settings.ts, message-layout.ts, AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue, AssistantContent.vue, ChatPanel.vue, SystemPane.vue, AssistantSection.vue, useLiveTimer.ts)
**Reviewer**: AI standards reviewer
**Basis**: docs/standards.md + CLAUDE.md 前端编码规范

---

## Phase A: Lint 结果

`npm run lint` 通过，0 errors / 7 warnings（均为 pre-existing）。本次改动引入 3 处 warning：

| 文件 | 行 | 规则 | 说明 |
|------|-----|------|------|
| MergeBlock.vue | ~178 | no-magic-numbers | `1000`（毫秒阈值） |
| StandaloneToolCard.vue | ~83 | no-magic-numbers | `50`（路径截断长度）×2 |

均为低优先级 magic numbers，含义明确，不阻塞合并。

---

## Phase B: 逐项规范检查

### 1. 禁止 `any` — PASS

全部 10 个文件无 `any` 类型使用。类型标注完整，import 类型均从 `@xyz-agent/shared` 导入。

### 2. 禁止原生 HTML 表单交互元素 — PASS（有注释）

| 文件 | 元素 | 说明 |
|------|------|------|
| StandaloneToolCard.vue | `<button>` | eslint-disable 注释，理由充分：custom flex toggle 布局，xyz-ui Button 的 padding/focus 会干扰紧凑行内布局 |
| ChatPanel.vue:111 | `<button>` | 滚动到底部 FAB，icon-only 浮动按钮，xyz-ui 无对应组件 |
| SystemPane.vue:141 | `<label>` | 非交互元素，仅用于 click 传递和可访问性 |

无 `<input>`, `<select>`, `<textarea>`, `<form>` 使用。

### 3. 禁止 Emoji — PASS

全部文件无 Emoji 使用。图标使用 inline SVG（MergeBlock 的 chevron）。

### 4. 禁止硬编码颜色 — PASS（1 处可接受例外）

AgentRunBlock.vue:187 使用 `rgba(255, 255, 255, 0.3)` — streaming 状态条 shimmer 渐变叠加层。白色半透明叠加是纯视觉效果，不受主题颜色影响，用 CSS 变量反而语义不清。**可接受**。

其余所有颜色均使用 CSS 变量（`--accent`, `--success`, `--danger`, `--border`, `--surface`, `--muted`, `--fg`, `--bg`, `--agent`, `--accent-light`, `--muted-dim`）和 `color-mix(in oklch, ...)` 函数。

### 5. 禁止魔数间距 — MINOR ISSUES

本次改动文件中检测到的魔数：

| 文件 | 值 | 说明 | 严重度 |
|------|-----|------|--------|
| MergeBlock.vue | `gap: 6px`, `padding: 5px 8px`, `margin-bottom: 4px`, `padding: 5px 12px`, `height: 28px` | scoped CSS 中的布局值 | 低 |
| MergeBlock.vue | `font-size: 10px`, `11px`, `9px` | 字体大小 | 低 |
| StandaloneToolCard.vue | `border-left-width: 2px`, `padding: 3px 0 3px 8px`, `margin-bottom: 4px` | scoped CSS | 低 |
| SystemPane.vue | `py-[9px]`, `min-w-[76px]`, `py-[6px]` | 已有样式，非本次新增 | 低 |
| ChatPanel.vue | `gap-[6px]`, `mb-[3px]` | 消息间距微调 | 低 |

**评估**：这些值集中在 `<style scoped>` 中作为布局微调，而非模板中的 Tailwind 魔数类。项目 design-system.md 中没有定义对应的标准间距 token（如 `gap-sm` = 6px），因此这些值是合理的实现选择。如果 project 后续统一间距 token，这些值需要跟进。**不阻塞合并**。

### 6. 行数上限（template ≤ 400, script ≤ 300） — PASS

| 文件 | template | script | 状态 |
|------|----------|--------|------|
| AgentRunBlock.vue | 50 | 114 | PASS |
| MergeBlock.vue | 44 | 133 | PASS |
| StandaloneToolCard.vue | 29 | 80 | PASS |
| AssistantContent.vue | 27 | 73 | PASS |
| ChatPanel.vue | 77 | 163 | PASS |
| SystemPane.vue | 68 | 80 | PASS |
| AssistantSection.vue | 11 | 21 | PASS |
| useLiveTimer.ts | — | 18 | PASS |

### 7. emit 只传单个 payload 对象 — PASS

ChatPanel.vue 的 `defineEmits` 全部使用单参数 payload 签名。无多参数 emit。

### 8. v-model 绑定 — PASS

SystemPane.vue 中 standaloneTools 的 checkbox 使用 Toggle 组件 + `@update:checked` 事件处理函数（`toggleStandaloneTool`），符合规范。其他 v-model 绑定（Select 组件）均为单值绑定。

### 9. Promise.allSettled — PASS

全部文件无 `Promise.all` 使用。本次改动不涉及并行请求。

### 10. 样式三层结构 — PASS

- **Design tokens**（style.css）：未新增 CSS 变量
- **Template class**（模板）：组件模板统一使用 Tailwind 工具类
- **Escape hatch**（`<style scoped>`）：MergeBlock.vue 和 StandaloneToolCard.vue 的 scoped style 用于 Tailwind 无法表达的伪类（`.merge-bar:hover`）、动画 keyframes、`color-mix()` 背景色。使用合理

`@apply` 使用：**未检测到**。PASS。

### 11. border-radius 规范 — PASS

默认使用 `rounded-sm`（1px）。MergeBlock.vue 的 `.merge-chip` 使用 `border-radius: 100px`（胶囊形 badge），属于特殊场景，**可接受**。

### 12. 禁止 `@apply` — PASS

全部文件未使用 `@apply`。

---

## Phase C: TypeScript 质量

### C1. message-layout.ts

- `ALL_PI_TOOLS` 使用 `as const` 断言，类型安全
- `isMergeBlock` 函数逻辑清晰，类型推导正确
- `groupIntoSections` 签名兼容旧调用方（`standaloneTools?` 可选参数），API 兼容策略合理
- `groupByContentBlocks` 中 `flushMerge` 闭包模式简洁

**发现**：`SectionType` 包含 `'thinking' | 'toolCall'`（旧类型）和 `'merge' | 'standalone' | 'customTool'`（新类型），两套类型共存于同一联合。旧类型仅在 `groupByLegacyFields` 和 `groupByContentBlocksLegacy` 中使用，新类型仅在 `groupByContentBlocks` 中使用。虽然不违规，但存在语义重叠——`AssistantSection` 接口未区分这两套体系。

**评估**：不影响运行时正确性，但后续维护时可能产生混淆（"thinking 类型的 section 会在 compact 模式出现吗？"）。**低优先级建议**。

### C2. useLiveTimer.ts

- 简洁的 composable，职责单一
- `onBeforeUnmount(stop)` 确保清理
- 多组件共享同一模式（AgentRunBlock、MergeBlock、StandaloneToolCard），复用正确

### C3. EnrichedSection 类型（AgentRunBlock.vue）

```typescript
interface EnrichedSection {
  type: string
  blocks: import('@xyz-agent/shared').ContentBlock[]
  toolCall?: import('@xyz-agent/shared').ToolCall
}
```

`type` 使用 `string` 而非 `SectionType`。这降低了类型安全性——如果 section 类型被拼错，TypeScript 不会报错。

**建议**：将 `type` 改为 `SectionType`（从 `message-layout.ts` 导入）。**低优先级**。

---

## Phase D: 架构一致性

### D1. compactStreaming 开关隔离

AgentRunBlock 仅在 `compactStreaming=true` 时激活。`false` 时走原有 `groupByContentBlocksLegacy` + `AssistantSection` 路径。两条路径完全隔离，无交叉依赖。**符合 spec 约束 #6**。

### D2. 数据流方向

- settings store → `standaloneTools` → `groupIntoSections` → sections → AgentRunBlock → MergeBlock/StandaloneToolCard
- 数据单向流动，无反向修改。**符合规范**。

### D3. 组件复用

MergeBlock 展开时复用 `ThinkingBlock` 和 `ToolCallCard`。StandaloneToolCard 展开时复用 `ToolCallCard`。**符合 spec 约束 #4**。

### D4. CSS 变量一致性

新组件使用的 CSS 变量与项目现有变量一致：

| 变量 | 用途 | 来源 |
|------|------|------|
| `--accent` | streaming 状态条、thinking 芯片 | 项目通用 |
| `--accent-light` | thinking 芯片背景 | 项目通用 |
| `--success` | tool 芯片、StandaloneToolCard 左边框 | 项目通用 |
| `--success-light` | tool 芯片背景（未显式使用，但 color-mix 替代） | — |
| `--danger` | error 状态 | 项目通用 |
| `--border` | 边框 | 项目通用 |
| `--surface` | 背景 | 项目通用 |
| `--muted` / `--muted-dim` | 辅助文字 | 项目通用 |
| `--bg` | MergeBar 背景 | 项目通用 |
| `--fg` | 主文字 | 项目通用 |
| `--agent` | text section 边框色 | 项目通用 |

**未新增 CSS 变量**。符合 spec 约束 #5。

---

## Phase E: spec 合规性（编码规范相关）

| spec 约束 | 状态 | 说明 |
|-----------|------|------|
| #1 不改共享类型 | PASS | Message/ContentBlock 类型未修改 |
| #4 复用现有组件 | PASS | ThinkingBlock/ToolCallCard 正确复用 |
| #5 CSS 变量复用 | PASS | 无新增 CSS 变量 |
| #7 设置存储 | PASS | standaloneTools 通过 settingsStore 持久化，persist.pick 包含 |

---

## 审查总结

**verdict: pass**

本次改动符合项目编码规范。所有 MUST-FIX 级别规则（禁止 any、禁止原生表单元素、禁止 Emoji、emit 单 payload、行数上限）均通过。发现 0 个 must-fix 级别问题。

以下为低优先级建议，不阻塞合并：

| # | 建议 | 文件 | 严重度 |
|---|------|------|--------|
| 1 | 提取 magic numbers 为命名常量（`1000`, `50`, `TEXT_PREVIEW_MAX=60`） | MergeBlock.vue, StandaloneToolCard.vue | 低 |
| 2 | `EnrichedSection.type` 从 `string` 改为 `SectionType` | AgentRunBlock.vue | 低 |
| 3 | 考虑将旧 `thinking`/`toolCall` SectionType 与新 `merge`/`standalone`/`customTool` 分离为两个联合类型 | message-layout.ts | 低（架构建议） |
