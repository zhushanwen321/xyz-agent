# rename-session 输入精简 + slug 标题 + 可靠性补齐 设计文档

> **一句话结论**：把标题生成的触发点修正到「首个用户轮次完成」、注入内容收敛为「用户 prompt + 轮次最终回复」两段信号，system prompt 重写为 slug 词组风格约束，并补齐超时、防覆盖手动命名、error 轮误命名三个可靠性缺口；验收用真实 pi 进程 + 真实模型做 E2E，以日志内省 + 双流交错时序 + 内容匹配作为证据链。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-rename-session` 是 pi 的 extension，在新 session 首个轮次后用独立小模型生成会话标题（`setSessionName` 落库），让 session 列表摆脱日期占位名。
- **C（冲突）**：现状的触发判定在**首个 LLM iteration 结束时就触发**（pi 的 `turn_end` 每个 iteration 发一次，见 §4 术语）——工具型首轮基于「我来看看代码」+ 首批工具结果这类不完整上下文生成标题；注入内容含 toolCall/toolResult 等与标题无关的过程数据；标题风格缺乏约束，常见完整句子；另有三个可靠性缺口（无超时、覆盖手动命名、error 轮当场用错误上下文命名）。
- **Q（问题）**：如何让标题生成「在正确时机触发、输入最小、风格可控、失败不影响任何东西、且行为可被 E2E 验证」？
- **A（答案）**：触发点用 `stopReason === "stop"` 快速路径 + 成功计数收敛到轮末最终 iteration；注入内容收敛为两段文本信号（user prompt + 最终回复，各截断保护）；system prompt 重写为 slug 词组约束；补 `timeoutMs` / 落库前重查 `getSessionName()` / 成功计数三个修复；新增 `PI_RENAME_DEBUG=1` debug 日志输出实际发送的 messages（带时间戳与 turnIndex），作为 E2E 证据链。

---

## 1. 背景：被设计的系统是什么

**本章结论：本设计只涉及 rename-session extension 的标题生成管线（触发判定 → 输入构造 → LLM 调用 → 标题落库），不涉及 pi 核心与 xyz-agent runtime。**

rename-session（源码 `extensions/rename-session/src/`）在 pi 进程内运行，监听 `turn_end` 事件。代码分四个文件：`index.ts`（事件编排）、`llm.ts`（prompt 常量 + messages 构造 + LLM 调用）、`pure.ts`（配置 + 首 turn 计数 + 标题清洗）、`commands.ts`（`/auto-rename` 开关命令，本次不动）。当前管线四步：

1. **触发判定**：`turn_end` 时统计 session entries 中 assistant 回复数（`countAssistantReplies`，数所有 `role === "assistant"` 的 message entry，不看 stopReason），`=== 1` 触发；
2. **输入构造**：`buildMessages()` 取当前全部 `type === "message"` 的 entry 作为 messages 前缀，末尾追加一条 rename 指令 user message；
3. **LLM 调用**：`callRenameLLM()` 经 `@zhushanwen/pi-llm-shared` 的 `callLLM()`（独立选模 `resolveModel`，默认 scoped；精简 systemPrompt；`tools: []`；`maxTokens: 64`）；
4. **落库**：`cleanTitle()` 清洗后 fire-and-forget 的 `.then()` 里 `pi.setSessionName()`（追加 `session_info` entry 到 session JSONL）。

## 2. 设计目标

**本章结论：改造后标题「在正确时机触发、成本降一个量级、风格是 slug 词组、任何失败零副作用、行为有可断言证据」。**

1. **G1 时机正确 + 输入精简**：标题 LLM 在首个用户轮次**完成后**触发，只接收两段信号——用户 prompt（任务意图）+ 该轮次最终回复（agent 结论），不含任何 toolCall/toolResult/中间过程文本；
2. **G2 slug 风格**：标题是名词或动名词词组（如「修复 Safari 按钮点击失效」「refactor-config-loader」），不是主谓宾句子（如「我帮你修复了登录 bug」是错误形态）；英文 kebab-case 小写，语言跟随对话；
3. **G3 可靠性**：LLM 调用 30s 超时兜底；用户已手动命名的 session 不被覆盖（含 LLM 调用进行中的竞态窗口）；error 轮不用错误上下文命名、下一个成功轮次仍会被命名；
4. **G4 可观测**：提供 debug 模式输出实际发送给 LLM 的 messages 与调用时机（带时间戳 + turnIndex），使 E2E 能断言「轮次结束后才调用」和「LLM 收到了哪两段文本」。

**In-scope**：上述四目标的 extension 侧改动 + 测试 + changeset。**Out-of-scope**：`maxTitleLength`/`model`/`thinkingLevel` 等既有配置项语义；失败自动重试（见 §6 D8 裁决）；llm-shared 与 pi 核心改动；xyz-agent 桌面端 UI；`/auto-rename` 命令。

## 3. 现状：使用者眼里是什么样的

**本章结论：现状四个失败模式——触发时机错误、token 成本与噪音、标题风格不可控、三个可靠性缺口——前两个源于「触发判定」把 iteration 当轮次，后两个源于 prompt 与落库路径的缺口。**

### 3.1 现状的真实样子（含关键事件语义）

pi 的事件语义（官方文档 `docs/extensions.md` "turn_start / turn_end"）：**turn = 一次 LLM response + 它触发的工具调用（一个 iteration）；`turn_end` 每个 iteration 发一次**，事件携带该 iteration 的 assistant message（`event.message`）。一条用户输入到 agent 停止等待的完整交互（下称**用户轮次 / round**）由 ≥1 个 turn 组成；工具型任务的 round 中间每个 turn 的 assistant message `stopReason` 为 `"toolUse"`，最终 turn 为 `"stop"`。

现状 `llm.ts` 的 `buildMessages()`（真实代码）：

```ts
export function buildMessages(entries: ReadonlyArray<EntryLike>, instruction: string): Message[] {
	const prefix = entries
		.filter((e) => e.type === "message" && e.message !== undefined)
		.map((e) => e.message as Message);
	return [...prefix, { role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }];
}
```

现状 `index.ts` 触发判定（真实代码）：

```ts
const entries = ctx.sessionManager.getEntries();
const assistantCount = countAssistantReplies(entries);  // 数所有 assistant entry，不看 stopReason
if (assistantCount !== 1) return;
```

现状 system prompt（`RENAME_SYSTEM_PROMPT`，真实代码）：

> 你是会话标题生成器。根据对话内容生成 3-8 词的简短标题，使用对话所用的语言。只输出标题文本，不要解释、emoji、引号或 markdown 标记。

### 3.2 怎么出错

- **失败模式 A（触发时机错误 → 标题基于不完整上下文）**：用户首轮「帮我修复 login 页面在 Safari 下按钮点不动的问题」，agent 首个 iteration 回复「我来看看相关代码」并发起 5 个 toolCall。该 iteration 的 `turn_end` 触发时 `countAssistantReplies === 1` 成立 → rename **在轮次中途触发**，注入的是 user prompt +「我来看看相关代码」+ 首批 toolCall/toolResult，生成的标题围绕「看代码」而非「修 bug」。真实证据：用户机器近期 session JSONL 中可见 `session_info` 落在首批 toolResult 之后、轮次仍在继续的行序（review 实测）。
- **失败模式 B（token 成本与噪音）**：即便触发点侥幸正确，`buildMessages` 也把全部 message entry（含 toolCall 参数、toolResult 输出、中间过程文本）发给标题模型。代码注释声称「前缀与主 turn 字节级一致，命中 kvcache」——前提不成立（§3.3），纯成本。
- **失败模式 C（标题风格不可控）**：现状 prompt 只约束「3-8 词」，无词组风格约束。用户（extension owner）观察到的实际产出常是完整句子风格（如「我帮你修复了登录 bug」），在 session 列表里既长又不像标题。
- **失败模式 D（可靠性缺口 ×3）**：
  - D-1 无超时：`callRenameLLM` 未传 `timeoutMs`（llm-shared `callLLM` 支持该参数但未被使用），provider 卡死时 detached promise 永远 pending；
  - D-2 覆盖手动命名：落库前不查 `getSessionName()`，用户在首轮完成前（或 LLM 调用进行中）手动 `/name`（RPC `set_session_name`）都会被返回的自动标题覆盖；
  - D-3 error 轮误命名：error 消息先落库再发 `turn_end`（真实 session JSONL 中存在 `stopReason:"error"` 的 assistant entry，review 实测 60 个近期 session 出现 36 条），`countAssistantReplies` 把它计入 → error 轮自身就触发 rename，基于错误上下文生成标题（标题可能是「请求失败」类垃圾）；error 发生在第 ≥2 个 iteration 时则 count >1 永不命名。

### 3.3 根因

- 失败模式 A/D-3 的根因：触发判定把「assistant entry 数 === 1」当作「首轮完成」，但 pi 的 `turn_end` 每 iteration 发一次，且判定不看 `stopReason`——既分不清「iteration 结束」与「轮次结束」，也分不清「成功」与「出错」。
- 失败模式 B 的根因：`buildMessages` 注释声称的 kvcache 前提不成立——rename 用 `resolveModel` 独立选模（默认 scoped，与主 session 模型大概率不同），所有主流 provider 的 prefix cache 按 model 隔离；即使模型相同，rename 请求的 systemPrompt 是 75 字符精简版，与主对话数千字符的 agent systemPrompt 从第一个字节就分叉，messages 前缀不可能命中缓存。付出的 input 成本换不回任何缓存收益。
- 失败模式 C 的根因：system prompt 与末尾指令都没有词组风格锚定（无正例、无反例、无 few-shot），模型默认产出摘要句。
- 失败模式 D 的根因：D-1 是 `timeoutMs` 参数漏传；D-2 是落库前未查 `getSessionName()`（pi 源码已验证：未命名时返回 `undefined`，✅探针见 §6 D5；且 `session_info` entry 无「手动/自动」来源标记，事后无法区分）；D-3 同失败模式 A。

## 4. 根因 + 物理数据流

**本章结论：改造集中在「触发判定」与「输入构造」两个环节，其余环节（配置、选模、落库、清洗）保持不动。**

> **turn（iteration）** = 一次 LLM response + 它触发的工具调用；pi 对每个 turn 发一次 `turn_start` / `turn_end`，`turn_end.message` 是该 iteration 的 assistant message（`stopReason`：中间 turn 为 `"toolUse"`，最终 turn 为 `"stop"`，异常为 `"error"` / `"aborted"`，输出截断为 `"length"`）。
> **用户轮次（round）** = 一条用户输入到 agent 停止等待下一次输入的完整交互，由 ≥1 个 turn 组成。本设计的「首个用户轮次」= session 中第一个以 `stopReason === "stop"` 结束的 round。
> **最终回复（final text）** = round 最后一个 turn 的 assistant message 中的 text 内容（不含 thinking / toolCall）。

现状数据流（改造点加粗）：

```
用户输入 prompt
  → pi agent loop：round = [turn₁: assistant msg(toolUse) → toolResults → turn₂: …] × N → 最终 turn(assistant msg, stopReason=stop)
    （每个 turn 各发一次 turn_end，event.message = 该 turn 的 assistant message）
  → extension handler（每个 turn_end 都被调用）
  →【改造点1：触发判定 —— stopReason==="stop" 快速路径 + 成功-turn 计数 + 防覆盖预检】
  →【改造点2：输入构造 —— buildTitleMessages(userPrompt, finalText, instruction)】
  → callLLM【改造点3：补 timeoutMs: 30s；改造点4：debug 日志内省（时间戳 + turnIndex）】
  → cleanTitle（轻度增强）
  → .then() 内【改造点5：落库前重查 getSessionName() 防竞态覆盖】
  → pi.setSessionName → appendSessionInfo → session JSONL 追加 {"type":"session_info","name":...}
  → session 列表 UI 显示标题
```

## 5. 终态：使用者眼里将是什么样的

**本章结论：session 列表里出现的是基于完整轮次生成的简短词组标题；标题生成的成本、时机、失败行为都对使用者透明无害。**

### 5.1 成功路径（真实场景样例）

用户在 pi 中输入：「帮我修复 login 页面在 Safari 下按钮点不动的问题」。agent 跑了 8 个工具调用（8 个 turn）后给出最终回复：「已修复：按钮被 header 的 z-index 遮挡，将其调至 100 并补了回归测试。」

round 完成后（约 2-5 秒），session 列表中该 session 的名字从日期占位变为：

> 修复 Safari 按钮点击失效

标题 LLM 实际收到的只有三条 message（`PI_RENAME_DEBUG=1` 时可在日志中看到）：

```json
[{"role":"user","text":"帮我修复 login 页面在 Safari 下按钮点不动的问题"},
 {"role":"assistant","text":"已修复：按钮被 header 的 z-index 遮挡，将其调至 100 并补了回归测试。"},
 {"role":"user","text":"<rename 指令>"}]
```

英文对话场景：用户「Refactor the config loader to support env overrides」→ 标题 `refactor-config-loader`。

### 5.2 失败路径（带恢复指引）

| 失败 | 行为 | 恢复指引 |
|---|---|---|
| 标题模型不可用（未配置 auth） | 跳过 rename，session 保留默认名，日志 `[rename-session] model not available, skipping` | `pi config` 配置模型凭证，或改 config JSON 的 `model` selector；已开头的 session 无法补命名，新 session 生效 |
| LLM 调用超时（30s） | 中止调用，session 保留默认名，日志含超时记录 | 无需操作；频繁超时则换轻量模型（改 `model` selector） |
| LLM 返回空/清洗后为空 | 跳过落库 | 无需操作 |
| 用户已手动命名（含 LLM 调用进行中手动命名） | 跳过 rename（落库前重查，尊重手动命名），debug 日志说明 | 无 |
| 首轮以 error / aborted / length 结束 | 本轮不命名；**下一个成功 round 仍会命名** | 修复导致 error 的问题后正常对话即可 |

所有失败共同保证：不影响 agent 主对话，不写入 session history，进程不挂起。

## 6. 关键决策与权衡

**本章结论：9 个决策，核心取舍是「stopReason 快速路径 + 成功计数」修正触发点、「两段文本信号」替代「全量前缀」、落库前重查防竞态。**

### D1 注入内容：两段文本信号（选） vs 全量前缀（现状） vs 仅 user prompt

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| A. user prompt + final text 两段（选） | 输入信号恰好是「意图 + 结论」，与标题语义对齐；无 kvcache 依赖 | 低：新纯函数 + handler 改传 `event.message` | final text 为空时需降级（D3 已覆盖） |
| B. 全量前缀（现状） | 名义上保 kvcache，实际不命中（§3.3），纯成本 | 零改动 | token 成本随工具数增长；过程数据稀释标题信号 |
| C. 仅 user prompt | 最省 | 最低 | 意图模糊的 prompt（如「继续」「接着改」）无上下文可依；丢失 agent 结论信号 |

**被否若用 B**：§5.1 的例子中，8 个工具调用的全部输入输出都会发给标题模型，成本高一个量级且标题质量不升反降。**被否若用 C**：prompt 为「嗯，继续」这类跟进型输入时，标题只能瞎猜。

### D2 触发点与 final text 来源：`stopReason === "stop"` 快速路径 + `event.message`（选）

pi 的 `turn_end` 每个 iteration 发一次，`event.message` 是**该 iteration** 的 assistant message——不能无差别使用。方案：handler 先做 O(1) 快速路径 `event.message.stopReason !== "stop"` 直接 return（过滤掉 `toolUse` 中间 turn 与 `error`/`aborted`/`length` 异常 turn），再走成功计数（D6）。**触发时刻的 `turn_end` 必然是 round 的最终 turn，其 `event.message` 即最终 assistant message**——final text 零遍历可得。

✅探针已测（review 核实）：事件每 iteration 一次（pi 官方文档 `docs/extensions.md` turn 定义 + `pi-agent-core/dist/agent-loop.js` 循环内每 LLM response emit 一次 turn_end）；`StopReason` 枚举 = `"stop" | "length" | "toolUse" | "error" | "aborted"`（`pi-ai/dist/types.d.ts`）；现状在首个 iteration 触发的实锤（真实 session JSONL 的 `session_info` 行序）。

被否方案「entries 反扫最后一条 assistant message」：无法区分「中间 iteration 的 assistant」与「最终 assistant」（都可能是最后一条 append 的），必须依赖 stopReason——那不如直接用事件自带的 message。

### D3 截断保护：两段各 4000 Unicode 码点

用户 prompt 可能贴几万字符代码/日志；skill 命令展开后首条 user message 也可能巨长。各段截断到 4000 码点（中文场景约 4k token，两段合计 ≤8k token——任何现代模型窗口都远超此值，成本可控），截断加 `…` 后缀。final text 为空（纯 toolCall 结束的 round 不存在此情况，因 `stopReason === "stop"` 才触发；但 text blocks 可能为空）时降级为只发 user prompt 两条 message——标题主信号本就是 prompt，不因此跳过整个 rename。`extractUserPromptText` 返回 null（理论不发生：round 由 user message 触发）时跳过 rename 并记 debug 日志。

### D4 slug 风格 prompt：重写 `RENAME_SYSTEM_PROMPT` + `RENAME_INSTRUCTION`，few-shot 锚定

新文案草案（中文为主，产出语言由对话决定）：

```
RENAME_SYSTEM_PROMPT =
"你是会话标题生成器。根据对话生成 slug 式标题：名词或动名词词组，
不要完整句子、不要主谓宾、不要代词或「已/完成了」这类时态表述、不要句尾标点。
英文用小写 kebab-case。使用对话所用的语言，3-6 个词。只输出标题文本。"

RENAME_INSTRUCTION =
"根据以上对话，为这个会话生成一个 slug 式标题。要求：
- 名词或动名词词组，例：「修复登录超时」「重构配置加载」「refactor-config-loader」
- 反例（错误）：「我帮你修复了登录 bug」「This session is about fixing bugs」
- 英文小写 kebab-case，中文直接用词组，不要句号
使用对话所用的语言。只输出标题文本。"
```

被否方案「只在 instruction 加一句风格要求」：system 与 instruction 双处一致约束 + 正反例 few-shot 的遵从率显著高于单处弱提示（正反例是最有效的风格锚定手段）。模型遵从率的验收处置见 §8.3 A2。

### D5 防覆盖：`.then()` 落库前重查 `getSessionName()` 判空

✅探针已测（pi `session-manager.js` 源码核实）：未命名时 `getSessionName()` 返回 `undefined`（无 `session_info` entry 时）；用户手动 `/name`（RPC `set_session_name`，已核实存在）后返回该名。检查位置在 **fire-and-forget 的 `.then()` 内、`setSessionName` 调用前**——不是发起 LLM 调用前：LLM 调用窗口（2-30s）内用户手动命名的竞态必须由落库前重查兜住。被否方案「比较新旧名字」：`session_info` entry 无来源标记（源码核实），无法区分自动与手动命名，不可行。

### D6 触发判定：成功-turn 计数 `countSuccessfulAssistantReplies(entries) === 1`（选） vs 现状 assistant 计数 vs `event.turnIndex`

新纯函数：数 `role === "assistant" && stopReason === "stop"` 的 message entry，`=== 1` 触发。覆盖场景：工具型首轮（中间 turn 全部 `toolUse` 不计数，最终 turn 时 stop 计数 1===1 触发，event.message 即最终回复）✅；error 轮（error entry 不计数；error 轮自身的 turn_end 被 D2 快速路径挡掉；下一成功 round 时 stop 计数 1===1 触发）✅；resume 旧 session（已有 ≥1 成功 turn，新 round 后 ≥2，不触发）✅。✅前提已实测证实：error 消息确实落库为 assistant entry（真实 session JSONL，60 个近期 session 出现 36 条 `stopReason:"error"`）。

**`stopReason === "length"`（输出被 max token 截断，轮次实质完成）**：与 error/aborted 同等对待——本轮不命名、不计成功，延迟到下一成功 round 命名。理由：截断的 final text 作为标题上下文质量无保证，而「延迟一轮命名」无害（远好于错误命名）；实测 length 在真实 session 中出现频率为 0，属极端边缘。

**被否 `event.turnIndex === 0`**：⛔已验证不可行——pi 源码显示 `agent_start` 时 `_turnIndex` 重置为 0，turnIndex 是「本次 agent run 内序号」，resume 旧 session 后首个 turn 也是 0，会误触发 rename。

### D7 超时：`timeoutMs: 30_000` 固定值

llm-shared `callLLM` 已支持 `timeoutMs`（✅源码核实，透传 `SimpleStreamOptions`），加一行即可。不进配置项（不加推测性功能；30s 对「输入 ≤8k token + 输出 64 token」的调用足够宽裕）。超时后 completeSimple 归一为 `ok:false`，走既有静默跳过路径。

### D8 失败重试：不做（本次 out-of-scope）

标题是一次性机会（后续 round 不再触发），网络抖动会导致该 session 保持默认名——但重试机制需要防抖、退避、与 session 退出的竞态处理，复杂度与收益不成比例。裁决：不做，留待真实失败频率数据支持后再议。若真发生，用户可手动 `/name`。

### D9 debug 证据链：`PI_RENAME_DEBUG=1` 环境变量控制，日志带时间戳 + turnIndex

debug 日志（`console.warn`，前缀 `[rename-session]`；**文案字面值是 E2E 断言的硬契约，实施时锁定不得漂移**。开关 helper 每次 live 读 `process.env.PI_RENAME_DEBUG`，非模块加载时读——保证可测与运行时切换）：

1. 触发跳过时（handler 侧，含 `t=<ISO时间>` 与 `turnIndex=<n>`）：`skip: stopReason=<r>` / `skip: count=<n>`（定位判定路径。turnIndex 只在此侧输出——它只在 handler 作用域可达，不为日志字段扩 callRenameLLM 签名；**此阶段不查 getSessionName**，防覆盖检查只在落库前——见 D5。另 `skip: no user prompt` 从 llm.ts 侧发出（extractUserPromptText null 时），格式同第 2 组只含 `t=`、无 turnIndex）；
2. 发请求时（**必须在 callLLM 调用之前打出**——构造 messages 后、发起请求前；A3 3b 竞态场景依赖轮询此日志在 rename 返回前抢入手动命名；含 `t=<ISO时间>`）：`LLM request messages: <JSON>`——每条 message 输出 `role + text 的 head 200 + tail 100 Unicode 码点`（v4 修正：截断单位与 truncateForTitle 统一为 Unicode 码点，非 UTF-16 码元；超长文本格式 `<head200>…<tail100>`，字面 `…` 连接；head/tail 双段支撑 E2E 对长 prompt 首尾片段的断言）；
3. 落库/跳过时（含 `t=<ISO时间>`）：`renamed to "<title>"`（v4 更新：移至 index 侧 `.then()` 内 `setSessionName` **之后**打出，handler 侧带 `t=` + `turnIndex=`——竞态命中时只打 `skip: name exists`、无 `renamed to`，日志不再出现「声称 renamed 但未落库」的矛盾）/ `skip: title empty`（cleanTitle 清洗后为空时在 callRenameLLM 内打出）/ `skip: name exists`（唯一文案，防覆盖命中，index 侧 `.then` 内打出）。

默认关闭时上述 7 条 debug 日志零输出；另有 3 条**常开** `console.warn`（不受 `PI_RENAME_DEBUG` 控制，供生产 stderr 诊断）：成功路径无条件记录 `rename with model <provider>/<id>`（llm.ts 发出）、失败路径 `rename LLM call failed: <err>`、选模失败 `model not available, skipping`。debug 日志是 E2E 验收（§8）的证据基础：**日志内省的是传给 `callLLM` 的同一对象**（同进程同函数序列化同一变量），日志内容即 LLM 收到的内容。

## 7. 实现机制（把终态落到代码层）

**本章结论：四个文件中三个改动、一个不动，新增纯函数均可单测，E2E 用脚本 + 断言工具落地。**

### 7.1 `pure.ts` 新增/修改

```ts
// 新增：成功-turn 计数
export function countSuccessfulAssistantReplies(entries: ReadonlyArray<EntryLike>): number
// EntryLike 扩展：message?: { role?: string; stopReason?: string }

// cleanTitle 增强：尾部标点（。．.，,、;；!！?？：:——半角 ? 与全角 ？ 两者）加入现有首尾清理正则
```

`countAssistantReplies` 保留导出（兼容），触发判定不再使用。

### 7.2 `llm.ts` 新增/修改

```ts
// 新增纯函数（均可单测）：
export function extractUserPromptText(entries: ReadonlyArray<EntryLike>): string | null
// 取首条 role==='user' 的 message：content 为 string 直接用；为 blocks 数组时取 type==='text' 的 text 拼接（跳过 ImageContent——标题模型可能不支持图片输入）
export function extractFinalText(message: unknown): string
// 触发 turn 的 event.message（宽松类型）中取 text blocks 拼接（跳过 ThinkingContent/ToolCall）
export function truncateForTitle(text: string, maxCodePoints = 4000): string
// Unicode 码点截断 + "…" 后缀
export function buildTitleMessages(userPrompt: string, finalText: string, instruction: string): Message[]
// 返回 [user(prompt), assistant(finalText 仅非空时), user(instruction)]

// callRenameLLM 签名变更：接收 finalMessage（触发 turn 的 event.message）
export async function callRenameLLM(ctx, config, finalMessage: unknown): Promise<string | null>
// 内部：extractUserPromptText(entries)（null → debug 日志 + 返回 null）
//      + extractFinalText(finalMessage) + truncate + buildTitleMessages
// 新增：timeoutMs: 30_000；D9 debug 日志
```

删除：`buildMessages`（全量前缀版）及其「kvcache」注释。**测试销毁范围**：`llm.test.ts` 的 `buildMessages` describe（LTC1/LTC2/LTC3）整组删除并以新纯函数测试替代；`callRenameLLM` 既有用例改新签名（加 `finalMessage` 参数）。

### 7.3 `index.ts` 修改

```ts
pi.on("turn_end", async (event, ctx) => {
	// 开关 + subagent 排除（不变）
	// 新：event.message.stopReason !== "stop" → return + debug 日志（O(1) 快速路径）
	// 新：countSuccessfulAssistantReplies(entries) !== 1 → return + debug 日志
	// fire-and-forget：
	void callRenameLLM(ctx, config, event.message)
		.then((title) => {
			if (!title) return;
			// 防 LLM 调用窗口竞态：落库前重查（D5）
			if (pi.getSessionName()) { debug日志 "skip: name exists"; return; }
			pi.setSessionName(title);
			// 落库后打出（handler 侧，带 t= + turnIndex=；竞态命中时只打 skip、无此行）
			debug日志 `renamed to "${title}"`;
		})
		.catch((e) => console.error("[pi-rename-session] rename LLM failed:", e));
});
```

handler 同步段另有 try/catch 兜底：同步路径任何抛错只 `console.error` 记录，不阻断 pi 的 agent 循环。

发起调用前不查 `getSessionName()`（那时查不能防竞态，落库前重查才是权威检查点）。`TurnEndLikeEvent.message` 从 `unknown` 收紧为带 `stopReason?: string` 的宽松结构类型。**测试销毁范围**：`index.test.ts` 中依赖 `countAssistantReplies===1` 旧判定的触发用例全部改造。

### 7.4 prompt 常量与测试改造

- `RENAME_SYSTEM_PROMPT` / `RENAME_INSTRUCTION` 按 D4 重写；单测断言两常量含正例与反例锚定文本；
- 单测：新纯函数全覆盖（提取/截断/image 过滤/空 final text 降级/null 路径/计数三场景/prompt 常量）；
- 集成测试（mock callLLM 层）：handler 编排正确性（触发/各跳过分支/防覆盖/传参含 event.message）。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：5 个 E2E 场景（含 1 个竞态子场景），全部真实 pi 进程 + 真实模型 + 真实 session 文件，以日志内省 + 双流交错时序 + 内容匹配为证据链；单测只作为门禁不作为验收。**

### 8.1 改动规模

大改动（行为变更：触发时机、输入构造、标题风格、失败语义均变）——按大改动配多个真实场景。

### 8.2 E2E 基础设施（所有场景共用）

- 真实 pi：`pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <本地 extensions/rename-session 路径>`，stdin 发 JSONL prompt 命令，stdout 收事件流、stderr 收扩展日志，**两流由 harness 交错写入同一时间轴文件**（各带到达时间戳）；
- 配置隔离：`PI_CODING_AGENT_DIR=<tmp>` 指向临时目录（写 enabledModels + 开启 rename 的 flag 文件）；
- `PI_RENAME_DEBUG=1` 开启证据日志；
- 断言对象：session JSONL 文件（行序 + entry 内容）+ 交错时间轴日志文件。

**回应用户三问（验收方法的可验证性依据）**：

1. **「如何验证一定是（round）结束后输入了 LLM」**——三重互补证据：
   - **双流交错时序**（发起时序的直接证据；v4 口径修正——「日志行到达时刻严格晚于 message_end 到达时刻」不可靠，pi 先调 handler 再写 stdout 有 ~1ms 通道伪影）：**流序判别为主**——交错时间轴上 `LLM request` 日志行之后无后续 turn_start/message_start/message_end 事件（turn_end 除外）；**时刻辅助**——`llmReq.t >= 最终 message_end.t - 1000ms` 容差；且 round 中间每个 iteration 的 `turn_end` 之后只有 `skip: stopReason=toolUse` 类日志、无 `LLM request`；
   - **内容匹配**（判别器，能证伪中途触发）：若实现在中途 iteration 触发，注入的 assistant 文本 ≠ 该 round 最终 assistant message 文本——断言日志中 assistant 段 text 与 session JSONL 最后一条 `stopReason:"stop"` assistant message 的文本一致，中途触发必不满足；
   - **JSONL 行序**（完成时序佐证）：`session_info` entry 位于该 round 全部 entry 之后（中途发起、稍后完成的调用也满足行序，故仅作佐证不作判别器）。
2. **「如何验证 LLM 收到了用户 prompt 和 turn last text」**——debug 日志内省：日志打出传给 `callLLM` 的每条 message 的 role + text（head 200 + tail 100 码点，同一对象序列化，日志即请求体；截断单位与 truncateForTitle 统一为 Unicode 码点）。断言：user 段含 prompt 首部特征片段、assistant 段含 final text 特征片段，且**不含**任何 toolResult 内容片段（负向断言，证伪全量注入残留）。
3. **「system prompt 是否优化 rename 质量」**——是，D4 重写为 slug 约束 + 正反例 few-shot，验收场景 A2 用规则断言（词组形态、无句尾标点、无代词开头）+ 人工抽查语义相关性。

### 8.3 验收场景

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| A1 | 工具型首轮：触发时机 + 输入内容 | G1 G4 | 真实 pi + 真实模型，发「列出当前目录的 ts 文件并统计行数」（触发多个 iteration），等 round 完成 + rename 完成 | ① 交错时间轴（流序判别为主）：`LLM request` 行之后无后续 turn 事件（turn_end 除外），时刻辅助 `llmReq.t >= 最终 message_end.t - 1000ms` 容差；中间 iteration 的 turn_end 后只有 skip 日志；② request 日志仅一条，其 user 段含「ts 文件」片段、assistant 段含 final text 特征片段、无 toolResult 内容片段（如文件列表原始输出）；③ 日志 assistant 段与 JSONL 最后一条 stop assistant message 文本一致；④ `session_info` 行位于 round 全部 entry 之后 |
| A2 | slug 标题风格 | G2 | 3 个真实 prompt：中文任务（「帮我写一个防抖函数并加单测」）、英文任务（"Refactor the config loader to support env overrides"）、跟进型 prompt（fixture 依赖：tmp cwd 放 notes.md 锚点「正在实现 debounce，下一步加 leading」，新 session 首条即「继续刚才的，改成支持 leading 选项」——空 tmp cwd 会诱发模型自由探索、击穿 runner 的 600s settled 等待上限，fixture 控时长且保留跟进语义；场景由「无上下文模糊跟进」调整为「有最小锚点的跟进」） | 每个 session 的标题过 assertTitleGuards 代理规则：≤50 码点；无句尾标点（断言集为 cleanTitle 清洗集的标点子集）；不以代词或「我」开头（中文）+ 不以 we/i/this 开头（英文，带 `\b` 词边界）；英文 kebab-case 正则；不以时态助词「了/过/中」结尾；人工抽查语义相关与词组形态（非完整句子）。**kebab-case 断言依赖模型遵从**：英文标题若非 kebab-case，按 §11.3 处置（prompt 微调后重跑），再不满足则升级为 cleanTitle 硬转换预案，不无限重试 |
| A3 | 防覆盖手动命名（含竞态窗口）+ 一次性语义 | G3 | 3a 静态：先经 RPC `set_session_name` 命名「我的手动名字」，再发 prompt 触发首轮；3b 竞态：发 prompt 后事件驱动等待（waitForStderr 行到达即触发，时间轴回查防丢早到日志），`LLM request` 一出现立即 RPC `set_session_name` 命名「竞态命名」，等 rename 返回；3c 一次性：3a 后同 session 发第二条 prompt | 3a/3b：turn 完成且等待 ≥10s 后，JSONL 最后一条 `session_info` 的 name 仍为手动名（3b 为「竞态命名」），debug 日志出现 `skip: name exists`；3c：无新 LLM request、无新自动 `session_info`，正向证据 `skip: count=2`。3b 固有时序 flakiness：若 rename 返回快于「等待触发 + RPC 往返」，日志断言 miss 则重跑（上限 2 次、共 3 次尝试；mimo 标题生成通常 1-3s，偶发即可） |
| A4 | error 轮不命名、下一成功轮仍命名 | G3 | 两阶段：阶段 1 用指向 `http://127.0.0.1:1` 的 provider 配置发首条 prompt → round error；阶段 2 改回正常配置，**重启 pi 并以 `--session <文件>` 恢复同一 session**（配置在进程启动时读取，必须重启续跑），发第二条 prompt → 成功 | 阶段 1 后无 `LLM request` 日志、无自动 `session_info`（error turn 的 turn_end 被 stopReason 快速路径挡掉）；阶段 2 round 成功后 `session_info` 出现且为 slug 标题（assertTitleGuards 断言） |
| A5 | 超时兜底 | G3 | 本地起一个接受 TCP 连接但不响应的 socket（node 一行脚本），标题 provider baseURL 指向它（主模型正常），发 prompt 触发 rename 调用 | 主 round 正常完成；≥25s 下限后超时失败日志出现（25s 下限用于区分超时路径与亚秒级连接错误路径；RENAME_TIMEOUT_MS 仍为 30s，runner 等待上限 45s 覆盖；该日志为常开 warn，非 debug 专属）；session 无自动 `session_info`；pi 进程不退出、后续命令正常响应 |

补充门禁（非验收）：`pnpm extensions:typecheck` / `pnpm extensions:lint` / `pnpm extensions:test` 全绿；新纯函数单测覆盖 §7 列举的分支。

### 8.4 明确不做的验收

- 不在 xyz-agent 桌面端验证（按项目规范，pi extension 优先本地 pi 实测；桌面端集成是发布后事项）；
- 不 mock `callLLM` 充当 E2E（mock 只出现在集成测试层）。

### 8.5 runner 基础设施（v4 实施期补记）

场景 runner（`run-aN.mjs` / `run-all.mjs`，基于 `harness.mjs`）落地时固化的基础设施约定：

- **失败四分类**：`assertion` / `timeout` / `pi-crash` / `api-error`；RPC 失败归并规则——pi 进程已死 → `pi-crash`，否则 → `assertion`。任一失败（含 KEBAB_NON_COMPLIANT）exit code → 1。
- **session_info 落盘等待**：`waitSessionInfoEntry` 轮询 session JSONL（300ms 间隔 / 10s 上限）——pi 的 append→flush 延迟不定，固定 sleep 不可靠，必须轮询到行出现。
- **E2E/CI 隔离**：根 `vitest.config.ts` include 为精确白名单（`src/__tests__/**` + `e2e/harness.test.mjs`），不含 `scenarios.test.mjs`；E2E 场景的 vitest 入口是专用 `e2e/vitest.e2e.config.ts`（`npx vitest run --config e2e/vitest.e2e.config.ts`）。E2E 为本地人工验收资产，不进常规 CI。
- **E2E_QUICK 分流**：cw testRunner 硬编码 120s 命令超时，真实模型全量必超——`E2E_QUICK=1` 只验单测骨架（秒级），全量 A1-A5 人工触发；正式验收证据 = RESULTS.md + 各场景跑记录。

## 9. 实施

**本章结论：三阶段交付——纯函数地基 → 编排改造 → E2E 验收固化。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | 纯函数层：提取/截断/计数/prompt 常量 + 单测 | G1 的输入构造能力、G2 的风格约束载体 |
| M2 | 编排层：handler 判定改造 + callRenameLLM 改造 + debug 日志 + 超时 + 防覆盖 + 既有测试改造 | G3 G4 全部、G1 G2 接通 |
| M3 | E2E：场景 A1-A5 脚本 + 交错时间轴 harness + README/CHANGELOG/changeset | 验收可执行、证据链固化、发布合规 |

## 10. 下一层拆分（cw unit）

| unit | 说明 | justification（为什么这么拆） |
|---|---|---|
| U1 pure 函数 + prompt 常量 | `pure.ts`/`llm.ts` 新纯函数与常量重写 + 全部单测 | 纯函数无依赖可先行，是 U2 的地基；单测密度最高的部分独立成单元 |
| U2 编排改造 | `index.ts` + `callRenameLLM` 改造 + 既有测试销毁重建 + 集成测试（mock callLLM 层） | 行为变更集中点，与纯函数分离便于审查 diff |
| U3 E2E 验收 + 发布物 | A1-A5 脚本（`extensions/rename-session/e2e/`）+ 交错时间轴 harness + 运行通过 + README 更新 + `.changeset/<slug>.md`（行为变更 body 进 CHANGELOG） | 验收独立成单元，失败不阻塞功能代码合入判断；脚本固化为回归资产；changeset 是项目发布规范要求的 PR 交付物 |

## 11. 待验证检查点（实施期验证，不阻塞设计）

1. **A4 的 `--session` 恢复与两阶段配置切换**实操细节（pi CLI flag 已核实存在，具体续跑行为实施期验证）；
2. **A2 跟进型 prompt（「继续…」）的标题质量**——若实测语义空洞，instruction 中提高 assistant 结论权重（prompt 微调，非结构改动）；
3. **模型对 slug 约束的遵从率**——若 prompt 微调一次后英文仍非 kebab-case，启用 cleanTitle 硬转换预案（仅对纯 ASCII 标题做空格→连字符 + 小写化，避免中英混合误伤）；
4. **debug 日志对交错时间轴的粒度**——若 stderr 缓冲导致到达时间戳失真，改用 pi 扩展日志文件（`PI_EXT_DEBUG=1` 落盘路径）与 stdout 事件流的文件 mtime + 行序双证据。

## 12. xyz-agent GUI 联动影响评估（实施后审查结论）

**本章结论：无 must-fix 级影响；两个存量「需注意」项与本次改动的交互面已知，可作后续独立 issue。**

审查范围：session 标题进入 GUI 的双数据源链路（runtime 内存 label + 磁盘扫描 `extractSessionName` 取最后一条 session_info）、`session_info_changed` 事件全链（pi → RPC stdout → event-adapter 翻译 `session.renamed` → renderer `updateLabel`）、GUI 手动重命名入口（`RenameSessionDialog` → WS `session.rename` → runtime out-of-band 直接 append JSONL）、`auto-rename-enabled` flag 契约两侧对齐。

| 变化点 | 定级 | 依据 |
|---|---|---|
| 触发时机变晚（round 末） | 需注意（存量） | 新 session 创建即有 label（创建时传入，或 basename(sessionCwd) 兜底），无「未命名 session」依赖；标题晚几秒出现只是初始 label 显示时间变长 |
| slug/kebab 标题风格 | 无影响 | 显示纯 CSS truncate，无格式正则/排序/去重假设；手动重命名校验仅长度 1-60（maxTitleLength 50 < 60）；prompt 约束语言跟随对话，中文对话仍得中文标题 |
| 两段输入 | 无影响 | extension 内部输入构造，不触 GUI 链路 |
| 防覆盖 guard | 需注意（存量缺口） | guard 查 `pi.getSessionName()`（pi 进程内存）；GUI 手动改名是 runtime out-of-band 直接 append JSONL，pi 不知情 → 首轮竞态窗口内 GUI 手动改名仍会被 auto 标题覆盖。**非本次回归**（旧版无 guard 同样覆盖，新版至少保护 pi 可见改名）；修复方向：runtime `renameSession` 时同步通知 pi，或 extension guard 兼查 JSONL 尾部 |
| 30s 超时 | 无影响 | fire-and-forget 静默跳过，GUI 无等待态 |
| PI_RENAME_DEBUG 日志 | 无影响 | pi stderr 被 runtime 收集进 Electron 日志（无 UI 通道）；7 条 debug 日志默认关闭零输出，另有 3 条常开 warn（model not available / call failed / rename with model） |
| 配置 schema/flag 契约 | 无影响 | SystemPage 开关 → flag 文件 ↔ extension live 读，两侧对齐未动 |

另发现一个与本次改动无关的存量现象：auto-rename 落库后 runtime 内存 `ManagedSession.label` 不随 `session.renamed` 事件更新，后续 `config.sessions` 全量广播可能把侧栏已显示的 auto 标题回退成派生 label（直到重启从磁盘读回）。本次命名时机变晚会拉长该现象的观察窗口，机制本身非本次引入。

## 附录：变更历史

- v1：初版（注入两段信号 + slug 风格 + 可靠性补齐 + E2E 验收设计）。
- v2：按对抗式审查修正——turn 语义模型（turn=iteration，turn_end 每 iteration 一次；重写 §3.2 失败模式 A/D-3、§4 数据流、D2 论证为 stopReason 快速路径）；防覆盖检查移至 `.then()` 落库前重查（D5/§7.3，堵 LLM 调用窗口竞态）；证据链论证修正（内容匹配为主判别器 + 双流交错时序，JSONL 行序降为佐证；日志加时间戳/turnIndex + head/tail 双段）；length stopReason 处理文档化（D6）；A2 kebab-case 失败处置路径；A4 补重启续跑机制；U3 补 changeset；token 估算修正；测试销毁范围与 null 路径补全。
- v3：实施后补充——D9 日志契约与实现对齐（turnIndex 仅 handler 侧、skip: no user prompt 归类修正、head200+tail100 截断格式）、§12 GUI 联动影响评估（无 must-fix；防覆盖对 GUI out-of-band 改名的存量缺口与修复方向）。
- v4：对抗式审查回填，性质 = 实施期演进 + 实现细节对齐（约 20 处文档/发布物与代码不一致的记录漂移）。D9：`renamed to` 移至 index 侧 `setSessionName` 之后（竞态命中只打 skip: name exists）、preview 截断单位统一 Unicode 码点、补 3 条常开 warn 口径；§7.1 cleanTitle 尾部标点补全角 ？；§5.2 日志文案对齐（model not available, skipping）；§7.3 补 handler 同步段 try/catch 兜底；§8：A1 时序口径改流序判别为主 + 1000ms 时刻容差、A2 补 fixture 依赖与完整代理规则、A3 改事件驱动等待 + 重跑上限 2 次 + 补 3c 一次性语义、A4 补 assertTitleGuards、A5 改 ≥25s 下限、新增 §8.5 runner 基础设施；§12：label 来源修正 + 常开日志口径限定。
