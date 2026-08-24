# Pi Extension 开发约定

> 本文档整合自 xyz-pi-extensions 项目的 CLAUDE.md，收录 pi extension 开发的**强约束和关键约定**。
> 完整开发指南（规范红线 + 进阶模式范例）见 [development-guide.md](./development-guide.md)。
> 日志现行口径（三层通道）见 [logging-conventions.md](./logging-conventions.md)——development-guide §10 的旧 console 口径已由其收敛。
> TUI 渲染细节见 [pi-tui-development-guide.md](./pi-tui-development-guide.md)。

本文档只收录「违反必出 bug」或「[MANDATORY]」级别的约束。通用工程规范（TS 禁 any 等）不在此重复，见项目根 [AGENTS.md](../../AGENTS.md)。本文档所载约束登记于 [docs/constraints.json](../constraints.json)（架构约束登记 SSOT）。

---

## 目录分组与 role 字段 [MANDATORY]

`extensions/` 下的包按**职责**分两组，目录位置、package.json 元数据、builtin 清单三者必须一致（`scripts/check-extension-dependencies.mjs` 校验，preflight/CI 拦截）：

| 分组 | 目录 | role 字段值 | 语义 | 与 mandatory 清单关系 |
|------|------|------------|------|---------------------|
| xyz 集成 | `extensions/taiji/` | `"taiji"` | 契约两端在 xyz-agent 体系内，离开 xyz-agent 无功能（如 msg-id 映射、system prompt 注入） | **必须在** `mandatory-extensions.json`（随应用打包） |
| 独立通用 | `extensions/universal/` | `"universal"` | 功能自足，独立 pi 用户可单独安装（如 goal、todo、structured-output） | 可在（builtin 打包的通用工具）可不在（npm 独立发布） |

约束：

1. 每个包的 `package.json` 必须声明 `"xyz-agent": { "role": "taiji" | "universal" }`，且与所在分组目录一致；
2. `extensions/` 一层禁止放 extension 包（`shared/` 共享库与 `tsconfig.json` 除外）；
3. 判断标准是「离开 xyz-agent 是否仍有功能」，不是「是否随应用打包」——goal/todo 等通用工具虽在 mandatory 清单随应用打包，但归 `universal/`；
4. 新建/移动包时同步更新：分组目录 + role 字段 + `extension-dependencies.json`（含 directory 路径）+ 根 AGENTS.md 分组列举；
5. **新增分组**（新开 `extensions/<group>/` 目录）时需同步登记分组名的代码点：`pnpm-workspace.yaml` glob、`scripts/check-extension-dependencies.mjs` 的 `GROUPS`、`scripts/bundle-extensions.mjs` 的 `srcDirFor`、`.agents/skills/dev-link/dev-link-lib.sh`（skill 自包含，无法共享常量）。其余消费点已 group 无关（runtime `extension-resolver.ts` 扫一层目录、pre-commit 2c/2d 模式不列组名），漏改时结构守卫会拦截 role 不一致。

## 运行环境

- 扩展在 Pi 进程内执行，**不是独立进程**
- 同一进程可能有多个 session。模块级 `let` 变量会被所有 session 共享，必须用闭包或 `session_start` 重建
- 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。已知例外：
  - `@zhushanwen/pi-subagent-workflow` 走单执行链——SubprocessAgentRunner 委托 SubagentService.executeAndAwait（`executeAndAwait` → `runSpawn` → `spawn("pi", ["--mode","json"])` 子进程，进程隔离），`session-runner.runSpawn` 是**唯一**的 Pi 子进程 spawn 点（ADR-030 决策 2）
  - `execFileSync("git", ...)` 等只读子进程调用可使用 child_process
- 旧包 `pi-workflow`/`pi-subagents` 的双 spawn 路径已废弃（见 [pi-ext-030](./adr/pi-ext-030-subagents-workflow-merge.md)）；旧包 `pi-subagents` 曾用的进程内 `createAgentSession()` 路径已回退为 spawn（进程隔离优先，见 pi-ext-030 决策记录）

## 资源自包含

扩展的文件分为两类，路径策略不同：

**资源文件**（扩展自带、随 npm 分发的脚本/配置）：
- 必须放在扩展自己的目录内（如 `scripts/`、`data/`），禁止引用扩展目录外的绝对路径
- 代码中通过 `import.meta.dirname`（ESM）或 `__dirname`（CJS）定位扩展内资源
- `package.json` 的 `files` 字段必须包含所有资源文件（`.py`、`.sh`、`.json` 等），确保 `npm pack` 后完整可用

**运行时数据文件**（扩展运行时产出的报告/缓存等）：
- 使用 Pi 平台约定路径 `homedir() + '.pi/agent/<用途>/'`
- 不纳入 npm 包，不随扩展分发

目标：用户 `pi install <extension>` 后直接可用，无需额外下载或配置外部资源。

## Session 隔离（进程内层面）

- 状态必须存储在 `session_start` 重建的闭包变量或 `ctx.sessionManager` entries 中
- `todo` 扩展的 `let todos` 是已知的违反——当前单 session 使用不会有问题，但多 session 时需要重构为闭包内状态

> 注意：这是 **extension 进程内**的 session 隔离，与 xyz-agent 前端的 per-session Map 分区（AGENTS.md §7）是不同层面。前者防 extension 模块级变量被多 session 共享，后者防 Vue 组件状态串台。

## 状态持久化

- 用 `pi.appendEntry(type, data)` 写入，`ctx.sessionManager.getEntries()` 读取
- 自行实现 GC（splice 旧 entries），防止长 session 中 entries 无限积累
- `deserializeState` 必须向后兼容旧格式（字段缺失时给默认值）

## Tool 设计

### `parameters` 顶层必须是 `Type.Object`（OpenAI 兼容性）[MANDATORY]

`pi.registerTool({ parameters, ... })` 的 `parameters` 序列化后顶层必须含 `type:"object"`。OpenAI function calling 规范要求 parameters 顶层是 object，**禁止**顶层 `Type.Union`/`Type.Intersect`/`Type.Composite`（序列化为 `anyOf`/`allOf`，无 type）、`Type.Array`（序列化为 `type:"array"`）。违反会导致严格 OpenAI 兼容网关 400 拒绝整个会话启动。

参数用 typebox `Type.Object()` + `StringEnum()` 定义 schema。

**多 action tool 标准范式**（参考 `extensions/universal/scheduler/src/tool.ts` 的 `ScheduleControlParams`）：

1. **运行时 schema**：扁平 `Type.Object`，`action` 字段用 `Type.Union([Type.Literal(...)])`（字段级，等价 enum，序列化为嵌套 anyOf 合规），各分支字段全部 `Type.Optional`；
2. **类型层**：用 `Static<typeof Schema>` 派生扁平类型（单一来源，禁止手工另写 discriminated union——会导致类型与 schema 两处同步漂移，且双形陷阱检测需跨分支访问字段，严格 union 下编译报错）；
3. **运行时校验**：handler 按 `action` 分枝校验必填字段存在 + 非空串（错误消息内嵌正确调用示例）；
4. `additionalProperties: false` 保留。

分支语义隔离从 schema 层降级为运行时 handler 校验——这是兼容 OpenAI 规范的必要代价。pre-commit 脚本 `.githooks/check_tool_schema.py` 强制拦截顶层非 Object schema（`SKIP_TOOL_SCHEMA_CHECK=1` 可跳过，仅限紧急）。设计背景见 [tool-schema-openai-compat.md](./tool-schema-openai-compat.md)。

- `execute` 返回 `{ content: [...], details: {...} }` 结构
- `details` 是 renderResult 的数据来源，不要依赖 content 文本解析
- 错误处理分两层：内部实现函数可以 `throw`；`execute` 是 API 边界，**必须 catch 并返回 `{ isError: true }` + 错误消息**。错误消息用 `err.message`（不含堆栈），禁止把 `err.stack` 拼进 content（堆栈外泄到 LLM 上下文/持久化记录）。同时禁止 `{ content: [{ text: "错误: ..." }] }` 不带 `isError` 的**错误成功模式**（调用方无法区分成功与失败）

## TUI 渲染

- `renderCall` 和 `renderResult` 返回 `new Text(string, 0, 0)`
- 颜色通过 `theme.fg("token", text)` 使用语义 token，不硬编码 ANSI
- 展开/折叠：`options.expanded` 控制显示详细程度
- **导航键规范**：自定义 TUI 组件的列表导航用方向键，经 pi-tui 的 `matchesKey(data,"up"|"down")` 识别——它覆盖全部方向键编码（legacy `\x1b[A`/`\x1b[B`、application-mode `\x1bOA`/`\x1bOB`、Kitty CSI u、modifyOtherKeys）。不要硬编码单一字节序列（会漏掉 application-mode/Kitty 终端，方向键直接失效）。禁止用 vim j/k 导航（与同组件内的 filter 文本输入冲突）。确认/取消多键位（Enter/Esc）走 `kb.matches` 以尊重用户键位，不受此限。

## 运行时环境区分（TUI 主进程 vs GUI 主进程 / xyz-agent）

扩展需要在 TUI / GUI 两种主进程下走不同分支时（如 widget 内容源、sidecar 通道选择），用 `ctx.mode === "rpc"` 判断，**不要**用 `ctx.hasUI`。

| 字段 | TUI 主进程 | GUI 主进程（xyz-agent）| subagent 子进程 |
|---|---|---|---|
| `ctx.mode` | `"tui"` | `"rpc"` | `"rpc"`（spawn 时 `--mode rpc`）|
| `ctx.hasUI` | `true` | `true` | `true` |

- `ctx` 来自 `session_start` 回调参数，永远是**当前进程**的 ctx。streamSink / widget 注入点的 ctx 是**主进程**的，跟子进程无关。
- spawn 子进程时传的 `--mode rpc` 决定子进程 stdout 格式，与主进程的 ctx.mode 独立。
- `hasUI` 在 TUI 和 RPC 都 true，不能区分。

**应用示例**（subagent-workflow W1 修复）：TUI 下禁用 streamSink 避免 raw LLM text 灌 widget；GUI 下启用（ctx.ui.setWidget → sidecar → chatStore）。

```typescript
streamSink: ctx.mode === "rpc"
  ? { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) }
  : undefined,
```

`ExtensionMode` 字面量（4 个值：`"tui" | "rpc" | "json" | "print"`）。完整章节 + 进程边界见 [pi-tui-development-guide.md](./pi-tui-development-guide.md) 第四部分第 8 节。

> xyz-agent 跨层排查（[docs/troubleshooting.md](../troubleshooting.md) 历史排查规则）常涉及 pi extension 行为——extension 的 `ctx.mode`、pi 私有协议（triggerTurn/deliverAs 等）是排查「主 agent 是否续跑」等跨层问题的前提知识。

## SDK 接口契约

凡调用 `pi.on(...)`、`pi.registerTool(...)`、`pi.registerCommand(...)`、读 `ctx.*` 的代码：

- **ExtensionHandler 签名是 `(event, ctx) => ...`（两个参数）**。`modelRegistry`/`cwd`/`ui`/`sessionManager` 在第二个参数 `ExtensionContext` 上，不在 event 上。核对时打开真实 SDK 的 `types.d.ts`
- 新增/修改 SDK 调用必须有契约测试覆盖（模板：`extensions/universal/subagent-workflow/src/execution/__tests__/sdk-contract.test.ts`）
- `registerTool` 的 schema 必填字段在所有执行模式下都必须真的必填；条件必填用 Optional + 运行时校验，避免 schema 与描述矛盾

> 本项目已将 `@earendil-works/pi-coding-agent@0.84.1` 作为根 devDependency 安装（真实 SDK 类型），不再使用类型桩。extensions 的 tsconfig 直接从 node_modules 解析 SDK 类型。

## Event handler 消息注入

event handler（如 `tool_execution_end`）中注入消息**必须用 `pi.sendUserMessage()`**，不能用 `ctx.sendUserMessage()`：

| API | ctx (ExtensionContext) | pi (ExtensionAPI) |
|-----|----------------------|-------------------|
| sendUserMessage / sendMessage | 仅 ExtensionCommandContext（command handler 内可用） | 任何位置 |
| sessionManager / signal / cwd | ✅ | ❌ |

`tool_execution_end` 事件字段是 `{ toolCallId, toolName, result, isError }`——**没有 `args`**（输入参数只在 `tool_execution_start` / `tool_execution_update` 事件上，字段名是 `args` 不是 `input`），结果是 `result`（不是 `content`/`details`）。

`sendUserMessage` 的 `deliverAs` 两模式：

| 模式 | 行为 |
|------|------|
| `"steer"` | 当前 turn 完成后、下一个 LLM 调用前投递（需要 AI 立即处理用这个） |
| `"followUp"` | 等 agent 完全空闲后投递 |

`"nextTurn"`（队列到下一个用户 prompt）只属于 `pi.sendMessage()` 的 `deliverAs`，`sendUserMessage` 不支持。

**消息注入不触发 skill 命令**：`pi.sendUserMessage("/skill-name")` 只是普通用户消息文本，不会触发 skill 机制（skill 由命令系统解析）。正确做法：把期望行为直接写进消息内容（如 `Run fix_whitespace.py --fix <file>, then retry the edit`），不依赖 skill 命令。

**防循环**：注入的 steer 消息可能触发新的同类事件，hook 逻辑必须幂等或去重，否则 hook → 消息 → 新事件 → hook 无限循环。

## 扩展安装红线 [强制]

**所有扩展必须通过 npm 包（`pi install`）加载，禁止通过本地目录（`~/.pi/agent/extensions/`）加载，dev 环境测试除外。**

| 方式 | 场景 | 是否允许 |
|------|------|----------|
| `pi install npm:@zhushanwen/pi-xxx` | 生产使用 | ✅ 唯一正确方式 |
| `~/.pi/agent/extensions/` 目录放置 | dev 环境调试 | ✅ 仅开发时 |
| `~/.pi/agent/extensions/` 目录放置 | 日常使用 | ❌ 禁止 |

**原因**：Pi 的包发现机制对 npm 包和本地目录走不同路径。npm 包通过 `collectPackageResources` → `readPiManifest` 发现，**必须**有 `pi` 字段才能加载。本地目录有 `index.ts` fallback 所以不报错，但这掩盖了 `pi` 字段缺失的问题，导致 npm 安装后扩展静默不加载。

**每个扩展 package.json 必须包含以下最小声明**：

```json
{
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "keywords": ["pi-package"]
}
```

**[强制]** `pi.extensions` 必须为 `["./index.ts"]`，禁止 `["./src/index.ts"]`。顶层 `index.ts` re-export `src/index.ts`，确保 Pi 扩展加载列表统一显示纯包名。

有 skills 目录的扩展还必须声明 `"pi.skills": ["./skills"]`。

### 配置 skill 约定 [强制]

凡 agent 可能需要协助配置/使用/排查的扩展，**必须**附带一个统一命名的 config skill，承载该扩展的配置/使用说明，让 agent 通过 pi 的 progressive disclosure（skill description 进 `<available_skills>`，正文按需 read）自动发现。

**触发条件**（任一命中）：
- 扩展读取磁盘配置文件（`<agentDir>/` 下的 .json 等）
- 扩展有命令交互 / 复杂存储机制（如 event sourcing），agent 可能需要协助使用或排查

**要求**：
- **命名**：`skills/<extension简名>-ext-config/SKILL.md`（如 `permission` → `permission-ext-config`、`scheduler` → `scheduler-ext-config`）
- **声明**：`package.json` 的 `pi.skills: ["./skills"]` + `files` 含 `"skills/"`（否则 npm publish 丢 skill）
- **frontmatter**：`name` = 目录名 + `description` 双引号含触发词（决定 agent 能否正确匹配 read）
- **内容**：
  - 有磁盘配置文件 → 配置路径（getAgentDir 派生）+ schema + 默认值 + 配置示例
  - 无配置文件但有命令交互/复杂存储 → 使用方式 + 存储机制（不硬套配置 schema 模板）

**范例**：`extensions/universal/{rename-session,permission,scheduler}/skills/*-ext-config/`

### 配置路径约定 [强制]

所有扩展的磁盘配置文件统一放 `<agentDir>/config/<extension简名>-ext-config.json`。

- **命名 = `<extension简名>-ext-config.json`**（从 extension 名直接推导）：`permission-ext-config.json` / `scheduler-ext-config.json` / `rename-session-ext-config.json`
  - 后缀 `-ext-config` 与 config skill 名 `<简名>-ext-config` 对齐：skill（SKILL.md 指导文档）与它指导的配置文件（.json 数据）同名配对，agent 按 skill 名即可定位到配置文件，反之亦然
  - 禁止语义名（`model-policy.json`）、无后缀简写（`permission.json`）与 `<名>-config.json`（`permission-config.json`）——统一经 `@zhushanwen/pi-llm-shared` 的 `getConfigPath(pkgName)` 生成路径，调用方不自拼文件名
- `<agentDir>` = pi 的 `getAgentDir()`（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；xyz-agent 隔离环境 `~/.xyz-agent/pi/agent`）
- shared 库（如 quota-providers）的领域数据文件（providers.json / secrets.json / quota-cache.json）也放 `config/`，可用领域名（非包名）
- 目录形态的配置（如 plan-templates/）不在此约定内

**历史路径迁移（session_start 运行时迁移，过渡性——一个 major 后去除）**：

- **迁移机制**：extension 在 `session_start` hook 里做**幂等一次性迁移**（模块级 once flag 防同进程重复触发）。运行时迁移**不是**双读 fallback——迁移完成后运行时只读新路径，session_start 只是触发迁移的时机
- **为何用 session_start 而非安装时迁移**：session_start hook 在 pi 进程内运行，**跨原生 pi + xyz-agent 统一生效**（xyz-agent 启 pi 子进程时同样触发），不依赖包管理器是否执行 lifecycle 脚本。pi 无 install-time/first-load 钩子（pi 的 `readPiManifest` 只读 extensions/themes/skills/prompts，不认自定义字段），session_start 是最可靠的统一迁移时机
- **过渡性标记 [强制]**：迁移 hook 是为平滑老用户升级而设的**过渡机制，不是永久逻辑**。每个迁移 hook 必须在代码注释里标注：
  - `Added in v<X.Y.Z>`（加入此 hook 的版本）
  - `Remove after v<N>.0.0`（计划去除版本 = 加入版本的下一个个 major release 之后；到达时必须删除迁移 hook——老用户已充分迁移，新用户不存在旧路径）
- **幂等要求**（迁移逻辑复用 `@zhushanwen/pi-llm-shared` 的 `migrateLegacyConfig` 工具）：
  - 旧路径不存在 → noop
  - 旧路径存在 + 新路径不存在 → `renameSync`（同盘原子搬移）
  - 旧路径存在 + 新路径已存在 → **删除旧文件**（新的是当前配置，旧的是残留副本；pi 运行时只读新路径，保留旧只制造 warn 噪音）
  - 失败 → warn 不抛错（best-effort，下次启动重试）
- **已废弃机制（禁止再用）**：`scripts/migrate-config.mjs` / `package.json#scripts.postinstall` / `pi.migrate` 字段是早期「安装时迁移」方案，已被 session_start 取代：
  - `postinstall` 在 pnpm workspace install（开发环境）会误触发，动开发者真实 `~/.pi/agent`
  - `pi.migrate` 是 xyz-agent runtime 私有字段，pi 原生不认（对原生 pi 用户无效）
  - session_start 无此副作用，统一覆盖两环境
- **升级场景自洽**：旧版本代码读旧路径、新版本代码读新路径 + session_start hook 迁移，任何版本运行时都不双读

**已收敛清单**（2026-08，session_start hook 迁移，随包发布）：

| 包 | 旧路径 | 新路径 |
|---|---|---|
| `pi-permission` | `<agentDir>/permission-config.json` | `<agentDir>/config/permission-ext-config.json` |
| `pi-rename-session` | 已合规 | `<agentDir>/config/rename-session-ext-config.json`（llm-shared 派生，无迁移脚本） |

## Extension 依赖管理 [MANDATORY]

所有 extension 之间的依赖关系必须在项目根的 `extension-dependencies.json` 中声明。新增、修改、删除 extension 时必须同步更新此文件。

**数据文件**：
- `extension-dependencies.json` — 依赖关系数据（source of truth，项目根）
- `extension-dependencies.schema.json` — JSON Schema 校验

**依赖类型**：

| 类型 | 标识 | 含义 | 在 package.json 中体现 |
|------|------|------|----------------------|
| **runtime** | `"runtime"` | 运行时需要对方 extension 已安装，但代码层面不 import | 不体现（通过 pi 自动加载 extension） |
| **package** | `"package"` | npm 包级别依赖，代码中直接 import 对方的模块 | 必须在 `dependencies` 或 `peerDependencies` 中声明 |
| **optional** | `"optional"` | 功能增强，缺失时降级运行 | 在 `peerDependencies` + `peerDependenciesMeta.optional: true` 中声明 |

**校验**：`npx ajv-cli validate -s extension-dependencies.schema.json -d extension-dependencies.json`

详见：[pi-ext-019](./adr/pi-ext-019-structured-output-extension.md)

## 禁止使用已废弃的 Pi SDK namespace [MANDATORY]

**唯一正确的 namespace**：`@earendil-works/pi-*`（`pi-coding-agent`、`pi-tui`、`pi-ai`、`pi-agent-core` 四个包）。

**禁止使用**：`@mariozechner/pi-*` 已被 Pi 团队重命名并被 npmjs 标记为 deprecated。仓库内任何位置（`.ts`、`.json`、`.d.ts`、vitest.config.ts、tsconfig.json）出现这个旧 namespace：

- 会让 `pnpm install` 报 deprecation warning，污染终端输出
- 让本地 monorepo 可能拉取 npm 上未迁移的旧版本
- 认知成本高——「为什么会有两个 namespace」

xyz-agent 依赖 `@earendil-works/pi-coding-agent`，此约束对消费侧同样有效。

## 命名约定

- 扩展入口：`export default function xxxExtension(pi: ExtensionAPI)`
- 状态接口：`XxxRuntimeState`
- 工具参数：`XxxParams`（typebox schema）
- 工具详情：`XxxDetails`（renderResult 数据）

## 行数上限

- 单文件不超过 1000 行。超过时按职责拆分到 `src/` 下
- 函数不超过 80 行

> 注意：这是 extensions 的约定（TS 源码），与 xyz-agent 前端的约定（Vue template ≤400 / script ≤300）度量对象不同，各自 scope 合理。

## TypeScript 约定

- 禁止 `any`，用 `unknown` 或具体类型
- `(entry as any).customType` 这种模式改为类型守卫函数
- `as never` / `as any` / `as unknown as T` 会绕过类型检查，`taste/no-unsafe-cast` 规则（extensions/ 专用）会 warn 标记。不可替代的断言必须有运行时 guard 或 SDK 契约测试兜底
- import 顺序：Node 内置 → npm 包 → 项目内部

## typebox 注意事项

本项目存在两个 typebox 包：`typebox`（v1.x，新版，SDK 使用）和 `@sinclair/typebox`（v0.34.x，经典版）。

- 当 extension 的 schema 直接传给 `registerTool` 的泛型约束时，**必须用 `typebox`**（与 SDK 一致），否则结构不兼容导致类型错误
- 仅在 extension 内部使用 schema（不传给 SDK 泛型）时，两个包均可，但建议统一用 `typebox`
