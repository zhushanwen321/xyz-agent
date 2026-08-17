# ws-client 不变量规格（特征测试断言依据）

> **来源**：renderer-rebuild-architecture.md §5.1（ws-client 不预拆，先整体迁入）/ §11.0.4（不变量定义修正）/ 附录 B.2-4（ws-client 不预拆 + 特征测试覆盖）
> **用途**：AC7 双交付之 markdown 规格权威。本文件列 5 类关键行为的特征断言点，P1 ws-client 迁入 core 后，`packages/core/src/transport/__tests__/ws-client.invariants.test.ts` 的 `it.todo` 按本文规格替换为真实断言。
> **不变量定义修正**：旧「本地模式逐字节不变」不可执行（测试无法锁定字节级）→ 新「**特征测试覆盖的关键行为不变**」。本文档定义的 5 类行为特征 = 特征测试必须锁定的不变量。

---

## ① 连接状态机

ws-client 维护连接状态（connecting / open / closing / closed），仅允许合法迁移。

**特征断言点**：
1. **合法迁移 connecting → open**：`WebSocketFactory.create()` 返回实例后进入 connecting，`onopen` 触发后迁移至 open（状态机推进，非直接跳变）。
2. **合法迁移 open → closing → closed**：主动 `close()` 先进入 closing，`onclose` 触发后进入 closed。
3. **非法迁移拒绝**：open 状态下收到意外 connecting 信号（如重连竞态）不重置状态机，保持 open（防状态回退）。
4. **closed 是重连起点**：closed 状态触发重连评估（见 ⑤ 退避），重连时从 closed → connecting 重新开始。

---

## ② auth 握手

连接 open 后立即发送 auth 消息（`buildAuthMessage`），等服务端 `auth.ok` / `auth.reject` 响应才进入正常消息处理。

**特征断言点**：
1. **auth.ok 后订阅 + flush**：收到 `auth.ok` 触发 session 通道订阅（subscribed sessions 注入）+ flush pending 队列（连接期间缓存的消息发出）。
2. **auth.reject 降级**：收到 `auth.reject` 触发降级——不进入消息处理循环，标记连接不可用，通知壳展示降级 UI（不静默吞错）。
3. **auth 时序**：auth 消息在 open 前不发（connecting 阶段不发业务消息）；open 后第一帧必须是 auth（防业务消息在未认证连接上泄漏）。
4. **probe 与 ws-client 共用 buildAuthMessage**：remote/probe 的连接探测与 ws-client 主连接共用 `buildAuthMessage`（防漂移测试随迁，见 §5.1）。

---

## ③ close code 分流

ws-client 按 WebSocket close code 分流重连策略。

**特征断言点**：
1. **1006（异常关闭）→ 重连**：1006 是浏览器层异常关闭（网络断开/服务端无响应），触发重连走 ⑤ 退避序列。
2. **4001（认证失效）→ 不重连**：服务端明确拒绝认证（token 过期/无效），重连无意义。标记需重新认证，壳降级提示用户重连前需刷新凭据。
3. **4xxx（服务端正常关闭，如 4000/4003）→ 不重连**：服务端主动关闭（如维护/限流），ws-client 尊重服务端意图不重连，等待服务端恢复或用户手动重连。
4. **分流判定集中**：close code 三分支判定集中在 ws-client 单点（不散落到 routeInbound 或 domain），便于 P1 迁移时整体锁定行为。

---

## ④ seq 回放（可靠投递语义）

session 通道消息带 seq 号，gap 检测后 reconcile 保证消息不丢。seq 机制全部在 transport + coordination，不进 domain（domain store 只面对已排序、已去重的消息流）。

**特征断言点**：
1. **seq gap 检测 → reconcile 请求**：收到消息 seq 跳号（如上次 seq=10，本次 seq=15）触发 reconcile 请求，拉取缺失区间（seq 11-14）。
2. **reconcile → seqReset → reload**：reconcile 响应后服务端发 seqReset，ws-client 触发 reload 会话历史（重新拉取完整消息流）。**重载前静默窗口逻辑保留**（reload 期间不处理新消息，防乱序）。
3. **presence 弱可靠通道不入 seq 桶**：presence 是全局协同态，弱可靠——不入 seq 桶，靠 `auth.ok` / `presence.list` 兜底补全。本约束在 coordination/presence.ts 注释 + 测试锁定，防未来误「修复」成入桶。
4. **send.rejected 点对点**：send 被拒是 reply 点对点（remote-use 语义变更），新链路按此建模，不回退广播语义。

---

## ⑤ 重连退避

异常关闭（1006）后按指数退避重连，visibility 事件可立即触发重连。

**特征断言点**：
1. **指数退避参数**：base（如 1s）/ cap（如 30s）/ jitter（随机抖动防惊群）符合预期序列。重连失败后退避翻倍，达 cap 后保持 cap，不无限增长。
2. **visibilitychange 触发立即重连**：页面重新可见（`document.visibilitychange` → visible）时，若当前处于退避等待，立即触发重连并**重置退避计数**（用户回到页面应尽快恢复连接）。
3. **重连上限**：连续重连失败达上限（如 10 次）后停止自动重连，避免无限重试消耗资源，标记需用户手动重连。
4. **退避状态机与连接状态机解耦**：退避计时是 closed 状态内的子状态，不污染 connecting/open 状态（重连成功后退避归零）。

---

## 协议演进纪律

- P1 ws-client 从 remote-use 整体迁入 core/transport/，**先不预拆**（auth/seq/RTT 三者经模块级状态紧耦合，拆分边界按实际耦合测量再定）。
- 本规格的 5 类行为特征是特征测试必须锁定的不变量。P1 迁入后 it.todo 替换为真实断言，断言点对应本文逐条特征。
- 新增行为不变量（如未来引入心跳/RTT 测量）时，先扩本文规格 + 新增 it.todo，再实现——规格先行。
