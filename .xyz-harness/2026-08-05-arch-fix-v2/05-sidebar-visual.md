# 主题 5：Sidebar 视觉 + 范式（收尾 8 + 9）

## 收尾 8：sidebar #6 #7（Wave 0，立即可做）

### #6 SegmentedTab count 数字去掉

**文件**：`packages/renderer/src/components/sidebar/SegmentedTab.vue`

**现状**（:21-27）：
```vue
<component :is="tab.icon" class="size-[15px] shrink-0" />
<span
  v-if="tab.count > 0"
  class="font-mono text-[10px]"
  :class="..."
>{{ tab.count }}</span>
```

**修复**：删除 :23-27 的 count `<span>` 块（5 行）。

**最小改动**：仅删 template 5 行 span（count 数据仍在 props/computed 但不渲染）。可选连带清理：`TabDef.count` 字段（:49）+ props `sessionCount/fileCount/subagentCount/workflowCount`（:23-27）+ tabs computed 的 count 赋值（:64-67）。**建议先保留 props 仅删 template**（调用方零改动）。

**spec 依据**：demo `.tmp/v6/src/components/sidebar/SegmentedTab.vue:14-17` 注释「克制原则（2026-08-02）：去掉 count 数字（对切换决策无用、制造视觉噪音）」。

### #7 SegmentedTab running badge pulse 动画

**文件**：`packages/renderer/src/components/sidebar/SegmentedTab.vue:28-30`

**现状**：
```vue
<span
  v-if="tab.badge"
  class="absolute right-1 top-1 size-[7px] rounded-full bg-accent"
/>
```
静态，无 animation。

**修复**：badge span 的 class 追加 `animate-[pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none`：
```vue
<span
  v-if="tab.badge"
  class="absolute right-1 top-1 size-[7px] rounded-full bg-accent animate-[pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none"
/>
```

**可行性**：`pulse-dot` keyframes 已存在于全局 SSOT（`style.css:375`）；`SessionItem.vue:68` 已有现成引用范式。无需新增 keyframes，符合 §4.8 SSOT 约束。

### 合计改动量

**1 个文件**（SegmentedTab.vue），**最小 6 行**（5 行删 count span + 1 行追加 pulse class）。零风险。

### 验收

- SegmentedTab 渲染无 count 数字
- running 状态 badge 有 pulse 动画（非静态）
- `prefers-reduced-motion` 下动画停止

---

## 收尾 9：§13.2 ⌘[⌘]⌘, 归位 useGlobalShortcuts

### 现状

`AppShell.vue:72-90` 仍散落 ⌘[ / ⌘] / ⌘, 的 useEventListener + if/else keydown 块，未并入 `useGlobalShortcuts.ts` 的 keymap 数组。

`useGlobalShortcuts.ts`（131 行）已收录 ⌘K/⌘N/⌘B/⌘⇧P/⌘G/⌘⇧G/⌘J 7 键 + shortcutOverrides 覆盖 + isComposerFocused 守卫。

### 修复

把 AppShell.vue:72-90 的 3 键块并入 useGlobalShortcuts keymap 数组：
- `mod+[` → navigation.back
- `mod+]` → navigation.forward
- `mod+,` → settingsOpen

经 options 注入 navigation/settings 依赖（对齐 useGlobalShortcuts 现有 shortcutOverrides 模式）。

### 性质

洁癖级问题。当前 AppShell 的 3 键与 useGlobalShortcuts 的 7 键语义无重叠，功能正确，仅架构不够干净。不阻塞，可延后。

### 验收

- `grep -rn "key === '\['\|key === '\]'\|key === ','" packages/renderer/src/components/shell/AppShell.vue` 零命中（3 键已并入 useGlobalShortcuts）
- ⌘[/⌘]/⌘, 功能正常（前后导航 + 打开设置）

---

## 主题 5 验收

- SegmentedTab 视觉对齐 demo
- 全局快捷键 SSOT 统一（useGlobalShortcuts）
