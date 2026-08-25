---
scope_ensemble_overlap: high      # 3 票一致 lite（主+偏严+偏宽）
reuse_ensemble_overlap: high      # 2b 两路重合：todo/ask-user Type.Array 先例、splitCriteriaLines 已有函数、${i+1}. 编号模式
test_ensemble_overlap: low       # 4b 两路主题重合 ~65%（<80%），互补采纳 U28-U39
reconstruct_blind_spot: high     # 5b MISSING 有效 4 条（非字符串元素/纯分隔符/流程级转义），保持启用
---

# goal successCriteria 结构化为条件数组 + 引导修正 实现计划

## 业务目标

把 `@zhushanwen/pi-goal` 的 successCriteria 从单条自由文本 string 结构化为条件数组 `string[]`（1~8 条、每条单行短条件），并修正 goal_control 工具引导文本（参数 description / 工具 description / promptGuidelines）加入粒度约束——堵住「AI create 时把 plan 规格整段倾倒进 successCriteria、每轮 prompt 全文注入」的引导缺口。

成功标准：
1. `goal_control create` 的 successCriteria 参数为 JSON 数组，schema 层 `minItems:1 / maxItems:8 / items minLength:1`，handler 层校验每条 trim 非空、不含换行（throw 带 Correct: 恢复正例）
2. 旧持久化数据（string 型 successCriteria）deserialize 时按行拆分为数组，不丢数据、不 throw；新数组数据 round-trip 一致
3. 每轮注入 prompt 的 `<successCriteria>` 段渲染为编号列表（`1. xxx`），widget / `/goal status` / `/goal update --criteria` 适配数组
4. 引导文本三层（参数 description / 工具 description / promptGuidelines）含粒度约束：3~8 条高层终态条件、每条单行、细粒度清单放 todo/plan 只引用不复制、禁止倾倒规格；prompt-lock 测试锁死防回滚
5. 跨包消费方 `plan/src/compact.ts`（`__goalInit` 调用点）同步适配数组，`pnpm extensions:typecheck` 全绿
6. goal + plan 两包 `pnpm test` / `pnpm extensions:lint` 全绿

约束：仅改 `extensions/universal/goal/` + `extensions/universal/plan/compact.ts`；vitest + @fast-check/vitest property 测试 + typebox Value.Check（延续现有基建）；错误文案带 `Correct:` 恢复正例（现有风格）。

迁移/校验设计决策（4b ensemble 后落定）：① 全空白旧 string → 迁移为 undefined（空态归一）；② 脏数据类型（number/null/嵌套数组）→ 防御性丢弃为 undefined（criteria 是 optional 字段，降级优于 state throw）；③ CRLF 兼容：split /\r\n|\r|\n/，handler 校验 /[\r\n]/（unicode/emoji 不误杀）；④ handleUpdate 第二入口同规则：拆分 + trim 去空段，空结果保留旧值；⑤ 迁移超 8 条不截断（迁移容忍旧数据，新建路径严限 8）。
不做：注入层截断/maxPrompt 长度（用户明确排除）、CW skill 交叉引用、`/goal update --criteria` 之外的命令面新功能、successCriteria 机器逐条核对 complete。

## 技术改动点

goal 包（extensions/universal/goal/）：
- 修改 `src/engine/types.ts` — GoalRuntimeState.successCriteria?: string → string[]（注释同步）
- 修改 `src/engine/goal.ts` — createGoalState 参数 successCriteria?: string → string[]
- 修改 `src/service.ts` — createGoal 参数类型跟随
- 修改 `src/index.ts` — `__goalInit` 实现与 `GoalInitFn` 导出类型的 successCriteria?: string → string[]
- 修改 `src/adapters/goal-control-adapter.ts` — ① GoalControlParams.successCriteria schema 改 Type.Array(Type.String(), {minItems:1, maxItems:8, items minLength 1}）；② handleCreate 数组校验（空数组/纯空白条目/含换行条目 throw 带 Correct: 正例）；③ 引导文本修正：参数 description 粒度约束、工具 description create 段、promptGuidelines create 项（三层信号冗余，对齐 budget-policy 先例）
- 修改 `src/persistence.ts` — deserializeState 迁移：`typeof === 'string'` 按行 split + trim + 去空行（超 8 条不截断）；serialize/makeHistoryEntry 类型跟随
- 修改 `src/projection/prompts.ts` — successCriteriaBlock 渲染编号列表（每条 escapeXmlText）
- 修改 `src/projection/widget.ts` — renderWidgetLines 数组 join('; ') 后截断
- 修改 `src/projection/gui.ts` — splitCriteriaLines 迁移至 persistence 供 deserialize 复用（正则增强含纯 \r）；buildGoalGui 消费点简化为直读数组
- 修改 `src/commands.ts` — GoalCommandArgs.criteria?: string[]；parseGoalArgs `--criteria` 按分号拆分
- 修改 `src/adapters/command-adapter.ts` — `/goal status` 多行编号显示；handleUpdate criteria 数组替换/保留
- 修改 `src/__tests__/schema.test.ts` — 数组用例（合法 1~8 / 9 条拒 / 0 条拒 / string 拒 / 空串条目拒）
- 修改 `src/__tests__/goal-control-adapter.test.ts` — handleCreate 数组校验用例 + 存量 string fixture → 数组
- 修改 `src/__tests__/goal-control-prompt.test.ts` — 新增粒度约束 prompt-lock 断言
- 修改 `src/__tests__/deserialize-state.test.ts` — property arb 改 fc.array + 旧 string 迁移用例
- 修改 `src/__tests__/goal-control-rpc.test.ts` / `gui.test.ts` / `command-adapter.test.ts` — 数组 fixture 适配

plan 包（extensions/universal/plan/）：
- 修改 `src/compact.ts` — buildPlanSuccessCriteria 返回 string[]（1 条总述 + 前 3 条 step preview，每条截断 ~80 chars）；tryGoalInit 调用跟随
- 修改 `src/__tests__/compact-handler.test.ts` — 断言适配数组

复用说明（2b ensemble 采纳）：① deserialize 迁移复用并增强 goal 自身 `projection/gui.ts:75` `splitCriteriaLines()`（split 正则从 /\r?\n/ 增强为 /\r\n|\r|\n/ 后直接复用，导出迁移到 persistence 供 deserialize 调用；gui.ts 消费点简化为直读数组）；② schema 对齐 `todo/tool.ts:43` `Type.Array(Type.String())` + `ask-user/types.ts:41` minItems/maxItems 写法；③ prompt 编号对齐 scheduler/session-reader/plan 三处一致的 `${i+1}. ` 模式；④ 迁移函数命名 `normalizeCriteria` 对齐同文件 normalizeStatus 风格；⑤ 引导文本三层冗余复用 budget-policy prompt-lock 先例。无新建文件。

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | goal: types.ts / goal.ts / service.ts / index.ts / goal-control-adapter.ts / persistence.ts + 测试（schema/adapter/deserialize）；plan: compact.ts + compact-handler.test.ts | [] | g1 | 数据契约闭环：类型层 + schema + handler 校验 + 持久化迁移 + 跨包消费方，交付后 `pnpm extensions:typecheck` 全绿 |
| W2 | goal: prompts.ts / widget.ts / gui.ts / commands.ts / command-adapter.ts + 测试（prompt/widget/command-adapter/rpc/gui） | [W1] | - | 渲染与用户面：prompt 编号列表 + widget/status/update/gui 适配（依赖 W1 的 string[] 类型） |

两 Wave 文件零交集，W2 消费 W1 定义的类型故串行。

## 单测用例清单（AC 级）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | schema.test.ts:Value.Check 批量用例; goal-control-adapter.ts:GoalControlParams | Value.Check(GoalControlParams, {action:"create", objective:"x", successCriteria:["a"]}) 及 ["a".."h"] 8 条 | true | 正常 |
| U2 | goal-control-adapter.ts:GoalControlParams | successCriteria: 9 条数组 | Value.Check false（maxItems:8） | 边界 |
| U3 | goal-control-adapter.ts:GoalControlParams | successCriteria: [] 空数组；successCriteria: "y" 字符串 | 两者 Value.Check false（minItems:1 / type array） | 异常 |
| U4 | goal-control-adapter.ts:GoalControlParams + handleCreate | successCriteria: ["a","  "] 纯空白条目 | schema minLength:1 按原始字符数放行 "  "（“”才被拦）→ handler 层 trim 兜底 throw（双层分工显式锁定） | 边界 |
| U5 | goal-control-adapter.test.ts:handleCreate; goal-control-adapter.ts:handleCreate | {action:"create", objective:"x", successCriteria:["cond a","cond b"]} | 不 throw；state.successCriteria === ["cond a","cond b"] | 正常 |
| U5b | goal-control-adapter.ts:handleCreate+schema | successCriteria: ["single"]（恰 1 条）与 ["a".."h"]（恰 8 条，含 emoji/中文如「通过测试✅」） | 双层均不 throw，state 数组长度 1/8（minItems/maxItems 边界正值 + unicode 不误杀） | 边界 |
| U6 | goal-control-adapter.ts:handleCreate | successCriteria: ["  "] 纯空白条目 | throw /successCriteria/ 且错误文案含 'Correct:' 数组正例 | 异常 |
| U7 | goal-control-adapter.ts:handleCreate | successCriteria: ["line1\nline2"]、["a\r\nb"]、["a\rb"] 条目含换行 | throw /successCriteria/ 且文案含「单行」+ 'Correct:' 数组正例（校验 /[\r\n]/ 覆盖三种换行形态） | 异常 |
| U8 | goal-control-adapter.ts:handleCreate | successCriteria: [] 空数组；undefined | throw /successCriteria.*required\|empty/ | 异常 |
| U9 | goal-control-adapter.ts:handleCreate | 已有 active goal + 传数组 create | throw 非终态守卫（D25 回归） | 边界 |
| U10 | persistence.ts:deserializeState | 旧数据 {successCriteria: "tests pass"} 单行 string | 返回 ["tests pass"] | 正常 |
| U11 | persistence.ts:deserializeState | 旧数据多行 "a\n b \n\nc"（含空白行） | 返回 ["a","b","c"]（逐条 trim、去空行） | 正常 |
| U11b | persistence.ts:deserializeState | 旧数据 "cond-1\r\ncond-2\r\ncond-3"（CRLF）与 "a\nb\r\nc\rd"（混合换行） | 分别 ["cond-1","cond-2","cond-3"] / ["a","b","c","d"]（无 \r 残留，split /\r\n|\r|\n/） | 边界 |
| U11c | persistence.ts:deserializeState | 旧数据 "\r\n" 与 "\r"（纯分隔符无内容） | 均归一为 undefined（拆分后全空段，同 U14 空态归一路径） | 边界 |
| U12 | persistence.ts:deserializeState | 新数据 ["x","y"]；缺字段 undefined | 分别原样返回 / undefined | 边界 |
| U13 | persistence.ts:deserializeState | 旧 string 拆分后 >8 条（10 行） | 保留全部 10 条不截断（迁移不丢数据） | 边界 |
| U14 | persistence.ts:deserializeState | 旧数据 " \n " 全空白 | 返回 undefined（空态归一，等同未设置） | 边界 |
| U14b | persistence.ts:deserializeState | successCriteria: 42 / null / true / ["a",["b","c"]]（脏数据类型） | 全部 undefined（防御性丢弃不 throw：非 string 且非 every-string array 均归一） | 异常 |
| U15 | deserialize-state.test.ts:goalStateArb | fc.option(fc.array(fc.string({minLength:1}).filter(s=>!/\r|\n/.test(s)),{minLength:1,maxLength:8})) round-trip；另加 fc.string()→迁移 property：任意 string 迁移后 Array.isArray 且 every(trim 非空) | serialize→deserialize 深相等；迁移 property 恒成立（生成器与新 schema/迁移语义对齐） | 正常 |
| U15b | persistence.ts:makeHistoryEntry | state.successCriteria=["a","b"] → makeHistoryEntry → JSON 序列化 → 反序列化 | entry.successCriteria 深等于 ["a","b"]（history 数据数组形态不丢） | 正常 |
| U16 | prompts.ts:successCriteriaBlock | state.successCriteria = ["a<b","c&d","<script>alert(1)</script>","already escaped: &amp;"] | 逐条 escape 后编号：`1. a&lt;b` `2. c&amp;d` `3. &lt;script&gt;…` `4. already escaped: &amp;amp;`，被 <successCriteria> 包裹（逐条级转义，先 escape 后拼接——含流程级二次转义） | 正常 |
| U16b | prompts.ts:escapeXmlText | "already escaped: &amp; <tag>" | "already escaped: &amp;amp; &lt;tag&gt;"（无条件二次转义，行为锁定） | 边界 |
| U17 | prompts.ts:successCriteriaBlock | 空数组 / undefined | 返回 ""（prompt 不增段） | 边界 |
| U18 | prompts.ts:continuationPrompt | state 含 ["a","b"] | prompt 文本含编号两行 + "every condition there must be met" 引用句保留 | 正常 |
| U19 | widget.ts:renderWidgetLines | ["cond one","cond two"] 及 8 条×20 字符 join 超 OBJECTIVE_DISPLAY_LIMIT | dim 行含 `✓ cond one; cond two`；超限截断到 OBJECTIVE_TRUNCATE_KEEP+"..."；条目含分号（"step 1; verify"）时 join 同形但内容不丢（锁定行为） | 边界 |
| U20 | commands.ts:parseGoalArgs | "/goal update new obj --criteria a; b; c" | {action:"update", objective:"new obj", criteria:["a","b","c"]}（**parse 层分号拆分 + 逐段 trim 去空段**，GoalCommandArgs.criteria: string[]） | 正常 |
| U21 | commands.ts:parseGoalArgs | "--criteria single" 无分号；"--criteria a;;b" 连续分号 | 分别 ["single"] / ["a","b"]（去空段） | 边界 |
| U22 | command-adapter.ts:handleUpdate | ① handleUpdate 收 criteria=["new a","new b"]（数组直赋值，不再 string.trim）→ 替换；② --criteria "  " 经 parse 拆为 ["  "] → 逐条 trim 后全空 → 空数组 → 保留旧值（与 handleCreate 同规则，第二入口不写入非法数组） | ① state.successCriteria === ["new a","new b"]；② state.successCriteria 仍为旧数组 | 异常 |
| U22b | index.ts:__goalInit | pi.__goalInit("objective", undefined, ctx, "slug", ["cond A","cond B"]) | 返回 true 且 state.successCriteria 深等于 ["cond A","cond B"]（GoalInitFn 签名 string[] 防漂移） | 正常 |
| U23 | command-adapter.ts:handleStatus | state.successCriteria = ["s1","s2"] | notify 文本含 "Success criteria:" 且逐条编号显示（非数组 toString 逗号拼接） | 正常 |
| U23b | gui.ts:buildGoalGui | state.successCriteria = ["cond A","cond B"]（数组直读，不再拆行） | GUI 描述符 criteria list-tree 行数为 2 且文本深等于数组条目（迁移后消费点简化） | 正常 |
| U23c | types.ts:GoalRuntimeState; goal.ts:createGoalState; service.ts:createGoal | createGoalState("obj", {}, "slug", ["a","b"]) 与 service.createGoal(...,["a","b"]) | 两者返回的 state.successCriteria 均深等于 ["a","b"]（类型链 string[] 透传——types/goal/service 三文件类型跟随的直接断言） | 正常 |
| U24 | goal-control-prompt.test.ts | 读 adapter 源码文本 | description 含「3~8 条」粒度约束、「引用」（不复制规格）指引；参数 description 含「单行」与数组说明；promptGuidelines 含粒度英文句（三层 lock，防回滚） | 正常 |
| U25 | compact-handler.test.ts:buildPlanSuccessCriteria; compact.ts:buildPlanSuccessCriteria | plan 文件 5 步 | 返回 string[]：1 条 "All 5 steps of <basename> executed and verified" + 前 3 条 step preview（各截断） | 正常 |
| U26 | compact.ts:tryGoalInit | detectGoalCapability true 路径（stub __goalInit 记录入参） | 第 5 参数为 string[]（编译期类型 + 运行时形态双验证） | 正常 |
| U27 | goal-control-rpc.test.ts / gui.test.ts / index.test.ts / service.test.ts / event-adapter.test.ts | 存量 fixture successCriteria: "y" → ["y"]（六文件全量清单） | 全部回归通过（无行为断言变化） | 正常 |
| U28 | goal-control-adapter.ts:GoalControlParams + handleCreate | ① schema 层：successCriteria: [1,2,3]（数值元素）/ ["a",null] → Value.Check false（items type string 拦非字符串元素）；② handler 层（测试直调不经 schema）：successCriteria: [1,null,true] → throw /successCriteria/（运行时 typeof 校验防御，不 crash） | ① false；② throw 带 Correct: 正例 | 异常 |
| U29 | prompts.ts:continuationPrompt; prompts.ts:budgetLimitPrompt; prompts.ts:objectiveUpdatedPrompt; prompts.ts:contextInjectionPrompt | 分别调 4 函数，state 含 ["cond A","cond B"] | 每个输出均含编号列表 `1. cond A\n2. cond B`（端到端穿透，非仅 successCriteriaBlock 单元） | 正常 |

## E2E 用例清单

测试栈探测：extensions/* 包用 vitest（无 Playwright/Cypress；`pnpm extensions:test` 聚合）。real 层按 AGENTS.md 用本地 pi CLI RPC 实测 extension。

| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|--------|------|------|------|---------|
| E1 | goal_control create 数组 → 持久化 → 重新加载全链路（index.test 集成：注册 tool → execute create 成功 → persistState 落盘 → 新 session deserialize → prompt 注入含编号列表） | mock | fake ports + stub pi-sdk（现有 stubs/pi-sdk.ts） | execute create(successCriteria:["e2e cond a","e2e cond b"]) → 读 session 文件 JSON → 新 session load → 调 contextInjectionPrompt | session 文件 successCriteria 为数组；重载后 state.successCriteria === 原数组；prompt 含 "1. e2e cond a" | `cd extensions/universal/goal && pnpm vitest run src/__tests__/index.test.ts` |
| E2 | 旧版 session 文件（string criteria）真实加载迁移 + pi CLI 实测 create 数组 | real | 本地 pi CLI（`pi --mode rpc --extension extensions/universal/goal --session-dir <tmp>`，模型 xiaomi-token-plan-cn/mimo-v2.5-pro） | ① 手造含 string successCriteria 的 goal-state entry 塞进 tmp session JSONL → 起 pi 发 /goal status；② 同 session 发 prompt 触发 goal_control create（数组）→ 读 session 文件 | ① status 输出编号列表（旧 string 已拆行迁移，不 throw）；② 新 create 的数组写入 session 文件、状态栏 widget 显示条件摘要 | manual（AGENTS.md「extension 改动优先本地 pi CLI 实测」） |

## 覆盖率 gate

- gate 命令：`cd extensions/universal/goal && pnpm vitest run --coverage`（@vitest/coverage-v8 已在 devDependencies）
- 阈值：本次改动文件行覆盖率 ≥ 60%（goal 包当前无既有阈值配置，60% 为下限；persistence/prompts/adapter 校验分支为目标高覆盖区）
- plan 包：`cd extensions/universal/plan && pnpm vitest run`（compact.ts 改动回归，不单设覆盖率阈值）
- gate 位置：W2 完成后独立验证 todo 执行

## 实现步骤

1. [W1] TDD：先写 U1-U15b + U22b + U25/U26/U28 失败测试（schema 数组形态与边界 / handleCreate 校验含 CRLF+unicode / deserialize 迁移含 CRLF+脏数据+超限+history round-trip / property 双路 / plan compact 数组 / __goalInit 签名）→ 实现 types/goal/service/index/adapter-schema+校验/persistence 迁移/plan compact.ts → `pnpm --filter @zhushanwen/pi-goal test && pnpm --filter @zhushanwen/pi-plan test` 绿 → `pnpm extensions:typecheck` 绿 → git commit
2. [W2] TDD：先写 U16-U24 + U27 + U29 失败测试（prompts 编号列表+escape+二次转义含流程级+4 函数穿透 / widget join+截断+分号同形 / parseGoalArgs 分号拆 / status 显示 / handleUpdate 第二入口跨层契约 / prompt-lock 粒度约束 / 存量 fixture 六文件适配）→ 实现 prompts/widget/commands/command-adapter + 引导文本三层修正 → goal 包全量测试绿 → `pnpm extensions:lint` 绿 → git commit
3. [验收] 覆盖率 gate（60%）→ E1 vitest 集成 → E2 pi CLI 实测 → CW test gate
