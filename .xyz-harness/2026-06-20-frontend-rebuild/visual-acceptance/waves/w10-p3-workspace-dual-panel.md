---
wave: W10
phase: P3
cases: complex×1
deps: [W09]
est: 12min
va_ref: VA-04 #1-7,13-14
---

# W10 · P3 双 Panel 主从 + 激活四层标识

> 1 个复杂 case：主从拓扑 + 激活四层标识 + 中缝无双线 + 切换/关闭。**P3 核心**，视觉 + DOM + 交互综合。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/workspace/spec.md` | **§拓扑 + §激活标识（四层 + 中缝取舍）** |
| `$ROOT/docs/designs/v3-demo/workspace/draft-dual-panel.html` | **主对照稿**（双 Panel + 激活四层） |
| `$ROOT/src-electron/renderer/src/components/workspace/Workspace.vue` | 待验：双 Panel 主从 |
| `$ROOT/src-electron/renderer/src/components/workspace/PanelContainer.vue` | 待验：split 状态机 |

## 前置

- **W09 PASS**（sidebar 可产出多 session 触发双 panel）。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`。

## Case · 双 Panel 主从 + 激活四层（complex）

> **核心**：主从而非对等；active panel 对话区永不被压缩；激活靠四层标识（左竖条 + inset ring + bg + opacity），**中缝无双线**。

### 检查项

| # | 检查 | 对照 | 期望 |
|---|------|------|------|
| a | 单 session 默认 | draft-dual-panel + panel/spec §状态机 | Panel-2 隐藏，Panel-1 撑满整个 Workspace |
| b | 双 Panel 主从 | draft + workspace/spec §拓扑 | 同时只有一个 active 真干活，另一个 standby；**active 对话区不被压缩遮挡** |
| c | 激活·左侧竖条 | workspace/spec §激活标识 | active panel 左侧 2px accent 实色；非激活无 |
| d | 激活·inset ring | workspace/spec §激活标识 | active panel 1px `accent-ring`（30% 透明）**inset box-shadow**（不改盒模型，不抖动）；非激活无 |
| e | 激活·背景 | workspace/spec §激活标识 | active `bg-elevated`（微亮）；非激活 `bg-panel` |
| f | 激活·整体 opacity | workspace/spec §激活标识 | active opacity 1；非激活 opacity 0.5（hover 回升 0.78） |
| g | 中缝无双线 | workspace/spec §激活标识（关键取舍） | 未用整圈实线（避免共用分隔线处双 accent 打架）；中缝处无双重 border |
| h | 点 panel 切换 active | workspace/spec §状态交互 | 点非 active panel → 四层标识联动翻转 |
| i | header × 关闭 | workspace/spec §状态交互 | 双 panel 时点 × → 关闭该侧回单 panel |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. 浏览器打开 draft-dual-panel.html 并排。
3. 单 session（默认）：核 Panel-2 隐藏（a）。
4. mock 开第二 session（或触发 split）：核双 Panel（b）。
5. DevTools 量激活四层：
   - active panel 查 `border-left:2px accent`（c）。
   - 查 `box-shadow` 含 inset accent-ring（d，**确认 inset 而非 border，不抖动**）。
   - 查 `background`（e）+ `opacity`（f）。
6. 查中缝处无双 border（g，DevTools 看两 panel 相邻边的 border/ring 是否打架）。
7. 点非 active panel：核四层翻转（h）。
8. 点 header × ：双→单（i）。

### 判定

**PASS**：a-i 全符合。
**FAIL 触发**：
- (b) 双 panel 对等 / active 被压缩 = FAIL（核心原则崩）。
- (d) 用 border 而非 inset ring（盒模型抖动）= FAIL。
- (g) 中缝出现双 accent 线 = FAIL（spec 明确取舍）。
- (h) 切换时四层不联动 = FAIL。

## 执行步骤

1. 启动 + draft 并排。
2. 单 session（a）→ 双 session（b-g 逐层核）。
3. 量 inset ring（d，重点）+ 中缝（g，重点）。
4. 切换（h）+ 关闭（i）。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后进 W11（Panel 骨架）。
