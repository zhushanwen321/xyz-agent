<!-- 一句话结论 -->
# Pi Extension Tool Schema OpenAI 兼容性设计

> **一句话结论**：`registerTool` 的 `parameters` 顶层必须是序列化后含 `type:"object"` 的 TypeBox schema；多 action tool 采用「扁平 `Type.Object` + 字段级 `Type.Union` + `Static<typeof Schema>` 派生类型 + 运行时分枝校验」范式（scheduler 已建立、goal/todo 待对齐），precommit 脚本固化防回归。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 维护一批 `@zhushanwen/pi-*` extension（`extensions/` 下 18 个目录，其中 13 个注册 tool，9 个为 mandatory 强制安装），每个通过 `pi.registerTool({ parameters, ... })` 注册工具；`parameters` 是 TypeBox schema，pi 启动会话时序列化为 JSON Schema 发给 LLM provider。
- **C（冲突）**：`goal_control` 与 `todo` 两个 tool 把 `Type.Union([...])` 直接作为 `parameters`，序列化产物**顶层只有 `anyOf`、没有 `type` 字段**，违反 OpenAI function calling 规范（parameters 顶层必须是 `type:"object"`），严格的 OpenAI 兼容网关直接 400 拒绝整个会话启动。
- **Q（问题）**：如何让多 action tool 的 schema 既兼容所有 OpenAI 严格网关，又保留类型安全与分支语义，且防止未来新 extension 再次踩坑？
- **A（答案）**：扁平 Object 范式（scheduler 已建立）+ `Static<typeof Schema>` 派生类型（单一来源，无两处同步）+ 运行时分枝校验 + precommit 脚本拦截顶层非 Object schema。

---

## 1. 背景：tool schema 是什么

**tool schema 是 LLM 与工具之间的调用契约。** 当 agent 需要调用工具时，LLM 根据 schema 决定传什么参数；pi 把 schema 序列化成 JSON Schema，连同 tool 的 `description` 一起发给 provider，provider 据此约束 LLM 的输出。

xyz-agent 的 extension（`extensions/<name>/src/`）用 TypeBox（`typebox` 包）定义 schema：

```ts
pi.registerTool({
  name: "todo",
  parameters: TodoParams,   // ← TypeBox schema，序列化后发给 provider
  async execute(id, params) { /* 运行时收到 LLM 按 schema 构造的 params */ },
});
```

**本次设计聚焦**：`parameters` 这一字段的 schema 形态合规性。不涉及 tool 的 `description`/`execute` 业务逻辑（那是 code-review skill 的 review-extension-api 维度职责）。

## 2. 设计目标

**改造后，extension 开发者与终端用户分别能做到：**

1. **兼容性**：任何一个 `@zhushanwen/pi-*` extension 注册的 tool，在任何 OpenAI 兼容网关（严格校验顶层 type 的）下都不会因 schema 被拒绝启动会话。
2. **表达力与类型安全**：多 action tool 仍能清晰表达"create 时必填 objective/successCriteria、complete 时必填 evidence"的分支语义；`execute` 内字段访问有类型支撑（避免 unsafe-cast）。
3. **防回归**：未来新增 extension 若误用顶层 Union/Array schema，在 `git commit` 阶段被 precommit 脚本拦截，不需要等用户在严格网关下踩坑。

**In-scope**：`goal_control` + `todo` 两个 tool 的 schema 改造；`docs/extensions/extension-conventions.md` 的 Tool 设计规范强化；新增 `.githooks/check_tool_schema.py` precommit 脚本。

**Out-of-scope**：pi 主包（`@earendil-works/pi-coding-agent`）的 schema 归一化改造（上游开源项目，不可控，见 §6.1）；其他 provider 的非标 schema 适配；goal/todo 的 `description`/`promptGuidelines` 文案优化；code-review subagent 模板的规范加载改进（正交问题，见文末脚注）。

---

## 3. 现状：顶层 Union 怎么让会话启动失败

### 3.1 现状的真实样子

`goal_control` 的 schema 定义（`extensions/goal/src/adapters/goal-control-adapter.ts:99`，已 read 核实）：

```ts
const CreateParams   = Type.Object({ action: Type.Literal("create"),          objective: Type.String(), successCriteria: Type.String(), ... }, { additionalProperties: false });
const CompleteParams = Type.Object({ action: Type.Literal("complete"),        evidence: Type.String() }, { additionalProperties: false });
const ReportBlockedParams = Type.Object({ action: Type.Literal("report_blocked"), reason: Type.String() }, { additionalProperties: false });

export const GoalControlParams = Type.Union([CreateParams, CompleteParams, ReportBlockedParams]);
//                                            ^^^^^^^^^^ 三个分支 object 组合成 discriminated union
```

`todo` 同构（`extensions/todo/src/tool.ts:90`，已 read 核实）：5 个分支 object 组成 `Type.Union([...])`。

### 3.2 怎么出错——序列化产物违反 OpenAI 规范

实跑 typebox 序列化（探针 ✅已测，`/tmp/_serialize-check.mjs`）：

```
GoalControlParams 序列化产物:
  顶层 keys: ["anyOf"]
  顶层 type: (undefined)
  有 anyOf/oneOf 在顶层? true
  OpenAI 兼容? ✗ 否（顶层非 object）
```

完整 JSON：
```json
{
  "anyOf": [
    { "type": "object", "required": ["action","objective","successCriteria"], "properties": {...}, "additionalProperties": false },
    { "type": "object", "required": ["action","evidence"], ... },
    { "type": "object", "required": ["action","reason"], ... }
  ]
}
```

**OpenAI function calling 规范**要求 `parameters` 顶层必须是 `type: "object"` 的 JSON Schema，**不接受顶层裸 `anyOf`/`oneOf`/`allOf`**。Anthropic 较宽松能接受，但各类 OpenAI 兼容网关（如本次报错的 "Console Go"）严格校验顶层 type → 直接 400：

```
Error: 400: Invalid schema for function 'goal_control': schema must be a
JSON Schema of 'type: "object"', got 'type: null'.
```
（报错原文来自用户环境 handoff 报告；根因——顶层无 type——已由本设计 §3.2 探针实跑验证）

> 👉 **恢复指引**：用户遇到此报错时，临时绕过方式是换用 Anthropic 直连或宽松网关；根治方式是按本设计 §5 改造 schema 后发版 extension。

### 3.3 影响范围——穷尽扫描全部注册 tool 的 extension

扫描 `extensions/` 下所有 `registerTool` 的 `parameters` 来源（已 read + grep 逐个核实 schema 定义）：

| extension | parameters 来源 | 顶层形态 | 结论 |
|---|---|---|---|
| **goal** | `GoalControlParams` | `Type.Union([...])` | ❌ 中招 |
| **todo** | `TodoParams` | `Type.Union([...])` | ❌ 中招 |
| scheduler | `ScheduleParams` / `ScheduleControlParams` | `Type.Object`（action 字段级 `Type.Union`） | ✓ 已建立范式 |
| structured-output | `createToolDefinition()` → `Type.Object`（tool-definition.ts:51） | `Type.Object` | ✓ |
| subagent-workflow | `SubagentParams` / `WorkflowParams` / `WorkflowScriptParams` | `Type.Object`（3 个 tool 共用此形态） | ✓ |
| cw-tool | 内联 `Type.Object({ action: StringEnum(...) })`（4 个 tool 共用 buildTool） | `Type.Object` | ✓ |
| ask-user | `InputSchema` | `Type.Object` | ✓ |
| pending-notifications | `PendingNotificationsParams` | `Type.Object` | ✓ |
| plan | 内联 | `Type.Object` | ✓ |
| vision | `AnalyzeImageParams` | `Type.Object` | ✓ |

**只有 goal + todo 中招**（已逐个核实）。其余 extension 的 `Type.Union`/`StringEnum` 都在字段级（如 `action: Type.Union([...])`，等价 enum），合规。

> **关于 scheduler 范式的兼容性证据**：字段级 `Type.Union([Type.Literal(...)])` 序列化为**嵌套 `anyOf`**（探针 ✅已测：`properties.action = { anyOf: [...] }`，与顶层裸 anyOf 不同）。scheduler/goal/todo/structured-output 同为 mandatory（`packages/shared/src/mandatory-extensions.json` 已核实），每次会话启动同批注册 schema 发给网关——用户只报 goal/todo 的**顶层** anyOf 报错，从未报 scheduler 的**字段级嵌套** anyOf。这间接证明字段级嵌套 anyOf 能过严格网关（若不能，scheduler 作为更早注册的 mandatory 会先报错）。**这是间接推断**，严格网关的端到端实测仍待 §8.3 落地确认（与 §7.2 ⛔ 标注口径一致，不提前声称"已验证"）。

### 3.4 根因

症状是"会话启动 400"，根因有三层，缺一不可：

1. **技术根因**：TypeBox `Type.Union([...])` 序列化产物顶层是 `{ anyOf: [...] }`，无 `type` 字段；而 OpenAI 规范要求顶层 `type:"object"`。两者不兼容。
2. **规范根因**：`docs/extensions/extension-conventions.md` 的「Tool 设计」章节（第 50 行）虽写了"参数用 typebox `Type.Object()` 定义 schema"，但**只有一行、没有明确"顶层必须是 Object、禁止顶层 Union/Array"及其原因（OpenAI 兼容性）**，也没有给出多 action tool 的标准范式，导致 goal/todo 作者用语义最自然的 discriminated union 而不知违规。
3. **防护根因**：没有 precommit 检查拦截顶层非 Object schema，违规 schema 能一路 commit、发版、到用户环境才暴露。

> **关键术语**：**discriminated union（判别联合）** = 多个 object schema 用一个判别字段（这里是 `action`）区分分支的类型。`{ action:"create", objective }` vs `{ action:"complete", evidence }`。这是 TypeBox/TypeScript 表达多 action tool 语义最自然、类型最安全的写法——但序列化成顶层 `anyOf` 不被 OpenAI 接受。本设计的核心张力就在此。
>
> **双形陷阱**（todo 专属）：弱模型调用时把复数参数误传成单数（add 时传 `text` 而非 `texts`、delete 时传 `id` 而非 `ids`）。todo 用 handler 内 defense-in-depth 检测（`handleAdd`/`handleDelete`，tool.ts:114/176），这要求 handler 能同时访问单/复数字段——决定了 todo 的类型层处理与 goal 不同（见 §5.2、§6.2）。

## 4. 根因 + 物理数据流

schema 从源码到 provider 网关的物理路径（标注每一层的位置）：

```
extensions/goal/src/adapters/goal-control-adapter.ts:99   ← 源码（TypeBox Type.Union）
        │
        │  pi 启动时 registerTool 注册（内存持有 schema 对象）
        ▼
pi 进程内存：tool.parameters = GoalControlParams 对象
        │
        │  pi 把 tool 列表序列化为 JSON Schema，随 LLM 请求发出
        ▼
HTTP 请求体（JSON）：tools[].function.parameters = { anyOf: [...] }  ← 顶层无 type
        │
        │  发往 LLM provider 网关
        ▼
OpenAI 兼容网关（如 Console Go）：校验 tools[].function.parameters.type === "object"
        │
        ✗ 顶层 type 缺失 → 400 Invalid schema → 整个会话启动失败
```

**关键观察**：xyz-agent runtime 通过子进程 RPC 调用 pi，**不经过 schema 序列化这一环**——pi 自己序列化、自己发 provider。这意味着 xyz-agent 无法在 runtime 层做 schema 归一化（拿不到序列化前的拦截点）。解法必须在 extension 源码层（xyz-agent 可控）或 pi 主包层（上游，不可控）二选一。这个事实决定了 §6 的方案取舍。

---

## 5. 终态：扁平 Object 范式长什么样

### 5.1 核心范式——扁平 schema + Static 派生类型 + 运行时校验

```ts
// ① 运行时 schema（合规层）：扁平 Type.Object + action 字段级 Type.Union（等价 enum）
export const GoalControlParams = Type.Object({
  action: Type.Union(
    [Type.Literal("create"), Type.Literal("complete"), Type.Literal("report_blocked")],
    { description: "create | complete | report_blocked" },
  ),
  // 各分支字段全部 Optional，不进 required —— 分支隔离交给运行时校验（③）
  slug: Type.Optional(Type.String({ description: "create 可选。短 kebab-case 标识。" })),
  objective: Type.Optional(Type.String({ description: "create 必填。" })),
  successCriteria: Type.Optional(Type.String({ description: "create 必填。" })),
  tokenBudget: Type.Optional(Type.Number({ description: "create 可选。" })),
  evidence: Type.Optional(Type.String({ description: "complete 必填。" })),
  reason: Type.Optional(Type.String({ description: "report_blocked 必填。" })),
}, { additionalProperties: false });

// ② 类型层：从 schema 派生（单一来源，杜绝"类型与 schema 两处同步"）
//    Static<typeof GoalControlParams> = { action: ...; slug?: string; objective?: string; ... }
//    所有字段 optional —— handler 内运行时校验必填（③）
export type GoalControlParamsT = Static<typeof GoalControlParams>;

pi.registerTool({
  parameters: GoalControlParams,
  async execute(_id, params: GoalControlParamsT, signal, _onUpdate, ctx) {
    if (params.action === "create") return handleCreate(params, session, ports);  // params.objective 是 string | undefined
    // ...
  },
});

// ③ 运行时校验（语义层）：handler 接受 optional，内部校验"字段存在 + 非空串"
function handleCreate(params: GoalControlParamsT, ...): GoalControlDetails {
  const objective = params.objective?.trim();
  if (!objective) throw new Error("'objective' required for create. Correct: {...}");  // 原本就有的空串校验，补"缺失"分支
  // ...
}
```

序列化产物（探针 ✅已测）：
```
顶层 keys: ["type","required","properties"]
顶层 type: "object"
OpenAI 兼容? ✓ 是
```

### 5.2 todo 与 goal 同构——双形陷阱在 Static 类型上直接可行

todo 与 goal **运行时 schema 完全同构**（都是扁平 Object + action 字段级 union）。关键在于：扁平 schema 的 `Static<typeof TodoParams>` 天然是"全字段 optional 的扁平 object"，**这正好满足双形陷阱检测的类型需求**——handler 能同时访问 `params.text` 和 `params.texts`（都是 optional）：

```ts
export const TodoParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("delete")], {...}),
  text:  Type.Optional(Type.String()),       // 陷阱字段：add/delete 误传单数
  texts: Type.Optional(Type.Array(Type.String())),
  id:    Type.Optional(Type.Number()),       // 陷阱字段：delete 误传单数
  ids:   Type.Optional(Type.Array(Type.Number())),
  status: Type.Optional(StatusSchema),
  updates: Type.Optional(Type.Array(...)),
}, { additionalProperties: false });

export type TodoParamsT = Static<typeof TodoParams>;  // 全 optional 扁平

// 双形陷阱检测直接在 Static 类型上可行——无需任何 cast
function handleAdd(state: TodoSessionState, params: TodoParamsT): string {
  if (params.text !== undefined && params.texts !== undefined) {   // 两个字段都在 Static 类型里
    throw new Error('add only accepts texts array; do not also pass singular "text"');
  }
  // ...
}
```

**对比现状**：当前 todo 的 `execute` 是 `params: Static<typeof TodoParams>`（旧 discriminated union 类型）然后 `as TodoActionParams`（cast 到宽松 interface，tool.ts:297）——因为旧 union 类型不允许跨分支访问 `text`/`texts`。**扁平化后这个 cast 自然消失**：Static<typeof 扁平 schema> 本身就是宽松全 optional，直接替代旧的 `TodoActionParams` interface。这是减法——消除一个 unsafe-cast。

### 5.3 失败路径——LLM 传错参时的运行时反馈

扁平 schema 放宽了 schema 层约束，弱模型可能传跨分支字段（如 `{action:"complete", objective:"..."}`）或漏传必填。运行时 handler 按 action 分枝校验，给出可操作错误：

```
[ERROR] goal_control complete 缺少必填字段 evidence。
  👉 正确调用：{"action":"complete","evidence":"<具体完成证据：改动的文件/通过的测试>"}
  （complete 不接受 objective 字段——那是 create 的字段）
```

> 👉 **恢复指引**：错误消息内嵌正确调用示例（对齐全局 AGENTS.md 规则 16「错误信息必须可操作」），LLM 读到后可自我纠正重试。

### 5.4 发版影响与观察期（mandatory 向后兼容）

goal/todo/structured-output/scheduler 都是 mandatory（autoUpgrade）。扁平化后 LLM 看到的参数契约变化：`required` 从"各分支独有必填字段"降级为"仅 action"。影响：

- **正面**：弱模型不再被迫为不需要的字段传占位值（如 complete 时不必编造 objective）。
- **风险**：弱模型可能漏传必填字段，触发运行时报错重试（多一次 round-trip）。

**观察期**：发版后跟踪一轮 goal/todo 调用的运行时报错率（日志见架构约定 #4 runtime 落盘）。若漏传必填的报错率异常高，说明 `description`/`promptGuidelines` 对必填字段的强调不足，需补强文案（不改 schema 形态）。**无回滚需求**——schema 形态变化不影响已持久化的 session 数据（goal/todo 状态文件不存 schema）。

---

## 6. 关键决策与权衡

### 6.1 决策一：schema 形态——扁平 Object vs 顶层 Union 归一化

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 扁平 Object + 字段级 union + Static 派生 + 运行时校验**（scheduler 范式） | ✅ 完全在 xyz-agent extension 源码内闭环，不依赖 pi 上游；与 scheduler 已有范式一致，项目内无分裂 | 中：goal/todo 各改 schema + handler 签名 + 测试调整 | 低：schema 层分支隔离降级为运行时校验，需 handler 补字段存在校验 | ✅ **选** |
| B. pi 主包发 provider 前归一化（检测顶层 anyOf → 展平为 object） | 表面更 DRY（宿主一次性适配，所有 extension 受益） | 高：改 pi 上游（badlogic/pi-mono）= fork 或提 PR | **高：上游不可控**。fork 维护成本（xyz-pi fork 教训刚过去，已切回上游）；PR 上游生效周期不可控；旧版 pi binary 仍有问题 | ❌ 否决 |

**被否若用（方案 B）**：§5.1 的 goal_control 例子不会变——extension 侧仍写顶层 Union（语义自然）；但 xyz-agent 无法保证 pi 上游接受 PR、无法保证用户 pi 版本跟进。一旦上游拒绝或延迟，问题无限期挂起。**可控性是决定性因素**：问题出在 xyz-agent 仓库内的 extension 源码，解法也必须在 xyz-agent 仓库内闭环。方案 B 可作为"向上游提 suggestion"的并行动作（建议 pi 提供 `registerMultiActionTool` 一等公民），但不作为 xyz-agent 的依赖路径。

### 6.2 决策二：类型层——Static 派生扁平 vs 手工 discriminated union

扁平 schema 的字段全是 Optional，`execute` 内访问 `params.objective` 得到 `string | undefined`。如何给字段访问提供类型支撑？两个候选：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **Y. `Static<typeof Schema>` 派生扁平类型 + 运行时校验** | ✅ 类型单一来源（从 schema 派生），杜绝"类型与 schema 两处同步"；goal/todo 统一处理；消除 todo 的 `as TodoActionParams` cast | 低：handler 签名改为接受 optional，内部补字段存在校验 | 低：execute 内字段是 optional，需判空（本就要运行时校验，不增加复杂度） | ✅ **选** |
| X. 手工声明 discriminated union 类型（execute 内按 action 收窄） | 类型收窄更精确（`params.action==="create"` 后 objective 是 string） | 中：类型与 schema 分离，需两处同步 | **高**：① 新增字段只改 schema 忘改类型 union → 类型安全静默失效，无编译期兜底；② **todo 双形陷阱检测需跨分支访问 text/texts，与严格 union 互斥**（handleAdd 内 `params.text` 编译报错） | ❌ 否决 |

**为什么选 Y（减法）**：方案 X 被否的关键是审查发现的 todo 互斥问题——todo 的 `handleAdd`/`handleDelete` 需同时访问单/复数字段检测双形陷阱，严格 discriminated union 下 `add` 分支不含 `text` 字段，访问报错。方案 Y 用 Static 派生的全 optional 扁平类型，所有字段都可访问，双形陷阱检测直接可行，且类型从 schema 单一派生无同步问题。

**为什么 scheduler 不需要这个讨论**：scheduler 的 handler 是 `switch(action){ case 'list': service.list(); case 'toggle': service.toggle(id, enabled) }`——分支内不访问"分支独有字段"（id/enabled 是所有分支共享的 optional），不依赖类型收窄。goal/todo 的 handler 访问分支独有字段（objective/texts），才需要类型层方案。这是 scheduler 范式"够用"而 goal/todo 需要明确类型策略的差异。

### 6.3 决策三：分支语义隔离——schema 层 vs 运行时层

| 方案 | 评估 | 裁决 |
|---|---|---|
| 运行时 handler 按 action 校验必填（字段存在 + 非空串） | schema 层失去编译期分支隔离，但 handler 本就有 `.trim()` 空串校验，补"字段存在"是自然延伸。集中、可测 | ✅ 选 |
| 保留 schema 层分支隔离（即维持顶层 Union） | 与 OpenAI 规范冲突，回到 §3 的问题 | ❌ |

**取舍诚实声明**：扁平 schema 放宽后，`additionalProperties:false` 只挡"未声明字段"，不挡"声明了但属于别的分支的字段"（如 complete 带 objective，objective 是声明的 Optional）。分支语义隔离从"编译期 schema"降到"运行时 handler"。这是兼容 OpenAI 规范的必要代价——handler 的运行时校验是唯一防线，必须有测试覆盖（见 §8）。

### 6.4 决策四：防回归——precommit 静态扫描 vs 动态序列化

| 方案 | 评估 | 裁决 |
|---|---|---|
| 静态正则扫描（`.githooks/check_tool_schema.py`） | 快，不影响 commit 体验；正则靠 `= Type.Union`（顶层赋值）vs `action: Type.Union`（字段级冒号）天然区分，零误报（探针 ✅已测）；局限：抓不到运行时动态拼接的 schema（extensions 内无此模式） | ✅ 选 |
| 动态序列化（build extension → import schema → 检查顶层 type） | 最准但要 build，precommit 里跑 build 体验差 | ❌（作为可选增强，不阻塞） |

precommit 脚本原型已实跑验证（探针 ✅已测）：精准拦截 goal/todo 两处，对其余 11 个 extension 零误报。

---

## 7. 实现机制

### 7.1 改造点清单

| 层 | 文件 | 改动 |
|---|---|---|
| goal schema | `extensions/goal/src/adapters/goal-control-adapter.ts` | `GoalControlParams` 从 `Type.Union` 改为扁平 `Type.Object`；`execute` 的 params 类型改为 `Static<typeof GoalControlParams>`；三个 handler 签名改为接受 optional，补"字段存在"校验（已有 `.trim()` 空串校验） |
| todo schema | `extensions/todo/src/tool.ts` | `TodoParams` 改为扁平 `Type.Object`；删除 `interface TodoActionParams`（由 `Static<typeof TodoParams>` 替代）；`execute` 内 `params as TodoActionParams` cast 消除；`handleAdd`/`handleDelete` 双形陷阱检测保留（在 Static 扁平类型上直接可行） |
| goal 测试 | `extensions/goal/src/__tests__/schema.test.ts` | 原 discriminated union 分支隔离用例语义改变，重写为验证"扁平 schema 顶层 type===object + 运行时分枝校验拒绝跨分支/缺失必填" |
| todo 测试 | `extensions/todo/src/__tests__/` | 同步调整（若存在 schema 测试）；重点覆盖双形陷阱检测在扁平类型下仍生效 |
| 规范 | `docs/extensions/extension-conventions.md` 「Tool 设计」章节 | 强化：明确"顶层必须 Object、禁止顶层 Union/Array + OpenAI 兼容性原因 + 多 action tool 标准范式 + 指向 precommit 脚本" |
| precommit | `.githooks/check_tool_schema.py`（新增）+ `.githooks/install-hooks.sh`（接入）+ `AGENTS.md`「跳过检查」段（补 `SKIP_TOOL_SCHEMA_CHECK`） | 新增静态扫描脚本，仿 `check_env_whitelist_sync.py` 结构 |

### 7.2 运行时校验探针（✅已测 / ⛔实施期门）

- ✅ **序列化合规**：扁平 `Type.Object` 序列化顶层 `type === "object"`（已用 typebox 实跑，见 §3.2/§5.1）
- ✅ **字段级 union 兼容性间接证据**：scheduler（mandatory）字段级嵌套 anyOf 与 goal/todo 同会话注册，用户只报后者（见 §3.3）
- ✅ **precommit 拦截**：原型脚本对 goal/todo 报错、对其余 extension 零误报（已实跑，见 §6.4）
- ⛔ **pi 严格网关端到端实测**：实施期用 dev-link 切本地版，`pi --mode rpc` 连严格网关实测会话启动成功（见 §8.3）——这是字段级嵌套 anyOf 安全性的最终确认
- ⛔ **类型层单一来源无漂移**：实施期确认 `Static<typeof Schema>` 派生方案下，新增字段只需改 schema 一处，类型自动跟随（无两处同步）

---

## 8. 验收（真实场景，非单测非 mock）

### 8.1 改动规模

**中等改动**——2 个 tool 的 schema/handler 改造 + 规范强化 + precommit 新增。涉及行为变更（schema 形态）和接口契约（LLM 看到的参数结构变了），需多场景验收。

### 8.2 验收场景

| 场景 | 回溯 §2 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| **8.1 序列化合规** | 目标 1（兼容性） | 在项目根跑 typebox 序列化脚本，dump `GoalControlParams` 与 `TodoParams` 的 JSON | 顶层 `type === "object"`，无顶层 `anyOf`/`oneOf` |
| **8.2 precommit 拦截** | 目标 3（防回归） | 把改造前的顶层 Union schema 临时还原一处，`git commit` 触发 `check_tool_schema.py` | 脚本 exit 2 并报出具体文件:行号 + 修复指引；改回扁平后 exit 0 |
| **8.3 pi 严格网关实测** | 目标 1（兼容性） | dev-link 切本地 goal/todo 版本；`pi --mode rpc --model <严格网关模型>` 发一条 prompt 触发 tool 注册 | 会话正常启动，不再 400；`goal_control`/`todo` 出现在 provider 的 tools 列表 |
| **8.4 运行时分枝校验** | 目标 2（表达力） | pi 交互中，分别触发 create（正常）、create（漏 objective）、complete（带跨分支字段 objective） | 正常 create 成功；漏 objective 抛可操作错误（含正确调用示例）；complete 带 objective 被 handler 拒绝 |
| **8.5 todo 双形陷阱** | 目标 2（表达力） | pi 交互中触发 add 同时传 `text` 和 `texts`、delete 同时传 `id` 和 `ids` | 双形陷阱检测在扁平类型下仍抛错（`handleAdd`/`handleDelete` 校验保留） |
| **8.6 类型安全** | 目标 2（类型安全） | `pnpm extensions:typecheck`；确认 todo 源码无 `as TodoActionParams` cast | typecheck 通过；todo cast 消除；goal handler 签名接受 optional 且内部校验 |
| **8.7 测试通过** | 目标 2+3 | `cd extensions/goal && npm test`；`cd extensions/todo && npm test` | 重写后的 schema 测试 + 既有行为测试全绿 |

> 验收不用 mock：8.3 用真实 pi 进程 + 真实网关；8.4/8.5 用真实 handler 执行路径；8.1/8.2 用真实 typebox 序列化与真实 git hook。

---

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | 规范强化 + precommit 脚本落地（不改 goal/todo） | 目标 3（防回归）先行——脚本上线后，goal/todo 的违规会立刻被拦截，倒逼 M1 |
| M1 | goal_control 改造（schema 扁平 + Static 派生 + handler 校验 + 测试） | 目标 1+2 对 goal 生效 |
| M2 | todo 改造（同构 + 消除 cast + 保留双形陷阱 + 测试） | 目标 1+2 对 todo 生效 |
| M3 | §8 全场景验收 + 发版 `@zhushanwen/pi-goal`/`@zhushanwen/pi-todo` + 观察期 | 终态全达成 |

### 9.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| unit-1 规范强化 | `extension-conventions.md`「Tool 设计」补强约束 + 范式 | 先立规矩，让后续改造有依据；规范是 SSOT，代码对齐它 |
| unit-2 precommit 脚本 | `check_tool_schema.py` + install-hooks 接入 + AGENTS.md SKIP 说明 | 防回归护栏，固化 unit-1 规范；M0 先行倒逼改造 |
| unit-3 goal 改造 | schema 扁平化 + Static 派生类型 + handler 签名改 optional + 测试重写 | 单独成单元，因 goal 的 handler 校验逻辑（D25 守卫等）需仔细迁移 |
| unit-4 todo 改造 | 同构改造 + 消除 `as TodoActionParams` cast + 保留双形陷阱检测 + 测试 | todo 的双形陷阱是历史教训，必须验证在扁平类型下仍生效 |
| unit-5 验收发版 | §8 全场景 + npm 发版 + 报错率观察期 | 验收与发版绑定，避免"改完没验就发" |

### 9.3 待验证检查点

- ⛔ **pi 严格网关端到端**：序列化合规 + 字段级嵌套 anyOf 间接证据已有，但严格网关的端到端实测（§8.3）是最终确认。若实测发现字段级嵌套 anyOf 也被某网关拒（间接证据推断错误），则需 fallback：action 字段改用 `Type.Enum` 或 `StringEnum`（@earendil-works/pi-ai）看是否序列化为 `enum` 而非 `anyOf`——这是 plan B，实施期按实测结果决定。
- ⛮ **pi 0.82.1 对扁平 schema 的实际处理**：序列化合规已验证，pi 是否对 `parameters` 有额外校验/转换需实施期确认。
- ⚠️ **pi 上游 suggestion 的并行动作**：本设计不依赖上游，但应向 pi-mono 提 issue 建议 `registerMultiActionTool` 一等公民（extension 写 discriminated union，pi 负责合规转换），作为长期理想形态。不阻塞本设计。

---

## 附录

### A. 规范落地条目文案（供 unit-1 直接 apply 到 `extension-conventions.md`「Tool 设计」章节）

> **`parameters` 顶层必须是 `Type.Object`（OpenAI 兼容性）[MANDATORY]**
>
> `registerTool` 的 `parameters` 序列化后顶层必须含 `type:"object"`。OpenAI function calling 规范要求 parameters 顶层是 object，**禁止**顶层 `Type.Union`/`Type.Intersect`/`Type.Composite`（序列化为 `anyOf`/`allOf`，无 type）、`Type.Array`（序列化为 `type:"array"`）、`Type.KeyOf`。违反会导致严格 OpenAI 兼容网关 400 拒绝整个会话启动。
>
> **多 action tool 标准范式**：参考 `scheduler/src/tool.ts` 的 `ScheduleControlParams`。三件套：
> 1. 运行时 schema：扁平 `Type.Object`，`action` 字段用 `Type.Union([Type.Literal(...)])`（字段级，等价 enum，序列化为嵌套 anyOf 合规），各分支字段全部 `Type.Optional`；
> 2. 类型层：用 `Static<typeof Schema>` 派生扁平类型（单一来源，禁止手工另写 discriminated union——会导致类型与 schema 两处同步漂移，且 todo 类双形陷阱检测需跨分支访问字段，严格 union 下编译报错）；
> 3. 运行时校验：handler 按 `action` 分枝校验必填字段存在 + 非空串（错误消息内嵌正确调用示例）；
> 4. `additionalProperties: false` 保留。
>
> 分支语义隔离从 schema 层降级为运行时 handler 校验——这是兼容 OpenAI 规范的必要代价。precommit 脚本 `.githooks/check_tool_schema.py` 强制拦截顶层非 Object schema（`SKIP_TOOL_SCHEMA_CHECK=1` 可跳过，仅限紧急）。

---

> **脚注：code-review subagent 模板的规范加载缺口**（正交问题，独立改进项）
>
> 排查中发现：8 个 `.agents/agents/review-*.md` 模板无一有"强制 read 规范文档"前置步骤，规范引用全是"参考/详见"性质，无一显式 `read AGENTS.md`。subagent 跑在隔离 context 不自动继承项目规范——这比 schema 兼容更广的结构性缺口。本设计的 precommit 脚本是 schema 合规的**机器护栏**，review agent 规范加载是**人工审查护栏**，两者互补。建议作为独立改进项：review agent 模板执行步骤开头强制 read 相关规范文档。不阻塞本设计。
