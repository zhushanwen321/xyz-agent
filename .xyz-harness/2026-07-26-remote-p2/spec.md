# 远程化 P2 设计：可靠投递层（seq + ring buffer + 回放）

**日期**: 2026-07-26 | **状态**: 设计定稿（待实施） | **上游方案**: [docs/feature-map/2026-07-26-remote.md](../../docs/feature-map/2026-07-26-remote.md)（§4.2 五件套、§九 P2 阶段、§12.5） | **前置设计**: [P0 spec](../2026-07-26-remote-p0/spec.md)（auth 握手、lastSeq 字段预留）、[P1 spec](../2026-07-26-remote-p1/spec.md)（ws-client auth 握手、D10 lastSeq 推迟到本阶段）

> P2 范围（feature-map §九）：出站消息打 seq + ring buffer + 握手 lastSeq 回放 + 驱逐兜底全量同步 + terminal scrollback ring buffer——runtime 中大改 + renderer 小改。
>
> 本文档把五件套落成可实施设计。所有结论均对照当前代码核实（引用到 `文件:行号`）。两个决定性事实：
>
> 1. **广播有唯一出口**：全 runtime 仅 `message-broker.ts:82` 一处做广播 `ws.send`，无绕行路径——seq 打点和缓冲只需改 broker 一个文件。
> 2. **renderer chat effect 大多非幂等**：`message_start`/`text_delta`/`error`/`customStart` 等都是无条件 append（`chat-message-effects.ts:259-293,395-411,346-379`），重复投递 = 重复气泡。因此回放必须保证「恰好是缺失段、零重复」，不能靠客户端去重兜底。

---

## 一、设计决策总表

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | **seq 作用域** | **server 实例级全局单调 seq**，打在广播消息 envelope 顶层（`ServerMessage.seq?: number`）。reply 与 initial state（点对点）**不打 seq** | per-session 序需要多 buffer 分别回放再合并，复杂度不值；全局序顺带给出 §12.5 想要的总序。广播唯一出口在 broker（`message-broker.ts:59-88`），单点打点。reply 是请求-响应闭环（pending map），断线即 `rejectAll`（`useConnection.ts:222-227`），无回放意义 |
| D2 | **ring buffer 结构** | **per-session 分桶**：`Map<sessionId, SessionBuffer>`，每个 SessionBuffer 存 `{seq, data: string}` 数组（broadcast 已序列化一次的字符串原样入桶，`message-broker.ts:68` 循环外 stringify 的同一产物），回放零再序列化。每桶独立条数+字节双限：默认 **1000 条 / 8MB per session**（env `XYZ_AGENT_REPLAY_MAX_MESSAGES_PER_SESSION` / `XYZ_AGENT_REPLAY_MAX_BYTES_PER_SESSION`），另设全局桶数上限 = `XYZ_AGENT_MAX_SESSIONS`（默认 10，与 P0 §七复用）。**分桶键 = `payload.sessionId`**：广播消息有 `payload.sessionId` → 入对应桶；无 `sessionId`（全局消息：`config.providers/skills/agents/defaults/plugins/sessions`、`model.*`、`workspace.*`、`worktree.*`、`extension.widget/status/discovered` 等无 sessionId 的 extension 子类型）→ **不入任何桶**，靠 initial state 兜底。**【R2-M3 修正】`extension.ui_request` 带 sessionId（protocol.ts:521）按动态规则入桶**，不在「全局消息」枚举内——这是 P3 审批补发回放依赖的路径 | **回放相关性是 per-session 分桶的核心价值**：客户端重连只应收到它「订阅过」的 session 的增量。前端 `chatSessions: Map` 是懒创建分区（`stores/chat.ts` messages Map 只在收到消息时 `set`），回放未订阅 session 的消息会创建僵尸分区。因此回放范围由客户端 auth 携带的 `subscribedSessions` 限定（见 D2.1），服务端只回放这些 session 桶中 seq>lastSeq 的消息。全局消息（配置变更类）低频小体积，不入桶——resume 路径下会丢失断线期间的全局增量（见 D2.2 承认此取舍），但前端重连补拉（**【R4-m2 修正】本 spec §6.4**，原文误写「P1 §6.4」）+ 冷启动 initial state 兜底覆盖大部分场景。**判断「是否入桶」用 `payload.sessionId` 是否存在动态判定，不硬编码 type 名**（自适应未来新增消息类型；terminal.data 的排除见 D3） |
| D2.1 | **回放范围 = 客户端订阅的 session** | auth 握手携带 `subscribedSessions: string[]`（客户端 `messages.keys()` 的并集——所有持有分区的 session）；`getReplayPlan` 只遍历这些 session 的桶收集 seq>lastSeq | 客户端最清楚自己持有哪些分区（`messages.value.keys()`）；服务端无状态追踪，简单。MAX_SESSIONS=10 时 payload 最多 ~360B（10 个 uuid），可接受。客户端打开新 session 时分区已在前端创建，下次重连自然带上——无需额外订阅协议 |
| D2.2 | **全局消息在 resume 路径的取舍** | resume 路径（短断线，跳过 sendInitialState）下，断线期间的全局消息增量（`config.providerUpdated`/`model.switched`/`config.skillUpdated` 等）**会丢失**。不补救 | 全局消息大多是「配置态」（前端有对应 RPC 可主动拉取最新值），或「瞬态事件」（`send.rejected` 的 busy 通知，过时即无意义）。前端重连后 P1 §6.4 现状的「补拉」逻辑（workspace.load、extensionApi.scan 等）会刷新部分全局态。**接受这个取舍**：补全局消息入桶会引入「全局桶」（回到全局 buffer 的复杂度），收益不抵成本。冷启动/reset 路径走 initial state 全量，无此问题 |
| D3 | **terminal.data 特殊处理** | terminal.data **打 seq 但不入 session 桶**，走独立 per-session scrollback buffer（D7）；session 桶回放时自然跳过 | terminal.data 无节流（`terminal-service.ts:98-104` onData 逐 chunk 广播），高频大体积，入桶会瞬间挤掉 chat 事件。客户端缺失段由 attach 回灌补，语义等价 |
| D4 | **驱逐检测** | broker 维护**全局 `evictedWatermark`**（所有 session 桶因 **LRU 驱逐**产生的最大被驱逐 seq）。重连判定：`lastSeq >= evictedWatermark` → 可回放；否则 → seqReset | seq 是全局单调（D1），任意订阅 session 桶的 LRU 驱逐都意味着该 seq 之前的消息不可回放——客户端 lastSeq 若低于 watermark，只能全量 reset。watermark 取所有桶 LRU 驱逐 seq 的最大值。**两种 seq 空洞不算 eviction**（不推进 watermark）：① `clearSessionBuffer`（session 销毁，对应 session 已删，客户端也不该再期待其消息，`session.deleted` 事件触发前端清分区）；② 巨消息豁免（>maxBytes 不入桶，单条丢失可接受，见 §3.1）。这两类空洞不破坏「lastSeq>=watermark 即订阅 session 可回放」的语义——session 销毁的桶不在 `subscribedSessions` 里（客户端已收到 `session.deleted` 并清了分区），巨消息豁免是已知的小概率丢失。**【R4-m3 时序注】**：P2 阶段 `session.deleted` 还是定向 reply（仅发起方收到），其他客户端靠 broadcastSessionList 兜底；**P6 D6 才把 session.deleted 升级为 broadcastExcept 广播**（其他客户端也能收到）。P2 D4① 的「客户端收到 session.deleted」论证在 P6 落地后才严格成立，P2 阶段靠 broadcastSessionList 覆盖 |
| D5 | **lastSeq/bootId 存客户端内存，不持久化** | ws-client 模块级变量；**冷启动（页面新加载）不带 lastSeq，走全量 initial state**；只有同页面生命周期内的重连才带 lastSeq+bootId | feature-map 原文是「客户端持久化 lastSeq」，但持久化**无效且有害**：页面 reload 后 stores 全空，回放只给增量，而 RPC 拉取态（chat history hydrate、commands、context、subagents）无法靠广播回放重建——带旧 lastSeq 反而得到残缺状态。页面存活期间（弱网/切网络/移动端页面冻结）内存完全够用；页面死亡 = 全量同步，现状路径已正确。这是本设计对 feature-map 的唯一实质偏离（D2 per-session buffer 反而是回归 feature-map §4.2 原文「per-session 保留最近 N 条」） |
| D6 | **全量同步兜底 = location.reload()** | 服务端判 lastSeq 失效（低于 watermark 或 bootId 不匹配）→ `auth.ok {seqReset:true}` → 客户端清内存 seq → `location.reload()` → 冷启动全量 | renderer **没有全局 reset 能力**：Pinia setup store 无 `$reset`，模块级守卫（`appBootstrapped`、`hydrated` Set、`useSettings.initialized`）全是「测试隔离用」reset，生产无编排点（探索结论 #8）。原地重建爆炸半径大；reload 构造性正确，与 P1 D3 同一哲学。附带修复现状 bug：WS 断线期间 pi 完成 → `message.complete` 丢失 → 卡「思考中」最长 10 分钟（`chat.ts:63` streaming 超时兜底），seqReset 后 reload 即恢复 |
| D7 | **terminal scrollback** | terminal-service 加 per-session chunk ring buffer（默认 **1000 chunks / 256KB**，env `XYZ_AGENT_TERMINAL_SCROLLBACK_BYTES`）；`attach` 从 no-op（`terminal-service.ts:159-161`）改为**同步点对点回灌**缓存 chunks（复用 `terminal.data` 消息形态，不带 seq、不入 session 桶——与 D3 一致） | 断线窗口 + 组件未挂载窗口（`useTerminal` 只订当前查看 session）的输出都能补回。回灌复用现有 renderer `scrollback.push` 路径（`useTerminal.ts:68-76`），renderer 零改动。同步发送 = Node 单线程保证回灌段与后续实时广播不交错 |
| D8 | **回放时序** | auth 校验通过 → reply `auth.ok` → 若可回放：**原样直发** buffer 中 seq>lastSeq 的消息（已序列化字符串，保持 seq 顺序）→ **跳过 sendInitialState**；若不可回放/冷启动 → 现状 sendInitialState | 初始状态 13 段全量（**R3-M1**：核实 `message-broker.ts` 实际 13 段）与 retained 状态 + 增量回放是互斥的两条路径，混推会把全量 `config.sessions` 等盖到 retained 状态上（虽幂等但浪费且引入时序竞争） |
| D9 | **bootId** | runtime 启动生成 `crypto.randomUUID()`，auth.ok 携带；客户端重连 auth 带回。不匹配 → seqReset | runtime 重启后内存 buffer 清零、seq 归 0，旧 lastSeq 无意义。本地模式同样适用：Electron supervisor 重启 runtime → 重连 → bootId 不匹配 → reload，顺带替代现状有缺陷的崩溃恢复（见 D6） |
| D10 | **心跳/ping 不动** | ping/pong 是 reply 无 seq（`server.ts:211`）；45s 入站超时（`connection-manager.ts:109-116`）不变 | 与投递层正交 |

**明确不在 P2**：pi 生命周期解耦（P3）、租约锁/presence（P5/P6）、移动重连策略调优（P8，P2 是其地基）、`message.file_changes` 的 messageId 去重确认（探索遗留，实施时顺带核实）。

**对 P0/P1 的依赖**：P0 的 auth 握手骨架（auth/auth.ok 协议、连接池 Map）与 P1 的 ws-client auth 发送/close code 处理必须已实施——P2 在其上扩展 payload 与重连行为。

---

## 二、协议变更（`packages/shared/src/protocol.ts`）

### 2.1 envelope 加 seq

```ts
// protocol.ts:768-772 现状
export interface ServerMessage<T extends ServerMessageType = ServerMessageType> {
  type: T
  id?: string
  payload: ServerMessageMap[T]
  seq?: number          // 新增：仅广播消息携带（broker.broadcast 打点）
}
```

`id` 体系不动（现状 `push_<n>`/`terminal_push_*`/无 id 混杂，seq 与之正交，不做统一）。

### 2.2 auth / auth.ok 扩展

```ts
// ClientMessageMap.auth（P0 §2.2 基础上加 bootId + subscribedSessions）
auth: {
  token: string
  clientId: string
  deviceName?: string
  lastSeq?: number            // P2 起消费；仅同页面生命周期重连携带
  bootId?: string             // 与 lastSeq 成对
  subscribedSessions?: string[]  // P2 起；客户端持有分区的 session 列表（messages.keys()），限定回放范围（D2.1）
}

// ServerMessageMap['auth.ok']
'auth.ok': {
  serverVersion: string
  clientId: string
  bootId: string        // runtime 实例 id
  serverSeq: number     // 当前 seq 水位（冷启动基线）
  resumed: boolean      // true=回放路径（已补发缺失，不推 initial state）
  replayedCount?: number// resumed=true 时回放条数（诊断/UI 用）
  seqReset?: boolean    // true=lastSeq 失效，客户端应清 seq 并 reload
}
```

`terminal.data` 消息形态不变（回灌复用）；`terminal.attach` 行为变更（服务端回灌），无新类型。

## 三、服务端：broker 改造（`message-broker.ts`）

### 3.1 seq 打点 + per-session 分桶缓冲

```ts
// 新增成员
private seq = 0
private bootId = crypto.randomUUID()
private sessionBuffers = new Map<string, SessionBuffer>()  // per-session 分桶
private evictedWatermark = 0   // 所有桶迄今驱逐过的最大 seq（全局）

interface SessionBuffer {
  entries: Array<{ seq: number; data: string }>  // 按 seq 升序
  bytes: number
}

broadcast(msg: ServerMessage): void {
  const sequenced = { ...msg, seq: ++this.seq }
  const data = JSON.stringify(sequenced)        // 现状循环外 stringify 的位置
  const sid = (msg.payload as { sessionId?: string } | null)?.sessionId
  // D2/D3：有 sessionId 且非 terminal.data 的消息入对应 session 桶
  if (sid && msg.type !== 'terminal.data') {
    let buf = this.sessionBuffers.get(sid)
    if (!buf) {
      buf = { entries: [], bytes: 0 }
      this.sessionBuffers.set(sid, buf)
    }
    if (data.length <= this.maxBytesPerSession) {  // 巨消息豁免（D4 ②），不入桶避免清空整桶
      buf.entries.push({ seq: sequenced.seq, data })
      buf.bytes += data.length
      this.evictIfNeeded(sid)
    }
  }
  // …现状遍历发送逻辑不变（发 data）
}
```

- **分桶键 = `payload.sessionId`**（动态判定）。terminal.data 虽有 sessionId 但走独立 scrollback（D3），用 `msg.type !== 'terminal.data'` 显式排除——这是唯一的 type 名硬编码（terminal.data 的特殊性：高频大体积无节流，与普通 session 消息语义不同），其余消息类型纯靠 sessionId 动态判定。
- stringify 失败维持现状取舍（整次丢弃，`message-broker.ts:72-75`）——但 **seq 已自增**，留下空洞。客户端 lastSeq 跳过空洞无害（回放条件 seq>lastSeq）。
- `evictIfNeeded(sid)`：对该 session 桶按条数/字节双限从**头部 LRU 驱逐**，`evictedWatermark = max(evictedWatermark, evicted.seq)`（**只 LRU 驱逐推进 watermark**，见 D4），`buf.bytes` 同步扣减。
- 驱逐阈值防呆：单条消息 > per-session maxBytes 时不入桶（D4 ② 巨消息豁免，直接广播），避免整桶被一条巨消息清空。该消息不可回放，属于已知小概率丢失。
- **session 销毁清理**：session 删除时调 `broker.clearSessionBuffer(sid)` 移除该桶——**不推进 evictedWatermark**（D4 ①：session 已删，客户端收到 `session.deleted` 清分区，不该再期待该 session 消息）。桶数天然受 `XYZ_AGENT_MAX_SESSIONS`（P0 §七，默认 10）上限保护。

### 3.2 回放 API

```ts
getReplayPlan(lastSeq: number, bootId: string, subscribedSessions: string[]):
  | { kind: 'resume'; messages: string[] }       // 已序列化，限定 session 桶内按 seq 升序合并
  | { kind: 'reset' }
// bootId 不匹配 或 lastSeq < evictedWatermark → reset
// 否则 resume：只遍历 subscribedSessions 对应的桶（D2.1），收集 entries 中 seq > lastSeq 的条目，
// 按 seq 升序合并（多桶间 seq 全局唯一单调，合并即全局序），messages 可为空数组（无缺失）。
```

**回放范围限定为客户端订阅的 session**（D2.1）：前端 `messages: Map<sessionId, Message[]>` 是懒创建分区（`stores/chat.ts`，收到消息才 `set`）。回放未订阅 session 的消息会触发前端为该 session 创建僵尸分区。客户端 auth 携带 `subscribedSessions = messages.value.keys()` 并集，服务端只回放这些桶——精准补齐已持有分区的 session 的增量，不波及未打开的 session。

## 四、服务端：auth 握手编排（`connection-manager.ts` + `server.ts`）

P0 已建 auth 门（首消息 auth、5s 超时、auth.ok 后 onConnect 推 initial state）。P2 在「auth 校验通过」分支插入回放编排：

```
auth 校验通过:
  plan = broker.getReplayPlan(payload.lastSeq, payload.bootId, payload.subscribedSessions ?? [])
  // 只遍历 subscribedSessions 对应的桶收集 seq>lastSeq（D2.1）
  if (!payload.lastSeq):
    reply auth.ok { bootId, serverSeq, resumed: false }
    onConnect(ws)                          // 现状：sendInitialState 13 段（R3-M1 核实）
  elif (plan.kind === 'resume'):
    reply auth.ok { bootId, serverSeq, resumed: true, replayedCount: plan.messages.length }
    for (data of plan.messages) ws.send(data)   // 原样直发，限定桶内按 seq 升序，顺序保证
  else: // reset
    reply auth.ok { bootId, serverSeq, resumed: false, seqReset: true }
    onConnect(ws)                          // 推全量（客户端无论如何会 reload，推了无害；
                                           // 不推则 reload 前的瞬间页面残缺——选择推，行为简单）
```

- 冷启动（无 lastSeq）与 seqReset 都走全量，区别只是 `seqReset` 标志触发客户端 reload（D6 的语义：重置客户端可能存在的 retained 脏状态——bootId 不匹配时客户端一定来自旧 server 实例的重连，其 retained 状态与 buffer 全清的新 server 已无法对账）。
- `getReplayPlan` 只回放客户端订阅的 session 桶（D2.1），不波及未订阅 session——客户端无感知分桶细节，resume 路径收到的就是「已订阅 session 的缺失增量，按全局 seq 排序」。
- 心跳定时器启动时点维持 P0（auth 成功后）。

## 五、服务端：terminal scrollback（`terminal-service.ts`）

```ts
// 新增 per-session 缓冲
private scrollback = new Map<string, { chunks: string[]; bytes: number }>()
// onData（:98-104）：广播之外追加 chunks.push(data)，双限驱逐（1000 chunks / 256KB）
// attach（:159-161 no-op → 实化）：
attach(sid, ws): void {
  const buf = this.scrollback.get(sid)
  if (!buf) return
  for (const data of buf.chunks) {
    ws.send(JSON.stringify({ type: 'terminal.data', payload: { sessionId: sid, data } }))
  }
}
```

- attach 签名加 `ws`（handler 层从路由上下文传入）——回灌是**点对点**，不广播（其他客户端不需要别人的回灌）。
- 同步 for 发送：Node 单线程保证回灌段完成后新 onData 才发出，该 client 视角顺序正确。
- PTY exit 保留 buffer（exit 前输出仍可回灌）；session 销毁/PTY kill 时清除。
- 回灌消息**不带 seq**（快照非新事件），renderer 现有 `scrollback.push` 消费路径零改动；renderer scrollback 自身 5000 条上限（`useTerminal.ts:52`）天然防叠加膨胀——重复 attach 回灌 = renderer 缓冲内旧内容重复？**边界处理**：renderer useTerminal 在 WS 重连后应清一次 per-session scrollback 再 attach（否则断线前缓冲 + 回灌全量重复显示）。这是 P2 renderer 侧唯一 terminal 改动（见 §6.3）。terminal.data 广播时仍打全局 seq（D1），但不入 session 桶（D3），与 chat 事件的 session 桶互不干扰。

## 六、renderer 改造

### 6.1 ws-client：seq 跟踪 + 重连携带（`lib/ws-client.ts`）

```ts
// 模块级新增（P1 auth 基础上）
let lastSeq = 0
let serverBootId: string | null = null
let getSubscribedSessions: () => string[] = () => []  // 注入：返回当前 chat messages.value.keys()

// onmessage 拦截层（P1 的 auth 拦截同处）：msg.seq > lastSeq → lastSeq = msg.seq
// auth.ok 处理：resumed=false && seqReset → 清 lastSeq/bootId → location.reload()
//              否则记录 serverBootId；lastSeq = max(lastSeq, payload.serverSeq)
// connect() 发 auth 时：lastSeq>0 && serverBootId → payload 带 lastSeq + bootId + subscribedSessions
```

- seq 更新点在 ws-client onmessage（routeInbound 之前）——与 mock 路径关系：mock 不经过真实 onmessage，lastSeq 恒 0，行为不变。
- `location.reload()` 是 renderer 首个 reload 调用（现状 grep 零命中）——加注释关联本设计 D6。

### 6.2 routeInbound 不动

回放消息与实时消息同形态同通道（seq>lastSeq 的消息按序到达），dispatch 逻辑零改动。chat effect 非幂等不构成问题：回放段恰为缺失段，服务端 watermark 判定保证零重复（D4），单线程 onmessage 同步处理保证「处理与 lastSeq 更新」原子。

### 6.3 useTerminal：重连清 scrollback（`useTerminal.ts`）

watch connected（或 events 层监听重连事件）→ 清 per-session renderer scrollback → 重新 attach → 服务端回灌全量。避免断线前缓冲与回灌重复。

### 6.4 useConnection 微调

- `ensureDispatcher`/`routeInbound` 不变。
- 重连后现状补拉（`useSidebar.ts:497-500` workspace.load + extensionApi.scan）保留——resumed 路径下它们是冗余但无害的（幂等全量刷新），不区别对待，保持简单。

## 七、与现有断线语义的对照改善

| 场景 | 现状 | P2 后 |
|---|---|---|
| 弱网闪断 30s（pi 生成中） | 断线窗口 delta 永久缺失；pi 完成则卡「思考中」至 10min 超时 | lastSeq 回放补齐，UI 无感 |
| 断线 10 分钟（pi 持续输出） | 同上 + terminal 输出丢失 | 超 buffer 驱逐 → seqReset → reload 全量恢复 |
| 移动端页面冻结 5 分钟回前台 | 同闪断（丢消息） | 页面存活 → 内存 lastSeq → 回放补齐 |
| 移动端页面被杀重开 | 全量 initial state（正确） | 不变（冷启动不带 lastSeq，正确） |
| runtime 崩溃重启 | restarting 屏 → 重连 → chat 不重拉，可能卡 streaming | bootId 不匹配 → reload → 全量恢复 |
| 重连后切到 terminal tab | 断线窗口输出缺失 | attach 回灌补齐（含未挂载期间） |

## 八、资源与配置

| 项 | 默认 | env |
|---|---|---|
| per-session replay buffer | 1000 条 / 8MB per session | `XYZ_AGENT_REPLAY_MAX_MESSAGES_PER_SESSION` / `XYZ_AGENT_REPLAY_MAX_BYTES_PER_SESSION` |
| session 桶数上限 | = `XYZ_AGENT_MAX_SESSIONS`（默认 10，P0 §七复用） | `XYZ_AGENT_MAX_SESSIONS` |
| terminal scrollback | 1000 chunks / 256KB per session | `XYZ_AGENT_TERMINAL_SCROLLBACK_BYTES` |
| bootId | 启动时 `crypto.randomUUID()` | — |

内存估算：每桶典型 1-5MB（pi 流式 ~130B/条，1000 条 ≈ 130KB，但 `message.*` 单条体积差异大），上限 8MB × MAX_SESSIONS(10) = 80MB 最坏；terminal 256KB × 10 = 2.5MB。per-session 分桶后单桶容量比原全局 5000 条小（避免单个 session 历史过长），但多 session 并发时总量可能上升——可通过调小 per-session 上限或 MAX_SESSIONS 控制。session 销毁自动清桶，无长期泄漏。

## 九、兼容性契约

| 契约 | 保障 |
|---|---|
| 无 auth 的本地开放模式（P0 D1） | 本地模式（Electron 连本地 runtime，不传 token-file）不走 auth 协议，**不获得 P2 回放能力**——重连走现状冷启动全量同步路径。这是有意取舍：本地模式无多客户端竞争、无移动端长断线场景，现状路径已够用；P2 回放能力仅认证模式（server CLI 部署、远程模式）生效。token 在 auth 启用时必填（P0 协议不变） |
| mock 模式 | mock 路径不过 onmessage，lastSeq 恒 0，不触发任何新逻辑 |
| 旧客户端连新服务端 | 旧客户端不带 lastSeq → 冷启动全量路径，与现状一致；envelope 多 seq 字段旧客户端忽略（JSON 宽松） |
| 新客户端连旧服务端 | P2 不保证（版本同发布，自托管场景服务端先升） |
| 消息 id 体系 | 不动（D2 seq 与 id 正交） |
| initial state 13 段（R3-M1 核实） | 冷启动/reset 路径逐段不变 |
| 全局消息（无 sessionId） | 不入任何 session 桶（D2）。**resume 路径下断线期间的全局增量会丢失**（D2.2 承认此取舍）——前端重连补拉（P1 §6.4 现状的 workspace.load/extensionApi.scan）刷新部分全局态，其余靠下次操作触发的 RPC 拉取或冷启动 initial state 覆盖。冷启动/reset 路径走 initial state 全量，无此问题 |

## 十、测试计划

框架 vitest（`packages/runtime/` 与 `packages/renderer/`，`npx vitest run`）。

| 测试 | 位置 | 要点 |
|---|---|---|
| seq 打点 | `transport/message-broker.replay.test.ts`（新建） | 广播递增 seq；terminal.data 有 seq 不入 session 桶；无 sessionId 的全局消息不入任何桶；stringify 失败 seq 空洞 |
| per-session 分桶 | 同上 | 有 sessionId 消息入对应桶；多 session 消息各自入桶互不干扰；同 session 连续消息保序 |
| buffer 驱逐 | 同上 | 单桶条数/字节双限从头部 LRU 驱逐推进 watermark；巨消息豁免不入桶不推进 watermark；`clearSessionBuffer` 移除整桶**不推进** watermark（D4 ①） |
| getReplayPlan | 同上 | bootId 不匹配→reset；lastSeq<watermark→reset；边界 lastSeq=watermark→resume；空缺失 resume；**subscribedSessions 过滤：只回放订阅 session 桶**；**多桶合并：订阅 A/B 各有 seq>lastSeq，回放按全局 seq 升序合并无交错**；**未订阅 session C 的桶不被回放** |
| auth 回放编排 | `transport/connection-manager.auth.test.ts` 扩展（P0 文件） | 冷启动推 initial state；resumed 不推 initial state 且限定订阅桶按序直发；seqReset 推全量带标志 |
| terminal scrollback | `services/terminal/terminal-service.test.ts` 扩展 | onData 入 buffer 双限驱逐；attach 同步回灌点对点；kill 清除 |
| renderer seq 跟踪 | `lib/ws-client.test.ts` 扩展 | onmessage 更新 lastSeq；重连 auth 带 lastSeq+bootId+subscribedSessions；seqReset→reload（mock location）；auth.ok serverSeq 基线 |
| useTerminal 重连 | useTerminal 测试扩展 | 重连清 scrollback + 重新 attach |
| 端到端验证脚本 | `tools/verify-replay.cjs`（新建，AGENTS 规则 #4） | 真起 runtime（带 token）→ client A 连上收消息 → 断 → RPC 触发若干广播（含多 session）→ A 带 lastSeq+subscribedSessions 重连 → 断言按序收到缺失段且无重复、未订阅 session 不回放 → 第二客户端 B 冷启动收到全量 initial state |

## 十一、开放问题

1. **`message.file_changes` 幂等**：探索遗留未确认（按 messageId 关联，可能需去重）——实施 T2 时顺带核实，若非幂等且可重复，补 messageId 去重（小改，本设计范围内）。
2. **replay 大 backlog 的 UI 表现**：断线 5 分钟数千条 delta 一次性回放，chat effect 逐条 append 可能卡顿。可选优化：回放消息打 `replayed: true` 标记让 renderer 批量 requestAnimationFrame 提交。P2 不做，实测卡顿再议。
3. **SSE 备选**（feature-map §4.2 记录）：五件套工作量如预期可控（broadcast 单出口 + auth 已就位），维持 WS 统一方案。
4. **per-session 桶的清理时机**：session 销毁时清桶已纳入设计（§3.1），但「session 长期闲置（未销毁但无活动）时是否压缩桶」未定。当前每桶独立 LRU 驱逐已防膨胀，长期闲置桶占内存但不增长——MAX_SESSIONS 上限内可接受。如后续内存压力大再议。
