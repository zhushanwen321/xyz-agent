---
wave: W04
phase: P1
cases: complex×1
deps: [W02]
est: 10min
va_ref: VA-02 #4,7-11
---

# W04 · P1 Traffic Light + App-Nav-Controls（两态 + 320ms）

> 1 个复杂 case：跨平台 traffic light 安全区 + app-nav-controls 两态切换 + 时序同步。需触发全屏交互。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/shell/spec.md` | **§二两态 + §三尺寸 + §七跨平台** |
| `$ROOT/docs/designs/v3-demo/shell/draft-overlay-states.html` | **主对照稿**（两态 + 尺寸表 + mimic_mac） |
| `$ROOT/CLAUDE.md` | #11 traffic light 安全区 SSOT |
| `$ROOT/src-electron/renderer/src/components/shell/AppShell.vue` | 待验：安全区 + traffic-light + app-nav-controls |

## 前置

- **W02 PASS**（shell 可渲染）。
- 与 W03 无依赖，可并行。
- 启动：`cd $ROOT && npm run dev`。

## Case · Traffic Light + Nav Controls 两态（complex）

> **核心约束**（CLAUDE.md #11 + shell/spec §二/§三）：aside 顶部留 52px 安全区（三平台统一）；traffic-light + app-nav-controls 在非全屏/全屏两态间 320ms 同步过渡。**无第三态**。

### 检查项

| # | 检查 | 对照 | 期望 |
|---|------|------|------|
| a | `.aside-region` 安全区 | spec §三 + CLAUDE #11 | `padding-top:52px`（= 安全区 32 + 呼吸 20，**三平台统一，全屏也保留**） |
| b | `.traffic-light` 定位 | spec §三 | `position:absolute` + `left:20px` + `top:20px` |
| c | traffic-light **非全屏态** | spec §二 | `opacity:1`（红黄绿常驻可见） |
| d | traffic-light **全屏态** | spec §二 | `opacity:0`（隐藏）+ `transition:opacity 320ms`（=`--duration-slow`） |
| e | `.app-nav-controls` 非全屏 | spec §三 | `left:90px`（紧跟红黄绿右侧，72+18 呼吸） |
| f | `.app-nav-controls` 全屏 | spec §三 | `left:20px`（左移占红黄绿位）+ `transition:left 320ms` |
| g | 两态过渡同步 | spec §七-3 | traffic-light opacity 与 app-nav-controls left **同时 320ms 完成**（肉眼同步，不错位） |
| h | app-nav-controls 三按钮 | spec §二 + §七-2 | 收起侧栏 / ← 后退 / → 前进（三平台统一自绘 DOM，非系统原生） |
| i | 跨平台 data-platform | spec §七-4 | `<html data-platform="mac|win|linux">`；win/linux 走 mimic_mac 自绘彩色圆点 |

### 检查方法

1. `cd $ROOT && npm run dev`。
2. 浏览器打开 draft-overlay-states.html 并排。
3. **非全屏态**（默认）：
   - DevTools 查 `.aside-region` 的 `padding-top`（a）。
   - 查 `.traffic-light` 定位 + `opacity`（b, c）。
   - 查 `.app-nav-controls` 的 `left`（e）+ 三按钮 DOM（h）。
   - 查 `<html>` 的 `data-platform`（i）。
4. **触发全屏**（mac: 绿色按钮 / `Ctrl+⌘+F`；win/linux: F11）：
   - 肉眼观察过渡：traffic-light 渐隐 + nav-controls 左移，**同时完成**（g）。
   - DevTools 查过渡后 `opacity:0`（d）+ `left:20px`（f）+ `transition` 时长（d, f）。
5. **退出全屏**回到非全屏态，确认状态可逆。
6. 若 mac：观察全屏时 hover 窗口顶部，系统红黄绿覆盖层是否落进 52px 留白（不遮挡内容）。

### 判定

**PASS**：a-i 全部符合。
**FAIL 触发**：
- (a) `padding-top` ≠ 52px = FAIL（三平台统一硬约束）。
- (d)/(f) transition 非 320ms = FAIL（spec §七-3 强制与 traffic-light 同步）。
- (g) 两过渡肉眼不同步 = FAIL。
- (i) win/linux 未自绘圆点（依赖系统原生）= FAIL（mimic_mac 要求三平台统一）。

## 执行步骤

1. 启动 + draft 并排。
2. 非全屏态逐项核 a/b/c/e/h/i。
3. 触发全屏，观察过渡（g）+ 核 d/f。
4. 退出全屏确认可逆。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后与 W05 合并进 P2。
