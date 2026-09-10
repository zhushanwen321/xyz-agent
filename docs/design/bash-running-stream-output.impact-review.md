# 影响面审查报告：bash-running-stream-output.md

> 审查人：tech-design-impact-review（专审 P0-12 副作用/遗漏、P0-19 宿主投影面、P0-20 已接受代价量化）。
> 事实核实方式：全部结论均 `read`/`rg` 源码核实，非推测；涉及文件与行号随条目附上。

## Summary

2 must-fix, 4 suggestions.

四个指定核查面（detail 消费方 / output 消费方 / WS 中间层 / mock 链路）中，mock 链路与 protocol 占位桶结论与文档一致（核实通过）；WS stream ring 内存放大与回归面表格的 subagent 事实依据两处存在实质问题；另有一处接管点语义变更未声明（降级 suggestion）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §6.4（D4 被否「running 态加截断」）/ §4「WS 契约安全性」 | P0-20 + P0-12 | **stream ring 帧放大未量化**：`message.tool_call_update` 是 stream 类消息，**入可回放 ring**（`packages/runtime/src/services/message-bus/message-bus.ts:78`，`DEFAULT_RING_CAPACITY = 1000` 帧不看字节）。设计只量化了 pi 侧单帧上界（50KB @100ms，已核实 `pi/dist/core/tools/truncate.js:10-11`），但新增 output 后**每帧 payload 从几十字节的 detail 膨胀到最多 50KB，ring 满载保留 1000 帧历史（非仅最新）→ 单 session 最坏 ~50MB 常驻内存**；且长 bash（>100s 持续输出 @10fps）会把主对话流的可回放帧整体冲刷出 ring——重连时 `fromSeq < ring 最旧 seq` 判 gap → 全量回放，subscribe snapshot 直接把 ring 内全部帧（最坏 50MB）作为一个 WS 消息发出。项目自己已在 `message-bus.ts:64` 对 subagent 高频帧声明过同款风险（「高频帧会冲刷主对话流的可回放 ring，制造主流 gap」）并刻意不入 ring，本设计未做对称分析。恢复路径（gap → 全量重拉 + 幂等 dispatch，`session-message-handler.ts:559-589`）存在，但**量级（ring ×1000 保留 ×50MB 内存 / 重连 snapshot 体积）与重审条件未量化**——D4 的「成本有界」结论只覆盖了 pi 单帧上界，未覆盖 WS ring 放大 | §6.4 补 ring 维度的代价四要素：量级（ring 容量 × 帧上界换算）、恢复路径（已存在，引用 session-message-handler gap 逻辑）、重审条件、显式判定；如不可接受，备选 = adapter 对 update 帧 output 做 ring 侧瘦身（如超阈值截断 + truncated 标记）或评估该 topic 是否该降级为类 transient 语义 |
| MUST_FIX | §7「回归面核对」表第 1 行（subagent 进度） | P0-12 | **回归面表格的事实依据与源码矛盾**：表格断言「扁平 progress 对象无 content 数组 → 判别式不产出 output，detail 语义原样」，即 subagent 进度以扁平对象形态流经 `tool_call_update.detail`。核实结果：① 生产端 subagent 工具的 onUpdate 投影已删除且是**恒 undefined 的死路径**（`packages/subagent-core/src/execution/subagent-service.ts:2260-2264` 注释明示「三调用点恒 onUpdate: undefined，仅测试触达」；`extensions/universal/subagent-workflow/src/interface/subagent-tool.ts:301` `_onUpdate` 未消费）——即今天 subagent 块 running 态根本没有 tool_call_update 帧；② 更关键：subagent 工具的 onUpdate **签名就是 `AgentToolResult<SubagentToolResult>`**（`subagent-tool.ts:43`）——content 数组形态，正是判别式**会**命中并产出 output 的形态。该签名一旦复活（注释自述「git 历史可完整恢复」），running 态 `tool.output` 会被写入中间快照文本，而 `BlockSubagent.vue:108` 用 `JSON.parse(props.tool.output)` 提取 subagentId（running 早期 parse 失败本就是 no-op 预期分支，点击安全性不受影响，但「detail 语义原样、output 不产出」的表格结论不再成立）。设计把「判别式对 subagent 安全」的核心论据建立在一个与源码相反的形态断言上 | 修正回归面表格：如实登记「subagent onUpdate 生产死路径（引用 subagent-service 注释）+ 签名为 content 形态、复活时会命中判别式产出 output」；如需防御，在 §9.3 待验证清单加一条「subagent onUpdate 复活时的 output 污染复查项」 |
| SUGGESTION | §7 U2 代码 | P0-12 | **detail 写入语义从「无条件覆盖」静默变「条件写入」**：现行 registry 是 `{ ...c, detail }` 无条件 spread（`registry.ts:678-682`）——update 帧缺 detail 会清空旧值；设计的 U2 改为 `...(detail !== undefined && { detail })`——缺 detail 时保留旧值。这是接管点的语义变更未声明。实测影响低（生产端 adapter 恒发 detail 字段、mock 恒发 string detail、GUI streaming fallback 又被 Block.vue:434-437 的 running-only 条件门控），但「改动不触碰的部分」应如实声明 | U2 要点里补一句该语义差异及为什么安全（或保持现行为：`detail` 无条件写） |
| SUGGESTION | §5.1 / §8.2 | P0-12 | **useToolMeta 的「N 行」计数在 running 态会提前出现**：`useToolMeta.ts:48-55` 从 `tool.output` 自算行数（OUTPUT_META_TOOLS 含 bash），且 meta 条渲染在展开容器内（Block.vue bash meta 条 `v-if="isBashTool && filteredMetaItems.length"`）——修复前 running 态展开区整体不渲染、计数不可见；修复后展开期间会显示实时增长的「N 行」。行为上属顺带收益且无害，但属未声明的用户可见变化，建议在 §5.1 终态图或回归面表格登记，避免实施期被当回归报 bug | §5.1/§7 回归面表补一行说明 |
| SUGGESTION | §4 修复后数据流图（Block.vue 行） | P1-8（INFO 交接主审） | 流程图写「displayContent = output → 有值 → 展开区渲染（AnsiText 着色 / 纯文本）」，但 Block.vue 实际渲染序是 `AnsiText v-if="outputRaw"` → `parsedJsonOutput` → `displayContent`（Block.vue:161-165）：outputRaw 仅含 ANSI 时产出，running 纯文本输出走 displayContent span；且 running 态 partial JSON（cw 命令流式 stdout，代码注释自述高频场景）每次快照都会进 `JSON.parse` 尝试（失败回 null，computed 缓存下开销小）。不影响方案成立，表述精度问题 | 流程图该行改为三段回退的真实渲染序 |
| SUGGESTION | §6.1 判别式说明 | P0-12（INFO） | 「string 形态与扁平 progress 形态（无 content 数组）保持 detail 语义不变——否则 subagent 扁平进度对象 `{currentTool, turn, tokens}` 会被 JSON.stringify 污染」：全仓 grep 未找到任何生产端发出该扁平形态（extensions 内唯一 partialResult 引用是 subagent-tool.ts:43 的签名声明）。判别式方向正确，但该例证当前无真实生产者，与 MUST_FIX #2 同源 | 与 MUST_FIX #2 一并修正例证的真实来源 |

## 核查面记录（通过项）

- **WS payload 中间层**：`message.tool_call_update` 在 `shared/protocol.ts:780` 仅登记 type 名，payload 走 `Record<string, unknown>` 占位桶（protocol.ts:1695-1697 已核实）——增字段零类型破坏，文档结论成立。message-bus 仅按 topic 分类（stream：分配 seq + 入 ring，payload 整体透传、无字段白名单）；`message.text_delta` 等才是 transient。ws-client / event-bus 为通用透传，无字段过滤。**注意 stream 入 ring 正是 MUST_FIX #1 的来源**。
- **mock 链路**：`run-send-stream-branches.ts:86` 核实只发 `{ toolCallId, detail: "读取 42 行" }`，output 字段缺省 → registry 条件写入不触发；`readString` 对非字符串返回 undefined，畸形帧天然降级。文档结论成立。
- **output 其他消费方**：`tool.output` 的 UI 消费方仅 Block.vue / BlockSubagent.vue / useToolMeta（见上）；core 侧 apply-entry / apply-entry-convert / truncate-tool-output 全部只作用于 end 路径持久化 entry，running output 不落盘，live ≡ reload 等价性论证成立（BlockSubagent 的 output JSON parse 见 MUST_FIX #2 说明，当前无影响）。
- **detail 其他消费方**：`extractGui` 消费 `tool.details`（end）与 running 态 `tool.detail`（Block.vue:431-437），adapter 的 detail 语义设计保持不变，GUI 双源提取不受判别式影响。
- **P0-19 宿主投影面**：本设计不写宿主 DB / OS 全局状态 / 第三方服务；唯一「共享状态」是 runtime 内存 ring（已按 MUST_FIX #1 覆盖）。P0-21 邻居不变量：S3（live ≡ reload）已覆盖持久化表面不变；建议 S5 验收时顺带断言一次「长 bash running 中断开重连 renderer」的 gap 恢复路径（可与 MUST_FIX #1 的量化合并考虑）。
