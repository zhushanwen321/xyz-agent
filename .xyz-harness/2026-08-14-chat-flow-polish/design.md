# 对话流展示优化设计：思考中状态 / 动画 / v6 边框对齐

> **状态**：设计稿（未实现）。本文只做设计决策与参数，不写实现代码。
> **输入**：用户三个诉求——① 思考中状态展示（侧边栏、流末尾光标、活动 block）太单调；② 整体动画偏少；③ v6 demo 的边框细节（bash 块展开、drawer/mainpanel 交界）与当前实现有差距。
> **事实基础**：`packages/renderer` + `packages/ui` 当前实现侦查、v6 spec（`docs/page-design/v6-spec-*.html`）与 `.tmp/v6` demo 规格比对。关键出处见附录 A。

---

## 0. 结论（执行摘要）

三个诉求的答案不是「多加点动画」，而是**先兑现已设计未实现的，再谈新增**。当前最大的落差是：v6 spec 已经定义好的东西（块展开过渡、状态脉动、bash 容器扁平化、drawer 投影形态）实现没跟上，导致界面停在「旧骨架 + 静态状态」。

**P0（最高杠杆，4 项）**：

| # | 动作 | 一句话理由 |
|---|------|-----------|
| 1 | **活动 block 态**：running 块加 1px accent 左缘 rail + `accent-soft` 微染（启用 `Block.vue` 预留的 `blockClass` 钩子），完成时 200ms 淡出 | 「思考中太单调」的真正根因是**块级无活动态**——光标是唯一在动的东西。补上这一层，光标回归辅助位，单调感结构性消失 |
| 2 | **block 展开/收起过渡**：chevron rotate + body 高度+opacity，`var(--duration-fast)`(120ms) `var(--ease)` | spec §13 已定义但未实现，当前 v-if 瞬时切换是界面「生硬」的最大来源 |
| 3 | **bash 展开容器对齐 spec §5**：删 `border` + `bg-surface-2` 双分隔 → 无 border + `bg-input` + `rounded-sm` | spec 明确「双分隔已删」，当前是 v6 之前的旧样式；容器从「贴片」变「凹槽」，层级语言与输入区统一 |
| 4 | **侧边栏 running 脉动**：badge 竖条加 opacity 呼吸（复用 `pulse-dot` 2s），waiting 胶囊同节奏 warn 色 | `SessionItem.vue` 注释承诺「running 脉动小条」但从未实现（`.si-badge` 是死类），属于兑现承诺而非新增 |

**P1（3 项）**：drawer 开合补 `translateX` 位移（现名 `drawer-slide-right` 却只有 fade，名不副实）；drawer 投影从 1px resize handle 移到 drawer 容器自身（对齐 demo）；drawer 内部 tab 栏/footer 分隔线 `border`→`hairline`（0.07→0.05，对齐 demo）。

**P2（可选，2 项）**：等待首 token 阶段内容区三点等待动画（区分「等待/输出」两态）；TurnMeta `working-pulse` 呼吸点对齐 spec §13。

**明确不做**（详见 §2.3 拒绝清单）：打字机效果、消息块入场动画、光标改形态/流光、scroll-behavior smooth。这些是过度动画的典型陷阱，日常高频工具加它们只会更慢更烦。

---

## 1. 方向一：思考中状态展示升级

### 1.1 现状事实（侦查确认，未夸大）

| 位置 | 现状 | 问题 |
|------|------|------|
| 侧边栏 running badge | 静态 accent 竖条（9×3px）+ 耗时文本，**零动画**；模板注释写「running 脉动小条」但 `.si-badge` 类在全局无任何 CSS 定义（死类） | 承诺的脉动从未实现；waiting 是静态「…」胶囊 |
| 流末尾光标 | 7×14px accent 方块，`blink` 1s `step-end` 阶梯闪烁（Turn.vue:73） | 形态本身没问题（终端光标语义），问题在于它是**唯一在动的状态元素** |
| 活动 block | **不存在块级活动态**。`Block.vue` 的 `blockClass` computed 恒返回空串（注释：保留钩子以备块级视觉）；running 只体现在 header 双环 loader + accent 文字；thinking working 态无任何标识（折叠 60 字符预览） | 长 turn 多块时，用户扫视无法定位「现在跑到哪了」 |
| TurnMeta | streaming = Loader2 单环 spinner + accent label（与 demo 一致） | spec §13 定义的 `working-pulse`（工具执行期呼吸点）未实现 |

### 1.2 活动 block 态（本方向核心，P0）

**为什么这是根因**：用户的监控行为是「扫一眼回答三个问题：活着吗、在干嘛、跑偏没」（streaming-trace-window 设计的用户画像）。当前三处状态展示里，侧边栏和光标都只回答「活着吗」，没有元素回答「在干嘛」——running 块的 header loader 太小（13px），且 thinking 块完全没有。块级活动态是唯一能把「当前活动」提升到扫视可见层次的手段。且 streaming-trace-window（滚动收编，窗口内仅 ~6 块）落地后，窗口内活动块染色会让「跑到哪了」一眼可辨，两者互相放大价值。

**方案对比**：

| 方案 | 形态 | 取舍 |
|------|------|------|
| **A（推荐）** | running 块：左缘 1px accent rail（inset box-shadow 实现，不改布局）+ 整块 `accent-soft` 微染；完成时 background 200ms `var(--ease)` 淡出 | accent-soft 是 color-mix 10% 极浅灰染，符合太极纯灰克制风；rail 提供无彩色依赖的第二通道（色弱友好）。风险：与 bash 展开容器 `bg-input`、滚动收编行叠加——实现时染色只作用块根、容器背景压盖其上即可 |
| B | 只染 header 行背景，body 不染 | 更轻，但长输出块滚动后 header 早出视口，染色意义丢失；不满足「扫视定位」 |
| C | 不加块级态，保持现状（只 header loader） | 用户明确抱怨单调，不解决 |

spec sidebar §3 有「禁 >1px 彩色侧边条」——那是 sidebar 卡片的约束（防止列表彩虹），对话流内 1px rail 是 Linear/Claude 的通用模式，语义不同，不适用该禁令。

**thinking 块 working 态**：`docs/page-design/streaming-trace-window/design.md` 已完整设计 streaming 期 trace 的滚动收编（含「当前活动在场」G2 目标），thinking 实时展示归该设计管辖，本文不重复设计，仅要求活动块染色对 thinking 块同样生效。

### 1.3 流末尾光标：保留，不改形态

**裁决：光标本体不动。** 阶梯闪烁（1s step-end）是终端与编辑器光标的四十年惯例（VSCode、iTerm、每条 CLI），它传递的信息是「输出位置在这里」，编程工具用户零学习成本。改成平滑呼吸或流光，是用装饰换掉约定俗成的语义，且呼吸动画在余光扫视时辨识度反而低于硬闪烁（硬闪的「有/无」对比最强）。

「单调」的修复不落在光标上，而落在 §1.2——当活动块染色、TurnMeta spinner、侧边栏脉动组成层次后，光标回到辅助指示的位置，单调感自然消失。

**可选 P2 增强（有明确 purpose，非装饰）**：turn 开始、首 token 未到时，光标位置显示三点等待动画（dot-flashing，1.2s ease-in-out，三点依次 opacity 0.3→1）；首个 block 到达后切回竖条 blink。Purpose = **State indication**（区分「模型还没出声」与「正在输出」两个语义不同的状态，对应用户「是不是卡了」的真实焦虑）。TurnMeta 的 pending spinner 在 turn 顶部，内容区三点在流末尾，位置不冲突。不做也可，标 P2。

### 1.4 侧边栏 badge：兑现注释承诺的脉动（P0）

- **running 竖条**：加 opacity 呼吸——复用现有 `pulse-dot` keyframes（opacity 1↔0.4），2s ease-in-out infinite。不用 `pulse-accent`（那是 box-shadow 扩散环，为圆点设计，9×3 竖条上效果不成立）。
- **waiting 胶囊**：「…」文本同节奏呼吸（2s opacity 1↔0.4），色 `warn`——对齐 spec §13「SessionItem waiting = pulse-warn」的语义（warn 色+脉动表达「等你处理」），box-shadow 环对文本胶囊不成立，故取 opacity 呼吸。
- **顺手清理**：补 `.si-badge` 定义或删注释，消灭死类与「注释承诺-实现缺失」的脱节（这类脱节是后续维护者的地雷）。

### 1.5 TurnMeta：spinner 保留，working-pulse 列 P2

当前 Loader2 spinner + accent label 与 `.tmp/v6` demo 完全一致，不动。spec §13 的语义分层是 streaming（输出中）= 单环 spinner、working（纯工具执行，无文本流）= `working-pulse` 呼吸点（9px accent，opacity+box-shadow 1.4s）。对齐它需要 turn 状态机区分两态，收益边际，列 P2。

---

## 2. 方向二：动画机会清单

按 find-animation-opportunities 方法论，每个候选过四问闸门：**频率**（每天见几次）→ **目的**（必须是 Feedback / Spatial consistency / State indication / Preventing jarring change / Explanation / Delight 之一）→ **速度**（UI <300ms）→ **功能**（动效是否妨碍阅读/操作）。期望拒绝大多数候选。

### 2.1 通过闸门的（按杠杆排序，共 5+1 项）

| # | 位置 | 现状 | 目的 | 频率 | 参数（精确值） |
|---|------|------|------|------|----------------|
| 1 | block 展开/收起（`Block.vue` 全部可折叠块） | v-if 瞬时切换 | State indication | 偶尔（用户主动点） | chevron `transform: rotate` + body 高度 0→auto + opacity，**120ms `var(--ease)`**。高度不定用 `grid-template-rows: 0fr→1fr` trick，不用 max-height 魔法数；virtua 虚拟列表内注意高度变化触发重测 |
| 2 | drawer 开合（`DrawerPanel.vue`） | Transition 名叫 `drawer-slide-right` 实则只有 opacity fade | Spatial consistency（从右缘来、回右缘去） | 偶尔 | `translateX(16px→0)` + opacity，**320ms `var(--ease)`**；transform 不触发布局（drawer 是 SplitterPanel，禁止 width 动画引起 main reflow） |
| 3 | 活动块染色出现/消失（§1.2 配套） | —（新态） | Preventing jarring change（染色瞬现瞬消会跳） | 每次 turn | background **200ms `var(--ease)`** 过渡，只过渡 background/box-shadow |
| 4 | 侧边栏 running/waiting 脉动（§1.4） | 静态 | State indication | 常驻 | `pulse-dot` opacity 1↔0.4，**2s ease-in-out infinite**（复用现有 keyframes，不新增） |
| 5 | 系统/错误通知行入场 | `ForkNotice` 已有 `notice-in`；其余通知行（错误、compact 记录等）待查是否复用 | Preventing jarring change | 罕见~偶尔 | `notice-in` translateY(-4px)+淡入，**200ms `var(--ease)`**（复用现有 keyframes；动作是排查统一，非新建） |
| 6（P2 可选） | 等待首 token 三点动画（§1.3） | 无 | State indication（等待/输出两态） | 每次 turn 开头 | 三点依次 opacity 0.3→1，**1.2s ease-in-out infinite**，新增一个 keyframes（本设计唯一新增） |

**预算纪律**：全部复用现有 tokens（`--ease` cubic-bezier(0.4,0,0.2,1) + 120/200/320ms 三档），**不新增 easing、不新增 duration 档**；keyframes 现有 9 个，本设计最多 +1（第 6 项且为可选）。`prefers-reduced-motion` 已由 style.css 全局 @media 兜底，所有新增自动继承降级。

### 2.2 已存在且足够的（不动）

hover transition-colors、回到底部 fade、AskUserOverlay slide-up、drawer tab 内容 fade、reka 浮层过渡（style.css 全局）、TurnSummary hover actions 150ms。

### 2.3 拒绝清单（认真考虑过，明确不做）

| 候选 | 拒绝理由（闸门哪一问杀的） |
|------|---------------------------|
| 打字机 / 逐 token 平滑流式 | **功能 + 频率**：正文是用户要读的内容，为风格而动是装饰；且 pi 推送是 chunk 级，平滑化是假流畅，渲染成本高 |
| 消息块 / turn 入场动画（fade/slide/stagger） | **频率**：每次 turn 都发生（每天几十次）；streaming 时块持续插入，入场动画会反复闪烁，对话流永无宁日 |
| 光标改平滑呼吸 / 下划线 / 流光渐变 | 见 §1.3——硬闪烁是终端语义；流光**无目的**（纯装饰） |
| session 列表 / 文件树 hover 增强（位移、icon 动效） | **频率**：每天几十次；已有 transition-colors 足够 |
| 命令面板 / 快捷键唤起动画 | **频率**：键盘操作 100+/天，永不加动画（Raycast 无开合动画是最优解） |
| `scroll-behavior: smooth` | **频率+功能**：streaming 自动滚动是高频连续事件，smooth 会造成追滞后 |
| drawer tab 内容切换动画增强 | 已有 `drawer-content-fade`，够 |
| 侧边栏折叠/展开宽度动画之外的装饰 | 折叠是每天几十次的操作，现状已够快 |

### 2.4 裁决

这个界面**不缺动画数量，缺的是两个结构性空洞**：块级活动态（§1.2）和展开过渡（#1）。补上这两个 + drawer 位移后，界面就接近「对」了——之后再加任何动效都是负收益。最高杠杆单项 = **block 展开/收起过渡**（覆盖面最大：每个可折叠块、每次点击）。

---

## 3. 方向三：边框细节对齐 v6

### 3.1 差异清单（当前实现 vs spec/demo，均有出处）

| # | 位置 | 当前实现 | v6 spec/demo 目标 | 出处 |
|---|------|----------|-------------------|------|
| 1 | **bash 展开容器**（tool 链） | `border border-neutral-faint` + `bg-surface-2` + rounded（Block.vue:155-163） | **无 border** + `bg-input` + `rounded-sm`——spec 原话「双分隔（border+bg-surface-2）已删，向 BashOutputBlock 扁平风」 | v6-spec-blocks.html §5 |
| 2 | **drawer 投影挂载点** | `--shadow-drawer` 挂在 **1px 宽 resize handle** 上（PanelContainer.vue:71） | 挂在 **drawer 容器自身**（demo SideDrawer.vue：`box-shadow: var(--shadow-drawer)`） | .tmp/v6 demo vs 实现 |
| 3 | **drawer 内部分隔线** | tab 栏 `border-b border-border`、footer `border-t border-border`（0.07） | `hairline`（rgba(255,255,255,0.05)）——demo L1 栏 `border-bottom: 1px solid var(--hairline)` | demo SideDrawer.vue:115 |
| 4 | drawer/mainpanel 交界方式 | 无 border，弱投影分隔 | 同左（D2 一体化） | **已对齐，不动** |
| 5 | main panel 描边 | `border-border` + `shadow-1`+`shadow-2` + `rounded-[10px]` | 同左 | **已对齐，不动** |
| 6 | 非 bash 工具块展开体 | 无边框无背景 pl-4 | 同左（spec §6 同为扁平） | **已对齐，不动** |
| 7 | BashOutputBlock（composer 直执） | 无边框无底 px-2 py-1 | 同左（5A 不可折叠，扁平） | **已对齐，不动** |

用户感知的「v6 边框细节更好」，实质差异就是 #1-#3 三处（#4-#7 当前已是 v6 目标态）。

### 3.2 #1 bash 容器：从「贴片」到「凹槽」

- **改动**：删 `border border-neutral-faint`、`bg-surface-2` → `bg-input`（#17171a），保留 `rounded-sm`（6px）；命令行与输出区间的分隔线随容器重构保留为 1px `hairline` 弱分隔。
- **为什么对**：v6 的层级语言是「背景阶梯」——surface（#1f1f22，panel）→ bg-input（#17171a，凹陷区，输入框/代码区）。`bg-surface-2`（#27272a）比父级**浅**，视觉上容器像浮在对话流上的「贴片」，所以需要 border 描边来压住边界；`bg-input` 比父级**深**，容器自然凹陷，深度差本身就是边界，border 成为冗余。删 border 不是省装饰，是层级语言统一后的必然结果。
- **连带一致性**：tool 链 bash（5B）、BashOutputBlock（5A）、非 bash 工具块展开体三者从此同为「无 border 扁平容器」，消除当前三套展开样式的不一致。

### 3.3 #2 drawer 投影挂载点

1px 宽的 handle 投 `-12px 0 24px` 阴影，阴影发根只有 1px，视觉上是「一条细缝渗出的弱光」；demo 把同一阴影挂在 drawer 容器左缘，是「整个 drawer 浮在 main 之上」的层叠感——这正是 D2「层级代边框」想要的效果，也是用户感知到的「阴影感」差距来源。改动 = 阴影从 handle 移到 DrawerPanel 根（或保留 handle 交互样式、阴影移到容器）。

### 3.4 #3 hairline 语义统一

v6 的边框语义分两级：`--border`（0.07）用于**跨层级**分隔（panel 描边、卡片），`--hairline`（0.05）用于**同 surface 内部**的弱分隔（drawer 内 tab 栏/footer）。当前 drawer 内部用了跨层级档，偏重。改动 = DrawerPanel 的 tab 栏底边、status footer 顶边 `border-border` → `border-[color:var(--hairline)]`（或 Tailwind 配置补 hairline 色档）。同 surface 内的分隔线「应该几乎看不见，但没了又觉得脏」——0.05 就是这个甜点位。

### 3.5 超出本文范围的已知差距（登记，不展开）

spec §6 的 exit N / 未结束标签、failed 不切 AlertTriangle、copy 按钮内行布局均为 spec 标注的 **[待实现]** 项；streaming-trace-window 滚动收编有独立设计文档推进。这些与本次「边框细节」诉求无关，实现排期时另行立项。

---

## 4. 落地优先级与验收

| 优先级 | 项 | 主要改动文件 | 视觉验收检查点 |
|--------|----|--------------|----------------|
| P0-1 | 活动块态（rail+染色+淡出） | `packages/ui/src/features/chat/Block.vue`（blockClass） | streaming 中 running 块一眼可定位；块完成时染色 200ms 淡出不瞬跳；bash 展开容器区不被染色弄脏 |
| P0-2 | 展开/收起过渡 | `Block.vue` | 点击 tool/thinking 块展开有 120ms 高度+opacity 过渡，chevron 旋转同步；虚拟列表滚动不抖 |
| P0-3 | bash 容器扁平化 | `Block.vue`（isBashTool 分支） | 展开容器无 border、`bg-input` 凹陷感；与 5A/非 bash 块视觉同源 |
| P0-4 | 侧边栏脉动 + 死类清理 | `packages/renderer/src/components/sidebar/SessionItem.vue` | running 竖条 2s 呼吸；waiting「…」warn 色同步呼吸；`.si-badge` 死类消除 |
| P1-1 | drawer 开合 translateX | `packages/ui/src/features/drawer/DrawerPanel.vue` | 开合有 320ms 右缘滑入感；main panel 无 reflow 跳动 |
| P1-2 | drawer 投影挂载 + hairline | `DrawerPanel.vue`、`PanelContainer.vue` | drawer 左缘整体浮层阴影；tab 栏/footer 分隔线肉眼更弱但仍可辨 |
| P1-3 | 通知行 notice-in 排查统一 | 对话流各通知行组件 | 错误/系统通知入场统一 200ms，无瞬现 |
| P2 | 三点等待动画 / working-pulse | `Turn.vue`、`TurnMeta.vue` | 等待期与输出期两态可区分 |

**验收方式**：`pnpm dev` 后 Playwright 连 `http://localhost:9222` 截图对比（参照 v6-spec-blocks.html §5、v6-spec-drawer.html §1、v6-spec-content.html §13 的渲染帧），动画项录屏或逐帧截图确认时长/曲线。`prefers-reduced-motion` 开启时全部新增动画应自动降级。

---

## 附录 A：事实来源

- 当前实现侦查：`packages/ui/src/features/chat/`（Turn.vue:73 光标、Block.vue:140/155-163 loader 与 bash 容器、TurnMeta.vue:26 spinner）、`packages/renderer/src/components/sidebar/SessionItem.vue:62-70`（静态 badge + 死类 `.si-badge`）、`packages/renderer/src/components/workspace/PanelContainer.vue:71`（handle 投影）、`packages/renderer/src/style.css:377-404`（9 个 keyframes SSOT）、`tailwind.config.ts:99-110`（animation 注册）；无 motion 库（两包 package.json 确认）
- v6 spec：`v6-spec-blocks.html` §5（bash 容器扁平化「双分隔已删」）、§6（tool 状态矩阵）；`v6-spec-content.html` §13（动画三类 8 种状态指示 + 微交互 + 入场退场全表）；`v6-spec-drawer.html` §1（D2 一体化、shadow-drawer 0.16）；`v6-spec-sidebar.html` §3（7px 状态点、active 形态）
- demo：`.tmp/v6/src/components/drawer/SideDrawer.vue`（容器自身 box-shadow、L1 栏 hairline:115）、`.tmp/v6/src/components/chat/TurnMeta.vue`（streaming spinner 形态）
- 相关已有设计：`docs/page-design/streaming-trace-window/design.md`（trace 滚动收编，thinking 实时展示归其管辖）

## 附录 B：动效 token（全部沿用现有，本文零新增）

```css
--ease: cubic-bezier(0.4,0,0.2,1);
--duration-fast: 120ms;  --duration: 200ms;  --duration-slow: 320ms;
/* keyframes 复用：pulse-dot / pulse-accent / blink / spin / loader-spin / notice-in（style.css:377-404） */
/* 唯一候选新增：dot-flash（三点等待，P2 可选项） */
```
