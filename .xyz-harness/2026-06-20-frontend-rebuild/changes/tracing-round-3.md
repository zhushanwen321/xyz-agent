# Tracing Round 3

> 独立隔离上下文，从零重跑 5 视角。spec 版本：`verdict: pass / 2026-06-20 / 前端 v3 重建`（含 D5-D7、§8.5 v1 范围裁决、§9 DEFERRED 清单）。

## 追踪范围

- **追踪的视角**：全部 5 视角完整追踪（User Journey / Data Lifecycle / API Contract / State Machine / Failure Path），无降级。
  - 注：P2/P3/P5 受 D7（mock 全内存、永不失败、id 不模拟往返）约束，其持久化/失败/幂等分支大量坍缩到 §9 DEFERRED（G-015/029/031/032 等），已核对无新分支。
- **F 类事实核对**（均 VERIFIED，与 spec §1 描述一致）：
  - `shared/session.ts` `SessionStatus = 'active'|'idle'`（D6 派生前提成立）
  - `shared/message.ts` `MessageStatus='streaming|complete|error'`、`ToolCallStatus='running|completed|error'`、`contentBlocks` 有序块、`isInterrupted` 字段均在
  - `composables/{useChat,useSlashCommands}.test.ts` → 不存在的 `__tests__/`（断链 symlink，P0 清理项属实）
  - `mock/mock-ws.ts` 53 行仅 ping→pong；`lib/ipc.ts` 4 方法；`App.vue` 纯占位（**未**调 `useConnection().init()`，属 greenfield 起点，P1 接入）；`style.css` token 已清空待填
  - `main.ts` `app.use(i18n)` + `locales/{en-US,zh-CN}.ts` 已 wire
  - `protocol.ts` 错误契约三通道（error envelope / message.error / success:false）+ `phase-1-api-client.md` SA1-6 分解均在

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G3-001 | D | User Journey / State Machine | §8.5 ↔ §4 ↔ §9 | **v1 scope 三分体系不自洽**。§8.5 明示「v1 只做主流程，其余 DEFERRED，§9 完整记录」，但 §4 P1-P6 的多个设计交付物既不在 §8.5 主流程、也不在 §9：① P4 `companion-zones`（= progress-zone + git-zone，见 workspace/panel spec）；② P4 `detail-pane`（Side Drawer）；③ P2 `折叠态`（collapsed 容器态本身——G-024 只 defer 其 nav 按钮迁移、G-031 只 defer 其持久化，态本身未归类）；④ P1 `全屏两态` + Electron fullscreen 处理；⑤ P1 `app-nav-controls` 的「收起」按钮（←/→ 导航在 D1 in-scope，但「收起」依赖 collapsed 态）；⑥ Overview 卡片网格内容/筛选排序（§8.5 只说「进入与基本退出」，进入后看到什么未定）。这些元素的 v1 状态（deepen / shell 占位 / defer）需明确，否则 P3/P4/P6 实施时会逐个猜测。 |
| G3-002 | D | User Journey | §9 DEFERRED 触发点 | **DEFERRED 功能的触发入口在 v1 如何渲染**——无统一规则。当某触发器（trigger）的目标功能在 §9 DEFERRED 时，trigger 本身在 v1 是「不渲染 / 渲染但 disabled / 渲染但 no-op」？影响面广：sidebar nav `搜索`(⌘K,G-022) 按钮、Settings 入口(⌘,/avatar,G-021)、session-item hover `重命名`(G2-005)/`删除`(G-013) 按钮、panel-header `分屏`(G-023) 按钮、Overview `⌘⇧O`(G-020)、composer 工具条 `模型/thinking-level` 选择器（model.switch 协议在但 UC-2 未涉）。两条合理路径（「只渲 in-scope」 vs 「全渲但 deferred 项 no-op/disabled」）产出截然不同的 UI，spec 未选。 |
| G3-003 | D | User Journey / State Machine | §9 vs shell 基准 | **v1 键盘快捷键范围未明**。spec 显式 defer 了 ⌘K/⌘⇧O/⌘B 第3态/⌘,(§9)，但对 ⌘N（新建 session，UC-3 in-scope）、⌘[/⌘]（nav 后退/前进，D1 history 栈 in-scope）只字未提。因对应功能 in-scope 且 shell 基准（`shell/spec.md`）已绑这些键，**大概率推导为「v1 wire」**——故标 low confidence；但 spec 对同类快捷键（⌘K 等）显式 defer 却漏提这两个，留有歧义，建议一句明确。 |

## 追踪要点（验证过的路径，确认无新 gap）

- **UC-1 启动→Shell**：App mount → useConnection.init（mock 200ms / real 端口发现三路）→ shell 渲染。init 接入点未显式分配 phase，但 P1「App.vue 真 shell」可推导，不计 gap。
- **UC-2 mock 对话**：S1→S2→S5 send → mock 流式 text_delta → S6 stop → 回 S1 → 回合折叠 pill。abort 在 UC-2 主路径内，mock 须支持中断流（phase-1 min set 列 abort），D7 未显式列但不冲突。auto-scroll 基础版（新消息滚到底）清晰。
- **UC-3 切换/创建/Overview**：segmented tab A↔B（B 内容 G2-003 defer，tab 切换骨架 in-scope）；Overview 按钮→覆盖 main、sidebar 持久（ADR-0022）；基本退出 = Esc + 点卡片载入 session 回 chat（§8.5）。session.create 默认 label/cwd 属 fixture 细节，G2-006 已 defer 到 plan。
- **D6 SessionStatus 5 态派生**：从 isStreaming/isWaitingTool/lastMessage.status 派生，不动 shared 类型，mock 需 emit tool_call_start/end 以驱动 waiting 脉冲（G2-006 fixture 已含 tool_call 块，覆盖）。
- **连接 4 态 + G5 重连收尾**：ws-client 不变量完整（verified）；mock 不走真实重连（D7），G5 代码写入但 mock 不可验，属 mock-first 固有性质，不计 gap。
- **导航历史栈（D1）**：entries+pointer+splice+MAX=50+overview 第三 view；back/forward 与 Flow 4 分支回退解耦。清晰。
- **数据生命周期**：session/message 全内存（D7），reload 重置；唯一性 = mock 自生 id（简化）；无删除级联（delete defer）。覆盖。
- **失败路径**：mock 永不失败（D7）；真 error 走 envelope/message.error（protocol D10）；stream_error/markSessionError 路由（G3/G-029 defer）。覆盖。

## 收敛判定

**未收敛（NOT CONVERGED）**——3 个新 D 类 gap，均不在 §9、不可由现有文本无歧义推导。

- **G3-001（主）**：spec 自我宣称「§9 完整记录 DEFERRED」，但 §4 的 companion-zones / detail-pane / 折叠态 / 全屏两态 / Overview 卡片网格等内容既不在 §8.5 主流程也不在 §9，v1 scope 三分体系（§8.5 ↔ §4 ↔ §9）不自洽。这是本轮最实质的 gap，建议补一张「§4 各交付物 → v1 归属（deepen/shell/defer）」映射表，或在 §9 补齐遗漏项。
- **G3-002**：DEFERRED 触发入口的 v1 渲染规则缺失（hide/disabled/no-op），影响 6+ 处 trigger，缺统一规则会导致组件间不一致。
- **G3-003（low）**：⌘N/⌘[/⌘] v1 状态未明（大概率 in，但 spec 漏提）。

G3-001 与 G3-002 性质属「spec 一致性/清晰度」，补 1-2 段即可收口；G3-003 一句话即可。主 agent 可选择补 spec 后进 Round 4，或显式裁定这些归 plan 阶段细化。
