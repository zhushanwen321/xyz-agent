---
wave: W08
phase: P2
cases: complex×1
deps: [W06]
est: 10min
va_ref: VA-03 #9-11
---

# W08 · P2 SessionItem（5 状态点 + 信息结构 + hover）

> 1 个复杂 case：D6 派生 5 状态点 + 信息结构 + hover 操作浮现。多状态 + 交互。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/sidebar/spec.md` | §会话项（D6 状态派生） |
| `$ROOT/docs/designs/v3-demo/sidebar/draft-session-item.html` | **主对照稿**（5 状态 + 激活 + hover） |
| `$ROOT/src-electron/renderer/src/components/sidebar/SessionItem.vue` | 待验：状态点 + 结构 + hover |
| `$ROOT/src-electron/renderer/src/components/sidebar/SessionList.vue` | 待验：列表渲染 |

## 前置

- **W06 PASS**（会话列表容器就绪）。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`（需 5 状态 mock fixture）。

## Case · SessionItem 5 态 + 结构 + hover（complex）

> 状态点 5 态由 D6（spec §5 D6）从 session 数据派生，非硬编码。

### 检查项

| # | 检查 | 对照 | 期望 |
|---|------|------|------|
| a | 5 状态点全显 | draft-session-item + spec §会话项 | running(实色转圈/脉冲) / waiting(脉冲) / done(静态) / stopped(静态灰) / error(红) — 5 态各有视觉区分 |
| b | waiting 脉冲 | draft-session-item | waiting 状态点有脉冲动画（非静态） |
| c | 信息结构 | draft-session-item | 每项含：状态点 + 标题 + 「目录·分支」小字 + 时间 |
| d | hover 操作浮现 | draft-session-item | hover 时时间隐去，浮现 2 个方形按钮（重命名 / 删除） |
| e | 激活态 | draft-session-item | active session 项有明显激活样式（accent 左条或 bg） |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`，确保 mock fixture 含 5 种状态的 session（若缺，需补 `api/mock/data.ts`）。
2. 浏览器打开 draft-session-item.html 并排。
3. 肉眼 + DevTools 核 5 状态点视觉（a）+ waiting 脉冲（b，查 `animation`）。
4. 核信息结构 DOM（c）：状态点 + 标题 + 小字 + 时间齐全。
5. hover 某项（d）：时间消失 + 2 方形按钮出现。
6. 点一项激活（e）：看激活样式。

### 判定

**PASS**：a-e 全符合。
**FAIL 触发**：
- (a) 缺状态点类型 / 状态点无视觉区分 = FAIL（D6 契约）。
- (b) waiting 无脉冲 = FAIL。
- (d) hover 无操作浮现 = FAIL（交互缺失）。

**注**：重命名 / 删除按钮点击后的**功能流**（rename 流 / 删除确认）是 DEFERRED（spec §9 G2-005/G-013），本 wave **只验按钮浮现**，不验点击效果。但若按钮可点且点了无反应 = FAIL（应 hide 或实现）。

## 执行步骤

1. 启动 mock（5 状态 fixture）+ draft 并排。
2. 核 5 状态点（a/b）。
3. 核结构（c）+ hover（d）+ 激活（e）。
4. 确认 hover 按钮若未实现功能则应 hide（不留无反应按钮）。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后可与 W07/W09 并行。
