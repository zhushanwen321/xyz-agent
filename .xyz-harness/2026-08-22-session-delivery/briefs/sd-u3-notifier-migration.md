# sd-u3：subagent-workflow notifier 切换内核（第一个消费者）

## 前置

sd-u2-delivery-kernel 已 closed（`@xyz-agent/session-delivery` 已在 root 分支）。开工前 `cw status` 确认。

## 背景

design.md §5 U3 / §3.1 调用方 A / §2.1 #1。notifier（`extensions/universal/subagent-workflow/src/execution/notifier.ts`）是竞态知识最全的投递实现（isIdle gate + FLUSH_BACKOFF 退避 + MERGE_WINDOW_MS=60s 滑动窗口合批 + runId 去重窗口 + shutdown flush + dispose 短路），sd-u2 的内核正是从它抽取的。本 unit 把 notifier 切换为内核消费者，验证内核抽象对最复杂场景的覆盖度（G4 零行为回归）。

## 目标

1. **装配**（subagent-workflow extension 装配处，按 design.md §3.1 调用方 A 示例）：
   - `createDelivery({ supportedPayloads: ['custom'], isIdle: () => ctx.isIdle(), hasPendingMessages: () => ctx.hasPendingMessages(), subscribeSettled: disposed 标志包装（pi.on 返回 void 无 off——design.md D8/must-fix #2 的包装模式照抄）, send: intent → {triggerTurn:true, deliverAs:'steer'|'followUp'} 映射 }`，config：`intent: 'interrupt-at-turn-boundary'`、`mergeWindowMs: 60_000`（滑动窗口）、`mergeHoldActive: () => host.hasRunningBackground()`（**禁止**用 isIdle 代替——D4 must-fix #1）。
   - 每 extension 实例一个 handle（单例约束）。
2. **notifier.ts 大幅瘦身**：私有 enqueue/gate/退避/合批/flush 逻辑删除，保留 `buildLlmContent` 等格式化职责在调用方（内核只拼接）；`notify()` 调用点改为 `delivery.send({ payload: {kind:'custom', customType:..., content: buildLlmContent(record), display: true, details} })`。
3. **行为等价**：busy 窗口合批、去重、退避达上限强发、shutdown flush、dispose 短路——全部经内核策略项表达（dedupe 按需开启；强发路径已实测安全，design.md §3.3 实测记录 P3'）。

## 验收（designer 细化，挂钩 S3）

- **golden 快照（本单元核心）**：迁移**前**先在当前 HEAD 固化 notifier 输出全文快照（单条 + 60s 窗口内两条合批各一）入 subagent-workflow 测试 fixtures（现有 notifier 测试的 mock 场景跑出全文落盘），迁移后 diff 逐字节一致。**快照固化必须在改 notifier.ts 之前完成并单独 commit**（红阶段依赖旧代码产出快照的时序——若 verify 红阶段在旧树重跑，快照生成命令必须旧树可跑）。
- 现有锚定测试（toContain/endsWith 关键行）不动、全绿。
- e2e-real（S3）：跑 subagent-workflow 现有后台通知 e2e（bg-notify 用例）+ 新增多任务合并场景（两个后台 subagent 60s 窗口内先后完成 → 一条合并消息，`---` 分隔、details 为 batch 结构）。e2e-sh 脚本输出 `<验收id> PASS|FAIL` 标记行。
- unit 级：装配映射测试（intent → pi 参数、mergeHoldActive 谓词接线）。

## 约束

- `cd extensions/universal/subagent-workflow && npx vitest run` 全绿 + 根目录 `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连过。
- extension 改动优先本地 pi CLI 实测（root brief 全局约束 7，驱动采事件同步模式）。
- 不动 scheduler / runtime / 其他 extension。
- API 若变（notifier 对外导出签名），grep 全部消费方含测试 mock 同步更新。
