# composer 四符号体系重做 + slash 列表动态刷新 设计文档

> **一句话结论**：把 composer 的引用符号体系统一为 `#` session / `@` subagent 定向 / `$` 文件 / `/` 命令（行首限定），四者全部复用既有触发-浮层-chip-Segment 管线与 subagent-workflow extension 底层，新建代码集中在「符号语义层 + @ 直连 RPC + 一次事件接线」；同时修复 panel 态 slash 列表不随 skill 目录变化刷新的断链（runtime 快照无失效路径）。

> **实施状态（2026-08-24，全部单元已落地）**：8 个实现单元全部完成并验收提交——U1 `e522c7460`（触发层/chip/Segment）、U3 `f1f6634d8`（断链修复）、U4 `21578c74f`（extension 命令面，P3/P6 本地 pi 实测通过）、U5 `9a757d7d3`（协议+marker 废弃）、U2a `b98939f37`（浮层多路+符号换绑）、U2c-runtime `e50395e66`（气泡双链路）、U2d `decfad2d9`（sidebar 直引）、U2b `c1de4bfbf`（发送分流+气泡渲染）。探针 P1/P2/P5/P6 ✅、P3 ✅（实测）、P4 部分（序列化有测试，session_read 端到端待真机走查 S4）。**待真机验收**（`pnpm dev` + 真实 pi）：S4 的 session_read 端到端命中、S6 的主 agent 追问衔接、S9 的真实 skill 目录变化端到端。实施期实现位置的一处修正：reload 链路识别点在 `session-entry-mapper`（共享单点，覆盖 RPC+文件 fallback 两路）而非本文 §5 U2 所写的 `entry-tree-builder`；`InjectionRequest` 字段名实施为 `refSessionId`（原 §3.3.4 写的 `sessionId` 与目标路由语义同名冲突）；发送分流点在 `send()` 入口而非 `submitSegments` 内（规避 user 气泡 reload 消失 + isGenerating 卡死）。**U4 后续修正（commit dd70fd6ac）**：pi 0.84.1 中 streaming 期间 `pi.sendMessage` 默认 steer 当前 turn（违背 §3.3.8「不经主 agent LLM」），实现改为按 `ctx.isIdle()` 分流——streaming 时传 `deliverAs: 'nextTurn'`（留痕延迟到下个 turn 落 entry，期间 reload/新开窗口暂看不到该定向气泡），idle 时不传 options（立即落 entry，即本文 §3.3.3 描述的路径）。

**层声明**：本文档是技术方案层设计（接口/数据模型/选型），下一层产物是实现任务拆分（§5）。不跨层到具体测试用例。

---

## 1. 背景目标

### SCQA

- **S（情境）**：xyz-agent 的 composer 输入区已有 `/`（命令/skill）与 `#`（文件引用）两套符号交互；TUI 端 pi（经 session-reader extension）用 `#` 引用 session。
- **C（冲突）**：同一符号 `#` 在 GUI 是文件、在 TUI 是 session，用户跨端混用时语义分裂；`@` 通道废弃闲置；「对 subagent 直接说话」没有入口（只能由主 agent LLM 代为派发）；此外 panel 态对话中 slash 浮层列出的 skill 是 session 激活时的快照，磁盘上增删 skill 后浮层不更新。
- **Q（问题）**：符号语义如何统一？@ 定向对话在没有 pi 原生支持（pi 核心无 subagent 概念）的前提下怎么落地？skill 动态性的断点在哪一层？
- **A（答案）**：本设计（用户已拍板四个决策：`/` 保持行首限定、`@` 采用 chip 单条定向模型、`@` 已开 subagent 范围限当前 session、slash 断链修复纳入本次 scope）。

### 系统是什么（受众：会用 xyz-agent 但不懂内部背景的开发者）

composer 是 xyz-agent 的消息输入区（Vue contenteditable），一条消息从键入到送达 LLM 的管线：

```
用户键入符号（# / $ / @ / /）
  → 触发检测（dom-core：光标前文本正则匹配）        packages/dom-core/src/composer/input/
  → 命令浮层（CommandPopover，候选过滤 + 键盘导航）  packages/renderer/src/components/panel/
  → 选中插入 chip（带颜色/类型的内联徽章）           packages/dom-core chip-commands.ts
  → 发送时解析为 Segment[]（结构化消息段）           packages/shared/src/segments.ts
  → 序列化为 prompt 文本 + segments.json sidecar     → runtime → pi 子进程 → LLM
```

两个关键既有资产（本设计大量复用，均已有生产实现与测试）：

1. **`session_read` 工具**（`extensions/universal/session-reader/`，builtin 强制加载）：LLM 侧工具，接收 `#<sessionId>` 文本即可定位并读取任意 session（支持 find/outline/expand/detail 等 9 个 action）。TUI 端 `#` 引用就是「浮层选中 → 插入 `#uuid` 纯文本 → LLM 调 session_read」。
2. **subagent-workflow extension**（`extensions/universal/subagent-workflow/`，builtin）：`subagent` tool 的 `start`/`message`/`close`/`list`/`cancel` 五个 action 全部实现——subagent 是长驻 pi 子进程，`message` action 已支持多轮续聊（热路径 stdin 直写 prompt / 冷路径 `--session` 续写）。**当前唯一入口是主 agent LLM 调 tool，GUI 无直连通道**。

### 设计目标

| # | 目标（使用者体验倒推） |
|---|---|
| G1 | 四符号语义统一：`$` 文件引用（接替现 `#`）、`#` session 引用（对齐 TUI）、`@` subagent 定向、`/` 命令保持行首限定；触发规则统一为「行首或空格后，bash 模式豁免」（`/` 仅行首） |
| G2 | `#` 引用的 session 覆盖左侧边栏全部 session（跨 cwd 分组），选中后 LLM 能用 session_read 读取 |
| G3 | `@` 可选择当前 session 已开的 subagent 或新建，选中后该条消息**直达 subagent、不经主 agent LLM**，主聊天流可见这条定向消息的去向 |
| G4 | panel 态对话中 slash 浮层实时反映 skill 目录变化（增删 skill 后无需切 session） |
| G5 | 历史消息零破坏：升级后旧 session（含 `#` 文件 chip 的消息）渲染与编辑行为不变 |

### In / Out of scope

**In**：上述 G1–G5；`/` 触发实现正则化（行为等价）；`message.send.subagent` 半成品 marker 通道的废弃清理。

**Out**（显式排除，后续演进）：
- `@` 对话模式（composer 切换为「与 subagent X 对话」的模式态，模型 B）
- `@` 已开 subagent 跨 session 引用（扫 `agentDir/subagents/` 全历史）
- `@` 新建时选择 agent .md 清单（见 D3，MVP 用默认 agent）
- `#` 引用 subagent 的 session 文件（session-reader 工具层支持，浮层不单列，LLM 可用 `#id` 自行定位）
- landing 态（无活跃 session）的 `@`/`#` 浮层（无数据源，不触发）

---

## 2. 现状与问题分析

**现状管线是健康的，问题集中在三处：符号语义分裂（历史演化无对齐点）、@ 缺一条不经主 agent 的直连通道（且存在一个模型错误的半成品）、pi reload 后 runtime→renderer 的命令快照刷新断链（两处接线缺失）。**

### 2.1 使用者视角现状

| 符号 | GUI 现状 | TUI 现状（对照） |
|---|---|---|
| `#` | 文件引用：`#` + 文件名弹层 → 绿色 file chip → 发送后 prompt 含裸路径，LLM 自行 read | session 引用：`#` 弹最近 session（年龄 + 标题预览）→ 插入 `#uuid` 文本 → LLM 调 session_read |
| `/` | 命令/skill 浮层：仅当**全文第一个字符**是 `/` 且无 chip 时触发 | 行首 `/` 触发 |
| `@` | 无任何行为（提及通道已废弃，`getMaimCandidates` 恒返回空） | 无 |
| `$` | 无任何处理 | 无 |

真实失败模式（使用者可感知）：

1. 用户在 TUI 用惯了 `#` 引用 session，到 GUI 输入 `#019e6c96...` 得到的是文件过滤浮层——语义冲突。
2. 用户想追问一个后台 subagent「刚才那个结果再展开讲讲」，只能重新组织语言发给主 agent、由主 agent 转述——绕路且主 agent 上下文被无谓占用。
3. 用户在对话中途往 `~/.agents/skills/` 加了一个新 skill，打开 `/` 浮层没有它；pi 侧其实已经 reload 完成（新 skill 已可执行），但浮层列表是旧的。切走再切回该 session 才能看到。
4. bash 模式（`!` 前缀）下输入 `!echo $HOME`——若 `$` 按目标规则实现，空格后的 `$` 会误弹文件浮层（现状无 bash 豁免机制，`isBashMode` 只驱动视觉样式，见 `packages/core/src/domain/composer/dispatch/bash.ts:61`）。

### 2.2 现状物理数据流（符号交互链路）

```
[输入事件] contenteditable onInput
   ├─ slash 检测：text.startsWith('/') && 无 chip      (contenteditable.ts:146)
   ├─ hash 检测：光标前文本 /(?:^|\s)#(\S*)$/          (input-dom.ts:187-198)
   ↓ emit slash-trigger / file-trigger
[浮层] CommandPopover (type: 'slash' | 'file' 二路硬编码)
   ├─ slash 源 = CommandRegistry 声明 ∪ commandStore(pi 真源)   (CommandPopover.vue:153-184)
   │    pi 真源 ← session.commands 广播 ← runtime commands 快照 ← pi get_commands RPC
   └─ file 源 ← file.search RPC → FileNode[]
[选中] onCmdSelect → clear query 文本 → insert chip
   ├─ slash-chip / mention-file(chip) / mention-at(存在但序列化降级纯文本)
[发送] getSegmentsFromEl → Segment[] → segmentsToText → prompt 文本
   └─ Segment 联合: text | skill | file | mention(死类型，无生产者) | image | handoff
```

### 2.3 根因分析

**R1 符号语义分裂**：GUI 的 `#`=文件先于 TUI session-reader 的 `#`=session 落地，两端各自演化没有对齐点。`@`/`$` 从未占用。chip/Segment 管线是单符号绑定的（`insertMentionChip('#', name)` 硬编码产出 file chip），语义换绑需要把「触发符号」与「chip/Segment 类型」解耦。

**R2 @ 无直连通道**：pi 核心无 subagent 概念（pi 0.84.1 dist 全量 grep `subagent` 零命中，已核实），全部能力在 subagent-workflow extension。extension 的 `/subagents` 命令在 RPC 模式只解析 `cancel` 一个 action（`interface/command-actions.ts:60-78`）。runtime 曾尝试 `message.send.subagent` 字段——把 `{agent, task}` base64 编进 marker 前缀发给**主 agent** 的 prompt（`message-dispatcher.ts:72-78`），但该 marker 在 extension 侧零消费方（全仓 grep 确认），是半成品：模型本身也错了（经主 agent 转发，违背「直达 subagent」的目标）。

**R3 panel 态 slash 列表静态化**。链路逐层核实：

```
skill 目录变化 → SkillRegistry chokidar watcher（300ms debounce，已建，usePolling 修过 macOS 丢事件）
  → onChange → ①broadcast config.skillCacheInvalidated（landing 态刷新用，链路完整有测试）
             → ②ReloadOrchestrator → idle session 立即 / running session 排队
                  → client.prompt('/__xyz_reload__') → extension handler → ctx.reload()
                  → pi 重扫 extensions/skills/prompts/themes（session 不重启）   ← pi 侧 OK
  → reload 完成信号回传：pi 的 session_start(reason='reload') 事件只发给 extension runner
     （agent-session.js:2072 走 _extensionRunner.emit），不出 RPC stdout——runtime 不可达（对照
     agent_settled 是双发 :330-331，session_start 单发 extension-only）         ← 断点 1
  → commands 快照（ReplicatedState）唯一失效点是 session.getCommands RPC 查询
     （session-service.ts:1949-1955「本方法是 commands 失效信号的全部汇聚点」），
     而该 RPC 在 renderer 无任何生产调用方（仅有 API 定义）                      ← 断点 2
  → session.commands 不再广播 → CommandPopover/commandStore 停留在 session 激活时刻的快照
```

即：pi 侧动态性已由 W5（ReloadOrchestrator）建成，断的是「runtime 已知 reload 完成（promptReload resolve）→ 快照失效重拉 → renderer 更新」的接线，两处缺失。好消息是 reload 完成时机 runtime 本来就知道：pi `prompt()` 对 extension 命令是 `await _tryExecuteExtensionCommand`（`agent-session.js:800`，handler 完成后短路返回），**`client.prompt('/__xyz_reload__')` 的 promise resolve 即 reload 完成**——失效信号可在现有 ReloadOrchestrator 调用点直接接线，无需依赖 pi 事件流。

### 2.4 关键事实清单（设计依据，全部来自源码核实）

| # | 事实 | 出处 |
|---|---|---|
| F1 | `#` 触发正则已是 `(?:^|\s)#(\S*)$`（空格/行首，全角空格也算 `\s`） | `input-dom.ts:196` |
| F2 | `/` 触发是全文 `startsWith('/')` + 无 chip；`clearSlashQueryText` 是清空整个输入框（与 hash 的「只删 query 段」不一致） | `contenteditable.ts:140-148, 233-247` |
| F3 | `mention-at` chip 存在但无 dataset/无 × 按钮/序列化降级纯文本；`{type:'mention'}` Segment 是无生产者死类型 | `chip-commands.ts:159-184`、`segments.ts:43` |
| F4 | pi RPC `prompt` 响应只有 success 无 payload——extension 命令的结构化返回值不能经 prompt 通道回传 | pi `rpc-mode.js:300-313` |
| F5 | subagent `message` action 续聊机制完整（热路径 stdin prompt + streamingBehavior / 冷路径 `--session` 重 spawn 续写 + EPIPE 兜底），handler `messageHandler`/`startHandler`/`closeHandler` 均已存在 | `subagent-service.ts:901-970`、`subagent-actions.ts:354-397` |
| F6 | `session.getSubagents` RPC（runtime 直读主 session JSONL，不依赖 pi 进程）+ `session.subagents` 广播 + `subagent.stream_delta` 实时流 + renderer subagent 虚拟 session（`subagent:<mainSid>:<subId>`）均已就绪 | `protocol.ts:348-349, 940-941`、`stores/subagent.ts:247-255` |
| F7 | runtime 零 import extension 源码（依赖边界既有约定，runtime deps 无任何 `@zhushanwen/pi-*`） | `packages/runtime/package.json` |
| F8 | pi 的 `session_start(reason)` 事件是 extension-only：只走 `_extensionRunner.emit`（`agent-session.js:2072`），不经 AgentSessionEvent 流出 stdout；而 `prompt()` 对 extension 命令 `await _tryExecuteExtensionCommand`（`agent-session.js:800`）——`client.prompt('/__xyz_reload__')` resolve 即 reload 完成，runtime 侧已持有完成时机 | pi `agent-session.js`（已核实，见 D4 探针 P1） |
| F9 | 已落盘 segments sidecar 回读是整体透传不按类型 switch，`file` segment 的渲染/编辑链路完整 | `entry-tree-builder.ts:84`、`UserBubble.vue:29-66` |
| F10 | extension 自描述 entry 范式已存在（subagent-record entry 落主 session JSONL，runtime extractor 消费） | `subagent-extractor.ts` |

---

## 3. 解决方案

**方案主干是复用：触发-浮层-chip-Segment 管线原样保留并参数化（符号与 chip 类型解耦），@ 定向对话走「subagentAction 扩展 + /subagents 命令面扩展」对称既有惯例（extension 底层 handler 零新写），断链修复是两处一次性接线。六个关键决策（D1–D6）各有方案对比与推荐。**

### 3.1 终态（使用者视角）

#### 3.1.1 `$` 文件引用（接替 `#`，交互与现状 `#` 完全一致）

```
用户输入：帮我看看 $composer-injection-store 的实现
                          └ 浮层弹出：composer-injection-store.ts  packages/renderer/src/composables/panel/
选中回车 → 绿色 file chip「composer-injection-store.ts」→ 发送
→ pi prompt 含裸路径 packages/renderer/src/composables/panel/composer-injection-store.ts
→ LLM 自行 read（现状链路，零变化）

失败路径：无新增失败面（复用现有 file.search RPC；RPC 失败时浮层空列表，输入继续，Esc 关闭）。
```

#### 3.1.2 `#` session 引用（新语义，对齐 TUI）

```
用户输入：# 然后继续输入 #fix-com
→ 浮层弹出 session 列表（数据源 = sidebar 同款 sessionStore.groups）：
    ┌ 01m  fix-composer-command-enhance 设计讨论   (当前项目)
    │ 2h   xyz-ui 组件库 review                    (~/Code/xyz-ui)
    │ 3d   pi-mono 上游调研                        (~/GitApp/pi-mono)
    └ （按 lastActiveAt 降序，query 按 label/id 子串过滤，跨 cwd 分组展示）
选中回车 → 紫/session chip「fix-composer-command-enhance 设计讨论」（显示 label，非 uuid）
→ 发送 → prompt 序列化为 #<sessionId>（36 位 uuid，对齐 TUI 协议）
→ LLM 调 session_read 工具（guidelines 已随 extension 注入）定位并读取该 session

失败路径：引用的 session 文件已被删除 → session_read 工具返回可读错误
（工具层已有：uuid 不匹配时的提示）→ 用户看到 LLM 报「找不到该 session」→
恢复动作：重新 # 选择正确的 session。
```

侧边栏直引（G2 附加入口）：sidebar SessionItem 右键/悬浮菜单加「引用到输入区」→ 经现有 `composerInjectionStore` 通道插入 session chip（`InjectionRequest` 扩展 `sessionId` 字段，见 3.3.4）。

#### 3.1.3 `@` subagent 定向对话（模型 A：chip 单条定向）

```
场景 1（已开 subagent 追问）：
用户输入：@ 然后输入 @build
→ 浮层弹出（数据源 = session.subagents，仅当前 session）：
    ┌ build-api   agent: worker   ● running   01m 前启动
    │ test-auth   agent: verifier ○ closed    2h 前
    └ ＋ 新建 subagent
选中 build-api → 蓝/subagent chip「@build-api」→ 用户继续输入「刚才的测试结果再展开讲讲」
→ 发送 → 消息经新 RPC 直达 extension（不经主 agent LLM，主 session 无新 turn）
→ 主聊天流出现一条定向消息气泡「→ @build-api：刚才的测试结果再展开讲讲」
→ subagent 处理结果在 sidebar Agents tab / SubagentTab（subagent 虚拟 session）可见

场景 2（新建）：
@ 浮层选「＋ 新建 subagent」→ 插入 chip「@新任务」（占位 slug，MVP 不选 agent .md，见 D3）
→ 输入 task 文本作为首条消息 → 发送 → extension start（conversation:true 可续聊）
→ session.subagents 出现新 record → 后续 @ 它继续对话（回到场景 1）

失败路径与恢复：
- 目标 subagent 已 closed 且不可 resume → extension 返回错误 → renderer toast
  「subagent 已结束，无法续聊」→ 恢复动作：@ 新建（extension 冷路径对 resumable 的
  record 会自动 --session 重启续写，已建，只有彻底 closed 的才报错）。
- WS/RPC 失败 → 发送失败，消息留在输入区（复用现有 draft 保留行为），重试即可。
```

#### 3.1.4 `/` 命令（单行行为不变，多行行首放宽，实现正则化）

行首 `/` 触发浮层（「帮我看看 /usr/local/bin」不弹层，与现状一致）；多行输入的**任意行**行首 `/` 从「仅全文首字符」放宽为「每行行首」（对齐 TUI，D5）；实现从 `startsWith` 改为光标前正则，`clearSlashQueryText` 从「清空整个输入框」改为「只删 `/query` 段」（与其他符号一致，也修复现状小 bug：行首 `/cmd` 后中途输入其他内容再触发时的全清问题）。

#### 3.1.5 slash 列表动态刷新（G4）

```
panel 态对话中，用户在 ~/.agents/skills/ 下 mkdir new-skill && 写 SKILL.md
→ watcher（300ms debounce）→ pi reload 完成（promptReload resolve，F8）
→ runtime commands 快照失效重拉 → session.commands 广播 → commandStore 更新
→ 用户再按 / 打开浮层（或已开浮层即时刷新）：new-skill 出现在列表 → 选中执行成功

失败路径：pi reload 失败（进程异常）→ ReloadOrchestrator best-effort 已记日志，
commands 快照保留旧值（ReplicatedState 失败退避机制已有）→ 下次 skill 变化重试。
浮层打开时的主动拉取（D4 路径 2）兜底：即使事件链全断，打开浮层即触发一次重拉。
```

### 3.2 方案对比（每个决策独立成条）

#### D1 `#` session 引用的 Segment 承载：新增 `{type:'session'}` vs 复用死类型 `{type:'mention'}`

| | 方案 a：新增 `session` type | 方案 b：激活 `mention` type |
|---|---|---|
| 长期合理性 | 语义自描述（`{type:'session', sessionId, label}`），序列化 `#uuid`、渲染、restore 各一个 case，类型层无歧义 | `mention` 是通用提及语义，将来 `@` subagent、`@` 用户都可能想用；给 session 独占后命名与语义错位 |
| 短期成本 | shared 类型 + 4 处 case（序列化/解析/渲染/restore） | 同样要改 4 处（死类型也要补生产者链路），成本相同 |
| 风险 | 无 | 三个月后「mention 到底是什么」成为考古题 |

**推荐 a**。被否理由已列。`mention` 死类型保留不动（不删，未来 @ 人/实体再用；本次 `@` subagent 用独立 `{type:'subagent'}`，同理由）。

#### D2 `@` 消息直达通道：扩展 `session.subagentAction` vs 修补 marker vs 新独立 RPC

| | 方案 a：`subagentAction` 扩展 action 联合 + `/subagents` 命令面同步扩展 | 方案 b：修补 `message.send.subagent` marker | 方案 c：新 RPC `session.subagentMessage` |
|---|---|---|---|
| 长期合理性 | 对称既有惯例：`session.workflowAction` 就是 `{action: 'pause'\|'resume'\|'abort'}` 联合经 `client.prompt('/workflows ...')` 转发 extension（protocol.ts:352 注释明言对称模式）；extension 侧 `parseSubagentRpcCommand` 扩 action 即可，handler 全部已存在（F5） | 模型错误：marker 拼进 prompt = 消息仍进主 agent LLM 上下文，违背「直达」目标；且 marker 无人解析 | 与 a 等价但多一个 WS 命令；a 复用现有命令面 |
| 短期成本 | protocol action 联合扩 `'message' \| 'start'` + runtime 转发 + extension 解析 + 文本转义协议 | 需要新写 extension 侧 marker 解析器（从零） | 同 a |
| 风险 | `client.prompt` 的文本转义（message 含空格/引号/换行）需协议约定（3.3.3） | 主 agent 上下文污染 + 半成品语义残留 | 无实质差异 |

**推荐 a**，并**废弃 marker 通道**（protocol `message.send` 删除 `subagent?` 字段 + runtime `sendSubagentMessage` 删除，git 历史可考）。

#### D3 `@` 新建时 agent .md 清单的获取通路

| | 方案 a：MVP 不选清单（默认 agent + task 即启动） | 方案 b：extension 命令回传清单（appendEntry 自描述 entry → runtime 事件 → WS） | 方案 c：runtime 依赖 `@zhushanwen/pi-subagent-workflow` 包 import agent-registry |
|---|---|---|---|
| 长期合理性 | 首期减法；后续若需要清单，b 是正路（自描述 entry 范式已有，F10）；不锁死路径 | 范式成立但为低频功能引入「命令→entry→事件→广播」四跳 | 破坏 F7 依赖边界（runtime 与 extension 两个发布单元耦合，版本漂移风险——workflow-extractor 已为此类漂移付过三源一致性测试的代价） |
| 短期成本 | 零（extension start 的 `agent` 参数本就可选） | 中（extension + runtime + renderer 三端） | 低但埋雷 |
| 风险 | 新建的 subagent 全走默认 worker 行为（task 书自包含约束下可接受，zsub 自身用法即如此） | 复杂度前置 | 架构债 |

**推荐 a**（已拍板范围限当前 session，清单同样后置）。Out-of-scope 已声明。

#### D4 slash 断链修复：失效信号怎么接

| | 方案 a：双路（promptReload resolve 接线 + 浮层打开主动拉） | 方案 b：翻译 session_start 事件（已核实不可行，记录防再走） | 方案 c：commands 实例周期兜底 poll |
|---|---|---|---|
| 长期合理性 | 失效信号挂在 runtime 已持有的 reload 完成时机上（F8：prompt resolve = reload 完成），零新依赖、零时序猜测；主动拉兜底同时修复 AGENTS.md 登记的「broadcast 时序竞争」（切 session 后主动消费 session 级状态） | `session_start(reason='reload')` 只走 `_extensionRunner.emit` 不出 stdout（F8，P1 探针核实），runtime 永远收不到——event-adapter 加 case 是死代码 | 轮询违背事件驱动范式；thinkingLevel 有 30s 兜底先例但那是高频变化字段 |
| 短期成本 | ReloadOrchestrator.doReload 成功路径 +1 行失效调用 + session-service 暴露 1 个失效方法 + renderer 浮层开时 1 次 RPC | —（不可行） | 1 行配置 |
| 风险 | 无（两路幂等：markDirty 防抖聚合；reload 进行中 commands 快照保留旧值不空转） | — | 无效轮询开销 |

**推荐 a**。接线点：`ReloadOrchestrator.doReload` 的 `await promptReload(sessionId)` 成功返回后调 `sessionService.handleSessionReloaded(sessionId)`（→ `commands.markDirty()`，W8「事件只做失效」范式不变，只是失效源从事件改为调用点）；失败路径（catch）不失效——快照保留旧值，下次 skill 变化重试。探针断言见 §5.1 P1/P2。

#### D5 `/` 触发实现正则化

`startsWith` → 光标前文本正则（光标所在行行首限定）。**行为差异显式声明**：单行场景完全等价（空格后 `/` 均不触发）；多行输入（shift+enter）场景是**放宽**——现状只在全文第一个字符触发，多行第二行及以后的行首 `/` 现状不触发、目标会触发（对齐 TUI 每行行首语义，多行起草后在中段行首调命令是合理预期）。同时 `clearSlashQueryText` 从全清改为只删 query 段（对齐 hash 的 `boundaryLen` 模式，修复现状「中途触发时全清输入框」的小 bug）。**否决项**：不放宽到空格后触发——「帮我看看 /usr/local/bin」类路径文本在编程助手场景高频，空格触发误报率高；业界（Claude Code、pi TUI）slash 均行首限定；`/` 的语义是「行首动作」而非「行内引用」，触发差异由语义差异支撑（用户已拍板）。

#### D6 bash 模式豁免与 `$` 误弹噪声（新增全局规则 + 登记取舍）

**bash 豁免**：draft 以 `!`/`!!` 开头（`isBashMode`）时，所有符号触发检测短路（不弹任何浮层）。实现点：`onInput` 触发检测前读 bash 态（经 callback 注入或 dom-core 导出 setter）。**否决项**：仅豁免 `$`（不豁免 `#`/`@`）——bash 命令文本里 `#` 是注释符、`@` 出现在各类语法中，一致豁免比按符号豁免简单且无歧义。

**`$` 误弹噪声（登记为已知取舍）**：普通消息文本里空格后 `$`（` $HOME`、` ${var}`、` $100`）会弹文件浮层——`$` 在自然文本/代码中的出现频率高于 `#`，这是符号选择的固有噪声。缓解已内建：CommandPopover 现状 `v-if="open && items.length > 0"`（空候选不渲染浮层）——query 无文件命中时浮层不出现；有命中时 Esc 即关，输入不受打断。**否决项**：query 首字符字符集白名单（如仅字母开头才弹）——会误伤 `$100-test.md` 类合法数字开头文件名，复杂度不值。若实测噪声不可接受，再加白名单规则（实施期反馈回路）。

### 3.3 接口与数据模型

#### 3.3.1 dom-core 触发层（符号与 chip 解耦）

```ts
// input-dom.ts —— 触发检测函数族（统一范式，照 detectHashTriggerFromEl 模式）
detectFileDollarTriggerFromEl(): { query } | null   // /(?:^|\s)\$(\S*)$/   （新）
detectSessionTriggerFromEl():   { query } | null    // /(?:^|\s)#(\S*)$/    （沿用现 hash 实现，语义改名）
detectSubagentTriggerFromEl():  { query } | null    // /(?:^|\s)@(\S*)$/    （新）
detectSlashTriggerFromEl():     { query } | null    // /^\/(\S*)$/（光标所在行行首限定，改 startsWith 实现）
// contenteditable.ts onInput：bash 模式短路（isBashMode 注入）后依次发射
//   onSessionTrigger / onSubagentTrigger / onFileDollarTrigger / onSlashTrigger
// clear 函数族：clearSessionQueryText / clearSubagentQueryText / clearFileDollarQueryText
//   + clearSlashQueryText 改为「只删 /query 段」（对齐 clearHashQueryText 的 boundaryLen 模式）
```

#### 3.3.2 Segment 与 chip（shared 类型 + dom-core）

```ts
// packages/shared/src/segments.ts —— Segment 联合新增两 case（F9：回读整体透传，新类型对旧消息零影响）
| { type: 'session';   sessionId: string; label: string }   // 渲染显示 label，序列化 #sessionId
| { type: 'subagent';  subagentId: string; slug: string }   // 渲染显示 @slug，不参与 prompt 序列化（路由标记，见下）

// segmentsToText：session → `#${sessionId}`（对齐 TUI 协议，session_read stripHash 消费）
//                subagent → ''（不进 prompt 文本；发送分流依据，见 3.3.5）

// chip-commands.ts：
//   insertFileChip 保持（触发符号换 $，产出 file segment 不变——F9 历史兼容的根基）
//   insertSessionChip(sessionId, label)：新 chip 类型（紫/session 配色，label + × 按钮 + dataset）
//   insertSubagentChip(subagentId, slug)：改造现 mention-at（补 dataset/× 按钮/结构，F3）
// getSegmentsFromEl：新增两类 chip 的解析分支；UserBubble.vue 新增两个渲染分支；
//   restore.ts 补两类（发送失败恢复，现状只处理 image/skill/file）
```

#### 3.3.3 extension 命令面扩展（subagent-workflow）

```ts
// interface/command-actions.ts —— parseSubagentRpcCommand 扩 action：
'subagents message <recordId> <text...>'   // text 为剩余全量（到行尾），含空格/引号原样；
                                           // 换行用 \n 字面转义（composer 输入经此协议编码）
'subagents start <slug> <task...>'         // conversation:true 固定（GUI 定向对话场景可续聊）
// handler 直接接线已存在的 messageHandler / startHandler（F5，service 层零改动）
```

**定向消息的留痕载体：`pi.sendMessage` 的 custom_message entry（一 entry 双消费）**。message/start 成功后，extension 调 `pi.sendMessage({ customType: 'subagent-directive', content: <定向文本>, display: <slug 与方向元数据>, details: { subagentId, slug, direction: 'user' } }, /* 不传 triggerTurn */)`，不选 `pi.appendEntry` 的理由：

1. **主 agent 上下文留痕**：custom_message entry 被 pi 的 `sessionEntryToContextMessages` 转为上下文消息（`session-manager.js:163-189`，与 plain custom entry「不参与 context」不同）——主 agent 下次 turn 可见「用户向 subagent X 发送过什么」，后续「刚才那个结果怎么样」的追问能衔接。若用 appendEntry（plain custom entry 不进 context），主 agent 对定向对话完全失忆，用户在主对话里追问将得到「不知道你在说什么」（§2.1 失败模式 2 的变体）。
2. **渲染源统一**：custom_message entry 同时是 renderer 定向气泡的渲染源（见 3.3.3a），live 与 reload 两链路消费同一载体。
3. **不唤醒主 agent**：`sendMessage` 不传 `triggerTurn` 时不产生新 turn（pi `types.d.ts:298-302`）——留痕 ≠ 处理，「不经主 agent LLM 处理」的结构性保证保持（见 3.3.8）。

#### 3.3.3a 定向消息的渲染双链路（G3「可见去向」的实现设计）

现状 custom entry 在 renderer 的消费面不支持「聊天流插消息」（历史重建只认 `xyz.client-msg-id`，其余 customType 跳过；live 侧 custom entry 只驱动派生缓存刷新 subagent 列表）——定向气泡需要新通路，且必须满足 AGENTS.md 关键规则 9「实时链路 + 重开 session 仍可见」：

```
[live 链路] pi sendMessage 落 custom_message entry → entry_appended 事件（customType=subagent-directive）
  → runtime event-adapter 新增 case：翻译为定向消息 broadcast（带 sessionId，规则 7）
  → renderer 聊天流插入定向气泡（「→ @slug：text」特殊样式，非 user/assistant 气泡）
[reload 链路] 重开 session → getHistory → entry-tree-builder / convertPiHistory
  新增 subagent-directive custom_message 识别 → 重建为同一形态的定向气泡（live ≡ reload）
```

#### 3.3.4 WS 协议与 runtime（shared/protocol + runtime）

```ts
// protocol.ts：
'session.subagentAction': { sessionId; action: 'cancel' | 'message' | 'start'; subagentId?; text?; slug?; task? }
//   （action 联合扩展，对称 workflowAction 惯例；'message' 带 subagentId+text，'start' 带 slug+task）
'message.send': 删除 subagent 可选字段（marker 通道废弃，D2）
// renderer 发送分流（core useChat.submitSegments）：
//   segments 含 subagent 段 → session.subagentAction(message/start) RPC（不经 client.prompt 主 agent 通道）
//   同时照常写 segments.json sidecar + 主 session 由 extension 的 subagent-directive entry 留痕
// InjectionRequest（drawer 注入通道）扩展 { sessionId?: string; label?: string }（sidebar 直引入口）
```

#### 3.3.5 slash 断链接线（runtime + renderer）

```ts
// runtime ReloadOrchestrator.doReload：await promptReload(sessionId) 成功返回后
//   → sessionService.handleSessionReloaded(sessionId)   // 新增失效方法
//     → replicatedStates.get(sessionId)?.commands.markDirty()   // W8「事件只做失效」范式
//     → 防抖重拉 get_commands → fetchCommandsSnapshot 挂钩自动 publish session.commands（已有）
//   （promptReload resolve = reload 完成的时机依据见 F8；失败路径 catch 不失效，快照保留旧值）
// renderer：CommandPopover 打开（cmdOpen false→true）且 type='slash' 且有 sessionId 时
//   → sessionApi.getCommands(sessionId)（查询即失效 + 顺带拿最新值回填 commandStore）
//   → 兜底所有广播丢失/时序场景；与失效路幂等（markDirty 防抖聚合）
```

#### 3.3.6 错误规格（每错误配恢复指引）

| 错误 | 层 | 用户所见 | 恢复动作 |
|---|---|---|---|
| session_read 定位失败（session 已删/uuid 错） | extension 工具 | LLM 转述「找不到 session」（工具已有可读错误） | 重新 `#` 选择有效 session |
| @ 目标 closed 且不可 resume | extension → RPC error | toast「subagent 已结束」 | `@` 新建，或看 SubagentTab 历史结果 |
| @ 目标进程死但 resumable | extension 冷路径自动 resume（F5 已建） | 无感（首次回复延迟数秒） | — |
| `/subagents message` 转义破损（换行丢失） | extension 解析 | 消息文本异常 | 文本 `\n` 转义协议单测覆盖；异常时 extension 报可读错误 |
| commands 重拉失败（pi 进程异常） | runtime ReplicatedState | 浮层保留旧列表（快照不空转） | 退避重试已有；下次浮层打开主动拉兜底 |
| WS 断连时发送 @ 消息 | renderer | 消息留输入区（draft 保留行为） | 重连后重发 |
| 新 skill 未出现 | 全链 | 浮层无新 skill | 检查 `~/.xyz-agent/logs/` runtime 日志 skillRegistry watcher；开浮层触发主动拉 |

#### 3.3.7 改造后物理数据流（@ 定向消息全链）

```
[renderer] 用户消息 = [subagent chip(@build-api), text(展开讲讲)] + 普通 segments
  → submitSegments 分流：含 subagent 段
  → WS session.subagentAction {action:'message', subagentId, text}
[runtime] message-dispatcher → client.prompt('/subagents message <id> <text>')
[pi 主进程] extension 命令短路（不经 LLM）
  → messageHandler → deliverMessage：热路径 stdin prompt / 冷路径 --session 重 spawn
[pi 主进程] sendMessage('subagent-directive') 落 custom_message entry → entry_appended 事件
[runtime] event-adapter → ①聊天流定向气泡 broadcast（3.3.3a live 链路）
                        ②subagent-extractor 派生缓存刷新 → session.subagents 广播
[renderer] 聊天流渲染定向气泡；subagent 回复经 subagent.stream_delta（实时）/
  session.getSubagentHistory（虚拟 session）呈现——两链路均已存在（F6）
[主 agent 上下文] custom_message entry 经 sessionEntryToContextMessages 进入 context——
  主 agent 下次 turn 可见定向消息（留痕 ≠ 处理，无新 turn，见 3.3.8）
```

### 3.3.8 方案边界：两个「不经主 agent」命题的显式区分

1. **不经主 agent LLM 处理（结构性保证，拍板目标）**：定向消息走独立 RPC 分流（`session.subagentAction` → extension 命令短路），不产生主 agent turn；`@` chip 的 subagent segment 序列化为空串，不进 prompt 文本。若实现中发现主 agent 产生 turn 或 prompt 残留 `@slug` 文本，即为 bug。
2. **主 agent 上下文有留痕（设计决策，非目标但必要）**：定向消息以 custom_message entry（`subagent-directive`）落主 session 并进入主 agent 上下文（3.3.3 第 1 条理由）——否则用户在主对话里追问「刚才那个结果怎么样」会得到主 agent 失忆式回答。留痕不唤醒（sendMessage 无 triggerTurn），主 agent 仅在**下一次被正常对话触发时**看到这些记录。
3. **@ 消息内容对主 agent 可见**是接受的产品取舍（subagent 对话内容非私密于主 agent）；若未来需要「主 agent 不可见」的私密定向，再评估脱敏留痕，本期不做。

---

## 4. 验收（真实场景，非单测）

**10 个场景覆盖全部 5 个目标，含 3 个负面反向验证（S2/S3/S8：不该发生的不发生）与 2 个失败路径（S5/S8：错误可读 + 有恢复动作）；每个场景可独立执行回归。**

> 运行环境：`pnpm dev` 真实 Electron app（非 mock）；pi 侧按 AGENTS.md 约定先用本地 pi CLI RPC 实测 extension 改动，再进 GUI 联调。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|---|---|---|
| S1 | `$` 文件引用（G1） | 打开任一 session，输入 `$composer-injection` | 浮层列出该文件（basename + 父目录两行）；选中发送；检查 runtime 日志 pi prompt 含完整路径；LLM turn 中出现文件内容引用 |
| S2 | bash 豁免（G1） | 输入 `!echo $HOME` 回车 | 输入过程无任何浮层弹出；bash 正常输出 home 路径 |
| S3 | `/` 行首限定（G1） | a) 输入「帮我看看 /usr/local/bin 的配置」b) 行首输入 `/` c) shift+enter 多行输入后，光标置于第二行行首输入 `/compact` | a) 全程无 slash 浮层；b) 浮层正常弹出且 query 过滤生效；c) 浮层弹出（多行行首放宽，D5 显式声明的行为） |
| S4 | `#` session 引用（G1/G2） | sidebar 有 ≥2 个不同 cwd 的 session；输入 `#` 再输 label 前缀 | 浮层跨 cwd 分组列出、按最近排序、query 过滤命中；选中发送后 LLM 调 session_read 返回该 session 的大纲/内容（turn 中可见工具调用与结果摘要）；chip 显示 label 非 uuid |
| S5 | `#` 失败路径（G2） | 手动删除某已结束 session 的 JSONL 文件后引用它 | LLM 收到 session_read 可读错误并转述；用户重新 `#` 选择成功 |
| S6 | `@` 已开定向（G3） | 主 agent 先派一个 subagent（正常对话让它调 subagent tool）运行中；输入 `@` 选它，发送「汇报当前进度」；随后 a) 观察 subagent 侧 b) 重开该 session c) 向主 agent 追问「刚才那个进度汇报说了什么」 | 主 session 聊天流**无新 assistant turn**（主 agent 不消耗）；出现定向消息气泡「→ @slug」；subagent JSONL（`~/.xyz-agent/pi/agent/subagents/`）出现该文本；a) SubagentTab/虚拟 session **即时**可见 subagent 回复（stream_delta 实时流）；b) 重开后定向气泡仍在（规则 9 live ≡ reload）；c) 主 agent 能衔接回答（custom_message 留痕进上下文，3.3.8） |
| S7 | `@` 新建（G3） | `@` 选「新建」，输入 task 发送 | session.subagents 出现新 record（sidebar Agents tab 可见）；subagent 开始执行；再次 `@` 该 subagent 可续聊 |
| S8 | `@` 失败路径（G3） | 对已 closed 且非 resumable 的 subagent 发定向消息 | toast「subagent 已结束」；消息不静默丢失（留在输入区或明确失败提示） |
| S9 | slash 动态（G4） | panel 态对话中 `mkdir ~/.agents/skills/test-dyn-skill && 写 SKILL.md`；等 2s；再按 `/` | 浮层出现 test-dyn-skill；选中执行成功；期间主 session 上下文无中断（reload 不重启 session） |
| S10 | 历史兼容（G5） | 升级前构造含 `#` 文件 chip 的消息落盘；升级后打开该 session | 旧消息 file chip 渲染正常、可点开详情、editAndResend 不丢 file 段 |

每个场景可独立执行与回归；S1–S5 依赖 U1+U2，S6–S8 依赖 U4+U5，S9 依赖 U3，S10 全量后回归。

---

## 5. 下一层拆分（实现单元）

**5 个单元按依赖排序：U3（断链修复）零耦合可先行合入；U1→U2 是符号底座到 UI 的主干；U4/U5 是 extension 与协议两端，与 U1/U2 并行、最后联调。**

| 单元 | 内容 | 关键文件（改动地图） | 依赖 | justification |
|---|---|---|---|---|
| U1 dom-core 触发与 chip 层 | 四符号检测函数族 + bash 短路 + clear 族 + slash 正则化 + session/subagent chip + Segment 两 case | `dom-core/composer/input/{input-dom,contenteditable,chip-commands,types}.ts`、`shared/src/segments.ts` | 无 | 符号管线的公共底座；纯逻辑层先行可独立单测（触发正则/转义/chip 解析） |
| U2 renderer 浮层与发送分流 | CommandPopover 多路（session/subagent 候选源 + 「新建」项）、useCommandPopoverTrigger 扩、UserBubble/restore 分支、submitSegments 分流、sidebar 直引入口、**定向气泡渲染双链路（live broadcast 消费 + entry-tree-builder/convertPiHistory 识别 subagent-directive）**、mock 数据 | `renderer/components/panel/{CommandPopover,Composer}.vue`、`useCommandPopoverTrigger.ts`、`core/domain/chat/useChat.ts`、`core/domain/composer/context/injection-store.ts`、`renderer/api/mock/*`、`runtime/infra/pi/entry-tree-builder.ts`（reload 链路）、聊天流气泡组件（live 链路） | U1 | UI 层消费 U1 类型；mock 先行使三视角测试可行；定向气泡双链路必须同批落地（规则 9：live ≡ reload） |
| U3 slash 断链修复 | ReloadOrchestrator.doReload 成功路径接失效 + session-service.handleSessionReloaded + 浮层打开主动拉 | `runtime/services/session/reload-orchestrator.ts`、`runtime/services/session/session-service.ts`、`renderer/components/panel/CommandPopover.vue` | 无（独立） | 与符号体系零耦合，可先行合入；风险最低收益即时 |
| U4 extension 命令面 | `/subagents` message/start 解析 + handler 接线 + sendMessage 留痕（custom_message 'subagent-directive'）+ 转义协议 | `extensions/universal/subagent-workflow/src/interface/{command-actions,subagents,subagent-actions}.ts` | 无（独立，本地 pi CLI 可测） | extension 与 GUI 解耦发布；按 AGENTS.md 先在本地 pi RPC 实测 |
| U5 WS 协议与清理 | subagentAction action 联合扩展 + runtime 转发 + marker 通道废弃（含既有测试同步删改：`server-subagent-boundary.test.ts` 等断言 marker 格式的用例） | `shared/src/protocol.ts`、`runtime/transport/session-message-handler.ts:281-283`（WS 入口 case）、`:441`（marker 分支删除）、`runtime/services/session/{session-service,message-dispatcher}.ts`、`renderer/api/domains/{session,chat}.ts` | U4（联调） | 协议变更集中一个单元，便于 review 与 mock 同步 |

联调顺序：U3 独立先行；U1 → U2；U4 ∥ U1/U2；U5 收口联调（S6–S8）。

**待验证检查点（实施期门，不编造结论）**：
1. `client.prompt('/__xyz_reload__')` resolve 时机 = reload 完成的实测复验（P2 探针，U3 首日真实 pi 子进程）
2. `/subagents message` 文本含换行的端到端实测（P3 探针，转义协议实施首日）
3. session chip 选中后 `#uuid` 与 session_read guidelines 的端到端命中率（P4；uuid 子串匹配协议以 TUI hash-provider 实测行为为准）
4. `sessionStore.groups` 在 landing 态为空 → `#`/`@` 不触发（浮层无数据源）的空态处理（U2 实现时确认触发短路条件）
5. `sendMessage` 无 triggerTurn 的「留痕不唤醒」实测（P6 探针，U4 首日本地 pi CLI）

### 5.2 用户习惯迁移（随 release note 交付）

`#` 语义从文件切换为 session：老用户肌肉记忆 `#文件名` 将得到 session 浮层。缓解：release note 明确新旧对照（`#`→session、`$`→文件）；session 浮层 query 对 label/id 子串过滤，文件名查询大概率空候选 → 浮层不渲染（内建缓解），用户可即时察觉并换 `$`。不做事前一次性弹窗提示（打断感 > 收益）。

### 5.1 探针断言清单（集中登记）

| # | 断言 | 状态 | 出处 |
|---|---|---|---|
| P1 | pi `session_start(reason)` 不出 RPC stdout（extension-only，`_extensionRunner.emit` 单发）——事件路不可行的负向事实 | ✅ 已测（dist 静态核实：`agent-session.js:2072` 单发 vs `:330-331` agent_settled 双发对照） | D4 |
| P2 | `client.prompt('/__xyz_reload__')` resolve 即 reload 完成（pi `prompt()` await `_tryExecuteExtensionCommand`，`agent-session.js:800`）——失效接线时机成立 | ✅ 已测（dist 静态核实）；⛔ U3 首日以真实 pi 子进程复验（S9 联动） | D4 / S9 |
| P3 | `client.prompt('/subagents ...')` 文本参数全量原文传递（pi 以首个空格拆命令名，args = 其后全文，含空格/引号原样） | ✅ 已测（dist 静态核实：`agent-session.js` `_tryExecuteExtensionCommand` 拆分逻辑）；⛔ U4 首日实测换行场景；降级：text 改 base64/JSON 编码 | D2 |
| P4 | `#uuid` 文本被 session_read 正确消费（stripHash `tool-handler.ts:102-103` + uuid 片段匹配已存在，TUI 生产验证过） | ⛔ 实施期门（S4 端到端）；降级：匹配退回全量 36 位 uuid（session chip 存全量 id，本就携带） | 3.3.2 / S4 |
| P5 | commands ReplicatedState 失效防抖 + 失败退避保留旧值 | ✅ 已测（replicated-state.ts 既有机制与测试，W8 验收锁定） | D4 |
| P6 | `sendMessage` 不传 triggerTurn 时不产生新 turn（留痕不唤醒） | ⛔ 实施期门（U4 首日本地 pi CLI 实测；降级：换 deliverAs:'nextTurn' 排队或退回 appendEntry 放弃留痕） | 3.3.3 / 3.3.8 |
