---
wave: W12
phase: P4
cases: complex×1
deps: [W11]
est: 12min
va_ref: VA-05 A1-A2,A6-A8
---

> 结果: ✅ PASS (2026-06-20, minimax-m3)

# W12 · P4 MessageStream 块渲染（7 类 + 气泡 + 光标 + 红框）

> 1 个复杂 case：7 类消息块渲染 + mock fixture 丰富度 + user 气泡 + 流式光标 + 失败红框。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/panel/spec.md` | §消息块（7 类）+ §流式光标 |
| `$ROOT/docs/designs/v3-demo/panel/draft-message-stream.html` | **主对照稿 A**（7 块 + 气泡 + 光标 + 红框） |
| `$ROOT/src-electron/renderer/src/components/panel/MessageStream.vue` | 待验：块渲染 |
| `$ROOT/src-electron/renderer/src/components/panel/message-stream/Block.vue` | 待验：块子组件 |
| `$ROOT/src-electron/renderer/src/api/mock/data.ts` | 待验：mock fixture（块丰富度） |

## 前置

- **W11 PASS**（Panel 骨架，message-stream zone 就位）。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`。

## Case · 7 类块 + 气泡 + 光标 + 红框（complex）

> 7 类：user / output-text / reasoning / tool / file-changes / steer·followup / system（panel/spec §消息块）。

### 检查项

| # | 检查 | 对照 | 期望 | 标记 |
|---|------|------|------|------|
| a | mock fixture 块丰富度 | draft-message-stream §附录 + spec §9 G2-006 | fixture 至少含：user / assistant-text / tool_call(简化) / summary / error，可验收 | ✅ |
| b | 7 类块可渲染 | draft-message-stream + panel/spec | 各类型块有对应视觉（user 气泡 / text 正文 / reasoning 折叠 / tool 卡 / file-changes 卡 / steer 按钮 / system 提示） | ✅(主类) |
| c | user 气泡靠右 | draft-message-stream | `bubble-user` 靠右（非左对齐正文流） | ✅ |
| d | 流式光标 | draft-message-stream | streaming 时末尾 `cursor` 闪烁（CSS animation） | ✅ |
| e | 失败红框 | draft-message-stream | error 块有红色边框/背景 `err` 样式 | ✅ |
| f | reasoning / steer 详细交互 | spec §9 G2-006 | — | 🔇 |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`，进一个有丰富消息的 mock session。
2. 浏览器打开 draft-message-stream.html 并排。
3. 核 fixture 块类型（a）：DevTools 看 MessageStream 内 Block 组件类型分布，或直接读 `api/mock/data.ts` 确认含 user/text/tool/summary/error。
4. 肉眼 + DevTools 核各类块视觉（b）：user 气泡（c，靠右 + bg 区别）、text 正文、error 红框（e）。
5. 触发流式（发条消息或用 streaming fixture）：看末尾光标闪烁（d，DevTools 查 cursor 元素 + animation）。
6. 🔇 (f) reasoning/steer 详细交互不验。

### 判定

**PASS**：a-e ✅ 项符合。
**FAIL 触发**：
- (a) fixture 缺主要块类型 = FAIL（UC-2 不可验收，spec G2-006）。
- (c) user 气泡不靠右 = FAIL。
- (e) error 无红框 = FAIL。
- 🔇 (f) 不影响。

## 执行步骤

1. 启动 mock + draft 并排。
2. 读 fixture / 看渲染（a/b）。
3. 核 user 气泡（c）+ error 红框（e）。
4. 触发流式看光标（d）。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后进 W13（回合折叠）。
