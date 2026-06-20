---
title: VA-02 · P1 L0 Shell（应用骨架布局）
phase: P1
wave: 2
task: T2.1, T2.2
group: FG2
priority: ★★★
---

# VA-02 · P1 L0 Shell

> 应用骨架布局：aside 透明 + main 浮起 + traffic light 安全区 + app-nav-controls。
> 本文件自包含。完整全局清单见 [va-00-index.md](va-00-index.md)。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 关联 harness 文档

| 文档 | 定位 |
|------|------|
| **Spec** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` §4 P1 行 + §7 UC-1 + §8.5 P1 v1 边界 |
| **Plan** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` FG2（T2.1-T2.2） |

## 本 VA 专属 design 文件（绝对路径）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/shell/spec.md` | **Shell 设计规范**（zcode-demo 拓扑 + traffic light + app-nav-controls + 跨平台方案 X） |
| `$ROOT/docs/designs/v3-demo/shell/draft-overlay-states.html` | **主对照稿**：非全屏 / 全屏两态 + 应用按钮 + 跨平台 mimic_mac + 尺寸表 |
| `$ROOT/docs/designs/v3-demo/shell/draft-skeleton.html` | 全屏分区空壳（辅助） |
| `$ROOT/docs/architecture/adr/0018-visual-direction.md` | 视觉方向（冷蓝 + 浮起语义） |
| `$ROOT/CLAUDE.md` | #11 traffic light 安全区（v3 shell 拓扑 SSOT） |

## 待验收代码文件

| 文件 | 类型 |
|------|------|
| `$ROOT/src-electron/renderer/src/components/shell/AppShell.vue` | create（L0 容器：aside + main 布局） |
| `$ROOT/src-electron/renderer/src/components/shell/AsideRegion.vue` | create（透明 sidebar 容器槽） |
| `$ROOT/src-electron/renderer/src/components/shell/MainPanel.vue` | create（float 主区槽 + view 路由） |
| `$ROOT/src-electron/renderer/src/App.vue` | modify（挂载 AppShell + traffic light 安全区） |

## 验收前置

- **VA-01（P0）必须 PASS**（token + shadcn 就绪）。
- 启动：`cd $ROOT && npm run dev`

## 对照表

> 拓扑核心：**base 平铺全屏 → sidebar 透明融合 → main 唯一 float-panel 浮起**（不靠 z-index，靠 background / border / radius / shadow）。

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| 1 | `.app-shell` 布局 | draft-overlay-states | `flex` + `p-3`(12px) + `gap-3`(12px) | ✅ |
| 2 | `.aside-region` 宽度 | draft-overlay-states + spec §一 | `width: 200px` | ✅ |
| 3 | `.aside-region` 透明 | spec §一（三层语义命门） | **无 background**，继承 base，与窗口底色融合 | ✅ |
| 4 | `.aside-region` 安全区 | spec §三 + CLAUDE.md #11 | `padding-top: 52px`（安全区 32 + 呼吸 20，**三平台统一**） | ✅ |
| 5 | `.main-panel` 浮起 | draft-overlay-states + spec §一 | `bg-panel` + border + `radius:12px` + shadow，**唯一浮起面板** | ✅ |
| 6 | `.main-panel` 不靠 z-index | spec §六 | 靠 background / border / shadow 浮起，无 z-index 抬高 | ✅ |
| 7 | `.traffic-light` 定位 | spec §三 | `left:20px` / `top:20px`（绝对定位窗口左上） | ✅ |
| 8 | traffic-light 非全屏态 | spec §二 | `opacity:1` 常驻 | ✅ |
| 9 | traffic-light 全屏态 | spec §二 | `opacity:0` 隐藏 + **320ms**（= `--duration-slow`）过渡 | ✅ |
| 10 | `.app-nav-controls` 非全屏 | spec §三 | `left:90px`（紧跟红黄绿右侧，72+18 呼吸） | ✅ |
| 11 | `.app-nav-controls` 全屏 | spec §三 | `left:20px`（左移占红黄绿位）+ **320ms** 平移同步 | ✅ |
| 12 | app-nav-controls 三按钮 | spec §二 + §七-2 | 收起侧栏 / ← 后退 / → 前进（三平台统一自绘 DOM） | ✅ |
| 13 | breadcrumb 落点 | spec §四 | 在 **main-header 内**（非横跨窗口顶栏，工作区上下文） | ✅ |
| 14 | 拖拽区 | spec §七-6 | main-header 空白区 `-webkit-app-region: drag`；按钮 / breadcrumb `no-drag` | ✅ |
| 15 | 跨平台 data-platform | spec §七-4 | `<html data-platform="mac\|win\|linux">`；win/linux mimic_mac 自绘圆点 | ✅ |
| 16 | ⌘[ / ⌘] 绑定 | spec §8.5 + plan T2.2 | keydown 绑定 `nav.back` / `nav.forward`（导航历史栈） | ✅ |
| 17 | 全屏两态切换微交互 | spec §8.5 P1 DEFERRED | — | 🔇 |

## 执行步骤

1. `cd $ROOT && npm run dev`。
2. 浏览器打开 `$ROOT/docs/designs/v3-demo/shell/draft-overlay-states.html`（主对照稿，含尺寸表）。
3. Electron 窗口与 draft 并排：
   - 视觉验 #1-#6（aside 透明 / main 浮起的层次感）。
   - DevTools 量 #2 / #4 / #7 / #10-#11 的像素值。
4. 触发全屏（mac 绿色按钮 F11 / `Ctrl+⌘+F`）验 #8-#9 / #11（320ms 平移）。
5. DevTools 查 `<html>` 的 `data-platform` 属性（#15）。
6. 按 `⌘[` / `⌘]` 验导航栈（#16，需有 >1 历史条目）。
7. DevTools Elements 搜 `-webkit-app-region`（#14，修复 spec §七-7 提到的旧 bug）。

## FAIL 判定

- aside 有 background（#3）/ main 靠 z-index 浮起（#6）= FAIL（违背 zcode-demo 拓扑核心语义）。
- `padding-top` 非 52px（#4）= FAIL（三平台统一硬约束）。
- app-nav-controls 时长非 320ms（#9 / #11）= FAIL（spec §七-3 强制与 traffic-light 同步）。
- 🔇 #17 不算失败（DEFERRED）。
- PASS 后进 [va-03-p2-sidebar.md](va-03-p2-sidebar.md)。
