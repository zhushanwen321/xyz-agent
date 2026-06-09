# Task 4: Communication Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the WebSocket communication layer between Vue frontend and Node.js Sidecar. Define typed protocol, implement WS client with reconnect/heartbeat, Sidecar WS server with message routing, and skeleton modules.

**Dependencies:** Task 1 complete (project scaffold with `sidecar/` dir and `src/types/` dir exist)

**Commit strategy:** 4 sub-tasks, commit after each.

---

## File Structure

```
# Frontend
src/types/protocol.ts      # 4A — WS protocol message types
src/types/message.ts       # 4A — Message, ToolCall, ThinkingBlock
src/types/session.ts       # 4A — SessionSummary, SessionGroup
src/types/provider.ts      # 4A — ProviderInfo, ModelInfo
src/lib/event-bus.ts       # 4B — Typed event emitter
src/lib/ws-client.ts       # 4B — Singleton WS client with reconnect/heartbeat
src/lib/protocol.ts        # 4B — Re-export from types/protocol.ts

# Sidecar
sidecar/src/protocol.ts    # 4C — Shared protocol types (mirrors frontend)
sidecar/src/index.ts       # 4C — Entry point: parse --port, start server
sidecar/src/server.ts      # 4C — WS server, message routing, heartbeat
sidecar/src/session-pool.ts # 4D — Session pool Map<id, SessionData>
sidecar/src/pi-bridge.ts   # 4D — pi SDK interface with stub/mock impl
sidecar/src/event-adapter.ts # 4D — Internal events → ServerMessage conversion
sidecar/src/config-store.ts  # 4D — Config read/write from ~/.xyz-agent/
```

---

## 4A. Protocol Types

**Commit:** `feat(p1): protocol types — message, session, provider, protocol`

### Step 1: Create `src/types/protocol.ts`

- [ ] Create `src/types/protocol.ts` with the full protocol type definitions

```typescript
// src/types/protocol.ts
// ── Client → Sidecar message types ──────────────────────

export type ClientMessageType =
  | 'session.create'
  | 'session.delete'
  | 'session.list'
  | 'session.switch'
  | 'session.history'
  | 'message.send'
  | 'message.abort'
  | 'config.getProviders'
  | 'config.setProvider'
  | 'config.deleteProvider'
  | 'model.list'
  | 'model.switch'
  | 'ping'

export interface ClientMessage {
  type: ClientMessageType
  id?: string
  payload: Record<string, unknown>
}

// ── Sidecar → Client message types ──────────────────────

export type ServerMessageType =
  | 'session.created'
  | 'session.deleted'
  | 'session.list'
  | 'session.history'
  | 'message.text_delta'
  | 'message.thinking_delta'
  | 'message.tool_call_start'
  | 'message.tool_call_end'
  | 'message.complete'
  | 'message.error'
  | 'config.providers'
  | 'config.providerUpdated'
  | 'model.list'
  | 'model.switched'
  | 'pong'
  | 'error'

export interface ServerMessage {
  type: ServerMessageType
  id?: string
  payload: Record<string, unknown>
}

// ── Payload type helpers (narrowed payload shapes) ──────

// Client payload shapes (for type-safe send calls)
export interface SessionCreatePayload {
  cwd?: string
}

export interface SessionDeletePayload {
  sessionId: string
}

export interface SessionSwitchPayload {
  sessionId: string
}

export interface SessionHistoryPayload {
  sessionId: string
}

export interface MessageSendPayload {
  sessionId: string
  content: string
}

export interface MessageAbortPayload {
  sessionId: string
}

export interface SetProviderPayload {
  providerId: string
  apiKey?: string
  baseUrl?: string
}

export interface DeleteProviderPayload {
  providerId: string
}

export interface ModelSwitchPayload {
  sessionId: string
  modelId: string
}

// Server payload shapes (for type-safe event handling)
export interface SessionCreatedPayload {
  sessionId: string
  label: string
  cwd: string
}

export interface SessionDeletedPayload {
  sessionId: string
}

export interface SessionListPayload {
  groups: Array<{
    cwd: string
    sessions: Array<{
      id: string
      label: string
      cwd: string
      status: string
      lastActiveAt: string
      modelId: string
      tokenCount: number
    }>
  }>
}

export interface SessionHistoryPayload {
  sessionId: string
  messages: unknown[]
}

export interface TextDeltaPayload {
  sessionId: string
  delta: string
}

export interface ThinkingDeltaPayload {
  sessionId: string
  delta: string
}

export interface ToolCallStartPayload {
  sessionId: string
  toolCallId: string
  toolName: string
  input: unknown
}

export interface ToolCallEndPayload {
  sessionId: string
  toolCallId: string
  output: string
}

export interface MessageCompletePayload {
  sessionId: string
  stopReason: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

export interface MessageErrorPayload {
  sessionId: string
  error: string
}

export interface ProvidersPayload {
  providers: Array<{
    id: string
    name: string
    status: string
    models: string[]
    apiKeySet: boolean
    baseUrl?: string
  }>
}

export interface ProviderUpdatedPayload {
  providerId: string
}

export interface ModelListPayload {
  models: Array<{
    id: string
    name: string
    providerId: string
    providerName: string
  }>
}

export interface ModelSwitchedPayload {
  sessionId: string
  modelId: string
}

export interface ErrorPayload {
  message: string
  code?: string
}
```

### Step 2: Create `src/types/message.ts`

- [ ] Create `src/types/message.ts` with Message, ToolCall, ThinkingBlock types

```typescript
// src/types/message.ts

export type MessageRole = 'user' | 'assistant'

export type MessageStatus = 'streaming' | 'complete' | 'error'

export interface ToolCall {
  id: string
  toolName: string
  input: unknown
  output?: string
  status: 'running' | 'done' | 'error'
  startTime: number
  endTime?: number
}

export interface ThinkingBlock {
  id: string
  content: string
  collapsed: boolean
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  status: MessageStatus
  toolCalls?: ToolCall[]
  thinking?: ThinkingBlock[]
  usage?: Usage
  timestamp: number
}
```

### Step 3: Create `src/types/session.ts`

- [ ] Create `src/types/session.ts` with SessionSummary and SessionGroup types

```typescript
// src/types/session.ts

export type SessionStatus = 'active' | 'idle'

export interface SessionSummary {
  id: string
  label: string
  cwd: string
  status: SessionStatus
  lastActiveAt: string
  modelId: string
  tokenCount: number
}

export interface SessionGroup {
  cwd: string
  sessions: SessionSummary[]
}
```

### Step 4: Create `src/types/provider.ts`

- [ ] Create `src/types/provider.ts` with ProviderInfo and ModelInfo types

```typescript
// src/types/provider.ts

export type ProviderStatus = 'connected' | 'not_configured' | 'error'

export interface ProviderInfo {
  id: string
  name: string
  status: ProviderStatus
  models: string[]
  apiKeySet: boolean
  baseUrl?: string
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
}
```

### Step 5: Update `src/types/index.ts`

- [ ] Add re-exports from the new type files to `src/types/index.ts`

```typescript
// Add these lines to src/types/index.ts:
export * from './protocol'
export * from './message'
export * from './session'
export * from './provider'
```

---

## 4B. Frontend WS Client

**Commit:** `feat(p1): ws-client + event-bus — typed WS client with reconnect/heartbeat`

### Step 6: Create `src/lib/event-bus.ts`

- [ ] Create `src/lib/event-bus.ts` — typed event emitter mapping ServerMessageType to handlers

```typescript
// src/lib/event-bus.ts
import type {
  ServerMessageType,
  ServerMessage,
} from '@/types/protocol'

type EventHandler<T = ServerMessage> = (message: T) => void

/**
 * Typed event bus for WS server messages.
 * Each ServerMessageType maps to a set of handlers.
 */
class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()

  on(event: ServerMessageType, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler)
    }
  }

  off(event: ServerMessageType, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler)
  }

  emit(message: ServerMessage): void {
    const handlers = this.handlers.get(message.type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message)
        } catch (err) {
          console.error(`[EventBus] handler error for "${message.type}":`, err)
        }
      }
    }
  }

  /** Subscribe to ALL server messages (useful for logging/debugging) */
  onAny(handler: EventHandler): () => void {
    // We use a special key for wildcard listeners
    const key = '*'
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set())
    }
    this.handlers.get(key)!.add(handler)
    return () => {
      this.handlers.get(key)?.delete(handler)
    }
  }

  /** Remove all handlers */
  clear(): void {
    this.handlers.clear()
  }
}

export const eventBus = new EventBus()
```

### Step 7: Create `src/lib/ws-client.ts`

- [ ] Create `src/lib/ws-client.ts` — singleton WS client with auto-reconnect and heartbeat

```typescript
// src/lib/ws-client.ts
import type { ClientMessage, ServerMessage } from '@/types/protocol'
import { eventBus } from './event-bus'

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'

type ConnectionListener = (state: ConnectionState) => void

const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 30000
const PING_INTERVAL = 30000
const PONG_TIMEOUT = 10000

class WsClient {
  private ws: WebSocket | null = null
  private url = ''
  private state: ConnectionState = 'disconnected'
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private connectionListeners = new Set<ConnectionListener>()
  private intentionalClose = false
  private messageId = 0

  /** Connect to the Sidecar WS server */
  connect(url: string): void {
    if (this.ws && (this.state === 'connected' || this.state === 'connecting')) {
      return
    }

    this.url = url
    this.intentionalClose = false
    this.setState('connecting')
    this.doConnect()
  }

  /** Send a typed client message */
  send(message: Omit<ClientMessage, 'id'>): string {
    const id = `msg_${++this.messageId}_${Date.now()}`
    const full: ClientMessage = { ...message, id }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(full))
    } else {
      console.warn('[WsClient] cannot send, ws not open:', full.type)
    }

    return id
  }

  /** Disconnect from server */
  disconnect(): void {
    this.intentionalClose = true
    this.cleanup()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState('disconnected')
  }

  /** Get current connection state */
  getState(): ConnectionState {
    return this.state
  }

  /** Subscribe to connection state changes */
  onStateChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  // ── Private ──────────────────────────────────────────

  private doConnect(): void {
    try {
      this.ws = new WebSocket(this.url)
    } catch (err) {
      console.error('[WsClient] WebSocket constructor failed:', err)
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      console.info('[WsClient] connected to', this.url)
      this.reconnectAttempts = 0
      this.setState('connected')
      this.startHeartbeat()
    }

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const message: ServerMessage = JSON.parse(String(event.data))

        // Handle pong internally
        if (message.type === 'pong') {
          this.clearPongTimer()
          return
        }

        eventBus.emit(message)
      } catch (err) {
        console.error('[WsClient] failed to parse message:', err)
      }
    }

    this.ws.onclose = (event: CloseEvent) => {
      console.info('[WsClient] closed:', event.code, event.reason)
      this.cleanup()
      this.ws = null

      if (!this.intentionalClose) {
        this.setState('reconnecting')
        this.scheduleReconnect()
      } else {
        this.setState('disconnected')
      }
    }

    this.ws.onerror = (event: Event) => {
      console.error('[WsClient] error:', event)
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY
    )
    this.reconnectAttempts++

    console.info(`[WsClient] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.setState('connecting')
      this.doConnect()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()

    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', payload: {} }))

        // Set pong timeout
        this.pongTimer = setTimeout(() => {
          console.warn('[WsClient] pong timeout, closing connection')
          this.ws?.close()
        }, PONG_TIMEOUT)
      }
    }, PING_INTERVAL)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.clearPongTimer()
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private cleanup(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.connectionListeners) {
      try {
        listener(state)
      } catch (err) {
        console.error('[WsClient] state listener error:', err)
      }
    }
  }
}

/** Singleton instance */
export const wsClient = new WsClient()
```

### Step 8: Create `src/lib/protocol.ts`

- [ ] Create `src/lib/protocol.ts` — convenience re-export

```typescript
// src/lib/protocol.ts
// Re-export protocol types for convenient import from lib/
export type {
  ClientMessage,
  ClientMessageType,
  ServerMessage,
  ServerMessageType,
  // Payload types
  SessionCreatePayload,
  SessionDeletePayload,
  SessionSwitchPayload,
  SessionHistoryPayload,
  MessageSendPayload,
  MessageAbortPayload,
  SetProviderPayload,
  DeleteProviderPayload,
  ModelSwitchPayload,
  SessionCreatedPayload,
  SessionDeletedPayload,
  SessionListPayload,
  TextDeltaPayload,
  ThinkingDeltaPayload,
  ToolCallStartPayload,
  ToolCallEndPayload,
  MessageCompletePayload,
  MessageErrorPayload,
  ProvidersPayload,
  ProviderUpdatedPayload,
  ModelListPayload,
  ModelSwitchedPayload,
  ErrorPayload,
} from '@/types/protocol'
```

---

## 4C. Sidecar WS Server

**Commit:** `feat(p1): sidecar ws server — entry point, server, protocol types`

### Step 9: Create `sidecar/package.json`

- [ ] Create `sidecar/package.json`

```json
{
  "name": "xyz-agent-sidecar",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.18.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0"
  }
}
```

### Step 10: Create `sidecar/tsconfig.json`

- [ ] Create `sidecar/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

### Step 11: Create `sidecar/src/protocol.ts`

- [ ] Create `sidecar/src/protocol.ts` — mirrors frontend protocol types

```typescript
// sidecar/src/protocol.ts
// Shared protocol types — must stay in sync with src/types/protocol.ts

export type ClientMessageType =
  | 'session.create'
  | 'session.delete'
  | 'session.list'
  | 'session.switch'
  | 'session.history'
  | 'message.send'
  | 'message.abort'
  | 'config.getProviders'
  | 'config.setProvider'
  | 'config.deleteProvider'
  | 'model.list'
  | 'model.switch'
  | 'ping'

export interface ClientMessage {
  type: ClientMessageType
  id?: string
  payload: Record<string, unknown>
}

export type ServerMessageType =
  | 'session.created'
  | 'session.deleted'
  | 'session.list'
  | 'session.history'
  | 'message.text_delta'
  | 'message.thinking_delta'
  | 'message.tool_call_start'
  | 'message.tool_call_end'
  | 'message.complete'
  | 'message.error'
  | 'config.providers'
  | 'config.providerUpdated'
  | 'model.list'
  | 'model.switched'
  | 'pong'
  | 'error'

export interface ServerMessage {
  type: ServerMessageType
  id?: string
  payload: Record<string, unknown>
}

/** Helper to create a ServerMessage */
export function serverMessage(
  type: ServerMessageType,
  payload: Record<string, unknown> = {},
  id?: string
): ServerMessage {
  const msg: ServerMessage = { type, payload }
  if (id !== undefined) {
    msg.id = id
  }
  return msg
}
```

### Step 12: Create `sidecar/src/index.ts`

- [ ] Create `sidecar/src/index.ts` — entry point

```typescript
// sidecar/src/index.ts
import { startServer } from './server'

function parseArgs(): { port: number } {
  const args = process.argv.slice(2)
  let port = 17777 // default port

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${args[i + 1]}`)
        process.exit(1)
      }
      i++
    }
  }

  return { port }
}

async function main() {
  const { port } = parseArgs()
  console.info(`[sidecar] starting on port ${port}`)
  await startServer(port)
}

main().catch((err) => {
  console.error('[sidecar] fatal:', err)
  process.exit(1)
})
```

### Step 13: Create `sidecar/src/server.ts`

- [ ] Create `sidecar/src/server.ts` — WS server with message routing and heartbeat

```typescript
// sidecar/src/server.ts
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from './protocol'
import { serverMessage } from './protocol'

interface RouteHandler {
  (msg: ClientMessage, send: (msg: ServerMessage) => void): Promise<void>
}

let client: WebSocket | null = null
const routes = new Map<string, RouteHandler>()

/** Register a message handler for a given client message type */
export function onMessage(type: string, handler: RouteHandler): void {
  routes.set(type, handler)
}

/** Send a message to the connected client */
function sendToClient(msg: ServerMessage): void {
  if (client?.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(msg))
  }
}

/** Start the WS server */
export async function startServer(port: number): Promise<void> {
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws: WebSocket) => {
    if (client?.readyState === WebSocket.OPEN) {
      console.warn('[server] rejecting additional client, only one allowed')
      ws.close(4001, 'only one client allowed')
      return
    }

    client = ws
    console.info('[server] client connected')

    ws.on('message', (raw: Buffer) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        sendToClient(serverMessage('error', { message: 'invalid JSON' }))
        return
      }

      // Handle ping internally
      if (msg.type === 'ping') {
        sendToClient(serverMessage('pong', {}, msg.id))
        return
      }

      // Route to registered handler
      const handler = routes.get(msg.type)
      if (handler) {
        handler(msg, sendToClient).catch((err) => {
          console.error(`[server] handler error for "${msg.type}":`, err)
          sendToClient(
            serverMessage('error', {
              message: err instanceof Error ? err.message : String(err),
            }, msg.id)
          )
        })
      } else {
        console.warn(`[server] no handler for "${msg.type}"`)
        sendToClient(
          serverMessage('error', { message: `unknown message type: ${msg.type}` }, msg.id)
        )
      }
    })

    ws.on('close', () => {
      console.info('[server] client disconnected')
      client = null
    })

    ws.on('error', (err: Error) => {
      console.error('[server] ws error:', err)
    })
  })

  return new Promise((resolve) => {
    wss.on('listening', () => {
      console.info(`[server] listening on ws://localhost:${port}`)
      resolve()
    })
  })
}
```

### Step 14: Verify sidecar compiles

- [ ] Run `cd sidecar && npm install && npx tsc --noEmit` to verify compilation

---

## 4D. Sidecar Skeleton Modules

**Commit:** `feat(p1): sidecar skeletons — session-pool, pi-bridge, event-adapter, config-store`

### Step 15: Create `sidecar/src/session-pool.ts`

- [ ] Create `sidecar/src/session-pool.ts` — in-memory session pool with CRUD

```typescript
// sidecar/src/session-pool.ts
import { randomUUID } from 'crypto'

export interface SessionData {
  id: string
  label: string
  cwd: string
  status: 'active' | 'idle'
  lastActiveAt: string
  modelId: string
  tokenCount: number
  createdAt: string
}

const sessions = new Map<string, SessionData>()

/** Create a new session */
export function createSession(cwd?: string): SessionData {
  const session: SessionData = {
    id: randomUUID(),
    label: 'New Session',
    cwd: cwd ?? process.cwd(),
    status: 'active',
    lastActiveAt: new Date().toISOString(),
    modelId: '',
    tokenCount: 0,
    createdAt: new Date().toISOString(),
  }
  sessions.set(session.id, session)
  return session
}

/** Get a session by ID */
export function getSession(id: string): SessionData | undefined {
  return sessions.get(id)
}

/** Delete a session by ID */
export function deleteSession(id: string): boolean {
  return sessions.delete(id)
}

/** List all sessions, sorted by lastActiveAt descending */
export function listSessions(): SessionData[] {
  return Array.from(sessions.values()).sort(
    (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  )
}

/** Update session fields */
export function updateSession(
  id: string,
  updates: Partial<Pick<SessionData, 'label' | 'status' | 'lastActiveAt' | 'modelId' | 'tokenCount'>>
): SessionData | undefined {
  const session = sessions.get(id)
  if (!session) return undefined
  Object.assign(session, updates, { lastActiveAt: new Date().toISOString() })
  return session
}

/** Group sessions by cwd */
export function groupSessionsByCwd(): Array<{ cwd: string; sessions: SessionData[] }> {
  const groups = new Map<string, SessionData[]>()

  for (const session of listSessions()) {
    const existing = groups.get(session.cwd)
    if (existing) {
      existing.push(session)
    } else {
      groups.set(session.cwd, [session])
    }
  }

  return Array.from(groups.entries()).map(([cwd, sessions]) => ({ cwd, sessions }))
}
```

### Step 16: Create `sidecar/src/pi-bridge.ts`

- [ ] Create `sidecar/src/pi-bridge.ts` — pi SDK interface with stub implementations

```typescript
// sidecar/src/pi-bridge.ts
// Interface for pi SDK interactions.
// Stub implementations for now — real pi SDK wiring in Task 10.

export interface PiBridgeEvents {
  onTextDelta: (sessionId: string, delta: string) => void
  onThinkingDelta: (sessionId: string, delta: string) => void
  onToolCallStart: (sessionId: string, toolCallId: string, toolName: string, input: unknown) => void
  onToolCallEnd: (sessionId: string, toolCallId: string, output: string) => void
  onComplete: (sessionId: string, stopReason: string, usage: { inputTokens: number; outputTokens: number }) => void
  onError: (sessionId: string, error: string) => void
}

export interface PiBridge {
  /** Create a new agent session */
  createSession(cwd: string): Promise<{ sessionId: string }>

  /** Send a user message and stream responses */
  sendMessage(sessionId: string, content: string): Promise<void>

  /** Abort current generation */
  abort(sessionId: string): Promise<void>

  /** Switch model for a session */
  switchModel(sessionId: string, modelId: string): Promise<void>

  /** List available models */
  listModels(): Promise<Array<{ id: string; name: string; providerId: string; providerName: string }>>
}

/**
 * Stub implementation for development.
 * Returns mock data simulating pi SDK behavior.
 */
export function createStubBridge(events: PiBridgeEvents): PiBridge {
  return {
    async createSession(cwd: string) {
      return { sessionId: `stub-${Date.now()}` }
    },

    async sendMessage(sessionId: string, content: string) {
      // Simulate streaming response
      const words = ['Hello', ' from', ' stub', ' pi-bridge', '!']
      for (const word of words) {
        await delay(100)
        events.onTextDelta(sessionId, word)
      }
      events.onComplete(sessionId, 'end_turn', { inputTokens: 10, outputTokens: words.length })
    },

    async abort(sessionId: string) {
      console.info(`[pi-bridge:stub] abort session=${sessionId}`)
    },

    async switchModel(sessionId: string, modelId: string) {
      console.info(`[pi-bridge:stub] switch session=${sessionId} model=${modelId}`)
    },

    async listModels() {
      return [
        { id: 'claude-sonnet', name: 'Claude Sonnet', providerId: 'anthropic', providerName: 'Anthropic' },
        { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai', providerName: 'OpenAI' },
      ]
    },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

### Step 17: Create `sidecar/src/event-adapter.ts`

- [ ] Create `sidecar/src/event-adapter.ts` — convert internal events to ServerMessage

```typescript
// sidecar/src/event-adapter.ts
import type { ServerMessage } from './protocol'
import { serverMessage } from './protocol'
import type { PiBridgeEvents } from './pi-bridge'

/**
 * Creates a PiBridgeEvents implementation that converts
 * internal pi events into ServerMessage format and sends them
 * to the client via the provided send function.
 */
export function createEventAdapter(send: (msg: ServerMessage) => void): PiBridgeEvents {
  return {
    onTextDelta(sessionId: string, delta: string) {
      send(serverMessage('message.text_delta', { sessionId, delta }))
    },

    onThinkingDelta(sessionId: string, delta: string) {
      send(serverMessage('message.thinking_delta', { sessionId, delta }))
    },

    onToolCallStart(sessionId: string, toolCallId: string, toolName: string, input: unknown) {
      send(serverMessage('message.tool_call_start', { sessionId, toolCallId, toolName, input }))
    },

    onToolCallEnd(sessionId: string, toolCallId: string, output: string) {
      send(serverMessage('message.tool_call_end', { sessionId, toolCallId, output }))
    },

    onComplete(sessionId: string, stopReason: string, usage: { inputTokens: number; outputTokens: number }) {
      send(serverMessage('message.complete', { sessionId, stopReason, usage }))
    },

    onError(sessionId: string, error: string) {
      send(serverMessage('message.error', { sessionId, error }))
    },
  }
}
```

### Step 18: Create `sidecar/src/config-store.ts`

- [ ] Create `sidecar/src/config-store.ts` — config file read/write with JSON fallback

```typescript
// sidecar/src/config-store.ts
// Reads/writes provider config from ~/.xyz-agent/config.toml (or .json fallback)

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ProviderConfig {
  id: string
  name: string
  apiKey: string
  baseUrl?: string
  models: string[]
}

export interface AppConfig {
  providers: ProviderConfig[]
  defaultModel: string
}

const CONFIG_DIR = join(homedir(), '.xyz-agent')
const CONFIG_JSON = join(CONFIG_DIR, 'config.json')

/** Load config from disk. Creates default if not exists. */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(CONFIG_JSON, 'utf-8')
    return JSON.parse(raw) as AppConfig
  } catch {
    // File doesn't exist or is invalid — return defaults
    return {
      providers: [],
      defaultModel: 'claude-sonnet',
    }
  }
}

/** Save config to disk */
export async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_JSON, JSON.stringify(config, null, 2), 'utf-8')
}

/** Get a single provider by ID */
export async function getProvider(providerId: string): Promise<ProviderConfig | undefined> {
  const config = await loadConfig()
  return config.providers.find((p) => p.id === providerId)
}

/** Upsert a provider config */
export async function setProvider(provider: ProviderConfig): Promise<void> {
  const config = await loadConfig()
  const index = config.providers.findIndex((p) => p.id === provider.id)
  if (index >= 0) {
    config.providers[index] = provider
  } else {
    config.providers.push(provider)
  }
  await saveConfig(config)
}

/** Delete a provider by ID */
export async function deleteProvider(providerId: string): Promise<boolean> {
  const config = await loadConfig()
  const before = config.providers.length
  config.providers = config.providers.filter((p) => p.id !== providerId)
  if (config.providers.length < before) {
    await saveConfig(config)
    return true
  }
  return false
}
```

### Step 19: Wire skeleton handlers into server

- [ ] Update `sidecar/src/server.ts` to register default message handlers using the skeleton modules

Replace the entire file with:

```typescript
// sidecar/src/server.ts
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from './protocol'
import { serverMessage } from './protocol'
import * as sessionPool from './session-pool'
import { createStubBridge } from './pi-bridge'
import { createEventAdapter } from './event-adapter'
import * as configStore from './config-store'

interface RouteHandler {
  (msg: ClientMessage, send: (msg: ServerMessage) => void): Promise<void>
}

let client: WebSocket | null = null
const routes = new Map<string, RouteHandler>()

// Create the stub pi-bridge with event adapter
// (event adapter will be set up once we have a client)
let bridgeSend: ((msg: ServerMessage) => void) | null = null

function getBridge() {
  const send = bridgeSend!
  const events = createEventAdapter(send)
  return createStubBridge(events)
}

/** Register a message handler for a given client message type */
export function onMessage(type: string, handler: RouteHandler): void {
  routes.set(type, handler)
}

/** Start the WS server */
export async function startServer(port: number): Promise<void> {
  // Register route handlers
  registerRoutes()

  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws: WebSocket) => {
    if (client?.readyState === WebSocket.OPEN) {
      console.warn('[server] rejecting additional client, only one allowed')
      ws.close(4001, 'only one client allowed')
      return
    }

    client = ws
    bridgeSend = sendToClient
    console.info('[server] client connected')

    ws.on('message', (raw: Buffer) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        sendToClient(serverMessage('error', { message: 'invalid JSON' }))
        return
      }

      // Handle ping internally
      if (msg.type === 'ping') {
        sendToClient(serverMessage('pong', {}, msg.id))
        return
      }

      // Route to registered handler
      const handler = routes.get(msg.type)
      if (handler) {
        handler(msg, sendToClient).catch((err) => {
          console.error(`[server] handler error for "${msg.type}":`, err)
          sendToClient(
            serverMessage('error', {
              message: err instanceof Error ? err.message : String(err),
            }, msg.id)
          )
        })
      } else {
        console.warn(`[server] no handler for "${msg.type}"`)
        sendToClient(
          serverMessage('error', { message: `unknown message type: ${msg.type}` }, msg.id)
        )
      }
    })

    ws.on('close', () => {
      console.info('[server] client disconnected')
      client = null
      bridgeSend = null
    })

    ws.on('error', (err: Error) => {
      console.error('[server] ws error:', err)
    })
  })

  return new Promise((resolve) => {
    wss.on('listening', () => {
      console.info(`[server] listening on ws://localhost:${port}`)
      resolve()
    })
  })
}

// ── Route registrations ─────────────────────────────────

function registerRoutes(): void {
  // ── Session routes ──────────────────────────────────

  onMessage('session.create', async (msg, send) => {
    const cwd = msg.payload.cwd as string | undefined
    const session = sessionPool.createSession(cwd)
    send(serverMessage('session.created', {
      sessionId: session.id,
      label: session.label,
      cwd: session.cwd,
    }, msg.id))
  })

  onMessage('session.delete', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const deleted = sessionPool.deleteSession(sessionId)
    if (deleted) {
      send(serverMessage('session.deleted', { sessionId }, msg.id))
    } else {
      send(serverMessage('error', { message: `session not found: ${sessionId}` }, msg.id))
    }
  })

  onMessage('session.list', async (msg, send) => {
    const groups = sessionPool.groupSessionsByCwd()
    send(serverMessage('session.list', { groups }, msg.id))
  })

  onMessage('session.switch', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const session = sessionPool.getSession(sessionId)
    if (session) {
      sessionPool.updateSession(sessionId, { status: 'active' })
      send(serverMessage('session.created', {
        sessionId: session.id,
        label: session.label,
        cwd: session.cwd,
      }, msg.id))
    } else {
      send(serverMessage('error', { message: `session not found: ${sessionId}` }, msg.id))
    }
  })

  onMessage('session.history', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    // Stub: return empty history
    send(serverMessage('session.history', { sessionId, messages: [] }, msg.id))
  })

  // ── Message routes ──────────────────────────────────

  onMessage('message.send', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const content = msg.payload.content as string
    const session = sessionPool.getSession(sessionId)
    if (!session) {
      send(serverMessage('error', { message: `session not found: ${sessionId}` }, msg.id))
      return
    }
    // Delegate to pi-bridge (stub for now)
    const bridge = getBridge()
    await bridge.sendMessage(sessionId, content)
  })

  onMessage('message.abort', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const bridge = getBridge()
    await bridge.abort(sessionId)
  })

  // ── Config routes ──────────────────────────────────

  onMessage('config.getProviders', async (msg, send) => {
    const config = await configStore.loadConfig()
    const providers = config.providers.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.apiKey ? 'connected' : 'not_configured',
      models: p.models,
      apiKeySet: !!p.apiKey,
      baseUrl: p.baseUrl,
    }))
    send(serverMessage('config.providers', { providers }, msg.id))
  })

  onMessage('config.setProvider', async (msg, send) => {
    const provider = {
      id: msg.payload.providerId as string,
      name: (msg.payload.name as string) || (msg.payload.providerId as string),
      apiKey: (msg.payload.apiKey as string) || '',
      baseUrl: msg.payload.baseUrl as string | undefined,
      models: (msg.payload.models as string[]) || [],
    }
    await configStore.setProvider(provider)
    send(serverMessage('config.providerUpdated', { providerId: provider.id }, msg.id))
  })

  onMessage('config.deleteProvider', async (msg, send) => {
    const providerId = msg.payload.providerId as string
    await configStore.deleteProvider(providerId)
    send(serverMessage('config.providerUpdated', { providerId }, msg.id))
  })

  // ── Model routes ───────────────────────────────────

  onMessage('model.list', async (msg, send) => {
    const bridge = getBridge()
    const models = await bridge.listModels()
    send(serverMessage('model.list', { models }, msg.id))
  })

  onMessage('model.switch', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const modelId = msg.payload.modelId as string
    const bridge = getBridge()
    await bridge.switchModel(sessionId, modelId)
    send(serverMessage('model.switched', { sessionId, modelId }, msg.id))
  })
}

// ── Helpers ─────────────────────────────────────────────

function sendToClient(msg: ServerMessage): void {
  if (client?.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(msg))
  }
}
```

### Step 20: Verify everything compiles

- [ ] Run `cd /Users/zhushanwen/Code/xyz-agent/sidecar && npm install && npx tsc --noEmit`
- [ ] Run `cd /Users/zhushanwen/Code/xyz-agent && npx vue-tsc --noEmit` (verify frontend types)
- [ ] Quick smoke test: `cd sidecar && npx tsx src/index.ts --port 17777` starts without error, Ctrl+C to stop

---

## Verification Checklist

After completing all steps:

- [ ] `sidecar/` has `package.json`, `tsconfig.json`, and compiles without errors
- [ ] `src/types/protocol.ts` exports `ClientMessage`, `ServerMessage`, and all payload types
- [ ] `src/types/message.ts` exports `Message`, `ToolCall`, `ThinkingBlock`
- [ ] `src/types/session.ts` exports `SessionSummary`, `SessionGroup`
- [ ] `src/types/provider.ts` exports `ProviderInfo`, `ModelInfo`
- [ ] `src/lib/event-bus.ts` provides typed `on`/`off`/`emit` for `ServerMessageType`
- [ ] `src/lib/ws-client.ts` singleton handles connect/disconnect/reconnect/heartbeat
- [ ] `src/lib/protocol.ts` re-exports protocol types
- [ ] `sidecar/src/server.ts` starts WS server, routes messages, handles ping/pong
- [ ] `sidecar/src/session-pool.ts` manages sessions in memory with CRUD and grouping
- [ ] `sidecar/src/pi-bridge.ts` defines interface with stub implementation
- [ ] `sidecar/src/event-adapter.ts` converts pi events to `ServerMessage`
- [ ] `sidecar/src/config-store.ts` reads/writes config from `~/.xyz-agent/config.json`
- [ ] `sidecar/src/index.ts` parses `--port` arg and starts server
- [ ] 4 commits created, one per sub-task (4A, 4B, 4C, 4D)
