# 对话历史双链路统一：共享 entry 映射 + compaction 生命周期事件驱动

> **一句话结论**：两条历史读取路径（RPC/文件）的 entry 筛选与伪消息映射统一为共享单点 `mapSessionEntries`，convertPiHistory 继续共用于下游——覆盖倒挂 by construction 消除；compaction 生命周期（手动+自动）改由 pi `compaction_start/compaction_end` 事件驱动，`compaction_end.result` 自带 summary/tokensBefore/estimatedTokensAfter，dispatcher 手动广播退出。

## §1 背景目标

- **S（情境）**：xyz-agent 的对话历史有两条读取路径——**RPC 路径**（session 活跃有 pi 进程，`get_entries` → `rebuildHistoryFromEntries`）与**文件路径**（session 离线无进程，解析 session JSONL → `mapEntriesToPiMessages` → `convertPiHistory`）。项目规则 7.5 要求：进入对话流的状态（压缩记录、分支摘要、扩展通知等）必须「实时可见 + 重开可见」，且两条读取路径都要覆盖。
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
- **In-scope**：共享 mapper 抽取与两路径接入；compaction 生命周期事件驱动（含 dispatcher 去重）；直接相关的契约清理（死分支、entry_appended、AGENTS.md 7.5 文档同步）。
- **Out-of-scope**：renderer 消息模型归一（`conversation-renderer-model-unification.md`）；pi 侧行为（不改 pi）；WS 全量契约 SSOT 文档化（仅同步本文触及的消息注释）；`getHistoryTailFromFile` 的 20 turn 窗口策略（不改）。

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
  → rebuildHistoryFromEntries（entry-tree-builder.ts:93-115）
      第一遍扫描：只放行 type==='message'（提取 message + entryId）
                 + type==='custom' && customType==='xyz.client-msg-id'（建 clientUuidMap）
                 【compaction / branch_summary / custom_message 在此被跳过】← 截断点
  → convertPiHistory(messages, entryIds)（message-converter.ts:189）
      系统消息分支（role:'compactionSummary' 等）拿不到输入，永不触发
  → clientUuid 回填 badge（entry-tree-builder 第 3 步，RPC 独有）
  → Message[]（缺三类记录）

【文件路径】session 离线（无 pi 进程）
session JSONL（~/.xyz-agent/pi/agent/sessions/.../*.jsonl）
  → mapEntriesToPiMessages（session-history.ts:22-83）
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
- 但 `entry-tree-builder.ts:93-115` 的第一遍扫描只放行 `type==='message'` + `custom/client-msg-id`，其余 entry 注释一句「跳过（未来扩展点）」。`entry-tree-builder` 的头注释自称「C1 修复核心：复用 convertPiHistory 做 message→Message 翻译（含 toolResult 合并 / compactionSummary / custom / branchSummary 系统消息处理）」——**修复修对了下游转换器，漏了上游输入端**：系统消息分支在 RPC 路径永远拿不到这三类输入。
- 于是规则 7.5 的事故换了个路径复活：当年修的是「converter 不能过滤掉 compaction」，现在变成「RPC 路径的 entry 筛选根本没把 compaction 交给 converter」。

**auto-compaction 全链路隐形**是同一根因的另一面，叠加实时链路的事件吞噬：

- pi 手动与自动压缩都会发 `compaction_start{reason}` / `compaction_end{result|errorMessage}`（pi `agent-session.js:1370` 手动 `:1608` 自动）——但 runtime `event-adapter.ts:667` 的 NULL_EVENTS 把这两个事件吞掉，实时零反馈。
- 压缩产物 compaction entry 又被 RPC 路径丢弃（上表）——重开也丢。
- 手动 compact 不受影响：dispatcher（`message-dispatcher.ts:423`）手动编排了 compacting → compactionSummary → compacted 全流程。同一语义的两种触发源，可见性天差地别——与 steer/pending 的「按触发源分叉」同构。

**附带事实**：`rpc-client.ts:511` 的 `client.getHistory()`（pi `get_messages` RPC）生产代码零调用方（仅 port 声明与测试引用），AGENTS.md 7.5 描述的「RPC 路径 = get_messages → convertPiHistory」已过期，需同步。

## §3 解决方案

**终态：活跃重开与离线重开看到完全一致的对话流（含压缩记录/分支摘要/bg-notify）；auto-compaction 实时出现「自动压缩」生命周期行，重开后记录仍在；手动 compact 行为不变。**

### 3.1 终态（使用者视角）

**场景 1：活跃重开双路一致（G1）**

```
[用户在活跃 session 手动 compact，对话流出现「已压缩 · 45.2K → 12.3K」]
[用户关闭面板，重开该 session（pi 进程仍活，走 RPC 路径）]
  → 对话流完整还原：「已压缩」记录行在原来的位置，与离线重开逐行一致
[fork 过的 session 重开] → 分支摘要行可见
[background subagent 完成过的 session 重开] → BgNotifyCard 可见
```

**场景 2：auto-compaction 实时可见（G2）**

```
[长任务进行中，context 达到 pi 阈值]
  → 对话流出现压缩生命周期：「正在自动压缩上下文…」（compacting 态，reason=threshold/overflow 区分手动）
  → 完成后：「已自动压缩 · 152.4K → 38.1K tokens」记录行进对话流，context 计数刷新（estimatedTokensAfter 驱动）
[重开 session] → 该压缩记录仍在
```

**场景 3：压缩失败（恢复指引，G2 失败路径）**

```
[自动/手动压缩失败]
  → compaction_end{result:undefined, errorMessage} → 对话流错误提示：
    「上下文压缩失败：<原因>」👉 可重试 /compact 或继续对话（上下文未压缩，agent 记忆未变）
  → compacting 态复位，不残留菊花
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 共享 mapper 单点（推荐）** | ✅ entry 判别唯一实现，by construction 双路一致；G3 达成，新增 entry 类型改一处 | 中：抽 `mapSessionEntries` + 两路径接入 + 删 `__entryId` 注入（message-converter 平行 entryIds 通道已就位）+ 单测 | 文件路径 `__entryId` → 平行数组的消费切换（convertPiHistory 已支持双通道，`message-converter.ts:126-130`，风险低）；compaction 事件驱动与 dispatcher 手动广播的重叠去重（探针 P-dedup） | ✅ |
| B. 各自补齐（entry-tree-builder 补三类 entry 消费） | ❌ 两份 entry 筛选实现继续并存，下一次新增 entry 类型必然再漂移——本次倒挂正是这么产生的 | 小：entry-tree-builder 加三个分支 | 高（长期）：修一处漏一处的循环；文件路径的尾读收集（`session-history.ts:tailReadHistory` 内联四类判断）仍是第三份 | ❌ |
| C. RPC 路径回退 `get_messages` | ❌ 丢掉 RPC 独有的 badge 回填（`get_messages` 无 entry 树，client-msg-id 映射无处附着）；且 pi 现行 RPC 是 `get_entries`，`get_messages` 客户端已死代码化 | 小：session-service 换调用 | 高：G4 badge 回填回归；方向与 pi 演进相反 | ❌ |

**推荐 A 的理由**：倒挂的根因是「两份输入筛选」，任何保留两份实现的修法都在给下一次漂移留门。方案 A 把判别收敛到单点后，双路一致不再依赖「记得同步两处」——这与 contentBlocks「顺序 SSOT、禁止末位派生」、steer 解耦「对话流只认通知」是同一哲学的第三次应用：**判别前置到数据入口，下游不做二次猜测**。

**若用方案 B（§2.1 的例子会怎样）**：本次三类 entry 补上了，活跃重开能看到压缩记录。但 `tailReadHistory` 的尾读收集（`session-history.ts:210-220` 内联的 isMsg/isCompaction/isCustom/isBranch）是事实上的第三份筛选实现，下次 pi 新增 entry 类型（如 bash_execution 独立顶层 entry，`session-history.ts:39-44` 注释已预埋此变化）时，需要在三个地方同时想起这件事。

### 3.3 关键设计

#### 3.3.1 共享 mapper：`mapSessionEntries`（infra/pi 层）

新函数（放 `infra/pi/`，与 entry-tree-builder 同层，消费 `PiSessionEntry` 联合类型——`pi-protocol.ts:540` 已含 message/custom/label/compaction/branch_summary 全联合）：

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

映射规则**整体迁移**自 `mapEntriesToPiMessages`（session-history.ts:22-83，逻辑不重新发明）：

- `message` → 透传 message 体（**不再注入 `__entryId`**——见 3.3.2）
- `compaction` → 伪消息 `{role:'compactionSummary', summary, tokensBefore, timestamp}`
- `custom_message` → 伪消息 `{role:'custom', customType, content, details, display, timestamp}`
- `branch_summary` → 伪消息 `{role:'branchSummary', summary, fromId, timestamp}`
- `custom` → 不进 messages，进 `customDataEntries`（RPC 路径建 clientUuidMap 用）
- 其余（label/session_info 等）→ 跳过

#### 3.3.2 `__entryId` 注入删除，统一平行 entryIds

现状双通道：文件路径把 `__entryId` 塞进 message 体（`session-history.ts:72`），RPC 路径用平行 `entryIds` 数组传给 `convertPiHistory(messages, entryIds)`；`message-converter.ts:126-130` 已做双通道归一（优先 options.entryId，回退读 `m.__entryId`），两路最终都汇聚到 `msg.piEntryId`（fork 定位消费的是它）。

统一后：两条路径都走平行 `entryIds`（mapper 直接产出），文件路径的 `__entryId` 注入删除；`message-converter` 的 `__entryId` 回退**保留作防御**（旧测试/第三方调用不炸），但生产路径不再产生。伪消息位置的 entryId 同样填入平行数组（compaction entry 也有 id），convertPiHistory 只给 user/assistant 填 piEntryId 的现状不变。

#### 3.3.3 两条路径的接入形态

- **RPC 路径**：`rebuildHistoryFromEntries(entries, segmentsMetadata)` 改为 = `mapSessionEntries`（拿 messages/entryIds/customDataEntries）→ `convertPiHistory(messages, entryIds)` → 第 3 步 badge 回填保留（clientUuidMap 从 `customDataEntries` 建，含现有的冲突 warn 防御，`entry-tree-builder.ts:100-112`）。
- **文件路径**：`getHistoryFromFilePath` / `tailReadHistory` 的「放行四类 + 伪消息映射」整体替换为 `mapSessionEntries`（`tailReadHistory` 约 :203-218 的内联收集同换——它只需 messages/entryIds，customDataEntries 忽略）。尾读窗口/turn 边界/`truncated` 语义零变化（窗口筛选在前，mapper 只处理筛后的 entry 集）。

#### 3.3.4 compaction 生命周期事件驱动

- **adapter**：`compaction_start` / `compaction_end` 从 NULL_EVENTS（`event-adapter.ts:667`）移除，翻译为中间事件；`compaction_start.reason`（manual/threshold/overflow）原样透传。
- **interpreter** 编排：
  - `compaction_start` → 广播 `session.compacting{reason}`（前端 compacting 态，reason 驱动文案：手动「正在压缩」/ 自动「正在自动压缩上下文」）
  - `compaction_end{result}` → 广播 `message.compactionSummary{summary, tokensBefore}`（进对话流）+ `applyContextUpdate(estimatedTokensAfter)`（刷 context 计数）+ `session.compacted`
  - `compaction_end{result:undefined, errorMessage, aborted}` → 广播 `session.compacted{error}` + 错误提示（恢复指引见 §3.1 场景 3）
- **dispatcher**（`message-dispatcher.ts:423 compact`）改为「RPC 触发 + 失败复位」：保留 busy 预检与 `isCompacting` 标记，**删除手动广播 compactionSummary / compacted**（pi 在 RPC compact 时同样发 compaction_start{reason:'manual'} / compaction_end，探针 P-manual-reason ✅）；RPC 调用本身失败时复位 + `session.compacted{error}` 兜底（pi 未发事件的路径）。
- **isCompacting 状态源切换**：当前端 compacting 由 dispatcher 标记驱动；改后由 `session.compacting/compacted` 消息驱动（与现有前端 handler 一致——`useChat.ts:191/195` 订阅的正是这两个消息，切换后前端零改动）。

#### 3.3.5 契约清理（随本设计一并做）

| 项 | 位置 | 处理 |
|---|---|---|
| adapter 死分支：`message_start{role:compactionSummary/branchSummary}` | `event-adapter.ts:487-510` | 删除（pi 从不为这两个 role 发 message_start，pi dist 全文仅注释一处命中；实时 compactionSummary 改由 3.3.4 事件驱动） |
| `agent_start` hook 不可达分支 | `event-adapter.ts:738`（NULL_EVENTS 先吞，hook 分支永不触发） | 删分支或从 NULL_EVENTS 移除——裁决：删分支（前端无消费方） |
| `entry_appended` 未登记 | pi-protocol.ts 已声明类型，DISPATCHER/NULL_EVENTS 均无 → 每次 extension appendEntry 刷 `console.warn('Unhandled pi event type')` | 登记 NULL_EVENTS（pi 0.80.3 会 emit，无前端消费方） |
| AGENTS.md 7.5 描述过期 | 「RPC 路径 = client.getHistory → pi get_messages → convertPiHistory」 | 同步为「get_entries → rebuildHistoryFromEntries（经共享 mapper）→ convertPiHistory」；`client.getHistory()` 死代码标注或删除 |

#### 3.3.6 运行时断言探针清单（准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-entries-types | pi `get_entries` 返回的 entry 树含 `type:'compaction'/'branch_summary'/'custom_message'/'custom'`（pi 源码写入点存在） | pi dist `session-manager.js:805`（compaction）、`:1059`（branch_summary）、`:868`（custom_message）、`:822`（custom）四处 append 实现 | ✅ 已验证 |
| P-compaction-end-result | `compaction_end.result` 含 `summary/tokensBefore/estimatedTokensAfter`；失败路径带 `errorMessage`、`aborted` | pi dist `agent-session.js:1448-1463`（result 构造）、`:1470-1476`（失败 emit）、`:1690-1694`（auto 同构） | ✅ 已验证 |
| P-manual-reason | 手动 compact（RPC 触发）同样发 `compaction_start{reason:'manual'}` + `compaction_end` | pi dist `agent-session.js:1370` | ✅ 已验证 |
| P-dedup | 事件驱动切换后，手动 compact 不出现双 compacting / 双 compactionSummary | dev app 手动 compact，观察对话流只出现一条压缩记录、compacting 只出现一次 | ⛔ 实施期 M4 |
| P-badge-backfill | RPC 路径 badge 回填（client-msg-id → segments）不回归 | 含图片 badge 的 user 消息，活跃重开后仍渲染 badge（非纯文本） | ⛔ 实施期 M2 |
| P-fork-locate | `__entryId` 注入删除后 fork 定位（msg.piEntryId）不受影响 | 文件路径重开后执行 fork，分支点定位正确（从 piEntryId 读） | ⛔ 实施期 M3 |

## §4 验收

**改动规模：中等偏大（runtime 数据链路行为变更 + 事件流变更）。验收用真实 dev app + 真实 pi session，非单测非 mock；单测仅作回归辅助。**

### 场景 1：活跃重开双路一致（回溯 G1）

- **上下文**：dev app 连真实 pi，某 session 里有一次手动 compact 记录、一次 fork 分支摘要、一条 background subagent 完成通知（BgNotifyCard）；pi 进程保持存活
- **步骤**：关闭该 session 面板 → 从 sidebar 重开（RPC 路径）→ 逐行对照压缩记录/分支摘要/bg-notify 是否在场
- **通过标准**：三类记录全部可见，位置与原对话一致；随后等 pi 进程退出再重开（文件路径），两路内容逐行一致

### 场景 2：auto-compaction 全程可见（回溯 G2）

- **上下文**：dev app，构造真实自动压缩（长跑 session 至 context 超 pi 阈值；无低阈值配置时接受用长上下文任务自然触发，记录触发时 context 计数）
- **步骤**：观察压缩发生时的对话流与 context 计数 → 压缩完成后重开 session
- **通过标准**：实时出现「正在自动压缩上下文…」→「已自动压缩 · N→M tokens」；context 计数刷新；重开后该记录仍在；全程无残留 compacting 菊花

### 场景 3：压缩失败恢复（回溯 G2 失败路径）

- **步骤**：构造压缩失败（如压缩进行中 abort / 模型请求失败）
- **通过标准**：对话流出现错误提示「上下文压缩失败：<原因>」+ 恢复指引；compacting 态复位；session 可继续正常对话

### 场景 4：现有能力不回归（回溯 G4）

- **步骤**：① 含图片/文件 badge 的 user 消息，活跃重开（RPC 路径）→ badge 渲染不降级；② 离线重开后执行 fork → 分支点定位正确；③ 长 session 顶部「加载更多」显隐与截断语义不变
- **通过标准**：三项行为与改动前一致

### 场景 5：双路径序列 diff（回溯 G3）

- **步骤**：同一 session，活跃时经 RPC 路径导出历史 Message[]；进程退出后经文件路径导出；diff 两序列（role/种类/顺序/关键字段）
- **通过标准**：序列一致（允许的唯一差异：文件路径 user 消息无 badge 回填降级为 text——G4 已知差异，改动前后一致）

## §5 下一层拆分

### 实施路径

| 步骤 | 交付 | 独立验证 |
|---|---|---|
| M1 共享 mapper | `infra/pi/session-entry-mapper.ts` 新增 `mapSessionEntries` + 单测（四类映射/custom 数据 entry 分流/畸形 data 降级/平行 entryIds） | 单测 |
| M2 RPC 路径接入 | `rebuildHistoryFromEntries` 改用 mapper（clientUuidMap 从 customDataEntries 建，badge 回填保留） | 场景 1 + P-badge-backfill |
| M3 文件路径接入 | `getHistoryFromFilePath`/`tailReadHistory` 换 mapper；删 `__entryId` 注入 | 场景 4② + P-fork-locate + 场景 5 |
| M4 compaction 事件驱动 | adapter 放开两事件 + interpreter 编排 + dispatcher 删手动广播 | 场景 2/3 + P-dedup |
| M5 契约清理 + 文档同步 | §3.3.5 四项 | grep 无死分支；AGENTS.md 7.5 更新 |

拆分理由：M1-M3 是「双路一致」主线（mapper 先行，两路径各自独立可验）；M4 是 compaction 可见性主线（依赖 M1 的 compaction 映射才能让重开可见，故排在 M1 后；与 M2/M3 无代码耦合但共享场景 1 的验收上下文）；M5 纯清理放最后防干扰主线。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `packages/runtime/src/infra/pi/session-entry-mapper.ts` | **新增**：`mapSessionEntries`（逻辑迁自 session-history.ts:22-83） |
| `packages/runtime/src/infra/pi/entry-tree-builder.ts` | 第一遍扫描换成 mapper；clientUuidMap 改从 customDataEntries 建；头注释更新 |
| `packages/runtime/src/services/session-history.ts` | 删 `mapEntriesToPiMessages`（迁出）；`getHistoryFromFilePath`/`tailReadHistory` 接入 mapper；删 `__entryId` 注入 |
| `packages/runtime/src/infra/pi/event-adapter.ts` | NULL_EVENTS 移除 compaction_start/end；删 §3.3.5 死分支；登记 entry_appended |
| `packages/runtime/src/services/session/event-interpreter.ts` | 新增 compaction_start/end 编排（3.3.4） |
| `packages/runtime/src/services/session/message-dispatcher.ts` | compact 删手动广播 compactionSummary/compacted，保留预检/标记/失败复位 |
| `packages/runtime/src/infra/pi/message-converter.ts` | 无逻辑改动（`__entryId` 回退保留作防御，注释标注生产路径已不再产生） |
| `AGENTS.md` 规则 7.5 | RPC 路径描述同步为 get_entries → mapper → convertPiHistory |
| 测试 | mapper 单测新增；entry-tree-builder/session-history/dispatcher 相关用例同步 |

### 待验证检查点

1. **P-dedup**（M4）：手动 compact 双发检查——若 pi 在 RPC compact 失败重试路径也发 compaction_end（`agent-session.js:1694 willRetry` 分支），确认前端对 willRetry=true 的中间态不错误收口。
2. **尾读窗口与 mapper 的顺序**（M3）：`tailReadHistory` 先在原始 entry 集上按 turn 边界截窗、再把窗口内 entry 交给 mapper——保持现有顺序（窗口语义零变化），mapper 不参与截窗。
3. **auto-compaction reason 值集**（M4）：pi 自动触发时 reason 的实际字符串（threshold/overflow 或其他）以 pi dist 运行时为准，前端文案映射做兜底（未知 reason 按自动处理）。
