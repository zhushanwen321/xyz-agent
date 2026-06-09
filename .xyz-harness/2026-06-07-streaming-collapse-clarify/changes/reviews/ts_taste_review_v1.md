---
verdict: fail
must_fix: 2
---

# TypeScript 品味审查报告

**审查范围**: `CompactSummaryBar.vue` (427 行) + `CompactStreamingBubble.vue` (185 行)
**审查依据**: `essence.md` 四条原则 + `ts/taste.md` 原则/偏好/反模式

---

## 汇总

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 | 3 | 跨文件重复 (×2) + `Record<string, unknown>` 反模式 |
| P1 | 2 | 自定义 CSS 反模式 + computed 派生状态可变性 |
| P2 | 0 | — |
| P3 | 0 | — |

**结论**: 两个文件存在明显的跨文件重复（`formatTime` 和 tool-input 解析），以及 `Record<string, unknown>` + `as` 类型绕过。需提取共享工具函数并引入结构化类型。

---

## CompactSummaryBar.vue (427 行)

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 消除重复 | L149-157 `formatTime()` | `formatTime` 函数与 `CompactStreamingBubble.vue` 中完全相同（含相同常量 `MS_PER_SECOND`/`SECONDS_PER_MINUTE`/`DECISECOND_MS`） | 提取到 `utils/time.ts` 共享 |
| P0 | 消除重复 | L168-177 `toolPath()` | tool-input 解析逻辑（`typeof input === 'string' ? JSON.parse(input) : input` → 尝试取 `path/file_path/command`）与 `CompactStreamingBubble.vue` L67-76 内联代码完全重复 | 提取到 `utils/tool-path.ts` 共享 |
| P0 | 类型即契约 | L170-174 `toolPath()` | `const rec = obj as Record<string, unknown>` + `(rec.path ?? rec.file_path ?? rec.command) as string \| undefined` — 典型 `Record<string, unknown>` + `as` 反模式，字段名拼错无编译时检查 | 定义 `ToolInputPath` 结构化类型或在入口断言为具体类型；该场景（解析 tool call 的动态 input）可考虑在白名单中登记 |
| P1 | 反模式: 自定义 CSS | `<style scoped>` 全段 (~190 行) | 大量常规 CSS 属性（`display: flex`, `gap`, `padding`, `border-radius`, `font-size`, `cursor: pointer` 等）均可由 Tailwind 工具类表达，违反项目 CLAUDE.md 核心规则 #3（Template class）| 将布局/排版/间距/颜色样式迁移为 Tailwind class，`<style scoped>` 仅保留 `color-mix()` 等无法用 Tailwind 表达的样式和 BEM 结构需要的伪类 |
| P1 | 反模式: 可变派生状态 | L121 `item.expanded = !item.expanded` | `chips` 是 computed，每次 `props.message` 变化时重新生成全新对象。对 `item.expanded` 的原地修改在 message 更新后丢失（尽管 SummaryBar 用于已完成消息，变化频率低，但仍脆弱）| 将 item 的展开状态独立存储（如 `Map<string, boolean>` ref），不依赖 computed 产物的可变性 |

---

## CompactStreamingBubble.vue (185 行)

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P0 | 消除重复 | L60-76 `statusText` computed 内 | tool-input 解析逻辑与 `CompactSummaryBar.vue` 的 `toolPath()` 完全相同：`typeof x === 'string' ? JSON.parse(x) : x` → `obj.path ?? obj.file_path ?? obj.command` | 同上，提取到共享 util |
| P0 | 类型即契约 | L69-73 | `const obj = raw as Record<string, unknown>` + `(obj.path ?? obj.file_path ?? obj.command) as string \| undefined` — 同一反模式 | 同上，随共享 util 一起修复 |
| P0 | 消除重复 | L46-57 `elapsedDisplay` computed | `formatTime` 逻辑与 `CompactSummaryBar.vue` 的 `formatTime()` 完全相同（含相同的 `MS_PER_SECOND`/`SECONDS_PER_MINUTE` 常量和分支逻辑） | 提取到 `utils/time.ts` 共享 |
| P1 | 反模式: 自定义 CSS | `<style scoped>` 全段 (~65 行) | 同 SummaryBar，常规 CSS 应为 Tailwind class。例外：`@keyframes pulse` 动画属于 escape hatch，保留合理 | 布局/间距/颜色迁 Tailwind；`@keyframes` 和 `animation` 属性保留 |

---

## 跨文件重复汇总

| 重复逻辑 | 文件 A | 文件 B | 相似度 | 行数 |
|----------|--------|--------|--------|------|
| `formatTime` 时间格式化 | SummaryBar L149-157 | StreamingBubble L46-57 | 100% | ~12 行 |
| tool-input 路径提取 | SummaryBar `toolPath()` L162-177 | StreamingBubble `statusText` 内 L65-76 | ~95% | ~12 行 |
| 常量 `MS_PER_SECOND`/`SECONDS_PER_MINUTE` | SummaryBar L85-86 | StreamingBubble L39-40 | 100% | 2 行 |

---

## 建议修复顺序

1. **提取 `utils/time.ts`**：导出 `formatTime(ms: number): string` + 相关常量。两文件改为 import。
2. **提取 `utils/tool-path.ts`**：导出 `extractToolPath(input: unknown, maxLen?: number): string`。两文件改为 import。在该函数内定义结构化类型或使用 type guard 替代 `Record<string, unknown>` + `as`。如认为 tool input 格式不可预测，在项目 CLAUDE.md 白名单中登记该场景。
3. **（P1，可后续）CSS → Tailwind 迁移**：两个组件的 `<style scoped>` 逐步迁为 Tailwind class，仅保留 `color-mix()` 和 `@keyframes` 等 Tailwind 无法表达的样式。
