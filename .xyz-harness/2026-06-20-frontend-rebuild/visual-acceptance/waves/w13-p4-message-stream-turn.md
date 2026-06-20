---
wave: W13
phase: P4
cases: complex×1
deps: [W12]
est: 10min
va_ref: VA-05 A3-A5,A9
---

> 结果: ✅ PASS (2026-06-20, minimax-m3)

# W13 · P4 MessageStream 回合折叠 + auto-scroll

> 1 个复杂 case：回合默认折叠 + pill 计数 + 展开真实时序 + auto-scroll 基础。机制验收。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/panel/spec.md` | **§回合折叠机制** |
| `$ROOT/docs/designs/v3-demo/panel/draft-message-stream.html` | **主对照稿**（折叠 pill + 计数） |
| `$ROOT/src-electron/renderer/src/components/panel/message-stream/Turn.vue` | 待验：回合折叠 |
| `$ROOT/src-electron/renderer/src/composables/effects/useChatScroll.ts` | 待验：auto-scroll |

## 前置

- **W12 PASS**（块渲染就绪，有完整回合数据）。

## Case · 回合折叠 + auto-scroll（complex）

> **回合** = AI 一次工作（开始到停止）。默认折叠只显 Summary + File Changes。

### 检查项

| # | 检查 | 对照 | 期望 | 标记 |
|---|------|------|------|------|
| a | 回合默认折叠 | draft-message-stream + panel/spec §回合折叠 | stream 完成的回合默认只显 Summary + File Changes（reasoning/tool 等折叠隐藏） | ✅ |
| b | 折叠 pill 计数 | draft-message-stream | pill 显「已工作 Xm Xs · N reasoning · M tool」计数 | ✅ |
| c | pill 点击展开 | panel/spec §回合折叠 | 点 pill → 展开按真实时序还原所有块（reasoning / tool / text 按发生顺序） | ✅ |
| d | 展开内容时序正确 | panel/spec §回合折叠 | 展开后块顺序 = 真实流式时序（非类型分组） | ✅ |
| e | auto-scroll 基础版 | spec §8.5 + useChatScroll | 新消息到达时自动滚到底 | ✅ |
| f | auto-scroll 高级（上滚暂停 / 跳底提示） | spec §9 G2-007 | — | 🔇 |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`，进含完整回合的 mock session。
2. 浏览器打开 draft-message-stream.html 并排。
3. 核默认折叠（a）：回合只显 Summary + File Changes。
4. 核 pill 计数（b）：数值合理（reasoning/tool 数与实际匹配）。
5. 点 pill 展开（c）：核展开内容 + 时序（d，DevTools 看展开后块顺序）。
6. auto-scroll（e）：触发新消息（发消息或推进 mock stream）→ 确认视口自动到底。
7. 🔇 (f) 上滚暂停/跳底提示不验。

### 判定

**PASS**：a-e ✅ 项符合。
**FAIL 触发**：
- (a) 回合不默认折叠（全展开）= FAIL（核心呈现规则）。
- (c/d) 展开后时序错乱（类型分组而非时序）= FAIL。
- (e) 新消息不滚到底 = FAIL（主聊天流可用性）。
- 🔇 (f) 不影响。

## 执行步骤

1. 启动 + draft 并排。
2. 核默认折叠（a）+ pill（b）。
3. 点展开核时序（c/d）。
4. 触发新消息看 auto-scroll（e）。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后可与 W14/W15 并行。
