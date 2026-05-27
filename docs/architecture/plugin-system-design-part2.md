# xyz-agent 插件系统融合设计报告 — Part 2

> Manifest 格式 | API 设计 | 扩展点体系 | 安全模型 | 持久化 | 分发机制

---

## 1. Manifest 格式

### 1.1 设计决策：复用 npm package.json

xyz-agent 不发明新的 manifest 格式。插件就是一个标准的 npm 包，在 `package.json` 中通过 `xyzAgent` 字段声明插件信息。这是 VSCode 验证过的路径——10 年来没有开发者抱怨 `package.json` 做 manifest 有什么问题。

### 1.2 完整 Manifest Schema

```typescript
/**
 * package.json 中的 xyzAgent 字段定义。
 * 该字段下的所有内容由 xyz-agent 解析，npm 侧不感知。
 */
interface XyzAgentManifest {
  /** Manifest schema 版本号。当前必须为 1。为未来 breaking change 预留 */
  manifestVersion: 1;

  /** 插件入口文件路径，相对于 package.json 所在目录 */
  main: string;

  /** 兼容的 xyz-agent 版本范围（semver） */
  engines: {
    'xyz-agent': string;  // 如 "^1.0.0"、">=1.2.0 <2.0.0"
  };

  /** 声明式扩展点 —— 不加载代码即可注册 */
  contributes?: PluginContributes;

  /**
   * 激活事件声明。
   * 可省略。省略时自动从 contributes 推断。
   * 手动声明的优先级高于自动推断，可用于声明 contributes 无法推断的事件。
   */
  activationEvents?: ActivationEvent[];

  /** 需要的权限声明（trusted 插件可省略，默认授予全部权限） */
  permissions?: PluginPermission[];

  /**
   * 信任等级要求。
   * - trusted: 内置或经审核的插件，授予完整 API 权限
   * - untrusted: 第三方插件，受限 API + 独占 Worker
   * 默认值：untrusted
   */
  trustLevel?: 'trusted' | 'untrusted';

  /** 是否允许在工作区未信任模式下运行（默认 false） */
  allowUntrustedWorkspace?: boolean;
}

/** 声明式扩展点 */
interface PluginContributes {
  /** Slash 命令注册 */
  slashCommands?: SlashCommandContribution[];
  /** AI 工具注册 */
  tools?: ToolContribution[];
  /** 配置项贡献 */
  settings?: SettingContribution[];
  /** 事件钩子声明 */
  hooks?: HookContribution[];
  /** 面板贡献 */
  panels?: PanelContribution[];
  /** 消息装饰器 */
  messageDecorators?: MessageDecoratorContribution[];
  /** 状态栏项 */
  statusBarItems?: StatusBarItemContribution[];
}
```

### 1.3 扩展点 Schema

```typescript
interface SlashCommandContribution {
  /** 命令名（不含 / 前缀），如 "search" → 用户输入 "/search" */
  name: string;
  /** 简短描述，显示在 SlashMenu 中 */
  description: string;
  /** 参数 schema（JSON Schema draft-07），可选 */
  parameters?: JsonSchema;
}

interface ToolContribution {
  /** Tool 名称，LLM 通过此名称调用 */
  name: string;
  /** Tool 描述，LLM 根据此描述决策是否调用 */
  description: string;
  /** 参数 schema（JSON Schema draft-07），LLM 据此构造参数 */
  inputSchema: JsonSchema;
}

interface SettingContribution {
  /**
   * 配置键名。点号分层，如 "myPlugin.search.maxResults"。
   * plugin 的名称空间自动添加前缀：`plugin.${pluginId}.`
   */
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'color' | 'path';
  default: unknown;
  description: string;
  /** type=select 时的可选项 */
  options?: string[];
  /** 取值范围（number 类型） */
  range?: { min: number; max: number };
  /** 是否需要重启生效 */
  requiresRestart?: boolean;
}

interface HookContribution {
  /** 钩子事件名，如 "message:beforeSend"、"tool:beforeCall" */
  event: HookEventName;
  /** 简短描述 */
  description: string;
}

interface PanelContribution {
  /** 唯一标识 */
  id: string;
  /** 面板标题 */
  title: string;
  /** 面板位置 */
  location: 'sidebar' | 'drawer' | 'panel';
  /** 图标键名（来自 xyz-ui 图标库） */
  icon?: string;
  /** 初始大小 */
  initialSize?: 'compact' | 'normal' | 'expanded';
}

interface StatusBarItemContribution {
  /** 唯一标识 */
  id: string;
  /** 对齐侧 */
  alignment: 'left' | 'right';
  /** 优先级（同 alignment 内排序，数字越大越靠外） */
  priority: number;
  /** 默认文本 */
  text: string;
  /** 默认 tooltip */
  tooltip?: string;
}

interface MessageDecoratorContribution {
  /** 匹配的消息类型：assistant | tool_call | system */
  messageType: string;
  /** 简短描述，在插件管理界面展示 */
  description: string;
}

/** 激活事件类型 */
type ActivationEvent =
  | { type: 'onSlashCommand'; command: string }
  | { type: 'onToolCall'; tool: string }
  | { type: 'onHook'; event: HookEventName }
  | { type: 'onSessionCreate' }
  | { type: 'onWorkspaceOpen' }
  | { type: 'onStartupFinished' }
  | { type: 'onLanguage'; language: string };  // 预留：按语言激活

/** 钩子事件名枚举 —— 从 pi 的 30+ 事件中筛选出插件可监听的子集 */
type HookEventName =
  // Session
  | 'session:created'
  | 'session:beforeDestroy'
  | 'session:afterSwitch'
  // Message
  | 'message:beforeSend'        // 消息发送前，可修改内容
  | 'message:afterSend'         // 消息发送后
  | 'message:afterResponse'     // LLM 响应到达后
  // Tool
  | 'tool:beforeCall'           // Tool 调用前，可修改参数或阻止
  | 'tool:afterCall'           // Tool 调用后，可修改结果
  // Model
  | 'model:changed'
  // Pi 事件桥接（只读，不可拦截）
  | 'pi:agentStart'
  | 'pi:agentEnd'
  | 'pi:toolExecutionStart'
  | 'pi:toolExecutionEnd';

/** 插件权限声明 */
type PluginPermission =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'network'
  | 'shell:execute'
  | 'clipboard:read'
  | 'clipboard:write'
  | 'notifications'
  | 'sessions:read'
  | 'sessions:write'
  | 'tools:register'
  | 'settings:write';

/** JSON Schema 类型（简化版，仅支持插件系统需要的字段） */
interface JsonSchema {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
}
```

### 1.4 Manifest 示例

```json
{
  "name": "xyz-plugin-web-search",
  "version": "1.0.0",
  "description": "Web search plugin for xyz-agent",
  "displayName": "Web Search",
  "publisher": "example",
  "icon": "icon.png",
  "xyzAgent": {
    "manifestVersion": 1,
    "main": "./dist/index.js",
    "engines": {
      "xyz-agent": "^1.0.0"
    },
    "contributes": {
      "slashCommands": [
        {
          "name": "search",
          "description": "Search the web",
          "parameters": {
            "type": "object",
            "properties": {
              "query": {
                "type": "string",
                "description": "Search query"
              }
            },
            "required": ["query"]
          }
        }
      ],
      "tools": [
        {
          "name": "webSearch",
          "description": "Search the web for information. Returns top results with title, URL, and snippet.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "query": {
                "type": "string",
                "description": "The search query"
              },
              "maxResults": {
                "type": "number",
                "description": "Maximum number of results (1-10)",
                "default": 5
              }
            },
            "required": ["query"]
          }
        }
      ],
      "settings": [
        {
          "key": "search.apiKey",
          "type": "string",
          "default": "",
          "description": "API key for search service"
        },
        {
          "key": "search.maxResults",
          "type": "number",
          "default": 5,
          "description": "Default max results per search",
          "range": { "min": 1, "max": 20 }
        }
      ],
      "hooks": [
        {
          "event": "message:beforeSend",
          "description": "Enrich message with search context"
        }
      ],
      "statusBarItems": [
        {
          "id": "search-status",
          "alignment": "right",
          "priority": 100,
          "text": "$(search) Search Ready"
        }
      ]
    },
    "permissions": [
      "network",
      "settings:write",
      "sessions:read"
    ],
    "trustLevel": "untrusted"
  }
}
```

### 1.5 与 pi / VSCode Manifest 对比

| 字段 | pi | VSCode | xyz-agent |
|------|-----|--------|-----------|
| 格式 | 无独立文件 | `package.json` + contributes | `package.json` + `xyzAgent` + contributes |
| name | 文件名推导 | `publisher.name` 组成 ID | `publisher` + `name` 组成 ID |
| version | 无 | `version` | `version` |
| 入口 | 目录推断（index.ts 或 package.json `pi.extensions`） | `main` | `main` |
| 兼容性 | 无 | `engines.vscode` | `engines.xyz-agent` |
| 激活事件 | 无（全部启动时加载） | `activationEvents` | `activationEvents`（可选，自动推断） |
| 扩展点 | 无声明式，全部编程式 | `contributes` 大量扩展点 | `contributes` 精选扩展点 |
| 权限 | 无 | 无显式声明（Workspace Trust 隐式） | `permissions` + `trustLevel` |
| schema 版本 | 无 | 无 | `manifestVersion: 1`（明确版本化） |

---

## 2. API 设计

### 2.1 设计原则

| 原则 | 说明 | 来源 |
|------|------|------|
| 最小暴露面 | 只暴露插件确实需要的能力，拒绝"万能接口" | VSCode 教训（API 一旦发布无法收回） |
| 全部异步 | 所有跨 Worker 方法返回 Promise | 进程隔离的基本要求 |
| 冻结防篡改 | `Object.freeze` 递归冻结 agentAPI 对象 | VSCode 实践 |
| 代理转发 | 插件调用的方法不直接在 Worker 内执行，而是通过 JSON-RPC 转发 | VSCode 架构 |
| 声明式优先 | 能在 manifest 中声明就不在代码中注册 | VSCode 最佳实践 |

### 2.2 agentAPI 完整接口

```typescript
/**
 * agentAPI — 插件可用的完整 API 代理。
 * 通过 PluginContext.api 获取。
 * 所有方法通过 JSON-RPC over MessagePort 转发到 Sidecar 主线程。
 * 递归冻结，不可篡改。
 */
interface AgentAPI {
  /** Session 管理 */
  readonly sessions: SessionsAPI;
  /** Tool 注册与管理 */
  readonly tools: ToolsAPI;
  /** Slash 命令 */
  readonly slashCommands: SlashCommandsAPI;
  /** 事件钩子（消息/Tool 拦截） */
  readonly hooks: HooksAPI;
  /** UI 交互 */
  readonly ui: UIAPI;
  /** 工作区信息 */
  readonly workspace: WorkspaceAPI;
  /** 持久化存储 */
  readonly storage: StorageAPI;
  /** 最新版本配置读取 */
  readonly config: ConfigAPI;
  /** 插件间通信 */
  readonly events: EventsAPI;
  /** 与 pi 引擎的对话能力（trusted 插件专属） */
  readonly agent: AgentBridgeAPI;
}

// ---- 各模块定义 ----

interface SessionsAPI {
  /** 获取所有 session 列表 */
  list(): Promise<SessionInfo[]>;
  /** 获取指定 session 详情 */
  get(sessionId: string): Promise<SessionInfo | undefined>;
  /** 获取当前活跃 session */
  getActive(): Promise<SessionInfo | undefined>;
  /** 向指定 session 发送消息 */
  sendMessage(params: { sessionId: string; content: string }): Promise<void>;
  /** session 创建事件 */
  onDidCreateSession: Event<SessionInfo>;
  /** session 销毁事件 */
  onDidDestroySession: Event<string>;
}

interface ToolsAPI {
  /**
   * 动态注册 tool（在 activate() 中调用）。
   * 返回的 Disposable 用于注销 tool。
   * manifest 中已声明的 tool 不需要再注册。
   */
  register(tool: RuntimeToolRegistration): Disposable;
  /** 获取所有已注册的 tool（包含其他插件和内置） */
  list(): Promise<ToolInfo[]>;
}

interface SlashCommandsAPI {
  /**
   * 动态注册 slash 命令。
   * manifest 中已声明的命令不需要再注册。
   */
  register(command: RuntimeCommandRegistration): Disposable;
}

interface HooksAPI {
  /** 消息发送前钩子。可修改内容或阻止发送 */
  onBeforeSendMessage(handler: MessageHookHandler): Disposable;
  /** Tool 调用前钩子。可修改参数或阻止调用 */
  onBeforeToolCall(handler: ToolCallHookHandler): Disposable;
  /** Tool 返回后钩子。可修改返回结果 */
  onAfterToolResult(handler: ToolResultHookHandler): Disposable;
  /** 通用 pi 事件监听（只读，不可拦截） */
  onPiEvent(eventName: PiEventName, handler: (data: unknown) => void): Disposable;
}

interface UIAPI {
  /**
   * 显示选择对话框。
   * 内部通过 extension_ui_request 协议 → Renderer 渲染
   */
  showSelect(title: string, options: readonly string[]): Promise<string | undefined>;
  /**
   * 显示确认对话框
   */
  showConfirm(title: string, message: string): Promise<boolean>;
  /**
   * 显示文本输入对话框
   */
  showInput(title: string, placeholder?: string): Promise<string | undefined>;
  /**
   * 显示通知（在客户端的 Toast 中）
   */
  notify: {
    info(message: string): void;
    warning(message: string): void;
    error(message: string): void;
  };
  /**
   * 更新插件在状态栏中的项
   * @param itemId — 对应 manifest 中 statusBarItems[].id
   */
  updateStatusBarItem(itemId: string, update: StatusBarItemUpdate): void;
  /**
   * 显示编辑器（多行文本输入）
   */
  showEditor(title: string, prefill?: string): Promise<string | undefined>;
}

interface WorkspaceAPI {
  /** 当前工作区根路径（即 session 绑定的项目目录） */
  readonly rootPath: string;
  /** 当前工作区名称 */
  readonly name: string;
  /** 工作区中的文件列表（模糊搜索） */
  findFiles(pattern: string): Promise<string[]>;
}

interface StorageAPI {
  /**
   * 全局 KV 存储（跨 workspace 持久化）。
   * 数据存储路径：~/.xyz-agent/plugins/<pluginId>/globalState.json
   */
  readonly global: PluginStateStorage;

  /**
   * 工作区级 KV 存储（当前 workspace 内持久化）。
   * 数据存储路径：<plugin data dir>/workspace/<workspace-hash>/
   */
  readonly workspace: PluginStateStorage;
}

interface ConfigAPI {
  /**
   * 读取插件自己的配置项（manifest 中 contributes.settings 声明的）
   * key 不含 plugin 前缀，如 "search.maxResults" 而非 "plugin.xyz-plugin-web-search.search.maxResults"
   */
  get<T>(key: string): Promise<T | undefined>;
  /** 读取所有插件配置 */
  getAll(): Promise<Record<string, unknown>>;
  /** 更新配置 */
  set(key: string, value: unknown): Promise<void>;
}

interface EventsAPI {
  /**
   * 跨插件事件通信。
   * 在 Worker 进程内通过 EventBus 实现，不经过 RPC 中转。
   */
  on(event: string, handler: (data: unknown) => void): Disposable;
  emit(event: string, data: unknown): void;
}

/**
 * Agent 桥接 —— 让插件直接操控 pi 引擎的能力。
 * 仅 trusted 插件可用。
 * 直接映射 pi 的 ExtensionAPI 中的关键方法。
 */
interface AgentBridgeAPI {
  /** 设置模型（仅对当前 session 生效） */
  setModel(modelId: string): Promise<void>;
  /** 获取当前模型 */
  getModel(): Promise<ModelInfo>;
  /** 获取 thinking level */
  getThinkingLevel(): Promise<'off' | 'low' | 'high' | 'max'>;
  /** 设置 thinking level */
  setThinkingLevel(level: 'off' | 'low' | 'high' | 'max'): Promise<void>;
  /** 获取当前 session 的可用 tools 列表 */
  getActiveTools(): Promise<string[]>;
}
```

### 2.3 辅助类型

```typescript
interface SessionInfo {
  id: string;
  label: string;
  cwd: string;
  status: 'active' | 'idle' | 'error';
  createdAt: number;
  lastActiveAt: number;
}

interface ToolInfo {
  name: string;
  description: string;
  source: 'builtin' | `plugin:${string}`;
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface RuntimeToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

interface RuntimeCommandRegistration {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<CommandResult>;
}

interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

interface CommandResult {
  success: boolean;
  data: unknown;
  error?: string;
}

interface StatusBarItemUpdate {
  text?: string;
  tooltip?: string;
  command?: string;
  visible?: boolean;
}

interface MessageHookResult {
  blocked?: boolean;
  transformedContent?: string;
}

interface ToolCallHookResult {
  blocked?: boolean;
  transformedParams?: Record<string, unknown>;
  /** 替换 tool handler（由插件自己执行） */
  replacedHandler?: (params: Record<string, unknown>) => Promise<unknown>;
}

interface ToolResultHookResult {
  transformedOutput?: unknown;
}

type MessageHookHandler = (
  ctx: { sessionId: string; content: string }
) => MessageHookResult | Promise<MessageHookResult>;

type ToolCallHookHandler = (
  ctx: { tool: string; params: Record<string, unknown>; sessionId: string }
) => ToolCallHookResult | Promise<ToolCallHookResult>;

type ToolResultHookHandler = (
  ctx: { tool: string; output: unknown; sessionId: string }
) => ToolResultHookResult | Promise<ToolResultHookResult>;

type PiEventName =
  | 'agent_start'
  | 'agent_end'
  | 'tool_execution_start'
  | 'tool_execution_end'
  | 'tool_execution_update'
  | 'turn_start'
  | 'turn_end'
  | 'session_compact';

interface PluginState {
  /** 全局请求计数器（用于 RPC 序列化时的自增 ID） */
  _requestIdCounter: number;
}

/** Disposable 清理接口，对标 VSCode Disposable */
interface Disposable {
  dispose(): void;
}

/** 事件订阅，对标 VSCode Event<T> */
interface Event<T> {
  (listener: (e: T) => unknown): Disposable;
}
```

### 2.4 API 稳定性分层

借鉴 VSCode，xyz-agent 将 API 分为三层：

| 层级 | 访问方式 | 稳定性保证 | 用途 |
|------|---------|-----------|------|
| **stable** | `agentAPI.*` 默认使用 | 向后兼容到下一个 major 版本 | 所有插件可用 |
| **proposed** | `agentAPI._proposed.*` | 随时可能变，可能移除 | 与特定插件联调中的实验性 API |
| **internal** | 不可用 | 无保证 | 仅 Sidecar 核心模块内部使用 |

**proposed API 的使用限制**：
- 插件在 manifest 中声明 `"xyzAgent.enableProposedApi": true`
- PluginService 检查 pluginId 是否在 Proposed API 白名单中
- 非白名单插件调用 proposed API 返回 `PERMISSION_DENIED` 错误

### 2.5 插件代码示例

```typescript
// xyz-plugin-web-search/src/index.ts
import type { PluginModule, PluginContext, ToolResult } from 'xyz-agent-plugin-sdk';

export function activate(context: PluginContext): void | Promise<void> {
  const { api, subscriptions } = context;

  // 1. 监听 session 创建事件
  const sessionSub = api.sessions.onDidCreateSession((session) => {
    console.log(`New session created: ${session.id}`);
  });
  subscriptions.push(sessionSub);

  // 2. 动态注册 tool（补充 manifest 中声明式注册的 webSearch）
  const toolReg = api.tools.register({
    name: 'webSearchExtended',
    description: 'Extended web search with filters',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        site: { type: 'string', description: 'Limit to specific site' }
      },
      required: ['query']
    },
    async execute(params): Promise<ToolResult> {
      const apiKey = await api.config.get<string>('search.apiKey');
      const results = await fetchSearchResults(params as any, apiKey);
      return { success: true, data: results };
    }
  });
  subscriptions.push(toolReg);

  // 3. 注册消息钩子 — 发送消息前注入搜索上下文
  const hookSub = api.hooks.onBeforeSendMessage(async (ctx) => {
    const recentSearches = await api.storage.workspace.get<string[]>('recentSearches');
    if (recentSearches?.length) {
      return {
        transformedContent: `${ctx.content}\n\n[Recent searches: ${recentSearches.join(', ')}]`
      };
    }
    return {};
  });
  subscriptions.push(hookSub);

  // 4. 跨插件通信 — 监听其他插件的 search:complete 事件
  const eventSub = api.events.on('search:complete', (data) => {
    api.ui.notify.info(`Search completed: ${JSON.stringify(data)}`);
  });
  subscriptions.push(eventSub);

  // 5. 更新状态栏
  api.ui.updateStatusBarItem('search-status', {
    text: '$(search) Search Ready',
    tooltip: 'Click to open search panel'
  });

  // 6. 如果作为 trusted 插件，可以直接操控 agent
  // const currentModel = await api.agent.getModel();
}

export function deactivate(): void {
  // 所有 subscriptions 会被自动 dispose，这里只做额外的清理
}

async function fetchSearchResults(
  params: { query: string; site?: string },
  apiKey: string
): Promise<unknown> {
  // ... 实际搜索逻辑
  return [];
}
```

### 2.6 与 pi Extension API 的映射

pi extension 的 30+ 种事件和能力与 xyz-agent agentAPI 的映射关系：

| pi Extension API | xyz-agent agentAPI | 映射方式 |
|-----------------|-------------------|---------|
| `pi.on("context", handler)` | `api.hooks.onBeforeSendMessage()` | Sidecar 桥接，pi context 事件 → RPC notification |
| `pi.on("tool_call", handler)` | `api.hooks.onBeforeToolCall()` | Sidecar 桥接，可修改参数或阻止 |
| `pi.on("tool_result", handler)` | `api.hooks.onAfterToolResult()` | Sidecar 桥接，可修改结果 |
| `pi.registerTool(tool)` | `api.tools.register(tool)` | 管理式注册 + 转发到 pi |
| `pi.registerCommand(name, opts)` | `api.slashCommands.register(cmd)` | 管理式注册 |
| `pi.sendMessage(msg)` | `api.sessions.sendMessage(params)` | 代理转发 |
| `pi.setModel(id)` | `api.agent.setModel(id)` | trusted 专属，转发到 pi |
| `pi.getThinkingLevel()` | `api.agent.getThinkingLevel()` | trusted 专属 |
| `ctx.ui.select/confirm/input` | `api.ui.showSelect/showConfirm/showInput` | extension_ui_request 协议转发 |
| `ctx.ui.notify()` | `api.ui.notify.info/warning/error()` | 通知转发 |
| `ctx.ui.setStatus()` | `api.ui.updateStatusBarItem()` | 状态栏映射 |
| `pi.events.on/emit()` | `api.events.on/emit()` | 同 Worker 内 EventBus，无需桥接 |
| `pi.appendEntry()` | 不暴露给插件 | 插件不应直接写 session 文件（数据一致性风险） |
| `pi.registerProvider()` | 不暴露给插件 | Provider 注册走 Settings，不走插件 API |
| `pi.exec(cmd, args)` | 不暴露 | shell:execute 权限控制，需单独审批 |
| `pi.on("input")` | 不暴露给插件 | 截获用户原始输入是危险操作 |

**关键设计**：
- pi 暴露了 30+ 事件，xyz-agent 只桥接 12 个控制点（通过 `hooks` + `agent` API）
- pi 的"免声明式"机制（不需要 manifest 即可注册能力）在 xyz-agent 中变为**声明式优先 + 编程式补充**
- pi 中 extension 可以直接注入消息到 session（`sendMessage`），xyz-agent 中此操作需要 `sessions:write` 权限

---

## 3. 扩展点体系

### 3.1 扩展点分类

xyz-agent 的扩展点分为两类：

| 类型 | 注册方式 | 何时加载代码 | 优点 |
|------|---------|------------|------|
| **声明式** | manifest `contributes` 字段 | 激活事件触发后 | 不加载代码即可出现在 UI 中，支持懒激活 |
| **编程式** | `activate()` 中调用 API 方法 | 激活时 | 灵活，适合运行时才能确定的内容 |

### 3.2 声明式扩展点详解

#### Slash Commands

用户输入 `/` 时在 SlashMenu 中显示。不加载代码即可出现在菜单中：

```json
{
  "contributes": {
    "slashCommands": [
      {
        "name": "search",
        "description": "Search the web",
        "parameters": {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "Search query" }
          },
          "required": ["query"]
        }
      }
    ]
  }
}
```

前端渲染流程：
```
用户输入 "/"
  → SlashMenu 组件查询 sessionStore.allSlashCommands
  → 包含内置命令 + 所有已注册插件的 slashCommands（不加载代码）
  → 用户选择 "/search"
  → PluginService 收到 onSlashCommand:search 激活事件
  → 激活插件 → 命令的 execute() 被调用
```

#### Tools

LLM 在进行 function call 时可以看到所有已注册的 tool（包括插件贡献的）。tool 的 schema 在 manifest 中声明，不加载代码即可让 LLM 知道它的存在和参数：

```json
{
  "contributes": {
    "tools": [
      {
        "name": "webSearch",
        "description": "Search the web and return results with title, URL, and snippet",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": { "type": "string" },
            "maxResults": { "type": "number", "default": 5 }
          },
          "required": ["query"]
        }
      }
    ]
  }
}
```

执行流程：
```
LLM 决定调用 webSearch tool
  → pi 发出 tool_call: { name: "webSearch", args: {...} }
  → Sidecar 检查 tool 来源是插件 →
  → 如果是首次调用该插件的 tool → 触发 onToolCall:webSearch 激活事件
    → 激活插件
  → 通过 PluginHost RPC 转发 tool 执行请求到 Worker
  → Worker 中 plugin.tool.execute(params) 返回结果
  → Sidecar 转发结果 → pi
```

#### Settings

插件贡献的配置项自动出现在 Settings 面板（Settings / Plugins / <pluginName>）：

```json
{
  "contributes": {
    "settings": [
      {
        "key": "search.apiKey",
        "type": "string",
        "default": "",
        "description": "API key for search service"
      },
      {
        "key": "search.maxResults",
        "type": "number",
        "default": 5,
        "description": "Max results per search",
        "range": { "min": 1, "max": 20 }
      },
      {
        "key": "search.engine",
        "type": "select",
        "default": "google",
        "description": "Search engine",
        "options": ["google", "bing", "duckduckgo"]
      }
    ]
  }
}
```

#### Panels

插件可以在侧边栏或抽屉中添加自己的面板。面板内容由前端渲染（预留），初期只支持简单的文本/列表展示：

```json
{
  "contributes": {
    "panels": [
      {
        "id": "search-history",
        "title": "Search History",
        "location": "drawer",
        "icon": "search",
        "initialSize": "compact"
      }
    ]
  }
}
```

#### StatusBar Items

在应用底部状态栏添加自定义项（文本 + 点击事件）。点击事件触发 `onCommand:<pluginId>.<itemId>`：

```json
{
  "contributes": {
    "statusBarItems": [
      {
        "id": "search-status",
        "alignment": "right",
        "priority": 100,
        "text": "Search Ready",
        "tooltip": "Search plugin status"
      }
    ]
  }
}
```

#### Message Decorators

在聊天流的消息上添加装饰（徽标、tag、上下文信息）。插件通过钩子 `on('message:afterSend')` 返回装饰数据：

```json
{
  "contributes": {
    "messageDecorators": [
      {
        "messageType": "assistant",
        "description": "Add search relevance badge to assistant messages"
      }
    ]
  }
}
```

### 3.3 编程式扩展点详解

编程式扩展点是在 `activate(context)` 中通过 `context.api` 动态注册的。

#### 事件钩子（核心差异化能力）

这是 xyz-agent 插件系统对 pi 能力的直接继承——让插件可以在消息/Tool 处理的各个阶段插入逻辑：

```typescript
// 消息钩子 — 发送消息前修改内容
api.hooks.onBeforeSendMessage((ctx) => {
  // ctx = { sessionId, content }
  if (ctx.content.includes('@search')) {
    return { transformedContent: enrichWithSearchContext(ctx.content) };
  }
  return {}; // 不做修改
});

// Tool 钩子 — Tool 调用前修改参数
api.hooks.onBeforeToolCall((ctx) => {
  if (ctx.tool === 'read' && ctx.params.path === 'secret.env') {
    return { blocked: true }; // 阻止读取敏感文件
  }
  return {};
});

// Tool 钩子 — Tool 调用后修改结果
api.hooks.onAfterToolResult((ctx) => {
  if (ctx.tool === 'webSearch') {
    // 给搜索结果添加缓存标记
    return { transformedOutput: { ...ctx.output, cached: true } };
  }
  return {};
});
```

**钩子执行顺序**：先执行内置 hooks → 按插件加载顺序执行插件 hooks。插件 hooks 中任意一个返回 `{ blocked: true }` 即阻止后续所有钩子。

#### Pi 事件监听（只读）

```typescript
api.hooks.onPiEvent('tool_execution_start', (data) => {
  console.log('Tool started:', data);
});

api.hooks.onPiEvent('agent_end', (data) => {
  api.ui.notify.info('Agent finished generating');
});
```

只能观测，不能拦截。拦截通过上面的 hooks.xxx 实现。

#### 跨插件通信

Worker 内的 EventBus（只覆盖同 Worker 内的插件，trusted 插件间失效）：

```typescript
// Plugin A: 触发搜索完成事件
api.events.emit('search:complete', { query: 'foo', results: 42 });

// Plugin B: 响应
api.events.on('search:complete', (data) => {
  api.ui.notify.info(`Search done: ${data.results} results`);
});
```

### 3.4 扩展点与激活事件的映射

| 声明式扩展点 | 激活事件 | 说明 |
|------------|---------|------|
| `slashCommands` | `onSlashCommand:{name}` | 用户选择命令时 |
| `tools` | `onToolCall:{name}` | LLM 首次调用该 tool 时 |
| `hooks` | `onHook:{event}` | 对应事件首次触发时 |
| `panels` | `onStartupFinished` | 面板需要在启动后渲染 |
| `statusBarItems` | `onStartupFinished` | 状态栏项在启动后显示 |
| `messageDecorators` | `onStartupFinished` | 装饰器在启动后注册 |

### 3.5 与 pi / VSCode 扩展点对比

| 扩展点 | pi | VSCode | xyz-agent |
|--------|-----|--------|-----------|
| Slash Commands | `registerCommand()` | `contributes.commands` | `contributes.slashCommands` + 编程式注册 |
| AI Tools | `registerTool()` | 无（VSCode 不是 AI Agent） | `contributes.tools` + `api.tools.register()` |
| Settings | 无 | `contributes.configuration` | `contributes.settings` |
| 事件钩子 | `pi.on("event")` 全部可用 | Extension Host 内无事件拦截 | 精选 12 个钩子点 + pi 事件只读桥接 |
| 面板 | TUI 组件 / custom | Webview / TreeView | `contributes.panels`（声明式 slot） |
| 状态栏 | `setStatus()` | `createStatusBarItem()` | `contributes.statusBarItems` + 编程式更新 |
| 消息装饰 | 无 | 无（无聊天流） | `contributes.messageDecorators` |
| Provider 注册 | `registerProvider()` | 无 | 不暴露（走 Settings） |
| 快捷键 | `registerShortcut()` | `contributes.keybindings` | 暂不支持 |

---

## 4. 安全模型

### 4.1 设计决策：分级信任

pi 采用"全信任"模型——extension 拥有宿主进程的全部权限。VSCode 采用"Workspace Trust"——基于是否信任当前工作区来限制扩展。xyz-agent 需要在两者之间找到平衡：

- **不能像 pi 一样全信任**：第三方插件不一定可信
- **不必像 VSCode 那样依赖 Workspace Trust**：xyz-agent 的工作区概念较弱
- **需要明确的权限声明**：开发者在使用插件前能知道它要什么权限

**选择**：分级信任模型，结合声明式权限。

### 4.2 信任等级

| 等级 | 条件 | Worker 策略 | API 访问 | 权限 |
|------|------|-----------|---------|------|
| **builtin** | 随 xyz-agent 打包的内置插件 | 共享 trusted Worker | 完整 agentAPI + AgentBridge | 全部 |
| **trusted** | 用户手动设为 trusted 的第三方插件 | 共享 trusted Worker | 完整 agentAPI | 默认全部，manifest 中 `permissions` 可为空 |
| **untrusted**（默认） | 所有第三方插件 | 独占 sandbox Worker | 受限 agentAPI（无 AgentBridge） | 按 manifest 中的 `permissions` 授予 |

### 4.3 权限声明

插件必须在 manifest 中声明需要的权限：

```typescript
type PluginPermission =
  // 文件系统
  | 'filesystem:read'         // 读取工作区文件
  | 'filesystem:write'        // 写入工作区文件

  // 网络
  | 'network'                 // 发出 HTTP 请求

  // Shell
  | 'shell:execute'           // 执行 shell 命令

  // 剪贴板
  | 'clipboard:read'
  | 'clipboard:write'

  // 系统通知
  | 'notifications'

  // Session
  | 'sessions:read'           // 读取 session 列表和信息
  | 'sessions:write'          // 向 session 发送消息

  // Tool / 配置
  | 'tools:register'          // 注册 AI Tool
  | 'settings:write';         // 修改插件配置

/** 默认权限（所有插件默认授予，无需声明） */
const DEFAULT_PERMISSIONS: PluginPermission[] = [
  // 无 —— 所有权限都需显式声明，零默认信任
];
```

**权限检查流程**：

```
1. PluginService 加载 manifest
2. 解析 permissions 字段
3. 安装时（或首次激活时）向用户展示权限列表
   ┌──────────────────────────────────────────────────────┐
   │  xyz-plugin-web-search 需要以下权限:                  │
   │                                                      │
   │  ⬡ network        — 访问搜索 API                      │
   │  ⬡ sessions:read  — 读取 session 信息                 │
   │                                                      │
   │  [拒绝]  [允许]                                       │
   └──────────────────────────────────────────────────────┘
4. 用户确认后，权限被持久化到 ~/.xyz-agent/plugins/permissions.json
5. 运行时每次 RPC 调用前，PluginService 检查权限映射表
6. 权限不足 → 返回 RPC error { code: -32001, message: "PERMISSION_DENIED" }
```

### 4.4 运行时沙箱

**sandbox Worker 的限制**：

1. **No `require` / `import` of Node.js builtins**：插件不能直接 `require('fs')`、`require('child_process')`、`require('http')`。Worker 启动时通过 `workerData` 注入经过净化的 `require` 函数，只允许 import 插件自身目录下的模块
2. **No `process.env`**：环境变量不可见
3. **No `process.cwd()` 写权限**：不能修改 cwd
4. **No `globalThis` 污染**：Worker 的 global scope 是插件专属的，同名变量不冲突
5. **通过 agentAPI 代理访问所有外部能力**：文件系统、网络、shell 等只能通过 API 代理调用

**trusted Worker 的限制**：
- 可以 require Node.js builtins
- 可以访问 process.env（部分净化）
- 通过 agentAPI 代理访问外部能力的路径与 sandbox 相同，但权限检查更宽松

### 4.5 与 pi / VSCode 安全模型对比

| 维度 | pi | VSCode | xyz-agent |
|------|-----|--------|-----------|
| 权限模型 | 无 | Workspace Trust | 分级信任 + 声明式权限 |
| 进程隔离 | 无 | ExtHost 进程 | Worker Thread |
| 代码能力限制 | 无（full Node.js） | ExtHost: full; Web: browser only | sandbox Worker: 净化 require() |
| 安装时审批 | 无 | 无（Marketplace 自动安装） | 展示权限列表，用户确认 |
| 运行时检查 | 无 | Workspace Trust 开关 | 每次 RPC 调用检查权限 |
| 恶意插件防护 | 无（信任开发者） | 签名 + Marketplace 审核 | 权限声明 + Worker 沙箱 |
| 敏感操作拦截 | 无 | Workspace Trust 关停部分 API | RPC 层拦截 + PERMISSION_DENIED error |

### 4.6 与 pi 的"全信任"模型的桥接

xyz-agent 的插件与 pi 的 extension 是不同的概念。pi extension 运行在 pi 进程内，xyz-agent plugin 运行在 Sidecar 的 Worker Thread 内。两者不直接通信。

**桥接策略**：
- xyz-agent 的内置插件（builtin）可以通过 AgentBridge API 直接操控 pi 引擎
- 第三方插件通过 hooks / tools / slashCommands 间接影响 pi 的行为
- 第三方插件不能调用 pi extension 的 API（如 appendEntry、registerProvider），防止污染 session 数据和模型配置

---

## 5. 持久化

### 5.1 数据目录布局

```
~/.xyz-agent/
├── plugins/
│   ├── <pluginId>/                     ← 插件安装路径（npm 包解压到此）
│   │   ├── package.json
│   │   ├── dist/
│   │   └── ...
│   ├── <pluginId>/
│   │   └── data/                       ← 插件专属数据目录
│   │       ├── globalState.json        ← 全局 KV 存储（跨 workspace）
│   │       └── workspace/              ← 工作区级数据
│   │           └── <workspace-hash>/
│   │               ├── workspaceState.json    ← 工作区 KV 存储
│   │               └── files/                 ← 插件自行管理的文件
│   └── permissions.json               ← 权限审批记录
└── pi/
    └── sessions/                       ← pi session 文件（插件不可写）
```

### 5.2 Storage API

```typescript
/**
 * KV 存储接口。
 * 所有读写操作通过 RPC 异步执行，确保 Worker 沙箱不直接操作文件系统。
 */
interface PluginStateStorage {
  /** 读取值 */
  get<T>(key: string): Promise<T | undefined>;
  /** 读取值（带默认值） */
  get<T>(key: string, defaultValue: T): Promise<T>;

  /**
   * 设置值。自动持久化到磁盘。
   * value 需要是 JSON-serializable 的。
   */
  set(key: string, value: unknown): Promise<void>;

  /** 删除键 */
  delete(key: string): Promise<void>;

  /** 获取所有键 */
  keys(): Promise<string[]>;
}
```

### 5.3 存储后端

```
PluginStorage (sidecar/services/)
  ├── globalState: Map<pluginId, StateStore>
  │     后端: ~/.xyz-agent/plugins/<pluginId>/data/globalState.json
  │     写入策略: 延迟批量写入（500ms debounce）
  └── workspaceState: Map<key, StateStore>
        后端: <plugin data dir>/workspace/<ws-hash>/workspaceState.json
        写入策略: 同 globalState

StateStore 内部:
  ├── 内存缓存（Map<string, unknown>）
  ├── debounced flush → fs.writeFile
  └── 启动时 fs.readFile → 填充缓存
```

### 5.4 存储限制

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 每个 key 的 value 大小上限 | 1MB | 超过返回 PAYLOAD_TOO_LARGE |
| 每个插件的 total 存储上限 | 10MB | 超过时 `set()` 返回 error |
| flush debounce 时间 | 500ms | 降低磁盘写入频率 |
| 不做跨 workspace 隔离 | — | 插件的 globalState 是所有 workspace 共享的 |

### 5.5 与 pi 的 appendEntry 桥接

pi 的 `appendEntry()` 允许 extension 向 session 文件追加自定义 entry（不发给 LLM，仅用于持久化标记）。xyz-agent 的插件**不能**直接使用 pi 的 `appendEntry()`。

替代方案：
- **内置插件**（builtin）：通过 AgentBridge 暴露 `appendSessionEntry(type, data)` 方法（trusted 可调用），由 Sidecar 转发到 pi RPC
- **第三方插件**：不提供此能力。如需持久化 session 相关的元数据，使用 workspaceState 的 KV 存储

### 5.6 与 pi / VSCode 持久化对比

| 维度 | pi | VSCode | xyz-agent |
|------|-----|--------|-----------|
| 全局存储 | 无（extension 自行 fs.writeFile） | `ExtensionContext.globalState` | `api.storage.global` |
| Workspace 存储 | 无 | `ExtensionContext.workspaceState` | `api.storage.workspace` |
| 文件存储 | 无限制 | `ExtensionContext.storageUri` | `<plugin data dir>/files/` |
| Session 持久化 | `appendEntry()`（无限制） | 无（无 session 概念） | AgentBridge 限定（仅 trusted/builtin） |
| 备份/同步 | 无 | 无（通过 Settings Sync） | 初期无 |
| 存储限制 | 无 | 无 | 每插件 10MB + 单值 1MB |

---

## 6. 分发机制

### 6.1 设计决策：渐进式分发

| 阶段 | 方案 | 说明 |
|------|------|------|
| **Phase 1（当前）** | Git repo + 手动链接 | 开发者 clone 仓库 → symlink 到 plugins 目录 |
| **Phase 2** | npm install | `xyz-agent plugin install <npm-package>` 自动安装 |
| **Phase 3** | Registry | 自建插件注册表（或借用 npm registry 的分发能力） |
| **Phase 4**（远期） | Marketplace | 自有 Marketplace（Web UI、评分、版本管理） |

当前聚焦 Phase 1-2。

### 6.2 插件发现路径

```
发现优先级（从高到低）:

Layer 1: 项目级
  <cwd>/.xyz-agent/plugins/
  自动激活，跟随 git

Layer 2: 用户级
  ~/.xyz-agent/plugins/
  跨项目可用

Layer 3: Settings 管理
  在 Settings / Plugins 中手动启用/禁用/删除
```
发现规则（与 pi 的 loader 一致）：

```typescript
/** 插件发现函数（在 PluginRegistry 中实现） */
interface PluginDiscovery {
  /** 从指定目录扫描所有插件，返回 pluginId → manifest 映射 */
  scanDirectory(dir: string): Promise<Map<string, XyzAgentManifest>>;

  /** 获取所有已发现的插件信息 */
  getDiscoveredPlugins(): PluginDescriptor[];

  /** 手动注册插件路径 */
  registerPath(path: string): Promise<void>;
}

interface PluginDescriptor {
  pluginId: string;           // publisher.name
  displayName?: string;
  version: string;
  description?: string;
  trustLevel: 'builtin' | 'trusted' | 'untrusted';
  status: 'discovered' | 'loaded' | 'active' | 'error' | 'disabled';
  activationEvents: ActivationEvent[];
  permissions: PluginPermission[];
  manifestPath: string;
  entryPath: string;          // 入口文件的绝对路径
}
```

### 6.3 安装流程

```
npm install -g xyz-plugin-web-search
  │
  ├─ (Phase 2: xyz-agent plugin install xyz-plugin-web-search)
  │
  ├─ PluginService 读取 package.json → 提取 xyzAgent 字段
  │
  ├─ 权限审批（首次安装）:
  │     ┌──────────────────────────────────────┐
  │     │ Install "Web Search"?                 │
  │     │                                       │
  │     │ Permissions:                          │
  │     │  ⬡ network                            │
  │     │  ⬡ sessions:read                      │
  │     │                                       │
  │     │ Trust Level: untrusted                │
  │     │                                       │
  │     │ [Cancel]  [Install]                   │
  │     └──────────────────────────────────────┘
  │
  ├─ 用户确认 → 记录到 permissions.json
  │
  ├─ 解析 contributes → 注册声明式扩展点
  │
  └─ 等待激活事件（懒激活）
```

### 6.4 版本管理

```typescript
/** 插件版本管理（PluginRegistry 内部） */
interface PluginVersionManager {
  /** 检查插件是否兼容当前 xyz-agent 版本 */
  checkCompatibility(manifest: XyzAgentManifest): CompatibilityResult;

  /** 检查是否有更新（需要 registry 支持，Phase 3+） */
  checkUpdates(): Promise<PluginUpdateInfo[]>;
}

interface CompatibilityResult {
  compatible: boolean;
  /** 不兼容时的原因 */
  reason?: string;
  /** 要求的版本范围 */
  requiredRange?: string;
}

interface PluginUpdateInfo {
  pluginId: string;
  currentVersion: string;
  latestVersion: string;
}
```

### 6.5 与 pi / VSCode 分发对比

| 维度 | pi | VSCode | xyz-agent |
|------|-----|--------|-----------|
| 安装方式 | `pi install <source>` | Marketplace 内一键安装 | Git clone / npm install / 手动链接 |
| 发现路径 | 项目级 + 用户级 + CLI 显式 | 用户级 `~/.vscode/extensions/` | 项目级 + 用户级 |
| 版本兼容检查 | 无 | `engines.vscode` + semver | `engines.xyz-agent` + semver |
| 权限审批 | 无（全信任） | 无（Marketplace 审核） | 安装时展示权限列表 |
| 自动更新 | 无 | 内置（基于 Marketplace 版本） | 初期手动 |
| 包格式 | 目录 / npm 包 | VSIX（带签名的 zip） | npm 包（与源码目录格式相同） |
| 启用/禁用 | `--no-extensions` 全局关闭 | 右键 → Disable | Settings / Plugins 中管理 |
| 卸载 | 手动删除目录 | 右键 → Uninstall | 手动删除 + npm uninstall |
| 包管理器 | `pi install`（`~/.pi/agent/packages/`） | VSCode UI | npm + 手动管理 |

---

## 7. 融合设计总结

### 7.1 从 pi 继承的设计

| 继承自 pi | 说明 |
|----------|------|
| 三层发现路径 | 项目级 + 用户级 + CLI 显式 → 改为项目级 + 用户级 + Settings |
| 两阶段生命周期 | 注册（注册 hooks/tools/commands）→ 绑定（注入 agentAPI） |
| 事件拦截机制 | `hooks.onBeforeXXX()` 可修改参数或阻止执行 |
| Tool 执行协议 | `RuntimeToolRegistration.execute()` 返回 `ToolResult` |
| 跨插件通信 | `api.events.on/emit()` 内存 EventBus |
| Extension UI 协议 | `extension_ui_request/response` → `api.ui.*` |

### 7.2 从 VSCode 继承的设计

| 继承自 VSCode | 说明 |
|--------------|------|
| 进程隔离 | Extension Host 独立进程 → Worker Thread 隔离 |
| 懒激活 | activationEvents + 从 contributes 自动推断 |
| 声明式 manifest | package.json + contributes 不加载代码即可注册 |
| API 稳定性分层 | stable / proposed / internal |
| API 冻结 | Object.freeze 防篡改 |
| Disposables 模式 | context.subscriptions 自动清理 |
| Manifest 版本化 | manifestVersion 为未来兼容预留 |
| engines 兼容性声明 | semver 约束 |

### 7.3 xyz-agent 的创新点

| 设计 | 说明 |
|------|------|
| Worker Thread 分组隔离 | trusted 共享 / untrusted 独占，比 VSCode 更细粒度 |
| 声明式权限声明 | pi 和 VSCode 都没有的显式权限模型 |
| 钩子事件精选 | 从 pi 的 30+ 事件中筛选 12 个控制点，不全部暴露 |
| 消息装饰器 | 针对 AI Agent 聊天流的特有扩展点 |
| Agent Bridge API | trusted 插件可以直接操控 pi 引擎，第三方插件只能通过 hooks 间接影响 |
| 渐进式分发 | Phase 1 git → Phase 2 npm → Phase 3 registry，不过度设计 |
