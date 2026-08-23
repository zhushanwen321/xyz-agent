# Root：Session 消息投递层统一（delivery kernel）实施

## 权威设计文档

`.xyz-harness/2026-08-22-session-delivery/design.md`（相对仓库根；绝对路径 `/Users/zhushanwen/Code/xyz-agent-workspace/feat-firstmate-new-session/.xyz-harness/2026-08-22-session-delivery/design.md`）。

该设计已经过两轮对抗式审查（0 must-fix，报告在同目录 review-report.md / review-report-2.md），pi 侧投递原语行为已真机探针实测（probes/ 目录，结论内嵌 §3.3 实测记录）。**实施以该文档为准，接口以 §3.4 内核接口草案为契约基线。**

## 目标

统一 5 处独立投递实现的知识为 packages 层策略内核 `@xyz-agent/session-delivery`，并交付两个新场景：session-manager send 排队（G1）与子 session 完成回流（G2）。设计目标 G1-G4 见 §1。

## 拆分（叶子 unit，本树共 6 个）

| unit id | 内容 | design.md 锚点 | 验收挂钩 |
|---|---|---|---|
| sd-u1-rpc-streaming-behavior | RpcClient.prompt 补 streamingBehavior 透传 | §5 U1 | S1 前置 |
| sd-u2-delivery-kernel | 内核包 @xyz-agent/session-delivery | §5 U2 / §3.3 / §3.4 | S5 |
| sd-u3-notifier-migration | subagent-workflow notifier 切换内核 | §5 U3 | S3 |
| sd-u5-send-queue | session-manager send 排队 | §5 U5 / D7 | S1, S6 |
| sd-u4-scheduler-migration | scheduler 切换内核（park + after-run） | §5 U4 | S4 |
| sd-u6-completion-backflow | session-manager 完成回流 | §5 U6 | S2 |

（U7 workflow helpers / compact 队列 / goal 迁移是评估项，不在本树——U3/U4 落地后另行评估。）

批次依赖（cw 无叶间依赖声明，靠分批创建保证）：sd-u1 + sd-u2 并行 → sd-u3 + sd-u5 → sd-u4 + sd-u6。后批 unit 开工时前批已 closed 且代码已 merge 回 root 分支。

## 全局硬约束（所有 unit 的 developer 必须遵守）

1. **[MANDATORY] 不修改 pi 源码、不 fork**（node_modules/@earendil-works/pi-coding-agent 只读；pi 语义断言权威源 = 实装 dist JS）。
2. **内核零 pi 依赖**：`packages/session-delivery` 不 import 任何 pi 类型/符号；steer/followUp/triggerTurn/streamingBehavior 等 pi 词汇只允许出现在两侧适配器（extension 装配 / runtime 装配）内（design.md D2/D3）。
3. **同 session 单例 handle**：持有 per-session 状态的装配必须以 sessionId 为键单例注册；此约束写进包 README 与 JSDoc（design.md §3.4 末尾约束）。
4. **vitest（禁 node:test / tsx --test）**，配置在各子包 vitest.config.ts，**从子包目录运行**（monorepo testCwd 坑：验收 command 必须形如 `cd <子包目录> && npx vitest run <file>`——`npx vitest` 不带 run 会进 watch 挂死）。
5. **测试三视角**（构建者白盒 + 使用者黑盒 + 观察者形态，TEST-STRATEGY.md §3）；timer 测试用 fake timers（内核无全局 timer 依赖，vitest fake timers 可测是 §3.4 明确约束）。
6. **完成即提交**：每 unit 改完验证通过后 git commit（英文 conventional），禁留脏工作区；禁 `--no-verify`。
7. extension 改动的验收优先本地 pi CLI 实测（`pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <path>` + stdin JSONL）；桌面侧 `pnpm dev`。真机驱动采 `.xyz-harness/2026-08-22-session-delivery/probes/probe-p3.mjs` 的**事件同步模式**（waitUntil 事件边沿，禁止固定 sleep），streaming/busy 前提必须结构化断言（design.md §4 驱动纪律）。
8. TS 分包边界：runtime 源码禁 `import.meta.url`（CJS bundle 失效）；新增 runtime 依赖同步 tsup.config.ts `noExternal`（本任务内核包在 packages/ 层、被 runtime import——需确认是否加 noExternal，见 sd-u2 brief）。
9. 提交前跑受影响范围的检查：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`（extension 侧）/ `cd packages/runtime && npx vitest run`（runtime 侧）。

## spec 验收用例撰写注意（designer）

- 验收 id 字符集：字母数字开头，后续可含 `.` `_` `-`（禁空格中文）。
- vitest 名字级比对：测试 fullName（describe+it 拼接）必须以词边界包含验收 id。
- e2e-real 用 e2e-sh 适配器：脚本输出 `<验收id> PASS|FAIL` 标记行，exit code 与标记行一致；禁止「一次 vitest 全绿给所有验收打 PASS」的 wrapper（红阶段拦截恒绿）。
- core 验收必须 e2e-real / e2e-mock；至少一条 unit 级。
- S3 的 golden 快照：迁移前先固化 notifier 现有输出全文快照入 fixtures（`extensions/universal/subagent-workflow` 测试目录），迁移后 diff。
