---
wave: W17
phase: P6
cases: complex×1
deps: [W16]
est: 10min
va_ref: VA-06 #1-7
---

# W17 · P6 Overview 进入/退出 + 覆盖关系

> 1 个复杂 case：Overview 入口触发 + 覆盖 workspace + sidebar 持久 + 进入/点卡片/Esc 退出。交互路径 + 覆盖语义。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/overview/spec.md` | **§触发 + §交互 + §入口落点** |
| `$ROOT/docs/designs/v3-demo/overview/draft-entry.html` | **主对照稿 A**（入口 + 覆盖关系） |
| `$ROOT/docs/architecture/adr/0022-overview-entry-coverage.md` | **入口覆盖裁决** |
| `$ROOT/src-electron/renderer/src/components/overview/Overview.vue` | 待验：进入/退出 + 覆盖 |

## 前置

- **W16 PASS**（panel 主流程就绪，可切 Overview）。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`（需多 session mock）。

## Case · Overview 进入/退出 + 覆盖（complex）

> **核心**（ADR-0022）：Overview ≠ 放大版 Session List。入口 = sidebar 按钮；激活后覆盖 workspace；**sidebar 持久**。

### 检查项

| # | 检查 | 对照 | 期望 |
|---|------|------|------|
| a | 入口 = sidebar Overview 按钮 | draft-entry + ADR-0022 | sidebar「Overview」入口按钮触发（带 session 计数角标，见 W07） |
| b | 覆盖 workspace | draft-entry + ADR-0022 | 激活后 main 区被卡片网格取代（workspace 内容隐藏/覆盖） |
| c | sidebar 持久 | draft-entry + ADR-0022 | Overview 激活时 **sidebar 不变**（不被覆盖，仍可操作） |
| d | Overview 按钮激活态 | draft-entry + sidebar/spec | 激活时按钮转 accent 态 |
| e | 退出·点卡片 | spec §8.5 + §交互 | 点任意卡片 → 载入该 session → 回 chat view |
| f | 退出·Esc | spec §触发 | Esc → 退出 Overview 回 workspace |
| g | 退出后状态恢复 | spec §边缘状态 | 退出后 workspace 恢复原状态（如双 Panel 不丢失） |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`，mock ≥3 session。
2. 浏览器打开 draft-entry.html 并排。
3. 点 sidebar Overview 按钮验进入（a）：main 区被卡片网格取代（b），sidebar 不变（c），按钮转 accent（d）。
4. 点任意卡片（e）：载入 session → 回 chat。
5. 再进 Overview，按 Esc（f）：退出回 workspace。
6. 退出后确认 workspace 状态恢复（g，若之前是双 Panel，退出后仍双 Panel）。

### 判定

**PASS**：a-g 全符合。
**FAIL 触发**：
- (c) Overview 覆盖了 sidebar = FAIL（ADR-0022 强制 sidebar 持久）。
- (a) 入口不在 sidebar（如 workspace 顶栏 view-tab）= FAIL。
- (g) 退出后 workspace 状态丢失 = FAIL。
- (e/f) 点卡片/Esc 无反应 = FAIL。

## 执行步骤

1. 启动 mock + draft 并排。
2. 进入（a-d）+ 覆盖关系（b/c 重点）。
3. 点卡片退出（e）+ Esc 退出（f）+ 状态恢复（g）。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后进 W18（网格细节）。
