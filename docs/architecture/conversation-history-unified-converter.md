# 对话历史双链路统一：共享 entry 映射 + compaction 生命周期事件驱动

> **一句话结论**：两条历史读取路径（RPC/文件）的 entry 筛选与伪消息映射统一为共享单点 `mapSessionEntries`，convertPiHistory 继续共用于下游——覆盖倒挂 by construction 消除；compaction 生命周期（手动+自动）改由 pi `compaction_start/compaction_end` 事件驱动，`compaction_end.result` 自带 summary/tokensBefore/estimatedTokensAfter 等 6 字段，**dispatcher 零广播、interpreter 唯一源**（P-dedup by construction）。

## §1 背景目标

- **S（情境）**：xyz-agent 的对话历史有两条读取路径——**RPC 路径**（session 活跃有 pi 进程，`get_entries` → `rebuildHistoryFromEntries`）与**文件路径**（session 离线无进程，解析 session JSONL → `mapEntriesToPiMessages` → `convertPiHistory`）。项目关键规则 9 要求：进入对话流的状态（压缩记录、分支摘要、扩展通知等）必须「实时可见 + 重开可见」，且两条读取路径都要覆盖。
- **C（冲突）**：现状两路覆盖**倒挂**——RPC 路径（活跃 session 重开的主路径）丢弃 compaction / branch_summary / custom_message 三类记录，文件路径（离线重开）反而完整；auto-compaction（pi 自动压缩）实时与重开**双双隐形**；AGENTS.md 7.5 描述的 `get_messages → convertPiHistory` 路径已成死代码，文档过期。
- **Q（问题）**：怎么让两条路径的覆盖**by construction**（结构上不可能分叉）一致，且 compaction 生命周期对用户全程可见？
- **A（答案）**：把「entry 筛选 + 非 message entry → 伪消息映射」抽为共享单点 `mapSessionEntries`，两条路径只声明各自附加需求（RPC 要 clientUuidMap 回填 badge，文件要尾读窗口）；compaction 生命周期改由 pi 事件驱动（`compaction_start{reason}` 区分手动/自动，`compaction_end.result` 携带全部所需数据），dispatcher 只保留 RPC 触发与失败复位。本文展开这个答案。

### 系统是什么

runtime 历史读取链路（`packages/runtime/src/`）：

```
pi get_entries RPC ──→ entry-tree-builder.ts ──┐
                                                 ├→ convertPiHistory → Message[] → 前端对话流
session JSONL 文件 ──→ session-history.ts ─────┘
```

- **entry**：pi session 的持久化单元（JSONL 一行 / get_entries 数组一项）。本文涉及五种：`message`（user/assistant/toolResult/bashExecution）、`compaction`（压缩记录）、`branch_summary`（fork 分支摘要）、`custom_message`（参与 LLM context 的扩展消息，如 subagent-bg-notify/workflow-result）、`custom`（扩展纯数据，**不参与** context——xyz-client-msg-id 的 badge 映射用它）。
- **`custom` vs `custom_message` 是两种不同的 entry**（pi `session-manager.js` 两个方法：`appendCustomEntry` 写 `type:"custom"` 纯数据，`appendCustomMessageEntry` 写 `type:"custom_message"` 带 content/display 的消息）。后文所有「custom 数据 entry」指前者（badge 回填专用），「custom_message」指后者（bg-notify 等对话流消息）。
- **伪消息**：文件路径把非 message entry 映射成 `role:'compactionSummary'/'branchSummary'/'custom'` 的伪消息对象，让下游 `convertPiHistory` 用一套 role 分支统一处理——就是 §2 数据流图里 `mapEntriesToPiMessages` 干的事。

### 设计目标（从使用者体验倒推）

1. **G1 双路一致**：同一 session，活跃重开（RPC 路径）与离线重开（文件路径）看到的对话流一致——压缩记录、分支摘要、bg-notify 通知都在，不少一行。
2. **G2 auto-compaction 可见**：pi 自动压缩发生时，用户实时看到「自动压缩」生命周期（开始→完成/失败），重开后压缩记录仍在。
3. **G3 单一转换权威**：entry → Message 的判别只有一个实现，未来 pi 新增 entry 类型只改一处。
4. **G4 不回归现有能力**：RPC 路径独有的 badge 回填（client-msg-id → 图片/文件/skill badge）、piEntryId（fork 定位）、文件路径的尾读截断语义（「加载更多」显隐）。

### Scope

- **当前层 → 下一层**：runtime 历史链路技术方案 → 文件级实现拆分（§5）。
- **In-scope**：共享 mapper 抽取与两路径接入；compaction 生命周期事件驱动（dispatcher 零广播、interpreter 唯一源）；compacting reason 文案区分手动/自动（store + MessageStream + i18n）；**display 历史链路归一（完成通知 customType 在历史链路也写 display:false，消除关键规则 9 实时/重开可见性分叉，方案 Z，MF-新2）**；直接相关的契约清理（死分支、entry_appended、AGENTS.md 7.5 文档同步）。
- **Out-of-scope**：renderer 消息模型归一（`conversation-renderer-model-unification.md`，本次仅改 compacting 浮层文案；**display 历史链路归一除外**——MF-新2 把完成通知 customType 的 display 覆写前移到 runtime mapper + shared SSOT 常量，core/message-turns.ts 仅改引用源不过滤逻辑，非消息模型变更）；pi 侧行为（不改 pi）；WS 全量契约 SSOT 文档化（仅同步本文触及的消息注释）；`getHistoryTailFromFile` 的 20 turn 窗口策略（不改，场景测试约束 ≤20 turn）。

## §2 现状与问题分析

**现状是：同一个 session，agent 还在跑时重开看不到压缩记录，agent 退出后重开反而能看到——覆盖倒挂；pi 自动压缩则在任何路径都不可见。**

### 2.1 使用者视角的现状（真实例子）

用户在长 session 里手动执行过一次 compact，对话流出现一行「已压缩 · 45.2K → 12.3K tokens」（SystemNotice）。agent 仍在运行（session 活跃）。用户关掉这个面板再重开：

- **实际看到**：「已压缩」那行**消失了**。对话流从压缩前的消息直接接到压缩后的消息，中间没有任何记录。
- 等 agent 任务结束、pi 进程退出后再重开同一 session，「已压缩」那行**又出现了**。
- 若是 pi **自动**压缩（context 超阈值触发），则无论实时、活跃重开还是离线重开，用户**从未**看到过任何痕迹——只会发现 context 计数骤降、agent 对早前内容「失忆」，无任何解释。

### 2.2 物理数据流（现状）

```
【RPC 路径】session 活跃（重开/切换的主路径）
pi get_entries（全量 entry 树，含五类 entry）
  → rebuildHistoryFromEntries（entry-tree-builder.ts:92-116）
      第一遍扫描：只放行 type==='message'（提取 message + entryId）
                 + type==='custom' && customType==='xyz.client-msg-id'（建 clientUuidMap）
                 【compaction / branch_summary / custom_message 在此被跳过】← 截断点
  → convertPiHistory(messages, entryIds)（message-converter.ts:189）
      系统消息分支（role:'compactionSummary' 等）拿不到输入，永不触发
  → clientUuid 回填 badge（entry-tree-builder 第 3 步，RPC 独有）
  → Message[]（缺三类记录）

【文件路径】session 离线（无 pi 进程）
session JSONL（~/.xyz-agent/pi/agent/sessions/.../*.jsonl）
  → mapEntriesToPiMessages（session-history.ts:24-77）
      放行四类：message / compaction / custom_message / branch_summary
      非 message entry → 伪消息（role:'compactionSummary'/'custom'/'branchSummary'）
      message 透传 + __entryId 注入（fork 定位）
  → sessionStore.convertHistory（= convertPiHistory）
      role 分支正常触发 → 系统消息完整还原
  → Message[]（完整，但 user 消息无 badge 回填——custom 数据 entry 未消费）
```

### 2.3 覆盖差异矩阵（实测）

| entry 类型 | RPC 路径 | 文件路径 | 用户可感后果 |
|---|---|---|---|
| message（user/assistant/toolResult/bashExecution） | ✅ | ✅ | — |
| compaction（压缩记录） | ❌ 跳过 | ✅ → role:'compactionSummary' | 活跃重开丢压缩记录 |
| branch_summary（fork 分支摘要） | ❌ 跳过 | ✅ → role:'branchSummary' | 活跃重开丢分支摘要 |
| custom_message（bg-notify / workflow-result） | ❌ 跳过 | ✅ → role:'custom' | 活跃重开丢 subagent 完成通知 |
| custom（xyz.client-msg-id 数据） | ✅ clientUuidMap → badge 回填 | ❌ 跳过 | 离线重开 user 消息 badge 降级为纯文本 |

### 2.4 根因分析

**根因不是 convertPiHistory 有缺陷，而是它上游有两份独立的 entry 筛选实现，输入集合不同。**

- `convertPiHistory`（message-converter.ts:189-336）本身是两路**共用**的，role 分支（toolResult 合并 :196、compactionSummary :231、custom :253、branchSummary :283、bashExecution :308）完整。
- 但 `entry-tree-builder.ts:92-116` 的第一遍扫描只放行 `type==='message'` + `custom/client-msg-id`，其余 entry 注释一句「跳过（未来扩展点）」。`entry-tree-builder` 的头注释自称「C1 修复核心：复用 convertPiHistory 做 message→Message 翻译（含 toolResult 合并 / compactionSummary / custom / branchSummary 系统消息处理）」——**修复修对了下游转换器，漏了上游输入端**：系统消息分支在 RPC 路径永远拿不到这三类输入。
- 于是关键规则 9 的事故换了个路径复活：当年修的是「converter 不能过滤掉 compaction」，现在变成「RPC 路径的 entry 筛选根本没把 compaction 交给 converter」。

**auto-compaction 全链路隐形**是同一根因的另一面，叠加实时链路的事件吞噬：

- pi 手动与自动压缩都会发 `compaction_start{reason}` / `compaction_end{result|errorMessage}`（pi `agent-session.js:1370` 手动 `:1608` 自动）——但 runtime `event-adapter.ts:667` 的 NULL_EVENTS 把这两个事件吞掉，实时零反馈。
- 压缩产物 compaction entry 又被 RPC 路径丢弃（上表）——重开也丢。
- 手动 compact 不受影响：dispatcher（`message-dispatcher.ts:423`）手动编排了 compacting → compactionSummary → compacted 全流程。同一语义的两种触发源，可见性天差地别——与 steer/pending 的「按触发源分叉」同构。

**附带事实**：`rpc-client.ts:511` 的 `client.getHistory()`（pi `get_messages` RPC）生产代码零调用方（仅 port 声明与测试引用），AGENTS.md 7.5 描述的「RPC 路径 = get_messages → convertPiHistory」已过期，需同步。

## §3 解决方案

**终态：活跃重开与离线重开看到完全一致的对话流（含压缩记录/分支摘要/bg-notify）；auto-compaction 实时出现「自动压缩」生命周期行，重开后记录仍在；手动 compact 行为不变。**

### 3.1 终态（使用者视角）

**场景 1：活跃重开双路一致（G1）**

> 会话规模约束：≤20 turns（compact/fork/bg-notify 记录都在窗口内）。文件路径离线重开走 `getHistoryTailFromFile`（DEFAULT_MAX_TURNS=20，session-history.ts:15；降级点 session-service.ts:508/512/516），>20 turns 会截断与 RPC 全量天然不一致——若需测长会话，对比口径改为「文件路径『加载更多』全量加载后 diff」。

```
[用户在活跃 session（≤20 turns）手动 compact，对话流出现「已压缩 · 45.2K → 12.3K」]
[用户关闭面板，重开该 session（pi 进程仍活，走 RPC 路径）]
  → 对话流完整还原：「已压缩」记录行在原来的位置，与离线重开逐行一致
[fork 过的 session 重开] → 分支摘要行可见
[background subagent 完成过的 session 重开] → BgNotifyCard 可见
```

**场景 2：auto-compaction 实时可见（G2）**

> reason 区分文案**入 scope**（MF4）：现状前端 compacting 浮层固定文案 `t('panel.message.compressing')`（MessageStream.vue:93）、store `setCompacting(sessionId, boolean)` 无 reason（store.ts:471）、compacting handler 忽略 payload.reason（useChat.ts:186）。auto-compaction 可见化的核心价值就是区分手动/自动，故需改 store 记 reason + MessageStream 按 reason 切文案 + i18n 新增「正在自动压缩上下文」key，renderer 文件补入改动地图。

```
[长任务进行中，context 达到 pi 阈值]
  → 对话流出现压缩生命周期：「正在自动压缩上下文…」（compacting 态，reason=threshold/overflow 区分手动）
  → 完成后：「已自动压缩 · 152.4K → 38.1K tokens」记录行进对话流，context 计数刷新（estimatedTokensAfter 驱动）
[重开 session] → 该压缩记录仍在
```

**场景 3：压缩失败 / 取消（恢复指引，G2 失败路径）**

> 失败构造：xyz-agent 无 abortCompaction 暴露（runtime/renderer/core 全仓零命中），无法主动构造 abort。可行构造仅「模型请求失败」——切坏模型 key / 断网触发 LLM 报错。aborted 路径仅在未来暴露 abortCompaction 后可测。

```
[手动 compact，模型 key 错 / 断网 → LLM 报错]
  → compaction_end{aborted:false, errorMessage:"Compaction failed: ..."}（failed，errorMessage 真值）
  → interpreter：session.compacted{error} + 对话流错误提示
    「上下文压缩失败：<原因>」👉 可重试 /compact 或继续对话（上下文未压缩，agent 记忆未变）
  → compacting 复位；compacted error 非空 → 前端不 flush compact queue（队列保留）

[扩展 cancel / signal abort 路径（若未来暴露 abortCompaction）]
  → compaction_end{aborted:true}（无 errorMessage 真值）
  → interpreter：session.compacted（不带 error）→ 不提示失败；flush compact queue 释放积压消息（压缩未发生，在未变 context 上继续）
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 共享 mapper 单点（推荐）** | ✅ entry 判别唯一实现，by construction 双路一致；G3 达成，新增 entry 类型改一处 | 中：抽 `mapSessionEntries` + 两路径接入 + 删 `__entryId` 注入（message-converter 平行 entryIds 通道已就位）+ 单测 | 文件路径 `__entryId` → 平行数组的消费切换（convertPiHistory 已支持双通道，message-converter.ts:126-131，风险低）+ port 签名扩展（MF5）；compaction 事件驱动采用 dispatcher 零广播（决策1）后 P-dedup by construction 成立（§3.3.6），无需去重探针 | ✅ |
| B. 各自补齐（entry-tree-builder 补三类 entry 消费） | ❌ 两份 entry 筛选实现继续并存，下一次新增 entry 类型必然再漂移——本次倒挂正是这么产生的 | 小：entry-tree-builder 加三个分支 | 高（长期）：修一处漏一处的循环；文件路径的尾读收集（`session-history.ts:tailReadHistory` 内联四类判断）仍是第三份 | ❌ |
| C. RPC 路径回退 `get_messages` | ❌ 丢掉 RPC 独有的 badge 回填（`get_messages` 无 entry 树，client-msg-id 映射无处附着）；且 pi 现行 RPC 是 `get_entries`，`get_messages` 客户端已死代码化 | 小：session-service 换调用 | 高：G4 badge 回填回归；方向与 pi 演进相反 | ❌ |

**推荐 A 的理由**：倒挂的根因是「两份输入筛选」，任何保留两份实现的修法都在给下一次漂移留门。方案 A 把判别收敛到单点后，双路一致不再依赖「记得同步两处」——这与 contentBlocks「顺序 SSOT、禁止末位派生」、steer 解耦「对话流只认通知」是同一哲学的第三次应用：**判别前置到数据入口，下游不做二次猜测**。

**若用方案 B（§2.1 的例子会怎样）**：本次三类 entry 补上了，活跃重开能看到压缩记录。但 `tailReadHistory` 的尾读收集（`session-history.ts:239-244` 内联的 isMsg/isCompaction/isCustom/isBranch）是事实上的第三份筛选实现，下次 pi 新增 entry 类型（如 bash_execution 独立顶层 entry，`session-history.ts:39-44` 注释已预埋此变化）时，需要在三个地方同时想起这件事。

### 3.3 关键设计

#### 3.3.1 共享 mapper：`mapSessionEntries`（infra/pi 层）

新函数（放 `infra/pi/`，与 entry-tree-builder 同层，消费 `PiSessionEntry` 联合类型）。**前置（MF1）**：现状联合（pi-protocol.ts:540-545）只含 message/custom/label/compaction/branch_summary 五类，**不含 `custom_message`**（头注释 :536-538 明言「未建模」）。M1 先给联合补 `PiSessionCustomMessageEntry`（`type:'custom_message'` + customType/content/display/details，对齐 pi `session-manager.js:866` appendCustomMessageEntry 写入点）；pi-protocol.ts 补入改动地图（§5）。补全后联合覆盖本设计全部五类 entry：

```ts
interface MappedSessionEntries {
  /** 四类 entry 转换后的 message/伪消息序列（保持原始顺序） */
  messages: unknown[]
  /** 与 messages 平行的 entry id 数组（每条对应其来源 entry 的 id） */
  entryIds: string[]
  /** type:'custom' 纯数据 entry 全集（client-msg-id 等，仅 RPC 路径消费） */
  customDataEntries: PiSessionCustomEntry[]
}
function mapSessionEntries(entries: PiSessionEntry[]): MappedSessionEntries
```

映射规则**整体迁移**自 `mapEntriesToPiMessages`（session-history.ts:24-77，逻辑不重新发明）：

- `message` → 透传 message 体（**不再注入 `__entryId`**——见 3.3.2）
- `compaction` → 伪消息 `{role:'compactionSummary', summary, tokensBefore, timestamp}`
- `custom_message` → 伪消息 `{role:'custom', customType, content, details, display, timestamp}`；**完成通知类 customType 强制覆写 `display:false`**（display 归一，方案 Z，见下）
- `branch_summary` → 伪消息 `{role:'branchSummary', summary, fromId, timestamp}`
- `custom` → 不进 messages，进 `customDataEntries`（RPC 路径建 clientUuidMap 用）
- 其余（label/session_info 等）→ 跳过

**display 历史链路归一（方案 Z，MF-新2）**：完成通知类 custom_message（`subagent-bg-notify`/`workflow-result`）在实时链路被前端 `filterDisplayableMessages` 的 `HIDDEN_NOTIFY_CUSTOM_TYPES`（core/message-turns.ts:51）挡住不渲染——但历史链路（converter custom 分支 message-converter.ts:266 `display: cm.display`）直接透传 pi 持久化的 display 值，**无 HIDDEN_NOTIFY 兜底** → pi 持久化 display:true 时重开后这些通知冒出来显示，与实时链路可见性分叉（关键规则 9 实时/重开一致被破坏）。裁决：完成通知 customType 在 mapper 层强制覆写 `display:false`，与实时链路 registry 对称（实时靠 HIDDEN_NOTIFY 挡住，历史靠 display:false，两者都进 `filterDisplayableMessages` 的 `display===false` 分支统一挡住）。判别不分散在两处——**shared 层定义 SSOT 常量** `COMPLETE_NOTIFY_CUSTOM_TYPES = new Set(['subagent-bg-notify','workflow-result'])`（放 `packages/shared/src/message.ts`，从 core/message-turns.ts:51 提升），mapper 与 core/message-turns.ts 双向引用（消除分散判别，新增完成通知 customType 只改 shared 一处）。

#### 3.3.2 `__entryId` 注入删除，统一平行 entryIds

现状双通道：文件路径把 `__entryId` 塞进 message 体（`session-history.ts:74`），RPC 路径用平行 `entryIds` 数组传给 `convertPiHistory(messages, entryIds)`；`message-converter.ts:126-130` 已做双通道归一（优先 options.entryId，回退读 `m.__entryId`），两路最终都汇聚到 `msg.piEntryId`（fork 定位消费的是它）。

统一后：两条路径都走平行 `entryIds`（mapper 直接产出），文件路径的 `__entryId` 注入删除；`message-converter` 的 `__entryId` 回退**保留作防御**（旧测试/第三方调用不炸，:126-131 双通道归一），但生产路径不再产生。伪消息位置的 entryId 同样填入平行数组（compaction entry 也有 id），convertPiHistory 只给 user/assistant 填 piEntryId 的现状不变（:189 主函数，role 分支 :231/253/283/308 为 `if (m.role===...)` 顺序链非 `case`）。

**port 签名扩展（MF5）**：文件路径经 `ISessionStore.convertHistory(raw)`（ports/session.ts:91-92，**仅 raw 单参数**）调到 convertPiHistory，但底层 `convertPiHistory(raw, entryIds?)`（message-converter.ts:189）的第二参数 port 层未透传（session-store.ts:65-67 实现直接 `return convertPiHistory(raw)`）。删 `__entryId` 后文件路径必须让 convertPiHistory 收到平行 entryIds，否则伪消息与 message 的 piEntryId 丢失（piEntryId 填充 :126-131 优先 `options.entryId` 回退 `m.__entryId`，两条都断则 fork 定位丢）。扩 `ISessionStore.convertHistory(raw, entryIds?: string[])` + PiSessionStore 实现透传第二参数；ports/session.ts + session-store.ts 补入改动地图。RPC 路径不经 port（rebuildHistoryFromEntries 直连 infra 自带 entryIds），无此问题。

#### 3.3.3 两条路径的接入形态

- **RPC 路径**：`rebuildHistoryFromEntries(entries, segmentsMetadata)` 改为 = `mapSessionEntries`（拿 messages/entryIds/customDataEntries）→ `convertPiHistory(messages, entryIds)` → 第 3 步 badge 回填保留（clientUuidMap 从 `customDataEntries` 建，含现有的冲突 warn 防御，`entry-tree-builder.ts:100-112`）。
- **文件路径**：`getHistoryFromFilePath` / `tailReadHistory` 的「放行四类 + 伪消息映射」整体替换为 `mapSessionEntries`（`tailReadHistory` 内联收集同换——它只需 messages/entryIds，customDataEntries 忽略；现状放行四类 = message/compaction/custom_message/branch_summary，session-history.ts:24-77；bashExecution 以 `type:'message'+role:'bashExecution'` 走 message 分支透传，非顶层类型）。经 port 调用：`sessionStore.convertHistory(messages, entryIds)` 透传平行 entryIds（MF5）。尾读窗口/turn 边界/`truncated` 语义零变化（窗口筛选在前，mapper 只处理筛后的 entry 集；DEFAULT_MAX_TURNS=20 不变）。

#### 3.3.4 compaction 生命周期事件驱动（dispatcher 零广播 + interpreter 唯一源）

**设计原则**：compaction 生命周期的所有前端状态与反馈，由 interpreter 从 pi `compaction_start`/`compaction_end` 事件**唯一驱动**。dispatcher 的 `compact()` 退化为「预检 + RPC 触发 + 失败复位」三件事，**删除全部 compaction 生命周期广播**——4 类 type / **5 处语句**（message-dispatcher.ts:444 busy 预检拒绝路径 `session.compacted{error}` + :455 `session.compacting` + :466 catch 块 `session.compacted{error}` + :477 `message.compactionSummary` + :491 `session.compacted`；`compacted{error}` 出现 2 次分别在 busy 预检与 catch，按 type 类别算 4 类全覆盖，删语句时 :444 busy 预检路径易漏须单列，SUG-新1）。手动/自动两条触发源经同一事件流驱动，**by construction 不可能双发**——原方案 P-dedup 的「事件驱动 vs dispatcher 手动广播重叠去重」难题从「需探针验证」降为「结构上不可能」（准则 8 减法优先）。

**前提（已 pi dist 核实）**：
- pi 手动与自动 compact 都发 `compaction_start{reason}` + `compaction_end`（agent-session.js:1370 手动 `reason:'manual'` 硬编码 / :1608 自动 `reason:'threshold'|'overflow'`）。
- **手动 compact 失败时 catch 必发 `compaction_end`**（agent-session.js:1464-1483，无静默路径——LLM 报错/AbortError/extension 抛错全部落此 catch）再 rethrow → RPC `compact` 命令返回 `success:false` error reply。即手动失败有「事件 + RPC error」双信号；自动失败只发事件、**不 rethrow**（:1710-1718 `return false`，无 RPC reply）。
- `compaction_end.result` 成功时含 6 字段（summary/firstKeptEntryId/tokensBefore/estimatedTokensAfter/usage/details，:1441-1458 手动 / :1681-1694 自动，同构）。

**adapter**：`compaction_start` / `compaction_end` 从 NULL_EVENTS（event-adapter.ts:667，9 成员含这两者）移除，翻译为中间事件；`compaction_start.reason` 与 `compaction_end` 的 result/aborted/errorMessage 原样透传。

**interpreter 编排**（唯一驱动源）：

| 事件 | 广播 | 说明 |
|---|---|---|
| `compaction_start{reason}` | `session.compacting{reason}` | compacting 态置位（前端 setCompacting(true) + runtime `active.isCompacting=true`）；reason 驱动文案（手动「正在压缩」/ 自动「正在自动压缩上下文」，文案改动见 MF4） |
| `compaction_end{result}`（成功，result 真值） | `message.compactionSummary{summary, tokensBefore}` + `applyContextUpdate(estimatedTokensAfter)` + `session.compacted` | 压缩记录进对话流；context 计数刷新；compacting 复位（前端 setCompacting(false) + runtime `active.isCompacting=false`，与 start 对称，SUG-新2）+ flush compact queue |
| `compaction_end`（aborted，无 errorMessage 真值） | `session.compacted`（**不带 error**） | 取消（extension cancel :1623 / signal abort :1658 / 手动 catch 的取消类错误 :1468）——压缩未发生，不提示失败；compacting 复位（`active.isCompacting=false`，与 start 对称）；按现状 compacted handler 语义 flush 队列（释放 compacting 期间积压消息，在未变 context 上继续） |
| `compaction_end{errorMessage:<msg>}`（failed，errorMessage 真值） | `session.compacted{error}` + 对话流错误提示 | 真失败——「上下文压缩失败：<原因>」+ 恢复指引；compacting 复位（`active.isCompacting=false`，与 start 对称，SUG-新2）；前端 compacted handler error 非空 → 不 flush（队列保留） |

**failed 判据：以 `errorMessage` 真值为准（非 aborted 字段、非 key 存在性）**。理由：pi 的三种 aborted:true 形态在「errorMessage 真值」层面一致（都为 falsy）——extension cancel（:1623）/ signal abort（:1658）对象字面量**无 errorMessage key**；手动 catch 的取消类错误（:1468）显式写 `errorMessage: aborted ? undefined : ...`（key 在但值为 undefined）。而 aborted 字段本身不可靠（手动 catch :1466 里 aborted 是动态计算：`"Compaction cancelled"` / `AbortError` → true，其余 → false）。故失败分叉以 **errorMessage 真值**为唯一判据——三种 aborted:true 在真值层面与 JSON wire format 层面都等价（`undefined` 被 `JSON.stringify` 省略），分叉干净。文档与实现统一约定此口径。

**孤儿 compaction_end 容错（SUG-新3）**：interpreter 编排假设「compaction_start 必先于 compaction_end」，但 pi overflow「已 retry 过一次」早退路径（agent-session.js:1544-1550，`_overflowRecoveryAttempted` 为 true 时）**不发 compaction_start 直接发 compaction_end**（`reason:"overflow"` + `aborted:false` + truthy `errorMessage` + `result:undefined`）——此路径跳过了 `_runAutoCompaction`（:1595，compaction_start 发出点 :1608），故无 preceding start，interpreter 的 compaction_start 置位从未执行。容错要求：compaction_end handler 的复位操作（`active.isCompacting=false`、前端 setCompacting(false)、flush 判定）对「本来就 false 的 isCompacting」幂等无害（setCompacting(false) 对 false 无操作，flush 按 error 真值判定照常——此孤儿 end 的 errorMessage 真值 → failed 分支 → 不 flush）；但文档须提此路径——interpreter **不得维护 start/end 配对状态机**（不因「未收到对应 start」而拒绝处理 end），end 自洽处理（复位 + 按 errorMessage 真值判分支）。这条孤儿 end 在历史链路也会被 pi 持久化（compaction entry / custom_message），mapper 与 converter 照常映射。

**dispatcher `compact()`（message-dispatcher.ts:423-500）改为三件事**：
1. **busy 预检（补 isCompacting 拒绝）**：现状预检（:439）`if (active.isBashRunning || active.isGenerating)` 只防「bash/generating 重入 compact」——这是**已存在**的方向（sendPrompt:111 / sendBash:255 已反向拒 isCompacting，:433-437 注释明言双向互斥已补齐）。补 `|| active.isCompacting` 防的是**第二个并发 compact() 重入**：A 置位 isCompacting（:458）后，B 进来预检若不查 isCompacting 就看不到 A → 两个 `client.compact` RPC 并发 → 双 compaction 事件流。补上后 P-dedup by construction 成立。
2. **RPC 触发**：`client.compact()`（:462）。
3. **catch（失败复位）**：**删除** `session.compacted{error}` 兜底广播（:467）与 toast；只做 `isCompacting = false` 复位（:498 finally）+ 传播 RPC error（throw/reject）。错误反馈统一归 interpreter。

**错误提示通道选择（interpreter 对话流 vs useChat toast）→ 选 interpreter，useChat `compact()` catch 删 toast（MF-新1）**。理由：pi 手动 compact 失败**必发** compaction_end{errorMessage}（无静默路径），interpreter 是确定可见的错误源；而 useChat `compact()` catch（:506）的 `deps.toast.error(...)` 对**所有 RPC 失败无条件触发**——failed 路径 interpreter 已从 compaction_end{errorMessage} 提示（双提示），aborted 路径取消却显示失败 toast（误提示）。useChat compacted handler :190 注释已警惕此双 toast bug。裁决：catch **删 toast**，错误提示统一归 interpreter（compaction_end{errorMessage} → 对话流错误提示）。auto compact 失败无 RPC reply（不 rethrow），dispatcher 根本不参与——只有 interpreter 能统一覆盖手动+自动两路失败。transport 级失败（RPC 未达 pi，pi 来不及发 compaction_end）不触发 interpreter，此时靠 **chatApi 层通用错误处理**兜底（非 compact 专属 toast）——compact 失败不单独 toast，与其它 RPC 命令失败同走通用通道。

**isCompacting 状态源切换**：前端 compacting 态从「dispatcher 标记」改为「session.compacting/compacted 消息」驱动。现状前端 handler（useChat.ts:186/190）订阅的正是这两个消息，切换后**handler 体零改动**（compacting handler 仍 `setCompacting(sid,true)`，compacted handler 仍按 error 决 flush）；但 reason 文案区分需改 store + MessageStream（见 MF4）。

**auto-compaction 可见化对 compact queue / 提交互斥的连锁影响**（新增分析）：
- 现状 auto compact 期间，前端无 compacting 态，Composer 直接 sendPrompt（sendPrompt:111 预检虽查 isCompacting，但 runtime 侧 `active.isCompacting` 只在 dispatcher 手动 compact 路径 :458 设置，auto 期间为 false）→ 用户消息正常进 pi，pi 内部 followUp/steering 排队。
- 可见化后，auto 的 compaction_start → 前端 setCompacting(true) → Composer 切 queueSend（Composer.vue:115 检测 isCompacting 路由，真正入队在 useComposerShell 层）→ 用户消息进 xyz 前端 compact queue → compaction_end → flush 重放。
- **裁决：接受「auto 期间走前端队列」的新行为**。理由：手动 compact 已是此模型（用户预期 compacting 期间消息排队），auto 与手动经同一事件流后行为一致，用户心智统一；pi 内部排队与前端队列并发可能致顺序歧义，但 auto compact 窗口短（秒级），flush 后顺序由 xyz 前端保证。代价：auto 期间 `active.isCompacting` 需由 compaction_start 事件驱动（interpreter 置位），sendPrompt 预检才能正确拦截——这是 M4 的一部分。**复位对称（SUG-新2）**：interpreter 必须在 compaction_end（成功/aborted/failed 三路）**复位** `active.isCompacting=false`，与 compaction_start 置位对称——否则 auto compact 结束后 `active.isCompacting` 永远 true，sendPrompt 预检（:111）永远拒绝，session 卡死（现状 dispatcher 手动路径靠 finally :498 复位，事件驱动后此 finally 随零广播一同删除，复位责任转移到 interpreter）。

#### 3.3.5 契约清理（随本设计一并做）

| 项 | 位置 | 处理 |
|---|---|---|
| adapter 死分支：`message_start{role:compactionSummary/branchSummary}` | `event-adapter.ts:493-510`（compactionSummary :493 / branchSummary :502） | 删除（实时 compactionSummary 改由 3.3.4 事件驱动）。注：「pi 从不发此 role」属**运行时断言**（pi message_start handler :374-386 注释「persisted elsewhere」为旁证，:381 唯一命中），仅凭 xyz 侧代码无法证实——M5 用 grep 历史 session JSONL 实测确认无 `message_start.*compactionSummary` 命中后再删 |
| `agent_start` hook 不可达分支 | `event-adapter.ts:738-741`（NULL_EVENTS:668 含 agent_start 先吞，:739 分支**静态不可达**——控制流事实，非运行时断言） | 裁决：**从 NULL_EVENTS 移除让分支可达**。理由：该分支产 `kind:'hook'` 交 interpreter `executeHooks('onPiEvent')`（event-interpreter.ts:259），消费方是**插件系统**（非前端 UI）——删分支会静默移除插件对 agent_start 的观测。注：onPiEvent 在 tool_execution_start/end、agent_end 等路径仍活，仅 agent_start 这一入口因 NULL_EVENTS 不可达。若确认无插件依赖 agent_start 观测，可选「删分支 + 注明牺牲」，默认保留可达 |
| `entry_appended` 未登记 | pi-protocol.ts:399-402 已声明类型（`entry: Record<string,unknown>`，非 any），NULL_EVENTS/DISPATCHER 均无 → extension 调 ctx.appendEntry（agent-session.js:1865-1871 emit :1868）每次刷 `console.warn('Unhandled pi event type')`（event-adapter.ts:747） | 登记 NULL_EVENTS（pi 会 emit，xyz 无前端消费方）。注：仅 extension ctx.appendEntry 路径 emit，内部 append（appendCompaction 等）不 emit |
| AGENTS.md 7.5 描述过期 | 「RPC 路径 = client.getHistory → pi get_messages → convertPiHistory」 | 同步为「get_entries → rebuildHistoryFromEntries（经共享 mapper）→ convertPiHistory」；`client.getHistory()`（rpc-client.ts:511，pi get_messages）死代码标注或删除（pi 当前依赖 0.84.1） |

#### 3.3.6 运行时断言探针清单（准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-entries-types | pi `get_entries` 返回的 entry 树含 `type:'compaction'/'branch_summary'/'custom_message'/'custom'`（pi 源码写入点存在） | pi dist session-manager.js:803（appendCompaction）/ 1059（branchWithSummary 内 branch_summary）/ 866（appendCustomMessageEntry）/ 820（appendCustomEntry）四处 append 实现，type 全硬编码字符串字面量 | ✅ 已验证 |
| P-compaction-end-result | `compaction_end.result` 成功含 6 字段（summary/firstKeptEntryId/tokensBefore/estimatedTokensAfter/usage/details）；失败路径带 `errorMessage`、`aborted` | pi dist agent-session.js:1441-1458（手动 result）/ 1681-1694（auto 同构）/ 1464-1483（手动 catch emit，aborted 动态）/ 1710-1718（auto catch） | ✅ 已验证 |
| P-manual-reason | 手动 compact（RPC 触发）同样发 `compaction_start{reason:'manual'}`（硬编码）+ `compaction_end`；失败 catch **必发**（无静默路径）+ rethrow → RPC error reply | pi dist agent-session.js:1370（start）/ 1464-1483（catch 必发 + rethrow）/ rpc-mode.js:416-419（compact → error reply） | ✅ 已验证 |
| P-dedup | 手动 compact 不出现双 compacting / 双 compactionSummary / 双 compacted | dev app 手动 compact，观察对话流只出现一条压缩记录、compacting 只出现一次 | ✅ **by construction**：dispatcher 零广播（§3.3.4 决策1）后，compacting/compactionSummary/compacted 全部由 interpreter 从 compaction_start/end 唯一驱动；预检补 isCompacting（:439）防并发 compact 重入。机制保证，非探针验证 |
| P-badge-backfill | RPC 路径 badge 回填（client-msg-id → segments）不回归 | 含图片 badge 的 user 消息，活跃重开后仍渲染 badge（非纯文本） | ⛔ 实施期 M2 |
| P-fork-locate | `__entryId` 注入删除后 fork 定位（msg.piEntryId）不受影响 | 文件路径重开后执行 fork，分支点定位正确（从 piEntryId 读） | ⛔ 实施期 M3 |
| P-failed-judge | interpreter 以 `errorMessage` 真值为失败判据：aborted（cancel/abort）不提示失败、failed（LLM 报错）提示失败 | dev app 构造 failed（坏模型 key），观察对话流错误提示 + compacted 不 flush；若未来暴露 abort，验证 aborted 不提示 + flush | ⛔ 实施期 M4 |
| P-auto-queue | auto compact 期间用户消息进前端 compact queue，compaction_end 后 flush 重放（非 pi 内部排队） | dev app 长跑触发 auto compact，期间发消息，观察消息进 queue 待 flush | ⛔ 实施期 M4 |
| P-msg-start-dead | message_start{compactionSummary/branchSummary} 在历史 session JSONL 中零命中（证死分支可删） | grep 历史 session 文件 `message_start.*compactionSummary` | ⛔ 实施期 M5 |

## §4 验收

**改动规模：中等偏大（runtime 数据链路行为变更 + 事件流变更）。验收用真实 dev app + 真实 pi session，非单测非 mock；单测仅作回归辅助。**

### 场景 1：活跃重开双路一致（回溯 G1）

- **上下文**：dev app 连真实 pi，某 **≤20 turns** session（MF6：文件路径 `getHistoryTailFromFile` 截断窗口）里有一次手动 compact 记录、一次 fork 分支摘要、一条 background subagent 完成通知（BgNotifyCard）；pi 进程保持存活
- **步骤**：关闭该 session 面板 → 从 sidebar 重开（RPC 路径）→ 逐行对照压缩记录/分支摘要/bg-notify 是否在场
- **通过标准**：三类记录全部可见，位置与原对话一致；随后等 pi 进程退出再重开（文件路径），两路内容逐行一致

### 场景 2：auto-compaction 全程可见（回溯 G2）

- **上下文**：dev app，构造真实自动压缩（长跑 session 至 context 超 pi 阈值；无低阈值配置时接受用长上下文任务自然触发，记录触发时 context 计数）
- **步骤**：观察压缩发生时的对话流与 context 计数 → 压缩完成后重开 session
- **通过标准**：实时出现「正在自动压缩上下文…」→「已自动压缩 · N→M tokens」；context 计数刷新；重开后该记录仍在；全程无残留 compacting 菊花

### 场景 3：压缩失败恢复（回溯 G2 失败路径）

- **步骤**：构造压缩失败——切坏模型 key / 断网触发 LLM 报错（S3：xyz-agent 无 abortCompaction 暴露，abort 路径不可主动构造，仅未来暴露后补测）
- **通过标准**：对话流出现错误提示「上下文压缩失败：<原因>」+ 恢复指引（interpreter 从 `compaction_end{errorMessage}` 驱动，决策2）；compacting 态复位；compacted error 非空 → compact queue 不 flush；session 可继续正常对话

### 场景 4：现有能力不回归（回溯 G4）

- **步骤**：① 含图片/文件 badge 的 user 消息，活跃重开（RPC 路径）→ badge 渲染不降级；② 离线重开后执行 fork → 分支点定位正确；③ 长 session 顶部「加载更多」显隐与截断语义不变
- **通过标准**：三项行为与改动前一致

### 场景 5：双路径序列 diff（回溯 G3）

- **步骤**：同一 **≤20 turns** session（MF6），活跃时经 RPC 路径导出历史 Message[]；进程退出后经文件路径导出；diff 两序列（role/种类/顺序/关键字段）。若用 >20 turns session，文件路径需先「加载更多」全量加载再 diff
- **通过标准**：序列一致（允许的唯一差异：文件路径 user 消息无 badge 回填降级为 text——G4 已知差异，改动前后一致）

## §5 下一层拆分

### 实施路径

| 步骤 | 交付 | 独立验证 |
|---|---|---|
| M1 共享 mapper | `infra/pi/session-entry-mapper.ts` 新增 `mapSessionEntries` + 单测（四类映射/custom 数据 entry 分流/畸形 data 降级/平行 entryIds/**完成通知 customType 覆写 display:false**）；pi-protocol.ts 补 `PiSessionCustomMessageEntry`（MF1）；shared/message.ts 提升 `COMPLETE_NOTIFY_CUSTOM_TYPES` SSOT 常量（MF-新2） | 单测 |
| M2 RPC 路径接入 | `rebuildHistoryFromEntries` 改用 mapper（clientUuidMap 从 customDataEntries 建，badge 回填保留） | 场景 1 + P-badge-backfill |
| M3 文件路径接入 | `getHistoryFromFilePath`/`tailReadHistory` 换 mapper；删 `__entryId` 注入；扩 port 签名 `convertHistory(raw, entryIds?)` + PiSessionStore 透传（MF5） | 场景 4② + P-fork-locate + 场景 5 |
| M4 compaction 事件驱动 | adapter 放开两事件 + interpreter 编排（errorMessage 真值判据 + isCompacting 置位/复位对称 SUG-新2 + 孤儿 end 容错 SUG-新3）+ dispatcher 零广播（补 isCompacting 预检）+ compacting reason 文案（MF4） | 场景 2/3 + P-dedup（by construction）+ P-failed-judge + P-auto-queue |
| M5 契约清理 + 文档同步 | §3.3.5 四项 + agent_start 从 NULL_EVENTS 移除（S1）+ PiCompactionEndEvent.result 收紧类型（S5） | grep 无死分支；P-msg-start-dead 实测；AGENTS.md 7.5 更新 |

拆分理由：M1-M3 是「双路一致」主线（mapper 先行，两路径各自独立可验）；M4 是 compaction 可见性主线（依赖 M1 的 compaction 映射才能让重开可见，故排在 M1 后；与 M2/M3 无代码耦合但共享场景 1 的验收上下文）；M5 纯清理放最后防干扰主线。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/runtime/src/infra/pi/session-entry-mapper.ts` | **新增**：`mapSessionEntries`（逻辑迁自 session-history.ts:24-77） |
| `packages/runtime/src/infra/pi/pi-protocol.ts` | **新增** `PiSessionCustomMessageEntry`（type:'custom_message' + customType/content/display/details，MF1）；`PiCompactionEndEvent.result` 从 `result?: unknown`（:359）收紧为 `CompactionResult` 形状（复用 ports/pi-engine.ts:45-50 的 summary/firstKeptEntryId/tokensBefore/estimatedTokensAfter，S5；成功 6 字段、失败 undefined）；entry_appended 类型已声明（:399-402）不动 |
| `packages/runtime/src/infra/pi/entry-tree-builder.ts` | 第一遍扫描换成 mapper；clientUuidMap 改从 customDataEntries 建（:100-112）；头注释更新 |
| `packages/runtime/src/services/session-history.ts` | 删 `mapEntriesToPiMessages`（迁出）；`getHistoryFromFilePath`/`tailReadHistory` 接入 mapper（经 port 透传 entryIds）；删 `__entryId` 注入 |
| `packages/runtime/src/services/ports/session.ts` | `ISessionStore.convertHistory(raw)`（:91-92）扩为 `convertHistory(raw, entryIds?: string[])`（MF5） |
| `packages/runtime/src/infra/pi/session-store.ts` | PiSessionStore.convertHistory 实现（:65-67）透传第二参数 entryIds 给 convertPiHistory（MF5） |
| `packages/runtime/src/infra/pi/event-adapter.ts` | NULL_EVENTS（:667，9 成员）移除 compaction_start/end；agent_start 从 NULL_EVENTS 移除让 hook 分支可达（S1）；删 message_start 死分支（:493-510，M5 实测确认后）；登记 entry_appended 入 NULL_EVENTS |
| `packages/runtime/src/services/session/event-interpreter.ts` | 新增 compaction_start/end 编排（§3.3.4 表格）；以 **errorMessage 真值**为 failed 判据；compaction_start 置位 + compaction_end（成功/aborted/failed 三路）**复位** active.isCompacting（对称，SUG-新2）；孤儿 compaction_end 容错（overflow 早退路径 agent-session.js:1544 无 preceding start，end handler 幂等自洽，SUG-新3） |
| `packages/runtime/src/services/session/message-dispatcher.ts` | compact（:423-500）**零广播**：删 4 类 type / 5 处语句（:444 busy 预检 compacted{error} + :455 compacting + :466 catch compacted{error} + :477 compactionSummary + :491 compacted，SUG-新1）；预检（:439）补 isCompacting 条件（防并发 compact 重入）；catch 只复位 isCompacting（:498）+ 传播 RPC error |
| `packages/runtime/src/infra/pi/message-converter.ts` | custom 分支（:253-272）引用 `COMPLETE_NOTIFY_CUSTOM_TYPES`（shared SSOT）对完成通知 customType 覆写 `display:false`（display 归一，MF-新2）；`__entryId` 回退 :126-131 保留作防御，注释标注生产路径已不再产生；role 分支 :231/253/283/308 为 if 链 |
| `packages/shared/src/message.ts` | **新增** `COMPLETE_NOTIFY_CUSTOM_TYPES = new Set(['subagent-bg-notify','workflow-result'])` SSOT 常量（从 core/message-turns.ts:51 提升，MF-新2）；mapper 与 core 双向引用 |
| `packages/core/src/domain/chat/message-turns.ts` | `HIDDEN_NOTIFY_CUSTOM_TYPES`（:51）改为引用 shared `COMPLETE_NOTIFY_CUSTOM_TYPES`（消除分散判别，过滤逻辑不变，MF-新2） |
| `packages/core/src/domain/chat/store.ts` | `setCompacting(sessionId, value)`（:471）扩 reason 参数（MF4）；底层结构从 `Set<string>` 调整为可挂 reason |
| `packages/renderer/src/components/panel/MessageStream.vue` | compacting 浮层（:93）按 reason 切文案：手动 `t('panel.message.compressing')` / 自动 `t('panel.message.autoCompressing')`（MF4） |
| i18n 文件（zh/en） | 新增 `panel.message.autoCompressing` key（MF4） |
| `packages/core/src/domain/chat/useChat.ts` | compacting handler（:186）传 reason 给 setCompacting；compacted handler（:190）注释更新「错误反馈归 interpreter」；**compact() catch 删 toast（:506）**——错误统一归 interpreter（compaction_end{errorMessage}），transport 级失败走 chatApi 通用错误处理（非 compact 专属 toast，MF-新1） |
| `AGENTS.md` 关键规则 9 | RPC 路径描述同步为 get_entries → mapper → convertPiHistory |
| 测试 | mapper 单测新增；entry-tree-builder/session-history/dispatcher/interpreter 相关用例同步 |

### 待验证检查点

1. **willRetry 中间态**（M4）：auto compaction 成功路径 `compaction_end{willRetry}`（agent-session.js:1694）的 willRetry 可能为 true（pi 内部重试）——interpreter 广播 session.compacted 时不应把 willRetry=true 当成失败；前端 compacted handler（useChat.ts:190）只看 error 字段，willRetry 不影响 flush 语义，但需确认 interpreter 不误传 error。
2. **尾读窗口与 mapper 的顺序**（M3）：`tailReadHistory` 先在原始 entry 集上按 turn 边界截窗、再把窗口内 entry 交给 mapper——保持现有顺序（窗口语义零变化），mapper 不参与截窗。
3. **auto-compaction reason 值集**（M4，已核实）：pi 自动触发时 reason = `"threshold"` / `"overflow"`（agent-session.js `_checkCompaction` 两分支），前端文案映射做兜底（未知 reason 按自动处理）。
