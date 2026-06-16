# 阶段 1 · 前端 API Client 层（最高收益，独立可验证）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：D3 / D6a / D6b / D8 / D9 / G3–G6 · spec：design.md §D3、§4.1 R4
> **v1.1 修订**（plan-review-round-1）：扩迁移范围（不止 7 composable）、mock 按重写估工、useChat 23 事件 + G6 reconcile、G5 改路由层收尾、修正消息数、Runtime id 回填已就绪。

## 目标

新建 `renderer/src/api/`，统一 WS+IPC 门面，命令(Promise)+事件(订阅)混合。迁移**所有** send 直调方（composable + store + 组件），错误流收口，mock 下沉。

## 前置依赖

阶段 0（文档基线）。Runtime 侧 id 回填**已就绪**（见下），仅需前端发 id。

## 现状（已核对）

### send 直调方（不止 7 composable，共 ~10 文件）

| 类型 | 文件 | send 处数 | 消息类型 |
|------|------|----------|---------|
| composable | useChat | 2 | message.send/abort |
| composable | useSession | 6 | session.create/delete/rename/list/history/compact |
| composable | useModel | 3 | model.list/switch + **session.setThinkingLevel** |
| composable | useProvider | 11 | config.getProviders/setProvider/deleteProvider/discoverModels/scanSkills/setSkill/deleteSkill/scanAgents/setAgent/deleteAgent |
| composable | useTree | 8 | session.list/history/switch + **tree-capability/clone/data/fork/navigate**（5 个 tree.*） |
| composable | useExtensionUI | 2 | extension.ui_response + **plugin.uiResponse**（跨 extension/plugin 两 domain） |
| composable | useToolApproval | 3 | tool.approve/deny/always_allow |
| **store** | **stores/plugin.ts** | **9** | plugin.list/uninstall/config.get/set/approvePermissions/revokePermissions…（**store 直 send，正是要消灭的反模式**） |
| **组件** | **settings/ExtensionsPane.vue** | 8 | extension.* |
| **组件** | **panel/PanelSessionView.vue** | 4 | session.setThinkingLevel/message.steer/follow_up/动态 |
| **组件** | **chat/SkillDrawer.vue** | 1 | file.read（**已用 `id: requestId`**，唯一已带 id 的调用方） |
| **组件** | **layout/AppStatusbar.vue** | 若干 | （迁移时一并扫） |

### useChat 事件订阅现状（23 个事件，全局单例模式）

`useChat.ts:339-362` 用模块级 `createGlobalHandlers()` 返回 `Map<ServerMessageType, handler>`（23 项），`registerGlobalListeners()`（:371）在模块加载时经 `queueMicrotask` 注册一次，**永不注销**（:374 注释）：

`message.message_start / text_delta / thinking_start / thinking_delta / thinking_end / tool_call_start / tool_call_end / tool_call_update / complete / error / status / bashExecution / compactionSummary / branchSummary / auto_retry_start / auto_retry_end / queue_update / stream_error` + `extension.error` + `extension:setEditorText` + `context.update` + `session.renamed` + `session.thinkingLevelSet`。

### Runtime 侧 id 回填（已就绪）

5 个 handler 共 85 处已回填请求 `id`（session-handler 15、tree 14、extension 28、plugin 13、settings 15）；`pong`/`file.read:result`/`sendError` 均回填。**task 4 无需改 Runtime，仅需前端 pending.ts 发 id。**

## 改动清单（有序 task）

### 1. 建 `api/` 骨架（design.md R4）

```
renderer/src/api/
├── index.ts        # createApiClient({ ws, ipc, mock }) → 统一 api 对象
├── transport.ts    # 抹平 ws send/recv 与 ipc invoke 差异
├── pending.ts      # id→Promise 关联表（command 实现）
├── events.ts       # 事件订阅 + session 路由第 2 层 + 重连收尾（G5）
├── domains/        # session.ts chat.ts config.ts model.ts tree.ts extension.ts plugin.ts system.ts
└── mock/           # 同接口假实现（D8，重写非搬迁）
```

### 2. `pending.ts`：command + G4 超时善后

- `command<T>(msg): Promise<T>`：发 `{...msg, id: crypto.randomUUID()}`，存 pending Map，返回 Promise。
- **G4**：30s 超时 reject `ApiTimeoutError` + 删 id；迟到响应（pending 无 id）丢弃；WS 断连时 pending 全 reject `ApiDisconnectError`。
- **command 与 messageQueue 交互**：断连期 command 不入队（队列只收 fire-and-forget 的 event 类 send）；入队超时由 pending 的 30s 计时器统一管，与队列重发解耦。

### 3. `events.ts`：G6 生命周期 + G5 路由层收尾 + D6b 路由

- **G6 reconcile useChat 全局单例**：useChat 现状是模块级全局单例注册（`globalEventMap` 幂等 + 永不注销）。**保持全局单例模式**（23 个事件是全局聊天流，非每组件实例），但收口到 `api.events`：`useChat` 改为订阅 `api.events.on(type, handler)` 而非直 `event-bus.on`。G6 的 refCount 多实例去重**只适用于组件级 on（如 PanelSessionView 自身订阅）**，不适用于 useChat 全局流——文档标注区分。
- **G5 收尾链路**（决策 A，符合 design.md R2/§4.1 依赖图——features 是唯一同时碰 api+store 的层）：
  - `useConnection`（effects 层，不碰 store）重连成功 → `api.events.emit('connection.restored')`
  - `events.ts`（api 层）只提供 emit/on 机制 + D6b 丢弃逻辑（无 sessionId → warn，不碰 store）
  - `useChat`（**features 层**，授权碰 store）订阅 `connection.restored` → 遍历 `isGenerating=true` 的 session 调 `markSessionError(sid, '连接已重置')`
  - **events.ts 不直接调 markSessionError**（避免 api 层碰 store，违反依赖图）
- **ws-client messageQueue 清空**（G5 决策 A 配套）：重连 `onopen` 时**清空 session-scoped 队列**（不重发给重启后的 runtime）；保留系统级消息（如纯查询）的队列或全部清空——执行时定，原则是「runtime 重启后旧 session 消息无意义」。
- **D6b**：session-scoped 消息无 `payload.sessionId` → 丢弃 + dev warn。

### 4. 迁移所有 send 直调方（灰度并存）

顺序（由简到繁，每步独立 commit 可验证）：
1. useToolApproval（3 tool.*）
2. useModel（3，含 setThinkingLevel）
3. useSession（6）
4. useTree（8，含 5 tree.*）
5. useExtensionUI（2，跨 extension/plugin）
6. useProvider（11 config.*，量最大）
7. **stores/plugin.ts**（9，store 反模式优先消灭）
8. **3 组件**（ExtensionsPane 8 / PanelSessionView 4 / SkillDrawer 1 / AppStatusbar）
9. **useChat 最后**（message.send 触发即流 + 迁移 23 个事件订阅到 api.events）

每步：`send({type,payload})` → `await api.xxx.yyy(payload)`，删 ws-client import。

### 5. D6a 错误流收口 + G3 优先级

- `chatStore.markSessionError(sid, err)`：唯一错误入口。
- **G3**：有 sessionId 的错误（`stream_error`）路由到 store 分区后调 markSessionError；D6b 丢弃只针对无 sessionId 的。

### 6. D8 Mock 重写（非搬迁，估工大）

现状 `mock/mock-ws.ts`（273 行）+ `mock/data.ts`（725 行）= **998 行**，机制是「传输层拦截 connect/send + 直推 event-bus + 改 store」。下沉到 api 层需**重写**为「实现同一 `api` 接口，返回预制 Promise / emit 预制事件」。

- VITE_MOCK 检查点在 **2 处**：`ws-client.ts:24/100/117` + **`useConnection.ts:45,53`**（connect 路径分支），都要迁。
- mock/data.ts（725 行预制数据）可复用，仅改消费方式。
- **Mock 必须覆盖的 api 方法最小集**（plan-review-round-3 P3，保证 `VITE_MOCK=true` 能跑通主流程）：
  - `session`：create / list / switch / abort / fork / rename / delete / destroyAll
  - `message`：send / stream（text_delta 流式返回预制消息）/ compaction / retry
  - `config`：getProviders / getConfig
  - `model`：list / switch
  - `tree`：get / setExpanded / setActive
  - `extension`：list / invoke
  - `plugin`：list / invoke / uiResponse
  - `context`：update / get
  - 以上对照 `shared/protocol.ts` 消息类型，逐个在 mock api 实现中返回预制 Promise / emit 预制 ServerMessage。

## 执行拆分（Subagent 分配）

改动清单的 6 个 task 映射到 **6 个 subagent**，分 4 轮执行（串行链 → 3 路并行 → 收尾）。依赖图：

```
SA1 (传输+命令核心) → SA2 (事件路由+domains) → ┬ SA3 (mock 重写)        ┐
                                                 ├ SA4 (composable 迁移)  → SA6 (useChat+错误流+集成)
                                                 └ SA5 (store+组件迁移)   ┘
```

每个 SA 独立 commit、可单独 revert。SA1/SA2 串行（SA2 依赖 SA1 的 pending 公开接口）；SA3/SA4/SA5 并行（均只依赖 SA2 定义的 api 接口）；SA6 收尾（依赖前三者完成）。

| SA | 对应 task | 目标 | 文件 | 依赖 | 行数估算 |
|----|----------|------|------|------|---------|
| **SA1** | task1+2(传输/命令) | api 传输层 + command 机制（含 G4 超时/断连 reject） | 新建 `api/transport.ts`、`api/pending.ts`、`api/index.ts`(骨架) | ws-client.ts、event-bus.ts | ~350 |
| **SA2** | task1+3(事件/domains) | 消息路由分发 + 8 个 domain 实现 + createApiClient 补全 | 新建 `api/events.ts`、`api/domains/{session,chat,config,model,tree,extension,plugin,system}.ts`、补全 `api/index.ts` | **SA1**（pending 公开接口：`resolveResponse`/`rejectAll`） | ~450 |
| **SA3** | task6 | D8 mock 重写为 api 同接口实现 | 新建 `api/mock/`（复用 `mock/data.ts` 725 行预制数据） | **SA2**（domains 接口） | ~600（复用后） |
| **SA4** | task4 | 迁移 6 个 composable 的 send→api | 改 `composables/{useToolApproval,useModel,useSession,useExtensionUI,useTree,useProvider}.ts` | **SA2** | ~660 改动 |
| **SA5** | task4 | 迁移 store + 4 组件的 send→api + 清零 send import | 改 `stores/plugin.ts`、`components/{settings/ExtensionsPane,panel/PanelSessionView,chat/SkillDrawer,layout/AppStatusbar}.vue` | **SA2** | ~1100 改动 |
| **SA6** | task5+收尾 | useChat 23 事件迁移 + D6a 错误流收口 + G3 + ws-client G5 清队列 + 全量集成验证 | 改 `composables/useChat.ts`、`composables/useConnection.ts`(emit 信号)、`lib/ws-client.ts`(清队列) | **SA3+SA4+SA5** | ~470 改动 |

### SA 间关键契约（SA1 必须先定）

- `pending.ts` 暴露：`command<T>(msg): Promise<T>`、`resolveResponse(id, payload)`、`rejectAll(reason)`、`clearBySessionId(sid)`（G5 重连清理用）。
- `transport.ts` 暴露：`send(msg)`、`onMessage(handler)`、`onClose(handler)`（events/pending 订阅）。
- `index.ts` 的 `createApiClient({ transport, mock? })` 返回 `{ command, events, ...domains }`——SA1 先不挂 domains，SA2 补全。

### 每个 SA 的验收（commit 前）

- SA1：单测 pending（超时/断连 reject/迟到丢弃）；`command` 发出带 `id` 的消息。
- SA2：单测 events（订阅/取消、D6b 无 sessionId 丢弃、G5 emit 信号）；domains 覆盖 protocol 消息类型（见现状表）。
- SA3：`VITE_MOCK=true npm run dev` mock 主流程跑通（覆盖最小集，见 task6）。
- SA4/SA5：改的文件 `send(` 清零；`npm run dev` 对应功能正常；`npm run lint` 过。
- SA6：useChat 23 事件手测（streaming/abort/thinking/toolCall）；`rg "from.*ws-client" renderer/src/` 仅剩 useConnection+api/transport.ts；`npm run dev` 全功能 + `VITE_MOCK=true` 均正常。

## 验证标准

- [ ] `npm run dev` 全功能正常。
- [ ] `VITE_MOCK=true npm run dev` mock 可跑。
- [ ] 双主题无回归。
- [ ] **`rg "from.*ws-client" renderer/src/`** 扫**全 renderer**（非仅 composables/）：仅剩 useConnection（传输层合法）+ api/transport.ts（封装层）。store/components/composables 的 send 直调清零。
- [ ] API Client 单测：command 超时、事件订阅/取消、session 路由第 2 层丢弃、重连收尾（G5）。
- [ ] useChat 23 事件迁移后行为不变（手测 streaming/abort/thinking/toolCall）。
- [ ] `npm run lint` 通过。

## 回滚

单阶段 commit。灰度并存保证 revert 后恢复直 send。**禁止只迁一半就合并**。

## 风险

| 风险 | 应对 |
|------|------|
| useChat 23 事件迁移遗漏 | 最后做；逐事件对照 :339-362 清单；手测覆盖 |
| mock 998 行重写估工不足 | 单列 task 6；data.ts 可复用降低工作量 |
| messageQueue 清空误伤系统消息 | 区分 session-scoped（清）vs 系统级（留）；测试覆盖 |
| G5 重连收尾跨 useConnection/effects/api/useChat 三层 | events.ts 只 emit 信号；useChat(features) 订阅后调 markSessionError；单测三层联动 |
