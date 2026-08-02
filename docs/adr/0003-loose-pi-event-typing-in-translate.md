# 0003: event-adapter translate() 不严格绑定 PiEvent 联合类型

## 状态

已推翻（见 ADR-0033）

## 上下文

`types.ts`（原 pi-rpc-types.ts）定义了 40+ 精确的 pi 事件类型（PiEvent 联合类型）。Spec 承诺 event-adapter.ts 的 `translate()` 入参改用 PiEvent 联合类型，使编译器做 exhaustive check。

实际实现发现：
- pi CLI 在运行时会发送 PiEvent 联合类型之外的事件类型：`compaction_*`、`auto_retry_*`、`extension_ui_response` 等
- 这些"额外"事件类型在 types.ts 的 PiEvent union 中没有定义，但 pi 确实会发出来
- 如果 translate() 入参严格绑定为 PiEvent，这些事件会在运行时被 TypeScript 类型系统认为"不可能"，但实际会到达

可选方案：
1. **严格绑定 PiEvent** — 在 switch 的 default 分支处理未知事件。但 TypeScript 的 exhaustive check 会认为 default 不可达，产生误导
2. **用 Record<string, unknown> 入参，switch 内部按已知类型分支** — 放弃编译期 exhaustive check，但运行时不会丢事件
3. **扩展 PiEvent 联合类型覆盖所有已知 pi 事件** — 最理想但需要持续维护，pi 每次更新都可能新增事件类型

## 决策

方案 2：translate() 入参为 `Record<string, unknown>`，switch 内部按 `event.type as string` 分支处理已知类型，default 分支返回 null（忽略未知事件）。

注释说明原因："translate() accepts Record<string, unknown> because pi sends event types beyond the defined union"。

## 理由

- 运行时安全优先于编译期类型安全。严格绑定可能导致未知事件类型被静默吞掉或运行时崩溃
- pi 是外部 CLI，其事件协议不完全由 xyz-agent 控制。pi 版本更新可能随时新增事件类型
- types.ts 的 PiEvent 联合类型仍有价值：作为文档和 rpc-client 的类型约束。只是不适合作为 translate() 的入参类型

## 后果

- 编译器不会在新增 pi 事件类型时报错（没有 exhaustive check）。需要在 pi 更新时手动检查 event-adapter 是否需要处理新事件
- rpc-client.ts 保留了自定义 PiMessage 接口（比 PiAnyIncomingMessage 更宽泛，覆盖 RPC 响应 + 事件），原因类似：pi 的实际消息格式比 types.ts 定义的更灵活
- 代码审查时这段设计需要口头解释，否则看起来像是"没做完类型绑定"
