# W3 验收报告：wire 层修复（tool-call-index 提取点 + 协议 select 类型）

> Verifier 对抗式独立验收，2026-08-20。验收基线 = 本目录 `w3-acceptance.md`（commit d48793a39）。
> **总结论：PASS**（C1/C2/C3/C4 全过；红性成立；无越界；2 项备注，0 阻塞）。

## 一、总结论

| 条款 | 结论 | 关键证据 |
|------|------|----------|
| C1 调查结论附 dist 锚点、实现与结论一致 | **PASS** | verifier 独立读 dist 源码逐字段核实全部锚点（见 §二）；实现（toolcall_end 提取）与调查结论一致 |
| C2 真实 pi 驱动测试绿 + mock 按真实 wire 形态 | **PASS** | 定向 `tool-call-index.test.ts` 7/7 绿（3 mock 凭证无关 + 4 真实 pi 子进程实跑 8.96s）；verifier 独立探针复核 wire 形态 5 项全证实（见 §二）；grep 无 mock 顶层 message 残留 |
| C3 select 类型 string[] + 消费方适配 + 类型检查绿 | **PASS** | `PiExtensionUiRequestEvent.options: string[]`（types.d.ts:70 锚点属实）；runtime/renderer/shared 全消费点核实（见 §五）；`pnpm typecheck` exit 0 |
| C4 全量绿 + R1 exit 0 + lint 零 error | **PASS（附备注）** | 全量 288 files / **3222 tests 全绿**（与合并态基线一致）；R1 exit 0（240 文件扫描通过）；lint 唯一 error 在 `chat-app/`（并行豁免领地、untracked、非 W3 引入），W3 三文件单独 eslint 零 error |

**红性验证（机制敏感性）**：verifier 临时把提取点退回 W3 前旧路径（`event.message?.content?.[contentIndex]?.id`）→ 定向测试 **3 用例红**（mock 提取用例、全链路用例、真实 pi 产出用例 `tool-call-index 真实产出：translate(真实 toolcall_end) 产出锚点事件`）→ 字节还原（md5 前后一致 `1975d2d1…`，diff stat 与初始相同）→ 还原后 7/7 复绿。真实用例对提取点敏感，非恒绿摆设。

## 二、wire 形态独立复核表（核心）

Verifier 双通道独立复核：**通道 1 = dist 源码逐行读**（node_modules `@earendil-works/pi-coding-agent@0.84.1` + `pi-ai@0.82.1` + `pi-agent-core`）；**通道 2 = 独立 spawn 真实 pi 探针**（verifier 自写脚本 `/tmp/w3-verify/probe.mjs`，`pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve`，cwd=tmp 隔离，发含 bash 工具调用 prompt，抓 57 行 stdout JSONL；非 builder 测试复跑）。探针已清理。

| # | builder 声称 | dist 源码核实 | 独立探针实测（56 流事件，32 message_update） | 结论 |
|---|-------------|--------------|----------------------------------------------|------|
| 1 | message_update wire 恒无顶层 message（toJsonEvent 剥离） | `dist/modes/json-event.js:3-15`：message_update 只输出 `{type, assistantMessageEvent}`（0.84.1）/ `{type, usage, assistantMessageEvent}`（全局 0.84.2），两版均无 message；RPC 转发点 `dist/modes/rpc/rpc-mode.js:266 output(toJsonEvent(event))`；内部事件确带 message（`agent-session.js:473-479`）——旧声明误读源 | 32/32 message_update 顶层字段全集 = `{type, usage, assistantMessageEvent}`，**0 个含顶层 message** | **证实** |
| 2 | toolcall_start wire = `{type, contentIndex}` 无 id（partial 被剥离） | pi-ai `types.d.ts:397-400`：toolcall_start 声明 `{type, contentIndex, partial}`，id 只在 `partial.content[contentIndex].id`；toJsonEvent 剥 partial | 样本 `{"type":"toolcall_start","contentIndex":1}`——无 id、无 toolCall | **证实** |
| 3 | toolcall_end 携带完整 toolCall（非 partial 字段不被剥离） | pi-ai `types.d.ts:405-409`：toolcall_end `{type, contentIndex, toolCall: ToolCall, partial}`；ToolCall = `types.d.ts:244-250` `{type:'toolCall', id, name, arguments, thoughtSignature?}`；toolCall 是独立字段，剥 partial 后保留 | 样本 toolcall_end = `{type, contentIndex:1, toolCall:{type:'toolCall', id:'call_b6e0e636d9674f809745d9ca', name:'bash', arguments:{command:'echo W3-VERIFY-PROBE .'}}}` | **证实** |
| 4 | toolcall_end.toolCall.id 与后续 tool_execution_start.toolCallId 同值 | （pi-agent-core agent-loop 语义） | 同一轮实测：两处均 `call_b6e0e636d9674f809745d9ca`，配对 true | **证实** |
| 5 | toolcall_end 恒早于 tool_execution_start | （assistant message 流完成才执行工具） | 首个 toolcall_end idx=26 < 首个 tool_execution_start idx=28（中间隔 message_end）| **证实** |

**A-08 注释锚点核实**（agent-loop.js，`@earendil-works/pi-agent-core/dist/agent-loop.js`）：
- user message_start 在 runAgentLoop 入口循环：`:52 emit message_start{prompt}`（52-54 区间）✓
- steering/pending 注入 turn 边界：`:98 emit message_start{message}`（96-103 区间，builder 引 :95-99）✓
- turn 末尾发的是 toolResult 非 user：`:550 emit message_start{toolResultMessage}`（emitToolResultMessage）✓
- 探针实测 message_start role 序列 = `user → assistant → toolResult → assistant`，与注释的事件序描述吻合 ✓

## 三、行为级证据（机制复活）

verifier 用**自己的探针 56 事件**（非 builder mock 样本）驱动生产代码全链路（tsx 直跑 `translate` + `EventInterpreter`）：

```
[translate] toolcall_end 数: 1 → tool-call-index 数: 1
[translate] 锚点事件: [{kind:'tool-call-index', toolCallId:'call_b6e0e636d9674f809745d9ca', contentIndex:1}]
[translate] tool_execution_start ids: ['call_b6e0e636d9674f809745d9ca'] | 配对: true
[全链路] tool_call_start 帧存在: true | entry.contentIndex: 1 | entry.toolCallId: call_b6e0e636d9674f809745d9ca
BEHAVIOR-PASS
```

W3 前旧路径在同样输入下 toolCallId 恒 undefined（红性测试复现），W3 后真实事件流驱动下 `tool-call-index` 真实产出且 `message.tool_call_start` WS 帧的 `entry.contentIndex` / `entry.toolCallId` 正确——机制复活直接证据成立。

## 四、mock 自欺消除核查

- `PiMessageUpdateEvent` 接口体 grep `message` 仅命中注释（wire 形态说明），**无 message 字段声明**；新增 `usage?: PiUsage`（wire 实测 32/32 有 usage，声明合理）。
- 全 runtime `type: 'message_update'` mock 构造点仅 2 处：`tool-call-index.test.ts`（照抄探针 wire 形态，无顶层 message）+ `event-adapter-delta.test.ts:18-20`（`{type, assistantMessageEvent}` 构造器，无 message）。**无旧形态残留**。
- 新测试含「旧 bug 回归锚」用例：wire 形态 toolcall_start 断言 noop（若实现退回 event.message 提取即红——红性实测已证）。

## 五、select 消费方独立复核

`.options` 全消费点 grep（runtime src + renderer src）：

| 消费点 | 形态 | 核实 |
|--------|------|------|
| `event-adapter.ts:478`（ASK_USER_MARKER 分支） | `JSON.parse(String(rawOptions[0]))`——options[0] 是 JSON payload | string[] 语义 ✓ |
| `event-adapter.ts:515`（普通 select 分支） | `rawOptions.map(String)` 透传 | string[] 语义 ✓（[HISTORICAL] 注释如实记录旧 .map(o=>o.label) 坏点） |
| `renderer useExtensionUI.ts:92` | `options as string[]` | ✓ |
| `renderer extension-host-dialog.ts:49 normalizeOptions` | 双形状归一（string→label=value；{label,value} 对象透传——兼容 plugin 源），有测试覆盖（`extension-host-dialog.test.ts:74-87`） | ✓ |
| `shared/protocol.ts:822` | `options?: string[]` | 与 runtime 声明一致 ✓ |
| 其余 `.options` 命中 | RpcClient 构造配置 / plugin-service / skill-registry / TerminalView 等 | 与 pi select 无关 ✓ |

**ask-user「不消费 pi select」判定复核**：ask-user 走 `askUserInteract`（`@xyz-agent/extension-protocol`，`extensions/ask-user/src/channel-handler.ts`）——复用 select 通道 + ASK_USER_MARKER 契约，options[0] 是序列化 `{questions, allowCancel}` JSON 载体而非选项语义；event-adapter 的 ASK_USER_MARKER 分支 parse 后不再透传 options 字段，前端 AskUserOverlay 消费 `askUserQuestions`。判定属实：ask-user 不按普通 select options 语义消费，W3 类型改动对其无影响（其改动文件在 W4 领地，无交叉）。

## 六、防篡改与越界

- **基线防篡改**：`.xyz-harness/2026-08-20-pi-assumption-remediation/acceptance/w3-acceptance.md` 未被修改（工作区 diff 中无该文件；git status 该文件无 M 标记）。
- **越界检查**：W3 自报清单 = `event-adapter.ts` / `pi-protocol.ts` / 新建 `src/__tests__/equivalence/tool-call-index.test.ts`——三者均在 W3 允许边界内。工作区其余修改逐一归属：`extensions/` 22 文件（W4 领地）、`packages/shared/*` + `session-lifecycle.ts` / `process-manager.ts` + `packages/runtime/test/skill-paths.test.ts`（PI_THINKING_LEVELS mock 行，W2 值域配套）+ `session-lifecycle-thinking.test.ts` / `pi-default-prompt.test.ts` 新建（W2 配套测试）、`chat-app/`（豁免）。**无 W3 越界**。
- verifier 全程零 git 写操作；红性测试的临时改动已字节还原（md5 一致）。

## 七、命令实跑记录

| 命令 | 结果 |
|------|------|
| `cd packages/runtime && pnpm typecheck` | exit 0 |
| `pnpm exec vitest run src/__tests__/equivalence/tool-call-index.test.ts` | 7/7 绿（真实 pi 用例实跑，非 skip——总时长 9.11s） |
| `pnpm exec vitest run`（全量） | 288 files / **3222/3222 绿**（35.45s，与合并态基线一致） |
| `python3 .githooks/check_pi_direct_write.py`（R1） | exit 0（240 文件，allowlist 命中 0） |
| 根 `pnpm run lint` | 1 error 497 warnings——唯一 error 在 `chat-app/src/components/ChatHistory.tsx`（豁免领地）；W3 三文件单独 eslint 0 error |
| 红性（临时旧路径 → 定向 → 还原） | 3 failed（含真实用例）→ md5 还原 → 7/7 复绿 |

## 八、备注（非阻塞）

1. **「实测 0.84.1」表述与实跑版本**：builder 注释/测试头写「pi 0.84.1」，但 fixture 与 verifier 探针实际 spawn 的是全局 `which pi` = **0.84.2**（项目依赖 node_modules 是 0.84.1）。verifier 同时核实了两版：0.84.1 dist 源码（toJsonEvent 无 usage 输出）+ 0.84.2 实测（wire 带 usage）——核心结论（顶层无 message / partial 剥离 / toolcall_end.toolCall 保留）**两版一致**，类型声明 `usage?` 可选字段兼容两版，无实质影响。生产 spawn 同样走 `which pi`（process-manager 同款探测），实态即 0.84.x 全局版。
2. **pi-protocol 注释引 `json-event.js:3-15`**：该文件实际 14 行，区间引用成立；`agent-session.js:473-479` 锚点精确。

## 九、verifier 探针清理确认

`/tmp/w3-verify/`（probe.mjs / probe-events.jsonl / event-adapter.ts.bak 等）与 `/var/folders/.../w3-verify-*` pi 临时 session 目录均已删除（ls 确认不存在）。fixture 测试自身的 `/tmp/pi-equiv-*` 由其 dispose 生命周期管理。
