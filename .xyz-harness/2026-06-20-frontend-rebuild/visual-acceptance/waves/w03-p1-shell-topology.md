---
wave: W03
phase: P1
cases: complex×1
deps: [W02]
est: 10min
va_ref: VA-02 #1-6
---

# W03 · P1 Shell 核心拓扑（aside 透明 + main 浮起）

> 1 个复杂 case：zcode-demo 拓扑核心语义。视觉层次 + DOM 结构双重判定，**P1 最关键验收**。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/shell/spec.md` | **Shell 规范**（§一三层语义命门 + §六不靠 z-index） |
| `$ROOT/docs/designs/v3-demo/shell/draft-overlay-states.html` | **主对照稿**（含拓扑尺寸表） |
| `$ROOT/src-electron/renderer/src/components/shell/AppShell.vue` | 待验：L0 容器布局 |
| `$ROOT/src-electron/renderer/src/components/shell/AsideRegion.vue` | 待验：透明 sidebar 槽 |
| `$ROOT/src-electron/renderer/src/components/shell/MainPanel.vue` | 待验：float 主区槽 |

## 前置

- **W02 PASS**（token + shadcn 就绪，shell 可渲染）。
- 启动：`cd $ROOT && npm run dev`。

## Case · Shell 核心拓扑（complex）

> **核心约束**（shell/spec §一 + §六）：base 平铺全屏 → sidebar 透明融合 → main 唯一 float-panel 浮起。**不靠 z-index，靠 background / border / radius / shadow**。

### 检查项

| # | 检查 | 对照 | 期望 |
|---|------|------|------|
| a | `.app-shell` 布局 | draft-overlay-states + spec §一 | `display:flex` + `padding:12px`(`--space-3`) + `gap:12px` |
| b | `.aside-region` 宽度 | draft 尺寸表 + spec §一 | `width:200px` |
| c | `.aside-region` **透明** | spec §一（三层命门） | **无 background 属性**（computed `background-color: transparent` / `rgba(0,0,0,0)`），继承 base，与窗口底色融合 |
| d | `.main-panel` 浮起 | draft + spec §一 | 有 `background`(`--panel`/`--surface`) + `border` + `border-radius:12px`(`--radius-lg`) + `box-shadow`，**视觉上唯一浮起面板** |
| e | `.main-panel` **不靠 z-index** | spec §六（关键） | computed `z-index` 为 `auto`/未设置；浮起完全靠 background+border+shadow |
| f | 视觉层次 | draft-overlay-states 浏览器并排 | 窗口呈现：底色平铺 → 左侧 sidebar 区域与底色融为一体（无边框无背景）→ 右侧主区明显浮起（有边框+圆角+投影） |

### 检查方法

1. `cd $ROOT && npm run dev`。
2. 浏览器打开 `$ROOT/docs/designs/v3-demo/shell/draft-overlay-states.html` 并排对照（视觉层次 f）。
3. Electron DevTools Elements：
   - 选中 `.app-shell` → 查 `display`/`padding`/`gap`（a）。
   - 选中 `.aside-region` → 查 `width`（b）+ `background-color`（c，必须 transparent）。
   - 选中 `.main-panel` → 查 `background`/`border`/`border-radius`/`box-shadow`（d）+ `z-index`（e，必须 auto）。

### 判定

**PASS**：a-f 全部符合。
**FAIL 触发**：
- (c) aside 有 background = FAIL（违背透明命门，整个拓扑语义崩塌）。
- (e) main 用 z-index 浮起 = FAIL（spec §六 明确禁止）。
- (f) 视觉上无法区分"sidebar 融合 + main 浮起"的层次 = FAIL。

## 执行步骤

1. 启动 dev + 打开 draft 并排。
2. 先肉眼判视觉层次（f）：sidebar 应"消失"进底色，main 应"浮"起来。
3. DevTools 逐项核 a-e 的 computed style。
4. 若 (c)/(e) 不符，读 `AsideRegion.vue` / `MainPanel.vue` 查根因（是否误加 background / z-index）。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后进 W05（Shell 杂项）。W04（traffic-light）与本 wave 无依赖，可并行。
