# workflow/subagent 支持 run 级 model/thinkingLevel override（含 max）

> **一句话结论**：让 agent 调用 workflow/subagent 工具时能用顶层 `model`/`thinkingLevel` 选模型，该 run 内所有子 agent 默认继承。采用**对称单路径注入**（两者都只走 worker global），需改 review-fix-loop 读 `$MODEL`（3 文件 5 处）+ tool-workflow 补撞名保护。功能已在 `fix-workflow-subagent-thinking-level` 分支实现，本文把它移植到 `feat-optimize-subagent-workflow-load` 分支的重构后架构。

---

## 开篇（SCQA）

- **S（情境）**：xyz-agent 给 agent 提供 `workflow` 和 `subagent` 两个工具。`workflow` 跑多步编排（如 review-fix-loop 审查-修复循环），内部启动多个子 agent；`subagent` 启动单个子 agent。
- **C（冲突）**：现状 agent 无法在 run 级选模型——workflow/subagent 启动的子 agent 只能继承主 agent 当前模型；且 subagent 的 `thinkingLevel` 缺 `max` 档位（SSOT 常量漏了）。
- **Q（问题）**：怎么让两个工具都能用顶层 `model`/`thinkingLevel` 选模型，该 run 内所有子 agent 默认继承，且只改一个 SSOT 常量就能加新 thinking 档位？
- **A（答案）**：顶层字段 + worker global 单路径注入 + review-fix-loop 改读 `$MODEL`。功能源分支已实现并审查，本文阐述移植到重构后架构的适配。

---

## 1. 背景：被设计的系统是什么

**workflow/subagent 是 agent 的"委派"工具——把一个任务拆给多个子 agent 协作完成，模型选择是委派的核心控制点。**

`workflow` 工具执行编排脚本（如 `review-fix-loop.js`），脚本内部用 `agent()` 函数启动一批批子 agent（审查员、修复员、汇总员）。`subagent` 工具启动单个子 agent。两者都经 worker_threads 子进程跑，每个子 agent 调一次 LLM。

**run 级 override 的使用者场景**：agent 决定"这次 review 用 glm-5.1 + max 思考深度"——它希望**该 run 内所有子 agent 都继承**这个选择，而不是逐个 agent 指定。源分支 `fix-workflow-subagent-thinking-level` 已实现该能力（3 commit），本文把它落到本分支的重构后架构。

> **两分支关系**：都从 `main@ed50bfd65` 分叉。源分支领先 main 3 commit（功能实现）；本分支领先 main 32 commit（subagent-workflow 大重构）。合并不了——架构已断裂（见 §3）。

---

## 2. 设计目标

**改造后 agent 能用一致的顶层字段选模型，且该 run 内所有子 agent 默认继承。**

1. **一致体验**：`workflow` 和 `subagent` 都用顶层 `model`/`thinkingLevel` 选模型（不是塞进 args）
2. **完整级别**：`thinkingLevel` 覆盖 pi-ai 全部取值（含 `max`），不静默 clamp
3. **统一继承**：run 级 override 是该 run 的默认，所有子 agent 默认继承（除非 per-subtask 显式指定）
4. **单一改动点**：新增 thinking 档位只改一个 SSOT 常量（`THINKING_ORDER`）
5. **零配置优先**：`model`/`thinkingLevel` 默认省略（继承主 agent 模型），仅当用户明确要求时 agent 才填

**In-scope**：移植源分支功能到本分支架构（model/thinkingLevel 顶层字段 + worker global 注入 + thinkingLevel 加 max + subagent schema 派生）

**Out-of-scope**：嵌套 workflow（workflow 内调 workflow）的 override 继承——已知限制（§10 L1），本次声明不修

---

## 3. 现状：两个分支的差异与移植障碍

**移植障碍的根因是 `tool-workflow.ts` 的架构断裂——源分支基于旧架构改，本分支已重构，必须在新架构上重新实现。**

### 3.1 源分支已实现的终态（参照）

源分支让 agent 能这样调用：

```
[agent] workflow run review-fix-loop --args targetType=git-diff target=main batch1=... --model glm/glm-5.1 --thinkingLevel max
```

机制：顶层 `model`/`thinkingLevel` 经「args merge（路径1）+ worker global（路径2）」双路径注入。但源分支的注入是**对称的**（model 和 thinkingLevel 都 merge 进 args）——这点埋了个致命缺陷（§6 D1 详述）。

### 3.2 本分支重构后的关键架构变化

本分支对 `subagent-workflow` 做了大幅重构，三项变化直接决定移植方式：

**变化一：平铺检测从硬编码枚举改为 schema 驱动**

```
旧（源分支改的对象）：                  新（本分支现状）：
KNOWN_ARG_KEYS = [21个硬编码键]         已删除
                                        TOOL_TOP_LEVEL = Set([tool 自身顶层键])  ← 撞名保护
                                        argKeysFromMeta(parameters) → {exact, patterns}  ← 动态构建
                                        findFlattenedArgKeys(params, exact, patterns)
```

源分支决策「从 `KNOWN_ARG_KEYS` 删 model」在本分支**无对应对象**——该数组已不存在。

**变化二：actionRun 引入参数校验 chokepoint**

`actionRun` 调 `runWorkflow` 前经 `validateRunArgs(spec)`（`args-validator.ts`）用 ajv 校验 `spec.args`。源分支把 model merge 进 args 的做法，**会经过这个 chokepoint**——源分支时代不存在的链路。

**变化三**：其他文件（worker 链路、model-resolver、run-spec、subagent-tool）本分支未改，源分支改动可干净搬入。

### 3.3 为什么不能 git merge

| 维度 | 源分支 | 本分支 |
|------|--------|--------|
| 平铺检测键源 | 改 `KNOWN_ARG_KEYS` | **已删除**，改为 `argKeysFromMeta` 动态构建 |
| actionRun 结构 | 旧结构末尾加注入 | 重构：`registry.getPath` 前置 + `ArgsValidationError` try/catch |

`tool-workflow.ts` 的 `git merge` 必然冲突，"解法"= 在新架构上重写。其余文件大部分干净可搬。

---

## 4. 物理数据流：model 怎么从用户传到子 agent

**model 经 RunSpec → workerData → worker global → agent() → resolveModel 五跳传到子 agent，thinkingLevel 走完全相同的路径（对称）。**

> **关键术语**：
> - **worker global**（`$MODEL`/`$THINKING_LEVEL`）= worker 进程启动时注入的进程级变量，该 worker 内所有 `agent()` 调用默认继承。物理上由 `worker-script-builder.ts` 从 `workerData` 构造。
> - **paramOverride** = `resolveModel` 函数的第三参数（`{model?, thinkingLevel?}`），优先级最高。物理上由 `subagent-service.ts` 的 `resolveIdentity` 从 agent-call 的 `opts.model` 构造。
> - **TOOL_TOP_LEVEL** = `tool-workflow.ts` 的一个 Set，登记 tool 自身的顶层键（action/name/slug/runId/args/tokens/time/error），平铺检测时排除——防止 workflow 参数名与 tool 键撞名时误报。

**终态数据流（Option B 对称）**：

```
[agent 调用] {action:"run", name:"review-fix-loop", args:{...}, model:"glm/5.1", thinkingLevel:"max"}
  │
  ▼ actionRun（tool-workflow.ts）
  │   ① TOPLVL 撞名保护：model/thinkingLevel 在 TOOL_TOP_LEVEL → 不进 workflow 的 exact → 不误报平铺
  │   ② args = params.args ?? {}  ← model/thinkingLevel 不 merge 进 args（对称关键）
  │   ③ runWorkflow({ args, parameters, model: params.model, thinkingLevel: params.thinkingLevel, ... })
  ▼ runWorkflow（lifecycle.ts）
  │   ④ validateRunArgs(spec) ← chokepoint 只校验 args，model/thinkingLevel 不在 args，不涉及
  │   ⑤ workerHost.start(spec, spec.args, handlers)
  ▼ worker 进程（workerData = { args, model: spec.model, thinkingLevel: spec.thinkingLevel, ... }）
  │   ⑥ buildWorkerScript 注入 $MODEL / $THINKING_LEVEL global（worker-script-builder.ts）
  ▼ workflow 脚本内 agent() 调用
  │   ⑦ review-fix-loop: MODEL = $MODEL; agent({..., model: MODEL})  ← opts.model 已传
  │      chain/parallel/...: agent({prompt,...})  ← opts.model 未传 → fallback $MODEL
  │   ⑧ postMessage agent-call → 主线程 resolveIdentity 构造 paramOverride
  ▼ resolveModel（model-resolver.ts）
     ⑨ if (paramOverride?.model) → 用顶层 model（优先级1）
        else if (agentConfig?.model) → 用 frontmatter model（优先级2）
        else → ctxModel（优先级3，主 agent 模型兜底）
     → lookupAndResolve（clamp thinkingLevel + auth 校验）
```

**对称性**：model 和 thinkingLevel 走完全相同的 5 跳路径。无 args merge，无双路径分歧。

---

## 5. 终态：agent 眼里将是什么样的

### 5.1 成功路径

```
[用户] 帮我对 src/auth.ts 做多轮 review，用 glm-5.1 + max 思考深度，发现问题就修
[agent] （识别要用 review-fix-loop，决定 run 级模型）
[agent 调用] {"action":"run","name":"review-fix-loop","args":{"targetType":"git-diff","target":"main","batch1":"/path/reviewer.md"},"model":"glm/glm-5.1","thinkingLevel":"max"}
[工具返回] Started workflow 'review-fix-loop' · run-xxx. Running in background.
[review-fix-loop 内部] review批 → aggregate → fix批 → 重审
  ↳ 每批的 agent() 都继承 glm-5.1 + max（无需逐个指定）
[工具返回] done: All batches clean. 15 issue(s) fixed.
```

省略 `model`/`thinkingLevel` 时，子 agent 继承主 agent 当前模型（零配置默认）。

### 5.2 失败路径（带恢复指引）

**失败 A：model 无效**

```
[agent 调用] {"action":"run",...,"model":"nonexistent/x"}
[reviewer agent 报错] Model "nonexistent/x" not found in registry (paramOverride)
[该 agent 失败被 SubprocessAgentRunner try/catch 吞，workflow 继续后续 agent]
```
👉 **恢复**：换用 valid model 重试；或省略 `model` 继承主 agent 模型。单个 agent 失败不终止整个 run（设计目标：单 call 失败降级，非 run 终止）。

**失败 B：thinkingLevel 非法值**

```
[agent 调用] {"action":"run",...,"thinkingLevel":"invalid"}
[agent 继承后] resolveModel 的 lookupAndResolve 把非法 thinkingLevel clamp 到目标 model 最高可用档
```
👉 **恢复**：用 valid 值（off/minimal/low/medium/high/xhigh/max）；非法值不报错，静默 clamp（pre-existing 行为）。

**失败 C：review-fix-loop 收到旧的 args.model（Option B breaking 变更）**

```
[agent 误用旧用法] {"action":"run","name":"review-fix-loop","args":{"model":"x",...}}
[工具返回] 未知参数: model（合法参数: targetType/target/...）  ← fail-fast
```
👉 **恢复**：model 已升格为顶层工具参数，改用顶层 `--model`：`{"action":"run",...,"model":"x"}`。用 `workflow info review-fix-loop` 重看参数列表。

---

## 6. 关键决策与权衡

### 6.1 D1 注入策略：对称单路径（选）vs 非对称双路径

**选对称单路径（Option B）：model 和 thinkingLevel 都只走 worker global，不 merge 进 args。**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|------------|------|------|
| **Option B 对称（选）**：都走 worker global，review-fix-loop 改读 `$MODEL` | 对称统一，无 args merge / 无 ajv chokepoint 论证 / 无非对称认知负担 | 改 review-fix-loop.js + utils.cjs + test 共 5 处（机械替换）；tool-workflow 补撞名保护 | 改内置 workflow 有回归风险（可控：3 处机械替换 + 端到端验证） | ✅ |
| Option A 非对称：model 走 args merge + global，thinkingLevel 只走 global | model 进 args 经 ajv chokepoint + 撞名保护 + 非对称专属探针（~40% 复杂度）；认知负担（为何两者路径不同） | tool-workflow 改动多（args merge + TOOL_TOP_LEVEL + TC3g + ajv 论证） | 非对称建立在伪前提（见下） | ❌ |

**Option A 的伪前提**：它把「review-fix-loop 读 `$ARGS.model`」当成不可改的架构约束。实际这只是 1 行实现选择——改成读 `$MODEL` global，对称就成立。Option A 为规避这 1 行改动，引入 args merge + 撞名保护 + 双层 chokepoint 论证 + 4 个非对称专属探针。

**若用 Option A，§5 的例子会怎样**：行为等价（最终子 agent 都继承顶层 model），但实现层 model 和 thinkingLevel 走不同路径，维护者要解释"为什么 model 进 args 而 thinkingLevel 不进"——且 model 进 args 要额外论证它不被 ajv chokepoint 拒绝、不被平铺检测误报。

**等价性边界（诚实声明）**：正常值/空串/不传三种边界，两方案行为一致。唯一差异是 **whitespace model**（`"  "`）：Option B 下 `$MODEL="  "`（不 trim）→ resolveModel truthy 命中 → lookup 抛错终止该 agent；源分支 Option A 现状有 `.trim()` 静默降级。两者非逐字等价，但 whitespace model 是畸形输入（LLM 不会主动填空白），现实概率极低。Option B 的快失败行为更严格，可接受。

### 6.2 D2 TOOL_TOP_LEVEL 必须加 model/thinkingLevel

**选**：`TOOL_TOP_LEVEL` Set 加 `"model"`、`"thinkingLevel"` 两键。

**证据**：`argKeysFromMeta`（tool-workflow.ts）构建平铺检测的 exact 集时，只排除 `TOOL_TOP_LEVEL` 成员。Option B 不把 model merge 进 args——于是**任何声明 `model`/`thinkingLevel` 参数的 workflow**（review-fix-loop 曾是先例，model 是高频参数名），顶层 model 会被 `findFlattenedArgKeys` 误报为"该塞进 args"。

**若不加**：§5.1 的成功路径调用会报「Detected model at top level — they belong inside 'args'」，agent 无法用顶层 model。

**被否**：删 review-fix-loop 的 model 声明就够了（只解决 review-fix-loop，不解决其他可能声明 model 的用户自定义 workflow）。

### 6.3 D3 review-fix-loop 改读 $MODEL（4 处代码 + 1 处测试）

**选**：review-fix-loop 的 MODEL 读取源从 `$ARGS.model` 改为 `$MODEL` global，配套删 args 相关声明。

| # | 文件 | 改动 |
|---|------|------|
| 1 | review-fix-loop.js `MODEL` 定义 | `typeof $ARGS.model === "string" && $ARGS.model.trim() ? ... : undefined` → `const MODEL = $MODEL;` |
| 2 | review-fix-loop.js `@pi-meta` | 删 `model: { type: string }` 声明 |
| 3 | review-fix-loop.js fail 文案 | 删 `合法参数:` 列表里的 `/model`（避免"未知参数: model（合法参数: ...model...）"自相矛盾） |
| 4 | review-fix-loop-utils.cjs | `VALID_ARG_KEYS` Set 删 `"model"` |
| 5 | review-fix-loop-utils.test.ts | expected 数组删 `"model"`（否则 toEqual 断言崩） |

**为何打破「workflows/*.js 不动」原则**：review-fix-loop 的 `args.model` 用法**未文档化**（usage 示例只示 targetType/target/batch1/autoCommit）。5 处都是机械替换，回归风险可控。收益（对称简化）大于代价。

**若不改 review-fix-loop**：它仍读 `$ARGS.model`，而 Option B 不把 model merge 进 args → `$ARGS.model` 恒空 → MODEL 恒 undefined → review-fix-loop 的子 agent 无法继承顶层 model（目标 3 破坏）。

### 6.4 D4 P0-10 消解机制：resolveModel 的 paramOverride 优先

**源 review 的 P0-10 担心**：review-fix-loop 若用 `model: MODEL || def.model`，reviewer agent 的 frontmatter model（`def.model`）会压制顶层 model。

**本分支现状**：三处消费点（review batch / aggregator / fix）都已改为 `model: MODEL,`（无 `|| def.model` 短路）。

**消解机制**（经代码实证）：靠 `resolveModel`（model-resolver.ts）的 `paramOverride?.model` truthy 判定（优先级1），压制 `agentConfig.model`（frontmatter，优先级2）与 ctxModel（优先级3）。链路：review-fix-loop 传 `model:MODEL` → agent() opts.model → postMessage → `resolveIdentity`（subagent-service.ts）构造 `{model: opts.model}` 作 paramOverride → resolveModel 优先级1 命中。

**已有测试守护**：`model-resolver.test.ts` 的 `describe("resolveModel — three-layer priority")` 含 L1（paramOverride 胜出）/L2（agentConfig）/L3（ctxModel）三个用例，优先级链已被覆盖。

---

## 7. 实现机制：文件改动分类

**改动分 A/B/C/D 四类。A 类干净搬入，B 类叠加，C 类架构断裂重写，D 类 Option B 新增的内置 workflow 改造。**

### A 类 · 本分支未改，源分支改动干净搬入（6 文件）

| 文件 | 源分支改动 | 搬入方式 |
|------|-----------|---------|
| `model-resolver.ts` | `THINKING_ORDER` 加 `"max"` + `export` + SSOT 注释 | 原样（本分支与 merge-base 字节一致，git apply 干净） |
| `worker-script-builder.ts` | 注入 `$MODEL`/`$THINKING_LEVEL` global + `agent()` 三分支 fallback | 原样（同上） |
| `worker-host.ts` | workerData 加 `model`/`thinkingLevel` 透传 | 原样（同上） |
| `model-resolver.test.ts` | 追加 P1/P2 探针 | 向现有文件追加（须在 model-resolver.ts 改后，否则引用 max 会红） |
| `worker-script-builder.test.ts` | 改 1 条既有断言 + 追加 P3/P4 | 向现有文件追加（**须与 worker-script-builder.ts 同批迁移**） |
| `.xyz-harness/workflow-subagent-thinking-level/{spec,review}.md` | 设计文档 | 新文件（从源分支 repo root 复制） |

### B 类 · 两边改不同区域，叠加（2 文件）

| 文件 | 源分支改的区域 | 本分支改的区域 |
|------|--------------|--------------|
| `run-spec.ts` | 加 `model?`/`thinkingLevel?` 字段 | 加 `parameters?` 字段（不重叠） |
| `subagent-tool.ts` | thinkingLevel 枚举从 `THINKING_ORDER` 派生 | 改 `agent` 字段 description（不重叠） |

> `run-spec.ts` 源 diff 注释引用已推翻的决策，搬入时改写为「Option B：经 worker global」。

### C 类 · 架构断裂，新架构上重写（2 文件）

| 文件 | 重写要点 |
|------|---------|
| `tool-workflow.ts` | `TOOL_TOP_LEVEL` 加 model/thinkingLevel（D2）+ `WorkflowParams` 加两个 Optional 字段 + actionRun 加 RunSpec 透传 + prompt 加默认省略条。**无 args merge** |
| `detectors.test.ts` | TC3g 第一条 toEqual 删 `"model"`（model 加 TOOL_TOP_LEVEL 后不进 exact）；第二条（args 内 model）不变 |

### D 类 · Option B 新增——内置 workflow 改造（3 文件，见 §6.3 D3 表）

---

## 8. 实施路径与文件改动地图

**分 4 阶段交付，A→B→C→D，每阶段可独立验证。**

| 阶段 | 内容 | 验证 |
|------|------|------|
| 1 | A 类搬入（6 文件） | model-resolver/worker-script-builder 测试绿 + typecheck |
| 2 | B 类叠加（2 文件） | typecheck（RunSpec 字段链路完整） |
| 3 | C 类重写（2 文件） | detectors.test.ts TC3g 绿 + tool-workflow grep 验证 |
| 4 | D 类改造（3 文件） | review-fix-loop-utils.test.ts 绿 + 端到端跑一次 review-fix-loop |

**文件改动地图**：

```
extensions/subagent-workflow/
├── src/execution/
│   ├── model-resolver.ts                 [A] THINKING_ORDER +max +export
│   └── __tests__/model-resolver.test.ts  [A] 追加 P1/P2
├── src/interface/
│   ├── subagent-tool.ts                  [B] thinkingLevel 枚举从 THINKING_ORDER 派生
│   ├── tool-workflow.ts                  [C] TOOL_TOP_LEVEL +model/thinkingLevel / WorkflowParams +字段 / actionRun +透传 / prompt
│   └── __tests__/detectors.test.ts       [C] TC3g 第一条删 model
├── src/orchestration/
│   ├── models/run-spec.ts                [B] RunSpec +model?/thinkingLevel?
│   ├── worker-host.ts                    [A] workerData 透传
│   ├── worker-script-builder.ts          [A] $MODEL/$THINKING_LEVEL global + agent() fallback
│   └── __tests__/worker-script-builder.test.ts [A] 追加 P3/P4（须与 builder 同批）
├── src/__tests__/
│   ├── review-fix-loop-utils.test.ts     [D] expected 删 model
│   └── worker-integration-harness.test.ts [新] worker 集成 harness（P3/P4/P-T2 运行时验证）
└── workflows/
    ├── review-fix-loop.js                [D] MODEL=$MODEL + 删@pi-meta model + 删fail文案 model
    └── review-fix-loop-utils.cjs         [D] VALID_ARG_KEYS 删 model

workflows/*.js（chain/parallel/map-reduce/scatter-gather）  [不动]
.xyz-harness/workflow-subagent-thinking-level/             [A] spec.md + review.md
```

**无需改动的文件（给证据避免实施者困惑）**：
- `lifecycle.ts` / `error-recovery.ts`：三处 `workerHost.start` 都传整个 spec，RunSpec 加字段后自动透传（grep 确认无显式 `spec.model`）
- `model-resolver.ts` 的 `resolveModel`：三层优先级链现成（已有 L1/L2/L3 测试守护）
- `subagent-service.ts` 的 `resolveIdentity`：构造 paramOverride 现成
- `agent-opts-resolver.ts`：只处理 skill/schema，不碰 model（M2 重构后）
- `launcher.ts`：嵌套 workflow 不继承外层 override（§10 L1 已知限制）
- `jsonl-run-store.ts`：RunSnapshot.spec 全量持久化，新可选字段安全 round-trip

---

## 9. 探针清单（运行时断言附探针）

**每条运行时行为断言配探针。⛔ = 实施期门，✅ = 已实测。**

| ID | 验证的行为 | 类型 | 状态 |
|---|---|---|---|
| P1 | `THINKING_ORDER` 加 max 后 `stripThinkingSuffix("p/m:max")` → `"p/m"` | 单测 | ⛔ |
| P2 | `availableThinkingLevels` 列出 max 且为末位 | 单测 | ⛔ |
| P3 | workflow 顶层 model 经 `$MODEL` global 被 agent() 默认继承。**需 worker harness**，短期降级源码断言 | 集成 | ⛔ |
| P4 | workflow 顶层 thinkingLevel 经 `$THINKING_LEVEL` 继承并 clamp。**需 worker harness** | 集成 | ⛔ |
| P5 | review-fix-loop 顶层 model 压制 frontmatter（整链集成）：resolveIdentity→resolveModel paramOverride 透传。纯函数优先级已被 L1/L2/L3 覆盖 | 集成 | ⛔ |
| P6 | subagent schema 派生自 THINKING_ORDER 后枚举含 max | 单测 | ⛔ |
| P7 | `findFlattenedArgKeys` 对顶层 model/thinkingLevel 不误报（在 TOOL_TOP_LEVEL 后） | 单测 | ⛔ |
| P-T2 | VALID_ARG_KEYS 白名单删 model 后不崩。**需 worker harness** 或断言 Set 内容 | 集成 | ⛔ |
| P-T3 | 对称验证：model+thinkingLevel 都不进 `$ARGS`（part1 单测可执行）；都经 global 继承（part2 需 harness） | 集成 | ⛔ |
| P-T4 | detectors.test.ts TC3g 修订后通过（第一条无 model，第二条不变） | 单测 | ⛔ |
| P-D1 | Option B 改造正确性：review-fix-loop 改后 MODEL=$MODEL + @pi-meta 无 model + VALID_ARG_KEYS 无 model + fail 文案无 model；运行传顶层 model 三处 agent 继承 | 集成 | ⛔ |

**探针可执行性**：11 个中 7 个单测可直接执行（P1/P2/P5/P6/P7/P-T4/P-D1 part1），4 个需 worker harness（P3/P4/P-T2/P-T3-part2）。未建 harness 时降级源码字符串断言（覆盖"注入逻辑写对"非"运行时真生效"）。**最高优先级门是 P-T3 + P-D1**——守护对称改造。

**测试命令**（实施时 grep 确认路径）：
```bash
cd extensions/subagent-workflow && npx vitest run \
  src/execution/__tests__/model-resolver.test.ts \
  src/orchestration/__tests__/worker-script-builder.test.ts \
  src/interface/__tests__/detectors.test.ts \
  src/__tests__/review-fix-loop-utils.test.ts
pnpm extensions:typecheck && pnpm extensions:lint
```

---

## 10. 待验证检查点与已知限制

### 待验证检查点（设计阶段无法确定，留实施期）

1. **pi SDK 对 tool params 未知字段策略**：顶层 model/thinkingLevel 不被 pi 拒绝。实施时调一次 workflow tool 传顶层 model 验证
2. **worker-script-builder 字符串拼接正确性**：`$MODEL`/`$THINKING_LEVEL` 注入转义/作用域（P3/P4 覆盖）
3. **resume/rebuild 路径透传**：三处 `workerHost.start` 都传 spec，override 在 pause→resume 保留。建议跑一次 run→pause→resume 确认
4. **GUI 侧**：workflow renderCall 展示 model——out-of-scope，确认不报错
5. **错误呈现层级**：顶层 model 无效时，resolveModel `lookupAndResolve` 抛错 → SubprocessAgentRunner.run try/catch → `AgentResult.error`（单 call 失败被吞，workflow 继续）。**不期望** workflow 整体终止

### 已知限制（接受代价，不在本次解决）

- **L1 嵌套 workflow 不继承外层 override**：`executeNestedWorkflow` 构建子 RunSpec 时不设 model/thinkingLevel → 子 worker global 为 undefined → agent() fallback 到 ctxModel，**静默降级**（不报错）。**长期增强**（非本次）：补 `model: parentRun.spec.model`。本次声明为已知限制
- **L2 review-fix-loop 不再接受 `args.model`（Option B breaking）**：删 VALID_ARG_KEYS 的 model 后，旧用法 `--args model=x` fail-fast。顶层 `--model` 提供等价能力
- **L3 whitespace model 抛 lookup 错**：Option B 下 `$MODEL` 不 trim，whitespace model 抛"Model not found"终止该 agent（非 trim 降级）。畸形输入现实概率极低

---

## 附录：源分支设计文档

完整的设计背景（SCQA、双注入机制原理、消费点对照、决策 D1-D7 原文）见源分支 `.xyz-harness/workflow-subagent-thinking-level/spec.md`（技术方案）+ `review.md`（对抗式审查）。本文不复制其内容，只阐述移植到本分支架构的差异与适配。
