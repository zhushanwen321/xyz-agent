# Backend Architecture: xyz-agent Phase 1 Sidecar

**Date**: 2026-05-06 | **Phase**: P1 (Hello pi) | **Status**: Design

> This document details the Node.js Sidecar architecture — the bridge between the Vue 3 frontend and the pi SDK agent engine.

---

## 1. Sidecar File Dependency Graph

```
sidecar/src/
│
├── index.ts                          # Entry: parse --port, start WS server
│   └──→ server.ts                    # WS server lifecycle + message routing
│         ├──→ session-pool.ts        # Map<sessionId, AgentSession> + CRUD
│         │     └──→ pi-bridge.ts     # createAgentSession() / prompt() / abort() / setModel()
│         │           └──→ [external] @mariozechner/pi-coding-agent
│         │                 ├── createAgentSession()          # sdk.ts
│         │                 ├── AgentSession                  # agent-session.ts
│         │                 │     ├── .prompt()               # send user message
│         │                 │     ├── .abort()                # cancel generation
│         │                 │     ├── .setModel()             # switch model mid-session
│         │                 │     ├── .subscribe()            # event listener
│         │                 │     ├── .dispose()              # cleanup
│         │                 │     ├── .setThinkingLevel()     # adjust thinking
│         │                 │     └── .isStreaming             # check state
│         │                 ├── SessionManager                 # session-manager.ts
│         │                 │     ├── .create(cwd)            # new file-backed session
│         │                 │     ├── .open(path)             # resume existing
│         │                 │     ├── .list(cwd)              # list sessions for cwd
│         │                 │     ├── .listAll()              # list all sessions
│         │                 │     └── .inMemory(cwd)          # no-file session
│         │                 └── ModelRegistry                  # model-registry.ts
│         │                       ├── .create(authStorage)    # load built-in + custom
│         │                       ├── .getAvailable()         # models with auth
│         │                       ├── .find(provider, id)     # lookup by provider+id
│         │                       └── .getApiKeyAndHeaders()  # auth resolution
│         │
│         ├──→ event-adapter.ts      # AgentSessionEvent → WS ServerMessage
│         │     └── reads AgentSessionEvent union type from pi SDK
│         │
│         ├──→ config-store.ts       # Read/write ~/.xyz-agent/config.toml
│         │     └──→ [dep] smol-toml | toml                    # TOML parser
│         │     └──→ AuthStorage.create()                      # pi auth.json bridge
│         │
│         └──→ protocol.ts           # ClientMessage / ServerMessage type defs
│               (shared types, no runtime deps)
│
└── [shared]
    └── protocol.ts is the single source of truth for WS message types
        Frontend copies types from this file (or shares via npm workspace)
```

**Import rules**:
- `protocol.ts` has zero runtime imports (pure types)
- `pi-bridge.ts` is the **only** file that imports from `@mariozechner/pi-coding-agent`
- `event-adapter.ts` imports only types (no runtime pi SDK usage)
- `config-store.ts` may import `AuthStorage` from pi SDK for auth.json interop

---

## 2. pi SDK Integration Architecture

### 2a. Initialization Sequence

Step-by-step from Sidecar process spawn to first session ready:

```
1. Tauri sidecar.rs spawns: node sidecar/dist/index.js --port 9527
   │
2. index.ts: parse --port, call server.start(port)
   │
3. server.ts.start():
   │  3a. config-store.ts: loadConfig()
   │      → Try ~/.xyz-agent/config.toml
   │      → Fallback: ~/.pi/agent/auth.json (if user has pi configured)
   │      → Fallback: env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
   │      → Returns: ConfigResult { providers, defaults }
   │
   │  3b. pi-bridge.ts: initializeBridge(config)
   │      → authStorage = AuthStorage.create(path.join(agentDir, "auth.json"))
   │      → modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath)
   │      → Returns shared { authStorage, modelRegistry } (singleton)
   │
   │  3c. Start WS server on specified port
   │      → Ready for frontend connection
   │
4. Frontend connects via WS
   │
5. Frontend sends: session.list {}
   │  → server.ts routes to session-pool.ts.listSessions()
   │  → SessionManager.listAll() → scans ~/.pi/agent/sessions/*/
   │  → Returns SessionInfo[] → converted to WS session.list response
   │
6. Frontend sends: session.create { cwd: "/Users/user/project" }
   │  → server.ts routes to pi-bridge.ts.createSession({ cwd })
   │  → pi-bridge calls createAgentSession() with:
   │      {
   │        cwd: "/Users/user/project",
   │        authStorage,           // shared from init
   │        modelRegistry,         // shared from init
   │        thinkingLevel: config.defaults.thinking_mode ?? "medium",
   │      }
   │  → pi SDK returns { session, extensionsResult }
   │  → session-pool stores: pool.set(session.sessionId, session)
   │  → Wire events: session.subscribe(adapter) → event-adapter → WS
   │  → Returns WS session.created { sessionId, cwd, label }
   │
7. Session ready. Frontend can now send message.send.
```

**Key singleton objects** (created once at startup, shared across sessions):

| Object | Source | Shared across sessions? |
|--------|--------|------------------------|
| `AuthStorage` | `AuthStorage.create(authPath)` | ✅ Yes |
| `ModelRegistry` | `ModelRegistry.create(authStorage, modelsPath)` | ✅ Yes |
| `AgentSession` | `createAgentSession(options)` | ❌ Per-session |

**`createAgentSession` exact call signature** (from `sdk.ts`):

```typescript
// Minimal P1 usage:
const { session } = await createAgentSession({
  cwd: "/path/to/project",
  authStorage,       // shared AuthStorage instance
  modelRegistry,     // shared ModelRegistry instance
  thinkingLevel: "high",
  // model: undefined → pi auto-resolves from settings or first available
  // sessionManager: undefined → pi creates file-backed session in ~/.pi/agent/sessions/
  // tools: undefined → pi enables default tools (read, bash, edit, write)
});
```

**`createAgentSession` resolution order for model** (when `model` not specified):
1. Restore from existing session data (if resuming)
2. Settings default (`settingsManager.getDefaultProvider()` + `getDefaultModel()`)
3. First available model with configured auth

### 2b. Session Lifecycle

Map each WS protocol message to the exact pi SDK call:

| WS ClientMessage | pi SDK Call | Notes |
|------------------|-------------|-------|
| `session.create { cwd }` | `createAgentSession({ cwd, authStorage, modelRegistry })` | Creates file-backed session in `~/.pi/agent/sessions/` |
| `session.create { cwd, sessionId }` (resume) | `createAgentSession({ cwd, sessionManager: SessionManager.open(path) })` | Opens existing `.jsonl` file |
| `session.delete { sessionId }` | `pool.get(id).dispose()` then delete `.jsonl` file | Dispose releases event listeners |
| `session.list {}` | `SessionManager.listAll()` | Scans all session dirs |
| `session.history { sessionId }` | `session.sessionManager.getEntries()` → convert to `Message[]` | Read JSONL entries, map to frontend types |
| `message.send { sessionId, content }` | `session.prompt(content)` | Triggers agent loop (LLM → tools → LLM...) |
| `message.abort { sessionId }` | `session.abort()` | Cancels current streaming/generation |
| `model.switch { sessionId, modelId }` | `session.setModel(modelRegistry.find(provider, modelId))` | Validates auth before switch |
| `model.list {}` | `modelRegistry.getAvailable()` | Returns models with configured auth |

**`session.prompt()` details**:

```typescript
// From agent-session.ts:
async prompt(text: string, options?: PromptOptions): Promise<void>

// PromptOptions:
interface PromptOptions {
  expandPromptTemplates?: boolean;           // Default: true
  images?: ImageContent[];                   // Image attachments
  streamingBehavior?: "steer" | "followUp";  // Required if already streaming
  source?: InputSource;                      // "interactive" | "extension" | ...
}

// P1 usage: always fresh prompt, no images
await session.prompt("Explain this function");
```

**`session.setModel()` details**:

```typescript
// From agent-session.ts:
async setModel(model: Model<any>): Promise<void>

// P1 usage:
const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");
if (model) {
  await session.setModel(model);  // Validates API key availability
}
```

**Session disposal**:

```typescript
// When deleting a session or shutting down:
session.dispose();  // Disconnects event listeners, invalidates extensions
```

### 2c. Event Conversion Map

The pi SDK emits `AgentSessionEvent` (which extends `AgentEvent`). The `event-adapter.ts` converts these to WS `ServerMessage` types.

#### Source Events: `AgentSessionEvent` Union

```typescript
// From agent-session.ts:
type AgentSessionEvent =
  | AgentEvent                          // Core agent events (see below)
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: ...; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
```

```typescript
// From @mariozechner/pi-agent-core:
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent?: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
```

#### Conversion Table

| pi SDK Event | WS ServerMessage | Conversion Logic |
|---|---|---|
| `{ type: "message_start", message }` where `message.role === "assistant"` | `message.text_delta` | Initial empty text block — sent as first delta with empty string or skipped |
| `{ type: "message_update", message, assistantMessageEvent }` where `assistantMessageEvent.type === "text_delta"` | `{ type: "message.text_delta", payload: { sessionId, delta: event.assistantMessageEvent.delta } }` | Stream text chunk |
| `{ type: "message_update", message, assistantMessageEvent }` where `assistantMessageEvent.type === "thinking_delta"` | `{ type: "message.thinking_delta", payload: { sessionId, delta: event.assistantMessageEvent.delta } }` | Stream thinking chunk |
| `{ type: "message_update", message, assistantMessageEvent }` where `assistantMessageEvent.type === "thinking_start"` | `{ type: "message.thinking_start", payload: { sessionId } }` | Begin thinking block |
| `{ type: "message_update", message, assistantMessageEvent }` where `assistantMessageEvent.type === "thinking_end"` | `{ type: "message.thinking_end", payload: { sessionId, content: event.assistantMessageEvent.content } }` | End thinking block |
| `{ type: "tool_execution_start", toolCallId, toolName, args }` | `{ type: "message.tool_call_start", payload: { sessionId, toolCallId, toolName, input: args } }` | Tool begins |
| `{ type: "tool_execution_update", toolCallId, toolName, partialResult }` | `{ type: "message.tool_call_update", payload: { sessionId, toolCallId, partialOutput: partialResult } }` | Tool partial output (optional P1) |
| `{ type: "tool_execution_end", toolCallId, toolName, result, isError }` | `{ type: "message.tool_call_end", payload: { sessionId, toolCallId, toolName, output: result, isError } }` | Tool completes |
| `{ type: "message_end", message }` where `message.role === "assistant"` | `{ type: "message.complete", payload: { sessionId, stopReason: message.stopReason, usage: message.usage } }` | Generation finished |
| `{ type: "agent_end" }` | (internal, no WS message needed) | Agent loop done |
| `{ type: "auto_retry_start" }` | `{ type: "message.status", payload: { sessionId, status: "retrying", attempt, message: errorMessage } }` | Auto-retry notification |
| `{ type: "compaction_start" }` | `{ type: "message.status", payload: { sessionId, status: "compacting" } }` | Context compression |
| `{ type: "session_info_changed", name }` | (internal, update session list cache) | Session renamed |
| `session.prompt()` throws error | `{ type: "message.error", payload: { sessionId, error: { message, code } } }` | LLM call failure |

#### `AssistantMessageEvent` Sub-event Mapping

The `message_update` event carries an optional `assistantMessageEvent` from the low-level LLM stream. This is the granular streaming data:

| `AssistantMessageEvent.type` | Field Used | WS Output |
|---|---|---|
| `"start"` | `partial` | (skip — empty initial message) |
| `"text_start"` | `contentIndex` | `message.text_start` (new text block) |
| `"text_delta"` | `delta: string` | `message.text_delta { delta }` |
| `"text_end"` | `content: string` | (skip — full content already streamed) |
| `"thinking_start"` | `contentIndex` | `message.thinking_start` |
| `"thinking_delta"` | `delta: string` | `message.thinking_delta { delta }` |
| `"thinking_end"` | `content: string` | `message.thinking_end { content }` |
| `"toolcall_start"` | `contentIndex` | (wait for tool_execution_start from agent loop) |
| `"toolcall_delta"` | `delta: string` | (optional: stream partial tool args) |
| `"toolcall_end"` | `toolCall: ToolCall` | (wait for tool_execution_start) |
| `"done"` | `reason, message` | (skip — message_end handles this) |
| `"error"` | `reason, error` | `message.error { error: { message: error.errorMessage } }` |

**Important**: The `toolcall_start`/`toolcall_end` events from `AssistantMessageEvent` represent LLM output parsing. The `tool_execution_start`/`tool_execution_end` events from `AgentEvent` represent actual tool execution. For the frontend, we care about **execution** events (which include the result), not LLM parsing events.

#### `StopReason` Mapping

| pi SDK `StopReason` | WS Protocol `stopReason` | Meaning |
|---|---|---|
| `"stop"` | `"stop"` | Normal completion |
| `"length"` | `"length"` | Hit max token limit |
| `"toolUse"` | `"tool_use"` | Agent wants to call tools (will continue loop) |
| `"error"` | `"error"` | LLM API error |
| `"aborted"` | `"aborted"` | User cancelled |

#### `Usage` Mapping

```typescript
// pi SDK Usage type:
interface Usage {
  input: number;           // Input tokens
  output: number;          // Output tokens
  cacheRead: number;       // Cache read tokens
  cacheWrite: number;      // Cache write tokens
  totalTokens: number;     // Total
  cost: {
    input: number;         // $ cost
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// WS payload — pass through as-is:
{ sessionId, stopReason, usage: message.usage }
```

---

## 3. Config Management Architecture

### 3a. Config File Format

xyz-agent uses `~/.xyz-agent/config.toml` for its own configuration, while leveraging pi's `~/.pi/agent/auth.json` and `~/.pi/agent/models.json` for provider credentials and model definitions.

```toml
# ~/.xyz-agent/config.toml

[defaults]
model = "anthropic/claude-sonnet-4-20250514"   # provider/modelId format
thinking_mode = "high"                          # off | minimal | low | medium | high | xhigh
temperature = 0.7                               # Future: not used in P1

# Provider API keys — also written to ~/.pi/agent/auth.json for pi CLI compat
# If key exists in auth.json, it takes precedence (pi CLI may have written it)
[providers.anthropic]
api_key = "sk-ant-..."

[providers.openai]
api_key = "sk-..."

[providers.deepseek]
api_key = "sk-..."
```

**Config store responsibilities**:

1. Read `~/.xyz-agent/config.toml` on startup
2. Sync API keys to pi's `~/.pi/agent/auth.json` (so pi CLI can also use them)
3. Read `~/.pi/agent/models.json` for custom model definitions (if any)
4. Provide `getDefaults()`, `getProviders()`, `setProvider()`, `deleteProvider()`

### 3b. Config Priority Chain

```
┌─────────────────────────────────────────────────────┐
│ 1. ~/.xyz-agent/config.toml                         │  ← xyz-agent primary config
│    [providers.anthropic]                            │
│    api_key = "sk-ant-..."                           │
├─────────────────────────────────────────────────────┤
│ 2. ~/.pi/agent/auth.json                            │  ← pi CLI credentials
│    { "anthropic": { "type": "api_key", ... } }      │    (if user already uses pi)
├─────────────────────────────────────────────────────┤
│ 3. Environment variables                            │  ← Fallback
│    ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.          │
├─────────────────────────────────────────────────────┤
│ 4. Hardcoded defaults                               │  ← Last resort
│    model: "anthropic/claude-sonnet-4-20250514"      │
│    thinking_mode: "medium"                          │
└─────────────────────────────────────────────────────┘
```

**Resolution logic in `config-store.ts`**:

```typescript
function resolveApiKey(provider: string): string | undefined {
  // 1. Check xyz-agent config.toml
  const configKey = config.providers?.[provider]?.api_key;
  if (configKey) return configKey;

  // 2. Check pi auth.json (via AuthStorage)
  const authKey = authStorage.get(provider);
  if (authKey?.type === "api_key") return authKey.apiKey;

  // 3. Check environment variables
  const envKey = ENV_KEY_MAP[provider]; // e.g., "anthropic" → "ANTHROPIC_API_KEY"
  if (envKey && process.env[envKey]) return process.env[envKey];

  return undefined;
}
```

### 3c. Config Reading Implementation

**TOML parsing options**:

| Library | Size | Maintenance | Verdict |
|---------|------|-------------|---------|
| `smol-toml` | ~15KB | Active | ✅ **Recommended** — lightweight, spec-compliant, synchronous API |
| `@iarna/toml` | ~45KB | Low activity | Alternative — npm's own TOML parser |
| JSON fallback | 0KB | N/A | Fallback — if TOML parsing fails, try reading as JSON |

**Recommendation**: Use `smol-toml` for its small bundle size and synchronous API (Sidecar doesn't need async config reads).

```typescript
// config-store.ts
import { parse, stringify } from "smol-toml";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const CONFIG_DIR = join(process.env.HOME!, ".xyz-agent");
const CONFIG_FILE = join(CONFIG_DIR, "config.toml");

export interface XyzConfig {
  defaults: {
    model?: string;           // "provider/modelId"
    thinking_mode?: string;   // ThinkingLevel
    temperature?: number;
  };
  providers: Record<string, {
    api_key?: string;
    base_url?: string;
  }>;
}

export function loadConfig(): XyzConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { defaults: {}, providers: {} };
  }
  const content = readFileSync(CONFIG_FILE, "utf-8");
  return parse(content) as unknown as XyzConfig;
}

export function saveConfig(config: XyzConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, stringify(config as any), "utf-8");
}
```

**Syncing to pi auth.json**: When `config.setProvider` is called from the frontend, the Sidecar writes the API key to both `~/.xyz-agent/config.toml` and pi's `~/.pi/agent/auth.json` (via `AuthStorage`), ensuring the pi CLI can also use the same credentials.

---

## 4. WS Protocol Handler Routing

### Routing Table

| ClientMessage | Handler Function | Module | pi SDK Calls | ServerMessage Response(s) |
|---|---|---|---|---|
| `session.create` | `handleSessionCreate()` | `session-pool.ts` | `createAgentSession({ cwd, authStorage, modelRegistry })`, `session.subscribe(adapter)` | `session.created` on success, `error` on failure |
| `session.delete` | `handleSessionDelete()` | `session-pool.ts` | `session.dispose()`, delete `.jsonl` file | `session.deleted` on success, `error` on failure |
| `session.list` | `handleSessionList()` | `session-pool.ts` | `SessionManager.listAll()` | `session.list { sessions: SessionSummary[] }` |
| `session.history` | `handleSessionHistory()` | `session-pool.ts` | `sessionManager.getEntries()`, `buildSessionContext()` | `session.history { sessionId, messages: Message[] }` |
| `message.send` | `handleMessageSend()` | `server.ts` → `pi-bridge.ts` | `session.prompt(content)` | Streaming: `message.text_delta`, `message.thinking_delta`, `message.tool_call_start`, `message.tool_call_end`, then `message.complete` |
| `message.abort` | `handleMessageAbort()` | `server.ts` → `pi-bridge.ts` | `session.abort()` | `message.complete { stopReason: "aborted" }` (via event) |
| `model.list` | `handleModelList()` | `server.ts` | `modelRegistry.getAvailable()` | `model.list { models: ModelInfo[] }` |
| `model.switch` | `handleModelSwitch()` | `server.ts` → `pi-bridge.ts` | `modelRegistry.find(provider, id)`, `session.setModel(model)` | `model.switched { sessionId, modelId }` on success, `message.error` on failure |
| `config.getProviders` | `handleGetProviders()` | `config-store.ts` | `loadConfig()`, `modelRegistry.getProviderAuthStatus()` | `config.providers { providers: ProviderInfo[] }` |
| `config.setProvider` | `handleSetProvider()` | `config-store.ts` | `saveConfig()`, `authStorage.set()`, `modelRegistry.refresh()` | `config.providerUpdated { providerId }` |
| `config.deleteProvider` | `handleDeleteProvider()` | `config-store.ts` | `saveConfig()`, `authStorage.delete()`, `modelRegistry.refresh()` | `config.providerUpdated { providerId }` |
| `ping` | `handlePing()` | `server.ts` | None | `pong {}` |

### Handler Implementation Pattern

Each handler follows this pattern:

```typescript
// server.ts — message routing
function handleMessage(ws: WebSocket, raw: string) {
  const msg = JSON.parse(raw) as ClientMessage;

  switch (msg.type) {
    case "session.create":
      handleSessionCreate(ws, msg.id, msg.payload);
      break;
    case "message.send":
      handleMessageSend(ws, msg.id, msg.payload);
      break;
    // ... etc
  }
}

// session-pool.ts — session creation
async function handleSessionCreate(ws: WebSocket, id: string, payload: { cwd?: string }) {
  try {
    const { session } = await createAgentSession({
      cwd: payload.cwd ?? process.cwd(),
      authStorage,
      modelRegistry,
    });

    // Wire events → event-adapter → WS
    session.subscribe((event) => {
      const serverMsg = adaptEvent(session.sessionId, event);
      if (serverMsg) ws.send(JSON.stringify(serverMsg));
    });

    pool.set(session.sessionId, session);

    sendResponse(ws, id, "session.created", {
      sessionId: session.sessionId,
      cwd: session.agent.state.cwd ?? payload.cwd,
      label: session.sessionName,
    });
  } catch (err) {
    sendError(ws, id, err);
  }
}
```

### Request-Response Correlation

The `id` field in `ClientMessage` is echoed back in the corresponding `ServerMessage`:

```typescript
interface ClientMessage {
  type: string;
  id?: string;       // Client-generated correlation ID
  payload: unknown;
}

interface ServerMessage {
  type: string;
  id?: string;       // Echoed from request (for request-response pairs)
  payload: unknown;
}
```

- **Request-response pairs**: `session.create` → `session.created`, `model.list` → `model.list`, etc.
- **Streaming events** (from agent loop): No `id` — they're pushed independently.
- **Errors**: Include the request `id` so the frontend can show the error context.

---

## 5. Error Handling Strategy

### 5a. Error Classification

```
┌──────────────────────────────────────────────────────────┐
│                    Error Sources                          │
├──────────────────┬───────────────────────────────────────┤
│ pi SDK errors    │ LLM API failures, auth errors,        │
│                  │ rate limits, context overflow          │
├──────────────────┼───────────────────────────────────────┤
│ Sidecar internal │ Config parse errors, file I/O,        │
│                  │ session corruption                     │
├──────────────────┼───────────────────────────────────────┤
│ Network errors   │ WS disconnection, timeout             │
├──────────────────┼───────────────────────────────────────┤
│ User errors      │ Invalid message format, missing       │
│                  │ sessionId, unknown model               │
└──────────────────┴───────────────────────────────────────┘
```

### 5b. Error Handling by Layer

#### pi SDK Errors → Frontend Toast

```typescript
// event-adapter.ts — catches agent errors
session.subscribe((event) => {
  // Auto-retry events
  if (event.type === "auto_retry_start") {
    sendToWs(ws, {
      type: "message.status",
      payload: {
        sessionId,
        status: "retrying",
        message: `Retrying (${event.attempt}/${event.maxAttempts})...`,
      },
    });
    return;
  }

  // message_end with error stopReason
  if (event.type === "message_end" && event.message.role === "assistant") {
    if (event.message.stopReason === "error") {
      sendToWs(ws, {
        type: "message.error",
        payload: {
          sessionId,
          error: {
            message: event.message.errorMessage ?? "Unknown error",
            code: "LLM_ERROR",
          },
        },
      });
      return;
    }
  }
});

// prompt() throws
try {
  await session.prompt(text);
} catch (err) {
  sendToWs(ws, {
    type: "message.error",
    payload: {
      sessionId,
      error: {
        message: err instanceof Error ? err.message : String(err),
        code: classifyErrorCode(err),  // → "AUTH_ERROR" | "RATE_LIMIT" | "NETWORK" | "UNKNOWN"
      },
    },
  });
}
```

**Error code classification**:

| Code | Condition | Frontend Action |
|------|-----------|-----------------|
| `AUTH_ERROR` | 401/403 from provider, `ok: false` from `getApiKeyAndHeaders` | Toast + redirect to Settings |
| `RATE_LIMIT` | 429 from provider | Toast with "try later" message |
| `CONTEXT_OVERFLOW` | `isContextOverflow(error)` returns true | Toast + suggest compaction |
| `NETWORK` | Connection timeout, DNS failure | Toast + show reconnect status |
| `NO_MODEL` | No model available with configured auth | Toast + redirect to Settings |
| `LLM_ERROR` | Generic LLM failure | Toast with error message |
| `INVALID_SESSION` | Session ID not found in pool | Toast + refresh session list |
| `INVALID_CONFIG` | TOML parse error, malformed config | Toast + use defaults |

#### WS Disconnection → Frontend Auto-Reconnect

```typescript
// Frontend: ws-client.ts
const RECONNECT_INTERVALS = [1000, 2000, 4000, 8000, 16000]; // Exponential backoff

class WsClient {
  private reconnectAttempt = 0;

  connect() {
    this.ws = new WebSocket(`ws://localhost:${port}`);

    this.ws.onclose = () => {
      // Notify UI: Statusbar shows "Disconnected"
      eventBus.emit("connection.status", { status: "disconnected" });
      this.scheduleReconnect();
    };

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      eventBus.emit("connection.status", { status: "connected" });
    };
  }

  private scheduleReconnect() {
    const delay = RECONNECT_INTERVALS[Math.min(this.reconnectAttempt, RECONNECT_INTERVALS.length - 1)];
    setTimeout(() => {
      this.reconnectAttempt++;
      this.connect();
    }, delay);
  }
}
```

#### Sidecar Crash → Tauri Restart

```rust
// src-tauri/src/sidecar.rs
// Tauri monitors the sidecar child process:
// - On unexpected exit (non-zero code): restart with backoff
// - On SIGTERM from Tauri shutdown: graceful stop (don't restart)
// - Health check: periodic ping over stdin/stdout or WS ping/pong
```

#### Invalid Config → Graceful Error

```typescript
// config-store.ts
export function loadConfig(): XyzConfig {
  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return parse(content) as unknown as XyzConfig;
  } catch (err) {
    // Log warning, return defaults (app still works with env vars)
    console.warn(`Failed to parse ${CONFIG_FILE}:`, err);
    return { defaults: {}, providers: {} };
  }
}
```

#### API Key Invalid → Specific Error

```typescript
// pi-bridge.ts
async function validateApiKey(provider: string): Promise<{ valid: boolean; error?: string }> {
  const models = modelRegistry.getAvailable().filter(m => m.provider === provider);
  if (models.length === 0) {
    // No models with configured auth for this provider
    return { valid: false, error: `No API key configured for ${provider}` };
  }

  // Try to resolve API key
  const auth = await modelRegistry.getApiKeyAndHeaders(models[0]);
  if (!auth.ok) {
    return { valid: false, error: auth.error };
  }

  return { valid: true };
}
```

### 5c. Error Flow Summary

```
pi SDK throws / emits error
  → event-adapter.ts catches
  → Classifies error code
  → Sends WS: { type: "message.error", payload: { sessionId, error: { message, code } } }
  → Frontend ws-client.ts receives
  → event-bus.ts dispatches
  → useChat composable processes
  → Shows toast (vue-sonner) with:
     - AUTH_ERROR: "API key invalid. Please check Settings → Providers."
     - RATE_LIMIT: "Rate limited. Please wait and try again."
     - Others: Generic error message
```

---

## 6. Session History Format

### 6a. pi Session Entry Types → Frontend Message Types

pi stores sessions as JSONL (append-only tree). Each line is a `SessionEntry`. The sidecar reads these entries and converts them to the frontend `Message` format.

**pi Session Entry Types**:

| Entry Type | pi Structure | Frontend Type |
|---|---|---|
| `session` (header) | `{ type: "session", id, cwd, timestamp }` | (metadata, not displayed) |
| `message` (user) | `{ type: "message", message: { role: "user", content: "...", timestamp } }` | `Message { role: "user", content: string, timestamp }` |
| `message` (assistant) | `{ type: "message", message: { role: "assistant", content: [...], stopReason, usage } }` | `Message { role: "assistant", content: ContentBlock[], ... }` |
| `message` (toolResult) | `{ type: "message", message: { role: "toolResult", toolCallId, content, isError } }` | `ToolResult { toolCallId, output, isError }` |
| `thinking_level_change` | `{ type: "thinking_level_change", thinkingLevel }` | (metadata, not displayed) |
| `model_change` | `{ type: "model_change", provider, modelId }` | (metadata, not displayed) |
| `compaction` | `{ type: "compaction", summary, tokensBefore }` | (internal, shown as system message) |

### 6b. Assistant Message Content Block Mapping

An assistant message has `content: (TextContent | ThinkingContent | ToolCall)[]`. Each content block maps to a specific frontend component:

```typescript
// pi SDK content blocks:
type ContentBlock = TextContent | ThinkingContent | ToolCall;

interface TextContent {
  type: "text";
  text: string;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

**Frontend mapping**:

| pi Content Block | Frontend Rendering | Component |
|---|---|---|
| `{ type: "text", text: "..." }` | `MessageBubble` → Markdown rendered | `StreamingText.vue` |
| `{ type: "thinking", thinking: "..." }` | `ThinkingBlock` → Collapsed by default | `ThinkingBlock.vue` |
| `{ type: "toolCall", id, name, arguments }` | `ToolCallCard` → Name + args summary | `ToolCallCard.vue` |

### 6c. Conversion Function

```typescript
// session-pool.ts or dedicated history-adapter.ts

interface FrontendMessage {
  id: string;
  role: "user" | "assistant" | "system";
  timestamp: number;
  content?: string;
  contentBlocks?: ContentBlock[];
  toolCalls?: FrontendToolCall[];
  thinking?: string;
  usage?: Usage;
  stopReason?: string;
}

interface FrontendToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

function convertHistory(entries: SessionEntry[]): FrontendMessage[] {
  const messages: FrontendMessage[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = (entry as SessionMessageEntry).message;

    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");

      messages.push({
        id: entry.id,
        role: "user",
        timestamp: msg.timestamp,
        content: text,
      });
    }

    if (msg.role === "assistant") {
      const contentBlocks = msg.content;
      const textBlocks = contentBlocks.filter(c => c.type === "text") as TextContent[];
      const thinkingBlocks = contentBlocks.filter(c => c.type === "thinking") as ThinkingContent[];
      const toolCallBlocks = contentBlocks.filter(c => c.type === "toolCall") as ToolCall[];

      messages.push({
        id: entry.id,
        role: "assistant",
        timestamp: msg.timestamp,
        content: textBlocks.map(b => b.text).join(""),
        thinking: thinkingBlocks.map(b => b.thinking).join(""),
        toolCalls: toolCallBlocks.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          // output will be filled from subsequent toolResult entries
        })),
        usage: msg.usage,
        stopReason: msg.stopReason,
      });
    }

    if (msg.role === "toolResult") {
      // Find the matching assistant message's toolCall and fill in the result
      const lastAssistant = findLast(messages, m => m.role === "assistant");
      if (lastAssistant?.toolCalls) {
        const tc = lastAssistant.toolCalls.find(t => t.id === msg.toolCallId);
        if (tc) {
          const outputText = msg.content
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join("\n");
          tc.output = outputText;
          tc.isError = msg.isError;
        }
      }
    }
  }

  return messages;
}
```

### 6d. Handling Incomplete Entries (Streaming in Progress)

When the user requests `session.history` for an active session that is currently streaming:

1. **Entries in JSONL file**: These are complete (flushed to disk by `SessionManager`).
2. **Current streaming message**: Not yet in the JSONL file. The `AgentSession` holds it in memory via `session.messages`.

Strategy:
- Read JSONL entries → convert to `FrontendMessage[]` (complete history)
- If `session.isStreaming` is true, also read `session.messages` (in-memory) and append the partial assistant message
- The partial message will have `contentBlocks` that are still being built (text may be partial, tool calls may be in-progress)
- Frontend handles this gracefully: `StreamingText.vue` renders partial text, `ToolCallCard.vue` shows spinner for in-progress tools

```typescript
async function handleSessionHistory(ws: WebSocket, id: string, payload: { sessionId: string }) {
  const session = pool.get(payload.sessionId);
  if (!session) { sendError(ws, id, "Session not found"); return; }

  const entries = session.sessionManager.getEntries();
  const history = convertHistory(entries);

  // If currently streaming, append live message
  if (session.isStreaming) {
    const liveMessages = session.messages;
    const lastAssistant = liveMessages.filter(m => m.role === "assistant").pop();
    if (lastAssistant) {
      history.push(convertAssistantMessage(lastAssistant));
    }
  }

  sendResponse(ws, id, "session.history", {
    sessionId: payload.sessionId,
    messages: history,
  });
}
```

### 6e. Session List Summary

`SessionManager.listAll()` returns `SessionInfo[]` which is already structured for the frontend:

```typescript
// pi SDK SessionInfo:
interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

// Convert to WS session.list format:
interface SessionSummary {
  id: string;
  cwd: string;
  label: string;          // name ?? firstMessage ?? "New Session"
  lastActivity: string;   // ISO timestamp from modified
  messageCount: number;
  isActive: boolean;      // true if session exists in pool
}
```

The frontend groups `SessionSummary[]` by `cwd` for the sidebar display.

---

## Appendix A: pi SDK Key Types Quick Reference

```typescript
// Thinking levels
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

// Stop reasons
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// Message roles
type MessageRole = "user" | "assistant" | "toolResult" | "custom" | "bashExecution";

// Agent message types
type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | BashExecutionMessage | CompactionSummaryMessage | BranchSummaryMessage;

// Model ID format: "provider/modelId" (e.g., "anthropic/claude-sonnet-4-20250514")
```

## Appendix B: File Locations

| File | Path | Purpose |
|------|------|---------|
| xyz-agent config | `~/.xyz-agent/config.toml` | User preferences, provider keys |
| pi auth store | `~/.pi/agent/auth.json` | API keys (shared with pi CLI) |
| pi models | `~/.pi/agent/models.json` | Custom model definitions |
| pi sessions | `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | Session history files |
| pi settings | `.pi/settings.json` (per-project) | Project-local settings |

## Appendix C: Sidecar Startup Checklist

```
☐ 1. Parse CLI args (--port, --agent-dir)
☐ 2. Ensure ~/.xyz-agent/ directory exists
☐ 3. Load config from ~/.xyz-agent/config.toml
☐ 4. Create AuthStorage (pointing to ~/.pi/agent/auth.json)
☐ 5. Create ModelRegistry (pointing to ~/.pi/agent/models.json)
☐ 6. Start WS server on specified port
☐ 7. Register message handlers (routing table)
☐ 8. Log: "Sidecar ready on ws://localhost:{port}"
☐ 9. Wait for frontend connection
```
