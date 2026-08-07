# 远程化 P3 设计：pi 与连接生命周期解耦

**日期**: 2026-07-26 | **状态**: 设计定稿（待实施） | **上游方案**: [docs/feature-map/2026-07-26-remote.md](../../docs/feature-map/2026-07-26-remote.md)（§九 P3 阶段、§8.4 P3、§十 待确认 #3） | **前置设计**: [P0](../2026-07-26-remote-p0/spec.md)（auth）、[P2](../2026-07-26-remote-p2/spec.md)（可靠投递层——本阶段的短断线恢复地基）

> P3 范围（feature-map §九）：WS 断开不 kill pi；pi 跑到完成或显式取消；重连续流；审批挂起多端唤醒——feature-map 预估「runtime 中改」。
>
> **代码核实后的关键发现：解耦主体已是现状。** pi 进程的全部 5 条终止路径（session.delete / restore 重建 / 同 id 冲突 / 创建失败清理 / runtime 关停）无一与 WS 连接状态相关；`connection-manager.ts:97-101` 的 close 处理只清连接池和心跳，无任何 onDisconnect 订阅者。客户端全断开时 pi 继续跑、事件继续翻译广播（零客户端 = no-op 循环）。因此 P3 的实际改动**小于 feature-map 预估**：真正缺失的只有「审批挂起的重连唤醒」一块，其余是语义固化（防回归测试）与文档。
>
> 本文档同时回答 feature-map §十 待确认 #3 的两个开放子问题。

---

## 一、设计决策总表

| # | 决策 | 选择 | 理由 / 证据 |
|---|---|---|---|
| D1 | **断开语义** | **WS 断开（含全部断开）pi 继续跑到 turn_end**，固化为契约 + 防回归测试，不改代码 | 现状已如此（无 onDisconnect 清理路径），但没有任何机制防止未来有人加「最后一个客户端断开就清理」——用测试固化。回答待确认 #3(a) |
| D2 | **审批挂起语义** | **pi 等审批时全客户端离线 → 无限期挂起，不设超时**；任一客户端连接（含冷启动）时服务端主动补发 pending 请求唤醒 | 回答待确认 #3(b)。现状 extension UI 超时已是死代码（**R3-m1 行号修正**：`extension-timeout-manager.ts:9-11` [2026-07-16] 日期戳、`:13-24` 死代码 TODO、`:51` EXTENSION_UI_TIMEOUT_MS 常量、`:78-84` 真正讲"取消所有 extension UI 超时"的注释）——单用户自托管下「用户自己的审批自己负责」，超时会自动回默认响应（confirm→false）是危险默认值，不恢复。MAX_SESSIONS（P0 §七）已限总量，挂起 session 占坑可控 |
| D3 | **审批唤醒实现** | **sendInitialState 加第 14 段 `extension.pendingRequestsBatch`**（**【R1-C1 修正】独立 type，不复用 `extension.pendingRequests`**——reply 是单 session 带 sessionId，push 是全局不带 sessionId，同型异构会撞 tsc），点对点，auth 后随 initial state 推送，前端新增 handler 消费填入 store | 双通路补全：短断线由 P2 ring buffer 回放覆盖（`extension.ui_request` 是广播，天然入 buffer）；长断线/冷启动/页面 reload 由 initial state 段覆盖。数据源相同（`ExtensionTimeoutManager.pendingRequests`，`extension-timeout-manager.ts:168-186`），但 payload type 独立。选推送而非前端拉取：审批是**阻塞 pi 的紧急态**，值得服务端主动推 |
| D4 | **runtime 关停语义** | **维持现状：SIGTERM → destroyAll 杀全部 pi**（`server.ts:294-298`）；不做 detached 保活。恢复路径 = JSONL 持久化 + restoreSession 热恢复（`session-lifecycle.ts:197-267`） | systemd/Docker 重启时用户预期进程清理；detached 保活会把孤儿子进程的管理负担转嫁部署层。turn 中断的 session 写 `stopped` sidecar（`persistSessionEnd`），重启后用户点开即 restore 继续。部署文档写明「更新/重启 runtime 会中断进行中的 turn」 |
| D5 | **重连续流** | **零新增改动**：短断线 P2 回放补齐 delta；冷启动靠 `config.sessions` 的 `status:'active'`（`session-service.ts:715`）显示生成中 + 新 delta 持续到达 + `message.complete` 权威 content 覆盖收口（`chat-message-effects.ts:323-336`） | P2 设计时已对齐；P3 只做端到端验证（turn 进行中断线→重连→流续上→complete 收口） |
| D6 | **watchdog 共存** | ping watchdog（`event-interpreter.ts:561-637`，turn 内 60s ping、180s 无响应 abort turn）**不动**；加测试验证审批挂起不被误 abort | 注释（`event-interpreter.ts:110`）明确 pi 等 extension 响应时 RPC 读循环仍处理 stdin，ping 可穿透——信任但验证 |
| D7 | **消息排队** | 维持 pi 原生 follow_up 队列（`rpc-client.ts:435-437`），runtime 不存队列；**pi 进程死亡 = 排队消息丢失**，文档注明 | 队列在 pi 内存是 pi 原生语义；runtime 复制一份队列 = 双写一致性问题，不值。边界场景（kill 时有排队）接受丢失 |
| D8 | **idle pi 资源** | 不做 idle reaper / LRU；`XYZ_AGENT_MAX_SESSIONS`（P0 §七，默认 10）是唯一总量阀 | 单用户自托管，10 个 idle pi 进程内存可接受；reaper 杀错进程的代价远大于省下的内存 |

**明确不在 P3**：presence（P6 做「谁在线」可视化，P3 的唤醒不需要 presence 协议）、租约锁（P5）、runtime 重启后自动 restore 所有 session（用户点开才 restore 的懒恢复保留，自动全量恢复会无差别占资源）、审批的移动端推送通知（P12）。

**对 P2 的依赖**：审批补发依赖 sendInitialState 的 auth 门控（P0 §2.1 auth.ok 后才推）；短断线恢复依赖 P2 ring buffer。P3 新增 1 个 ServerMessage type `extension.pendingRequestsBatch`（**R1-C1**：独立 type，非复用 `extension.pendingRequests` reply 形态）。

---

## 二、唯一代码改动：pending UI 请求补发

### 2.1 服务端（sendInitialState 第 14 段）

`message-broker.ts` sendInitialState（:197-293，**【R3-M1 修正】现 13 段**）追加第 14 段：

```ts
// step 14: 挂起的 extension UI 请求（审批/ask-user/select/input/editor）
// 【R1-C1 修正】独立 type extension.pendingRequestsBatch（非 extension.pendingRequests）
// 数据源 = ExtensionTimeoutManager.pendingRequests（与 getPendingRequests RPC 同源）
{ type: 'extension.pendingRequestsBatch', payload: { requests: PendingUiRequest[] } }
```

- **【R1-C1】独立 type 不复用 `extension.pendingRequests`**：现有 `extension.pendingRequests` 是 `extension.getPendingRequests` RPC 的 reply（payload `{ sessionId, requests }`，单 session）；initial-state push 是全局聚合（payload `{ requests }`，跨所有 session），**不带 sessionId**。同型异构会导致 ServerMessageMap 一型两形撞 tsc。新增 `extension.pendingRequestsBatch` 承载 push 形态。
- **点对点**（随 initial state 发给新连接），非广播——已连接客户端持有自己的 pending 视图，不需要别人的补发。
- **实施前置核实**（plan T1）：① `cachePendingRequest` 存的字段是否足够原样重建 UI（requestId/sessionId/method/title/options/…）；② pendingRequests 的清理路径——客户端响应后 `removePendingRequest`（现状已有），session 删除/pi 进程退出时是否清缓存（孤儿请求会随 initial state 反复推给新连接，必须清）；③ 缓存条数上限（防泄漏）。

### 2.2 renderer（useExtensionUI 消费）

- `useExtensionUI`（现状已订 `extension.ui_request` 实时帧）新增 `extension.pendingRequestsBatch` handler（**R1-C1：独立 type**）：逐条按现有 ui_request 处理路径填入 store（弹审批 UI）。
- **去重**：handler 以 requestId 为键写入（现状 store 若已是 Map 则天然幂等；若是数组需补 requestId 查重——P2 回放 + initial state 补发可能对同一请求投递两次：短断线重连时 buffer 回放含 ui_request，同连接 initial state 不推（resumed 路径），所以实际不重叠；但「auth 重连 + 页面未 reload 但组件重挂载」等边角仍可能重复，requestId 去重兜底）。
- **冷启动时序**：initial state 到达时 AppShell 可能尚未挂载（useExtensionUI 订阅未注册）——与 AGENTS「runtime broadcast 时序竞争」同类问题。对策：**订阅常驻化**（handler 注册挪到 useConnection dispatcher 层或 App setup，与 useChat 全局路由同范式），或前端在 onConnected 后主动调一次 `extension.getPendingRequests` 兜底。二选一，实施时按现有订阅格局取简单者（倾向后者：零新订阅，复用已有 RPC）。

### 2.3 补发消息与 P2 seq 的关系

第 14 段是 initial state 的一部分（点对点）→ 按 P2 D1 **不打 seq、不入 buffer**，与现有 13 段一致。实时 `extension.ui_request` 广播照旧打 seq 入 buffer。

## 三、语义固化（防回归测试）

| 契约 | 测试 |
|---|---|
| 全客户端断开 pi 存活 | connection-manager/session-service 集成测试：建立 session + 开始生成 → 断开全部 ws → 断言 pi 进程存活、事件继续产出入 P2 buffer；重连回放收到缺失 delta |
| 审批挂起不被 watchdog 误 abort | event-interpreter 测试：mock pi 挂起 extension_ui_request（ping 正常响应、无 turn 事件）→ 推进 180s+ → 断言 onSilentAbort 未触发 |
| 审批挂起重连唤醒 | 端到端：pi 挂起审批 → 客户端断开 → 冷启动新客户端 → 收到 `extension.pendingRequestsBatch` → 响应 → pi 继续 |
| runtime 关停杀 pi | 已有路径，补断言：SIGTERM → destroyAll 调用（若现有测试未覆盖） |

## 四、文档化（无代码）

1. **部署文档追加**（P0 `docs/deployment/server.md` 的后续维护项，随 P0 实施一并写或 P3 补）：
   - 「重启/升级 runtime 会中断所有进行中的 turn」（D4）；session 历史不丢，重开即恢复
   - 「pi 等审批时离开：审批请求会挂起，任一设备重连后弹出」（D2/D3）
   - 「排队消息（follow_up）在 pi 进程内存，runtime 重启即丢」（D7）
2. **troubleshooting.md 追加**：「客户端全断开后台 session 是否继续跑？——是，重连自动补齐（P2）」。

## 五、与 feature-map §8.4 P3 原文的对照

| 原文要求 | 本设计落点 |
|---|---|
| WS 断开不 kill pi | 现状已是，D1 测试固化 |
| pi 跑到完成或显式取消 | 现状已是（abort 链路 `message-dispatcher.ts:161-194` 任一客户端可发，多客户端共享 session 天然支持） |
| 重连续流 | D5：P2 回放 + 现有冷启动拉取，零新增 |
| 审批挂起所有客户端离线 → 挂起等待（带超时） | D2：挂起等待，**不带超时**（偏离原文括号——死代码史证明超时自动回默认响应危险，且单用户场景无价值） |
| 任一客户端重连后 presence 唤醒 | D3：initial state **第 14 段**（R3-M1）补发 `extension.pendingRequestsBatch`（不需要等 P6 presence 协议，提前落地） |

## 六、测试计划

框架 vitest（`packages/runtime/`、`packages/renderer/`）。

| 测试 | 位置 | 要点 |
|---|---|---|
| pending 补发段 | `message-broker` 测试扩展 | sendInitialState 含**第 14 段** `extension.pendingRequestsBatch`（R3-M1/R1-C1）；requests 为空时段落省略或空数组（实施定） |
| 缓存清理审计 | `extension-timeout-manager` 测试扩展 | session 删除/pi 退出后 pendingRequests 无孤儿（T1 核实后补对应清理 + 断言） |
| renderer 消费 | useExtensionUI 测试扩展 | pendingRequests push → 审批 UI 出现（用户可见断言）；requestId 重复投递不重复弹 |
| §三 四条契约 | 见上表 | |
| 端到端 | `tools/verify-pi-decouple.cjs`（新建） | 真 runtime + 真 pi：开始生成 → 断 client → 等 turn 完成 → 重连 → 回放含完整 turn；审批挂起场景同上 |

## 七、开放问题

1. **pendingRequests 缓存上限与 TTL**：若用户永不响应且反复创建审批（如脚本化 extension），缓存是否无界增长。实施 T1 审计后决定加不加 LRU（预期：量极小，不加）。
2. **多客户端同时响应同一审批**：现状 `extension.ui_response` 先到的生效、清 pending，后到的因 pending 已清而走 bridge/error 分支——多客户端场景两个设备同时点审批，后到者的 UX（静默忽略 vs 提示「已被其他设备处理」）。P3 不处理，列入 P6 presence 协同的附带项。
3. **runtime 重启后自动 restore「 dying 时正在生成」的 session**：sidecar 有 `stopped` 终态可识别，可做「启动时把 interrupted session 标记到列表」。懒恢复已够用，不做；用户反馈后再议。
