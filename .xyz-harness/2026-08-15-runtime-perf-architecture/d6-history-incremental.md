# D6：Session 历史增量拉取（since=leafId）

> **一句话结论**：`getHistory` 每次切回/重开 session 都让 pi 全量序列化 entry 树 + runtime 全量重建历史（长 session 数 MB JSONL、上千 entry，是切回卡顿的直接来源）。定案：runtime 记录 per-session `lastLeafId`，首次全量、后续 `getEntries(since=lastLeafId)` 增量拉取；renderer chat store 新增 append 合并；pi 抛 "Entry not Found"（branch 后）时降级全量重建。增量底座（pi `since` 支持、`leafId` 返回、virtua append 机制）已全部探明就绪。

**当前层 → 下一层**：技术方案设计（下一层产物 = 可实现的接口/数据模型/时序契约）。涉及数据流与错误处理，准则 5/6/7 全适用。

---

## §1 背景目标

### SCQA

- **情境**：用户切回一个长对话 session 时，runtime 调 `getHistory`：走 pi `get_entries` RPC 拿**全量 entry 树**，再经 `rebuildHistoryFromEntries`（entry 树 → 消息 + segments badge 回填）全量重建后推给 renderer，renderer 全量替换 chat store。
- **冲突**：长 session（几百轮对话）的 entry 树可达数 MB、上千 entry。每次切回，pi（单进程）全量序列化阻塞自身事件循环（连 `get_state` ping、abort 也变慢），runtime 侧全量重建是几十~几百 ms CPU，renderer 全量替换整条消息数组。而 pi 早已支持增量（`get_entries(since)` 用 findIndex+slice 实现），runtime 已预留参数但从未使用，响应里拿到的 `leafId`（当前叶子 entry id）也被注释为「保留供未来增量」。
- **问题**：**每次切回都全量重传 + 全量重建，而增量能力已被上游原生支持。**
- **答案**：增量拉取。runtime 记录 `lastLeafId` → 后续请求带 `since`；renderer 新增 append 合并路径；branch 导致 since 失效时降级全量（低频）。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| entry 树 | pi session 的持久化模型：JSONL 每行一条 entry（message/custom 等），按 id 关联成树。`get_entries` 返回 `{entries, leafId}`。 |
| leafId | 当前叶子 entry id（pi `sessionManager.getLeafId()`）。branch 后指向新叶子；空 session 为 null。探明确认：**来自 pi RPC 响应**（AGENTS.md「从 JSONL 解析近似值」的说法与代码不符，本仓无该解析代码）。 |
| since | `get_entries(since=entryId)` 返回该 entry 之后的全部 entry；pi 找不到 since id 时抛 "Entry not Found"（`pi-protocol.ts:679-683` 注释）。 |
| hydrate / prepend | renderer chat store 的两种历史写入：hydrate 全量覆盖（首次进 session）；prependHistory 去重合并头部（「加载更多」）。**无 append 入口**。 |
| virtua | renderer 消息流实际使用的虚拟列表库（`virtua@^0.50.0`），支持顶部 `:shift` 插入与底部 push 重 diff——append 渲染机制现成。 |

### 设计目标

1. **切回秒开**：长 session 切回时只传增量（新 turn 的几十条 entry），不再全量重传重建。
2. **渲染正确**：append 后的消息流与全量重建结果一致（顺序、去重、badge 回填）。
3. **branch/fork 不坏**：branch 后 since 失效场景自动降级全量，用户无感。

### In / Out scope

- **In**：runtime 增量拉取逻辑（lastLeafId 记录、fallback）、renderer appendHistory、offline 路径策略。
- **Out**：pi 进程内部 get_entries 实现（上游能力，直接消费）；「加载更多」历史（prepend 路径已存在，不变）；segments badge 的存储格式（不动）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

用户在长对话（几百轮、含大量工具调用）session 上切走再切回：侧栏选中 → 等待（pi 全量序列化 + runtime 全量重建 + renderer 全量替换，长 session 秒级）→ 聊天流出现。期间 pi 的事件循环被序列化占用，若后台还有别的 session 在跑，其 ping/abort 响应也会延迟。

### 2.2 现状数据流

```
切回 session
  → renderer getHistory RPC
  → runtime session-service.getHistory（session-service.ts:487-517）
      → client.getEntries()                    ← 全量，无 since
      → readSegmentsMetadataFile（sidecar）
      → rebuildHistoryFromEntries(entries, segments)   ← 全量重建
  → renderer chat.hydrate(sid, messages)       ← 全量覆盖 Map
```

### 2.3 探明事实（增量可行性）

| 事实 | 证据 |
|---|---|
| pi 原生支持 since | `getEntries(since?)` 已实现（rpc-client.ts:527-528）；pi 端 findIndex+slice；找不到 since id 抛 "Entry not Found" |
| leafId 已返回未消费 | `session-service.ts:491-493` 的 cast 含 leafId，注释「保留供未来增量」 |
| entry 重建兼容增量 | `entry-tree-builder.ts:81` 注释「全量或 since 增量」 |
| renderer 无 append 入口 | chat store 只有 hydrate（覆盖）+ prependHistory（头插去重），写入统一走 `commitMessages` 整体替换（mutations.ts:23-29） |
| virtua 支持 append | `MessageStream.vue:156` 用 virtua；底部 push 全量重 diff；顶部 `:shift`（load-more） |
| segments badge 兼容增量 | 回填按 `clientUuidMap`/`piEntryId` 匹配（entry-tree-builder.ts:74-76），增量子集 + 全量 sidecar 仍可正确回填新 turn 的 badge |
| branch 失效风险 | branch 切换回上游后 since id 可能无效 → pi 抛 "Entry not Found"；fork 是 runtime 层截断 JSONL 写新文件（session-fork.ts），新 session 有独立 leafId |
| offline 路径 | 无 pi 进程时走文件尾读（tailReadHistory，最近 20 turn）+「加载更多」全量读（getFullHistory）——文件路径无 leafId 概念 |

### 2.4 根因

**runtime 从未消费 leafId**：增量能力的最后一环（记录并传递 since）缺失，导致每次都是全量。renderer 的「全量替换」模型是第二个根因——即使 runtime 传了增量，store 也没有合并入口。

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**切回场景**：用户切回长 session → runtime 用上次记录的 `lastLeafId` 调 `getEntries(since=lastLeafId)` → 只拿到新 turn 的 entry → 重建增量消息 → renderer 把增量消息 append 到现有消息流尾部。秒级呈现。

**首次进入场景**：hydrate 全量（与现状一致），同时记录本次响应的 leafId。

**branch 后切回场景**：pi 抛 "Entry not Found" → runtime 捕获 → 降级全量拉取 + 重建 + 全量覆盖 + 更新 lastLeafId。用户无感（只多一次全量，且 branch 是低频显式操作）。

**offline 场景**（pi 进程不存在）：保持现状尾读 + 加载更多，不做增量（文件路径无 leafId 概念）。

**失败路径 + 恢复指引**：get_entries 增量失败（超时/网络无关，pi 进程内错误）→ 与现状同链降级（`getHistory` 现有 fallback 到尾读）；renderer append 合并失败不影响已有消息（append 幂等去重）。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：增量 since=lastLeafId + renderer append + fallback（选）** | ✅ 治本：长 session 切回成本与增量成正比；底座全部现成 | 中：runtime 记录/传递 + renderer appendHistory + fallback 分支 | 中：branch 失效（有 fallback）；append 合并正确性（有去重幂等设计） | ✅ |
| B：保持全量 + runtime 结果缓存（entry 数未变复用） | ❌ 治标：pi 每次仍全量序列化（成本大头在 pi 侧），runtime 只省重建；且缓存失效判定（entry 数）脆弱 | 中 | 低 | ❌ 若用它：切回长 session 时 pi 仍要全量序列化数 MB entry 树，卡顿源原样保留 |
| C：保持现状 | ❌ | 零 | — | ❌ 长 session 卡顿持续 |

**推荐 A**。理由：增量底座（pi since + leafId + entry-tree-builder 兼容 + virtua append）已全部就绪，A 是「把已铺好的最后一环接上」；B 没有解决 pi 侧序列化这个主要成本；项目无用户包袱，不必顾虑 renderer 旧模型的兼容。

### 3.3 关键决策与权衡

**D6-1：lastLeafId 的存储与生命周期**。
- 选择：runtime 进程内 `Map<sessionId, string>`（per-session 内存态），首次全量拉取时写入；session dispose/pi 进程退出时清除（无持久化需求——重开 app 本来就是首次全量）。
- 被否：持久化到 sidecar——收益（跨 app 重启的增量）几乎为零（重启后 renderer 内存已空，必然全量 hydrate），徒增一致性问题。
- 证据：增量语义只对「同一 app 运行期内、renderer 已有历史内存」的切回有意义。

**D6-2：增量响应的消息重建与 badge 回填**。
- 选择：增量 entries 直接走现有 `rebuildHistoryFromEntries(entries, segmentsMetadata)`（其注释已声明兼容 since 增量）；segmentsMetadata 仍读全量 sidecar。
- 边界：增量窗口内**没有**新的 custom entry 时，`clientUuidMap` 为空 → 增量消息的 badge 可能降级占位文本。可接受：新 turn 的 badge 伴随新 segments 写入 + 对应 custom entry 在增量窗口内，正常回填；历史老消息的 badge 在首次全量 hydrate 时已正确。
- 证据：探明事实「新增 turn 的 badge 不受影响」。

**D6-3：renderer append 合并语义**。
- 选择：新增 `appendHistory(sessionId, messages)`：按 messageId 去重（已在尾部的跳过，新消息追加），复用 `prependHistoryMut` 的去重范式（mutations.ts:67-77）；幂等（同批重复 append 无副作用）。
- 被否：直接 `commitMessages([...old, ...new])` 无去重——重复拉取（fallback 后重试等）会产生重复消息。
- 证据：chat store 所有写入走不可变 `commitMessages` 范式（浅拷贝 Map + 新数组），append 同范式实现。

**D6-4：fallback 触发条件**。
- 选择：捕获 pi 的 "Entry not Found"（`sendCommand` reject 的 error message 匹配）→ 重走全量拉取 + 全量覆盖（hydrate 语义）+ 更新 lastLeafId。其他错误 → 走现有降级链（尾读）。
- 证据：branch 是唯一使 leafId 失效的已知场景（fork 生成新 session 文件 + 新 leafId，不触发）；匹配错误文案是既有做法（pi 错误经 `success:false`/error 返回）。

**D6-5：`getHistory` 接口形状**。
- 选择：RPC 响应保持 `{messages, historyTruncated}` 形状不变，新增字段 `incremental?: boolean`（renderer 据此选 append 还是 hydrate）。runtime 内部按「有无 lastLeafId + 是否首次」决定 since。
- 理由：renderer 需要在 append/hydrate 间二选一；显式标记比「renderer 自己猜」可靠。

---

## §4 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | 真实长 session：先跑出 50+ 轮对话，切走再切回 | 切回并计时；观察 runtime 日志中 get_entries 是否带 since | 切回耗时显著低于改造前基线；日志显示 `get_entries {since: <entryId>}` 且返回 entry 数远小于全量；聊天流完整（新旧消息连续无重复） | 目标 1、2 |
| V2 | 切回后继续对话一轮，再次切走切回 | 观察第二次切回 | 第二次切回只增量拉取 1 轮的 entry；消息流与直接看完全一致 | 目标 1、2 |
| V3 | fork 一个 session 并打开 | 观察 fork 后打开的新 session | 新 session 首次打开走全量（新 session 无 lastLeafId），历史按 fork 截断正确显示 | 目标 3 |
| V4 | 真实场景验证 badge：发送带图片/文件的用户消息后再切回 | 切回后检查消息 badge | 新增 turn 的消息 badge（图片/文件/skill）正确回填，无降级占位 | 目标 2 |
| V5 | 关闭 pi 进程（或 session 离线）后打开该 session | 观察加载行为 | 走尾读路径（现状行为），无报错 | 目标 3（offline 不回归） |

---

## §5 下一层拆分

实施路径：runtime 先行（可独立验证），renderer 随后（依赖新字段）：

| # | 拆分单元 | justification | 文件改动地图 |
|---|---|---|---|
| U1 | runtime lastLeafId 记录 + since 传递 + fallback | 增量核心，独立可测 | `session-service.ts`（getHistory）、`rpc-client.ts`（已有 getEntries(since)，无改动） |
| U2 | RPC 响应加 incremental 标记 | renderer 决策依据 | `session-service.ts` 返回形状；shared 类型（如需） |
| U3 | renderer appendHistory | 合并语义 + 幂等去重 | `core/domain/chat/store.ts`、`mutations.ts`、`useChat.ts`（hydrateHistory 分支） |
| U4 | 端到端验证（V1-V5 场景脚本化） | 验收落地 | 测试或手动清单 |

**待验证检查点**：
- AGENTS.md「leafId 从 JSONL 解析近似值」的说法与代码现实（leafId 来自 pi RPC）的矛盾——实施 U1 前用真实 pi 版本验证 `get_entries` 响应的 `leafId` 字段存在且随 append 更新（写独立验证脚本，符合项目「外部系统先验证再编码」规则）。
- branch 操作在 pi 侧的 leafId 变化行为（切换到旧 branch 后 since 失效的具体报错文案），U1 的 fallback 匹配以实测文案为准。
- renderer 全量替换模型下 `hydrated` Set 的幂等守卫与 append 的关系：append 只发生在已 hydrate 的 session 上，hydrate 仍是首次进入的唯一入口。
