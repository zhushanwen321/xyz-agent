---
wave: W14
phase: P4
cases: complex×1
deps: [W11]
est: 12min
va_ref: VA-05 B1-B6,B10
---

> 结果: ✅ PASS (2026-06-20, W14 修复: S5 spinner 三态 + 工具条元素补齐)

# W14 · P4 Composer 4 态主路径 + 视觉一体

> 1 个复杂 case：S1/S2/S5/S6 四态流转 + 输入区/工具条视觉一体 + 工具条布局 + 发送→追加链路。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/panel/spec.md` | **§composer 视觉一体** |
| `$ROOT/docs/designs/v3-demo/panel/draft-composer-states.html` | **主对照稿 B**（9 态，v1 只验 4） |
| `$ROOT/src-electron/renderer/src/components/panel/Composer.vue` | 待验：4 态 + 工具条 |
| `$ROOT/src-electron/renderer/src/stores/chat.ts` | 待验：send 编排 |
| `$ROOT/src-electron/renderer/src/composables/features/useChat.ts` | 待验：send |

## 前置

- **W11 PASS**（composer zone 就位）。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`。

## Case · Composer 4 态 + 视觉一体（complex）

> v1 只做主路径 4 态：S1 空 → S2 聚焦 → S5 发送中 → S6 停止 → 回 S1。

### 检查项

| # | 检查 | 对照 | 期望 | 标记 |
|---|------|------|------|------|
| a | S1 空态 | draft-composer-states | 输入区空，工具条静态（未激活） | ✅ |
| b | S2 聚焦态 | draft-composer-states | 输入区聚焦，工具条激活（视觉变化） | ✅ |
| c | S5 发送中 | draft-composer-states | spinner + 禁用输入 | ✅ |
| d | S6 停止态 | draft-composer-states | 显示停止按钮替代发送 | ✅ |
| e | 输入区+工具条视觉一体 | panel/spec §composer + draft | 同一卡片底，**无强分隔线**（border-top 等） | ✅ |
| f | 工具条布局 | draft-composer-states | `+添加` · 上下文 · 模型 · thinking-level · 发送（从左到右，齐全） | ✅ |
| g | 发送→追加链路 | plan-frontend §3 UC-2 链 | Composer send → useChat.send → store.appendUser → MessageStream 渲染 user 块 | ✅ |
| h | S3 @浮层 / S4 附件 | spec §9 G2-002 | — | 🔇 |
| i | S7/S8 steer / followup / S9 失败重发 | spec §9 G-019 | — | 🔇 |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`，进一个 session。
2. 浏览器打开 draft-composer-states.html 并排。
3. **S1→S2**：点输入区聚焦，核工具条激活（a/b）。
4. **S2→S5**：输入文字 + 发送，核 spinner + 禁用（c）+ 消息流追加 user 块（g）。
5. **S5→S6**（若 mock stream 中）：核停止按钮（d）。
6. **S6→S1**：点停止或等完成，核回空态。
7. DevTools 查 composer 工具条 DOM：确认输入区与工具条同一容器 + **无 border-top 等强分隔**（e）+ 工具条元素齐全（f）。
8. 🔇 (h/i) S3/S4/S7-S9 不验；确认入口若显示则应 hide。

### 判定

**PASS**：a-g ✅ 项符合。
**FAIL 触发**：
- (e) 输入区与工具有强分隔线 = FAIL（panel/spec 明确视觉一体）。
- (g) 发送后消息流不追加 = FAIL（主链路断）。
- (d) 无停止按钮 = FAIL。
- 🔇 (h/i) 不影响；但若 S3/S4/@浮层入口显示且无反应 = FAIL（hide 规则）。

## 执行步骤

1. 启动 + draft 并排。
2. 走 S1→S2→S5→S6→S1 流转（a-d）。
3. 发送核追加（g）。
4. DevTools 核视觉一体（e）+ 工具条（f）。
5. 确认 🔇 入口 hide。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后可与 W13/W15 并行。
