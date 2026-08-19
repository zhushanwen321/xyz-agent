# W3 验收基线：wire 层修复（tool-call-index + 协议 select 类型）

> 防篡改：本文件是 W3 验收 SSOT，builder/verifier 禁改。设计依据 = `docs/architecture/pi-assumption-remediation.md` §3.3 + D3 降级分支；证据 = 审计 A-01 / A-05。

## pi 语义锚点（已核实）

- `toJsonEvent`（`node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js:3-15`）对 message_update 只输出 `{type, assistantMessageEvent}`（partial 字段也被剥离）——顶层 `message` 字段不存在于 wire。
- select options 实为 `options: string[]`（`dist/core/extensions/types.d.ts:70`）。
- **待 builder 实调查**（首步，决定实现或降级）：真实 pi 事件流中 `assistantMessageEvent` 对 ToolCall part 的 start/delta/end 形态——ToolCallStartEvent 是否携带 `contentIndex` 与 part.id（读 `dist/core/agent-session.js` 的 AssistantMessageEvent 发射点 + 真实 pi 实测事件流抓包）。

## 交付物

1. **tool-call-index 修复（或降级）**：
   - 路径 a（实现）：从 `assistantMessageEvent` 提取 toolCallId + contentIndex，event-adapter.ts:111-125 改造为真实字段源；**mock 测试同步改为按真实 wire 形态构造**（消除「mock 自带 message 字段」自欺）；新增真实 pi 事件流锁定测试（等价测试先例：`src/__tests__/equivalence/`，spawn 真实 pi 跑一轮含工具调用的对话断言 tool-call-index 产出）。
   - 路径 b（降级，需证据）：若调查证实 wire 层不可得 toolCallId（pi 未暴露），删除死机制 + 消费方清理 + 在 pi-protocol.ts 登记 pi 能力缺口（附 dist 锚点），报告显式选定并给证据。
   - 两路都须更新 A-08 注释（user message_start 时序 0.84.1 实态——W2 移交项）。
2. **pi-protocol select 类型**：`options: string[]`（附 types.d.ts:70 锚点）；消费方适配（ask-user 的 select 渲染——label=value；grep 全部 `\.options` 消费点逐一核对，与 W4 的 ask-user isError 改动不同文件不同函数可并行，merge 时注意）。
3. 协议文件相关既有测试更新。

## 验收条款

| # | 条款 | 证伪点 |
|---|------|--------|
| C1 | 调查结论附 dist 锚点（assistantMessageEvent 形态逐字段），实现或降级与结论一致 | 报告 + 源码 |
| C2 | 路径 a：真实 pi 驱动的 tool-call-index 产出测试绿；mock 按真实 wire 形态构造（grep mock 无顶层 message 字段残留） | 测试实跑 |
| C2' | 路径 b：死机制删除干净（grep tool-call-index 消费方零悬空）+ 缺口登记 | 源码 |
| C3 | select 类型 string[] + 消费方适配 + 类型检查绿 | 命令 |
| C4 | `cd packages/runtime && pnpm typecheck && pnpm exec vitest run` 全绿；R1 exit 0；lint 零 error | 命令 |

## 边界

- 只许改：`packages/runtime/src/infra/pi/event-adapter.ts`、`pi-protocol.ts`、select 消费方（ask-user 等的**渲染/类型适配行**，不动其 execute 逻辑——那是 W4）、`src/__tests__/equivalence/` 新测试、既有相关测试。
- 禁碰：session-lifecycle/process-manager 值域行（W2）、pi-provider 域（W1b）、extensions 的 isError 改动（W4）、core（W5）。
- 禁 git 写；真实 pi 探针隔离（/tmp + 隔离 dirs），用后清理。
