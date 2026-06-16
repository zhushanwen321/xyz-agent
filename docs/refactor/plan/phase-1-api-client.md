# 阶段 1 · 前端 API Client 层（最高收益，独立可验证）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：D3 / D6a / D6b / D8 / D9 / G3–G6 · spec：design.md §D3、§4.1 R4

## 目标

新建 `renderer/src/api/`，统一 WS+IPC 门面，命令(Promise)+事件(订阅)混合。迁移 7 个 composable 的 `send()` 直调，错误流收口，mock 下沉。

## 前置依赖

阶段 0（文档基线）。无 Runtime 侧强改动（id 回填是向后兼容增强）。

## 现状（已核对）

7 个 composable 直 `import { send }`，消息类型分布：
- **useChat**：`message.send`、`message.abort`
- **useSession**：`session.create/delete/rename/list/history/compact/switch`
- **useModel**：`model.list`、`model.switch`
- **useProvider**（最多，11 个）：`config.getProviders/setProvider/deleteProvider/discoverModels/scanSkills/setSkill/deleteSkill/scanAgents/setAgent/deleteAgent`
- **useTree**：`session.list/history/switch`
- **useExtensionUI**：2 个 extension 相关
- **useToolApproval**：`tool.approve/deny/always_allow`

`send()` 返回 void（fire-and-forget）；`ClientMessage.id` 可选但几乎无人用。

## 改动清单（有序 task）

### 1. 建 `api/` 骨架（design.md R4）

```
renderer/src/api/
├── index.ts        # createApiClient({ ws, ipc, mock }) → 统一 api 对象（组合根）
├── transport.ts    # 抹平 ws send/recv 与 ipc invoke 差异
├── pending.ts      # id→Promise 关联表（command 实现）
├── events.ts       # 事件订阅 on/off，背后是 event-bus
├── domains/        # typed 方法（复用 protocol.ts union，D9）
│   ├── session.ts  chat.ts  config.ts  model.ts  tree.ts  extension.ts  plugin.ts
│   └── system.ts   # api.window.* / api.dialog.* / api.shortcut.*（走 IPC）
└── mock/           # 同接口假实现，VITE_MOCK 时注入（D8）
```

### 2. `pending.ts` 实现 command + G4 超时善后

- `command<T>(msg): Promise<T>`：生成 `id`（crypto.randomUUID）→ 存入 `pending` Map → `ws.send({...msg, id})` → 返回 Promise。
- **G4 超时**：默认 30s（可配置），超时 → `reject(new ApiTimeoutError(msg))` + 从 pending 删 id。
- **迟到响应**：Runtime 迟到响应到达时 pending 无该 id → 静默丢弃。
- **错误分类**：`ApiTimeoutError` / `ApiDisconnectError`（WS 断连，pending 全 reject）/ 业务错误（Runtime error payload）。
- **断连处理**：ws 断开事件 → 遍历 pending 全 reject `ApiDisconnectError`。

### 3. `events.ts` 实现 G6 生命周期

- `on(type, handler): unsubscribe`。
- **继承 CLAUDE.md #2 refCount**：组件多实例（split mode）下，同 type+handler 用模块级 refCount 合并，防重复注册。`unsubscribe` 时 refCount 归零才真正移除。

### 4. Runtime 侧：直接响应回填 id（向后兼容）

- 在 `server.ts` / handler 中，**直接响应**（非广播）消息回填请求 `id`。
- 广播 / 纯 push（`context.update`、`plugin:statusChange`、`message.text_delta`）**不回填**。
- 消息路由表（T1 声明式）可顺手做，但非本阶段必须。

### 5. 迁移 7 个 composable（灰度并存）

顺序建议（由简到繁，每步独立可验证）：
1. useToolApproval（3 个 tool.* 命令，纯请求/响应）
2. useModel（2 个命令）
3. useSession（7 个命令）
4. useTree（3 个命令）
5. useExtensionUI（2 个）
6. useProvider（11 个 config.*，量最大但模式一致）
7. useChat（`message.send` 触发即流 + `message.abort`；**最后做**，因涉及流式事件订阅 `api.events.on('message.text_delta'...)`）

每步：把 `send({type, payload})` → `await api.xxx.yyy(payload)`，删除该 composable 对 `ws-client` 的 `send` import。

### 6. D6a 错误流收口 + G3 优先级

- `chatStore.markSessionError(sid, err)`：唯一错误入口，内含 `isGenerating=false` + `streamingMessage=null` + push 系统通知。
- **G3**：有 sessionId 的错误消息（如 `stream_error`）路由到 store 分区后调 `markSessionError`；D6b 丢弃规则只针对「session-scoped 但无 sessionId」的消息。

### 7. G5 重连期收尾

- `useConnection` 重连成功回调：对所有 `isGenerating=true` 的 session 调 `markSessionError(sid, '连接已重置')`。不续传（runtime 重启上下文已丢）。
- 重连失败：退避上限后报错，不自动重试到死循环。

### 8. D8 Mock 下沉

- `VITE_MOCK` 从 `ws-client.ts` 移到 `createApiClient({ mock })`。
- mock 实现同一 `api` 接口，返回预制 Promise / emit 预制事件（业务语义，非协议字节）。

## 验证标准

- [ ] `npm run dev` 全功能正常（发消息/切模型/插件/配置/树导航）。
- [ ] `VITE_MOCK=true npm run dev` mock 模式可跑。
- [ ] 双主题无回归。
- [ ] `rg "from '../lib/ws-client'" renderer/src/composables/` 仅剩 useConnection（传输层合法），其余 7 个已清零。
- [ ] API Client 单测：command 超时、事件订阅/取消（refCount）、session 路由第 2 层丢弃。
- [ ] `npm run lint` 通过。

## 回滚

单阶段 commit。灰度并存设计保证：revert 后恢复 composable 直 send + ws-client mock。**禁止只迁一半 composable 就合并**（中间态混用）。

## 风险

| 风险 | 应对 |
|------|------|
| id 回填与现有 fire-and-forget 不兼容 | 向后兼容：广播/push 不回填；仅直接响应回填。未带 id 的请求仍按旧逻辑跑 |
| useChat 流式迁移遗漏事件订阅 | 最后做；迁完手测 streaming + abort |
| refCount 逻辑错导致事件翻倍/丢失 | 单测覆盖多实例订阅/取消场景 |
