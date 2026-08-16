# D6：Session 历史重建缓存 + leafId 增量重建（runtime 侧）

> **一句话结论**（审查后重范围，见文末「重范围记录」）：初稿假设「每次切回 session 都全量重传重建」——**该前提与代码不符**：切回在 LRU 窗口内（≤8 session）根本不调 `getHistory`（isHydrated 三重守卫 + 消息常驻 Map 靠流式事件保鲜），真正的全量重建只发生在**无基底路径**（LRU 驱逐后重进 / dispose 后重开 / renderer 重载）。而这条路径上 renderer 消息数组已清空，初稿的「renderer append 增量」无处安放（append 到空数组会丢历史头部）。定案：**增量做在 runtime 侧**——runtime 维护 per-session「已重建消息缓存 + lastLeafId」，重建路径命中缓存时零 pi 序列化、leafId 前进时 `getEntries(since=lastLeafId)` 只重建增量窗口；**renderer 协议与行为完全不变**（每次仍是全量数组、全量替换）。增量底座（pi `since` 支持、`leafId` 返回、entry-tree-builder 兼容 since）已全部探明就绪。

**当前层 → 下一层**：技术方案设计（下一层产物 = 可实现的接口/数据模型/时序契约）。涉及数据流与错误处理，准则 5/6/7 全适用。

---

## §1 背景目标

### SCQA

- **情境**：长 session（几百轮对话）的 entry 树可达数 MB、上千 entry。当 session 被 LRU 驱逐（`LRU_MAX_SESSIONS=8`）或 dispose 后重新进入、或 renderer 重载时，runtime 调 `getHistory`：走 pi `get_entries` RPC 拿**全量 entry 树**，再经 `rebuildHistoryFromEntries`（entry 树 → 消息 + segments badge 回填）全量重建后推给 renderer，renderer 全量替换 chat store。
- **冲突**：这条重建路径上，pi（单进程）全量序列化阻塞自身事件循环（连 `get_state` ping、abort 也变慢），runtime 侧全量重建是几十~几百 ms CPU。而 pi 早已支持增量（`get_entries(since)` 用 findIndex+slice 实现），runtime 已预留参数但从未使用，响应里拿到的 `leafId`（当前叶子 entry id）也被注释为「保留供未来增量」。
- **问题**：**重建路径每次全量重传 + 全量重建，且 runtime 从不消费 leafId**——增量能力的最后一环缺失。
- **答案**：runtime 侧缓存最后重建结果 + 记录 `lastLeafId`：命中且 leafId 未变 → 直接返回缓存（零 pi）；leafId 前进 → `getEntries(since=lastLeafId)` 只取增量窗口重建后并入缓存；branch 导致 since 失效时降级全量重建（低频）。renderer 不做任何改动。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| 切回零请求（审查新增事实） | LRU 窗口内的 session 切回**不调 getHistory**：`useSidebar.ts:176`、`useSidebarNew.ts:216`、`core/domain/chat/useChat.ts:592` 三处 `if (chat.isHydrated(sid)) return` 守卫；消息常驻 Map 靠流式 `applyMessageEvent` 保鲜（lru.ts 保留最近 8 个，驱逐时同时清 messages + hydrated）。 |
| 重建路径 | `getHistory` 真实触发点：首次进入、LRU 驱逐后重进、dispose 后重开、renderer 重载——**共同点是 renderer 消息数组已空（无基底）**。 |
| entry 树 | pi session 的持久化模型：JSONL 每行一条 entry（message/custom 等），按 id 关联成树。`get_entries` 返回 `{entries, leafId}`。 |
| leafId | 当前叶子 entry id（pi `sessionManager.getLeafId()`）。branch 后指向新叶子；空 session 为 null。探明确认：**来自 pi RPC 响应**（AGENTS.md「从 JSONL 解析近似值」的说法与代码不符，本仓无该解析代码）。 |
| since | `get_entries(since=entryId)` 返回该 entry 之后的全部 entry；pi 找不到 since id 时抛 "Entry not found"（`pi-protocol.ts:679-683` 注释；**大小写以实测为准**）。 |
| piEntryId | 消息的跨重建稳定身份：entry-tree-builder 路径按 entryIds[i] 传入，`message-converter.ts:140` 写入 `msg.piEntryId`。`Message.id` 是每次重建随机生成的 UUID（`message-converter.ts:134/234/263/282/308`），**不可作去重键**。 |
| hydrate / prepend | renderer chat store 的两种历史写入：hydrate 全量覆盖（首次进 session，`store.ts:252` 有 `hydrated.has → return` 守卫）；prependHistory 去重合并头部（「加载更多」）。**无 append 入口，且本设计不需要。** |

### 设计目标

1. **重建路径加速**：LRU 驱逐重进 / dispose 重开 / renderer 重载时，缓存命中零 pi 序列化、leafId 前进只重建增量——长 session 重建从秒级降到百毫秒级。
2. **渲染正确**：renderer 每次拿到的全量数组与「全量重建一次」的结果一致（顺序、去重、badge 回填）。
3. **branch/fork 不坏**：branch 后 since 失效场景自动降级全量重建，用户无感。

### In / Out scope

- **In**：runtime 重建缓存与生命周期（lastLeafId 记录、增量合并、fallback）。
- **Out**：renderer 改动（协议形状不变，无 append 入口）；pi 进程内部 get_entries 实现（上游能力，直接消费）；「加载更多」历史（prepend 路径已存在，不变）；segments badge 的存储格式（不动）；offline 尾读路径（不变）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

用户在多个 session 间来回切换（超过 8 个时 LRU 开始驱逐）：切回一个被驱逐的长 session → 侧栏选中 → 等待（pi 全量序列化 + runtime 全量重建 + renderer 全量替换，长 session 秒级）→ 聊天流出现。期间 pi 的事件循环被序列化占用，若后台还有别的 session 在跑，其 ping/abort 响应也会延迟。而 LRU 窗口内的切回是瞬时的（零请求）——卡顿只集中在「重建路径」。

### 2.2 现状数据流

```
重新进入 session（首次 / LRU 驱逐后 / dispose 重开 / renderer 重载）
  → renderer getHistory RPC（useSidebar/useSidebarNew 的 !isHydrated 分支）
  → runtime session-service.getHistory（session-service.ts:487-517）
      → client.getEntries()                    ← 全量，无 since
      → readSegmentsMetadataFile（sidecar）
      → rebuildHistoryFromEntries(entries, segments)   ← 全量重建
  → renderer chat.hydrate(sid, messages)       ← 全量覆盖 Map

（LRU 窗口内切回：isHydrated 守卫命中 → 不调 getHistory → 零请求，消息靠流式事件保鲜）
```

### 2.3 探明事实（增量可行性 + 触发路径）

| 事实 | 证据 |
|---|---|
| **切回零请求（审查新增，推翻初稿前提）** | `useSidebar.ts:176` / `useSidebarNew.ts:216` / `core/domain/chat/useChat.ts:592` 三重 `isHydrated` 守卫；`lru.ts` `LRU_MAX_SESSIONS=8`、驱逐时 deleteMessageKey + deleteHydrated |
| getHistory 真实触发路径 = 无基底路径 | 首次进入 / LRU 驱逐后 / dispose 后 / renderer 重载——messages 均已被清空（deleteMessageKey / deleteSession cleanup） |
| pi 原生支持 since | `getEntries(since?)` 已实现（rpc-client.ts:527-528）；pi 端 findIndex+slice；找不到 since id 抛 "Entry not found" |
| leafId 已返回未消费 | `session-service.ts:491-493` 的 cast 含 leafId，注释「保留供未来增量」 |
| entry 重建兼容增量 | `entry-tree-builder.ts:81` 注释「全量或 since 增量」 |
| 消息身份：piEntryId 稳定、Message.id 随机 | `message-converter.ts:134/234/263/282/308` 全 `crypto.randomUUID()`；`:140` piEntryId 来自 entryIds[i]（稳定）；live 流 id 为 `u-*`/`a-*`（store.ts:273 / event-adapter.ts:490） |
| renderer 全量替换模型 | hydrate 有守卫（store.ts:252），`setMessages`（store.ts:260）是非守卫覆盖路径；无 append 入口 |
| segments badge 兼容增量 | 回填按 `clientUuidMap`/`piEntryId` 匹配（entry-tree-builder.ts:74-76），增量子集 + 全量 sidecar 可正确回填增量窗口内新 turn 的 badge |
| branch 失效风险 | ~~branch 切换回上游后 since id 可能无效 → pi 抛 "Entry not Found"~~（实施期修正：pi append-only，branch 后 since=旧 leaf **不报错**但返回新分支条目，增量合并会静默产出「老分支尾 + 新分支」混合历史；D6-4 的 "Entry not found" fallback 只覆盖 entry 消失场景。实施已加 parentId 不变量检测，见文末补记）；fork 是 runtime 层截断 JSONL 写新文件（session-fork.ts），新 session 有独立 leafId |
| offline 路径 | 无 pi 进程时走文件尾读（tailReadHistory，最近 20 turn）+「加载更多」全量读（getFullHistory）——文件路径无 leafId 概念，不进缓存 |

### 2.4 根因

**runtime 从不消费 leafId，且重建结果不缓存**：重建路径每次重复「pi 全量序列化 + runtime 全量重建」两段成本，而增量能力的最后一环（记录并传递 since）缺失。renderer 的「全量替换」模型不是根因——重建路径上 renderer 本就没有基底，全量替换是必要语义。

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**LRU 驱逐重进场景**：用户在 10+ 个 session 间切换，切回一个被驱逐的长 session → runtime 查缓存：有记录且 leafId 未变 → **直接返回缓存消息（零 pi 序列化、零重建）**；leafId 前进（上次重建后 pi 又跑了新 turn）→ `getEntries(since=lastLeafId)` 只取增量窗口 → 重建增量消息并入缓存 → 返回全量。百毫秒级呈现。

**首次进入场景**：全量重建（与现状一致），同时缓存结果 + 记录本次响应的 leafId。

**branch 后重进场景**（实施期修正）：pi append-only，branch（extension 经 navigateTree）后 since=旧 leaf **不报错**但返回新分支条目——runtime 靠 **parentId 不变量检测**（delta 首条 entry.parentId 必须等于缓存 leafId，branch 后是 branch 点不满足）→ 丢弃该 session 缓存 → 全量拉取 + 重建 + 覆盖缓存 + 更新 lastLeafId。用户无感（只多一次全量，且 branch 是低频显式操作）。

**offline 场景**（pi 进程不存在）：保持现状尾读 + 加载更多，不读不写缓存（文件路径无 leafId 概念）。

**失败路径 + 恢复指引**：get_entries 增量失败（超时/pi 进程内错误）→ 与现状同链降级（`getHistory` 现有 fallback 到尾读），缓存不动（下次重试仍走 since）；缓存合并失败不影响 pi 侧数据（缓存是纯派生数据，可随时丢弃重建）。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：runtime 侧重建缓存 + since 增量重建（选）** | ✅ 治本：重建路径成本与增量成正比；renderer 协议零改动；缓存是纯派生数据、可随时丢弃 | 中：runtime 缓存/记录/合并/fallback | 中：缓存生命周期（有容量帽 + dispose/退出清理）；增量合并正确性（piEntryId 去重）；branch 失效（有 fallback） | ✅ |
| B：保持全量 + renderer 侧不改、pi 侧结果缓存（entry 数未变复用） | ❌ 治标：pi 每次仍全量序列化（成本大头在 pi 侧），且缓存失效判定（entry 数）脆弱——entry 数不变但内容变（编辑/压缩）会返回陈旧历史 | 中 | 低 | ❌ 若用它：重建长 session 时 pi 仍要全量序列化数 MB entry 树，卡顿源原样保留，且引入陈旧返回风险 |
| C：保持现状 | ❌ | 零 | — | ❌ 重建长 session 卡顿持续 |
| D：（初稿方案，审查后被否）renderer append + runtime 增量标记 | ❌ 在唯一真实触发路径上不可行：getHistory 只在无基底路径被调（renderer messages 已空），append 到空数组丢历史头部；branch fallback 依赖 hydrate 但其有幂等守卫（store.ts:252）会 no-op；按 Message.id 去重因重建随机 UUID 而失效 | — | 高：静默丢历史头部 / 重复 turn | ❌ 重范围记录见文末 |

**推荐 A**。理由：增量底座（pi since + leafId + entry-tree-builder 兼容 since）已全部就绪，A 是「把已铺好的最后一环接上」，且把增量落在唯一有基底的层（runtime 缓存）；B 没有解决 pi 侧序列化这个主要成本；D 的三处结构性缺陷在审查中已核实（见 §2.3 探明事实）。

### 3.3 关键决策与权衡

**D6-1：重建缓存与 lastLeafId 的存储与生命周期**。
- 选择：runtime 进程内 `Map<sessionId, { leafId: string | null, messages: Message[], historyTruncated: boolean }>`（per-session 内存态）；**容量帽 = 最近 8 个 session**（对齐 renderer LRU 窗口：只有可能被驱逐重进的 session 才值得缓存，超出窗口的缓存无消费者；超帽按最久未访问驱逐缓存条目）。写入时机 = 每次成功重建后；清除时机 = session dispose / pi 进程退出（`clearSession` 现有编排点挂清理）+ 容量帽驱逐。无持久化需求——重开 app 后 runtime 内存已空，必然全量重建。
- 被否：持久化到 sidecar——收益（跨 app 重启的缓存）几乎为零（重启后必然全量，缓存重建成本就是现状成本），徒增一致性问题。
- 证据：增量语义只对「同一 app 运行期内、session 曾被重建过」的重进有意义；缓存是纯派生数据，丢弃无一致性风险。

**D6-2：增量窗口的消息重建与 badge 回填**。
- 选择：增量 entries 直接走现有 `rebuildHistoryFromEntries(entries, segmentsMetadata)`（其注释已声明兼容 since 增量）；segmentsMetadata 仍读全量 sidecar。
- 边界：增量窗口内**没有**新的 custom entry 时，`clientUuidMap` 为空 → 增量消息的 badge 可能降级占位文本。可接受：新 turn 的 badge 伴随新 segments 写入 + 对应 custom entry 在增量窗口内，正常回填；历史老消息的 badge 在缓存中的旧消息上已正确回填，合并后不丢。
- 证据：探明事实「新增 turn 的 badge 不受影响」（entry-tree-builder.ts:74-76）。

**D6-3：runtime 侧增量合并语义（去重键 = piEntryId）**。
- 选择：缓存数组与增量数组**按 `piEntryId` 去重合并**——增量消息 piEntryId 已在缓存尾部 → 跳过（不重复）；新 piEntryId → 追加。`Message.id` 不参与去重（重建随机 UUID，探明事实）。无 piEntryId 的消息（理论上重建路径都会带，entry-tree-builder 全路径传 entryIds；防御：无 piEntryId 时按内容顺序追加，并记 debug）。
- 幂等：同批重复合并无副作用（按 piEntryId 已存在即跳过）。
- 被否：按 Message.id 去重（初稿方案）——重建 id 随机，去重恒失效，同 turn 出现两份；按 (role, timestamp) 结构去重——脆弱且开销大。
- 证据：`mutations.ts:67-77` 的 prependHistoryMut 是 renderer 侧 piEntryId 去重的现成范式（本设计在 runtime 侧复用同语义）。

**D6-4：fallback 触发条件**。
- 选择：捕获 pi 的 "Entry not found"（`sendCommand` reject 的 error message 匹配，**文案大小写以实测为准**——源码注释为 "Entry not found" 小写 n）→ 丢弃该 session 缓存 → 全量拉取 + 重建 + 覆盖缓存 + 更新 lastLeafId。其他错误 → 走现有降级链（尾读），缓存不动。**实施期补充（W20 审查 Fix-2）**："Entry not found" 只覆盖 entry 消失场景（缓存跨 pi 进程存活 + 文件被外部改写）；branch 的真实症状是 append-only 下不报错但静默合出混合历史，已加 **parentId 不变量检测**（delta 首条 parentId ≠ 缓存 leafId → 丢缓存全量重建）。
- 证据：branch 是唯一使 leafId 失效的已知场景（fork 生成新 session 文件 + 新 leafId，不触发）；匹配错误文案是既有做法（pi 错误经 `success:false`/error 返回）。

**D6-5：协议与 renderer 侧零改动**。
- 选择：RPC 响应形状**保持 `{messages, historyTruncated}` 不变**，**不新增 `incremental` 字段**（初稿方案的新字段作废）。runtime 内部按「有无缓存 + leafId 是否前进」决定 since；renderer 继续 hydrate 全量覆盖——在重建路径上这就是正确语义（renderer 无基底）。
- 理由：初稿的 incremental 标记存在两个缺陷——renderer 有基底时（LRU 窗口内）根本不调 getHistory，标记无从生效；renderer 无基底时标记指向 append 却会丢头部。增量落在 runtime 侧后，renderer 无需知道增量与否。

---

## §4 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | LRU 驱逐后重进：开 >8 个 session（触发 evictIfNeeded），其中一个长 session 先跑出 50+ 轮，切走至其被驱逐，再切回 | 切回并计时；观察 runtime 日志中 get_entries 是否被跳过（缓存命中）或带 since | 缓存命中路径：无 get_entries 调用、聊天流完整；leafId 未变时切回耗时显著低于改造前基线 | 目标 1、2 |
| V2 | 增量重建：V1 场景中，该 session 在驱逐期间又跑了 1 轮新对话，切回 | 观察 runtime 日志 get_entries 参数 | 日志显示 `get_entries {since: <entryId>}` 且返回 entry 数远小于全量；聊天流与全量重建一致（新旧消息连续、无重复、头部完整） | 目标 1、2 |
| V3 | fork 一个 session 并打开 | 观察 fork 后打开的新 session | 新 session 无缓存、首次打开走全量，历史按 fork 截断正确显示 | 目标 3 |
| V4 | 真实场景验证 badge：发送带图片/文件的用户消息后驱逐并重进 | 重进后检查消息 badge | 增量重建的新 turn 消息 badge（图片/文件/skill）正确回填，无降级占位 | 目标 2 |
| V5 | 关闭 pi 进程（或 session 离线）后打开该 session | 观察加载行为 | 走尾读路径（现状行为），无报错、不读写缓存 | 目标 3（offline 不回归） |
| V6 | branch 后重进：branch 到旧分支再切回 | 观察加载行为 | parentId 不变量 violation → 丢缓存全量重建（日志可见），聊天流与全量重建一致（新分支权威视图，无混合历史），缓存被覆盖 | 目标 3 |

---

## §5 下一层拆分

实施路径：纯 runtime 改动，renderer 零改动，可独立验证：

| # | 拆分单元 | justification | 文件改动地图 |
|---|---|---|---|
| U1 | 重建缓存 + lastLeafId 记录 + since 传递 + fallback | 增量核心，独立可测 | `session-service.ts`（getHistory：缓存命中/增量/全量三分支 + clearSession 清理挂钩）、`rpc-client.ts`（已有 getEntries(since)，无改动） |
| U2 | 增量合并（piEntryId 去重）+ 容量帽驱逐 | 合并正确性 + 内存治理 | `session-service.ts` 或独立 helper（`history-rebuild-cache.ts`） |
| U3 | 端到端验证（V1-V6 场景脚本化） | 验收落地 | 测试或手动清单 |

**待验证检查点**：
- AGENTS.md「leafId 从 JSONL 解析近似值」的说法与代码现实（leafId 来自 pi RPC）的矛盾——实施 U1 前用真实 pi 版本验证 `get_entries` 响应的 `leafId` 字段存在且随 append 更新（写独立验证脚本，符合项目「外部系统先验证再编码」规则）。
- branch 操作在 pi 侧的 leafId 变化行为（切换到旧 branch 后 since 失效的具体报错文案与大小写），U1 的 fallback 匹配以实测文案为准。
- **compact 后增量 since 语义（⛔ 实施前必跑）**：长 session 的核心操作是压缩（compact）——compact 新增 compaction summary + 后续条目，需实测 `since=旧 lastLeafId` 是否只返回 compact 之后的新条目（badge 随新 turn 回填），还是返回「自旧叶子以来的全部新条目」导致与缓存中 compact 前消息重复；若重复，增量合并需按 piEntryId 去重兜底（D6-3 已设计）并补 V7 场景断言。

---

## 附：重范围记录（对抗式审查结论，2026-08-15）

初稿方案为「runtime 增量标记 + renderer appendHistory」，审查核实三条结构性缺陷后重范围为本稿的 runtime 侧重建缓存：

1. **收益前提错误**：`getHistory` 只在无基底路径被调（isHydrated 三重守卫 + LRU 消息常驻），「每次切回都全量」不成立，切回在 LRU 窗口内零请求。
2. **append 落点错误**：无基底路径上 renderer messages 已空，append 到空数组丢历史头部；branch fallback 依赖 hydrate 但被 store.ts:252 守卫 no-op。
3. **去重身份错误**：重建消息 id 为随机 UUID，按 Message.id 去重恒失效；稳定身份是 piEntryId。

重范围后 renderer 协议与行为零改动，增量底座（pi since / leafId / entry-tree-builder since 兼容）全部复用。

---

## 附：实施期补记（W20 对抗式审查修复，2026-08-16）

**R-12 实施扩展**：空 entries 短路同时应用于**全量分支**（pi RPC 是活跃 session 的权威视图，entries 空 = 真空，不走尾读——尾读会给出发文件尾部与 RPC 视图闪变的不一致结果）；idle session 的文件尾读兜底仅保留在 getEntries **抛错**链（超时/pi 内部错误降级）。

**branch 症状修正 + parentId 不变量检测**：初稿假设「branch 后 pi 抛 Entry not found」——实测 pi append-only，branch（pi rpc-mode 把 navigateTree 暴露给 extension command context）后 since=旧 leaf **不报错**但返回新分支条目，增量合并会静默产出「老分支尾 + 新分支」的混合历史；D6-4 fallback 只覆盖 entry 消失场景。修复：增量合并前校验 delta 首条 entry 的 `parentId === cached.leafId`（正常 append 恒满足；branch 后首条 parentId 是 branch 点）→ 不满足即丢缓存全量重建 + warn 日志。

**孤儿 toolResult 回填（增量窗口以 toolResult 开头）**：缓存 leafId 可能切在 assistant(toolCalls) 与其 toolResults 之间（后台 session 生成中 getHistory 写缓存），下次增量窗口以 toolResult 开头 → convertPiHistory 的 toolResult→toolCall 配对是窗口局部的 → 配对失败静默丢弃 → 缓存中该 toolCall 永久无输出（leafId 持续前进，永不触发全量重建自愈）。修复：convertPiHistory 增加孤儿收集（可选 out 参数），session-service 增量合并后按 toolCallId 回填到缓存 assistant 的 toolCall（message-converter 的 applyOrphanToolResults）。

**并发 getHistory 竞态**：per-session inflight 复用（同 session 共享同一 promise，GitStateService inflightSnapshot 同款模式），消除「后完成者的旧 delta 与先完成者的新缓存交错写回」竞态。
