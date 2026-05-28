# xyz-agent 插件系统融合设计报告 — Part 1

> 架构总览 | 进程模型 | 生命周期 | 通信协议

---

## 1. 架构总览

### 1.1 设计目标

xyz-agent 的插件系统需要同时满足三方诉求：

| 诉求 | 说明 |
|------|------|
| **安全性** | 第三方插件不能直接访问宿主进程内存、文件系统、网络。崩溃不拖垮核心 |
| **扩展性** | 插件能注册 tool、slash command、事件钩子、Settings 面板、消息装饰器等 |
| **简洁性** | 插件是一个 npm 包 + manifest，写法对标 VSCode extension 的 DX |

### 1.2 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 进程隔离 | Worker Thread（Sidecar 内部） | 比 Electron Utility Process 轻量；VSCode 教训：单进程多插件是稳定性痛点 |
| 通信协议 | JSON-RPC 2.0 over MessagePort | MessagePort 是 Node.js 原生能力，零依赖；JSON-RPC 成熟、可调试 |
| Manifest | `package.json` + `xyzAgent` 字段 | 复用 npm 生态，不发明新格式；VSCode 验证了这条路可行 |
| API 风格 | 代理对象 + `Object.freeze` | 插件拿到的 `agentAPI` 是冻结的代理，通过 RPC 转发调用 |
| 激活策略 | 声明式懒激活 | 从 `contributes` 自动推断激活事件，不加载代码即可注册声明式扩展点 |
| 权限模型 | 分级信任 | 已信任插件（完整 API）/ 未信任插件（受限 API），无沙箱内的精细权限 |

### 1.3 与 pi / VSCode 的定位对比

```
           pi Extension          VSCode Extension        xyz-agent Plugin
           ────────────          ────────────────        ─────────────────
隔离级别    无（同进程）           进程级（ExtHost）         线程级（Worker Thread）
信任模型    完全信任              Workspace Trust          分级信任
权限控制    无                    有限（声明式）            声明式 + 运行时检查
Manifest   无独立文件             package.json             package.json + xyzAgent
UI 扩展    TUI 组件 / RPC        Webview iframe           声明式 + Vue 组件 slot
通信方式    直接函数调用           JSON-RPC over MP         JSON-RPC over MP
目标用户    开发者自己             全球开发者社区            开发者 + 未来社区
复杂度      最低                  最高                     中等
```

### 1.4 架构总览图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        xyz-agent Electron App                        │
│                                                                      │
│  ┌──────────────────────────┐          ┌──────────────────────────┐ │
│  │   Renderer (Vue 3)       │  WebSocket│   Sidecar (Node.js)      │ │
│  │                          │◄────────►│                          │ │
│  │  ┌────────────────────┐  │          │  ┌────────────────────┐  │ │
│  │  │ Plugin UI Slots    │  │          │  │ PluginService      │  │ │
│  │  │ - Panel slots      │  │          │  │ (发现/加载/激活)    │  │ │
│  │  │ - Command palette  │  │          │  └────────┬───────────┘  │ │
│  │  │ - Settings slots   │  │          │           │              │ │
│  │  └────────────────────┘  │          │  ┌────────▼───────────┐  │ │
│  │                          │          │  │ PluginHost          │  │ │
│  │  ┌────────────────────┐  │          │  │ (Worker Thread 池)  │  │ │
│  │  │ ws-client.ts       │  │          │  │                     │  │ │
│  │  │ event-bus.ts       │  │          │  │  ┌───────────────┐  │  │ │
│  │  └────────────────────┘  │          │  │  │ Worker #1     │  │  │ │
│  └──────────────────────────┘          │  │  │  Plugin A     │  │  │ │
│                                         │  │  │  Plugin B     │  │  │ │
│                                         │  │  └───────┬───────┘  │  │ │
│                                         │  │          │MP+RPC    │  │ │
│                                         │  │  ┌───────▼───────┐  │  │ │
│                                         │  │  │ Worker #2     │  │  │ │
│                                         │  │  │  Plugin C     │  │  │ │
│                                         │  │  └───────────────┘  │  │ │
│                                         │  └─────────────────────┘  │ │
│                                         │                           │ │
│                                         │  ┌─────────────────────┐  │ │
│                                         │  │ 其他 Services       │  │ │
│                                         │  │ SessionService      │  │ │
│                                         │  │ ConfigService       │  │ │
│                                         │  │ ModelService        │  │ │
│                                         │  └─────────────────────┘  │ │
│                                         └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.5 PluginService 在 Sidecar 中的位置

PluginService 是 Sidecar 内的一个新 Service 模块，与现有 Service 平级：

```
Sidecar 内部架构:

server.ts (Transport)
  ├── SessionService
  ├── ConfigService
  ├── ModelService
  ├── PluginService  ← 新增
  │     ├── PluginRegistry      (manifest 解析、发现)
  │     ├── PluginHost          (Worker Thread 池管理)
  │     ├── PluginActivator     (懒激活逻辑)
  │     └── PluginAPIProvider   (agentAPI 代理对象工厂)
  └── ProcessManager
```

### 1.6 核心 TypeScript Interface

```typescript
/** 插件 manifest 中 xyzAgent 字段的类型 */
interface XyzAgentManifest {
  /** manifest schema 版本，为未来 breaking change 留口 */
  manifestVersion: 1;

  /** 插件入口文件（相对于 package.json） */
  main: string;

  /** 兼容的 xyz-agent 版本范围 */
  engines: {
    'xyz-agent': string; // semver range，如 "^1.0.0"
  };

  /** 声明式扩展点——不加载代码即可注册 */
  contributes?: PluginContributes;

  /** 激活事件声明。可省略，从 contributes 自动推断 */
  activationEvents?: ActivationEvent[];

  /** 需要的权限声明 */
  permissions?: PluginPermission[];

  /** 信任等级要求：trusted = 完整 API，untrusted = 受限 API */
  trustLevel?: 'trusted' | 'untrusted';
}

/** 声明式扩展点 */
interface PluginContributes {
  slashCommands?: SlashCommandContribution[];
  tools?: ToolContribution[];
  settings?: SettingContribution[];
  hooks?: HookContribution[];
  panels?: PanelContribution[];
  messageDecorators?: MessageDecoratorContribution[];
}

/** 插件贡献的 slash command */
interface SlashCommandContribution {
  name: string;           // 如 "search"
  description: string;
  /** 参数 schema（JSON Schema） */
  parameters?: Record<string, unknown>;
}

/** 插件贡献的 tool（LLM 可调用） */
interface ToolContribution {
  name: string;
  description: string;
  /** JSON Schema 描述 tool 参数 */
  inputSchema: Record<string, unknown>;
}

/** 插件贡献的 Settings 项 */
interface SettingContribution {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  default: unknown;
  description: string;
  options?: string[]; // type=select 时的可选项
}

/** 事件钩子 */
interface HookContribution {
  event: string;          // 如 "message:beforeSend", "tool:beforeCall"
  description: string;
}

/** 面板扩展 */
interface PanelContribution {
  id: string;
  title: string;
  /** 面板位置 */
  location: 'sidebar' | 'panel';
  icon?: string;
}

/** 消息装饰器 */
interface MessageDecoratorContribution {
  type: string;           // 匹配的消息类型
  description: string;
}

/** 激活事件类型 */
type ActivationEvent =
  | { type: 'onSlashCommand'; command: string }
  | { type: 'onToolCall'; tool: string }
  | { type: 'onSessionCreate' }
  | { type: 'onWorkspaceOpen' }
  | { type: 'onStartupFinished' };

/** 权限声明 */
type PluginPermission =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'network'
  | 'shell'
  | 'clipboard'
  | 'notifications';
```

---

## 2. 进程模型

### 2.1 设计决策：Worker Thread 隔离

**选择**：插件运行在 Sidecar 进程内的 Worker Thread 中，而非独立子进程。

**理由**：

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 同进程（pi 模式） | 零开销、直接调用 | 崩溃即全挂、无安全边界 | 排除 |
| 独立子进程（VSCode 模式） | 完全隔离、可远程 | 每个进程 30-50MB、IPC 序列化开销大 | 过度 |
| **Worker Thread** | 内存共享（低成本）、MessagePort 原生支持、崩溃可捕获 | 不如进程隔离彻底、不支持多 Node 实例 | **采用** |

Worker Thread 的关键优势：
- 创建成本约 5-10MB（vs 子进程 30-50MB）
- `MessagePort` 是 Node.js 原生能力，不需要额外传输层
- `worker.terminate()` 可强制回收崩溃的插件
- 共享 `structuredClone` 序列化，比 IPC 的 JSON.stringify 更高效

### 2.2 Worker 分组策略

借鉴 VSCode "单进程多扩展"的教训，xyz-agent 采用**按信任等级分组**的 Worker 池：

```
┌─────────────────────────────────────────────────────┐
│                   Sidecar 主线程                      │
│                                                      │
│  PluginHost                                          │
│  ┌────────────────────────────────────────────────┐  │
│  │                                                 │  │
│  │  Worker #1 (trusted pool)                      │  │
│  │  ┌──────────────┐  ┌──────────────┐            │  │
│  │  │ Plugin A     │  │ Plugin B     │            │  │
│  │  │ (官方/已审核) │  │ (官方/已审核) │            │  │
│  │  └──────────────┘  └──────────────┘            │  │
│  │                                                 │  │
│  │  Worker #2 (sandbox pool)                      │  │
│  │  ┌──────────────┐                              │  │
│  │  │ Plugin C     │  每个 Worker 只装一个未信任插件 │  │
│  │  │ (第三方)      │  崩溃只影响自己               │  │
│  │  └──────────────┘                              │  │
│  │                                                 │  │
│  │  Worker #3 (sandbox pool)                      │  │
│  │  ┌──────────────┐                              │  │
│  │  │ Plugin D     │                              │  │
│  │  │ (第三方)      │                              │  │
│  │  └──────────────┘                              │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

分组规则：

| 信任等级 | 共享方式 | API 权限 | 崩溃影响 |
|---------|---------|---------|---------|
| `trusted` | 多个插件共享一个 Worker | 完整 agentAPI | 同 Worker 内所有 trusted 插件 |
| `untrusted` | 每个 Worker 一个插件 | 受限 agentAPI（无 shell、无文件系统写） | 仅自身 |

### 2.3 与 pi / VSCode 的进程模型对比

```
pi:      [Extension A, B, C] ←── 同一进程，零隔离
VSCode:  [Extension A, B, C, ...全部] ←── 同一 ExtHost 进程，一个崩全崩
xyz-agent:
         [Plugin A, B] ←── trusted Worker（共享，但都是可信的）
         [Plugin C]    ←── sandbox Worker #1
         [Plugin D]    ←── sandbox Worker #2
```

**xyz-agent 比 VSCode 更激进的地方**：未信任插件各自独占 Worker，牺牲了一些内存效率，换取更好的崩溃隔离。

### 2.4 进程模型 Interface

```typescript
interface WorkerPoolConfig {
  /** trusted 插件共享的 Worker 数量（默认 1） */
  trustedWorkers: number;
  /** 单个 trusted Worker 最多承载的插件数（默认 10） */
  trustedWorkerCapacity: number;
  /** 未信任插件是否各自独占 Worker（默认 true） */
  sandboxIsolation: boolean;
  /** Worker 空闲超时（ms），超时后 terminate（默认 60000） */
  idleTimeout: number;
}

interface WorkerHandle {
  workerId: string;
  threadId: number;
  trustLevel: 'trusted' | 'sandbox';
  /** 该 Worker 中已加载的插件 ID 列表 */
  pluginIds: string[];
  /** Worker 状态 */
  status: 'idle' | 'active' | 'crashed' | 'terminated';
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 内存使用（bytes），通过 worker.threadId 查询 */
  memoryUsage?: number;
}

interface PluginHost {
  /** 初始化 Worker 池 */
  initialize(config: WorkerPoolConfig): Promise<void>;
  /** 为插件分配 Worker（复用或新建） */
  assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<WorkerHandle>;
  /** 向指定 Worker 加载插件 */
  loadPlugin(workerId: string, pluginPath: string): Promise<void>;
  /** 激活插件 */
  activatePlugin(pluginId: string, event: ActivationEvent): Promise<void>;
  /** 停用插件 */
  deactivatePlugin(pluginId: string): Promise<void>;
  /** 终止指定 Worker（崩溃恢复） */
  terminateWorker(workerId: string): Promise<void>;
  /** 获取所有 Worker 状态 */
  getWorkerStatuses(): WorkerHandle[];
  /** 关闭所有 Worker */
  shutdown(): Promise<void>;
}
```

### 2.5 崩溃恢复流程

```
Worker 崩溃
  │
  ├─ worker.on('error') 触发
  │
  ├─ PluginHost 标记 Worker 状态为 'crashed'
  │
  ├─ 通知 PluginService → 通知前端（event-bus）
  │     "plugin:crashed" { pluginIds: [...], reason: "..." }
  │
  ├─ 自动恢复策略:
  │     ├─ trusted Worker → 新建 Worker，重新加载所有 trusted 插件
  │     └─ sandbox Worker → 等待下次激活时重建
  │
  └─ 记录崩溃日志（插件 ID、错误栈、内存快照）
```

---

## 3. 生命周期

### 3.1 设计决策：三阶段生命周期 + 懒激活

借鉴 pi 的两阶段（注册 → 绑定）和 VSCode 的懒激活（activation events），xyz-agent 采用三阶段：

```
┌───────────────────────────────────────────────────────────────────┐
│                        插件生命周期                                │
│                                                                    │
│  Phase 1: DISCOVER                                                │
│  ┌─────────────────┐                                              │
│  │ 扫描插件目录     │  不加载代码，只读 package.json 的 xyzAgent 字段  │
│  │ 解析 manifest    │  注册声明式扩展点（slash commands / tools 等）  │
│  │ 验证版本兼容     │  建立 pluginId → manifest 映射                │
│  └────────┬────────┘                                              │
│           │                                                        │
│  Phase 2: ACTIVATE (lazy)                                         │
│  ┌─────────────────┐                                              │
│  │ 触发激活事件     │  如：用户输入 /search → 匹配 onSlashCommand    │
│  │ 分配 Worker      │  trusted → 共享 Worker; sandbox → 独占       │
│  │ 加载入口模块     │  worker 中 import() 插件入口                   │
│  │ 调用 activate()  │  插件注册运行时能力（事件监听、动态 tool 等）   │
│  │ 注入 agentAPI    │  绑定真实的 RPC 代理                          │
│  └────────┬────────┘                                              │
│           │                                                        │
│  Phase 3: DEACTIVATE                                              │
│  ┌─────────────────┐                                              │
│  │ 调用 deactivate()│  插件清理资源                                 │
│  │ dispose subs     │  自动 dispose 所有 subscriptions              │
│  │ 卸载模块         │  worker.terminate()（sandbox）或保留（trusted） │
│  └─────────────────┘                                              │
└───────────────────────────────────────────────────────────────────┘
```

### 3.2 与 pi / VSCode 的生命周期对比

| 阶段 | pi | VSCode | xyz-agent |
|------|-----|--------|-----------|
| **发现** | CLI 启动时扫描目录 | 启动时读所有 `package.json` | 启动时扫描目录，解析 manifest |
| **注册** | 工厂函数调用（立即） | 声明式注册（不加载代码） | **声明式注册（不加载代码）** |
| **激活** | 无懒激活，全部启动 | activation events 按需 | **activation events 按需** |
| **绑定** | `bindCore()` 注入真实实现 | `activate()` 获取真实 context | **`activate()` 注入 agentAPI** |
| **运行** | 同进程，handler 直接调用 | ExtHost 内，通过 RPC | Worker 内，通过 MessagePort RPC |
| **停用** | `invalidate()` 标记 stale | `deactivate()` + dispose | **`deactivate()` + dispose** |

**关键区别**：pi 没有懒激活（所有 extension 在启动时加载），xyz-agent 和 VSCode 一样支持按需激活，减少启动时的资源消耗。

### 3.3 激活事件设计

xyz-agent 支持以下激活事件：

```typescript
type ActivationEvent =
  | { type: 'onSlashCommand'; command: string }    // 用户输入匹配的 slash 命令
  | { type: 'onToolCall'; tool: string }           // LLM 调用匹配的 tool
  | { type: 'onHook'; event: string }              // 匹配的事件钩子被触发
  | { type: 'onSessionCreate' }                    // 新 session 创建时
  | { type: 'onWorkspaceOpen' }                    // 工作区打开时
  | { type: 'onStartupFinished' };                 // 所有启动完成后
```

**自动推断规则**（从 `contributes` 推断，无需手动声明 `activationEvents`）：

```typescript
function inferActivationEvents(contributes: PluginContributes): ActivationEvent[] {
  const events: ActivationEvent[] = [];

  // slash commands → onSlashCommand
  for (const cmd of contributes.slashCommands ?? []) {
    events.push({ type: 'onSlashCommand', command: cmd.name });
  }

  // tools → onToolCall
  for (const tool of contributes.tools ?? []) {
    events.push({ type: 'onToolCall', tool: tool.name });
  }

  // hooks → onHook
  for (const hook of contributes.hooks ?? []) {
    events.push({ type: 'onHook', event: hook.event });
  }

  // panels → onStartupFinished（面板需要在启动后渲染）
  if ((contributes.panels ?? []).length > 0) {
    events.push({ type: 'onStartupFinished' });
  }

  return events;
}
```

### 3.4 生命周期 Interface

```typescript
/** 插件入口函数签名（对标 VSCode 的 activate/deactivate） */
interface PluginModule {
  /**
   * 激活插件。首次被需要时调用。
   * 返回 void 或 Promise<void>。
   */
  activate(context: PluginContext): void | Promise<void>;

  /**
   * 停用插件。插件被禁用、卸载、应用关闭时调用。
   * 用于清理资源（如果不手动清理，subscriptions 中的资源会被自动 dispose）。
   */
  deactivate?(): void | Promise<void>;
}

/** 插件运行时上下文（对标 VSCode ExtensionContext） */
interface PluginContext {
  /** 插件唯一 ID（publisher.name） */
  readonly pluginId: string;

  /** 插件安装路径 */
  readonly extensionPath: string;

  /** 插件可用的 API 代理（冻结对象） */
  readonly api: AgentAPI;

  /** 全局 KV 存储（跨 workspace 持久化） */
  readonly globalState: PluginStateStorage;

  /** 工作区 KV 存储（当前 workspace 持久化） */
  readonly workspaceState: PluginStateStorage;

  /** 插件专属存储路径（文件持久化） */
  readonly storageUri: string;

  /** 插件专属临时路径（应用关闭时可清理） */
  readonly storageTempPath: string;

  /**
   * 资源订阅列表。
   * 插件注册的 Disposable 对象放入此数组，
   * deactivate 时自动 dispose 全部。
   */
  readonly subscriptions: Disposable[];
}

/** KV 持久化接口 */
interface PluginStateStorage {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  set(key: string, value: unknown): Thenable<void>;
  delete(key: string): Thenable<void>;
  keys(): readonly string[];
}

/** 可清理资源（对标 VSCode Disposable） */
interface Disposable {
  dispose(): void;
}

/**
 * 事件订阅器（工厂模式，对标 VSCode Event<T>）。
 * 调用返回的 Disposable 可取消订阅。
 */
interface Event<T> {
  (listener: (e: T) => unknown): Disposable;
}
```

### 3.5 生命周期状态机

```
                  ┌──────────┐
                  │ UNLOADED │  启动时：扫描 manifest，不加载代码
                  └────┬─────┘
                       │ activation event 触发
                       ▼
                  ┌──────────┐
         ┌───────│ LOADING  │  分配 Worker，import() 入口模块
         │       └────┬─────┘
         │ 加载失败     │ 模块加载成功
         │            ▼
         │       ┌──────────┐
         │       │ACTIVATING│  调用 activate(context)，注入 agentAPI
         │       └────┬─────┘
         │            │ activate() 完成
         │            ▼
         │       ┌──────────┐
         │       │  ACTIVE  │  正常运行，响应事件/RPC
         │       └────┬─────┘
         │            │ deactivate 触发（禁用/卸载/关闭）
         │            ▼
         │       ┌────────────┐
         │       │DEACTIVATING│  调用 deactivate()，dispose subscriptions
         │       └─────┬──────┘
         │             │ 清理完成
         │             ▼
         │       ┌──────────┐
         └──────►│ UNLOADED │  可重新激活
                 └──────────┘

         特殊路径:
         ┌──────────┐
         │  CRASHED │  Worker 崩溃，自动恢复或等待下次激活
         └──────────┘
```

### 3.6 发现（Discovery）路径

与 pi 的三层发现类似，xyz-agent 支持三层 + Settings 配置：

```
┌────────────────────────────────────────────────────────────────┐
│                    插件发现路径                                  │
│                                                                 │
│  Layer 1: 用户级                                                │
│  ~/.xyz-agent/plugins/                                          │
│  全局可用，跨项目                                                │
│                                                                 │
│  Layer 2: 项目级                                                │
│  <project>/.xyz-agent/plugins/                                  │
│  项目本地，跟随 git（开发者协作时共享插件配置）                     │
│                                                                 │
│  Layer 3: Settings 配置                                         │
│  Settings → Plugins → 已安装列表                                 │
│  支持手动添加路径、启用/禁用、配置信任等级                         │
│                                                                 │
│  发现规则（与 pi 一致）:                                         │
│  ├── <dir>/package.json + xyzAgent 字段 → 标准 manifest         │
│  ├── <dir>/index.ts 或 index.js → 无 manifest，尝试加载          │
│  └── <file>.ts 或 .js → 单文件插件                               │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. 通信协议

### 4.1 设计决策：JSON-RPC 2.0 over MessagePort

**选择**：Worker Thread 与 Sidecar 主线程通过 `MessagePort` + JSON-RPC 2.0 通信。

**理由**：

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 直接 `postMessage` | 最简单 | 无类型安全、无请求-响应关联、无错误传播 | 排除 |
| **JSON-RPC over MessagePort** | 标准、可调试、有请求-响应、有错误码 | 比 postMessage 略重 | **采用** |
| vscode-jsonrpc 库 | 成熟、类型安全 | 引入重依赖、API 偏 VSCode 场景 | 过度 |

自实现 JSON-RPC 层只需约 200 行代码（请求-响应映射 + 通知广播），比引入第三方库更可控。

### 4.2 通信架构图

```
┌────────────────────────────────────────────────────────────────────┐
│                        Sidecar 主线程                               │
│                                                                     │
│  PluginService                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  JSON-RPC Dispatcher                                        │   │
│  │  ┌────────────────┐  ┌────────────────┐                      │   │
│  │  │ 请求路由        │  │ 响应等待 map    │                      │   │
│  │  │ method → handler│  │ id → resolve   │                      │   │
│  │  └────────────────┘  └────────────────┘                      │   │
│  │                                                              │   │
│  │  注册的 RPC 方法（主线程侧）:                                  │   │
│  │  ├── "session.list"           → SessionService               │   │
│  │  ├── "session.sendMessage"    → SessionService               │   │
│  │  ├── "tool.execute"           → SessionService               │   │
│  │  ├── "config.get"             → ConfigService                │   │
│  │  ├── "config.set"             → ConfigService                │   │
│  │  ├── "model.list"             → ModelService                 │   │
│  │  ├── "storage.get"            → PluginStorage                 │   │
│  │  ├── "storage.set"            → PluginStorage                 │   │
│  │  └── "plugin.notify"          → event-bus → Renderer         │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                              │ MessagePort                           │
│                              │ (worker.parentPort)                  │
│  ┌──────────────────────────▼───────────────────────────────────┐   │
│  │  Worker Thread                                                 │   │
│  │                                                                │   │
│  │  ┌──────────────────────────────────────────────────────────┐ │   │
│  │  │ agentAPI 代理层                                         │ │   │
│  │  │                                                          │ │   │
│  │  │  api.sessions.list()        → JSON-RPC request           │ │   │
│  │  │  api.sessions.sendMessage() → JSON-RPC request           │ │   │
│  │  │  api.tools.register()       → JSON-RPC notification      │ │   │
│  │  │  api.events.on("msg", fn)   → JSON-RPC notification      │ │   │
│  │  │                                + 本地 listener map        │ │   │
│  │  └──────────────────────────────────────────────────────────┘ │   │
│  │                                                                │   │
│  │  ┌──────────────────────────────────────────────────────────┐ │   │
│  │  │ Plugin 代码                                              │ │   │
│  │  │  只能通过 agentAPI 代理与外部通信                          │ │   │
│  │  │  不能直接 require('fs')、process.env 等（sandbox 模式）    │ │   │
│  │  └──────────────────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘

                          │
                          │ WebSocket (已有)
                          ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Renderer (Vue 3)                             │
│                                                                     │
│  ws-client.ts                                                       │
│  ├── 接收 "plugin:notification" 消息 → 渲染插件 UI                  │
│  ├── 接收 "plugin:crashed" 消息 → 显示错误提示                      │
│  └── 接收 "plugin:panel" 消息 → 渲染插件面板 slot                   │
└────────────────────────────────────────────────────────────────────┘
```

### 4.3 JSON-RPC 消息格式

遵循 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 规范：

**请求（Request）—— 从 Worker 到主线程**：
```typescript
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;          // 自增 ID，用于关联响应
  method: string;      // 如 "session.sendMessage"
  params: Record<string, unknown>; // 方法参数
}
```

**响应（Response）—— 主线程回复 Worker**：
```typescript
interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number;          // 对应请求的 ID
  result: unknown;     // 方法返回值
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: {
    code: number;      // JSON-RPC 错误码或自定义错误码
    message: string;
    data?: unknown;    // 附加错误信息
  };
}
```

**通知（Notification）—— 双向，无需响应**：
```typescript
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;      // 如 "plugin.toolRegistered", "plugin.eventFired"
  params: Record<string, unknown>;
}
```

### 4.4 通信 Interface

```typescript
/** Worker 侧的 RPC 客户端（在 Worker Thread 内运行） */
interface PluginRpcClient {
  /** 发送 RPC 请求并等待响应 */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;

  /** 发送 RPC 通知（不等响应） */
  notify(method: string, params: Record<string, unknown>): void;

  /** 注册通知处理函数（主线程推送过来的通知） */
  onNotification(method: string, handler: (params: Record<string, unknown>) => void): Disposable;

  /** 销毁客户端，清理所有 handler */
  dispose(): void;
}

/** 主线程侧的 RPC 方法注册表 */
interface PluginRpcServer {
  /** 注册主线程暴露给插件的 RPC 方法 */
  registerMethod(method: string, handler: RpcMethodHandler): void;

  /** 向指定 Worker 推送通知 */
  notify(workerId: string, method: string, params: Record<string, unknown>): void;

  /** 向所有活跃 Worker 广播通知 */
  broadcast(method: string, params: Record<string, unknown>): void;
}

type RpcMethodHandler = (
  pluginId: string,
  params: Record<string, unknown>
) => Promise<unknown>;
```

### 4.5 agentAPI 代理对象

插件通过 `context.api` 访问宿主能力。这个对象在 Worker 内创建，是冻结的代理：

```typescript
/**
 * agentAPI — 插件可用的宿主 API 代理。
 * 所有方法都通过 JSON-RPC 转发到主线程，因此全部是异步的。
 * Object.freeze 防止插件篡改。
 */
interface AgentAPI {
  /** Session 相关操作 */
  readonly sessions: {
    list(): Promise<SessionInfo[]>;
    get(sessionId: string): Promise<SessionInfo | undefined>;
    sendMessage(params: { sessionId: string; content: string }): Promise<void>;
    onDidCreateSession: Event<SessionInfo>;
    onDidDestroySession: Event<string>;
  };

  /** Tool 注册与管理 */
  readonly tools: {
    register(tool: RuntimeToolRegistration): Disposable;
    list(): Promise<ToolInfo[]>;
  };

  /** Slash Command 注册 */
  readonly slashCommands: {
    register(command: RuntimeCommandRegistration): Disposable;
  };

  /** 事件钩子 */
  readonly hooks: {
    /** 消息发送前，可修改或拦截 */
    onBeforeSendMessage(handler: MessageHookHandler): Disposable;
    /** Tool 调用前，可修改参数或阻止 */
    onBeforeToolCall(handler: ToolCallHookHandler): Disposable;
    /** Tool 返回后，可修改结果 */
    onAfterToolResult(handler: ToolResultHookHandler): Disposable;
  };

  /** 存储操作（代理到 PluginStorage） */
  readonly storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };

  /** 配置读取 */
  readonly config: {
    get<T>(key: string): Promise<T | undefined>;
  };

  /** 通知（显示在前端 UI 上） */
  readonly notify: {
    info(message: string): Promise<void>;
    warning(message: string): Promise<void>;
    error(message: string): Promise<void>;
  };

  /** 扩展间通信 */
  readonly events: {
    on(event: string, handler: (data: unknown) => void): Disposable;
    emit(event: string, data: unknown): void;
  };
}

/** 运行时 Tool 注册（在 activate() 中动态注册） */
interface RuntimeToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

/** 运行时 Slash Command 注册 */
interface RuntimeCommandRegistration {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<CommandResult>;
}

/** Tool 执行结果 */
interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

/** Command 执行结果 */
interface CommandResult {
  success: boolean;
  data: unknown;
  error?: string;
}

/** 消息钩子处理结果 */
interface MessageHookResult {
  /** true = 拦截该消息，不继续传递 */
  blocked?: boolean;
  /** 替换后的消息内容 */
  transformed?: string;
}

type MessageHookHandler = (message: { content: string; sessionId: string }) =>
  MessageHookResult | Promise<MessageHookResult>;

type ToolCallHookHandler = (call: { tool: string; params: Record<string, unknown> }) =>
  { blocked?: boolean; transformedParams?: Record<string, unknown> } |
  Promise<{ blocked?: boolean; transformedParams?: Record<string, unknown> }>;

type ToolResultHookHandler = (result: { tool: string; output: unknown }) =>
  { transformedOutput?: unknown } |
  Promise<{ transformedOutput?: unknown }>;
```

### 4.6 通信流程示例

**场景：LLM 调用插件注册的 Tool**

```
  pi 子进程            Sidecar 主线程              Worker Thread           Plugin 代码
      │                     │                         │                      │
      │  tool_call          │                         │                      │
      │  {name:"webSearch"} │                         │                      │
      │────────────────────►│                         │                      │
      │                     │  JSON-RPC notification  │                      │
      │                     │  "hooks.onBeforeToolCall"│                     │
      │                     │────────────────────────►│                      │
      │                     │                         │  触发 hook handler   │
      │                     │                         │─────────────────────►│
      │                     │                         │  ◄───────────────────│
      │                     │  ◄──────────────────────│  hook result         │
      │                     │  (not blocked)          │                      │
      │                     │                         │                      │
      │                     │  JSON-RPC request       │                      │
      │                     │  "tool.execute"         │                      │
      │                     │────────────────────────►│                      │
      │                     │                         │  plugin.tool.execute()│
      │                     │                         │─────────────────────►│
      │                     │                         │  ◄───────────────────│
      │                     │  ◄──────────────────────│  tool result         │
      │                     │  JSON-RPC response      │                      │
      │  tool_result        │                         │                      │
      │◄────────────────────│                         │                      │
      │                     │                         │                      │
```

### 4.7 与 pi / VSCode 的通信对比

| 维度 | pi | VSCode | xyz-agent |
|------|-----|--------|-----------|
| **协议** | 无（直接函数调用） | JSON-RPC 2.0 | JSON-RPC 2.0 |
| **传输层** | 内存（同进程） | MessagePort / WebSocket | MessagePort |
| **API 调用方式** | `pi.on()` / `pi.registerTool()` 直接调用 | `vscode.commands.*()` 代理 → RPC | `api.tools.*()` 代理 → RPC |
| **序列化** | 无 | JSON-RPC 序列化 | JSON-RPC 序列化 |
| **异步性** | 部分同步、部分异步 | 全部异步（Thenable/Promise） | **全部异步（Promise）** |
| **事件通知** | 直接 handler 调用 | RPC notification | RPC notification |
| **错误传播** | throw Error（同步） | RPC error response | RPC error response |
| **可调试性** | console.log | DevTools + RPC log | Worker console + RPC log |

**关键区别**：
- pi 零序列化开销，但牺牲了隔离性
- VSCode 和 xyz-agent 都选择了 JSON-RPC，但 xyz-agent 的传输层更简单（只有 MessagePort，没有 WebSocket 远程场景）

### 4.8 错误码定义

```typescript
/** 自定义 JSON-RPC 错误码（-32000 ~ -32099 为自定义范围） */
const PluginRpcErrorCodes = {
  // 权限相关
  PERMISSION_DENIED: -32001,       // 插件无权调用该方法
  TRUST_LEVEL_REQUIRED: -32002,    // 需要 trusted 级别才能调用

  // 资源相关
  PLUGIN_NOT_FOUND: -32010,        // 插件未找到
  PLUGIN_NOT_ACTIVE: -32011,       // 插件未激活
  SESSION_NOT_FOUND: -32012,       // Session 不存在
  TOOL_NOT_FOUND: -32013,          // Tool 不存在

  // 限制相关
  RATE_LIMITED: -32020,            // 调用频率超限
  PAYLOAD_TOO_LARGE: -32021,       // 消息体过大

  // 执行相关
  TOOL_EXECUTION_FAILED: -32030,   // Tool 执行失败
  HOOK_HANDLER_ERROR: -32031,      // 钩子处理函数抛出异常
  ACTIVATION_FAILED: -32032,       // 插件激活失败
} as const;
```

---

## 附录：设计原则总结

| # | 原则 | 来源 | xyz-agent 实践 |
|---|------|------|---------------|
| 1 | 进程隔离 | VSCode 教训 | Worker Thread 隔离，sandbox 独占 |
| 2 | 懒激活 | VSCode 最佳实践 | activation events + 自动推断 |
| 3 | API 最小暴露 | VSCode 教训（API 一旦发布无法收回） | 分层 API + agentAPI 冻结代理 |
| 4 | 声明式优先 | VSCode 最佳实践 | manifest contributes 不加载代码即可注册 |
| 5 | 全部异步 | 进程隔离的基本要求 | 所有跨 Worker API 返回 Promise |
| 6 | 自动清理 | VSCode Disposable 模式 | context.subscriptions + deactivate() |
| 7 | 崩溃恢复 | VSCode ExtHost 痛点 | Worker crash → 自动重建 |
| 8 | 数据隔离 | VSCode 扩展间隔离 | 每个 pluginId 独立 storage namespace |
| 9 | 可观测性 | VSCode ExtHost Profiler | Worker 状态监控 + RPC 日志 |
| 10 | 向前兼容 | VSCode 教训 | manifestVersion 字段 + semver engines |
