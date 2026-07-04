# Wave P2 · MessageStream + Overlays + Settings 精细度

> 自包含 handoff。新 session 只读本文档即可开工。先读完"项目与全局上下文"。

## 项目与全局上下文（所有 Wave 共享，必读）

**项目**：xyz-agent（Electron + Vue3 + TS + Tailwind v3 + Pinia）。v3 冷蓝暗色设计（ADR-0018），暗色为真默认（ADR-0021-B）。
**工作目录**：`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`
**渲染层源码根**：`src-electron/renderer/src/`（审计文档误写 `components/workspace/panel/`，实际是 `components/panel/`）
**编码规范**：`docs/standards.md` + worktree 根 `CLAUDE.md`（禁止 scoped 自定义 CSS、禁止原生 HTML 表单元素、禁止 any、Ponytail 模式）

**设计稿 SSOT**（路径含空格，bash 必须整体加引号）：
`"/Users/zhushanwen/Library/Application Support/Open Design/namespaces/release-stable/data/projects/5c80f187-ed73-415b-8c81-f825302eacbc/docs/designs/v3-demo/"`
下称 `$V3`。结构：`{shell,sidebar,workspace,panel,overlays,overview,settings}/spec.md` + 同目录 `draft-*.html`；根 `README.md` + `ui-skeleton.md`。

**审计产出**：`.v3-audit/`（`results/wave-W01~W19.md` + `batch-{1,2,3-4}-summary.md` + `decisions.md`）

**Phase D 已完成（6 commit）**：token SSOT（`e2b386ea`）/ 删零引用组件（`39eee5da`）/ UI 原子对齐（`373f33d6`）/ settingsStore（`c5723efa`）/ Shell+Sidebar+Panel 布局（`462e878e`）/ Composer steer（`3a4a33e5`）。详见 `git log --oneline -6`。

**3 裁决**（`.v3-audit/decisions.md`）：DEC-01 SessionItem=inset ring/Panel=四层；DEC-02 min-h=40px；DEC-03 S6=steer 长期方案。

**硬禁忌（必守）**：
1. ★ **AI 自身绝对禁止直接 read 图片，会卡死整个会话**。视觉对比走 subagent + 视觉模型（`minimax/MiniMax-M3` 或 `zai mimo-v2.5-pro`），返回文本结论。
2. dev server 等长跑进程必须**异步后台启动**（bash `background:true`）。
3. 禁 `SKIP_LINT=1`/`--no-verify`/`eslint-disable`/`any`。禁 scoped 自定义 CSS（keyframes 归 `tailwind.config.ts`）。
4. 路径含空格 bash 加引号。审计行号/路径会漂移，改前先读真实代码。

**模型路由**：subagent 需指定模型。读代码/规划→`kimi-coding/kimi-k2-thinking` 或 `deepseek/deepseek-v4-pro`；纯机械→`deepseek/deepseek-v4-flash`；视觉→`minimax/MiniMax-M3`。

---

## 本 Wave 目标

处理"数据字段/类型已存在但渲染层未接入"的精细度问题。这些**不依赖 flow-2 数据源**（字段已在 shared types 或 store 里），只需渲染层接线。区别于 DEFER 项（FileChanges/SideDrawer 等需新数据通道）。

## 任务清单（5 项）

### P2-1 · MessageStream OutputText 中间/收尾拆分
- **审计**：W11 WP-L3-08。draft-message-stream §4 规则表：Output Text 一种类型两种渲染——中间产出折进执行流程（trace），收尾位固定不折叠。
- **现状**：`components/panel/message-stream/Turn.vue` 把所有 assistant.content 拼成 `summaryText` 当收尾，未区分中间/收尾。
- **关键**：`Message.contentBlocks` 字段**已存在**（`shared/src/message.ts`，W11 确认）可区分，但 Turn.vue 未用。
- **改**：`Turn.vue` 读 contentBlocks，最后一条 text 块当收尾恒显，其余折进 trace。短期可先手动"最后一条=收尾"。
- **必读**：`$V3/panel/draft-message-stream.html` §4 规则表、`.v3-audit/results/wave-W11-message-stream.md` WP-L3-08、`shared/src/message.ts`（contentBlocks 定义）

### P2-2 · ReasoningBlock 独立折叠
- **审计**：W11 WP-L3-09。draft §4："长 reasoning 块可单独再折叠"。
- **现状**：`components/panel/message-stream/Block.vue` thinking 块直接显示 content 纯文本，无独立折叠 UI。`ThinkingBlock.collapsed` 字段**已定义**（`shared/src/message.ts`，W11 确认）但 Block.vue 未响应。
- **改**：`Block.vue` thinking 分支加 toggle（点击 header 折叠/展开）+ 响应 `collapsed` 字段。
- **必读**：同 P2-1 的 draft + wave-W11 WP-L3-09、`shared/src/message.ts`（ThinkingBlock.collapsed）

### P2-3 · SearchModal z-index
- **审计**：W15 OL-L1-01。SearchModal z-index 50，应 1000（高于所有面板）。
- **改**：`components/overlays/SearchModal.vue`（先 grep 定位实际 z-index class），改 `z-[1000]` 或对应 tailwind 配置。
- **注意**：SearchModal 内容本身 DEFERRED（G-022），本任务只修 z-index 层级。
- **必读**：`.v3-audit/results/wave-W15-overlays.md` OL-L1-01、`$V3/overlays/spec.md`

### P2-4 · SettingsModal .modal-head 结构
- **审计**：W18 ST-L2-02。SettingsModal 缺 `.modal-head` 结构。
- **改**：先读 `$V3/settings/draft-settings-shell.html` 的 modal-head 结构 + `components/` 下 SettingsModal.vue（grep 定位），按设计补 head 结构。
- **注意**：Settings 菜单内容 G3-002 DEFERRED，本任务只补 head 容器结构，不补菜单项。
- **必读**：`.v3-audit/results/wave-W18-settings-shell.md` ST-L2-02、`$V3/settings/draft-settings-shell.html`、`$V3/settings/spec.md`

### P2-5 · Composer 三 zone 间距统一
- **审计**：W13 WP-L3-29。设计要求三 zone（ProgressZone/Composer/GitZone）垂直 gap:6px 紧凑成"带"，各自独立成卡。现状各自独立 margin/padding（ProgressZone mt-2.5 / Composer pt-2.5 / GitZone mb-3），非规范 6px。
- **改**：`components/panel/Panel.vue`（5 zone 容器）包一个 `flex flex-col gap-1.5`（6px）容器统一间距，移除三 zone 各自的上下 margin。或读 `$V3/panel/draft-companion-zones.html` §裁决 确认最终间距方案。
- **注意**：三 zone 的 bg-input/圆角 Phase D 已统一（`462e878e`），本任务只修垂直间距。
- **必读**：`.v3-audit/results/wave-W13-companion-zones.md` §二（视觉一体核查专节）、`$V3/panel/draft-companion-zones.html`

## 执行方式

P2-1/P2-2 都改 message-stream/（Turn.vue + Block.vue），**必须同一 subagent 串行**（避免文件冲突）。P2-3/P2-4/P2-5 独立可并行。
- message-stream 组（P2-1+P2-2）：`kimi-coding/kimi-k2-thinking`，1 个 subagent
- P2-3/P2-4/P2-5：`deepseek/deepseek-v4-pro`，3 个并行 subagent

## 必读文档

- 审计详情：`.v3-audit/results/wave-W11-message-stream.md`（P2-1/2）、`wave-W13-companion-zones.md`（P2-5）、`wave-W15-overlays.md`（P2-3）、`wave-W18-settings-shell.md`（P2-4）
- 数据契约：`src-electron/shared/src/message.ts`（contentBlocks / ThinkingBlock.collapsed 字段定义）
- 设计稿：`$V3/panel/draft-message-stream.html`、`draft-companion-zones.html`、`$V3/overlays/spec.md`、`$V3/settings/draft-settings-shell.html`
- batch 摘要：`.v3-audit/batch-3-4-summary.md`（W11/W15/W18 结论）

## 验证

每项改后：`cd src-electron/renderer && npx vue-tsc --noEmit` + 根目录 `npm run lint`。message-stream 改动（P2-1/P2-2）需异步启 dev:mock 截图给 minimax subagent 验证回合折叠态视觉（禁忌第 1 条）。

## 边界（不做）

- **不做 FileChanges 块**（W11 WP-L3-11，依赖 runtime 数据通道，DEFER flow-2，见 Wave F2）
- **不做 SteerFollowup pending 气泡**（WP-L3-12，G-019 DEFER）
- **不做 SystemNotice**（WP-L3-13，需 messageTurns 扩 system 分组 + 数据源）
- **不做消息操作菜单**（WP-L3-14，flow-2 范畴）
- 不做 Settings 菜单内容（G3-002）
- 不做 ProgressZone/GitZone 状态机（依赖 runtime，DEFER）
