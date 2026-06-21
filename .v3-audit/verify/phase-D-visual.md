# Phase D · 视觉验证报告（Wave V）

> 日期：2026-06-21
> 验证对象：Phase D 6 commit（`e2b386ea` token SSOT → `3a4a33e5` Composer steer）
> 方法：mock dev server（VITE_MOCK=true）+ CDP 协议截图 + minimax VLM 视觉对比 + 像素级 computed-style 核验
> 工作目录：`refactor-arch-render-runtime` worktree（Phase D commit 所在）
> 产出图：`/tmp/v3-verify/V{1,2,3,6}*.png`（10 张，未提交，仅本次验证用）

## 一、验证方法与可信度

三层验证交叉，避免单一手段误判：

| 层 | 手段 | 可信度 | 用途 |
|---|---|---|---|
| 1 代码层 | CDP `Runtime.evaluate` 读 class/computed style | 最高（精确值） | token 落地、class 存在性、颜色精确值 |
| 2 像素层 | CDP `getComputedStyle` 读实际渲染值 | 最高 | 消除 VLM 观感误判（如 S2 边框色） |
| 3 视觉层 | minimax VLM（mmx vision describe）分析截图 | 中（会误判颜色归属） | 整体观感、布局结构、可见性 |

**关键教训**：VLM 在 S2 边框色上误判（识别为蓝，实际中性白 12%）。所有颜色类结论必须用像素层复核，不能只信 VLM 观感。

## 二、验证环境

- Vite dev server `:1420`（strictPort，mock 模式跳过 runtime）
- Electron CDP `:9222`（`--remote-debugging-port`）
- 视口 `Emulation.setDeviceMetricsOverride` 1280×800 @2x
- mock fixture：5 session 覆盖 5 态（active/error/waiting/running/stopped）

## 三、逐项验证结论

### V1 SessionItem（sidebar）—— ⚠ 部分通过

| 子项 | 判定 | 证据 |
|---|---|---|
| DEC-01 inset ring（删左竖条） | ✅ | active class `ring-1 ring-inset ring-accent-ring`；minimax 确认"无左竖条，inset 风格淡蓝描边" |
| RC-09 布局修复（grid→flex） | ✅ | class `flex items-start gap-2`；minimax 确认 dot 独立列/title 单行/branch+time 次行同行 |
| 状态点颜色映射 | ✅ | running=蓝/done=绿/error=红，minimax 全部识别正确 |
| **active 项背景色** | **⚠ P1** | 实现 `bg-accent-soft`（rgba(79,142,247,0.12) 淡蓝）vs draft `surface-2`（#1b1b20 中性灰）。minimax 明确观察到"淡蓝色偏冷蓝调而非纯灰" |

**V1 待办**：active 背景 accent-soft vs surface-2 偏差，登记 Wave P1（见 §五 P1-1）。

### V2 Panel 四层激活（workspace）—— ✅ 通过

| 子项 | 判定 | 证据 |
|---|---|---|
| 左 2px accent 竖条 | ✅ | active section 内 `<div class="... w-[2px] bg-accent">`；minimax"右侧激活面板边缘亮蓝竖条 2-3px" |
| inset accent-ring 内描边 | ✅ | class `shadow-[inset_0_0_0_1px_var(--accent-ring)]`；minimax"精细淡蓝半透明内描边" |
| bg-elevated 微亮 | ✅ | class `bg-bg-elevated`（#1c1c20）；minimax"激活更亮、待机更暗" |
| standby opacity 0.5 | ✅ | class `opacity-50`；minimax"待机态明显变暗灰、明度下降" |
| 四层视觉可辨（主从焦点） | ✅ | minimax"四层视觉差异全部被识别，主从焦点一眼可辨" |

四层激活标识**全部视觉通过**，DEC-01 Panel 分支（保留四层）兑现。

### V3 Composer 三态（panel）—— ✅ 通过（S6 steer 兑现）

| 子项 | 判定 | 证据（像素核验） |
|---|---|---|
| S1 空态：bg-input 容器感 | ✅ | composer-box bg=`rgb(16,16,19)`=#101013=bg-input |
| S1 发送按钮 disabled | ✅ | title="输入内容后发送"，disabled |
| **S2 输入中：中性 ring（非蓝）** | ✅ | **像素核验**：border=`rgba(255,255,255,0.12)`，box-shadow=`rgba(255,255,255,0.04) 0 0 0 2px`——中性白，非蓝。draft 要求"普通聚焦不染 accent"兑现。（minimax 曾误判为蓝，像素核验推翻） |
| S2 发送按钮 enabled accent | ✅ | title="发送 · ⏎"，bg=accent |
| **S6 流式：steer 呼吸蓝 ring** | ✅ | class `border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)] animate-steer-breathe`；minimax"明显蓝色发光呼吸，视觉突出" |
| S6 steer-breathe keyframe 收敛 | ✅ | tailwind.config.ts：`0%,100%{box-shadow:0 0 0 3px rgba(79,142,247,0.22)}50%{0 0 0 4px 0.40}` 2.6s，与 draft 逐字一致；无 scoped CSS 残留 |
| S6 停止按钮替代发送 | ✅ | `<Button><Square>` title="停止"；minimax"方形停止按钮非箭头" |
| **DEC-03 S6 死胡同消除** | ✅ | ⏎ streaming 时触发 onSteer（非阻止）；placeholder="想补充什么？⏎ 加入当前任务 · Alt+⏎ 排到下一轮…"（消除"按停止中断"误导）；hint="⏎ 追加 steer · Alt+⏎ 新轮 followup · ⇧⏎ 换行" |
| S6 → complete 正确复位 | ✅ | 流式结束后 placeholder 回 S1，isStreaming=false（规则#3 防护有效） |
| **S1 placeholder 文案省略** | ⚠ P2 | 实现"描述你想让 AI 做什么…" vs draft"…或 @ 引用、# 文件、/ 命令…"。省略部分对应 G2-002 DEFER 的 @/#// 浮层，属合理 DEFER 配套（不诱导触发未实现功能） |

**V3 核心结论**：DEC-03 steer 长期方案**完整兑现**，S6 死胡同 UI 消除，steer 呼吸 ring 与中性 S2 ring 区分清晰（像素验证）。

### V4 Dialog（Settings/Search）—— ✅ 代码层通过（运行时不可触发）

| 子项 | 判定 | 证据 |
|---|---|---|
| DialogOverlay backdrop-blur | ✅ | DialogContent.vue：`bg-black/80 backdrop-blur-sm` |
| DialogContent bg-surface 浮起 | ✅ | `bg-surface ... sm:rounded-lg` |
| DialogClose open 态非蓝（RC-08） | ✅ | `data-[state=open]:bg-surface-hover data-[state=open]:text-muted-foreground` |
| SettingsModal/SearchModal 渲染 | ⚠ 无法视觉验证 | 入口 DEFERRED（⌘, / ⌘K / sidebar 按钮 v1 全 hide，G3-002），组件存在但无调用方渲染触发入口，CDP 无法运行时打开 |

**V4 说明**：Dialog 原语层（backdrop-blur/bg-surface/close 态）代码层确认正确。SettingsModal/SearchModal 因触发入口 DEFERRED 无法做运行时视觉验证，登记为"组件就绪、入口待 G-021 联调"。

### V5 Input/Textarea 原语 —— ✅ 代码层通过（运行时不可独立观察）

| 子项 | 判定 | 证据 |
|---|---|---|
| Input bg-surface-2 + inset accent ring + error | ✅ | Input.vue：`bg-surface-2 focus-visible:ring-1 ring-inset ring-accent-ring`，`error && 'border-danger'` |
| Textarea bg-surface-2 + inset ring + min-h-40 | ✅ | Textarea.vue：`bg-surface-2 focus-visible:ring-1 ring-inset ring-accent-ring min-h-[40px]`（DEC-02 40px） |
| P0 "Textarea 缺 focus ring"（W02）修复 | ✅ | ring 已存在 |
| 原语 bg-surface-2 运行时可视 | ⚠ 不可独立观察 | 唯一消费者 Composer 用 `bg-transparent` 覆盖（输入区透明，composer-box 提供容器感）——设计选择，非 bug |

### V6 Button variant + 整体观感 —— ✅ 观感通过 / ⚠ 工具区降级

| 子项 | 判定 | 证据 |
|---|---|---|
| 整体观感（冷蓝精致暗色） | ✅ | minimax"Linear/Cursor/Raycast 同梯队，无 AI slop，专业工具质感" |
| default variant（accent 实色） | ✅ | 发送按钮 bg=accent #4f8ef7 |
| secondary variant（transparent+border） | ✅ | Diff 按钮 minimax"深灰底细边框白字" |
| ghost hover 非蓝（RC-08） | ✅ | class `hover:bg-surface-hover`；代码层确认 |
| danger variant（text-danger） | ✅ | class `text-danger hover:bg-[rgba(239,68,68,0.12)]` |
| **Composer 工具区（上下文/模型/thinking）** | ⚠ 已知 DEFER | draft 为可点击 button（hover 浮 bg-hover，thinking max 紫底发光）；实现为纯文字 span（title="功能开发中"）。minimax"颜色暗淡像占位提示"。属 G-022 DEFER 配套（模型/thinking-level popover 未实现） |

### V7 AppShell 窗口圆角 —— ✅ 代码层通过

| 子项 | 判定 | 证据 |
|---|---|---|
| app-shell rounded-[10px]（W03 P0） | ✅ | computed `border-radius:10px`；minimax"窗口圆角约 12-16px" |
| mac 真实窗口外框圆角 | ⚠ 无法 CDP 截取 | CDP 截图只含渲染区不含窗口框；mac 窗口圆角由系统提供，app-shell 圆角作 win/linux 补救已应用 |

### V8 dropdown/tooltip 删除后渲染（RC-03）—— ✅ 通过

| 子项 | 判定 | 证据 |
|---|---|---|
| 页面健康渲染 | ✅ | app-shell/session(5)/panel/composer 全在；0 dropdown popover 残留 |
| 无运行时报错 | ✅ | CDP Log domain 2.5s 监听 0 error；dev.log 无 Vue warn / 组件解析失败 |
| dropdown-menu 14 子组件零影响 | ✅ | 四次验证（W01+W02+W07+W16）+ 本次运行时确认闭合 |

## 四、Phase D 6 commit 兑现度

| commit | 验证点 | 兑现 |
|---|---|---|
| `e2b386ea` token SSOT | --surface-2/--bg-elevated/--bg-input 落地 + data-theme 槽位 + steer-breathe keyframe 收敛 | ✅ 全部像素确认 |
| `39eee5da` 删 24 零引用组件 | dropdown/tooltip 删除后无破坏 | ✅ V8 |
| `373f33d6` UI 原子对齐 | Input/Textarea bg-surface-2+inset ring+error；button 4 variant；Dialog blur+bg-surface | ✅ V5/V6/V4 |
| `c5723efa` settingsStore 骨架 | theme/language/colorTheme + setTheme 应用 data-theme | ✅ store 存在（运行时 data-theme 无显式值，暗色为 :root 默认，ADR-0021-B） |
| `462e878e` Shell/Sidebar/Panel | SessionItem flex+inset ring；AppShell rounded-10；Panel bg-elevated 四层；三 zone bg-input | ✅ V1/V2/V7 |
| `3a4a33e5` Composer steer/followUp | DEC-03 steer ⏎ 提交 + accent ring + placeholder 对齐 | ✅ V3-S6 完整兑现 |

**Phase D 整体：6/6 commit 视觉兑现，无回归。** tsc+lint 通过的基础上，运行时视觉验证确认改动符合设计稿，3 条裁决（DEC-01/02/03）全部落地正确。

## 五、发现的偏差（需 Wave P1/P2 登记）

### P1（建议修）

**P1-1 · SessionItem active 背景色与 draft SSOT 不符**
- 现状：实现 `bg-accent-soft`（rgba(79,142,247,0.12) 淡蓝）
- draft：`background:var(--surface-2)` = #1b1b20（中性灰），draft-session-item.html §4 裁决明文
- 视觉影响：active 项偏蓝，与 inset accent-ring（也偏蓝）叠加，蓝调偏重；draft 意图是"中性灰底 + 蓝色 ring"层次对比
- 决策点：(a) 改实现 `bg-accent-soft`→`bg-surface-2` 对齐 SSOT；或 (b) 更新 draft 接受 accent-soft（若产品认为淡蓝更醒目）
- 注意：`--surface-2`(#1b1b20) 与 `--surface-hover`(#1b1b20) 当前同值，若选 (a)，active 用 surface-2 会与 hover 态视觉重合，需同步区分两 token

### P2（登记备查，多数属合理 DEFER 配套）

**P2-1 · Composer S1 placeholder 文案省略**
- 实现"描述你想让 AI 做什么…" vs draft"…或 @ 引用、# 文件、/ 命令…"
- 省略部分对应 G2-002 DEFER 的 @/#// 浮层功能，属合理省略（不诱导触发未实现功能）
- G2-002 实现后补回尾部文案

**P2-2 · Composer 工具区 span vs draft button**
- draft 将上下文/模型/thinking 设计为可点击 button（hover 浮 bg-hover，thinking max 紫底发光）
- 实现为纯文字 span（title="功能开发中"），minimax 观感"像占位提示"
- 属 G-022 DEFER 配套（模型/thinking-level popover 未实现），登记待 G-022 联调时改回 button + 染色

**P2-3 · --surface-2 与 --surface-hover 同值（#1b1b20）**
- handoff 已知项。影响：Input/Textarea 容器在非 focus 态边界不明显；若 P1-1 选(a)，active 与 hover 视觉重合
- 建议在 Wave P1 统一区分两 token 取值

**P2-4 · SettingsModal/SearchModal 运行时不可视觉验证**
- 入口 DEFERRED（G3-002），组件就绪但无触发路径
- 待 G-021 联调阶段补运行时视觉验证

**P2-5 · Input/Textarea 原语 bg-surface-2 运行时不可独立观察**
- 唯一消费者 Composer 覆盖 bg-transparent（设计选择）
- 原语正确性已代码层确认，待出现独立 Input 消费者（如 Settings 表单）时补视觉验证

## 六、无法验证项（边界外）

- mac 真实窗口外框圆角（CDP 不截窗口框，需系统级截图工具）
- hover 态视觉（minimax 无法触发 hover，CDP dispatchMouseEvent 可触发但本次未对每个 hover 态逐一截图）
- 亮色主题（data-theme=light，settingsStore 骨架存在但无切换入口，ADR-0021-B 暗色为真默认）

## 七、结论

Phase D 视觉验证**通过**。6 个 commit 的实际渲染符合 v3 设计稿，3 条裁决（DEC-01 SessionItem inset ring / DEC-02 Composer 40px / DEC-03 steer 长期方案）全部正确落地，无回归。

发现 1 个 P1 偏差（SessionItem active 背景色）+ 5 个 P2（多为合理 DEFER 配套）。建议 Wave P1 处理 P1-1 + P2-3（token 取值统一），其余 P2 随对应功能（G2-002/G-022/G-021）落地时消化。

**验证方法学收获**：VLM（minimax）视觉分析适合整体观感/布局/可见性判断，但颜色精确值会误判（S2 边框色误判为蓝）；所有颜色类结论必须用 CDP `getComputedStyle` 像素核验兜底。后续视觉验证 wave 应维持"代码层 + 像素层 + VLM 层"三层交叉。
