---
target: 对话流 message-stream + workspace 整体样式
total_score: 26
p0_count: 0
p1_count: 2
timestamp: 2026-07-15T13-15-04Z
slug: kages-renderer-src-components-panel-message-stream
---
# Critique: 对话流 message-stream + workspace 整体样式

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | turn-meta sticky 贴顶遮挡（单 panel 透明继承，--panel-bg 兜底但边界 case 风险） |
| 2 | Match System / Real World | 3 | 开发者术语对齐（cwd/branch/jsonl），breadcrumb 两段克制 |
| 3 | User Control and Freedom | 2 | hover-only 操作（复制/fork/edit）键盘 Tab 不可达，无 undo |
| 4 | Consistency and Standards | 2 | 字号 6 档无节奏（10/11/11.5/12/12.5/13.5）；soft 色 3 种表达并行；amber-500 脱离 token 体系 |
| 5 | Error Prevention | 3 | 删除两段确认、compact 互斥、fork modal；abort 无确认（延续 sidebar P1） |
| 6 | Recognition Rather Than Recall | 2 | icon-only badge/think-tool count 靠 hover title；hover-only 操作不可见 |
| 7 | Flexibility and Efficiency | 3 | ⌘N/⌘K/⌘B + 输入历史导航齐全；对话流内无快捷键（复制/fork 无 hotkey） |
| 8 | Aesthetic and Minimalist Design | 3 | 克制无 slop（无渐变文字/玻璃拟态/侧色条）；字号碎片化破坏节奏感 |
| 9 | Error Recovery | 3 | 错误插消息流 + 草稿恢复 + dead session 重开 |
| 10 | Help and Documentation | 2 | slash chip 可点开 drawer 查文档（亮点），但空态/术语无 inline 教学 |
| **Total** | | **26/40** | **Acceptable — 打磨层有系统性收益** |

## Anti-Patterns Verdict

**LLM 评估**: 非 AI slop。配色严格走 CSS 变量 SSOT（style.css + design-tokens.md），无渐变文字、无玻璃拟态卡片、无侧色条、无 big-number hero。冷蓝暗色方向准确，信息密度匹配目标受众（后端开发者，6h/天）。组件词汇一致（xyz-ui Button 统一）。这是合格的生产级产品 UI，问题不在"乱"，在"节奏失序"。

**确定性扫描**: detector 对 Vue SFC markup 扫描返回空（detector 主要针对 HTML 文件）。手动代码审查补充。

## Overall Impression

骨架扎实，设计系统有 SSOT 且大部分落地。最大的系统性机会是**排版节奏**：对话流一个屏幕内出现 6 档字号，其中 11/11.5/12/12.5px 四档肉眼几乎不可辨，导致"明明很克制却显得碎"。第二大机会是 **soft 色无统一 token**——同一个"淡色背景"语义散落着 color-mix、rgba 硬编码、tailwind alpha slash 三种表达，且透明度数值 6%/10%/12%/15%/18% 各不相同。这两项是"小改动大收益"的系统性优化。

## What's Working

1. **turn-meta 折叠编排**（Turn.vue）— 已工作 Xs + chevron + think/tool badge 的单行 meta，点击展开 trace，收尾 summary 恒显。信息架构清晰，折叠态一行概览、展开按时序看过程。这是对话流的核心节奏，做得好。

2. **thinking variant 降级排版**（MarkdownRenderer.vue）— thinking 块的 markdown 标题用 --reasoning 紫、marker/blockquote 压到 --subtle、strong 回升 --fg 提供强调层级。同一个 MarkdownRenderer 组件用 variant prop 区分正文与过程信息，设计意图明确（次要信息降级但不丢结构）。

3. **ChangeSetCard 状态机**（ChangeSetCard.vue）— 5 态状态机（accumulating→ready→partially-reviewed→resolved→superseded），折叠卡 header 计数 + 行数汇总（+N/-N 绿红），展开文件清单点击进 drawer 看 diff。把 git 变更集从对话流底部独立成可操作卡，信息分层到位。

## Priority Issues

### [P1] 字号 scale 失序：6 档无节奏，4 档肉眼不可辨

对话流一个 turn 内出现的字号：10px（badge/thinking header/tool header）· 11px（metaItems/subagent progress）· 11.5px（system notice/bg-notify）· 12px（thinking body/tool result/change-set header）· 12.5px（turn-meta/text block/session label/dir）· 13.5px（user bubble/summary）。

问题在于 11 / 11.5 / 12 / 12.5px 这四档，相邻差异 0.5px，在 15px 根字号下比例差 < 4%，肉眼无法区分层级。product register typography 原则要求 step 间 ≥1.125 比例（~12.5%）。当前的字号不是在表达层级，而是在制造噪声——开发者扫一眼对话流，无法通过字号快速定位"这是 meta 还是正文还是过程"。

**Why it matters**: PRODUCT.md 第 4 原则"长时间使用不疲劳"。字号失序增加视觉扫描成本，6 小时使用后疲劳感来源之一就是"每个元素字号都微妙不同但说不出区别"。也违背 Heuristic 8（Aesthetic/Minimalist）。

**Fix**: 收敛到 3 档语义字号 + 1 档 micro：
- 正文（user/summary）：13.5px（保留）
- 次要过程（thinking body/tool result/text block/meta/change-set body）：统一 12px
- meta 标签（turn-meta elapsed/badge label/session label/dir）：统一 12px 但用 font-weight/颜色区分而非字号
- micro（badge 数字/header uppercase label/count）：11px（单一 micro 档）
- 删除 11.5px 和 12.5px 两档（并入相邻）

**Suggested command**: `/impeccable typeset`

### [P1] soft 色无统一 token：3 种表达并行 + 透明度魔法值散落

同一个"状态色淡背景"语义，代码里有三种实现：
- `--accent-soft: rgba(79,142,247,0.12)` / `--reasoning-soft: color-mix(...)`（design-tokens 有 token）
- `bg-[color-mix(in_oklch,var(--danger)_6%,transparent)]`（Block.vue 失败态，手搓 6%）
- `bg-info/10` · `bg-success/10` · `bg-danger/10` · `bg-accent-soft`（ChangeSetCard，tailwind slash 10%）
- `bg-[rgba(79,142,247,0.25)]` · `bg-[rgba(239,68,68,0.15)]`（Composer boxClass/shadow，硬编码 rgba）
- `bg-[rgba(56,189,248,0.12)]` · `bg-[rgba(167,139,250,0.12)]`（Turn.vue badge，硬编码 rgba）

透明度数值：6% / 10% / 12% / 15% / 18% / 25% / 30% / 40%——8 个不同透明度表达"淡背景/软填充"。--accent-soft 是 12%，但 Composer 的 focus shadow 用 25%，badge 用 12% 但硬编码 rgba 而非 token。

**Why it matters**: 同语义多表达 = 维护时无法一处改全。新增状态色（如未来 warning soft）会继续手搓。且硬编码 rgba（`rgba(79,142,247,...)`）在 palette 切换时（data-theme-preset 覆盖 --accent）不会跟随，导致切配色后 soft 色与主色脱节。这直接违背 design-tokens.md 自己的设计原则（"--accent-soft 用 color-mix 派生跟随主题"），但只有 accent/reasoning 做到了，info/success/danger 没做。

**Fix**（长期方案）: 在 design-tokens 补 `--success-soft` / `--info-soft` / `--danger-soft` / `--warning-soft`，全部用 `color-mix(in oklch, var(--xxx) 12%, transparent)` 派生（对齐 --accent-soft 12% 基准）。组件里所有 `bg-info/10` / `bg-[rgba(...)]` / `bg-[color-mix(...)]` 替换为对应 `bg-[var(--xxx-soft)]`。硬编码 rgba 全部消除。

**Suggested command**: `/impeccable polish`

### [P2] hover-only 操作按钮：对话流复制/fork/edit 键盘不可达

Turn.vue L77 / L193：user 气泡和 summary 的复制/编辑/fork 按钮 `opacity-0 group-hover:opacity-100`。键盘 Tab 无法聚焦到 opacity:0 的按钮（部分浏览器可聚焦但视觉不可见，无 focus 指示）。这与上次 sidebar critique 的 P1（WorkflowList hover-only abort）是同一类问题的延续。

**Why it matters**: Alex（Power User）persona 用键盘导航，hover-only 把核心操作（复制对话、fork 会话）藏起来。也违背 Heuristic 6（Recognition）和 a11y。

**Fix**: 改为 `opacity-0 group-hover:opacity-100 focus-within:opacity-100 focus-visible:opacity-100`，或用 `transition-opacity` + `:focus-within` 让容器内任一元素聚焦时整组可见。更彻底的方案：操作按钮常驻但 `text-subtle` 低存在感，hover 回升 `text-fg`（不靠 opacity 显隐）。

**Suggested command**: `/impeccable polish`

### [P2] amber-500 硬编码脱离 token 体系（ChangeSetCard）

ChangeSetCard.vue L99 `bg-amber-500/10 text-amber-500`（partially-reviewed 状态）。design-tokens 有 `--warning: #f5a524`，但 partially-reviewed 用了 Tailwind 调色板的 amber-500（#f59e0b），两者色相相近但不是同一个色，且 amber-500 不走 CSS 变量，palette 切换时不跟随。

**Why it matters**: 状态色应全部走 token 体系。partially-reviewed 语义上就是 warning（部分审查=需注意），用 amber-500 而非 --warning 是语义断裂。lint 规则 `no-hardcoded-colors` 应该拦这个（amber-500 是 Tailwind 调色板色非语义类），需确认是否漏检。

**Fix**: `bg-amber-500/10 text-amber-500` → `bg-warning/10 text-warning`（warning 对应 --warning #f5a524）。

**Suggested command**: `/impeccable polish`

### [P3] Panel standby opacity-50 影响可读性（延续未修）

Panel.vue L380：双 panel standby 态 `opacity-50`。整个对话流文字变淡。上次 critique（2026-07-09 P3）已提，仍未修。

**Why it matters**: standby 的语义是"退后/非焦点"，不是"内容变次要"。用户可能想在 standby panel 里阅读历史对话，opacity-50 强制降可读性。违背 PRODUCT.md 第 4 原则。

**Fix**: standby 只降 header/border 存在感（border 色变淡、header opacity-60），对话流正文保持 100% 可读。或用 `opacity-70`（轻微提示非焦点但不影响阅读）+ hover 回升。

**Suggested command**: `/impeccable polish`

## Persona Red Flags

**Alex (Power User)**: 对话流复制/fork 按钮 hover-only，键盘 Tab 不可达；复制对话无 ⌘C hotkey（必须 hover 点按钮）；fork 无快捷键；turn 折叠/展开只能鼠标点 chevron，无键盘。6 小时高强度使用下，每次复制都要 mouseover 是摩擦。

**Jordan (First-Timer)**: think/tool badge（"3 思考"/"5 工具"）点击行为不明确（展开 trace？跳转？），无 inline 提示；tool call 的 `read · src/App.vue` 摘要行，`·` 分隔符对非开发者不直观；ChangeSetCard 的 A/M/D badge 无 legend；streaming 光标 w-[7px] 偏粗，首次见会误认为选中态。

**Sam (Accessibility)**: hover-only 操作无键盘替代；icon-only button 靠原生 title（2s 延迟、不可样式）；streaming 动画（animate-blink / animate-spin / animate-working-pulse）未确认是否全部有 prefers-reduced-motion 兜底（style.css 未见全局 reduced-motion 块）。

## Minor Observations

- Turn.vue pending 气泡 `px-[13px] py-[9px]`：13px/9px 是魔法数（非标准 Tailwind scale，不对齐 4px 栅格），且 user 正常气泡同此值。应收敛到 `px-3 py-2`（12px/8px）。
- Block.vue 失败态 `bg-[color-mix(in_oklch,var(--danger)_6%,transparent)]` 6% 偏淡，在暗色 bg 上几乎不可见（对比 ChangeSetCard 的 danger/10 更合理）。
- Composer 发送按钮 disabled 态 `disabled:bg-transparent disabled:text-subtle`：透明背景+灰字，在 composer-box 内几乎"消失"，disabled 边界不清。
- SessionItem hover 操作按钮 `bottom-1 right-1.5` 盖在 dirName 上（注释说"不遮时间"，但遮了目录名）。
- Sidebar brand 用户头像 `bg-gradient-to-br from-accent to-info`：渐变小色块可接受，但 PRODUCT.md anti-reference 提"拒绝渐变"，此处是用户身份标识，渐变纯装饰。

## Questions to Consider

- 字号能否收敛到 3 档语义（正文/次要/micro）？当前 6 档的区分意图是什么，能否用 font-weight + 颜色替代字号差异？
- soft 色是否值得一次性补全 token（--info-soft/--success-soft/--danger-soft/--warning-soft）？这是"一次投入永久受益"的长期方案。
- hover-only 操作能否改为"常驻低存在感 + hover 回升"？复制是高频操作，藏起来反直觉。
- prefers-reduced-motion 是否有全局兜底？streaming/blink/pulse 三类动画在减少动效偏好下应如何降级？
