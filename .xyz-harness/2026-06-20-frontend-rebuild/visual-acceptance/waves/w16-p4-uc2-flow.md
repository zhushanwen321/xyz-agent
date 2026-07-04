---
wave: W16
phase: P4
cases: complex×1
deps: [W12, W13, W14, W15]
est: 15min
va_ref: VA-05 D3-D4 + 集成
---

> 结果: ✅ PASS (2026-06-20, W16 修复: 流式状态机稳定性)

# W16 · P4 UC-2 端到端集成 + DEFERRED hide

> 1 个复杂 case：UC-2 全链路 smoke test + abort 基础 + Side Drawer/⌘B/Tool 审批 hide。**P4 收尾集成验收**。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` | §7 UC-2 + §8.5 P4 + §9（G-018/019/025/033） |
| `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan-frontend.md` | §3 UC-2 数据流链 |
| `$ROOT/docs/designs/v3-demo/panel/draft-detail-pane.html` | Side Drawer（DEFERRED，确认未渲染） |
| `$ROOT/docs/designs/v3-demo/panel/draft-breadcrumb-popovers.html` | ⌘B 三态（v1 只前两态） |
| `$ROOT/src-electron/renderer/src/components/panel/MessageStream.vue` | 集成验证 |
| `$ROOT/src-electron/renderer/src/components/panel/Composer.vue` | 集成验证 |

## 前置

- **W12 + W13 + W14 + W15 全部 PASS**（各环节就绪，本 wave 做集成）。

## Case · UC-2 全链路 + hide 规则（complex）

> UC-2（spec §7）：用户发消息 → 流式回复 → 回合折叠。端到端跑通主路径。

### 检查项

| # | 检查 | 对照 | 期望 | 标记 |
|---|------|------|------|------|
| a | UC-2 发送→流式→折叠 | spec §7 UC-2 + plan-frontend §3 | 完整链路：Composer 输入 → 发送 → store.appendUser（user 块） → assistant 流式（光标） → 完成 → 回合折叠（pill） | ✅ |
| b | abort 基础（S6 停止） | spec §9 G-025 | 流式中点停止按钮 → 中断流式（基础可用） | ✅(基础) |
| c | abort 高级（中断后折叠/重发） | spec §9 G-025 | — | 🔇 |
| d | ⌘B 前两态 | spec §8.5 + draft-breadcrumb-popovers | ⌘B toggle sidebar（展开/收起），正常工作 | ✅ |
| e | ⌘B 第 3 态（折叠+脏数据→分支 popover） | spec §9 G-033 + draft 卡 E | — | 🔇 |
| f | Side Drawer（detail-pane） | draft-detail-pane + panel/spec | v1 不做，确认**未渲染**（无 detail-pane DOM） | 🔇(hide) |
| g | Tool 审批 UI | spec §9 G-018 | — | 🔇(hide) |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`，进新 session。
2. **UC-2 主路径**（a）：
   - Composer 输入「测试消息」→ 发送。
   - 观察：user 块立即出现（靠右气泡）→ assistant 开始流式（光标闪烁）→ 流式完成 → 回回合折叠（pill 显计数）。
   - 全链路无卡顿 / 无错误 / 状态正确翻转（S1→S2→S5→S6→S1）。
3. **abort**（b）：再发一条，流式中点停止 → 确认中断（不再追加内容）。
4. **⌘B**（d）：按 ⌘B 验 sidebar 展开/收起正常。
5. **hide 检查**：
   - (f) DevTools 搜 detail-pane / Side Drawer DOM → 确认不存在。
   - (g) 流式中 tool_call 块 → 确认无审批按钮（或入口 hide）。
6. 🔇 (c/e) 不验。

### 判定

**PASS**：a/b/d ✅ + f/g 🔇(hide) 符合。
**FAIL 触发**：
- (a) 链路任一环节断（发送无追加 / 无流式 / 不折叠）= FAIL（UC-2 核心）。
- (b) 停止按钮无反应 = FAIL（基础 abort）。
- (f) Side Drawer DOM 已渲染 = FAIL（违反 hide，除非入口隐藏不可达）。
- (g) Tool 审批入口显示但无反应 = FAIL（hide 规则）。
- 🔇 (c/e) 不影响。

## 执行步骤

1. 启动 mock + 新 session。
2. 跑 UC-2 全链路（a），观察每环节。
3. 测 abort（b）+ ⌘B（d）。
4. DevTools 确认 Side Drawer（f）+ Tool 审批（g）hide。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后进 W17-W20（P6，可并行派单）。
