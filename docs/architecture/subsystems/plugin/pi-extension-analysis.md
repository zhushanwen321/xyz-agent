# pi Extension 系统架构分析报告

> 基于 pi 源码 `~/Code/pi-mono-workspace/main/` 分析，涵盖 extension 生命周期、API、进程模型、通信机制等完整架构。

---

## 1. Extension 生命周期

### 1.1 发现（Discovery）

Extension 通过 `ResourceLoader` 从三个层级发现，优先级从低到高：

| 层级 | 路径 | 说明 |
|------|------|------|
| 项目级 | `<cwd>/.pi/extensions/` | 项目本地，跟随 git |
| 用户级 | `~/.pi/agent/extensions/` | 全局，跨项目 |
| CLI 显式 | `--extension <path>` 或 `-e <path>` | 运行时注入，最高优先级 |

**发现规则**（`loader.ts:discoverExtensionsInDir`）：
1. **直接文件**：`*.ts` 或 `*.js` 文件直接加载
2. **子目录 + index**：`<dir>/index.ts` 或 `<dir>/index.js`
3. **子目录 + package.json**：`<dir>/package.json` 中有 `pi.extensions` 字段，声明要加载的文件列表

不支持递归扫描，复杂多文件 extension 必须使用 `package.json` manifest。

> 源码：`loader.ts:resolveExtensionEntries()`, `loader.ts:discoverExtensionsInDir()`

### 1.2 加载（Loading）

使用 [jiti](https://github.com/unjs/jiti) 动态加载 TypeScript 模块：

```
loadExtensions(paths, cwd, eventBus)
  → loadExtension(path, cwd, eventBus, runtime)
    → loadExtensionModule(path)  // jiti.import() 加载 TS/JS
    → factory = module.default   // 必须导出工厂函数
    → api = createExtensionAPI(extension, runtime, cwd, eventBus)
    → factory(api)               // 调用工厂函数，注册 hooks/tools/commands
```

**关键机制**：
- 每个 extension 模块必须导出一个工厂函数（`ExtensionFactory`）：`(pi: ExtensionAPI) => void | Promise<void>`
- jiti 配置了虚拟模块（Bun binary 模式）或路径别名（Node.js 模式），使 extension 可以 `import { Type } from "typebox"` 等
- **编译产物兼容**：Bun 编译时将所有 `@earendil-works/*` 包内联为 virtualModules，extension 在编译后的二进制中仍能 import

> 源码：`loader.ts:loadExtension()`, `loader.ts:loadExtensionModule()`

### 1.3 初始化（Initialization）

分两阶段：

**阶段一：注册（Registration）**
- 工厂函数被调用时，extension 通过 `pi.on()`, `pi.registerTool()`, `pi.registerCommand()` 等方法注册所有能力
- 此时 `ExtensionRuntime` 的 action 方法（sendMessage、setModel 等）都是 **throwing stubs**，调用会报错
- `pi.registerProvider()` 在此阶段只是入队 `pendingProviderRegistrations`

**阶段二：绑定（Binding）**
- `ExtensionRunner.bindCore(actions)` 被调用，将真实的 action 实现注入到 `ExtensionRuntime`
- 刷新 provider 注册队列：`pendingProviderRegistrations` → `ModelRegistry.registerProvider()`
- 此后 action 方法可正常使用

> 源码：`runner.ts:bindCore()`, `loader.ts:createExtensionRuntime()`

### 1.4 运行（Running）

- Extension 的事件处理器在宿主进程的主线程中同步/异步执行
- 每次事件触发时通过 `ExtensionRunner.createContext()` 创建一个 `ExtensionContext`，包含当前 session 状态
- 事件按 extension 加载顺序依次调用，支持链式处理（如 context 事件修改 messages）

### 1.5 销毁（Destruction）

- `session_shutdown` 事件通知 extension 即将销毁
- Session 替换（newSession、fork、switchSession）或 reload 时，旧 runtime 调用 `invalidate()` 标记为 stale
- Stale runtime 的所有方法调用会 throw Error，防止使用过期的 ctx

> 源码：`runner.ts:invalidate()`, `types.ts:ExtensionRuntimeState.invalidate()`

---

## 2. Extension API（pi 对象）

### 2.1 API 面积总览

`ExtensionAPI` 提供以下能力：

| 类别 | 方法 | 说明 |
|------|------|------|
| **事件订阅** | `on(event, handler)` | 30+ 种事件类型 |
| **工具注册** | `registerTool(tool)` | 注册 LLM 可调用的 tool |
| **命令注册** | `registerCommand(name, opts)` | 注册 slash 命令 |
| **快捷键注册** | `registerShortcut(key, opts)` | 注册键盘快捷键 |
| **CLI 标志** | `registerFlag(name, opts)` / `getFlag(name)` | 注册和读取 CLI 标志 |
| **消息渲染** | `registerMessageRenderer(type, renderer)` | 自定义消息渲染 |
| **发送消息** | `sendMessage(msg)` / `sendUserMessage(content)` | 向 session 注入消息 |
| **持久化** | `appendEntry(type, data)` | 追加自定义 session entry（不发给 LLM） |
| **Session 元数据** | `setSessionName()` / `getSessionName()` / `setLabel()` | 设置 session 名称和标签 |
| **Shell 执行** | `exec(cmd, args, opts)` | 执行外部命令 |
| **Tool 管理** | `getActiveTools()` / `getAllTools()` / `setActiveTools()` | 管理活跃 tool 列表 |
| **模型控制** | `setModel()` / `getThinkingLevel()` / `setThinkingLevel()` | 切换模型和 thinking level |
| **Provider 注册** | `registerProvider()` / `unregisterProvider()` | 注册/注销模型 provider |
| **扩展间通信** | `events` (EventBus) | 发布/订阅跨 extension 事件 |

### 2.2 事件类型清单

Extension 可以监听 **30+ 种事件**，按类别分组：

**Session 事件**
- `session_start` — session 启动/加载/重载
- `session_before_switch` — session 切换前（可取消）
- `session_before_fork` — session 分叉前（可取消）
- `session_before_compact` — compaction 前（可取消/自定义）
- `session_compact` — compaction 完成
- `session_shutdown` — session 关闭
- `session_before_tree` — session tree 导航前（可取消）
- `session_tree` — session tree 导航完成

**Agent 事件**
- `context` — LLM 调用前，可修改 messages
- `before_provider_request` — provider 请求发出前，可替换 payload
- `after_provider_response` — provider 响应后
- `before_agent_start` — agent 循环开始前，可修改 system prompt
- `agent_start` / `agent_end` — agent 循环开始/结束
- `turn_start` / `turn_end` — 单轮对话开始/结束
- `message_start` / `message_update` / `message_end` — 消息流事件
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end` — 工具执行事件

**Tool 拦截事件**
- `tool_call` — 工具调用前，可**拦截/阻止**执行，可**修改参数**
- `tool_result` — 工具执行后，可**修改返回结果**

**Model 事件**
- `model_select` / `thinking_level_select` — 模型/thinking level 切换

**输入事件**
- `input` — 用户输入后，可**转换/拦截**输入
- `user_bash` — 用户执行 bash 命令，可替换执行方式

**资源发现事件**
- `resources_discover` — 允许 extension 动态提供 skill/prompt/theme 路径

### 2.3 可中断/可修改的事件

部分事件支持返回值来影响后续行为：

| 事件 | 返回值效果 |
|------|-----------|
| `context` | 修改发送给 LLM 的 messages |
| `before_provider_request` | 替换整个 API payload |
| `before_agent_start` | 注入消息 + 替换 system prompt |
| `message_end` | 替换最终消息 |
| `tool_call` | `block: true` 阻止执行 |
| `tool_result` | 修改 tool 返回内容 |
| `input` | `handled`（吞掉）/ `transform`（修改文本）|
| `session_before_*` | `cancel: true` 取消操作 |
| `resources_discover` | 返回额外的 skill/prompt/theme 路径 |
| `user_bash` | 提供自定义执行器或替换结果 |

> 源码：`types.ts:ExtensionEvent` 联合类型（约 30+ 种）

---

## 3. 进程模型

### 3.1 Extension 运行在宿主进程内

**关键发现：所有 extension 运行在 pi 的主进程中，没有进程隔离。**

- Extension 代码通过 jiti 加载后在同一进程空间执行
- 事件处理器、tool execute 函数、UI 操作都在主线程执行
- 共享同一个 `ExtensionRuntime` 对象，所有 extension 共享一个 runtime 实例

### 3.2 没有沙箱

- Extension 可以访问 Node.js 全部 API（`fs`, `child_process`, `os` 等）
- Extension 可以 import 宿主的包（`@earendil-works/pi-coding-agent`, `typebox` 等）
- 没有权限控制，没有 capability 限制
- 这是有意设计：pi 的 extension 是"受信任的"代码，不是"不可信插件"

### 3.3 Stale Instance 保护

虽然没有沙箱，但有 **stale instance 保护**机制：
- Session 替换/reload 后，旧 runtime 被 `invalidate()`，所有方法调用 throw
- 防止 extension 在 session 切换后仍持有旧 context

> 源码：`runner.ts` 全文，`types.ts:ExtensionRuntimeState.assertActive()`

---

## 4. 通信机制

### 4.1 Extension ↔ 宿主

**直接函数调用**——没有 IPC，没有序列化。

Extension 的 handler 函数在宿主进程中直接被调用，参数是内存中的对象引用。返回值也是直接传递。

```
ExtensionRunner.emit(event) → for ext in extensions → handler(event, ctx) → result
```

### 4.2 Extension ↔ Extension

通过 `pi.events`（EventBus）发布/订阅：

```typescript
// Extension A
pi.events.on("my-channel", (data) => { ... });

// Extension B  
pi.events.emit("my-channel", { ... });
```

EventBus 基于 Node.js EventEmitter，纯内存，同进程。

> 源码：`event-bus.ts`, `types.ts:ExtensionAPI.events`

### 4.3 Extension ↔ LLM Agent

通过以下机制间接通信：

1. **Tool 注册** → LLM 看到 tool schema → 调用 tool → extension execute 函数被调用
2. **消息注入** → `pi.sendMessage()` / `pi.sendUserMessage()` 注入消息到对话流
3. **Context 修改** → `on("context")` 修改发给 LLM 的 messages
4. **System prompt 修改** → `on("before_agent_start")` 替换 system prompt
5. **Tool 拦截** → `on("tool_call")` 修改 LLM 发起的 tool 调用参数

---

## 5. Manifest 格式

pi extension **没有独立的 manifest 文件**。

Extension 的声明方式：

### 5.1 单文件 Extension

直接是一个 `.ts` 文件，导出工厂函数：

```typescript
// my-extension.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.on("agent_start", () => { ... });
  pi.registerTool({ ... });
}
```

### 5.2 多文件 Extension（package.json）

`package.json` 中的 `pi` 字段：

```json
{
  "pi": {
    "extensions": ["src/index.ts", "src/extra.ts"]
  }
}
```

这是唯一的 manifest 格式，**没有 name、version、permissions 等字段**。

### 5.3 加载入口解析优先级

```
1. package.json 存在且有 pi.extensions → 加载声明的文件列表
2. index.ts 或 index.js 存在 → 加载 index 文件
3. 都没有 → 跳过该目录
```

> 源码：`loader.ts:resolveExtensionEntries()`

---

## 6. 权限模型

**pi 没有权限模型。**

Extension 拥有与宿主进程完全相同的权限：
- 完整的文件系统访问
- 完整的网络访问
- 完整的子进程执行能力
- 完整的环境变量访问

唯一的"安全"机制来自 subagent extension 的 `agentScope`：
- 默认只加载 user 级别 agent（`~/.pi/agent/agents/`）
- 项目级 agent（`.pi/agents/`）需要显式 `agentScope: "project"` 或 `"both"`
- 项目级 agent 使用时会弹出确认对话框（可通过 `confirmProjectAgents: false` 跳过）

**这属于子进程级别的隔离策略，不是 extension 自身的权限控制。**

> 源码：`examples/extensions/subagent/agents.ts:discoverAgents()`

---

## 7. UI 交互协议

### 7.1 ExtensionUIContext 接口

Extension 通过 `ctx.ui.*` 与用户交互，根据运行模式（interactive/RPC/print）有不同实现：

| 方法 | 说明 | Interactive | RPC |
|------|------|:-----------:|:---:|
| `select(title, options)` | 下拉选择 | ✓ | ✓ (协议转发) |
| `confirm(title, message)` | 确认对话框 | ✓ | ✓ (协议转发) |
| `input(title, placeholder)` | 文本输入 | ✓ | ✓ (协议转发) |
| `notify(message, type)` | 通知 | ✓ | ✓ (fire-and-forget) |
| `setStatus(key, text)` | 状态栏 | ✓ | ✓ (fire-and-forget) |
| `setWorkingMessage(msg)` | 加载文案 | ✓ | ✗ |
| `setWorkingIndicator(opts)` | 加载动画 | ✓ | ✗ |
| `setWidget(key, content)` | 挂件 | ✓ | ✓ (仅文本) |
| `setFooter(factory)` | 自定义 footer | ✓ | ✗ |
| `setHeader(factory)` | 自定义 header | ✓ | ✗ |
| `custom(factory)` | 自定义全屏 UI | ✓ | ✗ |
| `editor(title, prefill)` | 多行编辑器 | ✓ | ✓ (协议转发) |
| `pasteToEditor(text)` | 粘贴到编辑器 | ✓ | ✓ (降级为 setEditorText) |
| `setEditorText(text)` | 设置编辑器内容 | ✓ | ✓ (fire-and-forget) |
| `onTerminalInput(fn)` | 原始终端输入 | ✓ | ✗ |
| `theme` | 读取当前主题 | ✓ | ✓ (默认主题) |
| `setTheme(name)` | 切换主题 | ✓ | ✗ |

### 7.2 RPC 模式下的 UI 协议

RPC 模式中，UI 请求通过 JSON 行协议转发给外部客户端：

```
→ { "type": "extension_ui_request", "id": "uuid", "method": "select", "title": "...", "options": [...] }
← { "type": "extension_ui_response", "id": "uuid", "value": "..." }
```

**模式**：
- 对话型（select/confirm/input/editor）：request-response，有 pending map
- 通知型（notify/setStatus/setWidget）：fire-and-forget，不等待响应
- 不支持型（custom/setFooter/setHeader）：静默忽略

`hasUI` 标志标识 UI 是否可用（print 模式为 false）。

### 7.3 对话框超时和信号

所有对话框方法支持 `ExtensionUIDialogOptions`：
- `signal?: AbortSignal` — 外部取消
- `timeout?: number` — 自动超时（带倒计时显示）

> 源码：`types.ts:ExtensionUIContext`, `rpc-mode.ts:createExtensionUIContext()`

---

## 8. Subagent 扩展

### 8.1 Subagent 是 Extension 实现

pi 的 subagent 系统**不是内置功能**，而是作为示例 extension 提供（`examples/extensions/subagent/`）。

核心机制：
- 通过 `pi.registerTool()` 注册名为 `subagent` 的 tool
- LLM 调用 `subagent` tool 时，extension **spawn 一个新的 `pi --mode json` 子进程**
- 子进程有独立的 context window，不与父进程共享

### 8.2 Agent 定义格式

Markdown 文件 + YAML frontmatter：

```markdown
---
name: planner
description: Creates implementation plans
tools: read, grep, find, ls
model: claude-sonnet-4-5
---
System prompt body...
```

Agent 发现路径：
- User 级：`~/.pi/agent/agents/*.md`
- Project 级：`.pi/agents/*.md`（需要 `agentScope` 参数启用）

### 8.3 运行模式

| 模式 | 参数 | 说明 |
|------|------|------|
| Single | `{ agent, task }` | 单 agent |
| Parallel | `{ tasks: [...] }` | 并发执行（max 8 tasks, 4 concurrent） |
| Chain | `{ chain: [...] }` | 串行，支持 `{previous}` 占位符 |

### 8.4 进程隔离

每个 subagent 调用：
1. 写 system prompt 到临时文件
2. `spawn(pi --mode json -p --no-session --append-system-prompt <file> Task: <task>)`
3. 解析 stdout 的 JSON 行输出（`message_end`, `tool_result_end` 事件）
4. 支持通过 AbortSignal 终止子进程（SIGTERM → 5s → SIGKILL）

> 源码：`examples/extensions/subagent/index.ts`, `examples/extensions/subagent/agents.ts`

---

## 9. 配置/持久化

### 9.1 Extension 没有独立的数据目录

pi 没有为 extension 提供专用的数据存储 API。Extension 需要自行管理持久化。

### 9.2 可用的持久化机制

| 机制 | 方式 | 说明 |
|------|------|------|
| Session entry | `pi.appendEntry(type, data)` | 追加到 session 文件，不发给 LLM |
| Session 名称 | `pi.setSessionName(name)` | 持久化到 session |
| Label | `pi.setLabel(entryId, label)` | 标记 session entry |
| 文件系统 | 自行 `fs.writeFile()` | 无约束，任意路径 |
| CLI flag | `pi.registerFlag()` / `pi.getFlag()` | CLI 参数传递，非持久化 |

### 9.3 Extension 共享状态

所有 extension 共享：
- 同一个 `ExtensionRuntime`（flag values、provider registrations）
- 同一个 `EventBus`（`pi.events`）
- 同一个 `SessionManager`（只读）
- 同一个 `ModelRegistry`

> 源码：`types.ts:ExtensionAPI`

---

## 10. 加载路径

### 10.1 完整加载流程

```
1. CLI 参数解析 → --extension/-e 收集路径
2. ResourceLoader.reload()
   ├── 用户级扩展目录: ~/.pi/agent/extensions/
   ├── 项目级扩展目录: <cwd>/.pi/extensions/
   ├── 包管理器解析: pi install <package> → ~/.pi/agent/packages/
   └── CLI 显式路径: --extension <path>
3. discoverAndLoadExtensions(paths, cwd, agentDir)
   ├── discoverExtensionsInDir() × 多个目录
   ├── loadExtensions() → loadExtension() × 每个路径
   │   └── jiti.import() → factory(api)
   └── loadExtensionFactories() → 内联工厂函数
4. ExtensionRunner 创建并 bindCore()
5. 事件流开始
```

### 10.2 CLI 参数传递

```
pi --extension /path/to/ext.ts    # 加载单个文件
pi -e /path/to/ext-dir/           # 加载目录
pi -e ./ext1.ts -e ./ext2.ts      # 可重复使用
```

`--no-extensions` 标志跳过所有自动发现的 extension，但仍加载 CLI 显式指定的。

### 10.3 包管理器

`pi install <source>` 安装 extension 包到 `~/.pi/agent/packages/`，包的 `package.json` 中声明 extension 文件路径。ResourceLoader 通过 `PackageManager.resolve()` 解析已安装的包。

> 源码：`resource-loader.ts:reload()`, `loader.ts:discoverAndLoadExtensions()`, `cli/args.ts`

---

## 11. 架构总结与关键发现

### 11.1 设计哲学

pi 的 extension 系统设计哲学是 **"受信任的代码扩展"**：
- 没有沙箱、没有权限控制、没有 manifest 验证
- Extension 是宿主进程的一部分，共享所有能力
- 安全边界在"是否加载 extension"这一层，不在 extension 运行时

### 11.2 核心架构图

```
┌─────────────────────────────────────────────────────────┐
│                    pi 主进程                              │
│                                                          │
│  ┌──────────────┐    ┌─────────────────────────────┐     │
│  │ ResourceLoader│───→│ ExtensionRunner              │     │
│  │ (发现+加载)   │    │ (运行+事件分发)              │     │
│  └──────────────┘    │                               │     │
│                      │  Extension[]                  │     │
│                      │  ├── handlers (事件处理器)     │     │
│                      │  ├── tools (注册的 tool)       │     │
│                      │  ├── commands (slash 命令)     │     │
│                      │  ├── flags (CLI 标志)          │     │
│                      │  ├── shortcuts (快捷键)        │     │
│                      │  └── messageRenderers          │     │
│                      │                               │     │
│                      │  ExtensionRuntime (共享状态)    │     │
│                      │  EventBus (跨 ext 通信)        │     │
│                      └──────────┬──────────────────────┘     │
│                                 │                           │
│  ┌──────────────────────────────┼───────────────────────┐   │
│  │ AgentSession                  │                       │   │
│  │ (agent 循环 + session 管理)   │                       │   │
│  │                               │                       │   │
│  │  agent events ───────────────→│ emit to extensions    │   │
│  │  tool calls ─────────────────→│ tool_call event       │   │
│  │  tool results ───────────────→│ tool_result event     │   │
│  │  context modifications ←──────│ context event result  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ UI 层                                                │    │
│  │  InteractiveMode → 直接 TUI 组件                     │    │
│  │  RPCMode → extension_ui_request/response JSON 协议   │    │
│  │  PrintMode → noOpUIContext（所有方法静默）             │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

                    ↕ (子进程)
┌─────────────────────────────────────────────────────────┐
│  Subagent: pi --mode json -p --no-session                │
│  (独立进程，独立 context window，通过 JSON stdout 通信)    │
└─────────────────────────────────────────────────────────┘
```

### 11.3 对 xyz-agent 插件系统的启示

| 维度 | pi 的选择 | xyz-agent 可考虑 |
|------|----------|-----------------|
| **进程模型** | 同进程，无隔离 | 可考虑进程隔离（Electron utility process）|
| **权限模型** | 无（信任模型） | 需要：插件可能来自第三方 |
| **Manifest** | 无独立文件 | 需要：声明式 manifest（name, version, permissions）|
| **UI 协议** | TUI 组件 / RPC JSON | 需要：Electron IPC + Vue 组件协议 |
| **Extension API 面积** | 极大（30+ 事件，全套 TUI） | 可借鉴事件分类，但需要收窄暴露面 |
| **生命周期** | 两阶段（注册+绑定） | 可复用此模式 |
| **持久化** | 无专用 API | 需要提供隔离的数据目录 |
| **Subagent** | extension 实现（spawn 子进程） | 可作为核心内置或作为一等 citizen |
| **Extension 间通信** | 内存 EventBus | 可用 Electron IPC 或 MessagePort |
| **加载路径** | 3 层（项目/用户/CLI） | 可复用，增加 marketplace 层 |
