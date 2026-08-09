# 三个 pi extension 改造设计：结构化载体 + 去协议层 + 测试按价值分层

> **一句话结论**：用三条主线把 `pi-ask-user` / `pi-scheduler` / `pi-structured-output` 改成"结构上不可能错"（by construction）——① ask-user 答案改结构化单模型、删 comment、消除反解析；② scheduler 抽后端接口去双轨；③ structured-output 拆模块。测试按 test-quality 三层重构成"能抓回归的最小集"。

## 开篇（SCQA）

- **S（情境）**：三个 extension 共 3753 行实现 + 6247 行测试，提供 pi 的用户交互（ask-user）、定时任务（scheduler）、结构化输出（structured-output）能力。
- **C（冲突）**：架构审查发现 11 个问题（ask-user 4 / scheduler 4 / structured-output 3），竞品调研（codex-cli + claude-code）印证根因——答案字符串化后反复解析、tool/command 双轨编排、单文件职责堆叠、测试含凑数与假测试。
- **Q（问题）**：如何用最小改动把三个 extension 改成"靠结构保证正确"，而非靠精巧机制（机制一崩全崩）？
- **A（答案）**：三条主线——减法优先，删 comment、砍协议层、拆大文件，让数据在生命周期里只结构化一次；测试只留能抓回归的。本文展开这个答案。

---

## §1 背景：被设计的系统是什么

**三个 extension 是 pi（AI coding agent）的独立能力插件，各自通过 `registerTool`/`registerCommand` 注入 agent 能力。** 本次设计聚焦它们内部的数据模型与分层，不改它们与 pi 的集成方式。

| extension | 能力 | 使用者 | 规模（src/实现） | 现有测试 |
|---|---|---|---|---|
| ask-user | agent 遇到无法自决的歧义时，弹 TUI 让用户选（单/多问题、选项+自由文本） | agent 调 tool；终端用户在 TUI 操作 | 10 文件 2140 行 | 5118 行（18 测试文件） |
| scheduler | 定时/周期注入 message 到当前 session（cron/interval/once） | agent 调 `schedule` tool；用户用 `/schedule` 命令 | 9 文件 1156 行 | 1329 行（9 测试文件） |
| structured-output | workflow 模式下强制 agent 产出符合 schema 的 JSON，并 turn_end 重试 | workflow 子进程的 agent 调 `structured_output` tool | 1 文件 457 行 | 816 行（2 测试文件） |

**本次设计性质**：技术方案设计（下一层产物 = 可实现的接口/数据模型 + 任务拆分）。因此涉及运行时数据流、错误处理、运行时断言——tech-design 准则 5/6/7 全部 P0 适用。

## §2 设计目标与 scope

**改造后，agent 和终端用户的能力不变，但实现"靠结构保证正确"，且测试只留能抓回归的。**

1. **ask-user**：agent 调 tool 拿到的答案、TUI 渲染用的答案、channel 透传的答案，是同一个结构化对象，全程不被字符串化再反解析；comment 功能删除。
2. **scheduler**：tool 与 command 共享同一套编排逻辑；调度后端可注入 mock，runtime 逻辑可单测；无死循环隐患。
3. **structured-output**：校验、守卫、hook 三类职责分文件；权威模式也跑 keyword-less 防御；hook 状态机有测试覆盖。
4. **测试**：纯逻辑（解析、格式化、状态计算）下沉层 1 并用 property-based；集成测试只测模块协作；删除 comment 测试、假测试、凑数断言。

**In-scope**：三个 extension 的 src 重构 + 测试重构 + 删 comment + 补 README（scheduler）。
**Out-of-scope**：三个 extension 与 pi 的集成协议（registerTool/registerCommand 机制不变）；新增功能（不加 multiSelect/is_secret 等 codex/claude-code 才有的字段，留作后续）；版本发布策略（changeset 在实施期定）。

---

## §3 现状：使用者与代码眼里是什么样的

### 3.1 ask-user：答案被字符串化，再费力反解析回来

**ask-user 的答案本该是结构化的，却被降级成字符串，下游再反解析——这是 11 个问题里最贵的一个。**

答案在交互状态 `QuestionState`（`types.ts:127-158`）里本是结构化的：

```ts
interface QuestionState {
  selectedIndex: number | null;      // 单选：选中的选项 index
  selectedIndices: Set<number>;       // 多选：已 toggle 的选项集合
  freeTextValue: string | null;       // Other 自由文本
  commentValue: string | null;        // ← comment 功能，本次删除
  mode: "options" | "freeform" | "comment";  // ← "comment" 本次删除
  // ... 光标、草稿等
}
```

但 `Result.answers` 的类型是 `Record<string, string>`（`types.ts:106`）——把结构化答案**压扁成字符串**。`formatAnswer`（`answer-format.ts:15`）负责序列化：

```
selectedIndex=0 + commentValue="fast"  →  "Postgres — fast"
selectedIndices={0,1}                  →  "Postgres, MySQL"
freeTextValue="custom"                 →  "custom"
```

下游两处需要"从字符串还原回结构"，调用 `parseAnswerParts`（`answer-format.ts:29`，76 行 + 一大段注释）：
- `index.ts:91` `renderExpandedOptions`——判断哪些选项被选中（画高亮标记）
- `channel-handler.ts:106` `encodeTuiResultToProto`——subagent 透传时把字符串答案拆回 selected/other 喂给协议层

`parseAnswerParts` 的注释（`answer-format.ts:55-60`）自己承认：

> MF-7 固有歧义取舍……精确 label body 优先是更优启发**而非完备解**。

即**反解析在数学上不完备**，靠 label 集合的巧合规避 bug（label 自身含 ` — ` 分隔符时会和 comment 分隔符混淆）。这是一个真实 bug 温床。

**comment 功能放大了这个反模式**：`commentValue` 是 `QuestionState` 里的独立字段，却被 `formatAnswer` 用 `ANSWER_COMMENT_SEPARATOR = " — "`（`types.ts:13`）拼进同一个字符串，让歧义更严重（comment 文本里出现 ` — ` 就会和分隔符冲突）。

### 3.2 scheduler：tool 与 command 各写一套，还有死循环隐患

**scheduler 的 5 个动作（list/toggle/delete/run/create）在 tool 和 command 各有一套几乎相同的实现，且 cron 失效时会陷入死循环。**

`SchedulerRuntime`（`runtime.ts`）是深模块——CRUD + 调度 + 限流都在里面，deletion test 成立。但它的两个调用方各包了一层壳：

| 动作 | `tool.ts`（agent 调） | `commands.ts`（用户 `/schedule`） | 共同点 |
|---|---|---|---|
| list | `:75-82` 手写格式 | `:113-118` 手写几乎相同格式 | 都调 `runtime.listTasks()` |
| toggle | `:84-92` 校验 id+enabled | `:120-126`（on/off）校验 id | 都调 `runtime.toggleTask()` |
| delete | `:94-101` 校验 id | `:128-133` 校验 id | 都调 `runtime.deleteTask()` |
| run | `:103-110` 校验 id | `:135-140` 校验 id | 都调 `runtime.runTaskNow()` |
| create | `:34-53` 解析+addTask+摘要 | `:156-171` 解析+addTask+摘要 | 都调 `runtime.addTask()` |

改一个动作的行为（如 list 输出加一列）要同步改两处，否则 tool 和 command 产出漂移。

**死循环隐患**（`runtime.ts`）：cron 任务的下次执行时间 `nextRunAt` 在三处重算，fallback 策略不一致：

```ts
// runtime.ts:56（addTask）：无效 cron → throw
// runtime.ts:101（toggleTask）：const next = (...) ?? Date.now()
// runtime.ts:217（dispatchTask）：const next = (...) ?? Date.now()
```

`:101` 和 `:217` 的 `?? Date.now()`：若 cron 表达式在运行时失效，`nextRunAt` 落到"现在" → 下一个 tick（30s 内）立即再到期 → dispatch → 再次 `nextRunAt = now` → **死循环**。只有全局 `RATE_LIMIT_PER_MINUTE=6`（`runtime.ts:14`）隐式兜底，而 rate limit 是全局资源——一个坏任务会耗尽配额拖垮所有任务。

**僵尸类型**：`ScheduleMode`（`types.ts:3`）全 src 零引用；`TaskStatus` 声明 `'pending'|'running'|'success'|'failed'` 四态，但 `pending`/`running` 从不赋值（只赋 `success`/`failed`）；`ParseScheduleResult.note`（`parsing.ts:54`）产生即丢弃。

### 3.3 structured-output：457 行单文件塞 7 种职责，hook 状态机零测试

**structured-output 把校验、守卫、工具定义、workflow hook 全堆在一个文件里，其中 hook 的重试状态机完全没有测试。**

单文件 `index.ts`（457 行）混合 7 个关注点：Ajv 缓存（`:28`）、schema 守卫（`:48-156`）、JSON 工具（`:87-130`）、事件守卫（`:132-145`）、核心校验 `executeStructuredOutput`（`:159`，双路径塞一个函数）、tool 定义 `createToolDefinition`（`:276`）、workflow hook `setupWorkflowHook`（`:383`）。

**双路径塞一个函数**（SO-1）：`executeStructuredOutput` 用 `if (authoritative !== undefined) { ...; return }` 把"权威模式"和"日常防御链"硬塞一起。权威模式跳过日常防御链的依据是注释（`:130-131`）"权威 schema 由 workflow 脚本写死，不存在互换/keyword-less 风险"——但 workflow 脚本本身可能写出 keyword-less schema（`{}` 或 `{a:1}`），此时权威模式**照单全收**，日常防御链保护的东西权威路径完全不设防。

**hook 状态机零测试**（SO-3）：`setupWorkflowHook`（`:383`）用 4 个 mutable 闭包变量（`soCallCount`/`soSucceededEver`/`hookRetryCount`/`lastSchemaError`）构成隐式状态机，转移规则散在两个 event handler，依赖"同 turn 内所有 tool_execution_end 都在 turn_end 之前触发"的时序假设——**该假设未经实测**，且整个状态机无测试。

**假测试**：`structured-output.test.ts` 含"Enforcement flag logic"段——用 `if` 手动构造非真实代码路径的断言，不驱动真实生产代码（mutation 100% 存活）。

### 3.4 三方共性根因

**三个 extension 的问题收敛到三个共性根因——数据载体失当、协议层冗余、测试凑数。**

| 根因 | ask-user | scheduler | structured-output |
|---|---|---|---|
| **数据载体失当**（结构化数据被字符串化/压扁） | 答案 `Record<string,string>` + 反解析 | schedule 单 string 压 cron+duration 两义 | — |
| **协议层/转换层冗余** | internal/proto 双模型 + 四向转换 | tool/command 双轨壳 | 双路径塞一个函数 |
| **测试凑数** | 5118 行含大量 comment 流程测试 | runtime 硬编码不可单测 | 816 行含假测试段 |

这三个根因正是本次改造的三条主线要解决的。

---

## §4 物理数据流：ask-user 答案的字符串化往返（最典型）

**ask-user 答案在生命周期里被"结构化 → 字符串化 → 反解析"折腾两次，这是 §3.1 反模式的物理表现。**

```
[TUI 用户操作]
   ↓ 写入 QuestionState（结构化：selectedIndex/Set/freeTextValue）
[component.ts] confirm
   ↓ submit-view.ts:47 formatAnswer() ── 序列化 ──▶ "Postgres — fast"
[Result.answers: Record<string,string>]  ← 这里降级成字符串
   ↓
   ├─▶ [index.ts:173 protoAnswersToResult → formatAnswer] RPC 路径出口
   │       ↓
   │   [index.ts:91 renderExpandedOptions → parseAnswerParts] ◀── 反解析回 selected[]
   │       ↓ 画选项高亮标记
   │
   └─▶ [channel-handler.ts:106 encodeTuiResultToProto → parseAnswerParts] subagent 透传
           ↓ 反解析回 selected/other 喂给协议层
       [proto AskUserAnswers]
```

**关键论断**：`parseAnswerParts` 不是凭空存在的——它存在**唯一**的理由是 `formatAnswer` 把结构化答案字符串化了。如果 `Result.answers` 直接存结构化值，`parseAnswerParts` 连同它的 76 行启发式歧义处理**整体消失**（准则 8：减法优先——砍掉根因，症状自动消失）。

> **术语锚定**：**结构化答案模型** = 答案的规范表示，形如 `{ selected: string[]; other: string|null }`（selected 是选中的 label 数组，other 是 Other 自由文本）。就是上面 `QuestionState` 里 `selectedIndex/selectedIndices/freeTextValue` 提取后的形态。改造后这个模型从 `QuestionState` 一路传到 `Result.answers`、channel 透传、proto 编码，全程不被字符串化。

---

## §5 终态：使用者眼里将是什么样的

### 5.1 ask-user 终态：单结构化模型，无 comment

**改造后，agent 调 ask-user 拿到结构化答案，TUI 与 channel 透传用同一个对象，全程无字符串往返；comment 功能消失。**

成功路径（agent 视角）：

```
[agent] 遇到歧义，调用 ask_user({questions:[{question:"用哪个 DB?", options:[{label:"Postgres"},{label:"MySQL"}]}]})
[tool execute]
   ↓ validateInput（options 可能含 string 误用，友好拦截）
   ↓ runTuiInteraction → 用户在 TUI 选 Postgres + 输 Other "需要 TLS"
   ↓ component 提取 QuestionState → AnswerValue { selected:["Postgres"], other:"需要 TLS" }
[Result.answers] = { "用哪个 DB?": { selected:["Postgres"], other:"需要 TLS" } }  ← 结构化，无 comment
   ↓ protoAnswersToResult：直接读 AnswerValue，调 encodeAnswer 渲染成协议字符串（仅协议边界）
[agent 收到] tool result，details.answers 结构化可用
```

注意：**协议边界仍需序列化**（proto `AskUserAnswers` 是 `Record<string,string>`，pi 协议固定），但序列化只在"出 extension、进 pi"的边界发生**一次**，且是单向（结构化 → 字符串），**不再反解析回来**——因为 extension 内部（renderExpandedOptions、channel-handler）都用结构化值，不碰字符串。

失败路径（带恢复指引）：

```
[agent] options 传了裸字符串数组 ["A","B"]
[validateInput] 抛错：
  "Each option must be a {label, description} OBJECT, never a bare string.
   Correct: options:[{label:'A'},{label:'B'}].
   👉 收到 options:[\"A\",\"B\"]"
[agent] 按纠错重试
```

### 5.2 scheduler 终态：共享编排，可单测

**改造后，tool 与 command 共享同一套编排；调度后端抽成接口，runtime 可注入 mock 单测。**

成功路径：

```
[agent] 调 schedule({name:"daily-check", schedule:"1h", prompt:"check deploy"})
   ↓ tool handler → SchedulerService.create(parseResult)  ← 共享编排
[SchedulerService] 校验 + 调 SchedulerBackend.addTask + 产出结构化结果
   ↓ tool handler 包成 {content, details}; command handler 包成纯文本字符串
[SchedulerRuntime] 持久化 + 排入 tick

[测试] const runtime = new SchedulerRuntime(mockBackend);  ← 注入 mock，不碰 pi.sendMessage
       runtime.addTask(...); assert nextRunAt 正确
```

失败路径（cron 失效，带恢复指引）：

```
[runtime.dispatchTask] computeNextRunAt 返回 undefined（cron 失效）
   ↓ 不再 ?? Date.now()（消除死循环）
   ↓ task.enabled = false; task.lastStatus = 'failed'; task.lastError = 'cron expression invalid'
[用户] /schedule list 看到 ●daily-check (disabled, last error: cron invalid)
   👉 用 /schedule rm <id> 删除，或 /schedule on <id> 用新 schedule 重试
```

### 5.3 structured-output 终态：拆模块，权威模式也设防

**改造后，校验、守卫、hook 分文件；权威模式也跑 keyword-less 防御；hook 状态机有测试。**

```
extensions/structured-output/src/
  ├─ index.ts              ← 仅 extension entry（registerTool + 注册 hook）
  ├─ ajv-validator.ts      ← Ajv 缓存 + getOrCompileValidator（纯逻辑，层1可测）
  ├─ schema-guards.ts      ← keyword 检测 + swap 检测 + 各类守卫（纯逻辑，层1可测）
  ├─ execute.ts            ← executeStructuredOutput（权威/日常两函数，都过 schema-guards）
  ├─ tool-definition.ts    ← createToolDefinition
  └─ workflow-hook.ts      ← setupWorkflowHook + 显式 RetryState（有测试）
```

成功路径不变（agent 调 structured_output，校验通过）。失败路径（权威模式遇到 keyword-less schema）：

```
[workflow 脚本] PI_WORKFLOW_SCHEMA='{}'  ← keyword-less，本该被拒
[executeStructuredOutput 权威分支] 不再照单全收
   ↓ assertJsonSchemaRoot 通过，但 hasSchemaKeyword(authoritative) === false
   ↓ 抛错：
  "Authoritative schema (PI_WORKFLOW_SCHEMA) has no recognized keyword.
   A workflow schema must describe shape via type/properties/items/...
   👉 检查 workflow 脚本的 outputSchema 定义，补全 JSON Schema 关键字。"
```

---

## §6 关键决策与权衡

### D1：ask-user 答案数据模型——单结构化模型，去协议转换层

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A（选）单结构化模型 + 协议边界单向序列化** | `Result.answers: Record<string, AnswerValue>`，`AnswerValue={selected:string[], other:string\|null}`。internal 与 proto 合并为单 Question 模型（proto 的 `value` 字段 = `label`，没必要分两套）。`parseAnswerParts` 整体删除。协议边界（出 extension 进 pi）单向 `encodeAnswer(value)→string`，不再反解析。 | 中：改 Result 类型 + 删 answer-format 反解析 + 改 channel-handler/index 直接读结构化值。有测试覆盖兜底。 | 低-中：Result 类型变更是 breaking（但 extension 内部消费，无外部消费者）。 | ✅ |
| B 保留 proto/internal 双模型 + 四向转换，只修 parseAnswerParts 歧义 | 不解决根因，反解析启发式仍存在，只是补 case。adapter 层是冗余 pass-through。 | 低（只补测试 case） | 高：启发式不完备性是持续的 bug 维护负担。 | ❌ |

**被否若用 B**：§5.1 的 agent 调用链里，`Result.answers` 仍是字符串，`renderExpandedOptions` 和 `channel-handler` 仍要调 `parseAnswerParts`，label 含 ` — ` 时仍可能误判选中项——§3.1 的 bug 温床原样保留。

**决策依据**：竞品 codex 用 `is_other` 单一 freeform + 前缀编码扁平化，**根本不反解析**（竞品报告 §1.4）；用户决策 2 明确"全局一套模型，不要不必要的协议层/domain 层转换"。方案 A 是减法（准则 8）——砍掉根因（字符串化），症状（反解析、双模型、四向转换）整体消失。

### D2：comment 功能——彻底删除

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A（选）彻底删除** | 消除 `commentValue` 字段、`QuestionMode:"comment"` 状态、`ANSWER_COMMENT_SEPARATOR`、`formatAnswer`/`parseAnswerParts` 的 comment 分支、component 的 comment mode 状态机、channel 的 `__comment` 协议。同步简化 D1（AnswerValue 无 comment 字段）。 | 中：删 8 处源码 + 大量 comment 测试（component.test.ts C-33~C-39、w2/w3、answer-format comment 用例）。 | breaking：schema 删 `allowComment` 字段，旧调用方传该字段会被 schema 拒（typebox 默认拒绝 unknown 当 additionalProperties:false 时）。 | ✅ |
| B 保留 comment，仅把它结构化进 AnswerValue | comment 仍是独立维度，TUI 仍需 comment mode 状态机，协议仍需 `__comment` key。复杂度保留。 | 低-中 | comment 的产品价值不明（codex/claude-code/MCP elicitation 均无独立 comment 概念，竞品报告 §1.1/§1.2）。 | ❌ |

**被否若用 B**：§5.1 的 AnswerValue 变成 `{selected, other, comment}`，comment mode 状态机、comment 渲染、`__comment` 协议编码全部保留，D1 的简化收益打折。

**决策依据**：用户决策 1 明确"comment 彻底删除"；竞品印证 comment 是 pi-ask-user 独有且无对标的功能（竞品报告 §1.1/§1.2）；comment 深度参与 §3.1 反解析反模式（`commentValue` 被 `formatAnswer` 字符串化是歧义主因之一）。删除同时简化 D1。

### D3：scheduler 架构——抽后端接口，去双轨

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A（选）抽 SchedulerBackend 接口 + SchedulerService 共享编排** | `SchedulerBackend` 接口（`sendMessage(msg,opts)` + `persist(store)` + `now()`），生产实现注入 pi API，测试注入 mock。`SchedulerService` 承载 5 动作的校验+调 runtime+产出结构化结果，tool/command 只包薄壳（包成 tool result 或纯文本）。 | 中：抽接口 + 建 service + 改 tool/command 调用。 | 低：runtime 逻辑不变，只是依赖反转。 | ✅ |
| B 全量 DDD（domain/application/infrastructure 三层 + 值对象 + 聚合根） | 过度设计——extension 只有 1156 行，没有复杂领域规则撑得起三层。引入大量样板。 | 高 | 高：抽象超过问题复杂度，维护负担反增。 | ❌ |
| C 只去双轨，不抽 backend 接口 | 解决 tool/command 重复，但 runtime 仍硬编码 `pi.sendMessage` + 文件 IO，不可单测（§3.2 ⑥测试盲区未解决）。 | 低 | 中：测试性问题遗留。 | ❌ |

**被否若用 B**：scheduler 只有"定时触发 + 注入 message + 记历史"这点领域逻辑，套聚合根/值对象/仓储是杀鸡用牛刀；§5.2 的 mock 注入反而被三层样板拖累。

**被否若用 C**：§5.2 的"`new SchedulerRuntime(mockBackend)` 单测"做不到，§3.2 的测试盲区原样保留。

**决策依据**：用户决策 2"参考 DDD/clean-arch 但简化"——方案 A 借鉴 clean-arch 的"依赖反转"（高层 runtime 不依赖低层 pi API，依赖接口），但不照抄 DDD 的全套战术模式。竞品 codex `CloudBackend` trait + MockClient 注入是正面参照（竞品报告 §2.4）。

### D4：structured-output 拆分粒度

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A（选）拆 6 模块（见 §5.3）** | 校验/守卫/hook/tool 各自独立，ajv-validator 与 schema-guards 是纯逻辑可层1单测。execute 拆权威/日常两函数。workflow-hook 显式 RetryState。 | 中：纯文件拆分 + execute 拆函数 + hook 状态机显式化。 | 低：行为不变，纯结构重构，有 816 行测试回归兜底。 | ✅ |
| B 保持单文件，只拆 execute 双函数 | 只解决 SO-1，SO-2（职责混杂）和 SO-3（hook 零测试）遗留。 | 低 | 中：单文件维护负担保留。 | ❌ |

**决策依据**：用户决策 2"结构简单的全局只一套模型，不要不必要的层"——但 structured-output 是**反例**：它 457 行确实需要拆（improve-codebase-architecture 审查 SO-2 deletion test：每个模块都 earn its keep）。方案 A 是"该拆的拆、不该加层的别加"。

### D5：测试重构策略——按 test-quality 三层

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A（选）三层重构：纯逻辑下沉层1 + property-based；集成只测协作；删凑数** | 符合 test-quality 核心原则（有效性优先于覆盖率、纯逻辑禁用集成测、一个 property 顶百 example）。 | 中：重新归类测试 + 写 property-based + 删 comment/假测试。 | 低-中：删测试需确认无回归保护丢失（mutation 视角）。 | ✅ |
| B 保留现有测试，只删 comment 相关 | comment 外的凑数/假测试/慢测试遗留。 | 低 | 中：测试债务保留。 | ❌ |
| C 推倒重写全部测试 | 抛弃已验证的回归保护（ask-user 18 文件含真实 e2e 按键模拟，价值高）。 | 高 | 高：丢失现有有效测试。 | ❌ |

**决策依据**：用户决策 3"测试代码规模大，参考 test skill 优化精简"。test-quality SKILL.md 核心原则：删掉被测代码改坏它也不会红的测试。ask-user 5118 行测试/2140 实现（2.4x）含大量 comment 流程测试（删 comment 后失效）；structured-output 假测试段（Enforcement flag logic）mutation 100% 存活。

---

## §7 实现机制：简化版分层（三 extension 目标结构）

**三个 extension 采用同一套简化分层原则：domain model = wire model（数据只有一套表示），只在有真实跨层差异时才加层。**

### 7.1 ask-user 目标结构

```
extensions/ask-user/src/
  ├─ types.ts          ← 单一 Question/AnswerValue 模型（合并原 internal/proto 双模型）
  ├─ validate.ts       ← 输入校验（options 含 string 误用的友好拦截）
  ├─ answer-codec.ts   ← AnswerValue ↔ 协议字符串（单向：仅协议边界 encode，无 decode）
  ├─ component.ts      ← TUI 交互状态机（无 comment mode）
  ├─ editor-ops.ts     ← 编辑器纯操作（freeform only，无 comment）
  ├─ question-view.ts  ← options/freeform 渲染（无 comment 渲染）
  ├─ submit-view.ts    ← 提交视图（formatAnswer 简化为无 comment）
  ├─ channel-handler.ts ← subagent 透传（直接读 AnswerValue，不调 parseAnswerParts）
  ├─ channel-registry-register.ts ← globalThis Symbol 握手（不变）
  └─ index.ts          ← extension entry + tool 定义 + execute（瘦身后职责清晰）
```

**关键变化**：
- `answer-format.ts` → `answer-codec.ts`：删 `parseAnswerParts`（整体），`formatAnswer` 简化为 `encodeAnswer(value: AnswerValue): string`（协议边界单向序列化，无 comment 分支）。
- `Result.answers: Record<string, AnswerValue>`（结构化），`AnswerValue = { selected: string[]; other: string | null }`。
- `QuestionMode = "options" | "freeform"`（删 "comment"）。
- proto 转换（原 `toProtoQuestions`/`protoAnswersToResult`/`renderExpandedOptions`）收拢：proto `AskUserQuestion.options` 的 `value` 字段直接用 `label`（两者本就相等，`index.ts:126` 注释已确认），消除 internal/proto 双模型。

### 7.2 scheduler 目标结构

```
extensions/scheduler/src/
  ├─ types.ts          ← 删 ScheduleMode（僵尸）、TaskStatus 收为 'success'|'failed'（删 pending/running）、删 ParseScheduleResult.note
  ├─ parsing.ts        ← computeNextRunAt 统一函数（消除三处重复）+ duration 单一常量表
  ├─ backend.ts        ← SchedulerBackend 接口（sendMessage/persist/now）
  ├─ runtime.ts        ← SchedulerRuntime 依赖 SchedulerBackend 接口（非 pi.sendMessage 硬编码）
  ├─ service.ts        ← SchedulerService：5 动作的校验+调 runtime+产出结构化结果（tool/command 共享）
  ├─ store.ts / format.ts / widget.ts / commands.ts / tool.ts ← 瘦壳（调 service）
  └─ index.ts          ← extension entry
```

**关键变化**：
- `SchedulerRuntime` 构造注入 `SchedulerBackend`，生产实现 `PiSchedulerBackend` 包装 `pi.sendMessage` + 文件 IO，测试注入 `MockSchedulerBackend`。
- `SchedulerService.create/list/toggle/delete/run` 是 5 动作的单一实现，`tool.ts`/`commands.ts` 只把结构化结果包成各自载体（tool result / 纯文本）。
- `computeNextRunAt(schedule, from)` 统一函数（parsing.ts），runtime 三处都调它；fallback 策略改为"无效 cron → 停用任务 + 标 failed"（消除 `?? Date.now()` 死循环）。

### 7.3 structured-output 目标结构（见 §5.3）

**关键变化**：
- `execute.ts` 拆 `validateWithAuthoritative(data, authSchema)` 与 `validateAgainstSelfReported(schema, data)` 两函数；**两者都先过 schema-guards 的 keyword-less 检查**（权威模式不再裸奔）。
- `workflow-hook.ts` 把 4 个 mutable 闭包变量提为显式 `RetryState`（集中转移表），配单元测试。
- `ajv-validator.ts`/`schema-guards.ts` 是纯逻辑，层 1 可直接单测。

---

## §8 测试策略（test-quality 落地，决策 3 重点）

**测试只留"删掉被测代码它会红"的断言。纯逻辑下沉层 1 + property-based，集成只测协作。**

### 8.1 三层归属

| 被测逻辑 | 层 | 重构动作 |
|---|---|---|
| ask-user `encodeAnswer`（AnswerValue→协议串）round-trip | 层 1 property-based | ∀合法 AnswerValue：协议侧能还原 selected（单向不需 full round-trip，但 encode 不丢信息） |
| ask-user `validateInput`（options string 误用拦截） | 层 1 | 纯函数，导出直接测 |
| ask-user TUI 交互（按键→状态转移） | 层 2 | 保留真实 e2e 按键模拟（component.test.ts 有效，保留）；删 comment 相关用例 |
| ask-user channel 透传（subagent 编解码） | 层 2 | 验证 AnswerValue 直传，不再测反解析 |
| scheduler `computeNextRunAt`/`parseSchedule`/`formatDuration` | 层 1 property-based | cron/interval 各种输入，nextRunAt 单调递增不变量 |
| scheduler `SchedulerService` 5 动作 | 层 1/2 | 校验逻辑下沉层1；调 runtime 用 mock backend 层2 |
| scheduler runtime 调度循环 | 层 2 | 注入 MockSchedulerBackend，测 tick/dispatch/限流 |
| structured-output ajv 校验/守卫 | 层 1 | 导出 getOrCompileValidator/守卫，纯函数测 |
| structured-output workflow hook RetryState | 层 1 | 显式状态机，测转移表（成功/未调用 steer/失败 steer/超上限/toolUse 不干预） |

### 8.2 删除/精简清单

| 删除目标 | 理由 | 依据 |
|---|---|---|
| ask-user 所有 comment 测试（component.test.ts C-33~C-39、w2-draft-hint、w3-regression comment 段、answer-format.test.ts comment 用例、channel-handler comment 用例） | comment 功能删除（D2） | 决策 1 |
| ask-user `parseAnswerParts` 全部测试 | 函数整体删除（D1） | AU-1 |
| structured-output "Enforcement flag logic" 假测试段 | 手动 if 构造非真实路径，mutation 100% 存活 | anti-padding 信号 1 |
| scheduler 无对应有效断言的 CRUD happy-path 重复 | 测框架不测逻辑 | anti-padding 信号 5 |

### 8.3 property-based 机会（test-quality 核心原则 4）

- **ask-user encodeAnswer**：`fc.record({selected: fc.array(fc.string()), other: fc.option(fc.string())})` → encode 后协议侧 parse 出的 selected 集合 ⊇ 输入 selected（不丢选中）。
- **scheduler computeNextRunAt**：∀合法 cron/interval + from → nextRunAt > from（单调）；interval → nextRunAt === from + intervalMs（精确）。
- **scheduler parseSchedule**：`'5m'`/`'2h'`/`'*/5 * * * *'` 等 → round-trip parse(format(x)) 稳定。

### 8.4 预期效果

ask-user 测试从 5118 行降约 30-40%（删 comment + 反解析 + 凑数），但回归保护力不降（保留有效 e2e + 补 property-based）。structured-output 删假测试段 + 补 hook 状态机测试，总行数持平但有效性提升。scheduler 补 runtime mock 测试（原本盲区），行数略增但覆盖关键路径。

---

## §9 实施：分阶段交付

| 阶段 | 内容 | 交付终态的什么 | 风险 |
|---|---|---|---|
| **M0** ask-user 删 comment + 结构化答案 | D1+D2：删 comment 全链路；Result.answers 改 AnswerValue；删 parseAnswerParts；合并 internal/proto 单模型；answer-format→answer-codec | §5.1 终态 | 中（Result 类型变更，有测试兜底） |
| **M1** ask-user 测试重构 | D5：删 comment 测试；encodeAnswer property-based；channel 透传改结构化断言 | §8 ask-user 部分 | 低 |
| **M2** scheduler 去双轨 + 抽 backend | D3：SchedulerBackend 接口 + SchedulerService；tool/command 瘦壳；computeNextRunAt 统一 + 死循环修复；清僵尸类型 | §5.2 终态 | 中 |
| **M3** scheduler 补 README + 测试 | 补 README；runtime mock 测试；parse/format property-based | §8 scheduler 部分 | 低 |
| **M4** structured-output 拆模块 | D4：拆 6 模块；execute 拆两函数 + 权威模式设防；hook RetryState 显式化 | §5.3 终态 | 低（纯结构重构） |
| **M5** structured-output 测试清理 | D5：删假测试；补 hook 状态机测试；守卫/ajv 层1单测 | §8 structured-output 部分 | 低 |

**每阶段独立可验证、可回滚。** M0 先做（最高价值 + 为 M1 铺路）；M2/M4 可并行（不同 extension，无依赖）。

---

## §10 下一层拆分（任务清单）

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| M0-a 删 comment 字段与状态 | types.ts 删 allowComment/commentValue/QuestionMode:"comment"/ANSWER_COMMENT_SEPARATOR | comment 删除的根，先清数据模型再清逻辑 |
| M0-b Result.answers 结构化 | types.ts ResultSchema.answers 改 `Record<string, AnswerValue>`；定义 AnswerValue | D1 核心，一处类型变更触发下游连锁改造 |
| M0-c 删 parseAnswerParts + 改 answer-codec | answer-format.ts→answer-codec.ts，删 parseAnswerParts，formatAnswer→encodeAnswer | AU-1 根因消除 |
| M0-d 合并 internal/proto 单模型 | 删 toProtoQuestions 的 value≠label 假设（value=label 已确认），Question 单一模型 | AU-3 去协议层 |
| M0-e channel-handler 直读 AnswerValue | encodeTuiResultToProto 不调 parseAnswerParts，直接读结构化 | AU-1 下游 |
| M0-f component/question-view/submit-view 删 comment mode | 删 comment 状态机分支与渲染 | D2 |
| M2-a SchedulerBackend 接口 + PiSchedulerBackend | backend.ts 接口，runtime 构造注入 | D3 依赖反转 |
| M2-b SchedulerService 共享编排 | service.ts 5 动作单一实现；tool/commands 瘦壳 | SCH-1 去双轨 |
| M2-c computeNextRunAt 统一 + 死循环修复 | parsing.ts 统一函数；runtime 三处调用；fallback 改停用+failed | SCH-2 + SCH-3 |
| M2-d 清僵尸类型 | 删 ScheduleMode；TaskStatus 收 'success'\|'failed'；删 note | 竞品报告 §2.3 |
| M4-a structured-output 拆 6 模块 | 按职责拆文件 | SO-2 |
| M4-b execute 拆两函数 + 权威设防 | validateWithAuthoritative / validateAgainstSelfReported；都过 schema-guards | SO-1 |
| M4-c hook RetryState 显式化 + 测试 | workflow-hook.ts RetryState 类 + 转移表测试 | SO-3 |

---

## §11 待验证检查点（探针清单，准则 7）

> 准则 7：运行时行为断言必须先验证再声称。✅=已验证（grep/读码确认）；⛔=实施期门（该阶段前必须跑通的探针）。

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-parse-delete | 删 parseAnswerParts 后无残留调用 | `grep -rn parseAnswerParts extensions/ask-user/src/` 应零命中（M0-c 后） | ⛔ M0-c |
| P-single-model | proto value 与 label 在所有路径相等 | grep `\.value` 在 ask-user src，确认无 value≠label 的消费 | ⛔ M0-d |
| P-no-comment-residue | 删 comment 后无残留 comment/allowComment/commentValue 引用 | `grep -rni comment extensions/ask-user/src/` 仅剩 CHANGELOG/历史注释 | ⛔ M0-f |
| P-answer-flow | 结构化 AnswerValue 从 component 一路到 proto 无字符串往返 | 写一个探针测试：mock 用户选 Postgres+Other，断言 Result.answers 是 AnswerValue 对象、channel-handler 收到结构化值 | ⛔ M0-e |
| P-cron-no-loop | cron 失效不再死循环 | 注入 MockBackend + 构造失效 cron task，跑 3 个 tick，断言 task.enabled===false 且 dispatch 只触发一次 | ⛔ M2-c |
| P-runtime-mock | SchedulerRuntime 可注入 mock 单测 | `new SchedulerRuntime(mockBackend)` 跑 addTask/dispatch，不碰 pi.sendMessage/文件 IO | ⛔ M2-a |
| P-auth-keyword | 权威模式拒绝 keyword-less schema | 单测：authoritative={} 抛 "no recognized keyword" | ⛔ M4-b |
| P-hook-state | hook RetryState 转移正确 | 单测覆盖：成功短路/未调用 steer/失败 steer/超上限放弃/toolUse 不干预/多 turn 重置 | ⛔ M4-c |
| P-test-mutation | 删测试后回归保护未降 | 对 ask-user/scheduler/structured-output 各跑一次 targeted mutation（改被测逻辑关键分支），确认有效测试变红 | ⛔ M1/M3/M5 |

**已验证事实**（本设计文档现状描述的依据）：
- ✅ ask-user 答案字符串化往返：`parseAnswerParts` 反解析点 2 处（`index.ts:91`、`channel-handler.ts:106`），`formatAnswer` 序列化点 2 处（`submit-view.ts:47`、`index.ts:173`）。
- ✅ scheduler cron fallback 死循环隐患：`runtime.ts:101`/`:217` 均 `?? Date.now()`，`:56` 用 throw（三处不一致）。
- ✅ structured-output 单文件 457 行、`executeStructuredOutput` 双路径（`:119` 权威分支提前 return）、`setupWorkflowHook` 4 mutable 闭包（`:297-300`）。
- ✅ scheduler 无 README、structured-output 有测试 816 行（含假测试段）、ask-user description 1829 字符。

---

## 附录 A：与两份调研/审查报告的映射

本设计基于两份临时报告（`extensions/.tmp-architecture-review.md`、`extensions/.tmp-competitive-research.md`），问题编号沿用其前缀：

| 报告问题 | 本设计落点 |
|---|---|
| AU-1（答案反解析） | D1 + M0-c/e |
| AU-2（ARCHITECTURE.md 脱节） | M0 完成后同步更新该文档 |
| AU-3（proto/internal 双模型） | D1 + M0-d |
| AU-4（index.ts 职责混杂） | M0-d 收拢 proto 转换后缓解 |
| SCH-1（tool/command 双轨） | D3 + M2-b |
| SCH-2（cron 死循环） | D3 + M2-c |
| SCH-3（cron 计算三处重复 + 常量双源） | M2-c |
| SCH-4（dispatchTask 长函数） | M2-a（backend 抽出后 runtime 瘦身） |
| SO-1（双路径塞函数） | D4 + M4-b |
| SO-2（单文件 7 职责） | D4 + M4-a |
| SO-3（hook 状态机零测试） | D4 + M4-c |

## 附录 B：变更历史

- v1（2026-08-09）：基于架构审查 + 竞品调研两份报告，落地用户三个决策（删 comment、简化 DDD 单模型、测试按 test-quality 精简）的初版设计。待 tech-design-review 对抗审查。
