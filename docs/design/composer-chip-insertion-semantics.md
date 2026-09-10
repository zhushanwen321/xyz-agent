# composer chip 插入语义统一（就地插入 + 键盘选中双触发修复）

> **一句话结论**：浮层键盘选中（Enter/Tab）后 chip 落错位置、选中即发送、skill 从行首命令浮层选中走老通路，三个问题的共同根因是**插入位置权威源三轨分裂 + 键盘事件 capture/bubble 双触发**；本设计把插入位置收敛为「编辑器内活选区优先、savedRange 仅作 blur 回退」，用 `stopPropagation` 根修双触发，把行首浮层的 skill 项改走 skill chip 通路，命令 chip 改为「视觉就地 + 序列化归位」——pi 行首命令协议零改动。

**层声明**：本文档是技术方案层设计——下一层产物是「可实现的接口/数据模型/代码任务」（P1-P4 实施单元）。涉及运行时行为与数据流，准则 5/6/7（探针/物理数据流/错误恢复）全适用。

**行号与轮次口径（design-code-sync 轮 3 补；轮 3 第 4 轮升级为规则；轮 3 收尾校正为与实情一致）**：**本文保留的绝对 `file:line` 均为设计时点（基线 `135c1dbab`）坐标**，仅三类例外——① 变更历史条目内的行号为其修订时点坐标；② 显式标注「提交时点」者（当前 0 处）；③ 显式标注「HEAD」者（当前 1 处：§3.3 D1 调用点清单的「HEAD 为七处 `:91/147/173/202/232/253/281`」，其语义即提交时点坐标）。已就地标注「设计时点」者：§2.2 标题、§2.4 标题、§3.3 D1 收口范围 bullet，以及 D1 调用点清单与 `contenteditable.ts:278`。**凡本设计改动涉及的位置一律用「符号 + 文件」引用**（函数名 / 常量名 / `describe` 文本），不写绝对行号——这是避免每轮重复产生行号漂移 finding 的长期口径；不逐轮追平行号漂移（历史漂移示例：`chip-commands.ts` 76→86、`contenteditable.ts` 240→242 / 278→279 / 379→367、`send.ts` 154→155 / 165→171 / 296→308 / 306→318、`CommandPopover.vue` 357→347；语义未变）。另：本文「rN」= 设计评审轮（r1/r2/r3），「轮 N」= design-code-sync 代码-文档同步轮（轮 1/轮 2/轮 3）——两者独立计数。

---

## 1. 背景目标

### SCQA

- **S（情境）**：composer 四符号体系（`$` 文件 / `#` session / `@` subagent / `/` 命令）+ multi-skill 注入（PR #199）落地后，任意位置（行中空白后）可呼出浮层，skill chip 已支持任意位置插入、多个共存。
- **C（冲突）**：用户实测发现——任意位置呼出浮层后，**键盘选中**（Enter/Tab）的 chip 落到「上次鼠标交互位置」（通常输入框头部）而非呼出位置；更糟的是 Enter 选中会**立即把草稿发送出去**；且同一个 skill 从行首 `/` 命令浮层选中时走的是老通路（强制最前、误删已有 chip、丢 location），与 multi-skill 建立的「就地、多共存」模型不一致。
- **Q（问题）**：为什么「任意位置呼出」没有兑现「任意位置插入」？skill 的两条插入入口为什么行为分裂？
- **A（答案）**：插入位置的判定分裂在三轨（编辑器内活选区 / stale 的 savedRange / slash 固定最前），而键盘选中路径恰好踩中 stale 轨；浮层键盘路由的 window capture 监听与输入框 keydown 冒泡对同一 Enter 事件双触发（选中 + 发送）；行首浮层的 skill 项按「入口」而非「项类型」路由到 slash 通路。本设计逐一根修，不改 pi 协议。

### 系统是什么（受众补足）

composer 是 xyz-agent 桌面端的输入区：一个 contenteditable 富文本框，用户可以打字、粘贴图片，也可以用触发符号呼出候选浮层——选中后插入**内联 chip**（不可编辑的徽章节点，如 `[file.css]`、`[某会话]`、`[code-review-graph✦]`）。发送时 DOM 被解析为 `Segment[]`（结构化段），再序列化为纯文本 prompt 发给 pi 子进程。pi 对**以 `/` 开头**的消息有特殊路由（命令），这是后文多处约束的来源。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者体验表述 |
|---|---|---|
| G1 | 键盘选中就地插入 | 在草稿任意位置输入 `#`/`@`/`$`/行中 `/` 呼出浮层，按 Enter 或 Tab 选中，chip 落在呼出位置——与鼠标点击选中行为完全一致 |
| G2 | 选中不误发送 | 浮层**打开（`open`）时按 Enter 是「选中候选」，绝不触发消息发送**；Tab/Enter 语义等同；浮层未打开时 Enter 正常发送。消费条件 = 浮层 `open`（**轮 4 取代**轮 3 第 4 轮 RC-A-1 的「实际可见才消费」，决策因果见 §3.3 D2）——前提是**每个 open 态都有可见渲染**，不存在「open 但不可见」的状态类。逐态可见性（轮 4 更新）：① 非空候选五路（slash/session/subagent/skill/`$` file——file 候选非空指 panel 态已加载 cwd 候选或 landing 拉取成功且有文件）⇒ 列表渲染、消费；② slash/session/subagent/skill 空候选、landing `@` 无 sessionId（`buildSubagentCandidates` 无 sessionId 时返回 `[]`）、landing `$` 无 cwd、landing `$` 候选源非空但 query 无匹配（`fileNoResultsVisible` 要求候选源为空）⇒ **「无匹配项」行**、消费；③ landing `$` 有 cwd 但候选未到（`cwdFileStatus === 'idle'`——open 边沿把状态复位为 idle 后**本次 open 不发请求**：无 cwd 直接返回，或 1s 节流命中跳过；节流命中时上一轮 open 的在途回执到达即写回 success/error）⇒ **「加载中」行**、消费；④ landing `$` 错误态 ⇒ 加载失败行（可点重试）、消费；⑤ landing `$` 空结果态（拉取成功且目录无文件）⇒ 无结果行、消费。**行为变化（轮 4 显式登记，取代轮 3 第 5 轮的「已接受代价」）**：②③ 两类的 Enter 从「放行 ⇒ 发送含触发符字面量的消息（landing 首发还会创建 session）」变为「被消费 ⇒ 不发送」；方向是**修正而非回归**——这批状态此前什么都不渲染（用户既看不出处于什么态、也没有任何反馈，这正是 RC-A-1 当初否决「open 即消费」的理由），现在每个态都有可见行，且 `Escape` 仍是显式关闭入口（关闭后 Enter 正常发送） |
| G3 | skill 两入口统一 | 同一个 skill 无论从行首 `/` 浮层还是行中空格后 `/` 浮层选中，都产 skill chip：插在光标处、多个共存、携带 SKILL.md 路径、不删已有 chip |
| G4 | 命令 chip 视觉就地 | 行首 `/` 浮层选中命令项，chip 插在光标处（不再强制跳到全文最前）；发送时命令自动归位到消息最前生效——pi 协议零改动 |
| G5 | 零回归 | 鼠标点击路径行为不变；手打 `/skill:xxx` 等纯文本行为零变化；发送后消息文本与现状等价 |

### In / Out of scope

**In**：五类 inline chip（file/session/subagent/skill/image）与命令 chip 的插入位置判定；浮层键盘事件路由；行首浮层 skill 项的通路切换；`Segment` 数据模型扩展（slash 段）；发送链路命令判定的真源迁移。

**Out**：
- pi 协议任何变更（行首命令模型、`_expandSkillCommand`、extension command 路由）
- 一条消息多命令支持（pi 命令模型 = 消息级单命令，本设计维持「命令 chip 唯一、替换语义」）
- 浮层 UI / 过滤 / 排序 / 触发正则（四符号触发域 D1/D5 决策不变）
- `hasChip` 触发抑制的放开（multi-skill D2 明确保留「存在任何 chip 时行首 `/` 不触发」——本设计维持，见 §3.3 D5）
- bash 模式（`!`/`!!` 前缀）行为
- 草稿持久化机制（drafts 存纯文本的现状不变；**该路径的真实行为变化 = 恢复后 `/cmd` 命令会被执行**——此前因缺边界空格、首 token 非法而按字面文本发送，见 §3.3 D6 边界声明，列为已接受的行为变化）

---

## 2. 现状与问题分析

### 2.1 使用者视角现状：三条浮层入口 × 两套插入行为

| 入口 | 触发 | 浮层 type | 选中后通路 | 插入行为 |
|---|---|---|---|---|
| 行首 `/` 命令浮层 | 光标所在行行首 `/`（多行任意行行首，D5 放宽） | `'slash'` | `clearSlashQueryText` → `insertSlashChip` | **强制全文最前** + 先删光所有 `.slash-chip`（含 skill chip！）+ 无 location |
| 行中空白后 `/` skill-only 浮层 | `(?:空格+非换行)/query`（multi-skill D1） | `'skill'` | `clearSkillQueryText` → `insertSkillChip` | 光标处 + 多个共存 + 带 location（multi-skill 模型） |
| `$`/`#`/`@` 浮层 | `(?:行首\|空格)符号+query` | `'file'`/`'session'`/`'subagent'` | `clearXxxQueryText` → `insertXxxChip` | 光标处（`insertChipAtSelection`） |
| SearchModal ⌘K（skill 的第三入口，轮 3 补；**轮 4 已合流**） | 全局搜索选择 → `commandStore.pendingSlash`（`isSkill`/`location` 经 `SearchItem` 透传）→ `useCommandPopoverTrigger.ts` 的 `watch(() => commandStore.pendingSlash, …)` → 按 `isSkill` 分流：skill 项 `insertSkillChip(bareSkillCommandName(command), location, icon)`，其余 `insertSlashChip(command, icon)` | ——（不经浮层） | `insertSlashChip` / `insertSkillChip` | **与第 1/2 行一致**：skill 项产 skill chip（`chipType='skill'` + `dataset.chipLocation` + 多 chip 共存 + 计入已选 skill）；命令项维持命令 chip（就地 + 单命令替换语义）。字段链：`SessionCommand.kind === 'skill'` → `SearchItem.isSkill` → `PendingSlash.isSkill`；location 走 `SessionCommand.sourceInfo.path` → `SearchItem.location` → `PendingSlash.location`（UI 层 `SearchModal.confirmSel` 显式搬运，漏搬会静默退回命令通路）——见 §3.3 D3 |
| `+` 菜单「命令」入口（轮 3 补） | 菜单项选择 → `useCommandPopoverTrigger.ts` 的 `onAddSelect('slash')`（`saveSelection()` + `cmdType='slash'` + `cmdOpen=true`）→ **打开行首 slash 浮层**（与第 1 行同通路） | `'slash'` | `clearSlashQueryText` → 命令项 `insertSlashChip`；skill 项（`isSkill`）经 D3 分流 `insertSkillChip` | 与第 1 行完全一致（同一浮层通路的第二触发路径）：命令项就地 + 单命令替换语义；skill 项光标处 + 多共存 + 带 location + **已选禁选生效**（S-2 后 slash 路消费 `selectedSkillNames`） |

回答本次设计的直接疑问「**multi-skill 不就是 slash command 插入吗？还有别的入口吗？**」：**有两条浮层入口**（行首 `/` 命令浮层——`+` 菜单「命令」是其第二触发路径；行中 `/` skill 浮层），加上不经浮层的 SearchModal ⌘K 共**三条 skill 入径**；本设计只覆盖两条浮层入口。multi-skill PR 只新建了第二条（skill-only 浮层 → `insertSkillChip`）；第一条（行首命令浮层混列的 skill 项，name 形如 `/skill:code-review-graph`）仍走 `insertSlashChip` 老通路。**`+` 菜单「命令」入口触发的正是这同一条行首浮层通路**（`onAddSelect('slash')` 打开行首 slash 浮层，命令项/skill 项随之按同一分派）——它并非独立通路，行为已随 D3/S-2 与第一条合流。**三条入径现已全部合流（轮 4）**：SearchModal ⌘K 的 skill 项经与 D3 同构的「按项类型」分流落 skill chip（字段链见 §2.1 第 4 行与 §3.3 D3）。数据层三条入径都产 skill segment（`visitSlashChip` 读 `dataset.chipType==='skill'`），`chipType='slash'` 只出现在命令项——不再存在「同一语义实体两套插入行为」的入口。

### 2.2 真实失败模式（全部已在 dev app 实测复现，Playwright + CDP；本节 `file:line` 为设计时点坐标，基线 `135c1dbab`）

**失败模式 A：键盘选中 chip 落到 stale savedRange（用户报告的「跳到头部」）**

实测序列（feat-composer-badge-position @ 0.9.15）：

1. 用户点击空输入框（`mouseup` → `saveSelection` 存下 range = 头部 offset 0）；
2. 打字 `AAA BBB CCC #`——光标随打字前进到末尾，但 **savedRange 不随打字更新**（`saveSelection` 仅在 `mouseup`/`blur` 触发，`ComposerInput.vue:29` + `contenteditable.ts:270`）；
3. `#` 触发 session 浮层，按 **Tab** 选中第一项；
4. `onCmdSelect` → `clearSessionQueryText()` 用**活光标**正确删掉 `#` → `insertSessionChip` → `restoreSelection()` **无条件用 stale savedRange（头部）覆盖活光标**（`contenteditable.ts:278`）→ chip 落在头部。

实测产物：`"[会话chip]× AAA BBB CCC "`（chip 在头部）——与用户报告完全一致。鼠标点击浮层项时 `blur` → `saveSelection` 恰好把 savedRange 刷新为当前光标，所以点击路径「侥幸正确」——正确性依赖巧合而非机制。

**失败模式 B：Enter 选中 = 选中 + 立即发送（双触发）**

同一 Enter keydown 事件被两条链路先后消费：

1. **window capture**（`CommandPopover.vue:384` `onWindowKeydown`，`addEventListener('keydown', h, true)`）命中 Enter → `preventDefault` + `onSelect` → **同步**执行 `onCmdSelect`：插 chip、`cmdOpen=false`；
2. 事件继续传播到输入框 target 阶段 → contenteditable `onKeydown` Enter 分支 → emit → `composer-keydown.ts:127` `if (cmdOpen.value && ...)` —— **cmdOpen 已被步骤 1 置 false**，短路跳过浮层路由；`handleKeydown` 内部的 `e.defaultPrevented` 幂等守卫（`CommandPopover.vue:357`）此时返回 false（「未消费」）→ 落入 Enter 分支 → `onSend()` → **刚插好 chip 的草稿被立即发送**。

实测产物：聊天流出现消息 `#feat-composer-badge-positionAAA BBB CCC`（chip 序列化文本在最前——同时坐实失败模式 A）。Tab 不触发发送（target 阶段不处理 Tab），故只有 A 显形。

**失败模式 C：行首浮层 skill 项破坏 multi-skill 模型**

`insertSlashChip`（`chip-commands.ts:76`）开头：`el.querySelectorAll('.slash-chip').forEach(removeChipNode)`——skill chip 复用 `.slash-chip` class（multi-skill D2 有意复用）。用户已插 2 个 skill chip 后，从行首 `/` 浮层选第 3 个 skill → **前两个被删光**，第 3 个强制插到全文最前，且不带 location（`SlashCandidateInput` 无 location 字段，`buildSlashCandidates` 不透传——而数据源 `PiCommandInfo.sourceInfo.path` 明明可得）。发送时该 chip 产 skill segment 无 location，runtime 注入器退化为 get_commands 权威映射解析（D4 兜底可用，但丢一层自描述）。

**失败模式 D：命令 chip 强制最前 × D5 多行触发放宽 = 视觉重排 + args 语义欺骗**

现状序列：多行草稿 `"任务描述…"`（第 1 行），Shift+Enter 后在第 2 行行首输 `/compact` → **Enter 选中**（chip 就地插入）→ 光标处补打 `我说明一下`——`clearSlashQueryText` 只删第 2 行的 `/compact` 过滤段（D5 已修正），但 `insertSlashChip` 把 chip **强制插到全文最前**。用户看到：命令从第 2 行「跳」到第 1 行前面，草稿视觉重排。（步骤说明：slash 触发正则 `(?:^|\n)\/(\S*)$` 的 query 捕获段是 `\S*`，命令与 args 连写成 `/compact 我说明一下` 会因空格失配 ⇒ 浮层关闭、Enter 落到 `onSend` 发出字面文本——故命令必须在浮层里先选中、args 再在光标处补打；下文场景 3 与 §4 场景 6 同此。）

args 语义的准确表述（r1 修订，F2；轮 3 修正「逐字相同」）：pi 的命令模型是 `/cmd` + **剩余全部文本**为 args（§2.5 实装），与用户在哪里打 `/cmd` 无关。现状（chip 强制最前）的序列化产物 = `/compact任务描述…\n我说明一下`（旧 `visitSlashChip` 把命令 label 拍平进 `pendingText`，且 chip 恒在最前 ⇒ 命令与正文之间**无边界空格**）——**args 从来就包含命令前的全部正文**；视觉重排掩盖了这一点，用户以为 args 是「我说明一下」。本设计 D4 修复的是**视觉欺骗**（chip 就地、不再重排草稿），归位产物与现状**除边界空格外逐字相同**（归位语义 = 现状语义）：slash 段后接不以空格开头的 text 段时（本形态即此），`needsBoundarySpace`（`shared/segments.ts`）补一格，产物为 `/compact 任务描述…\n我说明一下`。**该空格是修正而非等价**——旧产物首 token 是 `/compact任务描述…`（非法命令名，pi 侧命令静默失效、按字面文本处理），新产物首 token 才是 `/compact`（§3.3 D4-e 登记）；「命令 chip 之后的文本才算 args」是独立的协议级行为变更，不属于本设计。

### 2.3 根因分析

**根因 1（A 的根因）：插入位置权威源三轨分裂。** 六类 inline chip 的 `insertXxxChip` 都先调 `restoreSelection()` 再 `insertChipAtSelection`（读 window 活选区）——「活选区」与「savedRange」两个真源之间没有优先级规则：`restoreSelection` 只要 savedRange 非空就无条件覆盖活选区，而 savedRange 只在 mouseup/blur 时刷新，打字与键盘移动光标都不更新。savedRange 的设计初衷是「浮层夺焦后恢复光标」（blur 场景），但它同时污染了「焦点从未离开」的键盘路径。另有一类（命令 chip）用第三轨：固定 `insertBefore(chip, el.firstChild)`。

**根因 2（B 的根因）：浮层键盘路由从「target 路由」迁移到「window capture 路由」时，双入口幂等守卫只保护了 ↑↓，没保护 Enter 的消费语义。** `cmdOpen` 在同一事件处理过程中被同步置 false，使 target 阶段的浮层路由判断失真；`defaultPrevented` 守卫返回「未消费」的语义与「事件已被浮层完整消费（选中+关闭）」的实际状态冲突。

**根因 3（C 的根因）：浮层选中项按「入口 type」而非「项类型」路由。** `onCmdSelect` 按 `payload.type`（浮层类型）分派；行首浮层的 skill 项 type 是 `'slash'`，于是进了 slash 通路——尽管该项在数据层终将变成 skill segment。「入口决定通路」使同一语义实体（skill）出现两套插入行为。

**根因 4（D 的根因）：「chip 必须在最前」是对 pi 行首协议的**位置层**妥协，而非协议本身的约束。** pi 只约束**序列化文本**以 `/cmd` 开头（§2.5）；现状把该约束前移到了** DOM 插入位置**，于是与 D5「任意行行首触发」组合后产生视觉重排。

### 2.4 物理数据流（基线现状；标注行含改动点与 HEAD 差异；未标 HEAD 的行号为设计时点坐标）

```
[composer DOM]
  chip(contenteditable=false) + 文本
    ↓ getSegmentsFromEl (dom-core input-dom.ts visitNode)
      ├─ .slash-chip + dataset.chipType='skill' → {type:'skill', name, location?}
      ├─ .slash-chip 其他（命令） → chip-label 文本并入 pendingText   ← 命令无结构化段（D4 改造点）
      └─ file/session/subagent/image → 各自结构化段
[Segment[]]
    ↓ getSegments / getSegments（发送前快照，core dispatch/send.ts:306）
    ├─→ segmentsToText (shared segments.ts，prompt 真源) → promptText → chatApi.send
    │     └─ runtime message-dispatcher.sendPrompt → BeforeSend hook → SkillInjector → client.prompt(pi)
    └─→ （draft.value = getText() = segmentsToText(DOM segments)，与 prompt 同源（基线与 HEAD 同源同序）；**HEAD 起**因 `visitSlashChip` 产 slash 段而表现为「已归位」，基线为拍平无空格形态）→ defer 拒绝判定 / /compact 拦截判定 / canSend   ← D4-c 迁移点（判定源单一化）
[pi RPC]
  prompt(text)：
    ├─ text.startsWith("/") → _tryExecuteExtensionCommand（含 pi builtin 命令）   ← 行首硬约束
    ├─ text.startsWith("/skill:") → _expandSkillCommand（全文展开）
    └─ 其余 → 普通 user message
[发送失败回滚]
  restoreSegments (dom-core restore.ts)：text 段 setText 重建 + 非文本段 insert*Chip 还原
    └─ skill 段 → insertSlashChip('/skill:name')                                                  ← 第三处通路错位（C 的另一实例）
```

**`draft.value` 与 prompt 同源（轮 3 修正）**：`getText()` 与发送前快照走的都是 `segmentsToText(getSegmentsFromEl(el))`——`input-dom.ts` 的 `getTextFromEl` 在基线与 HEAD **完全相同**，D4 只改了 `visitSlashChip` 的段产出，因此 `draft.value` **现在也已归位**（`ComposerInput.vue:130` onInput → `Composer.vue` onInputChange `draft.value = text`，与 `send.ts` 的 `segmentsToPrompt(segments)` 是同一函数的两次调用，恒同源同序）。原「两个文本真源的序差异」前提因此不成立：即使不迁移判定源，`draft.value` 也已以 `/cmd` 开头。D4-c 迁移的真实价值是**判定源单一化 + 消除 draft 快照失真窗口**（`draft` 是 `getText()` 的调用快照，`restore.ts` 的 `restoreInput(textOnly)` / 程序化 setText / 时序窗口下可滞后于 DOM；读 segments 恒取当前真值）——迁移本身无害且仍有价值，但**不是**「漏命中」修复（§3.3 D4-c 理由列已按此修正）。

### 2.5 pi 协议约束（实装证据，0.84.4 node_modules 权威版）

- `agent-session.js:821 prompt()`：`text.startsWith("/")` → 先试 extension command（pi builtin 命令如 /compact /model /goal 也以 extension command 注册，`_throwIfExtensionCommand` :1078 同构解析第一个空格前 token）；
- `_expandSkillCommand`：`text.startsWith("/skill:")` 才展开——**整条消息**行首；
- RPC 模式 `rpc-mode.js:298` prompt 命令纯透传 session.prompt。

结论：**「命令生效」要求序列化产物以 `/cmd` 开头，且一条消息只有一个命令（第一个空格前 token）**。这是 D4 方案必须满足的硬约束；「DOM 里 chip 在哪」pi 完全不感知——位置层可以也应该就地化。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 1（G1+G2，`#` 键盘选中就地插入、不发送）**：

> 用户在草稿中部输入 `帮我查一下 #`（光标在 `#` 后）→ session 浮层弹出 → 按 **Enter** 选中「feat-composer-badge-position」→ `#` 过滤段被删，session chip 出现在「帮我查一下 」之后（呼出位置），光标落在 chip 后，**消息没有被发送**，草稿继续可编辑。Tab 选中行为完全相同。

**场景 2（G3，行首浮层选 skill = skill chip）**：

> 用户在行首输 `/code-rev` → 命令浮层（命令+skill 混列）过滤出 skill 项 `code-review-graph` → Enter 选中 → 输入框变为 `[code-review-graph✦]`（紫色 skill chip，在光标处）。此前已插入的另一个 skill chip `[code-simplify✦]` **原样保留**。发送后 JSONL 与 skill-only 入径产出逐字一致（`<skill name=... location=...>` 全文注入，location 已携带）。

**场景 3（G4，命令 chip 视觉就地 + 发送归位，r1 断言修正）**：

> 多行草稿：第 1 行 `总结这个项目`，Shift+Enter 后第 2 行行首输 `/compact` → **Enter 选中**（`/compact` chip 出现在**第 2 行原位**，第 1 行纹丝不动）→ 光标处补打 `清理一下`。按 Enter 发送 → 消息文本自动归位为 `/compact 总结这个项目\n清理一下`（命令在最前，slash 段与 text 段之间由 `needsBoundarySpace` 补一格边界空格，与现状序列化产物除该空格外逐字相同，D4-e）→ renderer /compact 拦截命中（判定基于归位文本；`send.ts` 的拦截条件要求 `/compact ` 前缀，该空格正是使旧产物漏拦截的修正点）→ 压缩执行，customInstructions = `总结这个项目\n清理一下`（全部剩余文本，现状 args 语义）——用户从 DOM 位置已能直观看到命令在第二行，不再被视觉重排欺骗。（步骤说明：命令与 args 必须分两步输入——连写成浮层 query 会因空格失配关闭浮层，见 §2.2 失败模式 D 的步骤说明。）

**场景 4（G5，点击路径回归保护）**：

> 用户用鼠标点击浮层项选中任一类型——行为与现状完全一致（本设计不动 blur 刷新路径，只是不再依赖它）。

**场景 5（G5，手打零变化）**：

> 用户手打整条 `/skill:code-review-graph 请review`（不用浮层）→ 行为与今天完全一致：pi 行首展开（因为文本以 /skill: 开头），无 xyz 侧干预。

### 3.2 方案对比

| # | 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|---|
| D1 | **A. 优先级判定上移进 `restoreSelection` 本体：活选区在编辑器内则不动，仅活选区失效时应用 savedRange（单点收口，含 insertTextAtCursor 等全部调用方）** | 好：插入位置单一权威源（编辑器内活选区）；savedRange 回归「夺焦恢复」本职；一处修复覆盖全部调用方（insertXxxChip 六类 + insertTextAtCursor + onAddSelect） | 低：一个函数 + 应用时防御 | 低：blur 路径行为等价（两分支均收敛到编辑器内选区，见 D1 等价性论证） | ✅ |
| | B. 监听 `selectionchange` 持续刷新 savedRange | 中：savedRange 永不 stale，但引入全局高频事件 + 跨实例（split mode 双编辑器）边界 | 中 | 中：selectionchange 触发时机浏览器间有差异；且修的是「症状」（stale）而非「错源」（该用时不用活选区） | ❌ |
| | C. `onCmdSelect` 键盘路径跳过 restoreSelection（传标志） | 差：调用方分支散逸，六类 chip 各自判断，新增 chip 类型必踩坑 | 低 | 高：分支组合爆炸（键盘/点击 × 六类 chip） | ❌ |
| | D. liveInEditor 检查放 `insertChipAtSelection` 内（v1 方案） | 差：**修复落点无效**——六类 insertXxxChip 的调用序是 `restoreSelection()` → `focus()` → `insertChipAtSelection()`，活选区在到达前已被 restoreSelection 用 savedRange 覆盖，检查点读到的恒为 savedRange 应用后的选区，回退分支永不触发（r1 主审 F1 击穿） | 低 | 高：实施后 G1 完全不生效 | ❌（被否谱系登记） |
| D2 | **A. window capture Enter/Tab 分支：`isComposing` 守卫 + `preventDefault` + `stopPropagation`（单点主修）** | 好：capture 消费即截断，双触发结构性消除；同时修 IME 确认劫持（现状已有）；时序契约由单测锁定 | 低：一个分支三行级改动 | 低：见边界声明（split mode 注册序 / Tab a11y） | ✅ |
| | B. A + composer-keydown Enter 分支前 `defaultPrevented` 防御层（v1 方案） | 差：**会拦死全部 Enter 发送**——contenteditable.ts onKeydown 的 Enter 分支先 `e.preventDefault()` 再转发（:240-249），composer-keydown 收到的 Enter 恒 `defaultPrevented===true`，防御层使正常发送永不触发（r1 影响面审 MF-1 击穿） | 低 | 高：P0 级发送链路故障 | ❌（被否谱系登记） |
| | C. `onCmdSelect` 延迟 `cmdOpen=false` 到 nextTick | 差：用时序补丁掩盖事件流缺陷，脆弱 | 低 | 高：任何在 nextTick 前读取 cmdOpen 的代码仍看到旧值；Vue 调度细节耦合 | ❌ |
| D3 | **A. `CommandSelectPayload` 增加 `isSkill` 字段，onCmdSelect 按「项类型」分流到 skill 通路 + location 透传链补齐** | 好：路由按实体语义而非入口；与数据层（visitSlashChip 按 chipType 分流）同构 | 低：payload 加字段 + `buildSlashCandidates` 透传 sourceInfo.path | 低 | ✅ |
| | B. 行首浮层移除 skill 项（只留 skill-only 入口） | 差：砍掉 pi TUI 原生习惯入口（行首 / 打 skill 名），用户入口减少 | 低 | 中：习惯回归投诉 | ❌ |
| | C. onCmdSelect 内解析 `name.startsWith('/skill:')` 字符串约定 | 中：可行但字符串协议脆弱（name 格式变更静默失效） | 低 | 中 | ❌ |
| D4 | **B. 命令 chip 视觉就地 + slash segment + segmentsToText 归位最前** | 好：位置语义与五类 inline chip 统一；pi 约束收敛在序列化单点；draft/defer 判定迁移到同一真源 | 中：Segment 模型 + 序列化 + 三个判定点 + restore 适配 | 中：触及发送判定链（见 D4-c 风险与对策） | ✅ |
| | A. 保持强制最前（现状） | 差：D5 触发放宽后语义裂缝永久存在（失败模式 D） | 零 | —— | ❌（但 D4 的被否谱系登记） |
| | C. 命令 chip 完全内联多命令（runtime 接管命令分发） | 差：偏离 pi 命令模型，runtime 需复刻 builtin 命令执行语义，漂移面大 | 高 | 高：与 pi 命令行为漂移（本项目红线） | ❌ |

### 3.3 关键决策与权衡

**D1：插入位置权威源 = `restoreSelection` 本体活选区优先（r1 修订，F1 落点修正）**

v1 把 liveInEditor 检查放进 `insertChipAtSelection` 是**无效落点**：六类 `insertXxxChip` 的调用序都是 `restoreSelection()` → `el.focus()` → … → `insertChipAtSelection()`（设计时点六处：`chip-commands.ts:121/145/172/200/219/245`；轮 3 补：D4-a 后命令通路 `insertSlashChip` 也收编进同款调用序，HEAD 为七处 `:91/147/173/202/232/253/281`），活选区在检查点之前就已被 `restoreSelection` 用 savedRange 覆盖，检查恒走「活选区」分支但读到的已是 stale 位置。r1 把优先级判定**上移到 `restoreSelection` 本体**（`contenteditable.ts:278`；design-code-sync 轮 1 同步：终态本体经偏差 #14 提取至 `packages/dom-core/src/composer/input/selection-restore.ts` 的 `restoreSelection`，contenteditable.ts 经 useSelectionRestore 工厂消费——`contenteditable.ts:278` 为设计时点行号）：

```ts
function restoreSelection(): void {
  const el = getEl()
  if (!el) return
  // ① 先读活选区并完成判定（r2 修订：判定必须在 focus() 副作用之前——focus 对无存活选区
  //    的编辑器会在头部新建 caret，若先 focus 再判定会读到「头部、在编辑器内」的假活选区，
  //    savedRange 永不应用，比现状还回归）
  const sel = window.getSelection()
  // 活选区仍在编辑器内（键盘路径焦点从未离开 / Chromium blur 后 selection 对象常保留）→ 原样使用，不应用 savedRange
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    el.focus()   // 键盘路径本有焦点，no-op；Chromium 选区保留型 blur 路径回拉焦点不动选区
    return
  }
  // ② 活选区失效（无选区 / 锚点被移出编辑器，如点击浮层文本后）→ 应用 savedRange（blur 时刷新）
  if (!sel) return
  if (!savedRange) {
    el.focus()   // 对齐现状（r3 SG-r3-1）：savedRange 为空仍回焦，防 chip 插入未聚焦编辑器（可达性极低但属修复引入的行为差异）
    return
  }
  el.focus()
  savedRange.collapse(true)                 // 防御：非折叠旧选区经 deleteContents 误删正文
  sel.removeAllRanges()
  sel.addRange(savedRange)
  // 应用后校验：savedRange 指向已移除节点时 addRange 静默失败 → caret 落到编辑器末尾
  if (!(sel.rangeCount > 0 && el.contains(sel.anchorNode))) placeCaretAtEnd(el)
}
```

- **等价性论证（r1 修正 F4 的未验证断言）**：不依赖「blur 后活选区必不在编辑器内」——两个分支都收敛到编辑器内的正确选区：键盘路径活选区即光标（savedRange 不再覆盖）；点击路径若 Chrome 保留编辑器内 selection（与 blur 前 caret 同值）则原样使用，若被移出（点击落到浮层文本）则应用 savedRange（blur 时 `saveSelection` 刚刷新为 caret 同值）——两种浏览器行为产出一致结果。
- **收口范围（本 bullet 行号为设计时点坐标，基线 `135c1dbab`）**：`restoreSelection` 的全部调用方一次修复——六类 `insertXxxChip`、`insertTextAtCursor`（:379，触发链是 sidebar/drawer 的 context 注入 `injection.ts:111`，r2 表述修正——+菜单 attach 走 `insertFileChip` 不经此路径）、`onAddSelect` 的 slash 分支（开头显式 `saveSelection()` 使两分支同值，等价性由 r2 影响面审核实）。`insertChipAtSelection` 保持现状逻辑（`rangeCount` 兜底 appendChild 保留）。
- **被否 B（selectionchange）**：修症状不修错源 + 高频全局事件 + split mode 跨实例边界。**被否 C（调用方分支）**：分支组合散逸。**被否 D（v1 落点）**：见上，检查点读到的恒是 savedRange 应用后的选区。
- **效果**：G1 对六类 inline chip 一次成立；点击路径零变化；split mode 无新增边界（savedRange 是实例级闭包变量，非模块级——影响面审已核实）。

**D2：Enter 双触发根修 = capture 消费即截断（r1 修订：加 isComposing 守卫、删除 defaultPrevented 防御层）**

`CommandPopover.vue` `handleKeydown` 的 Enter/Tab 分支改造为三步：

```ts
if (e.key === 'Enter' || e.key === 'Tab') {
  if (composingRef.value || e.isComposing) return false  // IME 双保险（r2 修订）：事件属性 + compositionstart/end 维护的模块内 boolean，对齐 contenteditable.ts:240 既有范式——历史存在过 IME 发 isComposing=false+keyCode 229 先于 compositionend 的引擎 bug 面，单靠事件属性无兑底。返回值按实现：`handleKeydown` 声明 boolean，草案裸 `return` 与终态不符（偏差 #2）
  e.preventDefault()
  e.stopPropagation()                 // capture 阶段截断，事件不再到达 target（双触发结构性消除）
  onSelect(list[activeIndex.value])
  return true
}
```
（`composingRef`：CommandPopover 模块内监听 `compositionstart/compositionend` 维护的 boolean，与 contenteditable.ts 的 `composing` 同款范式。design-code-sync 轮 1 同步：CommandPopover 侧终态经偏差 #5 提取为 `packages/renderer/src/composables/panel/composition-flag.ts` 的 useCompositionFlag；AmbiguousFilePopover 保留同款范式的自建 composingRef 未迁移——改其 IME 守卫需单独动该文件副本。）

- **消费前提 = 浮层 `open`（轮 4 取代 RC-A-1 的「实际可见才消费」）**：`handleKeydown` 只在 `!open` 时返回 false（全部键放行 ⇒ Enter 正常发送），open 即消费 ↑↓ ⏎ Tab Esc。**决策因果**：[HISTORICAL] 轮 3 第 4 轮曾把条件收紧为「浮层实际可见（`items.length > 0 || fileFallbackVisible`）」，理由是当时存在一批「open 但什么都不渲染」的状态（slash/session/subagent/skill 空候选、landing `@` 无 sessionId、landing `$` 的 `idle` 与 query 无匹配），吞键会让消息发不出且无任何提示。**轮 4 为每个 open 态补了可见反馈行**（候选列表 / 「无匹配项」/ landing `$` 「加载中」/ 加载失败行），「不可见」状态类消失 ⇒ 该理由不再成立 ⇒ 条件回到「open 即消费」。逐态可见性同见 §1 G2。**实现落点**：键盘路由与 `activeIndex` 收敛下沉到 `packages/renderer/src/composables/panel/command-popover-keyboard.ts`（组件只留候选组装与渲染），消费条件与模板 `v-if="open"` 同源；回归锁见 `composer-keydown.test.ts` 的空态用例组与 N-2 用例组。**行为变化**：②③ 两类的 Enter 从「发送含触发符字面量的消息」变为「被消费不发送」，Escape 仍是显式关闭入口（关闭后 Enter 正常发送）。
- **删除 v1 的 defaultPrevented 防御层**（r1 影响面审 MF-1）：`contenteditable.ts` onKeydown 的 Enter 分支先 `e.preventDefault()` 再 `onEnterKeydown(e)` 转发（:240-249）——composer-keydown 收到的 Enter **恒** `defaultPrevented===true`，「Enter 分支前 `if (e.defaultPrevented) return`」会拦死全部正常发送。双触发的防护完全依赖 stopPropagation 主修 + 单测锁定时序契约（P5：浮层实际可见时 Enter 不触发 onSend 的 capture/bubble 全链路用例）。
- **IME 守卫是现状 bug 顺带修复**：浮层 query 过滤态下 IME 组合中按 Enter 确认候选词，现状会被 capture 劫持为「选中浮层第一项」（`onWindowKeydown` 无 isComposing 检查）——D2 重写该分支时一并修复，与 G2「绝不触发发送」的承诺域一致。
- **同款模式顺带修复**：`packages/ui/src/features/chat/AmbiguousFilePopover.vue:113-150` 是同款「window capture + preventDefault + 无 stopPropagation」双入口模式（r2 影响面审核实：其选中链路仅 emit('select') → selectFile + drawer.open，无 chip 插入/无 composer 参与/关闭不依赖 target 阶段 handler，加 stopPropagation 安全）——P2 一并加 **stopPropagation + IME 双保险守卫**（同款问题：其 capture 劫持 IME 确认 Enter），并在两处登记时序契约注释（防未来复制复发）。
- **边界声明**：① split mode 双 CommandPopover 同时 open（理论可达）时，stopPropagation 使先注册的实例独裁消费——现状双消费同样按注册序，行为差异可忽略，登记为已知限制；② 浮层 **open** 期间 Tab 被完全消费（焦点遍历不可用）——期望行为，属工作流变更显式登记（r1 SG-6；轮 4 起消费条件统一为 open）。
- **重演验证**（修复后时序）：capture 命中 Enter → isComposing 否 → preventDefault + stopPropagation + onSelect（同步插 chip、关浮层、D1 保证插在活选区）→ 事件不到 target → contenteditable onKeydown 不跑 → onSend 不可能触发。IME 组合中 → isComposing return → 事件正常到达 target → 候选词确认照常。
- **被否 C（nextTick 延迟关浮层）**：时序补丁掩盖事件流缺陷。**被否 B（防御层）**：见上，拦死正常发送。

**D3：行首浮层 skill 项按「项类型」路由（选定）**

- `CommandSelectPayload` 增加 `isSkill?: boolean`（`CommandPopover.onSelect` 已有 `item.isSkill` 派生——`buildSlashCandidates` 产出，零新增计算）。
- `onCmdSelect`：`type==='slash' && isSkill` → `clearSlashQueryText()` + `insertSkillChip(parsedName, location, icon)`（与 type==='skill' 分支合流；parsedName = name.slice('/skill:'.length)）。
- **location 透传链补齐**：`SlashCandidateInput` 加 `location?`；`CommandPopover.vue` slashCommands computed 从 `PiCommandInfo.sourceInfo?.path`（skill 项）填充（design-code-sync 轮 1 同步：终态回填逻辑经偏差 #6 位于 command-popover-symbols.ts 的 buildPanelSlashCandidates，非 CommandPopover.vue 内联）；landing 态 SkillInfo 分支填 `sourcePath`。**对 runtime 注入器零改动**（D4 权威映射兜底本就兼容缺 location，带上后走自描述路径）。
- **被否 B（砍入口）**：破坏 pi TUI 原生习惯。**被否 C（字符串约定）**：脆弱协议。
- **同修第三处错位**：`restore.ts restoreSegments` 的 skill 分支从 `insertSlashChip('/skill:'+name)` 改为 `insertSkillChip(name, seg.location)`——发送失败回滚不再丢 location、不再误删其他 chip。
- **第三入口已合流（轮 4 修；原「已知不一致，不在本设计 scope」登记已关闭）**：SearchModal ⌘K 是 skill 的第三入口——全局搜索选择 → `commandStore` 的 `PendingSlash` → `useCommandPopoverTrigger.ts` 的 watch → 注入 chip。修复前它落**命令 chip**（无 `dataset.chipLocation`、受单命令替换语义管辖、不计入 `selectedSkillNames`，G3「携带 SKILL.md 路径」在该入口不成立），根因是 pi 0.84.4 的 skill 命令名不带 `/` 前缀（形如 `skill:code-review-graph`）而 `PendingSlash` 既无类型标记也无 location 字段。**修法（与 D3 同构的「按项类型路由」）**：字段链 `SessionCommand.kind === 'skill'` →（映射）`SearchItem.isSkill` →（写入）`PendingSlash.isSkill`；location 走 `SessionCommand.sourceInfo.path` → `SearchItem.location` → `PendingSlash.location`。消费侧 `isSkill` 为真走 `insertSkillChip(bareSkillCommandName(command), location, icon)`（与 `onCmdSelect` 的 skill 项分流同一落点），否则维持 `insertSlashChip`（回归锁）。**原登记的成本论据（「location 数据面不存在、补齐属新增数据管道」）经复核不成立**：`applyCommands` 已把 `RawCommand.sourceInfo` 归一化进会话命令，两处 `SearchItem` 映射点本就在这些命令对象上，故只需补字段透传。UI 层 `SearchModal.confirmSel` 必须显式搬运 `isSkill`/`location`——它按字段重建 `SearchItem`，漏搬会静默退回命令通路（回退实验已证该透传承重）。

**D4：命令 chip 视觉就地 + 序列化归位（选定，含四个子决策）**

- **D4-a DOM 插入**：`insertSlashChip` 命令分支（非 `/skill:`）从「删光全部 `.slash-chip` + `insertBefore(firstChild)`」改为「仅移除已有**命令** chip（`dataset.chipType==='slash'`，替换语义，维持单命令不变量）+ `insertChipAtSelection`」；命令分支同样先经 `restoreSelection()`（D1）取活选区落位——与五类 inline chip 同款调用序（r3 一致性审查补记）。
- **D4-b 数据模型**：`Segment` 联合类型新增 `{ type: 'slash'; name: string }`（name 不含 `/` 前缀）；`visitSlashChip` 非 skill 分支从「label 并入 pendingText」改为 `flushText + push({type:'slash', name: dataset.chipName})`（chipName 已有，insertSlashChip 现存）。`SEGMENT_SERIALIZERS` 加 `slash: (seg) => '/' + seg.name`。
- **D4-c 归位与判定真源迁移（r1 修订：消费点清单补全，F5/MF-2；轮 3 修正理由列）**：`segmentsToText` 函数级归位——序列化前把 slash 段提为首段（多个 slash 段防御性全前置按序，正常态至多一个），后接原序其余段；既有 `needsBoundarySpace` 规则沿用（slash 段视同 chip 类段）。**发送判定逐点裁决**（`draft.value` 全部消费方）：注意 `draft.value = getText()` 与 prompt 同源且**自 HEAD 起已归位**（§2.4；基线为拍平无空格形态），三条「迁移」行的理由因此是**判定源单一化 + 消除 draft 快照失真窗口**（`draft` 是 `getText()` 的调用快照，回滚/程序化 setText/时序窗口下可滞后于 DOM），而非「DOM 序漏命中」——后者在 `getTextFromEl` 恒走 `segmentsToText` 的前提下不成立：

  | 消费点 | 现状输入 | 裁决 | 理由 |
  |---|---|---|---|
  | defer 拒绝判定 `/` 半边（`send.ts` 的 `enqueueDuringDefer`） | draft.value | **迁移** segmentsToPrompt | 判定源单一化 + 消除 draft 快照失真窗口（回滚/程序化 setText/时序）；defer 的 segments 载荷与 UI 判定读同一真值，杜绝快照滞后；即使不迁，draft 也已以 `/cmd` 开头（同源归位） |
  | defer 拒绝判定 `!` 半边（同上函数） | draft.value | 不迁 | `!` 不产 chip，手打必在 DOM 文本行首，两源恒一致；同函数内双源拆开判定 |
  | `/compact` 拦截（`send.ts` 的 `sendActiveMessage`） | draft.value | **迁移** segmentsToPrompt | 同「判定源单一化 + 消除 draft 快照失真窗口」；`segmentsToPrompt(segments)` 即发送载荷本身，判定与载荷构造同源，快照滞后面归零 |
  | staging 提交（`send.ts` 的 `routeStaging` → `staging.send(draft.value)`） | draft.value | **迁移** segmentsToPrompt（r1 MF-2） | 同「判定源单一化 + 消除 draft 快照失真窗口」；staging 载荷本就是 segments 的序列化，改后判定与载荷同一表达式，fork/handoff staged prompt 的 `/cmd` 前缀不再依赖 draft 与 DOM 的时序一致性 |
  | 用户消息展示 / 复制 / 历史条目（`normalizeContent` / `UserBubble` 渲染） | message content segments | **接受**（随同一序列化实现归位） | slash 段渲染为 `/name` 纯文本且前置——`segmentsToText` 同时是展示序列化（`segments.ts` 头部注释自述「归一化展示用 + pi prompt 序列化的唯一实现」），不拆两条实现（与 §2.4「判定源单一化」、§3.2 D4「pi 约束收敛在序列化单点」一致）；展示面与 prompt 面形态一致，避免同一条消息两副样子。渲染侧实现：`shared` 抽出归位序与边界空格单一实现（`normalizeSegmentOrder` / `needsBoundarySpace`，与 `segmentsToText` 共用），`packages/ui/src/features/chat/UserBubble.vue` 按归位序渲染 slash 段为纯文本（MF-1） |
  | defer 入队展示文本（`enqueueCompact` 的 text 参数） | draft.value | 不迁（登记） | 仅入队条目展示；重放载荷走 segments（归位序列化），协议面不受展示文本影响 |
  | bash 判定（`trySendBash`/`extractBashCommand`） | draft.value | 不迁 | `!` 前缀语义与 chip 无关；命令 chip + `!ls` 混排的现状行为两源本就一致 |
  | canSend / hasInput / placeholder / isBashMode | draft.value | 不迁 | 非空判定不受 chip 位置影响（getText 含 chip label）；isBashMode 判定 `!` 前缀同上 |
- **D4-d 纯文本判定**：sidecar 写入条件「全部 text 段才跳过」扩展为「text 段 + slash 段跳过」——slash 段无 badge 还原需求（chat 流显示归位后纯文本——该展示分支由本设计的代码侧一并落地：`UserBubble` 按归位序渲染 slash 段，见 D4-c 展示行），不为此引入 sidecar 写入。**谓词存在两处（轮 3 修正，原「单点声明」与实现不符；轮 3 第 4 轮按口径规则改符号引用）**：字面相同的 `segments.some((s) => s.type !== 'text' && s.type !== 'slash')` 落在 `useChat.ts` 的 `submitSegments`（直发路径，函数内 `const needsBackfill`）与 `submitQueuedEntry`（defer 重放路径，函数内 `const needsBackfill`）各一处，无共享 helper（提取属结构改造，超出本设计范围；`submitSegments` 侧该谓词上方的不变式注释「sidecar 条目存在 ⟺ 映射 custom entry 存在」本身要求两侧同谓词，字面重复即口径同步的代价）。**不变式**：谓词认定纯文本 → sidecar 写入与 custom entry 标记两条通道都不触发；defer 侧 slash 段不可达（`send.ts` 的 `enqueueDuringDefer` 对以 `/` 开头的 `segmentsToPrompt(segments)` 一律拒绝入队），两处同谓词排除纯为口径统一（另经核实：pi RPC 侧无 Segment 穷尽 switch，skill-injector / entry-tree-builder 均消费序列化文本，sidecar 旧数据兼容成立）。
- **D4-e args 语义显式登记（r1 F2，轮 3 修正「逐字相同」）**：归位后的序列化产物与现状（chip 强制最前）**除边界空格外逐字相同**——slash 段后接不以空格开头的 text 段时，`needsBoundarySpace`（`shared/segments.ts`）补一格：旧产物 `/compact任务描述…\n我说明一下`，新产物 `/compact 任务描述…\n我说明一下`。**该空格是修正而非等价**：旧产物首 token 为 `/compact任务描述…`（非法命令名，pi 侧命令静默失效、按字面文本处理），新产物首 token 才是 `/compact`，行首命令协议成立（`send.ts` 的 `/compact ` 前缀拦截同理——旧产物根本进不了该分支）。args 语义不变：恒为命令后的剩余全部文本（含命令 chip 之前的正文），**维持现状协议语义**。「命令 chip 之后的文本才算 args」（slash 段之前的 text 段移到其后）是独立的协议级行为变更，超出本设计，登记为未来独立决策候选。
- **风险与对策**：触及发送判定链是本设计最大风险面——对策是 §4 场景 6/7/10/11（defer 入队、/compact 拦截、staging 提交、defer 重放四条链路的真机验收）+ 判定源迁移用例全量同步改写。
- **被否 A（保持现状）**：失败模式 D 永存。**被否 C（runtime 接管命令）**：与 pi 漂移面不可控。

**D5（登记，不改）：hasChip 触发抑制维持现状**

存在任何 chip 时行首 `/` 不触发（multi-skill D2 保留决策）。本设计不改——放开是独立行为变更（误触发面需独立评估 query 合法性过滤对命令域的适配），超出「修插入语义」的 scope。已知限制：插了 skill chip 后行首无法再呼命令浮层（删 chip 或发送后恢复）——**§4 场景 5 因此按逆向序（先行首 skill、后行中 skill）验收**。未来放开条件：命令域 query 过滤对齐 skill 域合法性过滤（`[a-z0-9-]`）后评估。

**D6（边界声明，r1 扩充为「恢复语义边界」集中登记）：三类恢复路径均为近似，不保序**

| 恢复路径 | 机制 | 近似点 | 判定 |
|---|---|---|---|
| 草稿持久化（session 切换） | drafts 存 `getText()` 纯文本（HEAD 起已归位），恢复 setText | chip 形态全丢（含命令/skill 位置）；**恢复后命令会被执行**（此前因缺边界空格、首 token 非法而按字面文本发送），与手打行首 `/cmd` 行为一致 | **已接受的行为变化**（轮 3 登记，与 D4-e 同根）：变化方向是修正（命令恢复后生效而非静默失效）；不采「另加 DOM 序取文本入口」以维持旧文案的备选——引入第二文本真源、与 §2.4「判定源单一化」及 §3.2 D4「pi 约束收敛在序列化单点」相悖，且旧行为是命令静默失效的缺陷。segments 持久化属独立迭代 |
| 发送失败回滚（`restoreSegments`） | text 段 setText 重建 + 非文本段逐个 `insertXxxChip` 追加 | **位置近似**：chip 回滚后落在全文尾部而非原位置（slash/skill/image/session/subagent 同理，现状已如此）；skill 段 location 保留（D3 同修）、slash 段形态恢复 | 接受（登记）；位置保序需 DOM 快照机制，成本不成比例 |
| 编辑重发（editAndResend） | **消息气泡上的内联编辑框**（`UserBubble.vue` 的 `draftText`，`startEdit` 经 `normalizeContent(content)` 回填**归位后全文**——命令可见可改）→ `rebuildSegmentsWithEditedText(user.content, text)` → `editAndResend(sessionId, user.id, segments)`（`useChat.ts` 的 `editAndResend`）：内部 `segmentsToPrompt(segments)` 后 `submitSegments` **直发**——全程不写 composer DOM、不经 `restoreSelection` | 同回滚：位置近似；消息 content 含 slash 段时（即由命令 chip 发出的消息），提交时**剥离编辑文本里与 slash 段重复的前缀命令**（命令由 slash 段承担；用户改写/删除命令时丢弃对应 slash 段），重发 prompt 命令在归位首且**只出现一次**（MF-2 采纳备选方案，理由：编辑框展示归位全文使用户可改命令）；**其余非 text 段（skill/file/mention/session/handoff）同走序列化文本剥离**（序列化 SSOT 取自 `segmentsToText([seg])`；剥离不到即丢弃该段、以文本形态随 prompt 进入——防止序列化标记随编辑稿整串回灌 text 段而翻倍，轮 3 收口）；subagent/未知类型序列化为空串 ⇒ 恒保留；**image 段按裸路径 token 参与剥离（轮 4 修；原「未修项」的两个方向均已关闭）**——image 序列化 `\n<path>\n` 是换行定界的裸路径，而 `submitEdit` 提交前对草稿 `.trim()` 会吃掉首尾换行，故序列化串精确匹配在真实链路恒不命中（只剩「丢弃段」一条路 ⇒ 段自带的首行换行一并丢失、prompt 首行变 `/path` 被 pi 当行首命令）；改为对 `seg.path` 做**裸路径 token 匹配**（前边界 = 串首或空白、后边界 = 串尾或空白，防 `x/data/a/1.png`、`/data/a/1.png2` 的前缀误配）：命中 ⇒ 剥离该处文本 + **保留**段（消除①翻倍）；未命中 ⇒ **丢弃**段（语义 = 用户删掉了该路径，消除②删除后路径复活）；历史纯文本 `/cmd` 消息 content 无 slash 段 ⇒ 该路径不产 slash 段，重发文本不变 | 接受；§4 场景 12 验收发送行为（不验收位置） |

---

## 4. 验收（真实场景，dev app + Playwright CDP）

实施完成后在 `pnpm dev`（remote-debugging-port=9222）+ Playwright 驱动真实界面验证。每个场景标注回溯目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| 1 | `#` 键盘选中就地插入 | 点击空框 → 打字 `AAA BBB CCC #` → Enter 选中浮层第一项 | 输入框文本 = `AAA BBB CCC [session-chip]`；chip 的 prevSibling 文本以 `CCC ` 结尾；**聊天流无新消息**；`#` 过滤段已删 | G1+G2 |
| 2 | Tab 与 Enter 等价 | 同场景 1 但按 Tab | 结果逐字符一致（除选中项） | G1 |
| 3 | 点击路径回归 | 同场景 1 但鼠标点击浮层项 | 结果与现状（修复前实测基线）一致 | G5 |
| 4 | stale savedRange 防御 | 点击草稿头部（savedRange=头部）→ End 键到尾部 → `#` → Enter | chip 在尾部（活选区），不在头部 | G1 |
| 5 | 行首浮层选 skill 不误删 | **逆向序（D5 抑制）**：行首 `/` 选 skill B（此刻无 chip，行首浮层才可呼出）→ 行中空白后 `/` 插入 skill A | 两 chip 均保留（插 A 不删 B）；B 在行首光标处、A 在插入点；均带 location（DOM dataset 断言）；发送后 JSONL 含两个 `<skill>` 全文 block（location 均自描述） | G3 |
| 6 | 命令 chip 视觉就地 + 归位拦截 | 打 `任务描述` → Shift+Enter → 第二行行首输 `/compact` → Enter 选中（chip 就地在第二行）→ 光标处补打 `清理`（命令与 args 分两步，见 §2.2 步骤说明） | chip 在第二行原位，第一行不动；再按 Enter 发送 → 归位产物 `/compact 任务描述\n清理`（`needsBoundarySpace` 补的边界空格，D4-e 修正点——`send.ts` 中 `sendActiveMessage` 的 `/compact ` 前缀拦截分支据此成立，旧产物无空格时根本进不了该分支）→ **renderer /compact 拦截命中**（压缩流程触发，customInstructions = `任务描述\n清理`，全部剩余文本——现状 args 语义，D4-e），非 pi 侧字面执行；**气泡 DOM 断言**：发送后用户气泡文本以 `/compact ` 开首且命令只出现一次（展示面随同一归位序列化，D4-c 展示行） | G4 |
| 7 | defer 态命令判定不裂 | 占用中（streaming）→ 多行草稿中间某行行首输 `/compact` → Enter 选中（chip 就地在行首）→ 发送 | 被拒绝入队并 toast「命令排队被拒」（判定基于归位文本）——与现状行为一致，非静默入队成字面文本 | G4 |
| 8 | 手打零变化 | 手打整条 `/skill:a 请review` 发送 | pi 行首展开（JSONL 断言 `<skill name="a">` 全文），无 xyz 干预 | G5 |
| 9 | 发送失败回滚保留 skill chip | 场景 5 发送前制造 runtime 不可达（断 pi）→ 发送 → 失败回滚 | 两 skill chip 形态恢复（非纯文本），location 保留；**位置不验收**（回滚位置近似=尾部，D6 登记边界） | G3 |
| 10 | staging 提交含命令 chip | fork staging 态 → 多行草稿中间某行行首输 `/compact` → Enter 选中（chip 就地）→ Enter 提交 | staged prompt 以 `/compact` 开首（归位文本），pi 侧行为与现状一致；无「静默变字面文本」 | G4 |
| 11 | defer 重放归位一致 | defer 态入队非命令富内容（file chip + 正文）→ flush 重放 | 重放 prompt 与直发同构（归位序列化）；无字段丢失 | G4+G5 |
| 12 | 编辑重发（命令不重复） | 对**由命令 chip 发出**的 user 消息（content 含 slash 段）→ 点消息气泡的**内联编辑框**（展示归位全文，命令可见可改）→ 直接提交或改正文后提交（`rebuildSegmentsWithEditedText` → `editAndResend` 直发，不写 composer DOM、不经 `restoreSelection`）；另对**含 skill/file/mention/session/handoff 段**的消息同理编辑重发 | 重发 prompt 以 `/cmd ` 开首、命令**只出现一次**（MF-2：剥离编辑文本里与 slash 段重复的前缀命令；改写命令时只含新命令、旧命令不残留）；skill/file/mention/session/handoff 段的序列化形态在 prompt 中**各只出现一次**（段保留即剥离对应文本，改写/删除则丢弃段——防标记翻倍，回归锁 `packages/ui/src/lib/__tests__/segment-rebuild.test.ts`）；image 段按裸路径 token 剥离（保留路径 ⇒ 重发 prompt 中路径只出现一次；删除路径 ⇒ 不再出现——原登记的两方向均已修，见 D6）；历史**纯文本** `/cmd` 消息（content 无 slash 段）编辑重发 → 文本不变（该路径不产 slash 段，不覆盖归位逻辑） | G5 |
| 13 | IME 组合确认不被劫持 | 浮层 query 过滤态 → IME 输入中文过滤词 → 组合中按 Enter 确认候选词 | 候选词确认照常，浮层不选中、不关闭、不发送（capture 层 isComposing 守卫，D2） | G2 |

补充断言（探针）：场景 1/5/6 的 DOM 断言同时校验 `window.getSelection().anchorNode` 位于 chip 后 spacer（光标位置正确）。

**回归测试清单（r1 补全，影响面审 MF-3）**——行为变更需同步改写/新增的测试：

| 包 | 测试文件 | 变更点 |
|---|---|---|
| shared | `src/__tests__/segments.test.ts` | slash 段类型 + serializer + 归位断言（穷尽守卫新增 key） |
| dom-core | `composer/input/chip-commands.test.ts` / `input-dom.test.ts` / `contenteditable.test.ts` / `restore.test.ts` / `skill-chip.test.ts` | D1 插入位置、D4-a 命令 chip 就地、visitSlashChip slash 段、restoreSegments（r3 审查修正：原列 skill-trigger.test.ts 实际未被行为变更触及，删；skill-chip.test.ts 才是被改文件） |
| ui | `features/composer/__tests__/`（file-chip / composer-input-get-text / useComposerChipCommands.image / composer-input-trigger-forward / composer-injection-real-dom / useComposerDragDrop） | 真实选区链路去 mock（restoreSelection mock 盲区——bug 存活根因；实施收窄见偏差 #15：仅 composer-injection-real-dom 去 mock，位置覆盖由 dom-core chip-commands.test 真实链路区段承接）；触发转发回归 |
| ui | `features/chat/__tests__/`（UserBubble 展示面，轮 3 补） | slash 段按归位序渲染为 `/name` 纯文本（气泡文本含 `/compact`、命令在首）；**段序仅含 slash/text 段（无 badge 段）时**：气泡渲染文本 === `segmentsToText(同段)` 等价锁（slash 与其后继段之间的边界空格显式渲染）——该范围由 `UserBubble.test.ts` 的 MF-1 组注释界定，同组含反例用例（`[slash, file, text]` 断言 `not.toBe(segmentsToText(同段))`）；含 badge 段不等价的原因是**两条并存**：① badge 边界空格不显式渲染——`UserBubble.boundarySpaceBefore` 只在 `prev.type === 'slash'` 时渲染一格空格，其余 badge 边界走自身 CSS `mr-1` 间距、不产文本节点，而 `segmentsToText` 经 `needsBoundarySpace` 对 chip→text 边界补空格，两者因此不等（取投影无差异的段序 `[file('a.ts'), text('正文')]` 即可单独证伪「只有一条原因」：序列化 `a.ts 正文` 与气泡文本 `a.ts正文` 的唯一差异就是这格空格）；② badge 段展示投影 ≠ 序列化（file 显 `fileBasename(path)` + 行范围、session 显 `label`、skill/subagent 显 name/slug、image 显缩略图），登记面见 `composer-multi-skill-injection.md` §3.5-⑤「`normalizeContent` 纯文本投影面（P0-12 登记）」（实有标题）。①②同为本锁不覆盖 badge 段的原因，均不在本锁范围——**在段/序列化层**结构性锁 live ≡ reload（MF-1），产线 `MarkdownRenderer` 的 markdown 块级渲染边界不在本锁范围（组注释 N-3a） |
| ui | `lib/__tests__/segment-rebuild.test.ts`（轮 3 新增） | 编辑重发：slash 前缀剥离 + 其余非 text 段（skill/file/mention/session/handoff）序列化剥离、subagent/未知类型恒保留；image 段按**裸路径 token**剥离（命中 ⇒ 剥该处文本 + 保留段；未命中 ⇒ 丢弃段）：新增 6 条 image 用例（两方向 + 改写路径 + 前/后边界守卫 + 游标保护），本文件 40 → 46 例 |
| renderer | `composer-keydown.test.ts`（D2 改动本体，含 capture/bubble 时序锁用例）；`composer-slash-trigger.test.ts`（U11c）；`composer-hash-trigger / composer-compact-queue / composer-dispatch-route / composer-bash-mode / composer-send-button-states / composer-fork-mode / composer-landing-skill-reload` | 浮层 open 时 Enter/Tab 被消费、不触发 onSend（时序锁）+ 每个 open 态都有可见渲染（列表 / 「无匹配项」/「加载中」/ 加载失败——消费条件与模板 `v-if="open"` 同源，**轮 4 取代** RC-A-1 的「不可见即放行」）+ 浮层未 open 时 Enter 正常发送（保留契约锁）+ 候选源缩短的同一拍 activeIndex 收敛（模板高亮行 = Enter 选中行、↑↓ 起点不再归 0）；强制最前断言改写为就地断言（**仅 `composer-slash-trigger.test.ts` U11c**——原同步列的 `composer-slash-injection.test.ts` 本分支零改动（`git log 135c1dbab..HEAD` 为空），轮 3 收窄）；D4-c 判定源迁移 |
| core | `domain/composer/dispatch/send.test.ts` / `submit.test.ts`；`domain/chat/` 的 `mutations.test.ts` / `useChat.test.ts` / `submit-queued-entry.test.ts`（场景 10/11/12 对应：staging/defer 重放/编辑重发） | 判定源迁移 + staging/defer 载荷。**轮 3 第 5 轮同步实施实况**：`submit.test.ts` / `mutations.test.ts` / `submit-queued-entry.test.ts` 三者**未实施**（`git log --oneline 135c1dbab..HEAD` 对三者输出均为空），用例归并至 `send.test.ts` / `useChat.test.ts`（本分支实际改动的两个文件），见实施计划 u6 领地登记 |
| runtime | skill-injector 相关（回归——slash 段不进注入器，预期零变化） | 反向回归锁 |

---

## 5. 下一层拆分

| 单元 | 内容 | 文件改动地图 | justification（为何独立成单元） |
|---|---|---|---|
| P1 | D1 restoreSelection 活选区优先 + 应用防御 | `dom-core/composer/input/contenteditable.ts`（restoreSelection 本体重写 + placeCaretAtEnd 辅助；design-code-sync 轮 1 同步：终态本体经偏差 #14 提取至 selection-restore.ts，contenteditable.ts 经 useSelectionRestore 工厂消费）；`chip-commands.ts`（调用点注释更新，无需改逻辑） | 根因 1 单点收口；判定在 restoreSelection 本体使其全部调用方（六类 insertXxxChip + D4-a 后的命令通路 insertSlashChip + insertTextAtCursor + onAddSelect）一次修复（r1 F1 落点修正；轮 3 补列 insertSlashChip 收编）；独立可验收（场景 1-4） |
| P2 | D2 capture 截断 + IME 守卫 + 同款模式修复 | `renderer/components/panel/CommandPopover.vue`（handleKeydown Enter/Tab：isComposing + stopPropagation）；`ui/features/chat/AmbiguousFilePopover.vue`（同款模式顺带修）；两处时序契约注释 | 根因 2；IME 确认劫持与 AmbiguousFilePopover 是同根双入口模式，合并修复防复发（r1 F3/SG-1）；独立可验收（场景 1「无新消息」+ 场景 13） |
| P3 | D3 skill 项按类型路由 + location 链 | `renderer/composables/panel/useCommandPopoverTrigger.ts`（payload + onCmdSelect 分流）；`command-popover-symbols.ts`（SlashCandidateInput.location + buildPanelSlashCandidates 的 sourceInfo.path 回填——r3 审查同步：回填逻辑经偏差 #6 提取至此，非 CommandPopover.vue 内联）；`CommandPopover.vue`（消费构建函数）；`dom-core/composer/input/restore.ts`（skill 回滚分支） | 根因 3；与 P1/P2 无代码耦合，可并行；独立可验收（场景 5/9） |
| P4 | D4 命令 chip 就地 + 归位 + 判定迁移 | `dom-core/composer/input/chip-commands.ts`（insertSlashChip 命令分支）；`input-dom.ts`（visitSlashChip slash 段）；`shared/segments.ts`（类型 + serializer + 归位）；`core/domain/composer/dispatch/send.ts`（defer `/` 半边 / /compact / staging.send 判定迁移）；`core/domain/chat/useChat.ts`（纯文本判定扩展，谓词两处：`submitSegments` / `submitQueuedEntry` 内的 `const needsBackfill`）；`dom-core/composer/input/restore.ts`（slash 段回滚） | 根因 4，触及数据模型与发送链——风险面最大，单独成单元便于审查与回滚；判定迁移点以 D4-c 裁决表为准（含 staging，r1 MF-2；轮 3 修正：迁移价值 = 判定源单一化 + 消除 draft 快照失真窗口，非「漏命中」修复）；独立可验收（场景 6/7/10/11/12） |
| P5 | 测试补齐（清单见 §4） | §4 回归测试清单全量 + 键盘路径真实选区用例（去 restoreSelection mock）+ capture/bubble 时序锁用例 | 测试盲区是 bug 存活至今的直接原因；时序锁用例是 D2 删除防御层后的唯一防线（r1 MF-1 对策） |

**实施顺序**：P1 → P2 → P3 → P4 → P5 随各单元带上（P1/P2 可并行，P4 依赖 P1 的 **restoreSelection 改造**——命令 chip 就地插入位置由它保证；`insertChipAtSelection` 本身不变，r2 修订消除 v1 残留表述）。

**待验证检查点（实施期核对，不阻塞设计）**：
1. `detectSlashTriggerFromEl` 的行首正则对「chip 后 ZWSP spacer 处光标」的行为（multi-skill D2 注释称 skill 域天然不命中，命令域需实测确认——影响场景 6 后连续操作）；
2. `normalizeContent`（复制消息/编辑重发）对 slash 段的呈现——预期归位文本透传，无反解析需求；
3. pi builtin 命令集在 RPC 模式的 extension command 注册完整性（场景 6 的拦截在 renderer 侧，此项只影响非 /compact 命令的实测选样）。

**变更历史**：
- v1（2026-09-08）：初版。
- v2（r1 修订，同日）：① D1 落点上移至 restoreSelection 本体（主审 F1：v1 检查点读到的恒是 savedRange 应用后的选区，回退永不触发；新增被否 D）；② D2 删除 defaultPrevented 防御层（影响面审 MF-1：contenteditable Enter 分支先 preventDefault 再转发，防御层会拦死全部正常发送；新增被否 B）+ 加 isComposing 守卫（F3：IME 确认劫持）+ AmbiguousFilePopover 同款模式顺带修（SG-1）+ split mode 注册序/Tab a11y 边界声明（F6/SG-6）；③ D4-c 判定源迁移消费点补全为裁决表（F5/MF-2：staging.send 迁移、defer `!` 半边拆分、bash/canSend 逐点不迁登记）；④ D4-e args 语义显式登记（F2：归位产物与现状逐字相同——该表述经 design-code-sync 轮 3 修正为「除边界空格外逐字相同」，见 v4；args 含命令前全部正文是现状语义；场景 3/6 断言修正）；⑤ D6 扩充为三类恢复路径集中登记（F7：回滚位置近似=尾部）；⑥ §4 新增场景 10-13（staging/defer 重放/编辑重发/IME）+ 回归测试清单补全（MF-3）；⑦ §5 P1/P2/P4/P5 同步 D1 落点、IME+AmbiguousFilePopover、staging 迁移、测试清单。
- v3（r2 修订，同日）：① §5 实施顺序改为「P4 依赖 P1 的 restoreSelection 改造」（主审 r2 MUST_FIX：v1 残留「依赖 insertChipAtSelection 改造」与 D1 r1 修订矛盾）；② D1 代码草案重排——活选区判定移至 el.focus() 之前（主审 r2 SG-a：focus 对无存活选区编辑器会头部新建 caret，先 focus 再判定是自毁式检查；失败分支在 Chromium 已知路径不触发但属健壮性缺陷，一行成本修复）；③ D2 IME 守卫升级双条件 composingRef||isComposing（主审 r2 SG-d：对齐 contenteditable.ts:240 既有范式，防御 keyCode 229 型引擎 bug 面）+ AmbiguousFilePopover 同步双保险（影响面审 r2 SG-1）；④ D4-d 补 needsBackfill 谓词单点声明（影响面审 r2 SG-2：谓词同时门控 sidecar 写入与 custom entry 标记；该「单点」经 design-code-sync 轮 3 修正为「谓词两处」，见 v4）；⑤ D1 收口范围 insertTextAtCursor 触发链表述修正为 context 注入 injection.ts:111（影响面审 r2 SG-4）；⑥ §4 core 行测试文件点名（影响面审 r2 SG-3：mutations/useChat/submit-queued-entry）；⑦ D1 草案 !savedRange 分支补 el.focus() 对齐现状回焦行为（主审 r3 SG-r3-1，随 r3 确认当轮修完）。
- v4（design-code-sync 轮 3 同步，2026-09-10，对齐 HEAD `39a8b08fe`）：① MF-3 三处「归位产物与现状逐字相同」（§2.2 失败模式 D / §3.1 场景 3 / D4-e）修正为「除边界空格外逐字相同」并写明该空格是修正（旧产物首 token `/compact任务描述…` 非法 ⇒ pi 侧命令静默失效；`send.ts` 的 `/compact ` 前缀拦截同理），§4 场景 6 期望值按实际产物补全；② MF-4 §2.4 撤除「两个文本真源」前提（`draft.value = getText() = segmentsToText(DOM segments)`，与 prompt 同源且已归位；`getTextFromEl` 基线与 HEAD 相同），D4-c 三条迁移行理由改为「判定源单一化 + 消除 draft 快照失真窗口」，D6 草稿持久化行与 Out of scope 补登记「恢复后命令会被执行」为已接受的行为变化并给出不采备选的理由；③ MF-6 D4-d「单点声明」改为谓词两处（`submitQueuedEntry` defer 重放 / `submitSegments` 直发，各持 `const needsBackfill`；轮 3 第 4 轮按口径规则改符号引用），登记 defer 侧 slash 段不可达；④ MF-7 §4 回归清单 renderer 行删除 `composer-slash-injection.test.ts` 的失实改写登记（该文件本分支零改动，改写实际在 `composer-slash-trigger.test.ts` U11c）；⑤ S-5 §2.1 入口表补 `+` 菜单 / SearchModal ⌘K 第三入口行，D3 增「已知不一致（不在本设计 scope）+ 后续迭代条件」；⑥ S-7 §4 场景 5 改逆向序（行首 skill → 行中 skill）以符合 D5 抑制；⑦ S-8 D4-c 新增「用户消息展示 / 复制 / 历史条目」行（随同一归位序列化，`UserBubble` 按归位序渲染 slash 段为纯文本），场景 6 补气泡 DOM 断言；⑧ S-9 D6 编辑重发行与 §4 场景 12 改为真实路径（消息气泡内联编辑框 → `rebuildSegmentsWithEditedText` → `editAndResend` 直发，不写 composer DOM）；⑨ I-5 D2 草案裸 `return` 改 `return false`（偏差 #2）；⑩ I-6 文档头部加「行号（设计时点 135c1dbab）与轮次口径」注，D1 调用点清单补 `insertSlashChip`（设计时点六处 → D4-a 后 HEAD 七处）；⑪ §5 P1/P4 同步上述改动。
- v5（design-code-sync 轮 3 第 4 轮复审修复，2026-09-10）：① RC-B-3 头部「行号与轮次口径」注升级为规则——**未标「设计时点」的 `file:line` 视为提交时点坐标；设计时点坐标（基线 `135c1dbab`）一律显式标注**，新增/改写引用尽量改「符号 + 文件」表述，不逐轮追平行号；② RC-B-4 §2.1 入口表第 4 行**拆为两行**——SearchModal ⌘K（真正的第三入口，真实描述保留）与 `+` 菜单「命令」入口（`onAddSelect('slash')` 打开行首 slash 浮层，与第 1 行同通路；skill 项经 D3 走 `insertSkillChip`、S-2 后已选禁选生效），导语同步改写，D3「已知不一致」收窄到 SearchModal ⌘K 一项（「后续迭代条件」只覆盖它）；③ RC-B-2 D4-d / §5 P4 / v4 变更历史三处谓词行号改**符号引用**（`submitSegments` / `submitQueuedEntry` 内的 `const needsBackfill`）——原写的绝对行号落在谓词上方的注释行（实测谓词在其下一行），故按新口径规则弃用数字；④ RC-B-5 §2.2 失败模式 D / §3.1 场景 3 / §4 场景 6 三处步骤改为「先选命令 `→` Enter 选中 `→` 光标处补 args」（slash 触发正则 query 捕获段 `\S*` 不含空白，连写会失配关闭浮层），期望产物不变；同模式扫涟漪：§4 场景 7/10 的「草稿中部插 `/compact` chip」改为「多行草稿中间某行行首输 `/compact` → Enter 选中」（slash 浮层只在行首触发，原表述不可执行）；⑤ RC-B-6 §2.4 标题与数据流图 `draft.value` 行加时态限定（基线与 HEAD 同源同序；**HEAD 起**因 `visitSlashChip` 产 slash 段才表现为已归位，基线为拍平无空格形态），消除「基线 draft 也已归位」误读；⑥ RC-B-8 §4 回归清单补 `ui/lib/__tests__/segment-rebuild.test.ts` 行；⑦ RC-B-9 该行等价锁措辞收窄为「**含 slash 段的段序**…（其余 badge 边界间距走 `mr-1`，不计入文本等价）」；⑧ RC-B-10 D6 编辑重发行补登记其余非 text 段的序列化剥离与 **image 恒保留（未修项）**，§4 场景 12 同步补非 text 段不翻倍的通过标准；⑨ 按新口径规则顺带对齐同模式坐标——D4-c 裁决表四行的 `send.ts` 行号改符号（`enqueueDuringDefer` / `sendActiveMessage` / `routeStaging`，消除与 D4-d `send.ts:225` 并存的「同一代码点两套坐标」）、D4-d 的 `send.ts:225` 同改符号、`selection-restore.ts:36` 改 `restoreSelection` 符号引用、`needsBoundarySpace` 的 `segments.ts:88-95` 两处（§2.2 / D4-e）改 `shared/segments.ts` 符号引用，并补 §2.2 / §2.4 / §3.3 D1 收口范围三处「设计时点」截面标注、D4-c 段首时态改为「自 HEAD 起已归位」。**（轮 3 第 5 轮注）**该条 ① 的规则经轮 3 收尾校正为「本文保留的绝对行号均为设计时点（`135c1dbab`）坐标，显式标注者除外」，见头部口径与 v7。
- v6（design-code-sync 轮 3 收尾文档修复，2026-09-10）：G2 口径与实现对齐（RC-A-1）——原表述「浮层**开着**时按 Enter 是『选中候选』」比实现宽：实现（`CommandPopover.vue` 的 `handleKeydown`，轮 3 第 4 轮）先判 `overlayVisible`（= `items.length > 0 || fileFallbackVisible`，与模板 `PopoverContent` 的 `v-if` 逐字同条件），只在浮层**实际可见**时消费 Enter/Tab；不可见态（候选为空的 slash/session/subagent/skill 路）浮层不渲染任何内容，吞掉 Enter 会让消息发不出且无提示。① §1 G2 收紧为「实际可见（有渲染内容）时…」并补不可见态语义（不可见 ⇒ Enter 正常发送属预期；landing `$` 错误/空结果态浮层可见 ⇒ 仍被消费不发送）；② §3.3 D2 补「消费前提 = 浮层实际可见」bullet，同节两处与 §4 回归测试清单 renderer 行的「浮层 open 时」措辞同步改为「实际可见时」（并补不可见态放行的回归锁条目）。实现侧修复与回归锁：`CommandPopover.vue` 的 `overlayVisible` 判定 + `composer-keydown.test.ts` 的 RC-A-1 用例。
- v7（design-code-sync 轮 3 第 5 轮收尾文档修复，2026-09-10）：① §4 回归清单 ui 行等价锁范围按用例实情收窄为「**段序仅含 slash/text 段（无 badge 段）**」，并把含 badge 段的非等价归因补为**两条并存**——(a) badge 边界空格不显式渲染（`UserBubble.boundarySpaceBefore` 只对 `prev.type === 'slash'` 渲染空格，其余 badge 走 CSS `mr-1` 间距、不产文本节点，而 `segmentsToText` 经 `needsBoundarySpace` 对 chip→text 补空格）；(b) badge 段展示投影 ≠ 序列化（file 显 `fileBasename(path)` + 行范围、session 显 `label`、skill/subagent 显 name/slug、image 显缩略图）。(b) 的登记面改引 `composer-multi-skill-injection.md` §3.5-⑤ 的实有标题「`normalizeContent` 纯文本投影面（P0-12 登记）」——原引「展示投影 ≠ 序列化」为该文档不存在的措辞（`UserBubble.test.ts` 的 MF-1 组注释与 `[slash, file, text]` 反例用例为证）。（**轮 3 第 6 轮复审勘误**）本条曾于第 5 轮把归因写成单因 (b)，并判定 (a) 的旧表述「失实」而删除——该判定本身失实：(a) 经代码与段序实测成立（`UserBubble.vue` 的 `boundarySpaceBefore` 与该文件注释「其余 badge 类型沿用自身 `mr-1` 间距，不引入额外文本节点」为证；取投影无差异的段序 `[file('a.ts'), text('正文')]`，序列化 `a.ts 正文` 与气泡文本 `a.ts正文` 的唯一差异即该空格），单因结论被证伪。v5 ⑦ 记录的同款措辞随之被本轮取代；② §1 G2 与 §3.3 D2 的不可见态枚举补 landing `@`（无 sessionId）与 landing `$` 两态（`idle` 拉取中/无 cwd、候选源非空但 query 无匹配），并显式登记后果（Enter 放行 ⇒ 首发送出含触发符字面量的消息并创建 session；判定已接受）；（**轮 3 第 6 轮勘误**）① 行「非空候选四路」补 `$` file 路为**五路**（原枚举漏了最常见的可见态：panel 态 cwd 候选已加载 / landing 成功有文件）；⑥ 行「永不进入 success/error」改「**本次 open 不发请求**（无 cwd，或 1s 节流命中）——节流命中时上一轮 open 的在途回执到达即写回 success/error，idle 是瞬态窗口」；③ §4 回归清单 core 行补括注（`submit.test.ts` / `mutations.test.ts` / `submit-queued-entry.test.ts` 三者未实施，用例归并 `send.test.ts` / `useChat.test.ts`）；④ 同清单 segment-rebuild 行 image 项补「无单测覆盖」标注；⑤ §3.3 D1 收口范围 bullet 的 `useCommandPopoverTrigger.ts:192` 改符号引用（`onAddSelect` 的 slash 分支——基线 `:192` 实为 attach/image 分支收尾，slash 分支起于 `:193`）；⑥ 头部口径补第三类例外（显式标注 HEAD 者，当前 1 处）；⑦（**轮 3 第 6 轮补登记**）第 5 轮代码侧改动进本文登记面：`CommandPopover.vue` 的 `handleKeydown` 的 Enter/Tab 读点对 `activeIndex` 收敛到末项（`onSelect(list[Math.min(activeIndex.value, list.length - 1)])`，防候选源缩短后 `list[activeIndex]` 为 `undefined` 抛错）；`command-popover-symbols.ts` 的 `displayName` 与 `isSkill` 判据同源（`skillDisplayName` 与 `displayName` 消费同一 `isSkill`）；`insertSlashChip` 的 slash 路消费 `selectedSkillNames`（S-2「已选禁选」的落地）。**该修复的残余（已接受）**：候选源缩短后到下一次 ↑/↓ 前模板无行高亮（模板只按 `i === activeIndex` 命中）、该窗口内按 Enter 静默选中末项（`composer-slash-trigger.test.ts` 已把该行为固化为期望）、该窗口内首次 ↑/↓ 均把 `activeIndex` 归 0（`(activeIndex ± 1 + len) % len` 对越界值不收敛到邻项）；判定 = 已接受（越界抛错已消除，残余仅高亮缺失与窗口内选末项）；⑧（**轮 3 第 6 轮补**）image 未修项的方向枚举补齐——D6 编辑重发行 / §4 场景 12 / 回归清单 segment-rebuild 行原只记「翻倍」，补记第二方向「**删除后路径复活**」（用户删掉编辑稿里的路径后 prompt 仍出现该路径：image 段恒保留、不参与剥离），与 `composer-multi-skill-injection.md` §3.5-⑤② 的两方向登记同口径。
- v8（未修项清零轮，2026-09-10）：把设计与计划此前登记的 5 条未修项全部关闭（触发 = 用户要求「对这 5 条都做设计和修复」）。① **SearchModal ⌘K 第三入口合流**——字段链 `SearchItem.isSkill/location` + `PendingSlash.isSkill/location`，消费侧按项类型分流到 `insertSkillChip`（裸名/location/icon），`SearchModal.confirmSel` 显式搬运（§2.1 第 4 行与导语、§3.3 D3 段重写；原「已知不一致」登记关闭；原「location 数据面不存在」的成本论据经复核不成立）；② **image 段编辑重发改「裸路径 token 剥离」**（前/后边界判定；命中 ⇒ 剥该处文本 + 保留段；未命中 ⇒ 丢弃段），原「翻倍 + 删除后路径复活」两方向关闭（D6 行、§4 场景 12 与回归清单 segment-rebuild 行、`composer-multi-skill-injection.md` §3.5-⑤② 同步）；③ **浮层消费条件从「实际可见才消费」改回「open 即消费」**——先为每个 open 态补可见反馈行（「无匹配项」/「加载中」/ 加载失败），「不可见」状态类消失 ⇒ RC-A-1 的否决理由（吞键无反馈）不再成立（G2 行与 §3.3 D2 bullet 重写；②③ 两类的 Enter 由「放行发送」变为「消费不发送」，行为变化显式登记）；④ **候选源缩短的 activeIndex 越界窗口消除**——键盘路由与索引收敛下沉 `packages/renderer/src/composables/panel/command-popover-keyboard.ts`，候选长度变化的同一拍（sync watch）收敛，模板高亮 / Enter 选中 / ↑↓ 起点三处一致（v7⑦ 的残余关闭）；⑤ **runtime 钳制用例的宿主 `models.json` 依赖消除**——测试自注入 `e2e-reasoning-off-probe` 演员并按显式名断言，宿主无该文件时仍 2/2 通过（见实施计划 §7 的 runtime 登记）。测试锚点：ui `segment-rebuild.test.ts` 40 → 46 例；renderer 全量 4094 → 4108 例（`+3 skipped` 不变）；core 全量 1776 → 1781 例；runtime 该文件 2 例（自足化前后同数）。
