# pi SDK 集成方案深度调研

**日期**: 2026-05-06 | **版本**: v1.0 | **状态**: 调研完成

> 本文档对比分析将 pi SDK 集成到 xyz-agent Node.js Sidecar 的两种路径：Direct SDK Import（Path A）和 Subprocess RPC（Path B），并评估其与 P1/P5/P6 各阶段的兼容性。

---

## 1. Path A: Direct SDK Import — 完整分析

### 1a. 初始化依赖链

从 `import` 到第一次 `prompt()`，完整的初始化链路如下：

```
1. import { createAgentSession } from "@mariozechner/pi-coding-agent"
   ↓
2. createAgentSession(options)  ←── 工厂函数（sdk.ts）
   ↓
3. 内部创建/接受依赖：
   ├── AuthStorage      → 默认 AuthStorage.create(agentDir/auth.json)
   ├── ModelRegistry    → 默认 ModelRegistry.create(authStorage, agentDir/models.json)
   ├── SettingsManager  → 默认 SettingsManager.create(cwd, agentDir)
   │   └── 读取 ~/.pi/agent/settings.json（全局）+ .pi/settings.json（项目级）
   ├── SessionManager   → 默认 SessionManager.create(cwd, sessionDir)
   │   └── JSONL 会话文件读写
   └── ResourceLoader   → 默认 DefaultResourceLoader({ cwd, agentDir, settingsManager })
       ↓
4. await resourceLoader.reload()  ←── 关键异步步骤
   ├── await settingsManager.reload()
   ├── await packageManager.resolve()  ←── npm/git 包发现
   ├── await loadExtensions(paths)     ←── 扫描+加载所有 extension
   ├── loadSkills(skillPaths)          ←── 加载所有 SKILL.md
   ├── loadPromptTemplates(promptPaths)←── 加载 prompt 模板
   └── loadProjectContextFiles()       ←── 加载 AGENTS.md / CLAUDE.md
   ↓
5. findInitialModel() → 从 settings/apiKey 查找可用模型
   ↓
6. new Agent({ streamFn, convertToLlm, ... })  ←── pi-agent-core 核心 Agent
   ↓
7. new AgentSession({ agent, sessionManager, settingsManager, resourceLoader, ... })
   ↓
8. 返回 { session, extensionsResult, modelFallbackMessage }
   ↓
9. session.prompt("Hello") → 首次交互
```

**关键发现**：

| 依赖 | 是否必须 | 文件系统依赖 | 说明 |
|------|---------|-------------|------|
| `SettingsManager` | 是 | `~/.pi/agent/settings.json` + `.pi/settings.json` | 两级配置合并 |
| `AuthStorage` | 是 | `~/.pi/agent/auth.json` | API Key 存储 |
| `ModelRegistry` | 是 | `~/.pi/agent/models.json` | 模型注册表 |
| `SessionManager` | 是 | JSONL 文件（可内存模式） | 会话持久化 |
| `ResourceLoader` | 是 | 大量文件系统扫描 | Extensions、Skills、Prompts、Context files |
| `Agent` | 是 | 无 | pi-agent-core 纯逻辑对象 |

**可绕过项**：
- `SessionManager.inMemory()` — 可跳过文件持久化
- `SettingsManager.inMemory(settings)` — 可跳过配置文件
- 但 `ResourceLoader.reload()` 仍需扫描文件系统加载 extensions/skills

**最小初始化代码**：

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: "/path/to/project",
  agentDir: "/path/to/agent/config",  // 需要包含 auth.json
  noTools: "all",                      // 禁用内置工具
  // 或指定自定义工具集
  tools: ["read", "bash"],
});
```

### 1b. Session 创建和事件获取

**创建 session**：

```typescript
// sdk.ts 导出
function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>

interface CreateAgentSessionResult {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  modelFallbackMessage?: string;
}
```

**发送 prompt**：

```typescript
// agent-session.ts
class AgentSession {
  async prompt(text: string, options?: PromptOptions): Promise<void>
  async steer(message: string, images?: ImageContent[]): Promise<void>
  async followUp(message: string, images?: ImageContent[]): Promise<void>
  async abort(): Promise<void>
}

interface PromptOptions {
  expandPromptTemplates?: boolean;  // default: true
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";  // 流式时的队列策略
  source?: InputSource;  // "interactive" | "rpc" | ...
}
```

**接收流式事件**：

```typescript
// agent-session.ts
type AgentSessionEvent =
  | AgentEvent                    // 来自 pi-agent-core 的底层事件
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start" | "compaction_end"; ... }
  | { type: "auto_retry_start" | "auto_retry_end"; ... }
  | { type: "session_info_changed"; ... }

// AgentEvent（来自 pi-agent-core）包含：
// - message_start, message_update, message_end
// - tool_call_start, tool_call_update, tool_call_end
// - agent_start, agent_end
// - thinking_start, thinking_update, thinking_end
// 等约 17 种事件类型

// 订阅事件
const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
  // 实时接收所有事件
});

// prompt() 是 async，但事件通过 subscribe 异步推送
// prompt() resolve 不代表 agent 完成，agent_end 事件才代表完成
```

**关键机制**：`prompt()` 发起后立即返回（异步），事件通过 `subscribe()` 的回调推送。调用方需自行维护事件循环或用 `agent.waitForIdle()` 等待完成。

### 1c. 资源和配置管理

**Provider 配置**：

```typescript
// 通过 SettingsManager 配置（settings.json）
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "transport": "sse",  // "sse" | "websocket"
}

// API Key 通过 AuthStorage 管理
authStorage.setRuntimeApiKey("anthropic", "sk-ant-...");
// 或环境变量 ANTHROPIC_API_KEY
// 或 ~/.pi/agent/auth.json 文件
```

**模型配置**：

```typescript
// ModelRegistry 管理所有可用模型
const models = await session.modelRegistry.getAvailable();
await session.setModel(model);
```

**工具配置**：

```typescript
// 创建时指定工具
createAgentSession({
  tools: ["read", "bash", "edit", "write"],  // 白名单
  noTools: "all",                              // 全部禁用
  customTools: [myTool],                       // 自定义工具
});

// SDK 导出独立的工具工厂
import { createReadTool, createBashTool, createCodingTools } from "@mariozechner/pi-coding-agent";
```

**配置文件需求汇总**：

| 文件 | 路径 | 用途 | 是否必须 |
|------|------|------|---------|
| `settings.json` | `~/.pi/agent/settings.json` | 全局配置 | 可用 inMemory 替代 |
| `auth.json` | `~/.pi/agent/auth.json` | API Key | 可用环境变量 + inMemory |
| `models.json` | `~/.pi/agent/models.json` | 模型注册 | 可自动发现 |
| Session JSONL | 可配置路径 | 会话持久化 | 可用 inMemory |
| Extensions | `.pi/extensions/` 等 | 扩展加载 | 可用 `noExtensions: true` |
| Skills | `.pi/skills/` 等 | 技能加载 | 可用 `noSkills: true` |

### 1d. 优势

1. **零进程开销**：同进程运行，无 IPC 序列化/反序列化，无进程启动延迟
2. **类型安全**：直接使用 TypeScript 类型，编译时捕获错误
3. **API 完整性**：可访问 `AgentSession` 的所有方法（包括 RPC 协议未暴露的内部 API）
4. **灵活的工具定制**：可直接创建和注入自定义 `ToolDefinition`，无需通过 extension 机制
5. **事件直接获取**：`subscribe()` 直接接收内存中的事件对象，无 JSON 解析开销
6. **调试友好**：单进程，可直接断点调试、查看调用栈
7. **ResourceLoader 可定制**：可通过 `extensionsOverride`/`skillsOverride` 等 hook 精确控制加载行为
8. **共享 Agent 实例**：多个组件可共享同一 session（如 GUI + CLI 同时操作）

### 1e. 劣势和风险

1. **依赖体积大**：
   - `@mariozechner/pi-coding-agent` 依赖 `pi-agent-core`、`pi-ai`、`pi-tui`、`chalk`、`diff`、`marked`、`undici` 等
   - `pi-tui` 包含终端 UI 组件（ink/React-based），在 Sidecar 场景中无用
   - `@silvia-odwyer/photon-node` 包含 WASM 模块（图片处理），可能增加打包复杂度
   - `proper-lockfile` 同步文件锁，在 Tauri 环境中可能引起问题

2. **隐式全局状态冲突**：
   - `chalk`、`process.stdout` 控制（`takeOverStdout`）等全局副作用
   - pi 的 `process.env.PI_CODING_AGENT = "true"` 等环境变量修改
   - `process.emitWarning` 被覆盖为空函数（`cli.ts`）

3. **初始化复杂**：
   - `ResourceLoader.reload()` 执行大量文件系统 I/O（扫描 extensions、skills、prompts）
   - 在 xyz-agent 的 Node.js Sidecar 中，这些 I/O 与 Rust 后端通过 Tauri Command 通信的模式不一致
   - 每次创建 session 都需完整初始化链路

4. **Native 模块风险**：
   - `@silvia-odwyer/photon-node` 是 WASM 模块，需验证在 Tauri 打包环境中是否正常
   - `@mariozechner/clipboard`（optional）依赖 native 模块
   - `proper-lockfile` 使用同步文件锁

5. **版本耦合**：
   - 直接 import 意味着与 pi 的内部 API 强耦合
   - pi 升级可能导致 breaking change（即使 semver 兼容，内部重构也可能影响）
   - `AgentSession` 类有 3000+ 行，内部状态复杂

6. **资源隔离缺失**：
   - 单进程中所有 session 共享内存，一个 session 的 OOM/crash 影响全部
   - 工具执行（bash、文件操作）在主进程中运行，无隔离

### 1f. 对未来 Phase 的影响

#### P5: Single-level SubAgent（多 session 管理）

**可行性：中等**

```typescript
// 理论上可以创建多个 AgentSession
const mainSession = await createAgentSession({ cwd: projectDir });
const subSession = await createAgentSession({ cwd: projectDir, noTools: "all" });

// 但问题：
// 1. 两个 session 共享同一进程资源（AuthStorage、ModelRegistry 默认共享文件）
// 2. BashTool 在同一进程中执行，工具隔离需要自定义实现
// 3. SessionManager 的 JSONL 文件可能有并发写入冲突
```

**主要障碍**：
- 需要为每个 SubAgent 创建独立的 `AuthStorage`/`SessionManager`/`ResourceLoader` 实例
- 工具执行（特别是 bash）需要自定义隔离机制
- 一个 SubAgent 的未捕获异常会影响整个进程

#### P6: Recursive SubAgent with RPC Bridge（交互式通信）

**可行性：低**

- P6 的核心需求是 SubAgent 运行时能**交互式地**与用户通信（ask_user）
- 这需要 SubAgent 的 `extension_ui_request` 能被主 Agent 代理给用户
- Direct SDK 模式下，`ExtensionUIContext` 直接绑定到 session，无法跨 session 代理
- 需要实现复杂的跨 session UI 代理层，本质上是在进程内重造 RPC 协议

#### 多并发 Session

**可行性：中等但脆弱**
- 可以创建多个 `AgentSession` 实例
- 但全局状态（`process.stdout` 控制、环境变量）可能冲突
- 并发 bash 执行在同一进程中，无资源限制

#### SubAgent 进程隔离

**可行性：不可行**
- Direct SDK 在同一进程中运行，无法实现进程级隔离
- 一个 SubAgent 崩溃 = 整个 Sidecar 崩溃 = 整个 Tauri 应用受影响

---

## 2. Path B: Spawn pi subprocess with RPC — 完整分析

### 2a. RPC 协议完整能力

#### 命令（stdin → pi 进程）

| 类别 | 命令 | 说明 |
|------|------|------|
| **对话** | `prompt` | 发送消息，支持 images、streamingBehavior |
| | `steer` | 中断式转向（LLM 正在生成时注入） |
| | `follow_up` | 队列式追加（LLM 完成后处理） |
| | `abort` | 终止当前生成 |
| **Session** | `new_session` | 新建会话（支持 parentSession 追踪） |
| | `switch_session` | 切换到已有会话 |
| | `fork` | 从指定消息分叉 |
| | `clone` | 克隆当前分支 |
| | `get_session_stats` | 获取统计信息 |
| | `set_session_name` | 设置会话名称 |
| **模型** | `set_model` | 设置 provider/modelId |
| | `cycle_model` | 切换下一个模型 |
| | `get_available_models` | 获取可用模型列表 |
| **思维** | `set_thinking_level` | 设置思考级别 |
| | `cycle_thinking_level` | 循环切换 |
| **队列模式** | `set_steering_mode` | "all" 或 "one-at-a-time" |
| | `set_follow_up_mode` | "all" 或 "one-at-a-time" |
| **压缩** | `compact` | 手动压缩上下文 |
| | `set_auto_compaction` | 开关自动压缩 |
| **重试** | `set_auto_retry` | 开关自动重试 |
| | `abort_retry` | 终止重试 |
| **Bash** | `bash` | 执行 bash 命令 |
| | `abort_bash` | 终止 bash 执行 |
| **状态** | `get_state` | 获取完整 RpcSessionState |
| | `get_messages` | 获取所有消息 |
| | `get_commands` | 获取可用命令（extension/prompt/skill） |
| | `get_last_assistant_text` | 获取最后一条助手消息文本 |
| | `get_fork_messages` | 获取可分叉消息列表 |

#### 响应（pi 进程 → stdout）

```typescript
// 每个命令都有对应的 response
{ id, type: "response", command, success: true, data }  // 成功
{ id, type: "response", command, success: false, error } // 失败

// id 用于请求-响应关联
// prompt 命令的 response 在 preflight 成功后立即发出（不等 agent 完成）
```

#### 流式事件（pi 进程 → stdout，持续推送）

所有 `AgentEvent` 都通过 stdout 推送，包括：
- `message_start` / `message_update`（text_delta） / `message_end`
- `thinking_start` / `thinking_update` / `thinking_end`
- `tool_call_start` / `tool_call_update` / `tool_call_end`
- `agent_start` / `agent_end`

#### 交互式通信：Extension UI Protocol

这是 RPC 协议最关键的能力，支持 SubAgent 与用户的交互式通信：

```typescript
// pi → stdout：子 Agent 需要用户输入
type RpcExtensionUIRequest =
  | { type: "extension_ui_request"; id; method: "select"; title; options }
  | { type: "extension_ui_request"; id; method: "confirm"; title; message }
  | { type: "extension_ui_request"; id; method: "input"; title; placeholder }
  | { type: "extension_ui_request"; id; method: "editor"; title; prefill }
  | { type: "extension_ui_request"; id; method: "notify"; message }
  | { type: "extension_ui_request"; id; method: "setStatus"; statusKey; statusText }
  | { type: "extension_ui_request"; id; method: "setWidget"; widgetKey; widgetLines }
  | { type: "extension_ui_request"; id; method: "setTitle"; title }
  | { type: "extension_ui_request"; id; method: "set_editor_text"; text }

// stdin → pi：用户回答
type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id; value: string }       // 输入值
  | { type: "extension_ui_response"; id; confirmed: boolean }   // 确认/取消
  | { type: "extension_ui_response"; id; cancelled: true }      // 取消

// 机制：
// 1. 子 Agent extension 调用 ctx.ui.confirm/input/select
// 2. pi RPC 层生成 extension_ui_request（含唯一 id）写到 stdout
// 3. 宿主程序读取后代理给用户（GUI 弹窗 / TUI 组件）
// 4. 宿主程序将用户回答作为 extension_ui_response 写到 stdin
// 5. pi 将回答传回 extension，工具 execute() resume
```

**交互式通信完整流程**：

```
宿主程序 (xyz-agent Sidecar)           pi 子进程 (--mode rpc)
     │                                       │
     │  { type: "prompt", message }         │
     │ ──────────────────────────────────→   │  开始 LLM 生成
     │                                       │
     │  ← AgentEvent: message_update         │  流式文本
     │  ← AgentEvent: tool_call_start        │  开始调用工具
     │                                       │
     │  ← extension_ui_request               │  工具需要用户输入！
     │    { id: "abc", method: "confirm" }   │  (ask_user 工具触发)
     │                                       │
     │  展示给用户，等待回答                   │  (工具阻塞中)
     │                                       │
     │  { type: "extension_ui_response",     │
     │    id: "abc", confirmed: true }       │
     │ ──────────────────────────────────→   │  工具获得回答，继续
     │                                       │
     │  ← AgentEvent: agent_end              │  执行完成
```

### 2b. 进程管理

#### 启动 pi RPC 进程

```typescript
// RpcClient 封装了完整的进程管理
import { RpcClient } from "@mariozechner/pi-coding-agent";

const client = new RpcClient({
  cliPath: "dist/cli.js",  // 或 "pi"（全局安装时）
  cwd: "/path/to/project",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
});

await client.start();
// 内部执行：spawn("node", ["dist/cli.js", "--mode", "rpc", "--provider", "anthropic", ...])
```

**实际 spawn 命令**：

```bash
node dist/cli.js --mode rpc [--provider <name>] [--model <id>] [--cwd <dir>]
```

#### 生命周期管理

```typescript
// 启动
await client.start();

// 使用
await client.prompt("分析这个项目");
const events = await client.collectEvents(timeout);

// 停止
await client.stop();
// 内部：SIGTERM → 等 1s → SIGKILL

// 监听事件
const unsub = client.onEvent((event) => { /* 实时事件 */ });
```

#### 崩溃处理

```typescript
// RpcClient 当前实现：
// - start() 后等 100ms 检查是否立即退出
// - stop() 先 SIGTERM，1s 后 SIGKILL
// - stdin end 事件触发 shutdown

// 需要增强的部分（xyz-agent 需补充）：
process.on("exit", () => { /* 清理子进程 */ });
childProcess.on("error", (err) => { /* 启动失败 */ });
childProcess.on("exit", (code, signal) => { /* 异常退出处理 */ });
// → 可重启、可上报错误给主 Agent
```

#### 健康检查

RPC 协议本身不包含 heartbeat 机制。可通过以下方式实现：
- 定期调用 `get_state` 检查进程存活
- 监听子进程的 `exit` 事件
- 设置 `stderr` 监控（RpcClient 已收集 stderr）

### 2c. 优势

1. **完美的进程隔离**：
   - 每个 SubAgent 是独立进程，崩溃不影响主 Sidecar
   - 内存、CPU 资源自然隔离
   - 可设置 OS 级别的资源限制（rlimit、cgroup）

2. **RPC 协议设计精良**：
   - 完整的请求-响应-事件三通道协议（JSONL framing）
   - `id` 字段支持请求关联
   - `extension_ui_request/response` 原生支持交互式通信
   - 所有 `AgentEvent` 都通过 stdout 推送

3. **P6 兼容性极佳**：
   - RPC 协议天然支持主 Agent 代理 SubAgent 的用户交互
   - `extension_ui_request` ↔ `extension_ui_response` 正好对应 P6 设计中的 RPC 桥接
   - `steer` / `abort` 支持用户中断/重定向 SubAgent

4. **版本解耦**：
   - pi 作为独立二进制/包，升级不影响 Sidecar 代码
   - 只依赖 RPC 协议的稳定性（JSON 格式，向后兼容）
   - 可同时运行不同版本的 pi（不同 SubAgent 用不同版本）

5. **现有 RpcClient 可直接使用**：
   - `RpcClient` 类已经封装了 spawn、JSONL 解析、请求-响应关联
   - `promptAndWait()`、`collectEvents()` 等高级 API 开箱即用
   - `onEvent()` 支持实时事件监听

6. **符合 xyz-agent 现有架构**：
   - Rust 后端（Tauri）↔ Node.js Sidecar 已经是进程间通信
   - Sidecar ↔ pi 子进程 是同构的进程间通信模式
   - 与设计文档「树形 SubAgent 引擎 §5.3 RPC 桥接模式」完全一致

7. **无全局状态污染**：
   - pi 的 `chalk`、`process.stdout` 控制等副作用被隔离在子进程中
   - 不影响 Sidecar 的全局状态

### 2d. 劣势和风险

1. **进程启动开销**：
   - 每次创建 SubAgent 需要启动新进程（Node.js 启动 ~200ms + pi 初始化 ~500ms）
   - 频繁创建/销毁的场景需进程池优化
   - 内存占用：每个 Node.js 进程 ~30-50MB 基础 + pi 运行时

2. **IPC 序列化开销**：
   - 所有事件和响应需 JSON.stringify/parse
   - 大型消息（如长代码文件内容）序列化有延迟
   - 但 JSONL 帧协议足够简单，实际性能影响可控

3. **调试复杂度**：
   - 多进程调试更困难（需 attach 到子进程）
   - 事件流异步且跨进程，时序分析更复杂
   - 错误栈可能跨越进程边界

4. **RPC 协议覆盖度**：
   - 当前 RPC 协议覆盖了大部分常用操作
   - 但部分 `AgentSession` 方法未暴露（如 `navigateTree`、`reload`、部分 extension API）
   - 未来 pi 新增功能可能需要等待 RPC 协议更新
   - **缓解**：可通过 `get_messages` 获取完整消息，自行处理缺失功能

5. **extension_ui_request 的限制**：
   - 部分 UI 交互在 RPC 模式下不支持（`setWorkingMessage`、`setFooter`、`setHeader` 等）
   - `custom()` UI 返回 `undefined as never`（未实现）
   - 主题切换不支持
   - **但这些在 SubAgent 场景中不需要**——SubAgent 不需要完整 TUI

6. **stdin/stdout 管道限制**：
   - 大量并发 SubAgent 可能遇到 fd 限制
   - 需要仔细管理子进程的生命周期防止僵尸进程
   - Windows 上的管道行为可能不同

7. **错误传播链路长**：
   - pi 子进程崩溃 → Sidecar 检测 → Rust 后端 → 前端
   - 每一层都需正确的错误处理和状态同步

### 2e. 对未来 Phase 的影响

#### P5: Single-level SubAgent

**可行性：高**

```typescript
// 使用 RpcClient 直接实现
const subAgent = new RpcClient({ cwd: projectDir });
await subAgent.start();

const unsub = subAgent.onEvent((event) => {
  // 转发进度到 Rust 后端 → 前端
});

await subAgent.prompt("分析模块 X 的代码质量");
const events = await subAgent.collectEvents();
await subAgent.stop();
```

- 每个 SubAgent 独立进程，天然隔离
- 进度事件可通过事件流实时获取
- 完成后提取结果，关闭进程

#### P6: Recursive SubAgent with RPC Bridge

**可行性：极高 — 这是 RPC 模式的设计目的之一**

```typescript
// 主 Agent 的 subagent_interactive 工具 execute() 实现
async function executeSubAgent(task: string, ctx: ToolContext) {
  const client = new RpcClient({ cwd: projectDir });
  await client.start();

  return new Promise((resolve, reject) => {
    // 1. 流式进度 → onUpdate()
    client.onEvent((event) => {
      if (event.type === "message_update") {
        ctx.onUpdate(event);  // 展示在 TUI
      }
    });

    // 2. extension_ui_request → 代理给用户
    // RpcClient 内部 handleLine 自动分发：
    // - type "response" → pendingRequests
    // - 其他 → eventListeners
    // 需要扩展 RpcClient 或自定义 stdout 处理来拦截 extension_ui_request

    // 3. 用户中断 → steer
    ctx.signal.addEventListener("abort", () => {
      client.steer("用户要求调整方向...");
    });

    // 4. 发送任务
    client.prompt(task);
    client.waitForIdle().then(() => {
      client.getLastAssistantText().then(resolve).then(() => client.stop());
    });
  });
}
```

**需要注意**：当前 `RpcClient.handleLine()` 将非 response 的数据全部作为 `AgentEvent` 分发。`extension_ui_request` 也走这个通道，需要在 `onEvent` 中拦截并处理。这可能需要对 `RpcClient` 进行小幅扩展（或直接使用底层 JSONL 协议）。

#### 多并发 Session

**天然支持** — 每个 session 一个进程，无共享状态冲突。

#### SubAgent 进程隔离

**天然支持** — OS 级别的进程隔离，可设资源限制。

---

## 3. 对比矩阵

| 维度 | Path A: Direct SDK | Path B: Subprocess RPC |
|------|-------------------|----------------------|
| **初始化复杂度** | 高 — 5+ 依赖初始化，ResourceLoader 重文件 I/O | 低 — `RpcClient.start()` 一行启动子进程 |
| **事件获取方式** | `session.subscribe()` — 内存回调 | `client.onEvent()` — JSON 解析后回调 |
| **进程隔离** | ❌ 无 — 同进程，崩溃互相影响 | ✅ 完全 — 独立进程，OS 级隔离 |
| **SubAgent 扩展性** | ⚠️ 需自行实现隔离层 | ✅ 原生支持 — 每个子 Agent 一个进程 |
| **RPC 桥接兼容性** | ❌ 不兼容 — 需进程内重造 RPC 代理层 | ✅ 完全兼容 — 协议原生支持交互式通信 |
| **性能开销** | ✅ 低 — 无 IPC，无序列化 | ⚠️ 中 — 进程启动 ~700ms + JSON 序列化 |
| **pi 版本升级影响** | ❌ 高 — 内部 API breaking change 直接影响 | ✅ 低 — 只依赖 RPC 协议稳定性 |
| **调试难度** | ✅ 低 — 单进程，断点调试 | ⚠️ 中 — 多进程，需 attach 调试 |
| **资源占用** | ✅ 低 — 共享运行时 | ⚠️ 中 — 每进程 30-50MB + 运行时 |
| **错误处理** | ❌ 复杂 — 需 try/catch 所有 session 操作 | ✅ 清晰 — 进程退出 = 错误，response.error = 业务错误 |
| **API 完整性** | ✅ 完整 — 所有内部 API | ⚠️ 良好 — RPC 覆盖大部分操作，少数缺失 |
| **类型安全** | ✅ 完整 — TypeScript 类型 | ⚠️ 部分 — JSON 传输需类型断言 |
| **全局状态风险** | ❌ 高 — chalk/stdout/env 副作用 | ✅ 无 — 子进程隔离 |
| **Tauri 打包兼容** | ⚠️ 需验证 — WASM/native 模块 | ✅ 无影响 — pi 作为外部二进制 |

---

## 4. 推荐方案

### 结论：**推荐 Path B（Subprocess RPC）**

### 推荐理由

#### 1. 架构一致性

xyz-agent 的整体架构已经是**进程间通信**模式（Rust Tauri ↔ Node.js Sidecar）。在 Sidecar 中再启动 pi 子进程是同构的扩展，不会引入新的架构模式。而 Direct SDK 引入的**同进程 import** 是异质的，与整体架构风格不一致。

#### 2. Phase 兼容性

| Phase | Path A | Path B |
|-------|--------|--------|
| **P1**（单 Agent） | ✅ 可行 | ✅ 可行 |
| **P5**（单层 SubAgent） | ⚠️ 需自建隔离 | ✅ 天然支持 |
| **P6**（递归 SubAgent + RPC 桥接） | ❌ 需重造 RPC 代理 | ✅ 协议原生支持 |

**关键洞察**：P6 的核心难点是**交互式 SubAgent 通信**（SubAgent 运行时能 ask_user），这恰好是 RPC 模式的 `extension_ui_request/response` 协议的设计目的。选择 Path A 意味着在 P6 阶段需要**重造**这套协议，而 Path B 已经提供了完整的解决方案。

#### 3. 渐进式采用

Path B 允许**渐进式采用**，不阻塞任何 Phase：

```
P1: 单个 RpcClient → 发送 prompt → 接收事件 → 转发到 Rust → 前端
     （最小可用，无需关心 extension_ui_request）

P5: 为每个 SubAgent 启动独立 RpcClient
     （需要管理进程生命周期，但交互模型不变）

P6: 在 P5 基础上增加 extension_ui_request 代理
     （增量式扩展，无需架构变更）
```

#### 4. 风险缓解

Path B 的主要风险（进程开销）有明确的缓解策略：

| 风险 | 缓解策略 |
|------|---------|
| 进程启动延迟 | 进程池 + 预热：Sidecar 启动时预创建 1-2 个空 pi 进程 |
| 内存占用 | 限制最大并发 SubAgent 数（max_width = 10） |
| 僵尸进程 | SIGTERM + SIGKILL + exit 事件监听 + 超时兜底 |
| JSON 序列化 | 实测表明影响可忽略（pi 内部已经做 JSON 序列化） |
| RPC 覆盖度 | 缺失功能可通过 `get_messages` + 客户端逻辑补全 |

### 实施建议

#### P1 阶段（立即）

```typescript
// sidecar/src/pi-bridge.ts
import { RpcClient } from "@mariozechner/pi-coding-agent";

export class PiBridge {
  private client: RpcClient;

  async init() {
    this.client = new RpcClient({
      cwd: this.projectDir,
      env: { ANTHROPIC_API_KEY: this.apiKey },
    });
    await this.client.start();
  }

  async prompt(message: string): AsyncIterable<AgentEvent> {
    // 发送 prompt 并通过 AsyncIterable 暴露事件流
    const eventBuffer: AgentEvent[] = [];
    let resolve: (() => void);

    const unsub = this.client.onEvent((event) => {
      eventBuffer.push(event);
      resolve?.();
      if (event.type === "agent_end") unsub();
    });

    await this.client.prompt(message);

    // 返回 AsyncIterable 供 Rust 后端消费
    return (async function* () {
      while (true) {
        if (eventBuffer.length > 0) {
          yield eventBuffer.shift()!;
        }
        await new Promise<void>((r) => { resolve = r; });
      }
    })();
  }
}
```

#### P6 阶段（未来）

在 P1 的基础上扩展 `PiBridge` 以支持 `extension_ui_request` 代理：

```typescript
// 扩展：拦截 extension_ui_request，通过 Tauri event 转发到前端
client.onEvent((event) => {
  if (event.type === "extension_ui_request") {
    // 转发到前端 GUI，等待用户回答
    const answer = await invoke("ask_user", { request: event });
    // 回传给子进程
    childProcess.stdin.write(JSON.stringify({
      type: "extension_ui_response",
      id: event.id,
      ...answer,
    }) + "\n");
  }
});
```

### Path A 的保留价值

Path A **不建议作为主方案**，但有一个合理的应用场景：

**如果未来 xyz-agent 需要深度定制 pi 的内部行为**（如自定义 Agent loop、替换 LLM provider 路由、注入自定义 compaction 策略），Direct SDK 是唯一能实现的方式。但这种需求目前不在路线图上。

如果确实需要，可考虑**混合方案**：主 Agent 用 Path B（RPC），高级定制场景按需 import SDK。两者不冲突。
