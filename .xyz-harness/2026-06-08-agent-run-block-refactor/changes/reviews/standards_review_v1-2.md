---
verdict: fail
---

# Standards Review: AgentRunBlock Refactor

**Scope**: 10 files (3 new components, 1 new composable, 6 modified)
**Date**: 2026-06-08

## Summary

New components follow project patterns well — `useLiveTimer` composable is a clean extraction, `message-layout.ts` keeps pure-function architecture, and the `standaloneTools` setting integrates correctly into the existing persist pipeline. Two standards violations in MergeBlock.vue require fixes before merge.

## Issues

### MUST_FIX

#### MF-1: MergeBlock.vue — border-radius: 4px 违反 §7.1

**标准 §7.1**: 项目全局只允许 1px 和 2px 两种 border-radius 值。圆形指示器/头像可用 50%。

MergeBlock.vue 的 scoped CSS 中有两处 `border-radius: 4px`:
- `.merge-bar` (line 179) — 容器级 UI 元素，应使用 1px 或 2px
- `.merge-stream` (line 256) — 同上

注意：CompactStreamingBubble.vue 和 CompactSummaryBar.vue 也使用 4px（预存 tech debt），但新代码不应复制旧模式。

**修复**: `.merge-bar` 和 `.merge-stream` 改为 `border-radius: 1px`（默认锐利风格）或 `border-radius: 2px`（如需稍大圆角）。

#### MF-2: MergeBlock.vue — <style scoped> 违反模板 style 规则

**标准**: `<style scoped>` 仅用于 Tailwind 无法表达的场景（伪元素、后代选择器、Vue Transition 类、动画 @keyframes）。

MergeBlock.vue 的 `<style scoped>` 约 130 行，其中大部分是 flex 布局、padding、gap、font-size、color 等常规样式，可用 Tailwind 工具类直接表达。vue_rules_checker 已对此报错。

合理保留为 scoped CSS 的部分：
- `@keyframes merge-pulse` 动画定义
- `.merge-bar:hover` 伪类交互（Tailwind `hover:` 可替代，但结合 `border-color` + `background` 两属性时 scoped CSS 更清晰）
- `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` 单行截断组合（Tailwind `truncate` 可覆盖）

需迁移到模板 Tailwind class 的部分：
- `.merge-bar` 的 `display: flex; align-items: center; gap: 6px; padding: 5px 8px` → Tailwind `flex items-center gap-1.5 py-[5px] px-2`
- `.merge-stream` 的 `display: flex; align-items: center; gap: 8px; padding: 5px 12px; height: 28px` → Tailwind `flex items-center gap-2 py-[5px] px-3 h-7`
- `.merge-chip` 的 `display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px` → Tailwind `inline-flex items-center gap-1 py-0.5 px-[7px]`
- `.merge-blocks` 的 `display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px` → Tailwind `flex flex-col gap-0.5 mb-1`
- 各处 `font-size` / `font-family` / `color` / `flex-shrink` / `user-select` / `cursor` 等均可 Tailwind 化

**修复策略**: 将布局/间距/颜色迁移到模板 class，scoped CSS 仅保留动画 keyframes、hover 伪类、文本截断。

---

### WARNINGS

#### W-1: StandaloneToolCard.vue — 原生 \<button\> (eslint-disable)

**标准**: 禁止原生 HTML 表单元素，必须使用 xyz-ui 组件。

Line 4-5 使用原生 `<button>` 并以 `<!-- eslint-disable-next-line taste/no-native-html-elements -->` 抑制。理由 "custom flex layout requires button" 可理解（语义化 + 无障碍），但与标准冲突。如 xyz-ui 的 Button 组件支持 flex 子元素布局，应优先替换。

#### W-2: Magic numbers (no-magic-numbers)

ESLint 报告 6 处新增 magic number:
- `200` (AgentRunBlock.vue:136, MergeBlock.vue:128, useLiveTimer.ts:7) — timer interval ms
- `1000` (MergeBlock.vue:167) — ms→s 转换
- `50` (StandaloneToolCard.vue:56×2) — path truncation length
- `100` (StandaloneToolCard.vue:45) — elapsed display threshold

均为 warnings，建议后续提取为命名常量（如 `TIMER_INTERVAL_MS = 200`、`PATH_MAX_LENGTH = 50`）。

#### W-3: MergeBlock.vue merge-chip border-radius: 100px

`.merge-chip` 使用 `border-radius: 100px` 实现药丸形。标准允许 50% 用于"圆形指示器/头像"。Chip 是计数指示器，视觉上等同 rounded-full。建议改用 Tailwind `rounded-full`（50%）替代硬编码 100px，与标准表述一致。

---

### PASSED

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Template 行数 ≤ 400 | PASS | AgentRunBlock 66, MergeBlock 62, StandaloneToolCard 43 |
| Script 行数 ≤ 300 | PASS | AgentRunBlock 68, MergeBlock 95, StandaloneToolCard 54 |
| 禁止 `any` | PASS | 无 any 使用，类型断言仅用 `as readonly string[]` |
| v-model / :value+@input | PASS | Settings 使用 Toggle 组件，无原生 v-model 问题 |
| 硬编码颜色 | PASS | 全部使用 CSS 变量 (--accent, --success, --danger, --muted, --border, --bg, --surface, --fg) |
| emit payload 规范 | PASS | 无 emit 使用（props-down only 组件） |
| 魔数间距 | PASS | 无 Tailwind 魔数间距（如 p-[17px]） |
| CSS 变量复用 | PASS | 不新增 CSS 变量，复用 --accent, --success, --danger, --muted 系列 |
| 暗色主题兼容 | PASS | 颜色全部通过 CSS 变量，3 主题自动适配 |
| 前端构建 | PASS | vue-tsc --noEmit 0 errors, vite build 成功 |
| ESLint | PASS | 0 errors, warnings 均为 no-magic-numbers（新代码引入 6 处） |
| 历史消息兼容 | PASS | groupIntoSections 无 standaloneTools 参数时走 legacy 路径 |
| useLiveTimer 生命周期 | PASS | onBeforeUnmount 清理 setInterval，无泄漏 |
| 数据目录隔离 | PASS | 不涉及 ~/.xyz-agent/ 或 ~/.pi/ 路径操作 |

## Verdict

**fail** — MF-1 (border-radius 4px) 和 MF-2 (scoped CSS 过度) 需修复后 re-review。其余文件无标准违规。
