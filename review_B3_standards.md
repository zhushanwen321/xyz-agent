# B3 前端编码规范审查报告

**分支**: `feat-integration-pi-extension` vs `main`
**范围**: `src-electron/renderer/src/` (22 files, +491 -39)
**审查时间**: 2026-06-04

---

## 总结

| 级别 | 数量 |
|------|------|
| MUST_FIX | 4 |
| LOW | 5 |
| INFO | 3 |

整体质量较高。魔数消除做得好（InputToolbar、ThinkingBlock、chat.ts 等都提取了常量）。eslint-disable 注释使用规范。主要问题集中在新增文件的硬编码颜色值和魔数间距。

---

## MUST_FIX

### 1. 硬编码颜色值 — `rgba()` 直接写在模板 class 中

- **文件**: `src-electron/renderer/src/components/extension/WidgetDock.vue:40`
- **内容**: `hover:bg-[rgba(255,255,255,0.02)]`
- **违反规则**: 禁止硬编码颜色，应使用 CSS 变量或语义 Tailwind 类
- **建议**: 在 `<style scoped>` 中用 `:hover` 伪元素定义（Tailwind 无法表达的场景），或定义 CSS 变量 `--hover-subtle-bg: rgba(255,255,255,0.02)` 后用 `hover:bg-[var(--hover-subtle-bg)]`

### 2. 硬编码颜色值 — `rgba()` 写在 `<style scoped>` 中

- **文件**: `src-electron/renderer/src/components/chat/SlashMenu.vue:258`
- **内容**: `box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);`
- **违反规则**: 禁止硬编码颜色
- **说明**: 此处在 `<style scoped>` 中，属于 Tailwind 无法表达的场景（escape hatch），但颜色值仍应使用 CSS 变量。建议定义为 `--shadow-md` 或 `var(--overlay-shadow)` 类似变量

### 3. 安装按钮 `installing` 状态无重置机制

- **文件**: `src-electron/renderer/src/components/settings/ExtensionsPane.vue:33-38`
- **内容**: `handleInstall()` 中 `installing.value = true` 后无任何重置逻辑，无 `on('extension.installResult', ...)` 监听来恢复为 `false`
- **违反规则**: 关键规则 #3 — 状态必须正确重置，否则 UI 卡死
- **影响**: 用户点击 Install 后按钮永远显示 "Installing..." 且 disabled，无法再次操作
- **建议**: 监听 server 回传的 install 结果事件，在成功/失败时 `installing.value = false`

### 4. `handleInstall` 标记 `async` 但无 `await`

- **文件**: `src-electron/renderer/src/components/settings/ExtensionsPane.vue:33`
- **内容**: `async function handleInstall()` 但函数体只有 `send(...)` 无 await
- **违反规则**: TypeScript 规范（不必要修饰符）
- **建议**: 去掉 `async`，或在 install 结果事件处理中用 Promise 化使 async 有意义

---

## LOW

### 5. 魔数间距 — `py-[10px]`、`min-h-[42px]`

- **文件**: `src-electron/renderer/src/components/settings/ExtensionsPane.vue:71,106`
- **内容**: `py-[10px]`、`min-h-[42px]`
- **违反规则**: 禁止魔数间距，应使用标准 Tailwind scale
- **说明**: 这两处与同文件其他 section header 保持一致（非本次 diff 引入的模式），但 `py-[10px]` 接近 `py-2.5`，`min-h-[42px]` 无标准 Tailwind 对应值。如项目中 section header 有统一的样式 token，应提取为共享样式

### 6. 魔数间距 — `<style scoped>` 中的硬编码像素值

- **文件**: `src-electron/renderer/src/components/chat/SlashMenu.vue:253-297`
- **内容**: 多处硬编码 `min-width: 240px`、`max-width: 380px`、`padding: 10px 12px`、`font-size: 12px`、`font-size: 13px`、`font-size: 11px`、`margin-bottom: 4px`、`margin-top: 6px`、`gap: 6px`、`padding: 1px 5px` 等
- **违反规则**: 禁止魔数间距
- **说明**: `<style scoped>` 是 Tailwind 无法表达场景的 escape hatch，这些值用于 tooltip 组件。短期内可接受，但长期建议提取为 CSS 变量以保持一致性

### 7. 魔数间距 — inline style `max-height: 180px`

- **文件**: `src-electron/renderer/src/components/extension/WidgetDock.vue:23`
- **内容**: `style="max-height: 180px"`
- **违反规则**: 禁止魔数间距
- **建议**: 提取为 CSS 变量或在 `<style scoped>` 中定义

### 8. 无意义的 computed 逻辑

- **文件**: `src-electron/renderer/src/components/extension/WidgetDock.vue:21`
- **内容**: `mode === 'single' ? '' : ''` — 两个分支都返回空字符串
- **说明**: `mode` computed 属性被定义但三元表达式无实际差异，属于残留代码
- **建议**: 要么实现单列/双列不同样式，要么移除 `mode` 及其引用

### 9. `role="button"` + `tabindex="0"` div 替代 button

- **文件**: `src-electron/renderer/src/components/extension/ExtensionWidgetPanel.vue:16-23`
- **内容**: 使用 `<div role="button" tabindex="0">` 模拟按钮行为
- **说明**: 功能上可访问性已覆盖（有 keydown enter/space 处理），但语义上不如原生 `<button>` 或 xyz-ui Button。此处是 collapse toggle header，不算表单交互元素，优先级较低
- **建议**: 考虑使用 xyz-ui 的可折叠容器组件（如果有的话），或使用原生 `<button>` + `appearance-none` 重置样式

---

## INFO

### 10. 原生 HTML 元素已有 eslint-disable 注释

- **文件**: `ThinkingBlock.vue:2`、`ToolCallCard.vue:3`、`AppSidebar.vue:80,88`、`PanelBar.vue:172`、`RenderDescriptor.vue:43`
- **说明**: 所有使用原生 `<button>` / `<table>` 的位置都添加了 `<!-- eslint-disable-next-line taste/no-native-html-elements -->` 注释并说明了原因（自定义渐变样式、xyz-ui 无 Table 组件等）。合规。

### 11. 行数限制 — 所有文件均在限制内

| 文件 | `<template>` | `<script setup>` | 状态 |
|------|-------------|-------------------|------|
| SlashMenu.vue | 63 | 180 | OK (≤400/≤300) |
| ExtensionWidgetPanel.vue | 22 | 9 | OK |
| WidgetDock.vue | 29 | 12 | OK |
| ExtensionsPane.vue | 86 | 57 | OK |
| ChatPanel.vue | 49 | 144 | OK |
| PanelSessionView.vue | 28 | 241 | OK |

### 12. v-model、any、emoji — 无违规

- 所有新增表单输入使用 `v-model`（ExtensionsPane 的 `Input` 使用 `v-model="installSource"`）
- 无 `any` 类型使用
- 无 Emoji 使用
- border-radius 均使用 `rounded-sm`（1px）或 `rounded-none`（0），符合规范

---

## 合规亮点

1. **魔数常量提取**：InputToolbar.vue（`BINARY_LEVEL_COUNT`、`MAX_BAR_COUNT`、`CONTEXT_DANGER_THRESHOLD` 等）、ThinkingBlock.vue（`DECISECOND_MS`、`SECONDS_PER_MINUTE`）、RenderDescriptor.vue（`PERCENT_MULTIPLIER`）、chat.ts（`PERCENT_MAX`、`PERCENT_SCALE`）都做得很好
2. **refCount 防重复注册**：`useExtensionWidget.ts` 正确实现了 CLAUDE.md Rule #2 的模块级 refCount 保护
3. **Session 隔离**：PanelSessionView 中 extension widgets/statuses 按 sessionId 过滤，符合 Rule #7
4. **eslint-disable 注释规范**：所有原生 HTML 元素使用都有行级 eslint-disable 注释并说明原因
5. **cleanup 生命周期**：`useExtensionWidget` 的 cleanup 在 `onUnmounted` 中正确调用
