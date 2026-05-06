# Pi SDK API Reference

> Source: `@mariozechner/pi-coding-agent` at `~/GitApp/pi-mono/packages/coding-agent/`
> Generated: 2026-05-06

---

## Table of Contents

1. [createAgentSession](#1-createagentsession)
2. [AgentSession](#2-agentsession)
3. [Event System](#3-event-system)
4. [SessionManager](#4-sessionmanager)
5. [ModelRegistry](#5-modelregistry)
6. [RPC Mode Protocol](#6-rpc-mode-protocol)
7. [Config Format](#7-config-format)

---

## 1. createAgentSession

**File**: `src/core/sdk.ts`

### Signature

```typescript
async function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>
```

### Options: `CreateAgentSessionOptions`

```typescript
interface CreateAgentSessionOptions {
  /** Working directory for project-local discovery. Default: process.cwd() */
  cwd?: string;
  /** Global config directory. Default: ~/.pi/agent */
  agentDir?: string;

  /** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
  authStorage?: AuthStorage;
  /** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
  modelRegistry?: ModelRegistry;

  /** Model to use. Default: from settings, else first available */
  model?: Model<any>;
  /** Thinking level. Default: from settings, else 'medium' */
  thinkingLevel?: ThinkingLevel;
  /** Models available for cycling */
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

  /** Tool suppression mode */
  noTools?: "all" | "builtin";
  /** Allowlist of tool names. When provided, only listed tools enabled. */
  tools?: string[];
  /** Custom tools to register */
  customTools?: ToolDefinition[];

  /** Resource loader override */
  resourceLoader?: ResourceLoader;
  /** Session manager override */
  sessionManager?: SessionManager;
  /** Settings manager override */
  settingsManager?: SettingsManager;
  /** Session start event metadata for extensions */
  sessionStartEvent?: SessionStartEvent;
}
```

### Result: `CreateAgentSessionResult`

```typescript
interface CreateAgentSessionResult {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  modelFallbackMessage?: string;  // Warning if restored with different model
}
```

### Usage Examples

```typescript
// Minimal - uses defaults
const { session } = await createAgentSession();

// With explicit model
import { getModel } from '@mariozechner/pi-ai';
const { session } = await createAgentSession({
  model: getModel('anthropic', 'claude-opus-4-5'),
  thinkingLevel: 'high',
});

// In-memory (no file persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
```

---

## 2. AgentSession

**File**: `src/core/agent-session.ts`

### Constructor Config: `AgentSessionConfig`

```typescript
interface AgentSessionConfig {
  agent: Agent;                              // Core agent engine from pi-agent-core
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  cwd: string;
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
  resourceLoader: ResourceLoader;
  customTools?: ToolDefinition[];
  modelRegistry: ModelRegistry;
  initialActiveToolNames?: string[];         // Default: ["read", "bash", "edit", "write"]
  allowedToolNames?: string[];               // Optional allowlist
  baseToolsOverride?: Record<string, AgentTool>;
  extensionRunnerRef?: { current?: ExtensionRunner };
  sessionStartEvent?: SessionStartEvent;
}
```

### Key Methods

#### Prompting

```typescript
/** Send a prompt to the agent. Handles extension commands, templates, streaming. */
async prompt(text: string, options?: PromptOptions): Promise<void>

interface PromptOptions {
  expandPromptTemplates?: boolean;           // Default: true
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp"; // Required if agent is streaming
  source?: InputSource;                      // Default: "interactive"
  preflightResult?: (success: boolean) => void;
}

/** Queue a steering message (interrupts after current tool call batch) */
async steer(text: string, images?: ImageContent[]): Promise<void>

/** Queue a follow-up message (waits until agent finishes) */
async followUp(text: string, images?: ImageContent[]): Promise<void>

/** Send a custom message (extension-created, can trigger LLM turn) */
async sendCustomMessage<T = unknown>(
  message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
): Promise<void>

/** Send a user message. Always triggers a turn. */
async sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp" },
): Promise<void>

/** Abort current operation */
async abort(): Promise<void>

/** Clear all queued messages */
clearQueue(): { steering: string[]; followUp: string[] }
```

#### Model Management

```typescript
/** Set model directly (validates auth) */
async setModel(model: Model<any>): Promise<void>

/** Cycle to next/previous model */
async cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>

interface ModelCycleResult {
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  isScoped: boolean;
}
```

#### Thinking Level

```typescript
/** Set thinking level (clamps to model capabilities) */
setThinkingLevel(level: ThinkingLevel): void

/** Cycle to next thinking level */
cycleThinkingLevel(): ThinkingLevel | undefined

/** Get available thinking levels for current model */
getAvailableThinkingLevels(): ThinkingLevel[]

supportsThinking(): boolean
supportsXhighThinking(): boolean
```

#### Tool Management

```typescript
/** Get names of currently active tools */
getActiveToolNames(): string[]

/** Get all configured tools with metadata */
getAllTools(): ToolInfo[]

/** Set active tools by name (rebuilds system prompt) */
setActiveToolsByName(toolNames: string[]): void

/** Get specific tool definition */
getToolDefinition(name: string): ToolDefinition | undefined
```

#### Compaction

```typescript
/** Manually compact session context */
async compact(customInstructions?: string): Promise<CompactionResult>

/** Cancel in-progress compaction */
abortCompaction(): void

/** Toggle auto-compaction */
setAutoCompactionEnabled(enabled: boolean): void

/** Whether compaction is running */
get isCompacting(): boolean
```

#### Session Management

```typescript
/** Set display name for session */
setSessionName(name: string): void

/** Navigate to different node in session tree */
async navigateTree(
  targetId: string,
  options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
): Promise<{ editorText?: string; cancelled: boolean; summaryEntry?: BranchSummaryEntry }>

/** Get session statistics */
getSessionStats(): SessionStats

/** Export session to HTML */
async exportToHtml(outputPath?: string): Promise<string>

/** Export session branch to JSONL */
exportToJsonl(outputPath?: string): string

/** Reload resources, settings, extensions */
async reload(): Promise<void>

/** Dispose session (disconnect events, invalidate extensions) */
dispose(): void
```

#### Bash Execution

```typescript
/** Execute a bash command */
async executeBash(
  command: string,
  onChunk?: (chunk: string) => void,
  options?: { excludeFromContext?: boolean; operations?: BashOperations },
): Promise<BashResult>

/** Cancel running bash */
abortBash(): void
```

### Read-only Properties

```typescript
get agent(): Agent
get state(): AgentState
get model(): Model<any> | undefined
get thinkingLevel(): ThinkingLevel
get isStreaming(): boolean
get systemPrompt(): string
get messages(): AgentMessage[]
get sessionFile(): string | undefined
get sessionId(): string
get sessionName(): string | undefined
get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>
get pendingMessageCount(): number
get isCompacting(): boolean
get isRetrying(): boolean
get autoRetryEnabled(): boolean
get autoCompactionEnabled(): boolean
get steeringMode(): "all" | "one-at-a-time"
get followUpMode(): "all" | "one-at-a-time"
get resourceLoader(): ResourceLoader
get modelRegistry(): ModelRegistry
get extensionRunner(): ExtensionRunner
```

---

## 3. Event System

### AgentEvent (from `@mariozechner/pi-agent-core`)

The core agent emits these events during the agent loop:

```typescript
type AgentEvent =
  // Lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }

  // Message streaming
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent?: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }

  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
```

### AgentSessionEvent (extended by AgentSession)

```typescript
type AgentSessionEvent =
  | AgentEvent
  // Queue updates
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  // Compaction
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  // Session info
  | { type: "session_info_changed"; name: string | undefined }
  // Auto-retry
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
```

### Subscription

```typescript
/** Subscribe to session events. Returns unsubscribe function. */
subscribe(listener: AgentSessionEventListener): () => void

type AgentSessionEventListener = (event: AgentSessionEvent) => void;
```

### AssistantMessageEventStream (from `@mariozechner/pi-ai`)

Low-level LLM stream events used during `streamSimple()`:

```typescript
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage }
```

**Note**: `AssistantMessageEventStream` has a `.result()` method that returns `Promise<AssistantMessage>`.

---

## 4. SessionManager

**File**: `src/core/session-manager.ts`

### Storage Format

Sessions are stored as **JSONL files** (append-only tree). Each line is a JSON entry.

**Default location**: `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<sessionId>.jsonl`

### File Format

```jsonl
{"type":"session","version":3,"id":"01961abc-def0-7423-8def-0123456789ab","timestamp":"2025-01-15T10:30:00.000Z","cwd":"/Users/user/my-project"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2025-01-15T10:30:01.000Z","message":{"role":"user","content":"Hello","timestamp":1705312201000}}
{"type":"message","id":"e5f6a7b8","parentId":"a1b2c3d4","timestamp":"2025-01-15T10:30:05.000Z","message":{"role":"assistant",...}}
{"type":"model_change","id":"c9d0e1f2","parentId":"e5f6a7b8","timestamp":"2025-01-15T10:31:00.000Z","provider":"anthropic","modelId":"claude-sonnet-4-20250514"}
{"type":"thinking_level_change","id":"f3a4b5c6","parentId":"c9d0e1f2","timestamp":"2025-01-15T10:31:01.000Z","thinkingLevel":"high"}
```

### Session Entry Types

```typescript
type SessionEntry =
  | SessionMessageEntry          // type: "message" — AgentMessage (user/assistant/toolResult)
  | ThinkingLevelChangeEntry     // type: "thinking_level_change"
  | ModelChangeEntry             // type: "model_change"
  | CompactionEntry              // type: "compaction"
  | BranchSummaryEntry           // type: "branch_summary"
  | CustomEntry                  // type: "custom" — extension data, NOT in LLM context
  | CustomMessageEntry           // type: "custom_message" — IN LLM context
  | LabelEntry                   // type: "label" — user bookmarks
  | SessionInfoEntry             // type: "session_info" — display name
```

### Key Methods

```typescript
class SessionManager {
  // Factory methods
  static create(cwd: string, sessionDir?: string): SessionManager
  static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager
  static continueRecent(cwd: string, sessionDir?: string): SessionManager
  static inMemory(cwd?: string): SessionManager
  static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager

  // List sessions
  static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>
  static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>

  // Append entries (returns entry ID)
  appendMessage(message: Message | CustomMessage | BashExecutionMessage): string
  appendThinkingLevelChange(thinkingLevel: string): string
  appendModelChange(provider: string, modelId: string): string
  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: T, fromHook?: boolean): string
  appendCustomEntry(customType: string, data?: unknown): string
  appendCustomMessageEntry(customType: string, content: string | Content[], display: boolean, details?: T): string
  appendSessionInfo(name: string): string
  appendLabelChange(targetId: string, label: string | undefined): string

  // Read state
  getCwd(): string
  getSessionDir(): string
  getSessionId(): string
  getSessionFile(): string | undefined
  getSessionName(): string | undefined
  getLeafId(): string | null
  getEntry(id: string): SessionEntry | undefined
  getBranch(fromId?: string): SessionEntry[]
  getEntries(): SessionEntry[]
  getTree(): SessionTreeNode[]
  getHeader(): SessionHeader | null
  getLabel(id: string): string | undefined
  buildSessionContext(): SessionContext

  // Tree operations
  branch(branchFromId: string): void
  resetLeaf(): void
  branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string
  createBranchedSession(leafId: string): string | undefined
  newSession(options?: NewSessionOptions): string | undefined
  setSessionFile(sessionFile: string): void
}
```

### SessionContext

```typescript
interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}
```

### SessionInfo

```typescript
interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}
```

---

## 5. ModelRegistry

**File**: `src/core/model-registry.ts`

### Key Methods

```typescript
class ModelRegistry {
  static create(authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry
  static inMemory(authStorage: AuthStorage): ModelRegistry

  /** Reload models from disk */
  refresh(): void

  /** Get all models (built-in + custom) */
  getAll(): Model<Api>[]

  /** Get only models with configured auth */
  getAvailable(): Model<Api>[]

  /** Find model by provider + id */
  find(provider: string, modelId: string): Model<Api> | undefined

  /** Check if model has auth configured */
  hasConfiguredAuth(model: Model<Api>): boolean

  /** Get API key and headers for a model */
  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>

  /** Register provider dynamically (from extensions) */
  registerProvider(providerName: string, config: ProviderConfigInput): void

  /** Unregister a previously registered provider */
  unregisterProvider(providerName: string): void

  /** Check if model uses OAuth */
  isUsingOAuth(model: Model<Api>): boolean

  /** Get auth status for a provider */
  getProviderAuthStatus(provider: string): AuthStatus
}
```

### ResolvedRequestAuth

```typescript
type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string }
```

### ProviderConfigInput (for dynamic registration)

```typescript
interface ProviderConfigInput {
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;
  oauth?: Omit<OAuthProviderInterface, "id">;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: Model<Api>["compat"];
  }>;
}
```

### Model Interface (from `@mariozechner/pi-ai`)

```typescript
interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;      // $/million tokens
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
}
```

### Known APIs

```typescript
type KnownApi =
  | "openai-completions"
  | "mistral-conversations"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-gemini-cli"
  | "google-vertex"
```

### Known Providers

```typescript
type KnownProvider =
  | "amazon-bedrock" | "anthropic" | "google" | "google-gemini-cli"
  | "google-antigravity" | "google-vertex" | "openai"
  | "azure-openai-responses" | "openai-codex" | "deepseek"
  | "github-copilot" | "xai" | "groq" | "cerebras"
  | "openrouter" | "vercel-ai-gateway" | "zai" | "mistral"
  | "minimax" | "minimax-cn" | "huggingface" | "fireworks"
  | "opencode" | "opencode-go" | "kimi-coding" | "cloudflare-workers-ai"
```

---

## 6. RPC Mode Protocol

**File**: `src/modes/rpc/`

### Overview

RPC mode uses JSONL over stdin/stdout. Commands go to stdin, responses and events come from stdout.

### Starting RPC Mode

```bash
pi --mode rpc [--provider <provider>] [--model <modelId>] [--session <path>] [--continue]
```

### Commands (stdin → agent)

```typescript
type RpcCommand =
  // Prompting
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }

  // State
  | { id?: string; type: "get_state" }

  // Model
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }

  // Thinking
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }

  // Queue modes
  | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

  // Compaction
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }

  // Retry
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }

  // Bash
  | { id?: string; type: "bash"; command: string }
  | { id?: string; type: "abort_bash" }

  // Session
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "clone" }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }

  // Messages
  | { id?: string; type: "get_messages" }

  // Commands
  | { id?: string; type: "get_commands" }
```

### Responses (agent → stdout)

```typescript
type RpcResponse =
  // Success with data (varies per command)
  | { id?: string; type: "response"; command: "prompt"; success: true }
  | { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
  | { id?: string; type: "response"; command: "set_model"; success: true; data: Model<any> }
  | { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: Model<any>[] } }
  | { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
  | { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
  // ... all other commands have success responses

  // Error (any command can fail)
  | { id?: string; type: "response"; command: string; success: false; error: string }
```

### Extension UI Protocol

**Requests** (agent → stdout — extension needs user interaction):

```typescript
type RpcExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
```

**Responses** (stdin → agent — user answers extension):

```typescript
type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }     // For select/input/editor
  | { type: "extension_ui_response"; id: string; confirmed: boolean } // For confirm
  | { type: "extension_ui_response"; id: string; cancelled: true }    // Cancelled
```

### RpcClient (programmatic access)

**File**: `src/modes/rpc/rpc-client.ts`

```typescript
class RpcClient {
  constructor(options?: RpcClientOptions)
  async start(): Promise<void>
  async stop(): Promise<void>

  // Event subscription
  onEvent(listener: RpcEventListener): void
  removeEventListener(listener: RpcEventListener): void

  // Typed API methods
  async prompt(message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void>
  async steer(message: string, images?: ImageContent[]): Promise<void>
  async followUp(message: string, images?: ImageContent[]): Promise<void>
  async abort(): Promise<void>
  async newSession(parentSession?: string): Promise<{ cancelled: boolean }>
  async getState(): Promise<RpcSessionState>
  async setModel(provider: string, modelId: string): Promise<Model<any>>
  async cycleModel(): Promise<{ model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null>
  async getAvailableModels(): Promise<{ models: Model<any>[] }>
  async setThinkingLevel(level: ThinkingLevel): Promise<void>
  async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null>
  async compact(customInstructions?: string): Promise<CompactionResult>
  async executeBash(command: string): Promise<BashResult>
  async getSessionStats(): Promise<SessionStats>
  async getMessages(): Promise<AgentMessage[]>
  async getLastAssistantText(): Promise<string | null>
  // ... etc
}
```

---

## 7. Config Format

### Directory Structure

```
~/.pi/agent/
├── auth.json              # API keys & OAuth credentials
├── models.json            # Custom model definitions & provider overrides
├── config.toml            # (Not found - settings are per-project via .pi/settings.json)
└── sessions/
    └── --<encoded-cwd>--/
        ├── 2025-01-15T10-30-00_01961abc.jsonl
        └── 2025-01-16T14-22-00_01962def.jsonl
```

### models.json Format

```json
{
  "providers": {
    "<providerName>": {
      "baseUrl": "https://...",
      "apiKey": "sk-...",
      "api": "openai-completions",
      "headers": { "X-Custom": "value" },
      "authHeader": true,
      "compat": { ... },
      "models": [
        {
          "id": "my-model",
          "name": "My Custom Model",
          "api": "openai-completions",
          "baseUrl": "https://...",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 16384,
          "headers": {},
          "compat": { ... }
        }
      ],
      "modelOverrides": {
        "claude-sonnet-4-20250514": {
          "contextWindow": 256000,
          "cost": { "input": 3.0 },
          "compat": { "supportsLongCacheRetention": true }
        }
      }
    }
  }
}
```

### auth.json

Managed by `AuthStorage`. Contains API keys and OAuth tokens per provider.

### Per-project Settings

Settings are managed by `SettingsManager` which reads from both project-local and global config locations. Key settings include:

- Default provider/model
- Thinking level
- Compaction settings (enabled, threshold)
- Retry settings (enabled, maxRetries, baseDelayMs)
- Steering/follow-up modes
- Shell command prefix
- Image auto-resize
- Theme

---

## 8. Key Type Mappings for xyz-agent

### ThinkingLevel

```typescript
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
```
Note: pi uses `"off"` as a valid level. xyz-agent's `ThinkingLevel` enum may need to include this.

### StopReason

```typescript
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"
```
Mapping to xyz-agent: `"toolUse"` ↔ `"tool_use"`, `"toolUse"` is pi's stop reason for continuing tool loop.

### Message Roles

```typescript
type MessageRole = "user" | "assistant" | "toolResult" | "custom" | "bashExecution"
```
Note: pi uses `"toolResult"` (camelCase). Custom messages have `customType` for extension identification.

### AgentMessage

```typescript
type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | BashExecutionMessage | CompactionSummaryMessage | BranchSummaryMessage
```

### Tool Call Flow

```
LLM response (stopReason: "toolUse", content includes ToolCall blocks)
  → Agent loop executes tools
  → ToolResultMessage added to messages
  → Loop continues (sends messages back to LLM)
  → Until stopReason !== "toolUse"
```

### Session Persistence

- **Append-only JSONL**: entries never modified or deleted
- **Tree structure**: each entry has `id` and `parentId`
- **Leaf pointer**: tracks current position in tree
- **Branching**: moves leaf pointer, doesn't modify history
- **Compaction**: creates summary entry, marks which entries are "kept"
- **Lazy flush**: file not created until first assistant message arrives
