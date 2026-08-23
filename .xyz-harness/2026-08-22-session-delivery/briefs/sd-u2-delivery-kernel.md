# sd-u2：内核包 @xyz-agent/session-delivery

## 背景

design.md（`.xyz-harness/2026-08-22-session-delivery/design.md`，**必读 §3.3 全部决策 D1-D9、§3.4 接口草案全文、§2.1 现有实现盘点、§2.3 失败模式 F1-F3**）。方案 A：packages 层策略内核 + 窄端口注入，把散落 5 处的投递竞态知识（idle 判定同步链 / busy 按意图入队 / in-flight 防重 / steer-vs-followUp 实战结论 / 退避 / 合批 / flush）收敛为一份带单测的实现。

## 目标

新建 `packages/session-delivery/`（与 packages/extension-protocol 平级，结构参照该包与 packages/shared 的 workspace 模式：package.json + tsconfig + vitest.config.ts + src/ + tests），实现 design.md §3.4 的接口（**以 §3.4 为契约基线，逐字段落实**）：

- `DeliveryIntent` / `DeliveryPayload`（判别联合 text|custom）/ `DeliveryMessage` / `DeliveryPort` / `DeliveryConfig` / `DeliveryHandle` / `createDelivery(port, config?)`。
- 策略默认值严格按 §3.3 D4 表（busyPolicy 默认 'retry-force'（settled 边沿驱动 flush + watch-dog 30s 复核；无 subscribeSettled 装配退化退避 {100ms, 50}≈5s 后强制发送）、mergeWindowMs 默认 0、合批拼接 `"\n\n---\n\n"` + details 包装 `{batch: true, items}`、dedupe 条数 LRU maxKeys、send() 单一常规入口、sendChecked 同步确认变体、flush/dispose）。
- **抽取而非重写**：enqueue/gate/合批/flush/退避骨架从 `extensions/universal/subagent-workflow/src/execution/notifier.ts` 抽取（该文件是竞态知识最全实现：isIdle gate + FLUSH_BACKOFF 退避 + MERGE_WINDOW_MS=60s 滑动窗口合批 + shutdown flush + dispose 短路）。**先读 notifier.ts 与其测试**（notifier 相关测试文件在 `extensions/universal/subagent-workflow/src/__tests__/` 或同包测试目录，以 find 为准），搬迁测试用例即继承 F1/F2 教训。

## 必测清单（unit 级，vitest fake timers，fullName 含验收 id）

1. **搬迁**：notifier 现有 flush/退避/合批测试场景改写为内核测试（gate 拒绝→退避重试→达上限强发；合批窗口滑动重置；dispose 短路；flush 强制投递）。
2. **intent 映射契约**：config.intent 缺省回落 'interrupt-at-turn-boundary'；msg.intent 覆盖 config.intent；port.send 收到的 intent 参数正确。
3. **subscribeSettled 事件驱动路径**：busy 入队 → settled 回调 → isIdle 复核 true → flush；复核 false → 不 flush 留队（等下轮 settled）。
4. **watch-dog**：settled 丢失场景下 30s 复核恢复（fake timers 快进）。
5. **payload 能力 fail-fast**：supportedPayloads 不含 'custom' 时 send/sendChecked custom 消息同步 reject（sendChecked reject / send 记 warn 不 throw）。
6. **mergeHoldActive 谓词**（D4 must-fix #1 语义）：谓词 true 走合批窗口、false/缺省立即投；**禁止** isIdle 参与立即投判定（测试锁：isIdle=true + mergeHoldActive=true 时仍走合批）。
7. **in-flight 防重**：单 handle 至多一个 flush 在途（send 入队 → flush 中 → 再 settled 边沿不并发 port.send）。
8. **sendChecked**：resolve=入队且 port.send 成功；port.send 抛错 reject；busy 排队时（gate 拦截）行为按「入队成功 + 异步终态」resolve（对照 §3.4 语义：reject = 入队失败）。
9. **onSettled 终态信号**：delivered / rejected 两种回调路径。
10. **dedupe**：同 dedupeKey 二次 send 被吞；maxKeys LRU 挤出。

## 约束

- **零 pi 依赖**：不 import pi 包任何符号；steer/followUp/triggerTurn/streamingBehavior 字样不得出现在内核 src（README 讲清「pi 词汇封闭在适配器」的边界）。
- 内核无 timer 依赖以外的全局状态；所有定时行为可被 vitest fake timers 驱动（§3.4 约束）。
- **README + JSDoc 写明**：同 session 必须单例 handle（多 handle 并发投递竞态无保护）；subscribeSettled 的退订语义由适配器负责兑现（extension 侧 disposed 包装模式见 design.md §3.1 调用方 A）。
- **runtime 打包核实**：runtime 后续会 import 本包——查 `packages/runtime` 的 tsup.config.ts 现有对 packages 层包（@xyz-agent/*）的处理方式（noExternal 还是 workspace 引用），保持一致并在 PR/commit 说明结论；`apps/electron` 打包如有独立清单同步核对。
- 本 unit 不改 notifier.ts / scheduler / runtime 任何现有代码（消费者单元 sd-u3/u4/u5/u6 才动）——纯新增包。
- 测试从包目录跑：`cd packages/session-delivery && npx vitest run`；通过后 `cd packages/runtime && npx vitest run` 确认无破坏（应零影响）。

## 验收要求（建议，designer 可细化）

全部 unit 级（本包无真实进程交互，e2e 留给消费者单元）；core 验收选 3/5/6/7（事件驱动路径 / fail-fast / mergeHold 语义 / in-flight 防重）中最能锁行为的组合，type 声明为 e2e-mock 不可——纯包单测请全部声明 unit/integration，core 的 e2e-real 覆盖由 sd-u3/u5 的 S3/S1 场景承担（root spec 的 S 场景挂在对应消费单元）。

## 完成定义

- `cd packages/session-delivery && npx vitest run` 全绿；`pnpm extensions:typecheck` 不受影响（本包不在 extensions/，但若把它加进了某个 tsconfig project 引用则相应跑通）。
- git commit（如 `feat(session-delivery): extract delivery kernel package from notifier`）。
