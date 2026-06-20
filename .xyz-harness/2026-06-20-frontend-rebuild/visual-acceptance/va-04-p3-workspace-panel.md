---
title: VA-04 · P3 Workspace + Panel 容器（双 Panel 主从 + 5 zone）
phase: P3
wave: 3
task: T4.1, T4.2, T4.3
group: FG4
priority: ★★
---

# VA-04 · P3 Workspace + Panel 容器

> 双 Panel 主从拓扑 + Panel 5 zone 空壳。此 phase 只验**容器骨架**，zone 内容（message-stream / composer）在 VA-05 验。
> 本文件自包含。完整全局清单见 [va-00-index.md](va-00-index.md)。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 关联 harness 文档

| 文档 | 定位 |
|------|------|
| **Spec** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` §4 P3 行 + §8.5 P3 v1 边界（骨架 + 主路径）+ §9 G-023（split 单 session DEFERRED） |
| **Plan** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` FG4（T4.1-T4.3） |

## 本 VA 专属 design 文件（绝对路径）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/workspace/spec.md` | **Workspace 拓扑规范**（双 Panel 主从 + 激活标识四层 + Header 结构） |
| `$ROOT/docs/designs/v3-demo/workspace/draft-dual-panel.html` | **主对照稿**：双 Panel 主从 + 激活标识 + Header |
| `$ROOT/docs/designs/v3-demo/panel/spec.md` | **Panel spec §核心裁决**（5 zone 固定排列 + 单/双状态机） |
| `$ROOT/docs/architecture/adr/0018-visual-direction.md` | 视觉方向（浮起 / inset ring） |

## 待验收代码文件

| 文件 | 类型 |
|------|------|
| `$ROOT/src-electron/renderer/src/components/workspace/Workspace.vue` | create（双 Panel 主从容器） |
| `$ROOT/src-electron/renderer/src/components/workspace/PanelContainer.vue` | create（Panel 挂载点 + split 状态机） |
| `$ROOT/src-electron/renderer/src/components/panel/Panel.vue` | create（Panel 容器，5 zone 编排） |
| `$ROOT/src-electron/renderer/src/components/panel/PanelHeader.vue` | create（per-session header） |
| `$ROOT/src-electron/renderer/src/components/panel/ProgressZone.vue` | create（zone 空壳占位） |
| `$ROOT/src-electron/renderer/src/components/panel/GitZone.vue` | create（zone 空壳占位） |
| `$ROOT/src-electron/renderer/src/stores/panel.ts` | create（PanelTree + activePanelId） |

## 验收前置

- **VA-01（P0）+ VA-02（P1 Shell）必须 PASS**。
- **VA-04 依赖 FG1**：panel store 就绪。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`。

## 对照表

> 核心约束：**主从而非对等**——同一时刻只有一个 active panel 真干活；active panel 对话区永不被压缩遮挡。

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| 1 | 单 session 默认态 | draft-dual-panel + panel/spec §状态机 | Panel-2 隐藏，Panel-1 撑满整个 Workspace | ✅ |
| 2 | 双 Panel 主从 | draft-dual-panel + workspace/spec §拓扑 | 同一时刻只有一个 active，另一个 standby | ✅ |
| 3 | 激活标识·左侧竖条 | workspace/spec §激活标识 | active panel 左侧 2px accent 实色；非激活无 | ✅ |
| 4 | 激活标识·inset ring | workspace/spec §激活标识 | active panel 1px `accent-ring`（30% 透明）**inset** box-shadow（不改盒模型）；非激活无 | ✅ |
| 5 | 激活标识·背景 | workspace/spec §激活标识 | active `bg-elevated`（微亮）；非激活 `bg-panel` | ✅ |
| 6 | 激活标识·整体 opacity | workspace/spec §激活标识 | active opacity 1；非激活 opacity 0.5（hover 回升 0.78） | ✅ |
| 7 | 中缝无双线 | workspace/spec §激活标识（关键取舍） | 未用整圈实线（避免共用分隔线处双 accent 打架） | ✅ |
| 8 | PanelHeader 单一 | workspace/spec §Header + panel/spec | 每 panel 只一个 header，**无工作区级横跨 header** | ✅ |
| 9 | PanelHeader 结构 | workspace/spec §Header | `[●状态点] session名 [📁目录] [⋯三点] [×关闭]` | ✅ |
| 10 | split / 新建会话槽位 | workspace/spec §状态交互 + panel/spec | 同槽位互斥：单 panel 显「分屏」；双 panel 显「新建会话」 | ✅ |
| 11 | Panel 5 zone 排列 | panel/spec §核心裁决 | ① panel-header → ② message-stream → ③ progress-zone → ④ composer → ⑤ git-zone | ✅ |
| 12 | 5 zone 空壳占位 | plan T4.2 | ProgressZone / GitZone 空壳（throw 或占位文本），MessageStream / Composer 在 VA-05 | ✅ |
| 13 | 点 panel 切换 active | workspace/spec §状态交互 | 点击切换 active，激活标识四层联动翻转 | ✅ |
| 14 | header × 关闭 | workspace/spec §状态交互 | 双 panel → 关闭该侧回单 | ✅ |
| 15 | split 单 session 场景 | spec §9 G-023 | — | 🔇 |
| 16 | 单 panel 关闭主会话确认 | workspace/spec §边缘状态 | — | 🔇 |

## 执行步骤

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. 浏览器打开 `$ROOT/docs/designs/v3-demo/workspace/draft-dual-panel.html` 并排。
3. 启动后单 session 验 #1（Panel-2 隐藏，Panel-1 撑满）。
4. mock 开第二 session 验双 Panel（#2-#7 激活四层 + 中缝）。
5. DevTools 量 inset ring（#4，确认 box-shadow inset 而非 border，不抖动）。
6. 点非 active panel 验四层翻转（#13）。
7. 验 PanelHeader 结构（#9）+ split / 新建会话互斥（#10，单 / 双切换按钮）。
8. DevTools 确认 5 zone DOM 顺序（#11）。
9. header × 验双→单（#14）。
10. 🔇 #15 / #16 不验。

## FAIL 判定

- 双 Panel 对等而非主从（#2）/ active 对话区被压缩 = FAIL。
- 激活标识用整圈实线致中缝双线（#7）= FAIL（spec 明确取舍）。
- 存在工作区级横跨 header（#8）= FAIL（核心原则）。
- 5 zone 顺序错（#11）= FAIL。
- PASS 后进 [va-05-p4-panel-content.md](va-05-p4-panel-content.md)。
