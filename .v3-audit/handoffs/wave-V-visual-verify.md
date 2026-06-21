# Wave V · Phase D 视觉验证

> 自包含 handoff。新 session 只读本文档即可开工。执行前先读完"项目与全局上下文"。

## 项目与全局上下文（所有 Wave 共享，必读）

**项目**：xyz-agent（Electron + Vue3 + TS + Tailwind v3 + Pinia）。v3 冷蓝暗色设计（ADR-0018），暗色为真默认（ADR-0021-B）。
**工作目录**：`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`
**渲染层源码根**：`src-electron/renderer/src/`（注意：审计文档误写 `components/workspace/panel/`，实际是 `components/panel/`）
**编码规范**：`docs/standards.md` + worktree 根 `CLAUDE.md`（禁止 scoped 自定义 CSS、禁止原生 HTML 表单元素、禁止 any、Ponytail 模式）

**设计稿 SSOT**（路径含空格，bash 命令必须整体加引号）：
`"/Users/zhushanwen/Library/Application Support/Open Design/namespaces/release-stable/data/projects/5c80f187-ed73-415b-8c81-f825302eacbc/docs/designs/v3-demo/"`
下称 `$V3`。结构：`{shell,sidebar,workspace,panel,overlays,overview,settings}/spec.md` + 同目录 `draft-*.html`；根 `README.md` + `ui-skeleton.md`。

**审计产出**：`.v3-audit/`（`results/wave-W01~W19.md` + `batch-{1,2,3-4}-summary.md` + `decisions.md` + `phase-D-plan.md`）

**Phase D 已完成（6 commit，工作树干净）**：
- `e2b386ea` token SSOT（+`--surface-2`/`--bg-elevated`/`--bg-input` + `[data-theme=light]` 槽位 + pulse/steer-breathe keyframes 收敛到 tailwind.config.ts）
- `39eee5da` 删 24 零引用组件（dropdown-menu/tooltip/dialog 未用子组件）
- `373f33d6` UI 原子（Input/Textarea bg-surface-2+inset ring+error prop；button 4 variant 对齐；Dialog backdrop-blur+bg-surface）
- `c5723efa` settingsStore 骨架（theme/language/colorTheme + setTheme 应用 data-theme）
- `462e878e` Shell/Sidebar/Panel（SessionItem flex+inset ring；AppShell rounded-[10px]+NavControls 提升；Panel bg-elevated 四层保留；三 zone bg-input）
- `3a4a33e5` Composer steer/followUp（DEC-03，pi RPC 已就绪，前端链路打通）

**3 裁决**（详见 `.v3-audit/decisions.md`）：DEC-01 SessionItem=inset ring/Panel=四层；DEC-02 min-h=40px；DEC-03 S6=steer 长期方案。

**硬禁忌（必守）**：
1. ★ **AI 自身绝对禁止直接 read 图片，会卡死整个会话**。视觉对比/截图分析必须走 subagent + 视觉模型（`minimax/MiniMax-M3` 或 `zai mimo-v2.5-pro`），subagent 截图后返回**文本结论**。
2. dev server 等长跑进程必须**异步后台启动**（bash `background:true`），同步会阻塞超时被 abort。
3. 禁 `SKIP_LINT=1`/`--no-verify`/`eslint-disable`/`any`。禁 scoped 自定义 CSS（keyframes 归 tailwind.config.ts）。
4. 路径含空格（Open Design 目录）bash 必须加引号。审计行号/路径会漂移，改前先读真实代码。

**模型路由**：subagent 默认 worker 无可用模型，必须指定。读代码/规划→`kimi-coding/kimi-k2-thinking` 或 `deepseek/deepseek-v4-pro`；纯机械→`deepseek/deepseek-v4-flash`；视觉对比→`minimax/MiniMax-M3`。

---

## 本 Wave 目标

验证 Phase D 6 个 commit 的实际视觉渲染符合设计稿，发现回归或偏差。tsc+lint 已过，但运行时视觉未验。

## 验证方法（严格按序，禁忌第 1/2 条）

**1. 异步启动 mock dev server**：
```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime/src-electron
# 必须后台启动（background:true），勿同步
npm run dev:mock   # VITE_MOCK=true，走 mockConnect，不连真实 runtime
```
- Vite 端口 1420（strictPort，被占则静默失败，先 `lsof -ti:1420 | xargs kill -9` 清理）
- Electron CDP 端口 9222（`--remote-debugging-port=9222`，供截图）
- 启动后等待 Vite "ready" + Electron 窗口出现（~10s）

**2. CDP 截图关键状态**（派给 minimax 视觉 subagent，不在主 agent 做）：
触发各待验状态，截全屏 PNG 保存到 `/tmp/v3-verify/`。需截的状态：
- V1 Sidebar SessionItem：列表态 + active 态（验 DEC-01 inset ring、flex 布局状态点/标题/时间同行）
- V2 Panel：单 panel + 双 panel active/standby（验四层激活：竖条+inset ring+bg-elevated+opacity）
- V3 Composer：空态(S1) + 输入中(S2) + 流式中(S6 steer-breathe ring)（验 bg-input、placeholder 切换、工具区纯文本化）
- V4 Dialog：打开 SettingsModal/SearchModal（验 backdrop-blur、bg-surface 浮起、close 态非蓝）
- V5 Input/Textarea：focus 态（验 inset accent-ring、bg-surface-2 容器感）
- V6 Button：default/secondary/ghost/danger 四 variant + hover 态（验 Ghost hover=surface-hover 非蓝、Danger 文字色）
- V7 AppShell：窗口圆角 10px（验 win/linux 锐角已修；mac 下观察圆角）
- V8 删除组件无破坏：确认 dropdown/tooltip 删除后 SettingsModal/SearchModal 正常渲染

**3. 视觉对比**（minimax subagent）：每张截图对比对应 `$V3/*/draft-*.html`，返回文本差异清单。**截图文件不要传回主 agent**。

**4. 产出**：`.v3-audit/verify/phase-D-visual.md`——逐项 ✅/⚠/❌ + 偏差描述 + 是否需 Wave P1 微调。

## 必读文档（绝对路径）

- 设计稿对照（按上面 V1-V8 选）：
  - `$V3/sidebar/draft-session-item.html` + `$V3/sidebar/draft-five-states.html`
  - `$V3/workspace/draft-dual-panel.html`（Panel 激活四层）
  - `$V3/panel/draft-composer-states.html`（Composer S1-S9 + steer 文案）
  - `$V3/panel/draft-companion-zones.html`（三 zone bg-input 视觉一体）
  - `$V3/settings/draft-settings-shell.html` + `$V3/overlays/draft-search-modal.html`（Dialog blur）
- 审计结论对照：`.v3-audit/batch-3-4-summary.md` §五（差异点①②③ 预期修复）、`.v3-audit/decisions.md`
- Phase D 改动清单：`git show --stat e2b386ea 39eee5da 373f33d6 c5723efa 462e878e 3a4a33e5`

## 关键现状（验证基准）

- `--surface-2` 与 `--surface-hover` 同值 `#1b1b20`（设计稿两处独立取值未协调）。验证时关注 Input/Textarea 是否因此无明显容器边界——若是，登记到 Wave P1。
- SessionCard（overview）与 SessionItem 现共用 tailwind.config 的 pulse keyframes（已收敛）。
- Composer steer 提交链路：Composer→useChat.steer→api/domains/chat.steer→transport `message.steer`→runtime（已存在）。

## 边界（不做）

- 不修任何代码（本 wave 只验证，发现问题登记给 Wave P1/P2）
- 不实现 DEFER 项（FileChanges/SideDrawer/搜索/状态机等）
- 不做视觉对比以外的功能测试
