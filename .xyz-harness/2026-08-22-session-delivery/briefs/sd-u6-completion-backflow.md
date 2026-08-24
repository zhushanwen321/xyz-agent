# sd-u6：session-manager 完成回流（G2 主体）

## 前置

sd-u1 / sd-u2 / sd-u5 均已 closed（U5 的 sessionId 单例注册表已建立，本 unit 复用）。开工前 `cw status` 确认。

## 背景

design.md §5 U6 / §3.1 调用方 C / §5 待验证第 2 条核实结论。现状：子 session（agent-managed）跑完任务无任何回流机制，父 agent 只能轮询 `get_session_status`（F5）。已核实：任务完成信号 = `agent_settled`（run 级联结束，子 session 完成后 pi 进程常驻 idle，「完成」≠进程退出）；检测点 = 组合根 `packages/runtime/src/index.ts:372` interpreter `onAgentSettled` 注入点（现为 flushPendingBashResults 单播，sd-u5 已扩展多播——若未扩展则本 unit 扩展）；`spawnSource`/`parentAgentSessionId` 在 session 内存态（`packages/runtime/src/services/session/session-lifecycle.ts:379-383` 打标）；进程 exit（`packages/runtime/src/infra/pi/process-manager.ts:367` `onSessionExit`）是另一信号。

## 目标

1. **终态检测**（组合根 onAgentSettled 多播处）：收到子 session 的 settled → 查该 session `spawnSource==='agent' && parentAgentSessionId` → 命中则回流。无父 id 的 agent session 完成不回流（跳过，session-lifecycle.ts:388 注释语义）。多条 run 多次回流 = 每次投递任务完成各回流一次（语义正确，§5 核实结论）。
2. **回流投递**：`parentDelivery.send({ payload: { kind: 'text', content: 通知文案 } })`——文案对齐 notifier buildLlmContent 模式：`Managed session "<label>" (<sid>) finished with status "<status>".\nFull transcript: <sessionFile>`（label/status/sessionFile 指针）。**复用 sd-u5 的 getOrCreateDelivery 注册表**（同一父 session 的 send 排队与回流必须同一 handle——单例约束）。status 来源：run 结束时 session 状态 + 最后 turn 是否 error（completed / failed，实施时以可得的运行时状态为准，在测试断言中固化语义）。
3. **失败回流**：进程 exit（onSessionExit，code/stderr 可得）对 agent-managed 子 session 同样回流（status: failed / exited，文案含退出信息）——pi 死了也要通知父 agent。
4. 父 session idle → 被唤醒开新 turn（prompt 主动唤醒，已实测）；streaming → steer 入队 turn 边界注入（已实测）。

## 验收（designer 细化，挂钩 S2）

- e2e-real（S2，本地 pi CLI）：父 session 挂 session-manager extension → create+send 短任务（如「执行 ls 并总结」）→ 等待 → **父 session 无人工输入自动开新 turn**，上下文含完成通知文案（label/status/`Full transcript:` 指针行；get_entries 验证）→ 父 session 下一轮回答能引用子 session 结果。
- unit 级：settled → 查标记 → 回流链路（mock parentDelivery 断言文案与 target）；无父 id 跳过；exit 失败回流；同父 session 复用单例 handle；多次 run 多次回流。

## 约束

- `cd packages/runtime && npx vitest run` 全绿；若触碰 extension-protocol 类型同步跑三连。
- 不动 notifier/scheduler；session-lifecycle 只读标记（打标逻辑已有），回流编排放组合根/handler 层（以最小侵入为准）。
- 回流通知一期纯 text 形态（D5：custom message 借道 marker 通道是二期，不实现）。
