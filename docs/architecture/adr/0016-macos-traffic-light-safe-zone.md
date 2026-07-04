# 0016: macOS Traffic Light Safe Zone + Sidebar Expand Button

**Status**: Superseded（被 [shell spec](../../page-design/v3/shell/spec.md) + 2026-06-28 折叠态 chrome 落位取代）
**Date**: 2026-06-06
**Superseded by**: `docs/page-design/v3/shell/spec.md`（zcode-demo 拓扑）+ 折叠态 chrome 迁入 P1 PanelHeader 方案

> **[2026-06-28 更新]** 本 ADR 的 v2 方案（PanelBar `padding-left:78px` safe-zone + 左缘 floating pill expand button）**已全部废弃**：
> - safe-zone 改为红黄绿位置由主进程 `titleBarStyle:'hidden'` + `trafficLightPosition:{16,26}` 精确控位，header 用 `pl-[88px]` 让位（折叠态）
> - floating pill expand button + rail-restore 左缘细条**均已移除**，唤回改走 ⌘B + P1 header chrome 按钮
> - 现版 SSOT 见 [shell spec](../../page-design/v3/shell/spec.md)。下文为历史决策原文，保留供追溯。

## Context

Sidebar collapsed 后有两个 UX 问题：

1. **Traffic lights 遮挡**：非全屏模式下，macOS 原生红黄绿按钮（约 78px 宽）遮挡 PanelBar header 中的"主线对话"等文字。左右 split panel 时，只有最左侧的 panel 受影响。
2. **Expand button 不可见**：原方案是 28px 全高 fixed 透明按钮，hover 才变色，颜色由 xyz-ui ghost variant 控制且不协调。用户不知道可以点击展开。

## Decision

### Issue 1: Traffic Light Safe Zone

- Sidebar collapsed + 非 fullscreen 时，最左侧 panel 的 PanelBar 添加 `padding-left: 78px`
- 左右 split panel 时，只有 tree 中最左侧 leaf 节点的 PanelBar 需要 safe-zone
- 全屏模式无 traffic lights，保持默认 `padding-left: 14px`
- 判断逻辑：`sidebarStore.collapsed && !layoutStore.isFullscreen` + panel 位置判断

### Issue 2: Floating Pill Expand Button

替换原来的隐形 fixed button，使用居中浮动的 pill 按钮：

- 始终可见，位于左边缘垂直居中
- 默认 `left: 0; width: 24px`，紧贴边缘无间距
- Hover 时 `width: 28px` + 阴影加深 + 颜色变深
- 使用设计系统 token（`--surface`, `--border`, `--muted`），不引入新颜色

## Demo

- [交互式 demo](../page-design/sidebar-collapse-fix.html) — 包含 single panel / split panel / floating pill / combined 场景

## Consequences

- 所有新增或修改窗口顶部区域 UI 的开发，必须考虑非全屏和全屏两种模式
- 已写入 CLAUDE.md 前端编码规范核心规则第 11 条
