# Task 4 (v2): Communication Layer — Subprocess RPC Architecture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete communication layer: shared protocol types, WS client (frontend), WS server + pi subprocess manager (sidecar). The sidecar no longer imports pi SDK directly — it spawns `pi --mode rpc` as a subprocess per session and translates between WS protocol and RPC protocol.

**Dependencies:** Task 1 complete (project scaffold with `shared/`, `sidecar/`, `src/` dirs exist)

**Commit strategy:** 6 sub-tasks, commit after each.

---

## Architecture Overview

```
┌─────────────┐    WS     ┌──────────────────────────┐   JSONL    ┌─────────────┐
│  Vue 3 App  │◄────────►│     Node.js Sidecar       │◄──────────►│  pi subprocess │
│             │  (port)   │                           │  (stdin/   │  (--mode rpc)  │
│ ws-client   │           │ server → message-router   │  stdout)   │               │
│ event-bus   │           │ session-pool              │           │  Agent loop    │
│ composables │           │ process-manager           │           │  Tools         │
│             │           │ rpc-client                │           │  LLM calls    │
│             │           │ event-adapter             │           │               │
└─────────────┘           └──────────────────────────┘           └─────────────┘
```

**Data flow:**

```
Frontend WS msg → server.ts → message-router.ts → session-pool.ts (lookup)
  → process-manager.ts (get or spawn pi process)
  → rpc-client.ts (send JSONL command via stdin)
  → pi subprocess processes & responds
  → rpc-client.ts (parse JSONL from stdout)
  → event-adapter.ts (translate RPC event → WS event)
  → server.ts (send to frontend via WS)
```

---

## File Structure

```
# Shared (plan-01 scaffold)
shared/protocol.ts              # 4A — WS protocol message types (frontend + sidecar)
shared/types.ts                 # 4A — Domain types (Message, Session, Provider, Model)

# Frontend
src/lib/event-bus.ts            # 4B — Typed event emitter
src/lib/ws-client.ts            # 4B — Singleton WS client with reconnect/heartbeat

# Sidecar
sidecar/src/index.ts            # 4C — Entry: parse --port, start WS server + health endpoint
sidecar/src/server.ts           # 4C — WS server (single-client), message dispatch
sidecar/src/process-manager.ts  # 4D — Spawn/manage pi subprocess lifecycle
sidecar/src/rpc-client.ts       # 4E — Communicate with pi via stdin/stdout JSONL
sidecar/src/event-adapter.ts    # 4E — Translate pi RPC events → WS protocol events
sidecar/src/session-pool.ts     # 4F — Map<sessionId, PiProcess> CRUD + grouping
sidecar/src/config-store.ts     # 4F — Read/write ~/.xyz-agent/config.json
sidecar/src/message-router.ts   # 4F — Route incoming WS messages to appropriate handler
```

---

## 4A. Shared Protocol Types

**Commit:** `feat(p1): shared protocol types — WS messages, domain types`

### Step 1: Create `shared/protocol.ts`

- [ ] Create `shared/protocol.ts` — WS protocol types shared by frontend and sidecar

```typescript
// shared/protocol.ts
// WebSocket protocol types — shared between Vue frontend and Node.js sidecar.
// Import via: import type { ... } from '@shared/protocol'

// ═══════════════════════════════════════════════════════════
// Client → Sidecar
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
// Sidecar → Client
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
// Client Payload Shapes
// ═══════════════════════════════════════════════════════════

export interface SessionCreatePayload {
  cwd?: string
}

export interface SessionDeletePayload {
  sessionId: string
}

export interface SessionSwitchPayload {
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
  name?: string
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

// ═══════════════════════════════════════════════════════════
// Server Payload Shapes
// ═══════════════════════════════════════════════════════════

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
    sessions: SessionSummaryPayload[]
  }>
}

export interface SessionSummaryPayload {
  id: string
  label: string
  cwd: string
  status: 'active' | 'idle'
  lastActiveAt: number
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
  input: string
}

export interface ToolCallEndPayload {
  sessionId: string
  toolCallId: string
  output: string
}

export interface MessageCompletePayload {
  sessionId: string
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'error' | 'aborted'
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
    status: 'connected' | 'not_configured' | 'error'
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
  code?: 'CONNECTION_LOST' | 'PROVIDER_ERROR' | 'SESSION_NOT_FOUND' | 'PROCESS_CRASHED' | 'TIMEOUT'
}

// ═══════════════════════════════════════════════════════════
// Helper
// ═══════════════════════════════════════════════════════════

/** Create a ServerMessage with typed payload */
export function serverMessage(
  type: ServerMessageType,
  payload: Record<string, unknown> = {},
  id?: string,
): ServerMessage {
  const msg: ServerMessage = { type, payload }
  if (id !== undefined) {
    msg.id = id
  }
  return msg
}
```

### Step 2: Create `shared/types.ts`

- [ ] Create `shared/types.ts` — shared domain types

```typescript
// shared/types.ts
// Domain types shared between frontend and sidecar.

// ═══════════════════════════════════════════════════════════
// Message
// ═══════════════════════════════════════════════════════════

export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'streaming' | 'complete' | 'error'

export interface ToolCall {
  id: string
  toolName: string
  input: string
  output?: string
  status: 'running' | 'completed' | 'error'
}

export interface ThinkingBlock {
  id: string
  content: string
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

// ═══════════════════════════════════════════════════════════
// Session
// ═══════════════════════════════════════════════════════════

export type SessionStatus = 'active' | 'idle'

export interface SessionSummary {
  id: string
  label: string
  cwd: string
  status: SessionStatus
  lastActiveAt: number  // Unix timestamp (Date.now())
}

export interface SessionGroup {
  cwd: string
  sessions: SessionSummary[]
}

// ═══════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════

export type ProviderStatus = 'connected' | 'not_configured' | 'error'

export interface ProviderInfo {
  id: string
  name: string
  status: ProviderStatus
  models: string[]
  apiKeySet: boolean
  baseUrl?: string
}

// ═══════════════════════════════════════════════════════════
// Model
// ═══════════════════════════════════════════════════════════

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
}

// ═══════════════════════════════════════════════════════════
// Error
// ═══════════════════════════════════════════════════════════

export interface AppError {
  message: string
  code?: 'CONNECTION_LOST' | 'PROVIDER_ERROR' | 'SESSION_NOT_FOUND' | 'PROCESS_CRASHED' | 'TIMEOUT'
  retryable?: boolean
}
```

### Step 3: Create `shared/package.json` and `shared/tsconfig.json`

- [ ] Create `shared/package.json`

```json
{
  "name": "@xyz-agent/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.ts",
  "types": "index.ts",
  "exports": {
    ".": "./index.ts",
    "./protocol": "./protocol.ts",
    "./types": "./types.ts"
  }
}
```

- [ ] Create `shared/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "skipLibCheck": true,
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "noEmit": true,
    "isolatedModules": true
  },
  "include": ["*.ts"]
}
```

- [ ] Create `shared/index.ts`

```typescript
// shared/index.ts
export * from './protocol'
export * from './types'
```

### Step 4: Update root `package.json` workspaces

- [ ] Add `"shared"` to workspaces array in root `package.json`

```json
{
  "workspaces": ["shared", "sidecar"]
}
```

### Step 5: Configure path alias in frontend and sidecar tsconfig

- [ ] Add `@shared/*` path alias to frontend `tsconfig.json`

```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["./shared/*"],
      "@/*": ["./src/*"]
    }
  }
}
```

- [ ] Add `@shared/*` path alias to `sidecar/tsconfig.json`

```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["../shared/*"]
    }
  }
}
```

---

## 4B. Frontend WS Client + Event Bus

**Commit:** `feat(p1): ws-client + event-bus — typed WS client with reconnect/heartbeat`

### Step 6: Create `src/lib/event-bus.ts`

- [ ] Create `src/lib/event-bus.ts` — typed event emitter mapping ServerMessageType to handlers

```typescript
// src/lib/event-bus.ts
import type { ServerMessageType, ServerMessage } from '@shared/protocol'

type EventHandler = (message: ServerMessage) => void

/**
 * Typed event bus for WS server messages.
 * Maps ServerMessageType to handler sets for efficient dispatch.
 */
class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()

  /** Subscribe to a specific event type. Returns unsubscribe function. */
  on(event: ServerMessageType, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
    return () => {
      this.handlers.get(event)?.delete(handler)
    }
  }

  /** Unsubscribe a specific handler from an event type. */
  off(event: ServerMessageType, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler)
  }

  /** Emit a server message to all registered handlers for its type. */
  emit(message: ServerMessage): void {
    const typeHandlers = this.handlers.get(message.type)
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(message)
        } catch (err) {
          console.error(`[EventBus] handler error for "${message.type}":`, err)
        }
      }
    }
    // Also dispatch to wildcard listeners
    const wildcardHandlers = this.handlers.get('*')
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(message)
        } catch (err) {
          console.error(`[EventBus] wildcard handler error:`, err)
        }
      }
    }
  }

  /** Subscribe to ALL server messages (useful for logging/debugging). */
  onAny(handler: EventHandler): () => void {
    if (!this.handlers.has('*')) {
      this.handlers.set('*', new Set())
    }
    this.handlers.get('*')!.add(handler)
    return () => {
      this.handlers.get('*')?.delete(handler)
    }
  }

  /** Remove all handlers. */
  clear(): void {
    this.handlers.clear()
  }
}

/** Singleton event bus instance. */
export const eventBus = new EventBus()
```

### Step 7: Create `src/lib/ws-client.ts`

- [ ] Create `src/lib/ws-client.ts` — singleton WS client with auto-reconnect and heartbeat

```typescript
// src/lib/ws-client.ts
import type { ClientMessage, ServerMessage } from '@shared/protocol'
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
  private sendQueue: string[] = []

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

  /** Send a typed client message. Returns the message ID. */
  send(message: Omit<ClientMessage, 'id'>): string {
    const id = `msg_${++this.messageId}_${Date.now()}`
    const full: ClientMessage = { ...message, id }
    const serialized = JSON.stringify(full)

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serialized)
    } else {
      // Buffer for later send after reconnect
      this.sendQueue.push(serialized)
      console.warn('[WsClient] buffered message (ws not open):', full.type)
    }

    return id
  }

  /** Disconnect from server */
  disconnect(): void {
    this.intentionalClose = true
    this.cleanup()
    this.sendQueue = []
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

  /** Subscribe to connection state changes. Returns unsubscribe function. */
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
      this.flushSendQueue()
    }

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const message: ServerMessage = JSON.parse(String(event.data))

        // Handle pong internally (heartbeat mechanism)
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

  private flushSendQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    for (const msg of this.sendQueue) {
      this.ws.send(msg)
    }
    this.sendQueue = []
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY,
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

/** Singleton WS client instance. */
export const wsClient = new WsClient()
```

---

## 4C. Sidecar Entry + WS Server

**Commit:** `feat(p1): sidecar entry + ws server — HTTP health, single-client WS, message dispatch`

### Step 8: Create `sidecar/package.json`

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
    "@xyz-agent/shared": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.18.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0"
  }
}
```

### Step 9: Create `sidecar/tsconfig.json`

- [ ] Create `sidecar/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "outDir": "dist",
    "rootDir": "src",
    "paths": {
      "@shared/*": ["../shared/*"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

### Step 10: Create `sidecar/src/index.ts`

- [ ] Create `sidecar/src/index.ts` — entry point with `--port` arg parsing, HTTP health, graceful shutdown

```typescript
// sidecar/src/index.ts
import { createServer } from 'http'
import { startServer } from './server'
import { initMessageRouter } from './message-router'

const DEFAULT_PORT = 3210

function parseArgs(): { port: number } {
  const args = process.argv.slice(2)
  let port = DEFAULT_PORT

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

  // HTTP health endpoint for Tauri sidecar.rs to poll
  const healthServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  healthServer.listen(port, () => {
    console.info(`[sidecar] health endpoint on http://localhost:${port}/health`)
  })

  // WS server on port + 1 (health and WS share same process, different ports)
  const wsPort = port
  await startServer(wsPort)

  // Initialize message routing
  initMessageRouter()

  // Write port file for cold-start discovery
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const configDir = join(homedir(), '.xyz-agent')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'sidecar.port'), String(wsPort), 'utf-8')

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.info(`[sidecar] received ${signal}, shutting down...`)
    // session-pool cleanup will be called from server
    healthServer.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('[sidecar] fatal:', err)
  process.exit(1)
})
```

### Step 11: Create `sidecar/src/server.ts`

- [ ] Create `sidecar/src/server.ts` — WS server with single-client constraint, message dispatch, heartbeat

```typescript
// sidecar/src/server.ts
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from '@shared/protocol'
import { serverMessage } from '@shared/protocol'

export type MessageHandler = (
  msg: ClientMessage,
  send: (msg: ServerMessage) => void,
) => Promise<void>

let client: WebSocket | null = null
const handlers = new Map<string, MessageHandler>()

/** Register a message handler for a given client message type */
export function onMessage(type: string, handler: MessageHandler): void {
  handlers.set(type, handler)
}

/** Send a message to the connected frontend client */
export function sendToClient(msg: ServerMessage): void {
  if (client?.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(msg))
  }
}

/** Check if a client is connected */
export function hasClient(): boolean {
  return client?.readyState === WebSocket.OPEN
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
      const handler = handlers.get(msg.type)
      if (handler) {
        handler(msg, sendToClient).catch((err) => {
          console.error(`[server] handler error for "${msg.type}":`, err)
          sendToClient(
            serverMessage('error', {
              message: err instanceof Error ? err.message : String(err),
            }, msg.id),
          )
        })
      } else {
        console.warn(`[server] no handler for "${msg.type}"`)
        sendToClient(
          serverMessage('error', { message: `unknown message type: ${msg.type}` }, msg.id),
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
      console.info(`[server] ws listening on ws://localhost:${port}`)
      resolve()
    })
  })
}
```

---

## 4D. Process Manager — pi Subprocess Lifecycle

**Commit:** `feat(p1): process-manager — spawn/manage pi subprocess lifecycle per session`

### Step 12: Create `sidecar/src/process-manager.ts`

- [ ] Create `sidecar/src/process-manager.ts` — spawn pi subprocess, manage lifecycle, handle crashes

```typescript
// sidecar/src/process-manager.ts
// Manages pi subprocess lifecycle: spawn, health, crash detection, cleanup.
// Each session gets its own pi subprocess running in RPC mode.

import { spawn, type ChildProcess } from 'node:child_process'
import { RpcClient, type RpcEventListener } from './rpc-client'

export interface PiProcessOptions {
  sessionId: string
  cwd: string
  env?: Record<string, string>
  provider?: string
  model?: string
  onExit?: (sessionId: string, code: number | null, signal: string | null) => void
}

export interface PiProcess {
  sessionId: string
  cwd: string
  rpcClient: RpcClient
  childProcess: ChildProcess
  createdAt: number
}

/** Find the pi CLI binary path */
function findPiCli(): string {
  // In development: use globally installed pi
  // In production: bundled path (future work)
  return 'dist/cli.js'
}

/**
 * Spawn a pi subprocess in RPC mode and return a managed PiProcess.
 *
 * The subprocess communicates via stdin/stdout JSONL protocol.
 * RpcClient wraps the protocol details.
 */
export async function spawnPiProcess(options: PiProcessOptions): Promise<PiProcess> {
  const { sessionId, cwd, env, provider, model, onExit } = options

  const rpcClient = new RpcClient({
    cliPath: findPiCli(),
    cwd,
    env: env ?? {},
    provider,
    model,
  })

  await rpcClient.start()

  const childProcess = rpcClient.getChildProcess()

  // Monitor for unexpected exits
  childProcess.on('exit', (code, signal) => {
    console.info(`[process-manager] pi process exited: sessionId=${sessionId} code=${code} signal=${signal}`)
    onExit?.(sessionId, code, signal)
  })

  childProcess.on('error', (err) => {
    console.error(`[process-manager] pi process error: sessionId=${sessionId}`, err)
  })

  return {
    sessionId,
    cwd,
    rpcClient,
    childProcess,
    createdAt: Date.now(),
  }
}

/**
 * Gracefully stop a pi subprocess.
 * SIGTERM → wait 1s → SIGKILL
 */
export async function stopPiProcess(piProcess: PiProcess): Promise<void> {
  try {
    await piProcess.rpcClient.stop()
  } catch (err) {
    console.warn(`[process-manager] error stopping process for ${piProcess.sessionId}:`, err)
    // Force kill if stop() failed
    try {
      piProcess.childProcess.kill('SIGKILL')
    } catch {
      // Already dead, ignore
    }
  }
}
```

---

## 4E. RPC Client + Event Adapter

**Commit:** `feat(p1): rpc-client + event-adapter — JSONL protocol, RPC→WS event translation`

### Step 13: Create `sidecar/src/rpc-client.ts`

- [ ] Create `sidecar/src/rpc-client.ts` — standalone JSONL RPC client for pi subprocess

This is a **standalone implementation** (not importing from pi SDK) that handles the stdin/stdout JSONL protocol directly. This avoids importing pi SDK into the sidecar process.

```typescript
// sidecar/src/rpc-client.ts
// Standalone RPC client for communicating with a pi subprocess via JSONL.
// Does NOT import @mariozechner/pi-coding-agent — the sidecar only talks
// to pi as a subprocess via stdin/stdout.

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

// ═══════════════════════════════════════════════════════════
// Types (mirrors pi's rpc-types.ts — subset needed for P1)
// ═══════════════════════════════════════════════════════════

/** Events emitted by pi subprocess on stdout (JSON lines) */
export interface AgentEvent {
  type: string
  [key: string]: unknown
}

/** RPC response from pi subprocess */
export interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/** Event listener callback */
export type RpcEventListener = (event: AgentEvent) => void

/** Options for creating an RpcClient */
export interface RpcClientOptions {
  /** Path to pi CLI entry point */
  cliPath: string
  /** Working directory for the agent */
  cwd?: string
  /** Environment variables (e.g. API keys) */
  env?: Record<string, string>
  /** Provider name */
  provider?: string
  /** Model ID */
  model?: string
}

// ═══════════════════════════════════════════════════════════
// JSONL Helpers
// ═══════════════════════════════════════════════════════════

function serializeJsonLine(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

// ═══════════════════════════════════════════════════════════
// RpcClient
// ═══════════════════════════════════════════════════════════

export class RpcClient {
  private process: ChildProcess | null = null
  private eventListeners: RpcEventListener[] = []
  private pendingRequests = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >()
  private requestId = 0
  private stderr = ''
  private rl: ReturnType<typeof createInterface> | null = null

  constructor(private options: RpcClientOptions) {}

  /**
   * Start the pi subprocess in RPC mode.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Client already started')
    }

    const args = ['--mode', 'rpc']
    if (this.options.provider) {
      args.push('--provider', this.options.provider)
    }
    if (this.options.model) {
      args.push('--model', this.options.model)
    }

    this.process = spawn('node', [this.options.cliPath, ...args], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Collect stderr for debugging
    this.process.stderr?.on('data', (data: Buffer) => {
      this.stderr += data.toString()
      process.stderr.write(data)
    })

    // Set up JSONL line reader for stdout
    this.rl = createInterface({ input: this.process.stdout! })
    this.rl.on('line', (line: string) => {
      this.handleLine(line)
    })

    // Wait for process to initialize
    await new Promise((resolve) => setTimeout(resolve, 100))

    if (this.process.exitCode !== null) {
      throw new Error(
        `Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`,
      )
    }
  }

  /**
   * Stop the pi subprocess gracefully.
   */
  async stop(): Promise<void> {
    if (!this.process) return

    this.rl?.close()
    this.rl = null
    this.process.kill('SIGTERM')

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill('SIGKILL')
        resolve()
      }, 1000)

      this.process?.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.process = null
    this.pendingRequests.clear()
  }

  /**
   * Get the underlying ChildProcess (for exit monitoring etc.)
   */
  getChildProcess(): ChildProcess {
    if (!this.process) throw new Error('Client not started')
    return this.process
  }

  /**
   * Subscribe to agent events (AgentEvent from stdout).
   * Returns unsubscribe function.
   */
  onEvent(listener: RpcEventListener): () => void {
    this.eventListeners.push(listener)
    return () => {
      const idx = this.eventListeners.indexOf(listener)
      if (idx !== -1) {
        this.eventListeners.splice(idx, 1)
      }
    }
  }

  /**
   * Get collected stderr output (debugging).
   */
  getStderr(): string {
    return this.stderr
  }

  // ── Typed Command Methods ────────────────────────────

  /** Send a prompt. Events stream via onEvent(). */
  async prompt(message: string): Promise<void> {
    await this.send({ type: 'prompt', message })
  }

  /** Abort current generation */
  async abort(): Promise<void> {
    await this.send({ type: 'abort' })
  }

  /** Set model by provider + ID */
  async setModel(provider: string, modelId: string): Promise<unknown> {
    const response = await this.send({ type: 'set_model', provider, modelId })
    return this.getData(response)
  }

  /** Get available models */
  async getAvailableModels(): Promise<unknown> {
    const response = await this.send({ type: 'get_available_models' })
    return this.getData(response)
  }

  /** Get all messages in session */
  async getMessages(): Promise<unknown> {
    const response = await this.send({ type: 'get_messages' })
    return this.getData(response)
  }

  /** Set thinking level */
  async setThinkingLevel(level: string): Promise<void> {
    await this.send({ type: 'set_thinking_level', level })
  }

  /** Start a new session within the pi process */
  async newSession(): Promise<unknown> {
    const response = await this.send({ type: 'new_session' })
    return this.getData(response)
  }

  /** Set session display name */
  async setSessionName(name: string): Promise<void> {
    await this.send({ type: 'set_session_name', name })
  }

  // ── Higher-level Helpers ─────────────────────────────

  /** Wait for agent to finish (agent_end event) */
  waitForIdle(timeout = 120000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timeout waiting for agent idle. Stderr: ${this.stderr}`))
      }, timeout)

      const unsubscribe = this.onEvent((event) => {
        if (event.type === 'agent_end') {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
  }

  /** Send prompt and wait for completion, returning all events */
  async promptAndWait(message: string, timeout = 120000): Promise<AgentEvent[]> {
    const eventsPromise = this.collectEvents(timeout)
    await this.prompt(message)
    return eventsPromise
  }

  /** Collect all events until agent becomes idle */
  collectEvents(timeout = 120000): Promise<AgentEvent[]> {
    return new Promise((resolve, reject) => {
      const events: AgentEvent[] = []
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`))
      }, timeout)

      const unsubscribe = this.onEvent((event) => {
        events.push(event)
        if (event.type === 'agent_end') {
          clearTimeout(timer)
          unsubscribe()
          resolve(events)
        }
      })
    })
  }

  // ── Internal ─────────────────────────────────────────

  private handleLine(line: string): void {
    if (!line.trim()) return

    try {
      const data = JSON.parse(line)

      // Response to a pending request
      if (data.type === 'response' && data.id && this.pendingRequests.has(data.id)) {
        const pending = this.pendingRequests.get(data.id)!
        this.pendingRequests.delete(data.id)
        pending.resolve(data as RpcResponse)
        return
      }

      // Otherwise it's an agent event — dispatch to listeners
      for (const listener of this.eventListeners) {
        try {
          listener(data as AgentEvent)
        } catch (err) {
          console.error('[RpcClient] event listener error:', err)
        }
      }
    } catch {
      // Ignore non-JSON lines (debug output etc.)
    }
  }

  private async send(command: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.process?.stdin) {
      throw new Error('Client not started')
    }

    const id = `req_${++this.requestId}`
    const fullCommand = { ...command, id }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`))
      }, 30000)

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout)
          resolve(response)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })

      this.process!.stdin!.write(serializeJsonLine(fullCommand))
    })
  }

  private getData<T = unknown>(response: RpcResponse): T {
    if (!response.success) {
      throw new Error(response.error ?? 'Unknown RPC error')
    }
    return response.data as T
  }
}
```

### Step 14: Create `sidecar/src/event-adapter.ts`

- [ ] Create `sidecar/src/event-adapter.ts` — translate pi RPC events → WS protocol events

This is the critical translation layer. It maps pi's internal `AgentEvent` types to the WS protocol's `ServerMessage` types. The WS protocol events are defined in spec-v2 section 五.

```typescript
// sidecar/src/event-adapter.ts
// Translates pi subprocess RPC events (AgentEvent) into WS protocol events (ServerMessage).
//
// pi RPC event types (from @mariozechner/pi-agent-core AgentEvent):
//   agent_start, agent_end, turn_start, turn_end,
//   message_start, message_update, message_end,
//   tool_execution_start, tool_execution_update, tool_execution_end
//
// pi message_update carries assistantMessageEvent subtypes:
//   text_delta, thinking_delta, toolcall_start, toolcall_delta, toolcall_end
//
// WS protocol event types (from shared/protocol.ts):
//   message.text_delta, message.thinking_delta,
//   message.tool_call_start, message.tool_call_end,
//   message.complete, message.error

import type { ServerMessage } from '@shared/protocol'
import { serverMessage } from '@shared/protocol'
import type { AgentEvent } from './rpc-client'

/**
 * Create an event adapter that translates pi RPC events to WS messages.
 *
 * @param sessionId - The WS session ID to tag all outgoing events
 * @param send - Function to send a ServerMessage to the frontend
 * @returns A function that handles an AgentEvent from pi subprocess
 */
export function createEventAdapter(
  sessionId: string,
  send: (msg: ServerMessage) => void,
): (event: AgentEvent) => void {
  return (event: AgentEvent) => {
    try {
      adaptEvent(sessionId, event, send)
    } catch (err) {
      console.error(`[event-adapter] error adapting event type="${event.type}":`, err)
      send(serverMessage('message.error', {
        sessionId,
        error: `Internal event adapter error: ${err instanceof Error ? err.message : String(err)}`,
      }))
    }
  }
}

/**
 * Core event translation logic.
 *
 * P1 handles these pi events:
 *   message_update with assistantMessageEvent.text_delta → message.text_delta
 *   message_update with assistantMessageEvent.thinking_delta → message.thinking_delta
 *   tool_execution_start → message.tool_call_start
 *   tool_execution_end → message.tool_call_end
 *   agent_end → message.complete
 *
 * All other events are logged but not forwarded (reserved for future phases).
 */
function adaptEvent(
  sessionId: string,
  event: AgentEvent,
  send: (msg: ServerMessage) => void,
): void {
  switch (event.type) {
    // ── Message streaming ────────────────────────────────
    case 'message_update': {
      // message_update carries an optional assistantMessageEvent
      // with a nested type field (text_delta, thinking_delta, toolcall_*)
      const subEvent = event.assistantMessageEvent as { type: string; [k: string]: unknown } | undefined
      if (!subEvent) {
        // Message update without sub-event detail — skip
        return
      }

      switch (subEvent.type) {
        case 'text_delta': {
          send(serverMessage('message.text_delta', {
            sessionId,
            delta: subEvent.delta as string,
          }))
          break
        }
        case 'thinking_delta': {
          send(serverMessage('message.thinking_delta', {
            sessionId,
            delta: subEvent.delta as string,
          }))
          break
        }
        case 'toolcall_start': {
          // Tool call started — extract from the message's content blocks
          // The parent message_update event has the message with tool_use content
          const message = event.message as { content?: Array<{ type: string; id?: string; name?: string; input?: string }> } | undefined
          // Find the latest tool_use block
          const toolBlock = message?.content?.findLast?.((b: { type: string }) => b.type === 'tool_use')
          if (toolBlock) {
            send(serverMessage('message.tool_call_start', {
              sessionId,
              toolCallId: toolBlock.id ?? '',
              toolName: toolBlock.name ?? '',
              input: typeof toolBlock.input === 'string' ? toolBlock.input : JSON.stringify(toolBlock.input ?? {}),
            }))
          }
          break
        }
        case 'toolcall_end': {
          // Tool call parsing complete (input fully received)
          // We don't emit a WS event here — tool_execution_start/end is more reliable
          break
        }
        default:
          // Other message sub-events (text_start, text_end, thinking_start, etc.)
          // Not needed in P1 — ignore silently
          break
      }
      break
    }

    // ── Tool execution ───────────────────────────────────
    case 'tool_execution_start': {
      send(serverMessage('message.tool_call_start', {
        sessionId,
        toolCallId: event.toolCallId as string,
        toolName: event.toolName as string,
        input: JSON.stringify(event.args ?? {}),
      }))
      break
    }

    case 'tool_execution_end': {
      const isError = event.isError as boolean
      const output = typeof event.result === 'string'
        ? event.result
        : JSON.stringify(event.result ?? '')
      send(serverMessage('message.tool_call_end', {
        sessionId,
        toolCallId: event.toolCallId as string,
        output: isError ? `Error: ${output}` : output,
      }))
      break
    }

    // ── Agent lifecycle ──────────────────────────────────
    case 'agent_end': {
      // Extract stop reason and usage from the final message
      const messages = event.messages as Array<{ usage?: { inputTokens: number; outputTokens: number }; stopReason?: string }> | undefined
      const lastAssistant = messages?.findLast?.((m: unknown) => m != null)
      const rawReason = lastAssistant?.stopReason ?? 'stop'

      send(serverMessage('message.complete', {
        sessionId,
        stopReason: mapStopReason(rawReason),
        usage: lastAssistant?.usage ?? { inputTokens: 0, outputTokens: 0 },
      }))
      break
    }

    // ── Ignored events (P1 — reserved for future phases) ──
    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
    case 'message_end':
    case 'tool_execution_update':
      // Log at debug level but don't forward
      break

    default:
      console.info(`[event-adapter] unhandled event type: ${event.type}`)
      break
  }
}

/**
 * Map pi's internal stop reason to WS protocol stop reason.
 *
 * pi uses: "stop" | "length" | "toolUse" | "error" | "aborted"
 * WS uses: "end_turn" | "max_tokens" | "tool_use" | "error" | "aborted"
 */
function mapStopReason(
  piReason: string,
): 'end_turn' | 'max_tokens' | 'tool_use' | 'error' | 'aborted' {
  switch (piReason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'toolUse':
      return 'tool_use'
    case 'error':
      return 'error'
    case 'aborted':
      return 'aborted'
    default:
      return 'end_turn'
  }
}
```

---

## 4F. Session Pool + Config Store + Message Router

**Commit:** `feat(p1): session-pool + config-store + message-router — full sidecar wiring`

### Step 15: Create `sidecar/src/session-pool.ts`

- [ ] Create `sidecar/src/session-pool.ts` — Map<sessionId, PiProcess> CRUD + cwd grouping

```typescript
// sidecar/src/session-pool.ts
// In-memory pool of active sessions. Each session maps to a pi subprocess.

import { randomUUID } from 'node:crypto'
import type { PiProcess } from './process-manager'

export interface SessionMeta {
  id: string
  label: string
  cwd: string
  status: 'active' | 'idle'
  lastActiveAt: number  // Unix timestamp (Date.now())
  modelId: string
  createdAt: number
}

interface PooledSession {
  meta: SessionMeta
  piProcess: PiProcess | null  // null = session exists but no active subprocess
}

const pool = new Map<string, PooledSession>()

/** Create a new session (without spawning pi process yet) */
export function createSession(cwd?: string): SessionMeta {
  const meta: SessionMeta = {
    id: randomUUID(),
    label: 'New Session',
    cwd: cwd ?? process.cwd(),
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: '',
    createdAt: Date.now(),
  }
  pool.set(meta.id, { meta, piProcess: null })
  return meta
}

/** Get session metadata */
export function getSessionMeta(id: string): SessionMeta | undefined {
  return pool.get(id)?.meta
}

/** Get the pi subprocess for a session */
export function getSessionProcess(id: string): PiProcess | null {
  return pool.get(id)?.piProcess ?? null
}

/** Attach a pi subprocess to an existing session */
export function attachProcess(id: string, piProcess: PiProcess): void {
  const session = pool.get(id)
  if (!session) {
    throw new Error(`Session not found: ${id}`)
  }
  session.piProcess = piProcess
  session.meta.status = 'active'
  session.meta.lastActiveAt = Date.now()
}

/** Detach and stop the pi subprocess for a session */
export async function detachProcess(id: string): Promise<void> {
  const session = pool.get(id)
  if (!session?.piProcess) return

  const { stopPiProcess } = await import('./process-manager')
  await stopPiProcess(session.piProcess)
  session.piProcess = null
  session.meta.status = 'idle'
}

/** Delete a session (stops pi process if running) */
export async function deleteSession(id: string): Promise<boolean> {
  const session = pool.get(id)
  if (!session) return false

  if (session.piProcess) {
    const { stopPiProcess } = await import('./process-manager')
    await stopPiProcess(session.piProcess)
  }

  pool.delete(id)
  return true
}

/** Update session metadata */
export function updateSessionMeta(
  id: string,
  updates: Partial<Pick<SessionMeta, 'label' | 'status' | 'lastActiveAt' | 'modelId'>>,
): SessionMeta | undefined {
  const session = pool.get(id)
  if (!session) return undefined
  Object.assign(session.meta, updates, { lastActiveAt: Date.now() })
  return session.meta
}

/** List all session metadata, sorted by lastActiveAt descending */
export function listSessions(): SessionMeta[] {
  return Array.from(pool.values())
    .map((s) => s.meta)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

/** Group sessions by cwd */
export function groupSessionsByCwd(): Array<{ cwd: string; sessions: SessionMeta[] }> {
  const groups = new Map<string, SessionMeta[]>()
  for (const meta of listSessions()) {
    const existing = groups.get(meta.cwd)
    if (existing) {
      existing.push(meta)
    } else {
      groups.set(meta.cwd, [meta])
    }
  }
  return Array.from(groups.entries()).map(([cwd, sessions]) => ({ cwd, sessions }))
}

/** Stop all pi subprocesses (for graceful shutdown) */
export async function stopAll(): Promise<void> {
  const { stopPiProcess } = await import('./process-manager')
  const promises: Promise<void>[] = []
  for (const session of pool.values()) {
    if (session.piProcess) {
      promises.push(stopPiProcess(session.piProcess))
    }
  }
  await Promise.allSettled(promises)
  pool.clear()
}
```

### Step 16: Create `sidecar/src/config-store.ts`

- [ ] Create `sidecar/src/config-store.ts` — read/write `~/.xyz-agent/config.json`

```typescript
// sidecar/src/config-store.ts
// Reads/writes xyz-agent configuration from ~/.xyz-agent/config.json

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
  theme?: 'light' | 'dark' | 'system'
  locale?: 'zh-CN' | 'en-US'
}

const CONFIG_DIR = join(homedir(), '.xyz-agent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG: AppConfig = {
  providers: [],
  defaultModel: 'claude-sonnet',
}

/** Load config from disk. Creates default if not exists. */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(raw) as AppConfig
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** Save config to disk */
export async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
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

/** Build env vars from all configured providers (for passing to pi subprocess) */
export async function buildProviderEnv(): Promise<Record<string, string>> {
  const config = await loadConfig()
  const env: Record<string, string> = {}

  for (const provider of config.providers) {
    if (!provider.apiKey) continue
    // Map provider ID to standard env var name
    const key = provider.id.toUpperCase().replace(/-/g, '_') + '_API_KEY'
    env[key] = provider.apiKey
    // Also set well-known env vars
    switch (provider.id) {
      case 'anthropic':
        env.ANTHROPIC_API_KEY = provider.apiKey
        break
      case 'openai':
        env.OPENAI_API_KEY = provider.apiKey
        break
    }
    if (provider.baseUrl) {
      const baseKey = provider.id.toUpperCase().replace(/-/g, '_') + '_BASE_URL'
      env[baseKey] = provider.baseUrl
    }
  }

  return env
}
```

### Step 17: Create `sidecar/src/message-router.ts`

- [ ] Create `sidecar/src/message-router.ts` — route incoming WS messages to appropriate handlers

```typescript
// sidecar/src/message-router.ts
// Routes incoming WS messages from the frontend to appropriate handlers.
// This is the central wiring point that connects server.ts to all sidecar modules.

import type { ClientMessage, ServerMessage } from '@shared/protocol'
import { serverMessage } from '@shared/protocol'
import { onMessage, sendToClient } from './server'
import * as sessionPool from './session-pool'
import * as configStore from './config-store'
import { spawnPiProcess, stopPiProcess } from './process-manager'
import { createEventAdapter } from './event-adapter'

/**
 * Register all WS message handlers.
 * Called once during sidecar startup.
 */
export function initMessageRouter(): void {
  // ── Session Routes ─────────────────────────────────────

  onMessage('session.create', async (msg, send) => {
    const cwd = msg.payload.cwd as string | undefined
    const meta = sessionPool.createSession(cwd)
    send(serverMessage('session.created', {
      sessionId: meta.id,
      label: meta.label,
      cwd: meta.cwd,
    }, msg.id))
  })

  onMessage('session.delete', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const deleted = await sessionPool.deleteSession(sessionId)
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
    const meta = sessionPool.getSessionMeta(sessionId)
    if (meta) {
      sessionPool.updateSessionMeta(sessionId, { status: 'active' })
      send(serverMessage('session.created', {
        sessionId: meta.id,
        label: meta.label,
        cwd: meta.cwd,
      }, msg.id))
    } else {
      send(serverMessage('error', { message: `session not found: ${sessionId}` }, msg.id))
    }
  })

  onMessage('session.history', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const process = sessionPool.getSessionProcess(sessionId)
    if (process) {
      try {
        const data = await process.rpcClient.getMessages() as { messages: unknown[] }
        send(serverMessage('session.history', {
          sessionId,
          messages: data.messages,
        }, msg.id))
      } catch (err) {
        send(serverMessage('error', {
          message: `failed to get history: ${err instanceof Error ? err.message : String(err)}`,
        }, msg.id))
      }
    } else {
      // No active process — return empty history
      send(serverMessage('session.history', { sessionId, messages: [] }, msg.id))
    }
  })

  // ── Message Routes ─────────────────────────────────────

  onMessage('message.send', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const content = msg.payload.content as string
    const meta = sessionPool.getSessionMeta(sessionId)
    if (!meta) {
      send(serverMessage('error', { message: `session not found: ${sessionId}` }, msg.id))
      return
    }

    // Ensure pi subprocess is running for this session
    let process = sessionPool.getSessionProcess(sessionId)
    if (!process) {
      try {
        const env = await configStore.buildProviderEnv()
        process = await spawnPiProcess({
          sessionId,
          cwd: meta.cwd,
          env,
          onExit: (sid, code, signal) => {
            console.info(`[message-router] pi exited: session=${sid} code=${code} signal=${signal}`)
            // Notify frontend of crash
            sendToClient(serverMessage('message.error', {
              sessionId: sid,
              error: `Agent process exited unexpectedly (code=${code}, signal=${signal})`,
            }))
            // Mark session as idle (process gone)
            sessionPool.updateSessionMeta(sid, { status: 'idle' })
          },
        })

        // Wire up event adapter for this session
        const eventAdapter = createEventAdapter(sessionId, sendToClient)
        process.rpcClient.onEvent(eventAdapter)

        sessionPool.attachProcess(sessionId, process)
      } catch (err) {
        send(serverMessage('message.error', {
          sessionId,
          error: `Failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
        }, msg.id))
        return
      }
    }

    // Update last active time
    sessionPool.updateSessionMeta(sessionId, { lastActiveAt: Date.now() })

    // Send prompt to pi subprocess
    try {
      await process.rpcClient.prompt(content)
      // prompt() returns immediately after pi acknowledges
      // Events stream via the event adapter
    } catch (err) {
      send(serverMessage('message.error', {
        sessionId,
        error: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
      }, msg.id))
    }
  })

  onMessage('message.abort', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const process = sessionPool.getSessionProcess(sessionId)
    if (process) {
      try {
        await process.rpcClient.abort()
      } catch (err) {
        send(serverMessage('error', {
          message: `Failed to abort: ${err instanceof Error ? err.message : String(err)}`,
        }, msg.id))
      }
    }
  })

  // ── Config Routes ──────────────────────────────────────

  onMessage('config.getProviders', async (msg, send) => {
    const config = await configStore.loadConfig()
    const providers = config.providers.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.apiKey ? 'connected' as const : 'not_configured' as const,
      models: p.models,
      apiKeySet: !!p.apiKey,
      baseUrl: p.baseUrl,
    }))
    send(serverMessage('config.providers', { providers }, msg.id))
  })

  onMessage('config.setProvider', async (msg, send) => {
    const provider: configStore.ProviderConfig = {
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

  // ── Model Routes ───────────────────────────────────────

  onMessage('model.list', async (msg, send) => {
    // Try to get models from any active pi process
    // If no process is running, return models from config
    const sessions = sessionPool.listSessions()
    let models: Array<{ id: string; name: string; providerId: string; providerName: string }> = []

    // Try each session's process until one responds
    for (const session of sessions) {
      const process = sessionPool.getSessionProcess(session.id)
      if (process) {
        try {
          const data = await process.rpcClient.getAvailableModels() as { models: Array<{ provider: string; id: string; name: string }> }
          models = data.models.map((m) => ({
            id: m.id,
            name: m.name,
            providerId: m.provider,
            providerName: m.provider,
          }))
          break
        } catch {
          // Try next process
        }
      }
    }

    // Fallback: static model list from config
    if (models.length === 0) {
      const config = await configStore.loadConfig()
      models = config.providers.flatMap((p) =>
        p.models.map((mId) => ({
          id: mId,
          name: mId,
          providerId: p.id,
          providerName: p.name,
        })),
      )
    }

    send(serverMessage('model.list', { models }, msg.id))
  })

  onMessage('model.switch', async (msg, send) => {
    const sessionId = msg.payload.sessionId as string
    const modelId = msg.payload.modelId as string
    const process = sessionPool.getSessionProcess(sessionId)

    if (process) {
      try {
        // Parse "provider/modelId" format or use default provider
        const parts = modelId.split('/')
        const provider = parts.length > 1 ? parts[0] : 'anthropic'
        const mid = parts.length > 1 ? parts[1] : modelId
        await process.rpcClient.setModel(provider, mid)
        sessionPool.updateSessionMeta(sessionId, { modelId })
      } catch (err) {
        send(serverMessage('error', {
          message: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
        }, msg.id))
        return
      }
    } else {
      sessionPool.updateSessionMeta(sessionId, { modelId })
    }

    send(serverMessage('model.switched', { sessionId, modelId }, msg.id))
  })
}
```

### Step 18: Verify everything compiles

- [ ] Run `cd /Users/zhushanwen/Code/xyz-agent && npm install` (installs workspaces)
- [ ] Run `cd /Users/zhushanwen/Code/xyz-agent/sidecar && npx tsc --noEmit` (verify sidecar compiles)
- [ ] Run `cd /Users/zhushanwen/Code/xyz-agent && npx vue-tsc --noEmit` (verify frontend types)
- [ ] Quick smoke test: `cd sidecar && npx tsx src/index.ts --port 3210` starts without error, Ctrl+C to stop

---

## Verification Checklist

After completing all steps:

- [ ] `shared/protocol.ts` exports `ClientMessage`, `ServerMessage`, all payload types, `serverMessage()` helper
- [ ] `shared/types.ts` exports `Message`, `ToolCall`, `ThinkingBlock`, `SessionSummary`, `ProviderInfo`, `ModelInfo`, `AppError`
- [ ] `shared/package.json` configured as workspace package with exports
- [ ] Root `package.json` has `"workspaces": ["shared", "sidecar"]`
- [ ] Frontend `tsconfig.json` has `@shared/*` path alias
- [ ] Sidecar `tsconfig.json` has `@shared/*` path alias
- [ ] `src/lib/event-bus.ts` provides typed `on`/`off`/`emit`/`onAny` for `ServerMessageType`
- [ ] `src/lib/ws-client.ts` singleton handles connect/disconnect/reconnect/heartbeat/send queue
- [ ] `sidecar/src/index.ts` parses `--port` arg, starts health endpoint + WS server, writes port file
- [ ] `sidecar/src/server.ts` single-client WS server with message dispatch to registered handlers
- [ ] `sidecar/src/process-manager.ts` spawns/stops pi subprocess (`pi --mode rpc`)
- [ ] `sidecar/src/rpc-client.ts` standalone JSONL client — stdin commands, stdout events, request-response correlation
- [ ] `sidecar/src/event-adapter.ts` maps pi RPC events → WS protocol events with StopReason translation
- [ ] `sidecar/src/session-pool.ts` Map<sessionId, PiProcess> CRUD + cwd grouping + graceful shutdown
- [ ] `sidecar/src/config-store.ts` reads/writes `~/.xyz-agent/config.json`, builds provider env vars
- [ ] `sidecar/src/message-router.ts` wires all WS message types to session/config/process operations
- [ ] 6 commits created, one per sub-task (4A, 4B, 4C, 4D, 4E, 4F)

---

## Key Design Decisions

### 1. Standalone RPC Client (not importing pi SDK)

The sidecar's `rpc-client.ts` is a **standalone implementation** of the JSONL protocol. It does NOT import `@mariozechner/pi-coding-agent`. Instead, it spawns `node dist/cli.js --mode rpc` as a child process and speaks JSONL over stdin/stdout.

**Rationale**: Spec-v2 section 六 explicitly chose Path B (Subprocess RPC) over Path A (Direct SDK Import). The sidecar only depends on the JSONL protocol's stability, not on pi's internal APIs.

### 2. Lazy pi Process Spawning

A pi subprocess is spawned only when the user sends the first message to a session (`message.send`). Session creation (`session.create`) is metadata-only — no process spawned.

**Rationale**: Reduces resource usage. P1 is single-session typically; the process model scales naturally for P5 (multi-session) where each session gets its own process.

### 3. Event Adapter Is Per-Session

Each pi subprocess gets its own `createEventAdapter(sessionId, send)` call. The adapter tags all WS events with the correct `sessionId`.

**Rationale**: When multiple pi processes run concurrently (P5), events from different processes must be correctly attributed.

### 4. Send Queue in WS Client

The frontend `ws-client.ts` buffers messages when the connection is down and flushes them on reconnect.

**Rationale**: Spec-v2 section 6.8 requires "WS 断连期间发出的消息 → 离线缓冲 → 连接恢复后自动重发".

### 5. Port = 3210 (Unified)

All port references use `3210` as the default. The health endpoint and WS server share the same process (health uses HTTP, WS uses WebSocket on the same port).

**Rationale**: Spec-v2 section 6.6 mandates unified port reference, eliminating the 9250/17777/3210 inconsistency from earlier plans.

### 6. Config as JSON (not TOML)

The sidecar uses `~/.xyz-agent/config.json` for its own settings. This is separate from pi's own config files (`~/.pi/agent/auth.json`, etc.).

**Rationale**: The sidecar manages its own configuration (Provider API Keys, default model, theme preferences). These are passed to pi subprocesses as environment variables, not via pi's config files.
