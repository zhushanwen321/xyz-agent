# 独立 LLM 调用共享库 + 配置统一收口 设计文档

> **设计层**：技术方案设计（当前层）→ 实现任务（下一层）
> **下一层产物性质**：可实现的接口 / 数据模型 / 技术方案 → §3 侧重接口先行、数据模型、错误规格、选型对比
> **涉及运行时行为**（LLM 调用、配置读取、凭证解析、错误处理）→ 准则 5/6/7 全适用，运行时断言附探针

---

## 0. 关键决策摘要（供快速 review）

本文档涉及 5 个核心设计决策，每个在 §3.3 有完整方案对比。摘要如下，标注「**待你确认**」的项尤其需要 review：

| # | 决策 | 推荐 | 关键理由 | 状态 |
|---|------|------|---------|------|
| A | rename/permission 的独立 model 怎么选 | `ModelSelector` 四形式：精确 ref / fallback / available / **scoped**（自读 settings.json 的 enabledModels）；rename 默认配 scoped | 用户确认要 scoped（接受自读 settings.json）；scoped 是用户显式排序列表，取首个比 getAvailable 更可控 | **已确认：支持 scoped** |
| B | 共享库 API 风格 | 无状态函数式 `callLLM(ctx, opts)` | 易测试、符合现有 extension 函数式风格、无生命周期负担 | 推荐 |
| C | permission 的 classifier 要不要一并收口 | 收口（C1），废弃其自读 `models.json` 的 `model-resolver`，改走 `ctx.modelRegistry` | permission 自读只读一源（读不到内置 provider + OAuth 凭证），是已知缺陷 | **已确认：C1 一起收口** |
| D | 新配置包的 scope | 只做「LLM 调用相关配置」一个包；硬编码路径修正作为独立改动 | 聚焦本需求主线，不过度扩张成通用配置基础设施 | 推荐 |
| E | 要不要提供「智能选模（auto）」 | 不提供；用显式 selector | xyz-agent 环境 models.json 普遍不填 `cost`，permission 的 `auto` 实测退化为字典序首个，语义失真 | 推荐 |
| F | model 解析要不要复用 runtime 逻辑 | **不复用**，走 `ctx.modelRegistry`（方案 D） | runtime 是 private 包 import 不到 + 路径不同 + 无多源合并；`ctx.modelRegistry` 是运行时权威（含 OAuth/env 多源凭证） | **已确认：方案 D** |

**📌 scoped-model 的实现方式（用户已确认）**（详见 §2.3 问题 5 + §3.3 决策 A）：pi 的 `ExtensionContext` **不暴露任何 settings 读取 API**（无 `getSettings()` / `getEnabledModels()`，grep types.d.ts 零命中）。用户确认接受 **自读 `<agentDir>/settings.json` 的 `enabledModels` 字段** 来实现 scoped 选择——由共享库封装读取 + glob 匹配。需注意区分：这里读的是「用户启用的 model 列表」配置，**不是凭证**（凭证仍走 `ctx.modelRegistry.getApiKeyAndHeaders`），与「凭证走 pi 底层能力」原则不冲突。scoped 的优势：`enabledModels` 是用户显式排序的数组，取首个 = 用户意图，比 `getAvailable()` 取首个（三源合并序，隐式）更可控。

---

## 1. 背景目标

### 1.1 SCQA 开篇

- **Situation**：xyz-agent 在 `extensions/` 下维护 18 个 pi extension 包，其中 rename-session 和 permission 两个会在 extension 进程内直接发起 LLM 调用（分别用 `completeSimple` 和 `streamSimple`），各自独立处理「选哪个 model、怎么拿 apiKey、用什么 system prompt」。
- **Complication**：rename-session 的 LLM 调用完全「搭便车」——model、systemPrompt、apiKey、tools 全部复用主 session，既浪费（把几千 token 的 agent system prompt 塞给一个只需生成标题的调用）又不可控（跟随主 session 模型，无法指定便宜的小模型）。permission 则走了另一个极端——自己 `readFileSync(models.json)` 解析 model 和 apiKey，只读到单一数据源，读不到 pi 内置 provider 和 OAuth 凭证。整个 extension 体系的配置读取更是碎片化：7 种机制并存、4 种磁盘路径风格、5 个包硬编码 `~/.pi` 路径。
- **Question**：如何让 rename-session / permission 的 LLM 调用变成「独立配置、独立 model、独立 prompt」，并把这套能力沉淀为可复用的共享库，同时顺带收敛配置路径的混乱？
- **Answer**：新建一个 LLM 调用共享库（封装 model 选择 + 凭证解析 + 调用入口），把 rename 和 permission 收口到它；新建一个轻量配置包统一 LLM 相关配置的读写；删掉 3 个废弃 extension；修正剩余包的硬编码路径。

### 1.2 系统是什么（给不懂内部背景的读者）

**xyz-agent** 是 Electron 桌面 AI Agent 工作台，通过子进程 RPC 调用 **pi**（`@earendil-works/pi-coding-agent`）作为底层 AI 能力。**pi extension** 是 pi 的插件机制：每个 extension 是一个 npm 包，导出一个工厂函数，接收 `ExtensionAPI` 和 `ExtensionContext`，通过注册命令、监听事件（如 `turn_end`）、注册工具来扩展 pi 行为。

**Extension 能拿到什么**（`ExtensionContext` 的关键字段）：
- `ctx.model` —— 当前会话正在用的 model（宿主模型）
- `ctx.modelRegistry` —— model 注册表，提供 `getAll()` / `getAvailable()` / `find(provider, modelId)` / `getApiKeyAndHeaders(model)` 等方法（详见 §2.2）
- `ctx.sessionManager` —— 会话管理（读写 entries、session id 等）
- `ctx.getSystemPrompt()` —— 当前会话的 system prompt（含 AGENTS.md 等全部上下文）

**Extension 拿不到什么**（关键约束）：
- `ctx` **没有** settings 读取 API（无法读 `enabledModels` / `defaultModel`）
- `ctx` **没有** config/sessionData 持久化 API（pi extension SDK 不提供官方配置机制）

**pi 的 provider/model 配置是三文件分工**（均派生自 `getAgentDir()`，即 `PI_CODING_AGENT_DIR` env，默认 `~/.pi/agent`）：

| 文件 | 角色 | 谁写 |
|------|------|------|
| `models.json` | 用户手定义的 provider/model | 用户 |
| `models-store.json` | pi 内置 provider catalog + `pi auth login` 刷新的 OAuth provider | pi 运行时 |
| `auth.json` | apiKey 凭证（按 provider，明文） | pi（`pi auth login` / `set-key`） |

pi 启动时 `ModelRuntime.create()` 把三源合并成完整的 provider/model 定义。**这是 model 解析的权威入口**。

### 1.3 设计目标

从使用者（extension 开发者 + 终端用户）体验倒推：

1. **rename-session 用独立的小模型生成标题**：不再跟随主 session 的昂贵模型，可配置一个便宜快速的 model，system prompt 是 rename 专属的精简版（不再是整个 agent prompt）。
2. **LLM 调用能力可复用**：rename 和 permission（以及未来任何需要在 extension 进程内调 LLM 的场景）共享同一套「选 model + 拿凭证 + 发起调用」封装，不再各写一遍。
3. **凭证走 pi 底层能力**：统一通过 `ctx.modelRegistry` 解析 model 和 apiKey，不自读文件、不散落 env。
4. **配置有归处**：LLM 相关配置（model 选择、prompt 模板、开关）有统一的读写位置和范式。
5. **路径不再硬编码**：所有数据目录路径通过 pi 内置的 `getAgentDir()` 派生，支持实例隔离（`XYZ_AGENT_DATA_DIR`）。
6. **废弃包清除**：删除已不再适用的 3 个 extension，减少维护面。

### 1.4 Scope

**In scope**：
- 删除 `context-engineering` / `statusline` / `evolve-daily` 三个 extension 包
- 新建 LLM 调用共享库（封装 model 选择 + 凭证解析 + 调用入口）
- 收口 `rename-session`：独立 model / 独立 system prompt / 独立配置
- 收口 `permission` 的 classifier：从自读 `models.json` 迁到共享库（**已确认 C1，本次一起做**）
- 新建轻量配置包（LLM 相关配置读写）
- 修正 `model-switch` / `vision` / `scheduler` 的硬编码路径（改走 `getAgentDir()`）

**Out of scope**（本设计不做）：
- 不把全部 18 个 extension 的配置都迁到新配置包（只做 LLM 线相关；通用配置基础设施留待未来）
- 不改 `vision`（它 spawn pi 子进程，LLM 调用发生在子进程内，不属于「extension 进程内直接调 LLM」，不纳入收口）
- 不改 goal / todo / plan / scheduler / structured-output / ask-user / evolve-daily(已删) 等间接「注入 message 唤醒 pi」的包（它们不直接调 LLM，配置收口不在本次主线）
- 不重构 permission 的规则引擎 / pipeline（只收口它的 model 解析 + LLM 调用入口）
- 不推动 pi 上游给 `ExtensionContext` 加 settings API（成本高、节奏慢，本次用替代方案绕过）

---

## 2. 现状与问题分析

> **本节为设计启动时（P0-P4 收口前）的现状快照，行号指向收口前代码。** 收口后 `model-resolver.ts`（整体重写为 `listAvailableModels`，仅 106 行，`resolveClassifierModel`/`findCheapestModel`/`loadModelsJson`/`flattenModels` 均已删除）、`classifier.ts`、rename `llm.ts`（改走 `llm-shared.callLLM`）等均已重构（见 §3 决策 + §5 实施），此处引用的行号（如 `model-resolver.ts:132-167/242-298`、`classifier.ts:80/188-193`、`llm.ts:68-93`）均已失效，保留作设计决策的背景追溯。

### 2.1 LLM 调用现状：两个直接调用者，两种完全不同的做法

extension 进程内直接发起 LLM 调用的只有 **rename-session** 和 **permission** 两个（`vision` 是 spawn 子进程，不算；详见 §2.5）。

**rename-session**（`extensions/rename-session/src/llm.ts`）——「搭便车派」：

```ts
// llm.ts:68-93（精简）
const model = ctx.model;                                    // ← 复用主 session 模型
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);  // ← 复用主 session 凭证
const systemPrompt = ctx.getSystemPrompt();                 // ← 复用主 session 的完整 agent prompt（几千 token）
const messages = buildMessages(ctx.sessionManager.getEntries(), CONFIG.renameInstruction);
const mappedTools = mapToolsToAiFormat(pi.getAllTools());   // ← 把全部工具塞给 LLM（rename 根本不需要工具）
const { completeSimple } = await import("@earendil-works/pi-ai/compat");  // 动态 import
const resp = await completeSimple(model, context, { apiKey: auth.apiKey, ..., maxTokens: 64 });
```

**permission**（`extensions/permission/src/classifier/`）——「自读文件派」：

```ts
// classifier/model-resolver.ts:132-167（精简）—— 自己 readFileSync(models.json)，不走 modelRegistry
const file = loadModelsJson();                              // ← 只读 models.json 一源
const hasApiKey = typeof providerDef.apiKey === "string";   // ← 直接取 provider.apiKey 字段
// extensions/permission/src/classifier/classifier.ts:188-193 + extensions/permission/src/production.ts:45-51
const provider = getApiProvider(model.api);
return provider.streamSimple(model, context, { apiKey: resolved.apiKey, ... });
```

**两者的关键差异**：

| 维度 | rename-session | permission |
|------|----------------|------------|
| model 来源 | `ctx.model`（宿主当前模型） | 自读 `models.json` 的 `resolveClassifierModel` |
| 凭证来源 | `ctx.modelRegistry.getApiKeyAndHeaders` | 自读 `providerDef.apiKey` 字段 |
| system prompt | `ctx.getSystemPrompt()`（整个 agent prompt） | 硬编码英文 classifier prompt |
| 调用函数 | `completeSimple`（compat，动态 import） | `getApiProvider().streamSimple`（静态 import + `@ts-ignore`） |
| 数据源完整度 | ✅ 三源合并（走 modelRegistry） | ❌ 单源（只读 models.json，读不到内置 provider + OAuth） |

### 2.2 ExtensionContext.modelRegistry 接口（权威能力）

`ModelRegistry`（`pi-coding-agent/dist/core/model-registry.d.ts`，pi-coding-agent 独有，pi-ai 包无此类）的方法：

| 方法 | 签名 | 用途 |
|------|------|------|
| `getAll()` | `Model<Api>[]` | 所有 model（三源合并全量） |
| `getAvailable()` | `Model<Api>[]` | 已配 auth 的可用 model |
| `find(provider, modelId)` | `Model<Api> \| undefined` | 按 provider + modelId 精确查 |
| `hasConfiguredAuth(model)` | `boolean` | 该 model 的 provider 是否配 auth |
| `getApiKeyAndHeaders(model)` | `Promise<ResolvedRequestAuth>` | **解析凭证**，返回判别联合 |
| `getProviderAuthStatus(provider)` | `AuthStatus` | provider auth 状态 |
| `getApiKeyForProvider(provider)` | `Promise<string \| undefined>` | provider 级 apiKey |
| `isUsingOAuth(model)` | `boolean` | 是否走 OAuth |

`getApiKeyAndHeaders` 的返回是判别联合，必须 narrow：

```ts
type ResolvedRequestAuth =
    | { ok: true; apiKey?: string; headers?: Record<string,string>; env?: Record<string,string> }
    | { ok: false; error: string };
```

**关键缺失**：`ModelRegistry` **没有按 scope 列 model 的方法**，也没有暴露 `enabledModels`（那是 settings.json 的字段，`ctx` 读不到，见 §2.3 问题 5）。

### 2.3 关键问题（带真实证据）

**问题 1：rename-session 的 system prompt 浪费严重**

rename 只需要生成 3-8 个词的标题，却把整个 agent system prompt（含项目 AGENTS.md、技能列表、工具说明，通常数千 token）塞给 LLM。`maxTokens: 64` 限制了输出，但**输入侧的 system prompt 成本没有限制**——每次首 turn 都要付一次完整 system prompt 的 input token 费用。这是「搭便车」模式的根本浪费。

**问题 2：rename-session 的 tools 传递是纯浪费**

`pi.getAllTools()` 把全部工具定义（每个工具 name + description + parameters schema，加起来也是数千 token）传给 rename 调用。rename 生成标题**根本不需要调用任何工具**，这些 token 纯属浪费，还可能诱导 LLM 尝试 tool call。

**问题 3：rename-session 的 model 不可控**

`ctx.model` 跟随用户当前会话。用户用 Claude Sonnet 时 rename 也用 Sonnet（贵），无法指定「rename 永远用某个便宜小模型」。配置层完全硬编码（`pure.ts:CONFIG` 的 `switchFilePath` / `maxTitleLength` / `renameInstruction`），model 字段都没有。

**问题 4：permission 自读 models.json 是已知缺陷**

permission 的 `resolveClassifierModel` 自己 `readFileSync(models.json)`，**只读到用户手定义的 provider**，读不到：
- `models-store.json` 里的 pi 内置 provider（官方 Anthropic/OpenAI/Google 等）
- `auth.json` 里的 OAuth 凭证

后果：如果用户只通过 `pi auth login` 配置了官方 provider（没手写 models.json），permission 的 classifier **找不到任何可用 model**，`resolveClassifierModel` 返回 `null` → fail-closed 降级为 `ask`。permission 放弃了 pi 已经做好的三源合并能力，自己重新实现了一个残缺版。

**问题 5：scoped-model 选择需自读 settings.json（SDK 不暴露 settings API）**

用户期望「从 scoped-model 选择」（读 settings.json 的 `enabledModels`）。但实测 `ExtensionContext` **不暴露任何 settings 读取 API**：

```
# grep node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
# "getSettings" / "settingsManager" / "getEnabledModels" → 零命中
```

`ExtensionContext` 只有 `modelRegistry` / `model` / `sessionManager` / `getSystemPrompt()` 等，**没有 settings 访问**。`ExtensionCommandContext` 扩展也只有 session 控制方法。要读 `enabledModels` 只能自读 `<agentDir>/settings.json`。**用户已确认接受此方案**（决策 A）：scoped 作为 ModelSelector 的一种形式，由共享库封装 settings.json 读取 + glob 匹配。注意区分：这里读的是「用户启用列表」配置，**不是凭证**（凭证仍走 `modelRegistry.getApiKeyAndHeaders`），与「凭证走 pi 底层能力」原则不冲突。

**问题 6：permission 的 'auto' 智能选模在 xyz-agent 环境实测失效**

permission 的 `findCheapestModel`（`model-resolver.ts:154-167`）按 `model.cost.input` 升序排序取首个。但 xyz-agent 隔离环境的 `models.json` 里 7 个 model **全部未填 `cost` 字段**（`cost` 是 models-store 内置 catalog 才有的字段）。退化为 `DEFAULT_COST.input = 0` 后，排序失去意义，结果恒为 `Object.entries(providers)` **插入顺序**首项的首个 model（即 models.json 中 `providers` 对象第一个 key 的首个 model）——与「最便宜」语义完全无关。运行时断言：⛔ 实施期需用探针验证（见 §4 验收场景 4）。

**问题 7：import 动态 vs 静态是历史误读，可统一**

rename-session 注释（`llm.ts:48-51`）声称「compat 是 throwing stub 必须延迟 import」。但实测：
- pi 的 extension loader 把 `@earendil-works/pi-ai` 和 `@earendil-works/pi-ai/compat` **运行时都重映射到 compat 模块**（`loader.js:37-42 / 82-88`）
- permission 静态 import compat 的 `getApiProvider` 正常工作（加 `@ts-ignore` 是因为主入口 .d.ts 无此声明，compat 入口有）
- compat.js 顶层是真实 provider 注册（`registerBuiltInApiProviders()`），不是 throwing stub
- 真正 stub 的是 `ExtensionRuntime` 的 action methods（`loader.js:128-130`），与 compat 模块无关

结论：共享库可直接**静态 import `@earendil-works/pi-ai/compat`**（类型干净、运行时无 stub 风险）。`completeSimple` 和 `streamSimple` 入参完全相同（`model, context, options`），唯一差异是返回值（前者 `Promise<AssistantMessage>`，后者 `AssistantMessageEventStream`）。

### 2.4 配置碎片化现状（18 包侦查结论）

全项目共 17 个 `@zhushanwen/pi-*` extension 包 + `extensions/shared/` 下的 quota-providers / extension-logger 共享库（下文统计含 shared 容器目录，故本节标题写「18 包」）。pi extension SDK **不提供任何官方 config 机制**（`ExtensionContext` 无 config/sessionData 字段，`package.json` 的 `pi.*` 无 config schema 声明位）。导致配置读取**并存 7 种机制**：

| # | 机制 | 用了多少包 |
|---|------|:---:|
| 1 | 硬编码常量/默认值 | 18/18 |
| 2 | 自定义磁盘配置文件（路径格式各定） | 10/18 |
| 3 | `process.env` 直接读 | 8/18 |
| 4 | pi session `customEntry` | 7/18 |
| 5 | pi `toolResult` 复用 | 2/18 |
| 6 | `ctx.*` 运行时上下文 | 18/18 |
| 7 | 跨扩展 globalThis Symbol 握手 | 2 对 |

磁盘配置文件路径**4 种风格不一致**：

| 风格 | 包 | 示例 |
|------|----|------|
| 扁平 `<agentDir>/<name>.json` | rename/model-switch/permission/vision | `model-policy.json` |
| `config/` 子目录 | statusline(删) + shared/quota-providers | `config/providers.json` |
| `extensions/<pkg>/config.json` | context-engineering(删) | — |
| `<pkg>/<cwd-hash>/` | scheduler | `scheduler/users/foo/proj/scheduler.json` |

**5 个包硬编码 `os.homedir()/.pi`** 不读 `PI_CODING_AGENT_DIR`（实例隔离 `XYZ_AGENT_DATA_DIR` 隐患）：model-switch / vision / context-engineering(删) / scheduler / evolve-daily(删)。删 3 个废弃包后剩 **model-switch / vision / scheduler** 三个要修。

### 2.5 vision 不纳入收口（已确认）

`vision`（`extensions/vision/src/spawn.ts`）是 spawn 独立 pi 子进程（`pi --mode json -p --no-session --model X --tools Y`），LLM 调用 100% 发生在子进程内的 pi，vision 进程对 pi-ai 只有 `import type { Message }`（编译期擦除），**零运行时 LLM 调用**。vision 自身不解析 apiKey（子进程内 pi 解析）。与既有调研文档 `docs/extensions/research/permission/technical/01-pi-llm-invocation.md` line 12/167 判定一致。**不纳入 LLM 调用收口**。

### 2.6 废弃包删除影响面（已确认）

三个废弃包均可安全删除：
- 均不在 `mandatory-extensions.json` / `recommended-extensions.json`
- 无任何 package.json 将它们列为运行时 dependency
- 无任何外部 .ts 源码静态 import 它们
- 唯一软依赖：`permission` 把 `statusline` 列为 optional peerDep，但 permission 源码零静态 import（全用 globalThis 反射 + `Symbol.for(...)` 字面量，设计上 statusline 缺失即 noop）
- `evolve-daily` 的两个 python目录（`scripts/` + `analyzer/`）随包删，无 CI/脚本引用。**但 `docs/extensions/` 下有多处文档引用 evolve-daily**（见下方「docs 引用分类处理」），删包时需一并处理
- `quota-providers` **必须保留**（`model-switch` 静态 import 它的 `readCache` / `CacheData`）。其 config/secrets/paths **强耦合 quota 领域 schema**（ProvidersConfig 的 token-plans/search-tools + 硬编码 quota 文件名），**不适合作为通用配置基建基座**；通用 config 范式（泛型 load/save + mtime 缓存 + 原子写）应借鉴 `permission/config.ts` 在 llm-shared/config.ts 独立实现（见 §3.5）

**docs 引用分类处理**（删三个废弃包时必须同步清理的 docs 引用，避免悬空）：
- **保留 + 加 deprecation 标注**：`docs/extensions/adr/pi-ext-024-skill-tracker-active-declaration.md`、`docs/extensions/third-party-extensions/{README,autocontext-vs-evolve-architecture-comparison,evolve-ecosystem-comparison}.md`、`docs/extensions/research/permission/technical/01-pi-llm-invocation.md`——这些是历史决策记录/竞品/架构分析，引用 evolve-daily 是记录「曾经有过这个方案」，删了反而丢失决策上下文。加一行 deprecation 标注说明包已废弃。
- **更新或删除**：`docs/extensions/glossary.md:177`（「Evolve 自进化系统」术语条目）等**描述当前现状**的文档——指向已删包，会误导读者以为包还在。术语条目删除或标注「已废弃」。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 1：用户开启 rename，新会话首 turn 后标题由独立小模型生成**

```
用户配置（<agentDir>/config/rename-session.json）：
{
  "enabled": true,
  "model": { "type": "ref", "ref": "deepseek-router/deepseek-chat" },
  "maxTitleLength": 50
}

用户行为：在用 Claude Sonnet 做主对话，首 turn 完成。
现象：session 标题在 1-2 秒后自动更新为简短标题（如"重构 rename-session 的 LLM 调用"）。
成本：rename 调用的是 deepseek-chat（便宜），system prompt 是 rename 专属的 2 句话（不是整个 agent prompt）。
失败路径：若 deepseek-chat 的 provider 没配 auth，rename 静默跳过（保留默认标题），不报错、不阻断主对话。
```

**场景 2：permission 的 classifier 走共享库**

```
permission-config.json 的 classifier.model 仍是 "auto" 或 "provider/modelId"。
但底层解析从「自读 models.json」换成「ctx.modelRegistry.getAvailable() + getApiKeyAndHeaders」。
现象：用户通过 pi auth login 配的官方 provider，现在 classifier 也能用了（之前读不到）。
```

**场景 3：extension 开发者复用共享库**

```ts
// 任何需要在 extension 进程内调 LLM 的场景
import { callLLM, resolveModel } from "@zhushanwen/pi-llm-shared";

const model = resolveModel(ctx, { type: "ref", ref: "deepseek-router/deepseek-chat" });
if (!model) return;  // model 不可用，静默跳过
const result = await callLLM(ctx, {
  model,
  systemPrompt: "你是一个标题生成器。",  // 独立 prompt，不复用 ctx.getSystemPrompt()
  messages: [{ role: "user", content: [{ type: "text", text: "..." }] }],
  maxTokens: 64,
  // 不传 tools —— 默认不塞工具
});
```

### 3.2 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  extensions/shared/                                          │
│  ├── quota-providers/   (已存在，保留：config/secrets/cache) │
│  ├── extension-logger/  (已存在，保留)                       │
│  └── llm-shared/        (★ 新建：LLM 调用共享库)             │
│      ├── resolveModel(ctx, selector)  → Model | null         │
│      ├── callLLM(ctx, opts)           → Promise<Result>      │
│      └── ModelSelector（ref/fallback/available/scoped）      │
└─────────────────────────────────────────────────────────────┘
            ▲                          ▲
            │ 复用                     │ 复用
   ┌────────┴────────┐         ┌───────┴────────┐
   │ rename-session  │         │ permission     │
   │ - 独立 model    │         │ - classifier   │
   │ - 独立 prompt   │         │   改走共享库   │
   │ - 独立 config   │         │   (废弃自读)   │
   └─────────────────┘         └────────────────┘
            │
            │ 配置读写
            ▼
   <agentDir>/config/rename-session.json   (★ 统一配置位置)
```

**两个新建/改动产物的职责边界**：
- `llm-shared`（共享库）：纯能力封装——model 解析 + 凭证获取 + LLM 调用入口。无状态、无配置文件（配置由调用方传入）。
- 配置读写：rename 自己读写 `<agentDir>/config/rename-session.json`（路径走 `getAgentDir()`）。**不单独建配置包**（决策 D：避免过度设计；配置读写范式提取到 llm-shared 的一个 `config.ts` util，rename 和 permission 复用）。

### 3.3 方案对比与关键决策

#### 决策 A：rename/permission 的独立 model 怎么选（已确认：支持 scoped）

**背景**：用户 #6 要求共享库具备「从 scoped-model 选择」和「从所有配置的 model 选择」两种能力。用户已确认接受 scoped 通过自读 settings.json 实现（§2.3 问题 5）。**已确认方案 A1（支持 scoped）**。

| 方案 | 做法 | 长期合理性 | 短期成本 | 风险 |
|------|------|-----------|---------|------|
| **A1（已确认）** | `ModelSelector` 四形式：`{type:"ref",ref:"p/id"}`（精确）/ `{type:"fallback",refs:[...]}`（按序尝试）/ `{type:"available"}`（getAvailable 全量）/ `{type:"scoped"}`（自读 settings.json 的 enabledModels，glob 匹配，按用户排序取首个可用） | 高：覆盖精确/兜底/全量/scoped 四语义 | 中：selector 类型 + glob 匹配 + settings 解析 | 低（enabledModels 字段由 pi 维护，格式稳定） |
| A2 | 只支持 ref/available，不支持 scoped | 中：不满足用户 #6 的 scoped 需求 | 低 | 低 |
| A3 | 只支持 scoped，不支持 ref/fallback | 低：精确指定/多 provider 容错场景无法用 | 中 | 中 |

**确认 A1**。四种 selector 的语义与适用场景：
- `{type:"ref"}`：精确指定一个 model（如 rename 想固定用某便宜模型）。最可控。
- `{type:"fallback"}`：按序尝试多个 ref（多 provider 容错）。
- `{type:"available"}`：从 `getAvailable()`（配了 auth 的全量）取首个。范围最大，隐式。
- `{type:"scoped"}`：自读 settings.json 的 `enabledModels`，glob 匹配 `getAll()`，过滤 `hasConfiguredAuth`，**按 enabledModels 数组顺序**取首个可用。

**scoped 实现要点**：
- `readEnabledModels()`：自读 `<agentDir>/settings.json` 的 `enabledModels` 字段（`string[]`，"provider/modelId" 格式，可含 `*` glob，如 `"anthropic/*"`）。文件/字段缺失返回空数组 → scoped 返回 null。
- glob 匹配需轻量实现（minimatch 或自实现 `*` 通配）；enabledModels 的 pattern 对 `getAll()` 的 `provider + "/" + id` 做匹配。
- **凭证仍走 `modelRegistry.getApiKeyAndHeaders`**（settings.json 不存凭证，只存启用列表）。
- **rename 默认配 `{type:"scoped"}`**：用用户启用的首个 model，零配置即可工作（若 enabledModels 为空则静默跳过）。也支持精确 ref 覆盖。

**scoped vs available 的范围差异**：`getAvailable()` = 配 auth 的全量；scoped = enabledModels 启用子集，通常 `scoped ⊆ getAvailable`。**scoped 取首个是用户显式排序的首个（可控），available 取首个是三源合并序的首个（隐式）**——因此"自动选一个 model"的场景 scoped 语义更优。permission 的 `'auto'` 映射为 scoped（见决策 E）。

**scoped 不依赖 cost 字段**：scoped 按 enabledModels 数组顺序取首个配了 auth 的 model，**不按 cost 排序**（§2.3 问题 6 已证 cost 在 xyz-agent 环境普遍缺失），避开了 permission 旧 'auto' 的退化问题。

#### 决策 B：共享库 API 风格

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| **B1** | 无状态函数式：`resolveModel(ctx, selector)` / `callLLM(ctx, opts)` | ✅ |
| B2 | class-based：`new LLMClient(ctx, config)`，实例持有 ctx | ❌ |

**推荐 B1**。理由：extension 本身是函数式的（工厂函数 + 事件 handler），无状态函数更契合；易测试（纯函数 + 注入 ctx mock）；无生命周期管理负担。permission 的现有 `resolveModel`/`streamSimple` 调用也是函数式的，迁移自然。

#### 决策 C：permission 的 classifier 要不要一并收口

**背景**：permission 的 `resolveClassifierModel` 自读 models.json 是已知缺陷（§2.3 问题 4）。收口到共享库能修这个缺陷，但改动面较大。

| 方案 | 做法 | 长期合理性 | 短期成本 | 风险 |
|------|------|-----------|---------|------|
| **C1（推荐）** | permission 的 classifier 改走共享库（`resolveModel` + `getApiKeyAndHeaders`），废弃 `model-resolver.ts` 的自读逻辑 | 高：修复读不到内置 provider/OAuth 的缺陷，统一 auth 获取 | 中：改 classifier 的 model 解析 + 测试 | 中：需回归 permission 现有行为 |
| C2 | permission 不动，只让 rename 用共享库 | 低：permission 缺陷遗留，两套 auth 获取并存 | 低 | 低 |
| C3 | 共享库同时支持 modelRegistry 派和自读派，permission 按原模式迁 | 低：维护两套，违背统一初衷 | 高 | 中 |

**确认 C1**。理由：C1 才是「真正收口」，C2 留了半截。C1 改动面较大（permission 有完整测试套件，需回归），但用户已确认本次一起做。permission 收口的实施在 P3 阶段（见 §5.1），可独立验收；P3 仍可拆为独立 commit，不影响 P0-P2 + P4 的交付。

#### 决策 D：要不要单独建一个「配置包」

**背景**：用户 #3 说「配置提供一个 extensions/shared/ 下的配置包」。

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| **D1** | 不单独建配置包；配置读写范式（路径推导 + load/save + 归一化）作为 `llm-shared/config.ts` util，rename/permission 复用；其他包的硬编码路径各自独立修 | ✅ |
| D2 | 建独立的 `extensions/shared/config/` 通用配置包，所有 extension 迁移 | ❌ |
| D3 | 只做共享库，配置内联在各 extension | ❌ |

**推荐 D1**。理由：本次主线是 LLM 调用收口，配置是配套。单独建通用配置包（D2）是更大的工程，且 18 个包迁移超出本需求 scope（§1.4 已排除）。D1 把配置 util 放进 llm-shared（它本就是 LLM 相关的共享层），既复用又不扩张。未来若要建通用配置包，llm-shared/config.ts 可提取出去。

#### 决策 E：要不要提供「智能选模（auto）」

**背景**：permission 现有 `'auto'`（按 cost 选最便宜）在 xyz-agent 环境失效（§2.3 问题 6）。

| 方案 | 做法 | 推荐 |
|------|------|:---:|
| **E1** | 共享库不提供 auto；用显式 selector（ref / fallback / available） | ✅ |
| E2 | 提供 auto，换排序依据（如 contextWindow 或显式 priority） | ❌ |
| E3 | 提供 auto，强制要求填 cost | ❌ |

**推荐 E1**。理由：auto 在当前环境不可靠（cost 普遍缺失），提供它等于给用户埋坑。显式 selector 行为确定、可预期。permission 的 `classifier.model: "auto"` 配置在 C1 收口后，**映射为 `{type:"scoped"}`**——从用户 settings.json 的 enabledModels 取首个可用 model（用户显式排序，比 getAvailable 取首个更可控）。这同时修复了"读不到 OAuth provider"的缺陷（走 `modelRegistry.getApiKeyAndHeaders`）。⛔ **探针**（P3 实施时）：确认 enabledModels 非空时 scoped 能取到 model；enabledModels 为空时实现采用更宽的兜底（CL-scoped-fallback）。**（C4 裁决，已接受，批次 3）**：**enabledModels 为空 → 先试 available fallback（getAvailable 首个）→ 仍 null 才 fail-closed `ask`**——保证「有 apiKey provider 但没配 enabledModels」的用户不退化（旧 auto 行为）；降级语义是「available 兜底失败后才 fail-closed」，非「空即 fail-closed」。测试覆盖 `extensions/permission/src/__tests__/production.test.ts` TC7。

**「没配置模型就不能用 auto」= 天然门禁，无需额外代码**：scoped 在 enabledModels 为空 / 启用的 model 都没配 auth 时返回 `null` → permission 沿用现有 `CLASSIFY_FALLBACK_RESULT`（`classifier.ts:80`）降级为 `ask`。这与 permission 现有 fail-closed 设计一致，C1 收口不需要写新的门禁逻辑。

#### 决策 F：model 解析要不要复用 runtime 的逻辑（已确认：不复用，走 `ctx.modelRegistry`）

**背景**：xyz-agent runtime（`packages/runtime/src/`）有一套 model 解析逻辑（`pi-provider-store.ts` 读 models.json）。评估能否复用给 llm-shared，避免重复造轮子。

| 方案 | 做法 | 可行性 | 否决/采纳理由 |
|------|------|--------|---------|
| A | extension 直接 import runtime 逻辑 | ❌ 不可行 | runtime 是 `private: true` 的 `@xyz-agent/runtime`（package.json:3-4），无 exports/main/files，extension 在原生 pi CLI 里 **import 不到** |
| B | 提取 runtime 逻辑成 extensions/shared 公共包 | ⚠️ 技术可行但无价值 | 提取出的是**次优逻辑**：runtime 只读单一 models.json（无多源合并）、enabledModels 是死字段（零 glob 消费）、无 "provider/modelId" 解析函数、apiKey 单源 |
| C | extension 复制一份到 llm-shared | ❌ 不推荐 | 比 B 更差：复制次优逻辑 + 重复代码 + 与 pi 运行时脱节 |
| **D（确认）** | **extension 用 pi 的 `ctx.modelRegistry`** | ✅ 采纳 | 运行时权威，零重复，自动跟随 pi 升级，含 OAuth/env/auth.json 多源凭证合并 |

**确认 D**。依据（pi ExtensionContext 已暴露的能力，`types.d.ts:220-222` + `model-registry.d.ts:21-41`）：
- `ctx.modelRegistry.find(provider, modelId)`：精确查 model（pi 内部三源合并：built-in + models.json + extension 注册）
- `ctx.modelRegistry.getApiKeyAndHeaders(model)`：**async**，返回判别联合，含 OAuth/env/auth.json **多源凭证合并**（比 runtime 的 sync 单源读文件更强）
- `ctx.modelRegistry.getAvailable()`：已过滤的可用 model 列表
- `ctx.model`：当前会话 model

**关键事实（为什么 runtime 逻辑次优，不复用）**：
- **路径不同**：runtime 读 `~/.xyz-agent/pi/agent/models.json`（`XYZ_AGENT_DATA_DIR` 隔离目录）；extension 在原生 pi 读 `~/.pi/agent/models.json`（`PI_CODING_AGENT_DIR`）。复用 runtime 逻辑要先改路径语义。
- **凭证来源更弱**：runtime 的 `getApiKeyForProvider` 只读 `provider.apiKey`（`pi-provider-store.ts:246`）；pi 的 `getApiKeyAndHeaders` 合并 auth.json OAuth + env + stored（provider-composer 多源）——同一 provider 两边读到的 key 可能不同。
- **enabledModels 是死字段**：runtime 的 enabledModels 仅 get/set（`pi-provider-store.ts:307/311`），**零 glob 消费**；pi 原生用 minimatch 解析（model-resolver.ts）但**不通过 ctx 暴露**（ExtensionContext 无 scopedModels 字段，已核实 `types.d.ts:209-234`）——**这是 scoped 需 extension 自读 settings.json 的根因**（见决策 A）。

**llm-shared 的定位**（基于方案 D）：**不是「model 解析库」**（解析全委托 `ctx.modelRegistry`），是**「LLM 调用封装」**——拿到 model + 凭证后，封装 `completeSimple`（pi-ai/compat）的调用细节（独立 system prompt、不传 tools、错误归一化）。`ModelRegistry` **无 complete 方法**（已核实 `model-registry.d.ts:21-41`，仅 find/getApiKeyAndHeaders/getAvailable 等），故 llm-shared 必须自己封装 `completeSimple`，不能委托 modelRegistry 调用。

### 3.4 共享库接口设计（`@zhushanwen/pi-llm-shared`）

**包位置**：`extensions/shared/llm-shared/`

**核心类型**：

```ts
// ModelSelector —— 决策 A 的 selector 抽象
export type ModelSelector =
  | { type: "ref"; ref: string }              // "provider/modelId" 精确
  | { type: "fallback"; refs: string[] }      // 按序尝试，第一个可用的
  | { type: "available" }                     // getAvailable() 全量（取首个）
  | { type: "scoped" };                       // 自读 settings.json enabledModels，glob 匹配，取首个可用

// CallLLMOptions —— 决策 B 的函数式 API
export interface CallLLMOptions {
  model: Model;                               // 由 resolveModel 返回
  systemPrompt: string;                       // 独立 prompt（调用方负责，不复用 ctx.getSystemPrompt）
  messages: Message[];                        // pi-ai 的 Message[]
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  sessionId?: string;                         // 透传给 provider 的 SimpleStreamOptions，用于 session 缓存/路由
  // 注意：不传 tools —— 默认不塞工具（rename/permission 都不需要）
}

export type CallLLMResult =
  | { ok: true; content: string }             // 提取后的文本（已 trim）
  | { ok: false; error: string; recoverable: boolean; stopReason?: "error" | "aborted" };
```

**核心函数**：

```ts
// 解析 selector 为可用 Model（走 ctx.modelRegistry，三源合并）
// 返回 null 表示 model 不可用（调用方应静默跳过）
export function resolveModel(
  ctx: ExtensionContext,
  selector: ModelSelector,
): Model | null;

// 发起 LLM 调用（静态 import @earendil-works/pi-ai/compat，决策 E 的 import 修正）
// 内部用 completeSimple（一次性结果）。凭证走 ctx.modelRegistry.getApiKeyAndHeaders。
export function callLLM(
  ctx: ExtensionContext,
  opts: CallLLMOptions,
): Promise<CallLLMResult>;
```

**resolveModel 的解析逻辑**（走 modelRegistry，不自读文件）：

```ts
// 共用 parseRef：拆 "provider/modelId"，用 indexOf 取首个 "/"（modelId 可含 "/"，如 "a/b/c" → provider="a", modelId="b/c"）。
// 边界守卫：无 "/" / "/" 开头 / "/" 结尾（provider 或 modelId 为空）→ null，不传空串给 find。
function parseRef(ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) return null;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export function resolveModel(ctx, selector) {
  const reg = ctx.modelRegistry;
  if (selector.type === "ref") {
    const parsed = parseRef(selector.ref);
    if (!parsed) return null;
    const m = reg.find(parsed.provider, parsed.modelId);
    return m && reg.hasConfiguredAuth(m) ? m : null;
  }
  if (selector.type === "fallback") {
    for (const ref of selector.refs) {
      const parsed = parseRef(ref);
      if (!parsed) continue;
      const m = reg.find(parsed.provider, parsed.modelId);
      if (m && reg.hasConfiguredAuth(m)) return m;
    }
    return null;
  }
  if (selector.type === "scoped") {
    // 自读 <agentDir>/settings.json 的 enabledModels，glob 匹配 getAll()，按用户排序取首个可用
    const enabled = readEnabledModels();
    if (enabled.length === 0) return null;
    const all = reg.getAll();
    for (const pattern of enabled) {       // enabledModels 有序，按用户排序
      for (const m of all) {
        if (matchGlob(pattern, `${m.provider}/${m.id}`) && reg.hasConfiguredAuth(m)) {
          return m;
        }
      }
    }
    return null;
  }
  // available: 取 getAvailable() 首个（配了 auth 的）
  const avail = reg.getAvailable();
  return avail.length > 0 ? avail[0] : null;
}
```

**callLLM 的凭证处理**（走 modelRegistry，必须 narrow 判别联合）：

```ts
// 顶层静态 import（决策 E 已证可行：compat 非 throwing stub，pi loader 运行时重映射，见 §2.3 问题 7）
import { completeSimple } from "@earendil-works/pi-ai/compat";

export async function callLLM(ctx, opts) {
  // B5：getApiKeyAndHeaders 与 completeSimple 同处 try。getApiKeyAndHeaders 的 reject
  //（抛异常，非返回 {ok:false}）也归一入 catch，保证调用方日志前缀一致——避免 callLLM 直接
  // reject 时上游走外层 .catch 输出不一致前缀（如 [pi-rename-session] 而非 [rename-session]）。
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(opts.model);
    if (!auth.ok) {
      return { ok: false, error: auth.error, recoverable: true };
    }
    const resp = await completeSimple(opts.model, {
      systemPrompt: opts.systemPrompt,
      messages: opts.messages,
      tools: [],  // 显式空，不塞工具
    }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: opts.signal,
      maxTokens: opts.maxTokens,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const content = extractText(resp);  // 提取 text block
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: String(e), recoverable: true };
  }
}
```

**错误规格**（每个错误配恢复指引，准则 6/16）：

| 错误 | 原因 | 恢复指引 |
|------|------|---------|
| `resolveModel` 返回 `null` | selector 指定的 model 不存在/未配 auth/scoped 时 enabledModels 为空 | 检查 `<agentDir>/models.json` 或跑 `pi auth login`；scoped 时检查 `<agentDir>/settings.json` 的 `enabledModels` 是否非空 |
| `callLLM` 返回 `{ok:false, recoverable:true}` | 网络/超时/auth 失败 | rename 静默跳过；permission 降级为 `ask`（fail-closed） |
| `callLLM` 返回 `{ok:false, recoverable:false}` | model 配置错误（如 api 类型不支持） | ~~修正 models.json 的 model 定义~~（**C2b 回写**：当前实现无此分支，catch/stopReason 路径统一 `recoverable:true`，细分待未来有消费者后再实现；`stopReason?: "error" \| "aborted"` 作为独立透传字段已就位，细分时可映射） |

> **C2b 回写（批次 3，实现现状）**：错误规格两级 recoverable 为设计目标，但**当前实现 catch 与 stopReason 归一化路径统一返回 `recoverable:true`，`false` 分支尚未实现**。唯一消费者 rename 不区分该值，细分属 YAGNI（与 followups C2 裁决一致）；`stopReason?: "error" | "aborted"` 透传字段已就位，未来出现需区分恢复性的消费者（如「model 配置错误立即失败不重试」）时可直接映射。

**调用语义契约（fire-and-forget，审查 suggestion）**：rename-session 现状 `index.ts` 的 turn_end handler 是**真正的 fire-and-forget**——`void callRenameLLM(...).then(...).catch(...)`，handler 立即 resolve，LLM 调用与 setSessionName 在后台异步完成（不阻塞 agent 进入下一次迭代）。**改造后必须保留此契约**：turn_end handler 内调 `callLLM` 必须用 `void callLLM(...).then(...).catch(...)` 包裹，**禁止 `await callLLM`**（await 会阻塞 turn_end handler，与现有行为不符，可能导致 agent 循环卡顿）。permission 的 classifier 不受此约束（classifier 在请求处理链内同步等待结果是正确行为）。

### 3.5 配置读写范式（llm-shared/config.ts，决策 D）

**统一路径**：所有 LLM 相关配置走 `<agentDir>/config/<pkg>.json`（沿用 quota-providers 已建立的 `config/` 子目录范式，通过 `getAgentDir()` 派生）。

```ts
// llm-shared/config.ts
// ⚠️ 用 pi 导出的 getAgentDir（dist/index.d.ts:2），禁止自实现
// permission 原 config.ts + classifier/model-resolver.ts 各自重复自实现了一份 PI_CODING_AGENT_DIR 解析（P3 收口已统一为复用 pi 导出）
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export function getConfigPath(pkgName: string): string {
  return join(getAgentDir(), "config", `${pkgName}.json`);
}

// loadConfig：读 + 归一化（容错）。文件不存在/坏 JSON/normalize throw 返回 defaults（调 onWarning）
export function loadConfig<T>(
  pkgName: string,
  defaults: T,
  normalize: (raw: unknown) => T,
  onWarning?: (msg: string) => void,
): T;

// saveConfig：原子写（tmp + rename，参考 permission 的范式）
// 返回 { success, error? }：rename 失败（如 Windows EPERM 目标占用）不抛错，由调用方处理
export function saveConfig(
  pkgName: string,
  config: unknown,
  onWarning?: (msg: string) => void,
): { success: boolean; error?: string };
```

**rename-session 配置 schema**（`<agentDir>/config/rename-session.json`）：

```ts
interface RenameSessionConfig {
  enabled: boolean;                          // 默认 false（沿用现有开关语义）
  model: ModelSelector;                      // 默认 { type: "scoped" }（用 enabledModels 首个，零配置）
  maxTitleLength: number;                    // 默认 50
  // renameInstruction 内置在代码里（i18n 考虑留未来），不进配置
}
```

**配置读写采用 mtime+size 双 key 缓存**（参考 permission 的 `config.ts`，避免每次 turn_end 都读盘；mtime + size 双 key 防 APFS 等文件系统 mtime 精度截断导致快速连续保存后缓存失效）。

### 3.6 硬编码路径修正范围

删 3 个废弃包后，剩 3 个硬编码 `homedir()` 的包需修正为 `getAgentDir()`：

| 包 | 现状 | 修正 |
|----|------|------|
| `model-switch` | `config.ts:15` `join(homedir(), ".pi", "agent", "model-policy.json")` | 改走 `getAgentDir()` |
| `vision` | `vision-model.ts:46` 硬编码 `os.homedir()/.pi/agent` 读 `vision-models.json` | 改走 `getAgentDir()`（**仅路径收口，schema 不动**——候选列表语义与 LLM 线开关不同） |
| `scheduler` | 已重构：`store.ts` 拆分为 backend/runtime/service 等，P4 目标（数据目录走 `getAgentDir`）在 `importer.ts:33` 实现（`scheduler/<root>/...` 从 `getAgentDir` 派生）；`importer.ts:34` 的 homedir legacyPath 是旧版（npm 0.1.1）数据迁移 fallback，有意保留 | 无需改动（P4 已在 `importer.ts` 落地） |
| quota-providers 的 kimi/zhipu/opencode | 读 `~/.pi/agent/secrets/*.txt`（API key fallback）硬编码 homedir | 改走 `getAgentDir()` 派生（与决策 D 的 quota-providers 保留独立一致，仅修路径） |

**注意**：这些都是独立改动（不依赖 llm-shared），可作为本设计的附带任务，也可拆成独立 follow-up。**建议本次一并做**（趁删包重整配置体系，一次性收敛）。**⚠️ 这些硬编码在 xyz-agent 环境下会读错目录**（读 `~/.pi/agent/` 而非隔离的 `~/.xyz-agent/pi/agent/`），是实例隔离的实际 bug，不只是整洁性问题——subagent 调研发现 6 个 extension 受影响（含 3 个 quota provider 的 secrets 文件）。

---

### 3.7 跨进程能力共享边界（为什么不抽「三合一公共包」）

**背景**：评估过「把 LLM 调用 / model 解析 / 配置读写抽成 extension 和 xyz-agent GUI 都能用的公共包」的方案。结论：**不抽三合一包**。三种能力的共享性差别极大，逐项判断如下。

| 能力 | 能抽公共包吗 | 根因 |
|------|:---:|------|
| LLM 调用 | ❌ 不需要 | runtime + renderer 都不调 LLM（grep 零命中，runtime 无 pi-ai import），LLM 调用 100% 在 pi 子进程内。空集合，没东西可共享 |
| model 解析 | ⚠️ 假共享 | extension 用 `ctx.modelRegistry`（运行时权威，含 OAuth/env 多源），runtime 用 `readFileSync`（配置快照，给 UI 展示/CRUD）。抽象层次不同，强行统一 = leaky abstraction |
| 配置读写 | ✅ 部分真共享 | 纯文件 IO 机制（JsonStore/atomicWrite）+ models.json schema 类型是真重复；路径/schema 语义各绑各的 |

**model 解析为什么是假共享**：这不是「同一件事的两种实现」，而是**不同层次的能力**——
- extension（pi 子进程内）：问 `ctx.modelRegistry`「现在有什么可用 model」，动态、含运行时凭证合并，用于**调 LLM**
- runtime（独立进程）：读配置文件快照「定义了什么 model」，静态，用于 **Settings UI 展示 + CRUD + 转发 pi RPC**（`model.list` / `model.switch` / `model.discover`），**零运行时 model 决策**（不路由、不切换、不监控——真正切模型是 pi 干的）

**真正能共享的两块（各自独立，不混在一起）**：

1. **文件 IO 基础设施**（`JsonStore` + `atomicWrite` + `WriteBackCache`）：runtime 已有成熟实现（`packages/runtime/src/utils/json-store.ts` + `fs-utils.ts`，纯 Node，与 LLM/model 无耦合）。extension 侧（permission/config.ts 的 mtime+原子写）是重复实现。
   - **长期方案**：抽成独立公共包（`extensions/shared/json-store`），两边都 import，路径/schema 作参数。
   - **本次短期方案**：llm-shared/config.ts 先借鉴 permission 范式独立实现（决策 D），未来再提取。不在本次 over-engineer。
2. **models.json schema 类型**（`PiProviderConfig` / `PiModelConfig`）：runtime 的 `pi-provider-store.ts:39-77` 和 permission 的 model-resolver 各定义了一份。**长期方案**：类型定义提取到共享层。本次不做（permission 收口后走 ctx.modelRegistry，不再需要自己定义这些类型）。

**明确不做的**：
- ❌ 不抽「LLM 调用」公共包——runtime/renderer 不调 LLM，只有 extension 需要（llm-shared 只服务 extension）
- ❌ 不抽「model 解析」公共包——范式不同（extension 用 ctx.modelRegistry / runtime 读文件），决策 F 已确认 extension 走 ctx.modelRegistry

**决策记录**：此结论基于 subagent 调研（runtime 零 LLM 调用、model 解析纯配置展示、配置 IO 是唯一真重复）。**未来若有人重提「三合一包」，参考本节，不要重复论证。**

## 4. 验收

> 每个场景标注验证 §1 的哪条目标。用真实环境（xyz-agent dev 或本地 pi CLI），非 mock。

### 场景 1：rename 用独立小模型生成标题（验证目标 1、2）

**前置**：`<agentDir>/config/rename-session.json` 配 `{ "enabled": true, "model": { "type": "ref", "ref": "<某便宜模型>" } }`。主 session 用一个贵模型（如 Claude Sonnet）。

**步骤**：
1. 新建 session，发一条消息让 assistant 回复
2. 等 turn_end 触发 rename

**通过标准**：
- session 标题在 1-3 秒更新为简短标题（跟对话内容相关，非默认日期/序号）
- 抓包/日志确认 rename 的 LLM 调用用的是配置的便宜模型，**不是**主 session 的 Sonnet
- 日志确认 system prompt 是 rename 专属精简版（几十 token），**不是**整个 agent prompt（可用 `XYZ_AGENT_DEBUG=1` 看 extension 日志，或在 callLLM 加 debug 日志打印 systemPrompt.length）
- ⛔ **探针**：`grep -c` systemPrompt 字符数 < 200（精简 prompt），对比改造前应 > 2000

### 场景 2：rename model 不可用时静默跳过（验证目标 1 的失败路径）

**前置**：配置 `"model": { "type": "ref", "ref": "nonexistent/model" }`。

**步骤**：新 session 发消息，turn_end 触发 rename。

**通过标准**：
- rename 静默跳过，session 标题保留默认值
- **不抛错、不阻断**主对话（主 session 正常继续）
- 日志记录 `[rename-session] model not available, skipping`（或类似）

### 场景 3：permission classifier 走共享库后能用到 OAuth provider（验证目标 2、3，依赖决策 C=C1）

**前置**：用户只通过 `pi auth login` 配了官方 provider（没手写 models.json 的 provider）。`permission-config.json` 的 `classifier.model` 仅支持 string 形式（`"auto"` 或 OAuth provider 的 `"provider/model-id"` ref）；传对象会被 normalize 忽略并 `console.warn('[pi-permission] Ignoring invalid classifier.model ...')` 回落 `auto`（与实现 `config.ts:72-79` 一致：warn 在 `:75`、normalizeClassifierConfig 在 `:69`、回落在 `:79`，**C3b 回写**）。

**步骤**：触发一次需要 classifier 的命令（如执行一个中等风险 bash 命令）。

**通过标准**：
- classifier 正常工作（返回 low/high risk 分类）
- ⛔ **探针**：改造前此场景 `resolveClassifierModel` 返回 null（读不到 OAuth provider），fail-closed 降级为 ask；改造后应返回有效 model 并完成分类

### 场景 4：scoped 不依赖 cost 字段（验证 §2.3 问题 6 已规避）

**前置**：xyz-agent 环境 models.json 的 model 全部无 cost 字段；settings.json 的 enabledModels 至少含一个配了 auth 的 model。

**步骤**：用 `{ "type": "scoped" }` selector 调 resolveModel。

**通过标准**：
- 返回 enabledModels 顺序首个配了 auth 的 model（非 null）
- ⛔ **探针**：日志确认不读 cost 字段、不排序，行为确定（按 enabledModels 顺序取首个），不像 permission 旧 auto 那样语义失真

### 场景 5：配置路径走 getAgentDir，实例隔离生效（验证目标 5）

**前置**：设 `PI_CODING_AGENT_DIR=/tmp/test-agent-dir`，启动 pi。

**步骤**：rename 写配置、model-switch 读 model-policy.json。

**通过标准**：
- 配置文件落在 `/tmp/test-agent-dir/config/rename-session.json`、`/tmp/test-agent-dir/model-policy.json`
- **不**落在 `~/.pi/agent/`
- ⛔ **探针**：`ls /tmp/test-agent-dir/config/` 确认文件在隔离目录

### 场景 6：删除三个废弃包后无 broken reference（验证目标 6）

**步骤**：`git rm -r extensions/context-engineering extensions/statusline extensions/evolve-daily`，同步清理 permission 的 peerDep + AGENTS.md 表格，跑 `pnpm install` + `pnpm extensions:typecheck` + `pnpm extensions:test`。

**通过标准**：
- pnpm install 无 fatal 错误（permission 的 optional peerDep statusline 缺失只是 warning，非 fatal）
- typecheck 全过
- 全部 extension 测试通过（permission 的 footer 集成测试应仍 pass——反射设计容忍 statusline 缺失）
- ⛔ **探针**：`grep -rn "pi-context-engineering\|pi-statusline\|pi-evolve-daily" extensions/ packages/ apps/ --include="*.ts"` 零命中（排除 permission 的反射字符串字面量，那是设计内的）
- ⛔ **探针（附带发现）**：statusline 当前是 `statusline_cache.json`（配额/速度数据）的**唯一写入者**，model-switch 的 `advisor.ts` 只读它做 peak 推荐。删 statusline 后无人写 cache → model-switch 读空/旧值。需确认 model-switch 的 `readCache` 返回空时推荐策略能降级（不报错、回退到非配额感知推荐），否则要把 cache 写入能力从 statusline 迁出

---

## 5. 下一层拆分

### 5.1 实施阶段（建议顺序，每阶段可独立验收）

| 阶段 | 内容 | 验收场景 | 依赖 |
|------|------|---------|------|
| **P0** | 删除 3 个废弃包 + 清理引用（permission peerDep / AGENTS.md / extension-dependencies.json） | 场景 6 | 无 |
| **P1** | 新建 `extensions/shared/llm-shared/`，实现 `resolveModel`（含 scoped 的 readEnabledModels + glob 匹配）/ `callLLM` / `config.ts` + 单测 | —（单测验证） | 无 |
| **P2** | 收口 rename-session：用 llm-shared，独立 model/prompt/config，删除搭便车逻辑 | 场景 1、2、5 | P1 |
| **P3**（若决策 C=C1） | 收口 permission classifier：改走 llm-shared，废弃 model-resolver 自读 | 场景 3、4 | P1 |
| **P4** | 修正 model-switch/vision/scheduler 硬编码路径 | 场景 5 | 无（可与 P2 并行） |

**P3 可独立拆出**：若用户选决策 C=C2（permission 分步走），P3 留作 follow-up，不影响 P0-P2 + P4。

### 5.2 文件改动地图

**新建**：
- `extensions/shared/llm-shared/`（新包：`package.json` / `index.ts` / `src/{index.ts, resolve.ts, call.ts, config.ts}` / `src/__tests__/`）
- `<agentDir>/config/rename-session.json`（运行时生成，不进 git）

**删除**：
- `extensions/context-engineering/`（整个目录）
- `extensions/statusline/`（整个目录）
- `extensions/evolve-daily/`（整个目录，含 python scripts/analyzer）

**修改**：
- `extensions/rename-session/src/{index.ts, llm.ts, pure.ts, commands.ts}`（收口到 llm-shared）
- `extensions/permission/src/classifier/{model-resolver.ts, classifier.ts}` + `production.ts`（若 C1）
  - 注：`model-resolver.ts` 已从 `resolveClassifierModel`（自读 models.json）**整体重写**为 `listAvailableModels`（走 `ctx.modelRegistry.getAll` + `hasConfiguredAuth` 过滤，给 picker 用），`loadModelsJson`/`flattenModels` 已删除
  - `extensions/permission/src/model-picker.ts`（W7 独立功能：`/permission model` 交互式选模型 overlay UI），**非本设计 classifier 收口范围**
- `extensions/permission/package.json`（移除 statusline peerDep）
- `extensions/model-switch/src/config.ts`、`extensions/vision/src/vision-model.ts`（路径改 getAgentDir）；`extensions/scheduler/src/importer.ts`（已重构：`store.ts` 拆分为 backend/runtime/service 等，`importer.ts:33` 已走 `getAgentDir`，`:34` homedir legacyPath 为旧版迁移 fallback 有意保留）
- `AGENTS.md`（Pi Extension 全集表格移除 3 行，17 → 14）
- `extension-dependencies.json`（移除 3 个废弃包条目）
- `docs/extensions/` 下引用废弃包的文档（分类处理，见 §2.6「docs 引用分类处理」）：
  - 保留 + 加 deprecation 标注：ADR（`adr/pi-ext-024-*`）、竞品/架构对比分析（`third-party-extensions/*`、`research/*`）——历史决策记录，不删
  - 更新或删除：`glossary.md` 的 evolve/statusline/context-engineering 术语条目、`01-pi-llm-invocation.md:217` 等描述现状的调研文档——指向已删包，会误导

### 5.3 待验证检查点（实施期需探针确认）

1. ⛔ **completeSimple 静态 import 可行性**：决策 E 推理认为可静态 import compat，但需在真实 pi extension 加载环境验证（P1 实施时第一个探针：静态 import 不 throw）。若实测仍需动态，回退到 rename 现有的动态 import 模式。
2. ⛔ **getAvailable() 在 xyz-agent 环境的返回**：需确认 OAuth provider 是否出现在 `getAvailable()`（影响场景 3）。P1 实施时用 `console.log(ctx.modelRegistry.getAvailable().map(m => m.provider + "/" + m.id))` 探针。
3. ⛔ **permission 收口的行为回归**（若 C1）：permission 有完整测试套件，C1 改动后必须全量回归 `extensions/permission/src/__tests__/`，确认 classifier 行为不退化。
4. ⛔ **config.ts 原子写在 Windows 的行为**：`tmp + rename` 在 Windows 上若目标文件被占用会失败，需测试或加 fallback（permission 现有实现是否已处理，P1 时核对）。
5. ⛔ **callLLM 参数字段名对齐**：§3.4 伪代码第二参数传 `{systemPrompt, messages, tools}`、第三参数传 `{apiKey, headers, env, signal, maxTokens, timeoutMs}`。compat.d.ts 确认 `completeSimple(model, context, options)` 三段式，但 `Context` 是否接受 `tools` 字段、`SimpleStreamOptions` 是否接受 `timeoutMs` 字段未在 compat.d.ts 展开。P1 实施首个类型对齐探针：核对 pi-ai 的 `Context` / `SimpleStreamOptions` 定义，字段名不符会静默忽略或报错。
6. ⛔ **settings.json enabledModels 解析**：scoped 依赖自读 `<agentDir>/settings.json` 的 `enabledModels` 字段。P1 实施时探针：① 确认 settings.json 不存在/字段缺失时 readEnabledModels 返回空数组（scoped 降级为 null，不抛错）；② 确认 enabledModels 的 glob pattern（如 `"anthropic/*"`）能正确匹配 `getAll()` 的 model；③ 确认 enabledModels 为有序数组（取首个 = 用户排序首位），核对 pi settingsManager 的 enabledModels 写入是否保持顺序。

---

## 附录 A：调研事实出处索引

> **本附录为设计启动时（P0-P4 收口前）的调研快照，行号指向收口前代码，收口后均已失效（见 §2 顶部快照声明）。** 保留作设计决策的背景追溯。

本文档的现状分析基于以下调研（均为只读，未改代码）：

- **rename-session 源码**：`extensions/rename-session/src/{index.ts, llm.ts, pure.ts, commands.ts}`
- **permission model 解析链路**：`extensions/permission/src/classifier/model-resolver.ts:132-167,242-298` / `extensions/permission/src/classifier/classifier.ts:181-193` / `extensions/permission/src/production.ts:38-51`
- **pi ExtensionContext 类型**：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:218-250`
- **ModelRegistry 类型**：`node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts`
- **pi-ai compat 签名**：`node_modules/@earendil-works/pi-ai/dist/compat.d.ts:44-66`
- **pi 配置三文件分工**：`~/.pi/agent/{models.json, models-store.json, auth.json, settings.json}` + `node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.d.ts` + `config.js:411-416`（getAgentDir）
- **loader 重映射**：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:37-42, 82-88, 128-130`
- **废弃包删除影响面**：全仓 grep + `packages/shared/src/mandatory-extensions.json` + `recommended-extensions.json`
- **vision spawn 确认**：`extensions/vision/src/spawn.ts:8,120-131,222` + `docs/extensions/research/permission/technical/01-pi-llm-invocation.md:12,167`

## 附录 B：Out of scope 的明确排除项

- **scoped-model 选择**：因 ExtensionContext 不暴露 settings API（§2.3 问题 5），本设计不实现 scoped。若未来需要，推动 pi 上游加 `ctx.getEnabledModels()`。
- **通用配置基础设施**：不建覆盖全部 18 extension 的配置包（决策 D）。本次只做 LLM 线。
- **vision 收口**：spawn 子进程，不属于 extension 进程内直接调 LLM（§2.5）。
- **间接注入 message 的 8 个包**（goal/todo/plan/scheduler/structured-output/ask-user/evolve-daily/statusline）：不直接调 LLM，配置收口不在本次主线。
- **permission 规则引擎/pipeline 重构**：只收口 model 解析 + LLM 调用入口，不动规则。
