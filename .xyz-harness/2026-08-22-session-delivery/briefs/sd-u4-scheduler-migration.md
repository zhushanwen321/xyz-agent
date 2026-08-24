# sd-u4：scheduler 切换内核（park 模式 + after-run 意图）

## 前置

sd-u2-delivery-kernel 已 closed。开工前 `cw status` 确认。

## 背景

design.md §5 U4 / §2.1 #2 / D4 busyPolicy 'park'。现状（`extensions/universal/scheduler/src/runtime.ts`）：`!ctx.isIdle() || ctx.hasPendingMessages()` 跳过延迟到下个 30s tick（runtime.ts:307-309）；`backend.sendMessage` 现配 `deliverAs:'followUp', triggerTurn:true`（runtime.ts:319）；force 任务绕过 gate 直投；`dispatchesInFlight` Map 防双派发；`await backend.sendMessage` 抛错驱动失败记账（标 failed；once 任务失败不删持久化 = at-least-once，runtime.ts:316-343）。

## 目标

1. **装配**：scheduler 的 backend 投递改走 `createDelivery`，config：`busyPolicy: 'park'`（busy 入队不重试，等 tick 外部重触发——内核 flush 由 scheduler 每 30s tick 调用，保持现状行为等价，避免 5s 强发提前注入正在进行的 run）、`intent: 'after-run'`（保持现状 followUp 语义）、`onSettled` 承接失败记账（rejected → 标 failed；once 任务失败不删持久化）。
2. **gate 段删**（runtime.ts:307-309 的 isIdle/hasPendingMessages 跳过逻辑交内核）；`dispatchesInFlight` **保留在调用方**（任务级防双派发与内核 in-flight 防重职责不同，D4 表去重行）。
3. **force 任务直投语义保持**：force 绕过排队直接投（现状绕过 gate——切换后 force 路径不进内核队列，直调 port 层发送或保持现有直投调用）。
4. 行为等价：到期唤醒（S4 场景）、双派发抑制、失败记账、at-least-once。

## 验收（designer 细化，挂钩 S4）

- e2e-real（S4，本地 pi CLI 挂 scheduler extension）：建 5s 后到期一次性任务 → session 自动开新 turn 收到任务 prompt（idle 唤醒路径）；同一任务 entries 中只出现一次（双派发抑制）。若做 busy 排队场景：到期时目标 streaming → 消息入队不重试 → 下个 tick flush 后注入（park 语义）。
- unit 级：park 模式行为（busy 入队后无内核内重试，tick 触发 flush 才投）；onSettled rejected → failed 记账 + once 不删持久化；after-run intent 传到 port.send；dispatchesInFlight 仍在调用方生效。
- 现有 scheduler 测试全绿（gate 行为变化会使部分测试语义迁移——更新测试以反映「gate 在内核」的新结构，但**行为断言等价**）。

## 约束

- `cd extensions/universal/scheduler && npx vitest run` + `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连过。
- 不动 notifier（sd-u3 已迁移）与 runtime。
- scheduler 的持久化机制不动（只改投递层）。
