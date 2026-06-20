---
wave: W11
phase: P3
cases: simple×3
deps: [W10]
est: 6min
va_ref: VA-04 #8-12
---

> 结果: ✅ PASS (2026-06-20, W11 修复: header 槽位互斥 + 新建会话替换待机侧)

# W11 · P3 Panel 骨架（单一 header + 5 zone 排列）

> 3 个简单 case：单一 header 结构 + 5 zone 排列 + split 槽位互斥。DOM 结构核对。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/workspace/spec.md` | §Header + §状态交互（槽位） |
| `$ROOT/docs/designs/v3-demo/panel/spec.md` | **§核心裁决（5 zone 固定排列）** |
| `$ROOT/src-electron/renderer/src/components/panel/Panel.vue` | 待验：5 zone 编排 |
| `$ROOT/src-electron/renderer/src/components/panel/PanelHeader.vue` | 待验：header 结构 |

## 前置

- **W10 PASS**（Panel 容器就绪）。

## Cases

### Case 1（simple）· 单一 header（无工作区级横跨）

**检查方法**：DevTools 搜 header 元素，确认每 panel 只一个 header。

**期望**（workspace/spec §Header + panel/spec）：
- 每 panel 有且只有一个 `PanelHeader`。
- **无工作区级横跨 header**（不在 Workspace 顶部跨双 panel）。

**PASS**：header 数 = panel 数，无横跨 header。

### Case 2（simple）· PanelHeader 结构 + split 槽位互斥

**检查方法**：DevTools 看 PanelHeader 内部 DOM。

**期望**（workspace/spec §Header + §状态交互）：
- header 结构：`[●状态点] session名 [📁目录] [⋯三点] [×关闭]`（顺序可微调，元素齐全）。
- split / 新建会话**同槽位互斥**：单 panel 显「分屏」按钮；双 panel 显「新建会话」按钮。

**PASS**：header 元素齐全 + 槽位互斥正确。

### Case 3（simple）· Panel 5 zone 排列顺序

**检查方法**：DevTools 看 Panel 内 DOM 子元素顺序。

**期望**（panel/spec §核心裁决）：
- DOM 顺序：① panel-header → ② message-stream → ③ progress-zone → ④ composer → ⑤ git-zone。

**PASS**：5 zone DOM 顺序符合。**注**：zone 内容（message-stream/composer 实现）在 W12-W14 验；本 wave 只验 zone 容器顺序 + 占位（ProgressZone/GitZone 可为空壳占位）。

## 执行步骤

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. DevTools 数 header（Case 1）+ 看 header 结构 + 槽位（Case 2）。
3. 看 Panel 子元素顺序（Case 3）。

## FAIL 判定

- 有工作区级横跨 header（Case 1）= FAIL（核心原则）。
- header 元素缺失 / 槽位不互斥（Case 2）= FAIL。
- 5 zone 顺序错（Case 3）= FAIL。
- PASS 后 W12/W14/W15 可并行（均依赖本 wave）。
