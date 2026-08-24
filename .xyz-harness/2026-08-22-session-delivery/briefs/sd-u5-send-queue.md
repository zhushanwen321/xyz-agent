# sd-u5：session-manager send 排队（G1 主体）

## 前置

sd-u1-rpc-streaming-behavior 与 sd-u2-delivery-kernel 均已 closed（streamingBehavior 透传 + 内核包在 root 分支）。开工前 `cw status` 确认。

## 背景

design.md §5 U5 / §3.1 调用方 B / **D7 副作用处置表（逐项照办）** / §2.1 #5。现状：agent 调 `send_to_session` 遇目标 busy 收到 `{blocked: true, rejected: true}` 无重试指引（F4）。目标：send 排队——busy 时入队在下一 turn 边界注入，返回 `{queued: true}`；同时补 create 带 prompt 的工具 schema 暴露。

## 目标

1. **runtime 装配 + sessionId 单例注册表**（design.md §3.1 调用方 B 示例）：`getOrCreateDelivery(sessionId, factory)` 以 sessionId 为键单例（**本 unit 建立注册表，sd-u6 复用**——多 handle 并发竞态无保护，§3.4 约束）。装配参数：
   - `supportedPayloads: ['text']`（runtime 拿不到 custom message，D9）
   - `isIdle`: session 的 `!isGenerating && !isCompacting && !isBashRunning`（读 runtime 状态标志）
   - `hasPendingMessages: () => false`（一期保守，§5 待验证第 1 条）
   - `subscribeSettled`: 经组合根 onAgentSettled 多播（接线点 `packages/runtime/src/index.ts:372`，现为 flushPendingBashResults 单播——扩展为多播列表；或 rpc-client.onEvent 过滤 agent_settled，二选一以实现侵入最小为准）
   - `send`: port 内先 ensureActive 再 `client.prompt(content, {streamingBehavior: intent 映射})`，成功后置位 `isGenerating=true + lastActiveAt`、best-effort `workspaceService.record`（try/catch warn）
2. **`handleSend` 改造**（`packages/runtime/src/transport/session-manager-handler.ts`）：改走 delivery 的 `sendChecked`；返回 `{queued: true}`；失败同步返回 error + hint（`'target session unreachable; retry send_to_session after checking get_session_status'`）。
3. **`handleCreate` 初始 prompt 直投**（D7 末行）：不走内核队列（新 session 必 idle 无竞态）——port 层同款 ensureActive+prompt 直发，失败照旧 throw（外层 catch 组装恢复路径，session-manager-handler.ts:73-84 现状保持）。
4. **D7 六步骤逐项处置**（防静默绕过，design.md D7 表）：放弃 BeforeSend hook（agent 路径不过）；保留 ensureActive / isGenerating+lastActiveAt 置位 / workspaceService.record；替换 busy 预检拒绝与 send.rejected 错误广播（agent 路径失败不走前端 banner——sendChecked reject → select 通道返回错误+hint）。
5. **协议与工具 schema**（SSOT `packages/extension-protocol/src/extensions/session-manager/types.ts`）：SendResult `{blocked, rejected}` → `{queued: true}` + 错误形状；extension 侧工具 schema/description 同步改「asynchronously queued」语义。**API 签名变更 grep 全部消费方（runtime / extension / 测试 mock）逐一同步**——测试 mock 不同步会静默漂移。
6. **plugin-service 两处路径**（session-api.ts:209 / plugin-rpc-setup.ts:131）**保持 dispatcher 现状不变**（D7 声明，防误改）。

## 验收（designer 细化，挂钩 S1/S6）

- e2e-real（S1，本地 pi CLI）：父 session 挂 session-manager extension，`create_managed_session` 建 子 session + send 长任务 → streaming 期间 send 第二条 → 第二条返回 `{queued: true}`（**断言 busy 前提：长任务 run 中 get_state 确认 isStreaming=true 后再发第二条**——事件同步模式，禁止固定 sleep）→ 子 session 下一 turn 开头出现第二条内容（get_entries 验证）。
- unit 级：handleSend busy 排队路径（mock kernel port）；错误路径返回 hint；单例注册表同 sessionId 复用 handle；D7 置位副作用（isGenerating/lastActiveAt/workspaceService.record 在 port.send 成功后发生）。
- S6（桌面 pnpm dev）留 manual 或独立 gate——桌面场景涉及双 session UI 观察量大，可在 exec-review 说明由人工/后续验证，spec 声明覆盖方式。

## 约束

- runtime 测试 `cd packages/runtime && npx vitest run`；extension 三连 `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`（protocol types 变更影响两端）。
- 不改 MessageDispatcher 本体（U5 只改 session-manager 的调用点）；不动 scheduler/subagent-workflow。
- subscribeSettled 接线若与 sd-u6 冲突：本 unit 只做「多播机制」，sd-u6 挂订阅者。
