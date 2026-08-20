# 对话流 turn 归属与 live≡reload 全类型收尾（conversation-turn-attribution）

> **一句话结论**：W20/W21 已把消息流统一到 entry-reducer，剩余 5 个分组错乱机制（3/4/5/A/C）收敛为一个欠账——**turn 归属仍靠 role 扫描 + 3 类消息（user 直插 / bash 帧式 / customStart 直插）未走 entry 通道**；本设计用三件事收尾：① 分组从 role 扫描改为**显式边界规则集**（隐藏完成通知作边界 + 续跑 turn 带触发起点、bash/健康警告作 turn 内 notice）② **live 全消息类型 entry 化**（bash 镜像 pi 双分支延迟、user/customStart 过 reducer）③ load-more 改**锚定切分**——使 live≡reload 从「除 bash/user/custom 外构造性成立」变为全类型构造性成立，且不新增任何第二真相。

## §1 背景目标

**SCQA**：

- **S（情境）**：xyz-agent 对话流的消息数组已是 entry 日志的纯函数（W20/W21）：实时链路 event-adapter 从 `message_end` 等事件重构 entry 喂单一 `applyEntry` reducer（`packages/core/src/domain/chat/effects/registry.ts:414-424` → `store.ts:434-437` `applyEntryFrame`），文件重放走同一 reducer——同 entry 序列必得同 state。数据登记表 #7 已登记该终态，并预留「**分组语义（turnId）归 fix-chat-flow-order 分支主题**」（`docs/architecture/data-source-registry.md` #7 例外列）。
- **C（冲突）**：分组（`message-turns.ts:138-170` `groupRenderInput`）仍是对消息数组做 **role 扫描**：user 开新 turn、assistant 归当前、system 一律 `current = null` 打断。同时 3 类消息没走 entry 通道（user 直插 `store.ts:335`、bash 帧式 `bash-effects.ts:55-95`、customStart 直插），live 侧 id 空间混合（`u-`/`bash-`/`s-`/`c-` 前缀 vs reducer 派生 `e<N>`），bash 的 live 入流时机与 pi 落盘时机分叉。
- **Q（问题）**：用户可感知的分组错乱仍剩 5 个机制（详见 §2.3）：bash mid-turn 重开分组跳变、注入续跑无起点并入上一 turn、可见 system 切断 turn 产生孤立 turn、活跃 session load-more 重复、steer 切分无显式语义。
- **A（答案）**：分组改为显式边界规则集（什么开 turn、什么归 turn 内，由消息自身可重放推导的属性决定，不新增物化字段）；3 类消息全部 entry 化收尾；load-more 从「按 id 去重」改为「按 hydrate 锚切分」。

**系统是什么**（给没用过内部链路的开发者）：

```
pi 子进程（session JSONL append-only 日志，entry 为持久化单元）
  ↕ stdio RPC + 事件流
runtime（event-adapter 无状态翻译 pi 事件 → message-dispatcher 编排 → MessageBus 广播帧）
  ↕ WebSocket
renderer/core（effects/registry.ts 处理帧 → applyEntryFrame 喂 per-session reducer state
              → message-turns.ts 分组 → MessageStream/Turn.vue 渲染）
重开 session：get_entries RPC（活跃）或文件解析（离线）→ replayEntries → 同一 reducer
```

**设计目标**（从使用者体验倒推）：

| # | 目标 | 使用者可见行为 |
|---|------|--------------|
| G1 | steer 后重开分组不变 | steer 插话后关闭重开 session，对话分组与实时所见一致（现状已一致，本设计加回归守卫）。注意：机制 3 的 UX（steer 视觉降级为 turn 内插话）依赖 D1b deferred，本设计只保证结构性一致 + 回归守卫 |
| G2 | bash 不再造成重开跳变 | streaming 中用 `!` 跑命令，实时看到执行反馈；run 结束后 bash 记录归入当前 turn 内部，重开分组与实时一致；空闲时执行立即入流 |
| G3 | 后台任务续跑有可见起点 | subagent/workflow 完成后 agent 的续跑响应出现在**新的一组**，带「后台任务完成」起点行，不再并入上一个用户问题；重开后同样 |
| G4 | turn 内运行信息不切断 turn | bash 执行记录、健康警告不再把一个 turn 切成两半产生无 user 的孤立组；压缩记录/分支摘要仍作独立边界行 |
| G5 | 活跃 session 翻旧历史不出重复 | 活跃对话中点「加载更多」，旧消息前插一次、不重复、顺序稳定 |
| G6 | live≡reload 全类型可回归 | 等价性测试覆盖全部消息类型（含 bash/user/custom），同类分叉结构性地不再出现 |

**In-scope**：分组规则集 v2、bash/user/custom 的 live entry 化、load-more 锚定切分、Turn 渲染模型扩展（触发起点行 + turn 内 notice）、等价性测试扩展、登记表/AGENTS 同步。
**Out-of-scope**：pi 侧任何行为（[MANDATORY] 不修改 pi 源码）；steer 视觉降级（依赖 mode 标记探针，见 D1b deferred）；renderer 消息模型大改（`conversation-renderer-model-unification.md` 既有轨道，本设计只做 turn 模型的**增量**扩展点）；`!` bash 的执行中输出样式（既有 ephemeral 反馈形态沿用，只改其数据归属）。

## §2 现状与问题分析

### 2.1 分组 SSOT 现状（role 扫描）

`groupRenderInput`（`packages/core/src/domain/chat/message-turns.ts:138-170`，实测）：

- user → `current = { user: msg, assistants: [] }` 开新 turn；
- assistant → 归 `current`（无则自启 `user: null` 的 turn，兼容首条边缘）；
- **其余（system 族）→ `current = null` 产出 static 项**（`bashExecution` / `systemNotice` 两种 kind，:152-165）——即任何可见 system 消息都切断当前 turn。

渲染前 `filterDisplayableMessages` 过滤 `display === false`（:83-85）——隐藏消息不参与分组。

### 2.2 W21 后消息数组的顺序权威与 3 类未 entry 化消息

实时侧顺序权威 = **pi 事件到达序 = entry 构造序**（event-adapter `handleMessageEnd` 从 `message_end` 重构 entry、无 id，interpreter 同步转发不重排，registry `message.message_end` → `applyEntryFrame`）。但并非全部消息都走这条通道：

| 消息类型 | live 入流路径 | live id 形态 | 文件/replay 路径 | replay id 形态 |
|---|---|---|---|---|
| assistant | `message_end` → entry → reducer | `e<N>` 派生（apply-entry.ts:124-126） | entry → reducer | entry.id（pi uuidv7） |
| **user** | `appendUser` 直插数组（store.ts:335；乐观 send 与 drainN 投递两处调用） | `u-${uuid}` | user entry → reducer | entry.id |
| **bash** | `message.bashStart`/`message.bashResult` 帧 → bash-effects 直建 system 消息（bash-effects.ts:55-95） | `bash-${uuid}` | bashExecution entry → reducer（apply-entry.ts:449-471） | entry.id |
| **custom 通知** | `message.customStart` 直插（registry，转 system 消息） | `c-${uuid}` | custom_message entry → reducer（apply-entry.ts:588-598，完成通知类覆写 display:false） | entry.id |
| stream_warn | registry handler 直插（:250-257） | `s-${uuid}` | **无 entry（live-only）** | — |

**pi 侧关键事实（全部对 node_modules 实装 0.84.1 dist 实测，遵守「pi 断言以实装版为准」纪律；旧 clone 0.80.3 已被 pi-assumption 审计定性为不可靠源）**：

- bash 消息在 pi streaming 期间缓存 `_pendingBashMessages`，非 streaming 立即写（`agent-session.js:2225-2247` `recordBashResult` 双分支）；flush 在 `_runAgentPrompt` 的 **finally**（:744-756，覆盖 abort），且先于 `_emitAgentSettled`；新一轮 `prompt()` 前也 flush（:846）。**文件内 bash entry 位置 = 所属 run 级联（含 followUp drain 续跑）全部 assistant 之后**。
- steer/followUp 入队前做 skill/模板展开（:986-1011）；queue_update 入队即发、消费时再发（:340-361）。
- followUp 的 drain 续跑发生在 `_runAgentPrompt` 内部 `_handlePostAgentRun` while 循环——**同一次 settled 级联**。

### 2.3 五个仍存的机制（真实失败形态，数组小写 u/a/b/s/c 表示消息）

| 机制 | live 数组与分组 | reload 数组与分组 | 用户所见问题 |
|---|---|---|---|
| **4 bash 分叉** | streaming 中 `!` bash：`[u1,a1a,bash,a1b]`（bash 即时入流切断 turn → a1b 成无 user 孤立组） | `[u1,a1a,a1b,bash]`（pi 缓存到 run 边界落盘，bash 在级联末尾；a1b 归 u1 组） | **重开前后分组不同**（主残留） |
| **A 注入无起点** | `[u_prev,a_last,c(隐藏),a_new]` → 过滤后 a_new 并入 u_prev 的 turn | 同左（custom_message entry 同样被 display:false 过滤） | 后台任务续跑响应混进上一个提问；多个任务完成堆同一组（每次必现） |
| **C system 切断** | 可见 system（stream_warn / compaction / branch summary / 可见 custom）mid-turn 出现 → `current=null` → 后续 assistant 孤立组 | compaction/branch 有 entry 两侧一致；stream_warn 无 entry 仅 live 切断 | 无 user 的孤立组、「总觉得乱」 |
| **5 load-more 重复** | 活跃 session store 含 live 消息（`u-`/`e<N>`/`bash-` 混合 id） | load-more 取文件全量（entry.id）经 `prependHistory` 按 **Message.id** 去重（mutations.ts:74-84）——两 id 空间永不相等 | 翻旧历史时同内容消息重复 prepend，分组彻底错乱（触发条件：活跃 session 中 load-more） |
| **3 steer 切分** | `[u1,a1a,s1,a1b]`：s1 开新 turn，a1a/a1b 分家 | 同左（一致） | 一次逻辑响应被切成两组（结构性、两侧一致，属语义决策而非分叉，见 D1） |

已修复机制（本设计只加守卫不重做）：机制 1/2（文本匹配失配/单帧丢失）——W14 计数 FIFO（`drainN` store.ts:373-384 + `countDrained` registry.ts:84-96 + `reconcilePending` 深度对账 store.ts:398-402，深度权威 = pi `pendingMessageCount`）；机制 B（notify/drain 竞态）——isIdle gate + 100ms 退避（notifier.ts:180-204）。

### 2.4 根因

W20/W21 解决了「**内容**从哪来」（entry reducer 单源），没解决「**归属**怎么判」（分组仍是 role 扫描的隐式推断）与「**顺序**的全类型覆盖」（3 类消息绕过 entry 通道、bash 时机分叉）。role 扫描的本质问题：它把「什么开 turn」的**产品语义**寄托在 role 这个**传输属性**上——system 族消息既有 turn 边界语义（压缩）又有 turn 内语义（bash 执行记录），role 无法区分；注入触发器（custom_message）因为隐藏而完全退出分组输入。load-more 的 id 去重则是把「同一性判断」寄托在两侧永远不会相等的 id 空间上。

### 2.5 现状物理数据流（bash 一类即可见分叉）

```
[Live]  xyz dispatcher: sendBash → 即时广播 bashStart → await pi.bash() → 即时广播 bashResult
        → bash-effects: 立即在 messages 数组建 system 消息（位置 = 执行时刻，mid-run）
[File]  pi: streaming 期间缓存 → _runAgentPrompt finally flush → bash entry 落在级联末尾
[Reload] 文件 entries → reducer → bash 消息在级联末尾            ← 与 Live 位置不同
```

## §3 解决方案

### 3.1 终态（使用者视角先行）

**成功路径**：

1. （G2）用户在 agent streaming 中输入 `!` bash：对话流立即出现执行中的轻量反馈（ephemeral，见 D2——不是消息数组项）；命令结束、本轮 run 级联全部结束后，当前 turn 内部末尾出现一条 bash 执行记录（notice 形态）。关闭重开：同一条记录出现在同一 turn 的同一位置。
2. （G3）后台 subagent 在主 agent 空闲时完成：对话流出现新的一组，起点是「后台任务完成 · 已继续处理」轻量起点行（非 user 气泡），下面是 agent 处理结果的 assistant 块。重开一致。
3. （G4）streaming 中出现健康警告：警告以 turn 内 notice 形态出现在当前组内部，当前 turn 不被切断。压缩记录仍独立成行（边界语义保留）。
4. （G5）活跃对话中点「加载更多」：更早的消息按文件序前插，无重复。
5. （G1）steer 插话：开新 turn（语义见 D1），重开一致。

**失败路径与恢复**（准则 6）：

- bash 结果 RPC 失败：现状错误处理保留（dispatcher catch 分支），无 entry 产生、无消息入流——用户重试 `!` 命令即可（恢复动作 = 重跑命令）。
- load-more 拉取失败：现状 catch 吞错策略保留（useChat.ts:656 注释），不破坏现有消息；恢复 = 再次点击「加载更多」。
- hydrate 锚缺失（异常场景，见 D5 兜底）：降级为现状 id 去重路径并在 console.warn 登记——退化不崩溃。

### 3.2 方案对比（整体三案）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 逐机制局部补丁**：bash 双位置修正、注入 turn 前插伪 user 行、load-more 换内容指纹去重、system 白名单不打断 | 每条规则各自为政，无统一「什么开 turn」语义；后续新增消息类型仍要逐个补丁；分组语义散落多处 | 最低 | 分组语义没有 SSOT，防复发能力弱；伪 user 行制造「看起来像用户说的」的歧义 | ❌ |
| **B 边界规则集 + 全类型 entry 化 + 锚定切分**（本设计） | 「什么开 turn」成为分组 SSOT 内的一张显式规则表；live 全类型过 reducer 使 live≡reload 构造性成立；锚定切分消灭 id 同一性判断；**不新增任何物化派生字段**（多源红线合规） | 中（分组重写 + dispatcher/registry 三处改造 + Turn 模型扩展） | bash 延迟入流的 UX 取舍（D2 论证）；分组重写需等价性测试护航 | ✅ |
| **C Message 物化 turnId 字段**：写时定 turn、读时纯分桶 | 表面最强（分桶 O(1)），但 pi entry 无 turn 概念，turnId 只能由 xyz 推导后**物化缓存**——replay 时仍需同一推导重放，物化值即第二真相，**恰好违反刚以 ADR-0062/治理线 D1-D8 清理掉的「派生数据不落第二份」原则**；且 turnId 写入点分散到所有消息创建处（每处都是潜在第二写方） | 高 | 多源真相回归——本项目 2026-08 刚用 20 个 wave 清理完的病灶 | ❌（被否关键论据：若用它，§2.3 机制 5 的「id 空间多源」会以「turnId 多写方」形态复活） |

**被否方案推演**（准则 4）：若用 A，机制 A 的修复（前插伪 user 行）在新 session 的重开路径也要伪造同一条伪 user——伪消息进入持久化边界，「渲染过滤不丢消息」（AGENTS 规则 7.5）语义被污染；若用 C，三个月后排查「这条消息 turnId 为什么错了」会面对 N 个写点——正是本仓 `sessionMetaCache` 影子状态（登记表 #1，W9 删除）的翻版。

### 3.3 关键决策

**D1：steer 保持「开新 turn」语义（选择）vs「归入当前 turn inline」（被否）**
- 选择理由：pi session 文件对 steer 投递的 user entry 与普通 user entry **无任何可重放区分标记**（0.84.1 dist `_queueSteer` :1016-1018 入队纯文本、drain 后与普通 prompt 同路径 appendMessage）——若 live 侧按 xyz 已知的 mode 做 inline 归组，replay 侧永远推不出同样归属，等于制造新的 live≠reload 分叉，与 G6 直接冲突。steer 本质是用户插话（pi CLI 同样显示为独立 user 消息），开新 turn 是两侧可一致推导的最大公约数。
- **D1b（deferred，非本设计范围）**：若产品后续要「steer 视觉降级为 turn 内插话」，需先过探针 ④（见 §3.5）确认 pi entry 可识别注入来源，或由 runtime 在 drain 时刻附带写一条 mode 标记 custom entry（经 pi `appendEntry` 合法通路，非直写）——届时另立设计。
- 影响的目标：G1（语义定案 + 守卫）。

**D2：bash live 入流镜像 pi 双分支 + 级联末对齐（选择）vs 保持即时入流（被否）vs 完全等 flush 事件（被否）**
- 选择：dispatcher 收到 `bash` RPC 结果后判 session 运行态——**streaming：结果挂 per-session 待落列（不进 messages），在本 run 级联真正结束的信号（settled-after-cascade，见探针 ②）到达时按序转成 bashExecution entry 经 `applyEntryFrame` 入流**；**空闲：立即转 entry 入流**。两侧位置都构造性地等于 pi 落盘位置（pi 文件内 bash entry 也在级联末尾，:744-756 finally 先于 settled）。
- 执行中反馈 ephemeral 化：`bashStart` 帧不再建 messages 数组项，改为既有的瞬时执行反馈通道（composer/状态区，具体挂点实施时对齐现有 ephemeral 形态——它本来就不参与持久化，数据归属改挂不新增状态源）。
- 被否「保持即时入流」：正是机制 4 本体。被否「等 pi 的 flush 事件」：pi 对 bash 落盘**不发射任何事件**（`recordBashResult` 无 emit，实测），没有可等的信号。
- **已知竞态登记**（诚实声明）：xyz 判「空闲」但 pi 实际 streaming 的窄窗口（判定源 = #11 活跃态 ReplicatedState，本身有失效链）会导致该条 bash live 位置与文件位置短暂不一致，重开后收敛（文件是 ground truth）。登记进登记表例外清单，与 #10「bash 改动历史不可还原」同级——已声明并接受的窄语义差。
- **与规则 9「对话流状态实时可见」的张力显式声明（r1 审查补）**：bash 执行记录延迟到级联末入流，但「实时可见」由两条通道共同满足——执行期间的实时反馈由 ephemeral 通道承担（不进 messages 数组，无持久化语义），run 结束后记录作为 turn 内 notice 入流（持久语义，与文件一致）。规则 9 的双通路要求（实时 + 重开可见）对 bash 类型以此分工达成，而非牺牲其一。
- `excludeFromContext` bash：pi 是否仍写 entry 未证实（探针 ①）。若不写：该类 bash 标记为 live-only notice（inline 归组，重开消失，登记例外）；若写：与普通 bash 同路径。
- 影响的目标：G2。

**D3：隐藏完成通知 = turn 边界 + 续跑 turn 带触发起点（选择）vs 通知改可见（被否）vs 维持并入（被否）**
- 选择：分组输入**从「display 过滤后」改为「全量数组」**——`filterDisplayableMessages` 从分组前置挪到渲染项层（隐藏消息不再进入渲染，但参与分组语义判定）。规则：`custom_message` 且属 `COMPLETE_NOTIFY_CUSTOM_TYPES`（display:false）→ 关闭当前 turn，**开启一个 `user:null, trigger:'bg-notify'` 的新 turn**；后续 assistant 归入该 turn。渲染层 Turn 组件为 `trigger` turn 渲染轻量起点行（「后台任务完成 · 已继续处理」，i18n），不渲染 user 气泡。连续边界标记（多个通知接连到达、无 assistant 跟随）折叠——**空 turn（无 user 无 assistants）不产出**。
- 被否「通知改可见」：通知正文（subagent 摘要 JSON）对用户是噪音，且改变既有「完成通知不打扰」的产品决策（display:false 是 shared SSOT 常量，两链路已一致）。被否「维持并入」：机制 A 本体。
- 多源核查：`COMPLETE_NOTIFY_CUSTOM_TYPES` 仍是唯一常量（shared/message.ts），live（customStart/applyEntry 覆写）与 replay（apply-entry.ts:598）已共用——本决策只新增「分组也读它」，不新增第二份判定。
- 影响的目标：G3。

**D4：notice 归属 = 派生规则，不新增字段（选择）vs 每条 system 带 placement 字段（被否）**
- 选择：分组 SSOT 内置一张**派生规则表**——`msg.bashExecution` 存在 → inline（归当前 turn 内部，不切断）；role 为 compactionSummary/branchSummary 或可见 custom → boundary（独立行 + 关闭当前 turn，现状语义）；**stream_warn 在其唯一创建点（registry :250-257 handler）打 `liveOnly: true` 标记**（该消息本就无 entry、无 replay 对应物，标记由单一写方写入，非物化派生）→ inline。inline notice 若无当前 turn（首条/边界后），退化为独立 notice 行（现状兜底保留）。
- 被否「placement 字段」：每条 system 创建点都要写 placement，N 个写点的字段就是 N 个潜在第二真相；派生规则集中在分组 SSOT 一处，与「投影一次」（治理原则 3）一致。
- 影响的目标：G4。

**D5：load-more 锚定切分（选择）vs 统一 id 空间（被否）vs 活跃 session 禁 load-more（被否）**
- 选择：hydrate 时记录**尾窗锚**（尾窗首条 entry 的 `piEntryId`——RPC `get_entries` 返回的 entry 自带 pi uuidv7，W20 hydrate 已消费 entries，锚随手可得）；load-more 经 `getFullHistory` 取全量 entries 后**按锚切分，只前插锚之前的段**，`prependHistory` 的 id 去重退化为兜底断言（命中即 console.warn 报异常）。锚存 per-session（chat store Map，与 messages 同区）。
- 被否「统一 id 空间」：live 事件重构的 entry 无 id（pi 在 emit 之后才分配 uuidv7，实测），live 侧永远拿不到将与文件一致的 id——该路线物理不可行。被否「禁 load-more」：UX 倒退（活跃长会话翻旧历史是真实需求）。
- 兜底：锚 entry 已被 compaction 重写移除时（探针 ③），降级为「按锚内容指纹（role + 首段文本 + 时间戳）定位切分点」，再失败走现状 id 去重 + warn（不崩溃）。**降级可靠性边界预评估（r1 审查补）**：指纹歧义（多条同 role + 同首段文本）时取**最后一个匹配位**（最接近尾窗，与 hydrate 尾窗语义一致）；零匹配即走现状去重并 console.warn——降级路径只影响「多前插/少前插一段旧历史」的边界精度，不产生重复（id 去重兜底仍在），最坏表现 = 回退到现状水平而非更差。探针 ③ 实施期若证实「compaction 不保留尾窗 entry id」，需同时实测指纹命中率并回填本条边界数据。
- 多源核查：锚的唯一写方 = hydrate（一次性），唯一读方 = load-more；不构成缓存（无失效/回写问题）。按登记表演进规约补 `@data-owner #7` 注解。
- 影响的目标：G5。

**D6：user / customStart 的 live 入流 entry 化（选择）vs 维持直插（被否）**
- 选择：`appendUser` 内部改为构造 user message entry → `applyEntryFrame`（乐观 send 与 drainN 投递两处调用点不变、签名不变——返回 id 改为 reducer 派生 id，useChat 的 clientUuid 映射消费返回值，行为不变）；`customStart` 同理转 custom_message entry。live 侧 id 空间收敛为 reducer 派生一种，`u-`/`c-` 前缀消灭。
- 被否「维持直插」：机制 5 的 id 混合空间根源之一；且 user 消息不走 reducer 意味着「live≡reload 构造性」对 user 类型不成立（reducer 的 user 分支只有 replay 在走）。
- 风险与边界：reducer 的 user 分支现被 replay 单路使用，live 接入后两条路径同分支——正是 W20/W21 的既定模式（assistant 已如此），等价性测试已有先例（`apply-entry-equivalence.test.ts`）。`appendUser` 的乐观插入语义（ref 与 reducer state 收敛，store.ts:430-433 注释）随 entry 化自然统一。
- 影响的目标：G5、G6。

### 3.4 目标物理数据流

```
[Live·全类型]  dispatcher/registry 各事件 → 统一构造 entry（assistant=既有；user=D6；
               custom=D6；bash=D2 双分支：streaming 挂起→级联末转 entry，空闲立即）
               → applyEntryFrame → per-session reducer state（唯一消息数组来源）
[分组]         groupTurns(全量数组) → 边界规则集：
               user → 新 turn（锚）
               隐藏 COMPLETE_NOTIFY custom → 边界（开 trigger turn，空 turn 折叠）
               assistant → 归 current（无则自启）
               bashExecution / liveOnly system → inline notice（不切断）
               compaction/branch/可见 custom → boundary notice（独立行 + 关闭 current）
[渲染]         渲染项层才做 display 过滤（隐藏项不渲染但已参与分组）
[Reload]       get_entries / 文件 entries（同一 entry 序列）→ replayEntries → 同一 reducer
               → 同一分组规则 → 同一渲染                  ← live≡reload 全类型构造性成立
[Load-more]    hydrate 记锚（尾窗首 entry id）→ getFullHistory 按锚切分 → 前插锚前段
```

### 3.5 探针清单（准则 7）

**✅ 已测（本轮两路调查 + 0.84.1 dist 实测，锚点见 §2.2/§2.3）**：pi bash 缓存双分支与 flush 边界（agent-session.js:2225-2247 / :744-756 / :846）；`recordBashResult` 无事件发射；steer 展开与入队形态（:986-1011）；queue_update 时序（:340-361）；xyz 侧分组规则 / drainN / appendUser / applyEntryFrame / bashStart-bashResult 即时广播 / prependHistory id 去重 / COMPLETE_NOTIFY 覆写（各文件行号见 §2）。

**⛔ 实施期门（探针不过则对应决策重议，禁止带病实施）**：
1. pi 对 `excludeFromContext` bash 是否写 entry（读 dist bash RPC 处理分支 + 本地 pi CLI 实测一条）→ 决定 D2 该分支走 entry 化还是 live-only 例外。
2. xyz 可观测的「级联结束」信号：event-adapter 是否转发 `agent_settled`（或等价 run 边界帧），及它与最后一条 assistant `message_end` 的相对次序 → D2 的 flush 触发点。若无现成信号，从 pi `agent_settled` 事件接（dist 已证实存在于 flush 之后发射）。
3. hydrate 锚在 compaction 后的存活（compaction 是否保留尾窗 entry id）→ D5 兜底路径的真实触发率。
4. pi session 文件的 steer user entry 是否携带任何可识别标记（D1b deferred 的立项依据，非本设计门）。

### 3.6 与既有治理/规范的一致性自查（多源红线）

| 本设计新增物 | 权威源 | 唯一写方 | 是否缓存/影子 | 合规依据 |
|---|---|---|---|---|
| 边界规则集（分组内置表） | 消息数组自身属性（派生） | `message-turns.ts` 分组 SSOT 一处 | 否（纯函数派生） | 治理原则 3「投影一次」；登记表 #7 注记更新 |
| bash 待落列（streaming 期间） | pi `recordBashResult` 的既定行为（xyz 镜像） | message-dispatcher 单点（per-session Map，挂 activeSession 同区） | 否（一次性中转，落定即清） | ADR-0062 绝对写规则不涉及（纯内存，不写 pi 文件）；ADR-0049 Map 分区范式。**生命周期（r1 审查补）**：session 删除 → 待落列随 Map 分区清理一并丢弃（挂接既有 cleanup 编排，无孤儿残留）；streaming 中切换 session 再切回 → Map 分区保证隔离、原 session 待落列保留（flush 信号按 sessionId 定向，跨 session 不误清）——两者均为预期行为 |
| hydrate 锚 | entry 序列（pi 文件） | hydrate 单点一次性写入 | 否（无回写无失效） | `@data-owner #7` 注解（W24 R3 先例） |
| `liveOnly` 标记（stream_warn） | 「该消息无 entry」这一事实 | registry 单一创建点 | 否（标记即来源声明） | 单写方字段，非派生物化 |
| trigger turn / inline notice | 分组派生 | 渲染层只读 | 否 | 不落 store |

规则 9 双通路核查：新增分组语义（D3/D4）在实时链路（registry 帧路径）与持久化链路（apply-entry entry 路径）**读同一规则表、同一常量**（`COMPLETE_NOTIFY_CUSTOM_TYPES` shared SSOT），无单侧独有规则——实时可见 + 重开可见同时成立。ADR-0049：新增 per-session 状态（bash 待落列、锚）全部 Map 分区、随 session 生命周期清理，不新建实例级 composable 状态。

## §4 验收（真实场景，非单测非 mock）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V1 | steer 后重开一致 | dev app 中 agent streaming 时 steer 一句插话 → 等 run 结束 → 关闭重开该 session | 实时与重开分组一致：插话开新组、前后 assistant 各归各组；无消息丢失（对照 session 文件行数） | G1 |
| V2 | streaming 中 `!` bash | dev app：agent 长 turn 执行中，输入 `!` 跑 `ls -la`（含一个 excludeFromContext 用例）→ run 结束 → 重开 | 执行中有即时反馈（不占消息组）；run 结束后 bash 记录位于当前 turn 内部末尾；重开位置一致；exclude 用例按探针 ① 结论表现（entry 化一致 / live-only 且已登记） | G2 |
| V3 | 空闲 `!` bash 即时 | agent 空闲时跑 `!` 命令 | bash 记录立即入流（无等待），重开一致 | G2 |
| V4 | 后台续跑有起点 | 本地 pi CLI（AGENTS 扩展实测纪律）+ subagent-workflow：发起后台 subagent → 主 agent 空闲后 subagent 完成 → 观察续跑；再在 dev app 重开该 session | 续跑响应在新的一组、带「后台任务完成」起点行；不并入上一提问的组；重开一致 | G3 |
| V5 | turn 内信息不切断 | dev app：streaming 中触发健康警告（或单测级用 injected 帧模拟，但验收以真实 stream_warn 一次为准）；再触发一次手动 compaction | 警告归当前 turn 内部（组不切断）；压缩记录独立成行且后续对话开新组；重开后压缩记录仍在、分组一致 | G4 |
| V6 | 活跃 load-more | dev app 长会话（>20 turn）：hydrate 后再聊 5 轮 → 点「加载更多」 | 旧消息前插一次、无重复、组序稳定；console 无锚降级 warn（若出现则为兜底路径命中，需检查 compaction 情形） | G5 |
| V7 | 全量回归 + 等价性 | `apply-entry-equivalence` / `custom-start-equivalence` 扩展用例（bash 双分支、user/custom entry 化、边界分组、锚切分）+ runtime/core/renderer 三包全量 + taste-lint | 全绿；等价性用例覆盖 §2.2 表全部 5 行类型 | G6 |

Final gate：V1/V2/V4 在打包链 dev app 端到端复跑一次（builtin 扩展生效形态）。

## §5 下一层拆分（wave 拆分，领地与依赖）

| wave | 内容 | 领地 | 依赖 | justification |
|------|------|------|------|---------------|
| W1 | bash entry 化 + 双分支延迟（dispatcher sendBash 改造、registry bash 帧处理改 applyEntryFrame、bash-effects 直建路径删除、探针 ①②） | runtime dispatcher + core registry/bash-effects | 无 | 机制 4 主修复；先独立落地可立刻消灭最大跳变源 |
| W2 | user/customStart entry 化（appendUser 内构 entry、customStart 转_entry、乐观插入与 reducer 收敛注释更新） | core store/registry | 无（与 W1 并行，不同文件） | 机制 5 根源 + W21 收尾；id 空间收敛为 D5 铺垫 |
| W3 | 分组边界规则集 v2（groupRenderInput 重写、display 过滤挪渲染层、空 turn 折叠、stream_warn liveOnly 标记） | core message-turns + registry 单点 | 建议在 W1 后（bash inline 规则引用其最终形态），逻辑上可并行 | 机制 A/C 主修复；纯函数重写可用等价性测试护航 |
| W4 | Turn 模型扩展 + 渲染（trigger 起点行、inline notice 渲染、MessageStream/Turn.vue 适配、i18n） | ui/renderer | W3 | 渲染消费 W3 语义；独立可验收（V4/V5 视觉面） |
| W5 | load-more 锚定切分（hydrate 记锚、getFullHistory 切分、prependHistory 改造 + 兜底、探针 ③） | core useChat/mutations + runtime 历史路径 | W2（id 空间收敛后锚语义最简） | 机制 5 主修复；锚逻辑小而独立 |
| W6 | 护栏与文档（等价性测试全类型扩展、登记表 #7 注记 + 例外登记（bash 窄竞态 / exclude 分支结论）、@data-owner 注解、AGENTS 7.5 同步） | 测试 + 文档 | W1-W5 | 防复发层；对齐治理线四层护栏惯例 |

**文件改动地图**：改写 `message-turns.ts`（分组规则 v2）、`store.ts`（appendUser entry 化、锚存储）、`effects/registry.ts`（bash/customStart 处理改造、stream_warn 标记）、`bash-effects.ts`（直建路径删除）、`message-dispatcher.ts`（sendBash 双分支）、`useChat.ts`（hydrate 锚 / loadMore 切分）、`mutations.ts`（prepend 兜底）；扩展 `Turn.vue`/`MessageStream`（trigger 行、inline notice）；新增无（不新建文件，全部在既有 SSOT 位置演进——避免新文件新管线）。

**待验证检查点**：§3.5 四项探针；W4 的 ephemeral 执行反馈挂点（对齐现有 composer/状态区形态，实施时以实际 UI 结构定案）。

**并行协调**：pi-assumption 修复线（W1a-W6）与 integrity-hardening 线正在并行实施，本设计领地（core chat 域 + dispatcher bash 段）与其无文件交叠（model-switch/provider/event-adapter toolcall 段）；开工前 `git log` 复核一次，若出现交叠（如 event-adapter bash 段被改）则本线对应 wave 顺延。

## §6 实施记录（W6 收尾补记，2026-08-20）

| wave | commit | 落定内容 |
|------|--------|---------|
| 前置 | a28fb6238 | shared `Message.liveOnly` 字段（stream_warn 标记的载体） |
| W1 | a6d306d64 | bash live entry 化 + dispatcher 双分支延迟（探针 ①② 落定）；abort 分歧发现并登记 |
| W5 | b56d845cb | load-more 锚定切分（探针 ③ 落定：exact 路径 compaction 后仍命中，兜底触发率 ≈ 0） |
| W2 | d1bee7c45 | user entry 化（appendUser 构造 entry）+ stream_warn liveOnly 标记 |
| W3 | 02b5a5ce3 | 分组边界规则集 v2（groupRenderInput 重写 + 空 turn 折叠 + 输出侧 display 过滤） |
| W4 | 85e158d23 | Turn 模型扩展 + 渲染（trigger 起点行 / inline notice / executingBash 完整形态 / i18n）+ 跨 wave 集成修复（消费方断言对齐 v2） |
| W6 | eb4ed5f3f | 等价性测试全类型扩展（E1-E4）+ compactionSummary entry 化 + 登记表 #7 / AGENTS 规则 9 同步 + W1 交棒注释清理 |
| W2 后修 | 5f5f9ddad | **appendUser 改 overlay-only**：W22 真实 pi 等价性测试捕获乐观 entry 与真实 message_end(user) 帧双喂 reducer（同一条 user 双计）；无条件 user 守卫也被 chaos 否定（sendCommand 源 user 仅经 message_end 入流是合法路径）、内容式去重对 steer 展开不可靠 → 定案：reducer 的 user entry 唯一来源 = 真实 message_end(user) 帧（两侧同为位置派生 id，live≡reload 对 user 严格构造性成立），appendUser 的 entry 仅作 ref overlay 派生基底（u-uuid 契约不变）。§3.3 D6 的「appendUser → applyEntryFrame」表述按此修订 |

**探针结论落定（§3.5 四项全闭环）**：

1. **excludeFromContext bash 写 entry**——`recordBashResult` 对 exclude 无分支（仅字段差异），streaming/idle 两分支都经 `sessionManager.appendMessage` 无条件落盘 → 与普通 bash 同路径 entry 化，**无 liveOnly 例外**（依据锚点：bash-effects.ts 文件头注释）。
2. **级联结束信号 = pi `agent_settled`**——pi `_runAgentPrompt` finally 先 `_flushPendingBashMessages`（bash entry 统一落盘）再 `_emitAgentSettled`，时序构造性保证；xyz 侧 dispatcher `flushPendingBashResults` 按 sessionId 定向消费（探针 ② 设计门通过）。
3. **hydrate 锚 compaction 后存活**——pi session 文件 append-only，compaction 只 append 一条 entry、**不从文件删除被摘要 entry、entry id 不变**（compaction 过滤只发生在发 LLM 的 buildContextEntries）→ exact 定位在 compaction 后仍命中，fingerprint/none 兜底真实触发率 ≈ 0（全依据锚点：mutations.ts `splitHistoryBeforeAnchor` 注释）。
4. **steer user entry 无可识别标记**——入队纯文本、drain 后与普通 prompt 同路径，D1b 维持 deferred（非本设计门）。

**W6 处置结论**：

- **compactionSummary 判定：entry 化（消灭双路径）**。帧数据源 = runtime event-interpreter 从 pi `compaction_end` 事件 result 提取的 `{ summary, tokensBefore, timestamp }`，与 pi 落盘 compaction entry（`sessionManager.appendCompaction`，手动 :1441 / auto :1670 两路都在 emit 前以同一批局部变量先落盘，0.84.1 dist 实测）**同源同值**，帧字段足以构造 `PiCompactionEntry` → registry handler 改直插为构造 entry → `applyEntryFrame`（user/custom/bash 同款范式）。fallback 文案由英文占位收敛为 reducer 中文（live/reload 一致）。剩余窄差异登记 #7 例外④：interpreter 仅 summary 真值时发帧，summary 缺失的 compaction（成功路径罕见）live 无消息、重开有 fallback 行。
- **等价性机器化（`apply-entry-equivalence.test.ts` W6 describe）**：E1 全类型归一 deep-equal（live 客户端 id 前缀 vs replay uuidv7）、E2 分组等价（toRenderItems 输出 deep-equal + turn 数/trigger/notices/边界行显式断言）、E3 abort 例外显式锁定（差异恰为 cancelled bash entry、分组不因它变化）、E4 compaction 处置（live 帧 entry ≡ replay entry）。
- **登记表 #7 注记**：turn 归属语义落地（边界规则集纯派生，无物化 turnId）+ 四项例外登记（bash abort 分歧 / executingBash ephemeral 态 / stream_warn liveOnly / compaction 窄差异）。
- **AGENTS.md 规则 9（历史编号 7.5）**：两通路落点更新为「共用同一 applyEntry reducer」，补全类型 entry 化 + 等价性测试守卫一句（全仓代码注释中「规则 7.5」历史编号引用未清理——语义指向不变，归后续统一编号时处理）。
