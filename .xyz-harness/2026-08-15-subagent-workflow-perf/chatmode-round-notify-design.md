# chatMode 轮次通知增量发送设计（消除 O(N²) 累计全文膨胀）

> **一句话结论**：轮次完成通知改为「只发本轮增量 + sessionFile 回溯指针」（方案 A，长期方案），信息量与现状无损等价，通知与父上下文体积从 O(N²) 降为 O(N)。
>
> **层声明**：本文当前层 = 性能问题技术方案；下一层 = 实现任务（文件级改动清单）。不写实现代码。

---

## 1. 背景与目标

**S（情境）**：`@zhushanwen/pi-subagent-workflow` 的对话模式（chatMode，`conversation:true`）subagent 是长驻对话伙伴：父 agent 用 `action:"start"` 启动后，可反复 `action:"message"` 续聊，每轮完成时扩展自动把子 agent 回复通知回父 agent（`interface/subagent-tool.ts:229`："the reply auto-notifies when the round completes"）。子进程 session 文件保留完整多轮上下文，续聊不丢前文。

**C（冲突）**：每轮通知的正文不是「本轮回复」，而是 `getFullText(record)`——**从第 1 轮到当前轮的全部 turn 文本拼接**。第 k 轮通知体积 ∝ 前 k 轮文本总量，N 轮对话的通知总体积 O(N²)。

**Q（问题）**：通知正文的语义应该是「本轮产出」还是「历史全量快照」？这是信息语义取舍，不是纯传输优化。

**A（答案）**：本轮增量。因为每轮通知 = 上一轮通知 + 本轮新增，历史部分在父 agent 上下文中已经存在——重发是纯冗余。全量快照的唯一「好处」（父 agent compaction 后看最新一条仍能拿到全量）代价是与 compaction 正面对抗，属于反模式；正确兜底是 sessionFile 回溯指针。

### 1.1 系统背景（读者假设：会用 subagent-workflow，未读过本次分析）

两个计数术语（后文 D1 公式与全部行号依赖此区分，首次出现即定义）：

- **turn**：pi 的执行单元——子 agent 的一段「输出文本 + 工具调用」循环，以 `turn_end` 事件闭合，逐个累积进 `record.turns[]`。**一个轮次内可有多个 turn**（例：子 agent 先说话、再调 read 工具、再总结 = 3 个 turn）。
- **轮次（round）**：父 agent 视角的对话周期——一次 `start`/`message` 到该轮 `agent_settled` 为止，完成时 `record.round` +1。**一个轮次 = `turns[]` 里新追加的 0..n 个 turn**（本轮空转/失败轮可为 0 个）。

chatMode 一次执行的生命周期：

1. **start**：`action:"start"` + `conversation:true` → spawn `pi --mode rpc` 子进程，record 挂 `chatMode:true`。
2. **轮次执行**：子进程跑本轮任务，事件（text_delta / tool_start / tool_end / turn_end）经 stdout JSON 流回流，全部累积进父进程内存的 `record.turns[]`。
3. **轮次完成**（`agent_settled`，真空闲边界）：扩展 arm 5 分钟 idle timer → 通知父 agent「本轮完成 + 回复正文」→ 父 agent 被 `triggerTurn:true` 唤醒，读到通知后决定续聊 / close / 行动。
4. **续聊**：`action:"message"` → 热路径直接向活子进程 stdin 发 prompt（冷路径 `--session` 续写原 session 文件重开），回到步骤 2。新一轮文本**继续追加**进同一个 `record.turns[]`。
5. **close**：终态化（closed），发终态通知。

### 1.2 设计目标

| # | 目标 | 判据 |
|---|------|------|
| G1 | 轮次通知体积与轮次序号解耦 | 第 k 轮通知 content 不含第 k-1 轮文本；N 轮通知总体积 O(N) |
| G2 | chatMode 语义零回归 | 续聊上下文保留、round 去重、close/cancel 路径行为不变 |
| G3 | 父 agent 保留全量回溯通道 | 通知携带 sessionFile 指针，父 agent 可按需读全文 |
| G4 | 一次性任务（非 chatMode）零影响 | 无 conversation 场景的通知与终态 result 与现状逐字节一致 |

使用者锚点（G1-G4 的最终受益者是使用者而非扩展内部）：G1/G3 让**父 agent** 的上下文不再被历史快照挤占、compaction 收益不再被下一轮全量前缀抵消；G1 同时让**用户**的 cache-miss 重复计费（随轮次平方增长）消失；G2/G4 保证既有使用者（续聊决策、一次性任务）可感知行为零变化。

**In scope**：轮次通知 / 终态通知的正文内容定义；增量边界的记账机制。
**Out of scope**：`record.turns[]` 的内存驻留治理（thinking / toolCalls result 全量驻留是 O(N) 内存问题且是投影数据源，需单独设计归档策略，与通知膨胀不是同一问题，见 §3.2 方案 B 讨论）；notifier 合并窗口 / dedup 机制本身（现有 `id:round` 去重已正确，`notifier.ts:128`）。

---

## 2. 现状与问题分析

**结论：通知正文取自跨轮累积的 `record.turns[]` 全量派生，且通知作为 custom message 永久进入父 agent 的 LLM 上下文——膨胀发生在「发送、父 session 文件、父 LLM 上下文」三层，后两层比单次发送成本更重。**

先看使用者（父 agent）今天实际收到什么。3 轮 chatMode 对话，第 2 轮完成时父 agent 收到的通知正文（真实模板拼接，非示意：running 分支文案取自 `notifier.ts:250` 的 `Subagent "x" (id) finished a round. Reply:\n${record.result}`，其中 `record.result` = `getFullText(record)` 全量拼接——含第 1+2 轮全部非空 turn 文本，轮间以 `\n\n` 连接）：

```
Subagent "reviewer" (sa-xxx) finished a round. Reply:
<第 1 轮回复全文>

<第 2 轮回复全文>
```

第 1 轮的内容在这条通知里是**第二次出现**（第 1 轮完成时已作为首条通知全文发过一次）。第 3 条通知同理含 1+2+3 轮全文。改造后的对照样例见 §3.1。

### 2.1 现状链路（行号取自 extensions/subagent-workflow/src/）

```
子进程 stdout（text_delta…turn_end）
  │  updateFromEvent()                      execution/execution-record.ts:285
  │    text/thinking/toolCalls 累积进 record.turns[]（唯一写点，跨轮永不清理）
  ▼
agent_settled（每轮真空闲边界）              execution/session-runner.ts:685-708
  │  armIdleTimer + limiter.reset() + record.turnCount = 0   ← 只重置计数器
  │  ctx.onRoundSettled(record)
  ▼
onRoundSettled                              execution/subagent-service.ts:1754-1781
  │  record.round += 1
  │  roundText = getFullText(record)        ← 【问题点】全历史轮次文本
  │  record.result = roundText
  │  notifyComplete(record)
  ▼
toNotifyRecord → BgNotifyRecord.result      execution/subagent-service.ts:563-595
  ▼
buildLlmContent（running 分支）              execution/notifier.ts:248-250
  │  `Subagent "x" (id) finished a round. Reply:\n${record.result}`
  ▼
sendMessage({customType:"subagent-bg-notify", content, display:true},
            {triggerTurn:true, deliverAs:"steer"})
                                            execution/notifier.ts:213-224
  ▼
父 agent：新 turn 被触发（triggerTurn）
  ├─ content 作为 custom entry 持久化 → 父 session JSONL 文件（每轮追加一条，物理落盘）
  └─ content 进入父 LLM 后续每轮的 prompt 上下文（膨胀真正的归宿）
```

关键事实（均已核实到代码）：

1. **turns[] 跨轮不清理**：`agent_settled` 只做 `limiter.reset()` + `record.turnCount = 0`（`session-runner.ts:699-700`）。注释明示设计意图——「不调 completeRecord（record 不冻结，保留 turns[] 等运行时状态供续聊累积）」（`finalize-record.ts:184` 附近）。
2. **getFullText 聚合全部历史**：`record.turns.map(t => t.text).filter(非空).join("\n\n")`（`execution-record.ts:534-539`）。`onRoundSettled` 的注释自述「跨轮累积，含本轮全部非空 turn 文本」（`subagent-service.ts:1763-1764`）。
3. **通知参与父 LLM 上下文**：pi SDK 契约——`sendMessage` 是 "Send a custom message to the session"（CustomMessage，`role:"custom"`），与 `appendEntry` 的 "not sent to LLM" 形成对照（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:904-917`、`core/messages.d.ts:29-39`；且 `CustomMessage` 无 `excludeFromContext` 字段，不落排除路径）。即通知 content 不仅一次性发送，还**持久化到父 session 文件并进入父 LLM 后续每轮的上下文**。探针：类型契约 ✅ 已核实（如上）；「父 session 文件逐轮追加 custom entry」的落盘事实 ⛔ 实施期随 §4 场景 1 打开父 JSONL 实测确认。

### 2.2 量化：三层放大器

设每轮子 agent 回复文本约 s 字符，N 轮对话：

| 层 | 膨胀 | 机理 |
|----|------|------|
| ① 单次发送 | 第 k 轮通知 ≈ k·s | getFullText 全量 |
| ② 父 session 文件 | Σ k·s ≈ **N²/2 · s** | 每条 custom message 持久化 |
| ③ 父 LLM 上下文 | 父第 m 轮时上下文含前 m 条通知 ≈ **m²/2 · s** | 通知是 custom message，参与每轮 prompt |

层 ③ 是真正的痛点：cache miss 时按 token 重复计费，且持续挤占父 agent 的有效上下文窗口（长对话中父 agent 可能比子 agent 更早触发 compaction）。层 ③ 还与 compaction 正面对抗——父 agent 刚 compaction 压缩掉历史通知，下一轮通知又灌入全量前缀，compaction 收益被立刻抵消。

附带成本（非本题主因，顺带记录）：`project()` 每 200ms 节流触发 `getEventLog`/`getDisplayItems` 遍历全部历史 turns（✅ 已核实：节流常量 `ON_UPDATE_MIN_INTERVAL_MS = 200`，`subagent-service.ts:197`；投影调用点 `subagent-service.ts:1652-1685`；派生实现 `execution-record.ts:426-448`、`:467-484`），CPU 随历史线性增长。

### 2.3 真实失败模式

一个 20 轮的 chatMode 调试对话，每轮回复 3KB：

- 第 20 轮通知单条 ≈ 60KB，直接触发_provider 上下文吃紧或被父侧截断；
- 父 session 文件通知段 ≈ 630KB 冗余文本（其中重复前缀占 95%+）；
- 父 agent 第 20 轮的 prompt 里塞着 19 份越来越长的历史快照。

### 2.4 核心语义问题：父 agent 每轮通知到底需要什么？

父 agent 收到第 k 轮通知后的决策动作只有三类：续聊（`message`）、关闭（`close`）、基于回复内容行动（写码 / 汇总 / 再派发）。分析其信息需求：

| 信息 | 是否需要 | 来源现状 |
|------|---------|---------|
| 本轮完成事件 + 本轮回复 | **需要**（决策依据） | 通知正文 |
| 第 1..k-1 轮内容 | **不需要重发**——已作为前 k-1 条通知在父上下文中 | 通知正文冗余重发 |
| 全量回溯（父 compaction 后 / 终态汇总） | 偶发需要 | 现状无显式通道（靠重发「顺带」覆盖）；子 sessionFile 本就是权威全量（list action 已引导 "Read an item's sessionFile for full detail"，`interface/subagent-tool.ts:231`） |

结论：**每轮通知 = 完成事件 + 本轮增量 + 回溯指针**，信息论上与现状无损等价（现状的额外部分是纯重复），且不再对抗 compaction。

---

## 3. 解决方案

**结论：推荐方案 A（增量通知 + 边界记账 + sessionFile 指针）【长期方案】；方案 C（截断）仅作紧急止血的短期备选；方案 B（裁剪 turns 历史）因破坏单一数据源被否。**

### 3.1 终态（使用者视角）

父 agent 启动 chatMode subagent 并对话 3 轮，看到的第 2 条通知（对照 §2 章首的现状样例）：

```
Subagent "reviewer" (sa-xxx) finished a round. Reply:
<仅第 2 轮回复正文>

Full transcript: /path/to/subagents/<enc>/sessions/<sid>.jsonl
```

- 前缀文案与现状逐字节相同（`finished a round. Reply:`，不改 notifier 现有措辞）；与现状的差异只有两处：正文范围从「全历史」缩为「本轮增量」、末尾追加 `Full transcript:` 指针行。
- 每条通知只含当轮回复；第 3 条不再重复第 1、2 轮内容。
- 父 agent 需要全量（如终态汇总）时，用 read 工具读通知尾部的 sessionFile 路径。
- 失败路径（sessionFile 尚未回填，极早期轮次）：指针行省略，通知正文与现状一致（增量=首轮全文），不阻塞。恢复指引：父 agent 随时可用 `action:"list"` 拿到该 subagent 的 sessionFile（tool description 已引导 "Read an item's sessionFile for full detail"，`interface/subagent-tool.ts:231`）——全量回溯通道不依赖指针行存在。

### 3.2 方案对比

#### 方案 A：通知只发本轮增量 + 边界记账【推荐，长期方案】

机制：`ExecutionRecord` 增加 `roundBaseTurnIndex`（本轮增量的起始 turn 下标）。`onRoundSettled` 取增量文本、发通知、推进边界；终态通知同样发增量 + 指针。

```ts
// 接口签名（伪代码）
export function getFullTextFrom(record: ExecutionRecord, fromTurnIndex: number): string
// 语义：turns.slice(fromTurnIndex) 的非空 text 拼接；fromTurnIndex=0 等价 getFullText
```

- **对父 agent 决策信息完整度的影响**：无损。父上下文信息总量与现状一致（现状是重复，增量是恰好一次）。唯一行为差异：父 compaction 吞掉早期通知后，父 agent 无法从「最新一条通知」恢复全量——由指针行兜底（主动读 sessionFile），且这本来就是 compaction 的应有语义（要压缩就别重灌）。
- **长期架构合理性**：高。修根因（通知内容定义错误），不碰数据模型（turns[] 仍是单一数据源，eventLog/usage/详情投影全部不受影响）；一次性任务路径 `fromTurnIndex=0` 天然回退为 getFullText，G4 零成本满足。
- **短期实现成本**：中低。改动集中在 3 个文件（execution-record 加派生函数 + record 字段、subagent-service 的 onRoundSettled、notifier 文案），预计 1 天含测试。核心复杂度在边界推进的滞后事件处理（见 §3.3 D1）。
- **风险**：边界记账错误会导致丢文本（比重复更严重）——用单测锁死滞后空 turn 边界 + 真实场景验收（§4 场景 3 的「跨轮记忆」测试能抓住）；消费方 `record.result` 语义从「全历史」变「本轮」影响 list 视图展示（`interface/list-component.ts:609-613` 显示的 result 变短）——list 本就引导读 sessionFile，可接受，需在变更说明中记录。

#### 方案 B：通知发全文但 turns 历史每轮裁剪【否决】

机制：`agent_settled` 时把已通知的 turns 从 `record.turns[]` 移除（或搬入 `archivedTurns`），getFullText 不改、自然只含本轮。

- **对父 agent 决策信息完整度的影响**：与 A 相同（正文等价），但父 agent 之外的所有消费方信息受损。
- **长期架构合理性**：低。`turns[]` 是收口设计的单一数据源——eventLog / displayItems / getTotalUsage / getAllToolCalls 全部从它派生（`execution-record.ts:5-13` 收口注释）。裁剪直接破坏：终态 `collectResult` 的 usage 只剩最后一轮、`extractParsedOutput` 倒序找 structured-output 只剩本轮、详情视图丢历史轮 eventLog。若为保住这些把裁剪项搬进 `archivedTurns`，则内存未省、引用被搬运，退化成 A 的低质实现（偏移量 vs 数组搬迁）。
- **短期实现成本**：看似低（getFullText 不动），实则要逐一审计 turns[] 全部派生消费方，成本高于 A。
- **风险**：高。用数据破坏换通知变短，把「通知瘦身」与「数据保留」两个正交关注点耦合成一个隐式契约，未来任何新派生函数都会踩坑。
- **若用它**：§2.1 链路中 `/subagents` 详情视图对 3 轮对话只显示最后一轮 eventLog，用户误以为前两轮丢失。

#### 方案 C：保持现状 + 体积上限截断【短期备选】

机制：`onRoundSettled` 对 roundText 截断（如 8KB 保尾）+ 标注 `…(truncated, full text: <sessionFile>)`。

- **对父 agent 决策信息完整度的影响**：受损最严重。截断丢信息且丢得盲目（保尾丢开头、保头丢结论），父 agent 只知道「被截了」不知道丢了什么；且每轮仍重发 cap 大小的重复前缀，父上下文仍线性膨胀 N·cap（O(N²)→O(N)，常数大）。
- **长期架构合理性**：低。吞症状不修根因（重复发送的根因还在，只是加了盖子）；cap 是魔法数，取值无原则依据。
- **短期实现成本**：极低（约 10 行）。
- **风险**：中。信息静默丢失改变父 agent 决策质量；两处截断点（onRoundSettled vs notifier）容易发散。
- **若用它**：§2 章首样例的第 2 轮通知变成「第 1 轮全文截断后的 8KB 尾部 + 第 2 轮全文」——父 agent 知道「被截了」但拿不回第 1 轮结论；§2.3 的 20 轮对话里第 20 轮通知仍丢失开头约 52KB，且每条仍带 cap 大小的重复尾部，父上下文继续线性膨胀。
- **定位**：仅当线上事故需要当天止血时使用，且必须带 TODO 指向本设计。非当前需要——A 的成本本身可控。

### 3.3 关键决策与权衡

**D1 增量边界 = 已闭合 turn 计数，不是 turns.length（防滞后空 turn 丢文本）**
选择：记账字段 `roundBaseTurnIndex` 推进为「本轮结束位置」；取增量用 `turns.slice(roundBaseTurnIndex)`。
被否：直接用 `turns.length` 作下一轮起点。
证据：settle 时刻末尾可能存在一个由滞后 `message_end` 开出的**空 turn**（`currentTurn()` 在 message_end 分支被调用，`execution-record.ts:372-386` + `:212-218`）。下一轮首个 text_delta 会**复用**这个空 turn 累积（currentTurn 返回未闭合的末 turn）。若边界越过它，本轮文本在下轮 slice 范围外——静默丢文本。正确推进：`turns.length - (末 turn 未闭合且 text 为空 ? 1 : 0)`。
探针：单测构造「turn_end → 滞后 message_end（开空 turn）→ agent_settled → 新轮 text_delta」序列，断言新轮增量含新文本。⛔ 实施期门——本断言必须落地为单测并真实运行通过。

**D2 终态（close）通知同样发增量 + 指针，不发全量**
选择：`closeAfterRoundSettled` 的合成 result 沿用 `record.result`（= 本轮增量，`subagent-service.ts:1097`），closed 分支文案附轮次统计 + sessionFile 提示。
被否：终态一次性发全量（O(N) 单条）。
理由：父 agent 已通过逐轮增量看过全部内容，终态再灌全量会重现层 ②/③ 的一次性大注入（N 轮全文单条进父上下文）；父 compaction 后确需全量的场景走指针读文件，成本按需支付。

**D3 指针提示行进通知正文（LLM 可见），不止 details**
选择：`buildLlmContent` running / closed(chatMode) 分支正文末尾追加 `Full transcript: <sessionFile>` 行。
理由：details 字段（`BgNotifyRecord`）不经 LLM 渲染路径消费（TUI 渲染器 `interface/bg-notify-render.ts` 读 details 但只服务终端显示：running 轮次分支仅渲染标题行、closed 分支也只显示 result 首行摘要，`bg-notify-render.ts:246`、`:254-257`）；指针必须在 content 里，父 LLM 才知道全量在哪。sessionFile 缺失（极早期轮）时省略该行，不阻塞通知。

**D4 非 chatMode 路径不动 + 边界不持久化**
选择：`roundBaseTurnIndex` 仅 chatMode 推进；一次性任务恒 0；该字段只存内存，不写入磁盘 manifest / session 重建路径。
理由：G4。`getFullTextFrom(record, 0)` 与 `getFullText` 逐字节一致，终态 `collectResult`（`output-collector.ts:77`）不改，一次性任务的通知 / result / schema enforcement 路径零变化。跨重启磁盘重建 record（`getRecordForAction` 用 `createRecord` 新建，`subagent-service.ts:945-964`）时字段为 undefined → 回退 0 → 下一轮通知发全量——**向现状方向的安全降级**（多发冗余，不丢文本），可接受，不值得为省一次冗余把边界塞进持久化链路。

**D5 内存驻留（turns[] 的 thinking / toolCalls result 全量累积）不在本次处理**
选择：out of scope。
理由：它是 O(N) 内存 + 投影遍历成本，不是 O(N²) 通知膨胀；且 turns[] 是投影数据源，裁剪需与 eventLog / 详情视图联动设计（方案 B 已论证贸然裁剪的破坏性）。单独立项。

---

## 4. 验收

**结论：全部在本地 pi CLI 用真实模型（`xiaomi-token-plan-cn/mimo-v2.5-pro`）跑 chatMode 多轮对话验证，先复现现状 O(N²) 基线，再验修复效果；不依赖单测断言作为验收依据。**

环境：本地源码 link（`.agents/skills/dev-link/` 的 pi-link 模式）+ `pi --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension extensions/subagent-workflow`，stdin JSONL 驱动 prompt；`PI_EXT_DEBUG=1` 看扩展日志。

### 场景 1【改动前基线】复现 O(N²)（回溯 G1 的反面证据）

1. 主 agent prompt：启动 chatMode subagent（task 让它输出一段固定长度可识别文本，如「请只回复：ROUND1-AAAA...」各轮不同），收通知后连发 2 次 `message`。
2. 打开**父** session JSONL，找 3 条 `subagent-bg-notify` entry。
3. **通过标准**：第 2 条 content 含 `ROUND1` 字样、第 3 条同时含 `ROUND1` 与 `ROUND2` 字样；三条 content 长度逐条叠加增长。记录三条长度作基线。

### 场景 2【改动后】通知增量不叠加（回溯 G1、G3）

1. 与场景 1 完全相同的对话流程。
2. **通过标准**：第 2 条 content **不含** `ROUND1` 字样、第 3 条不含 `ROUND1`/`ROUND2`；每条只含当轮标记；每条末尾有 `Full transcript: <路径>` 行且该文件存在；三条长度大致相等（≈ 单轮回复长度），总量对比场景 1 基线显著下降。

### 场景 3【语义回归】跨轮上下文保留（回溯 G2）

1. 第 1 轮让子 agent 记住一个暗号（如「暗号是 ZEBRA-42」）；第 3 轮 message 问「我第一轮告诉你的暗号是什么」。
2. **通过标准**：第 3 轮通知正文正确答出 ZEBRA-42。证明子 session 上下文保留不受影响（增量只改通知内容，不动子进程 / resume 机制）。

### 场景 4【回溯通道】终态指针可达（回溯 G3、G2）

1. 3 轮后 `action:"close"`，收终态通知。
2. **通过标准**：终态通知含 sessionFile 路径；`cat` 该文件能依次看到 3 轮 user prompt 与 assistant 回复全文。

### 场景 5【回归护栏】一次性任务零影响（回溯 G4）

1. 不带 `conversation:true` 跑一个普通 background subagent 至完成。
2. **通过标准**：完成通知 content 与改动前同 task 的输出逐字节一致（无 transcript 行、全文语义不变）。

---

## 5. 下一层拆分

拆分按「数据层 → 唯一通知来源 → 文案收口 → 消费方确认 → 真实验收」的依赖序，每个任务可独立验收，纯函数改动（任务 1）先行隔离边界风险。

| # | 任务 | 文件 | justification |
|---|------|------|---------------|
| 1 | `ExecutionRecord` 增加 `roundBaseTurnIndex?: number` 字段 + `getFullTextFrom(record, fromTurnIndex)` 派生函数（fromTurnIndex=0 等价 getFullText）；单测覆盖滞后空 turn 边界（D1 探针）、多 turn 单轮、空文本轮过滤 | `execution/types.ts`、`execution/execution-record.ts` | 数据层先行；纯函数可独立验收（单测），边界 case 集中在此隔离 |
| 2 | `onRoundSettled`：`roundText = getFullTextFrom(record, record.roundBaseTurnIndex ?? 0)`；推进边界（按 D1 公式）；record.result 写点语义随之变为「本轮增量」 | `execution/subagent-service.ts:1754-1781` | 唯一通知正文来源，改一处即覆盖热 / 冷两种轮路径（均汇聚于 onRoundSettled） |
| 3 | `buildLlmContent` running 分支 + chatMode closed 分支追加 `Full transcript: <sessionFile>` 行（sessionFile 缺失省略）；一次性 closed 分支不动 | `execution/notifier.ts:227-252`、`BgNotifyRecord` 补 `sessionFile` 字段（`toNotifyRecord` 透传） | 指针必须在 LLM 可见的 content 内（D3）；notifier 是文案唯一收口 |
| 4 | `closeAfterRoundSettled` / `doFinalizeRoundToIdle` 确认 result 语义（D2：增量 + 指针，不回归全量）；梳理 `record.result` 下游展示（list-component / bg-notify-render）确认增量语义可接受 | `execution/subagent-service.ts:1088-1105`、`execution/finalize-record.ts:216` | 终态与轮次通知语义一致性；显式记录消费方影响而非静默变更 |
| 5 | 真实场景验收：按 §4 场景 1 先跑基线存证，改动后跑场景 2-5 | 本地 pi CLI | 设计阶段验证（§4）即实施 DoD，先基线后修复防「无对照的通过」 |

依赖关系：1 → 2 → 3/4 并行 → 5。每个任务独立 commit（对应「打包相关改动规范」的逐项验证精神，本组无打包配置改动）。

**待验证检查点（实施期必须落实）**：
- D1 滞后空 turn 边界：单测 + 场景 2/3 双保险（通知丢文本会被场景 3 的跨轮问答抓到——子 agent 答不上说明轮文本没进增量）。
- 合并窗口内两轮同 flush：notifier `doSend` 把多条 pending 拼一条消息（`notifier.ts:205-208`），两条各自是各自增量，无重复。「轮次完成即 flush」✅ 已核实代码：`hasRunningBackground()` 对 timer-armed record 返回 false（`!hasIdleTimer(r.id)` 判据，`subagent-service.ts:544-553`，判据在 `:551`）；⛔ 运行时实测随场景 2 确认。
