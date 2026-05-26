/**
 * Dependency Injection interfaces for the Service layer.
 *
 * These interfaces decouple the Transport layer (server.ts) from
 * concrete implementations, enabling independent testing and
 * future swaps of business logic modules.
 */
import type {
  ServerMessage,
  SessionSummary,
  SessionGroup,
  Message,
  ProviderInfo,
  ModelInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
} from '@xyz-agent/shared'
import type { PiEventListener } from './rpc-client.js'

// ── IRpcClient ────────────────────────────────────────────────────

/** pi subprocess RPC client — high-level command API. */
export interface IRpcClient {
  prompt(content: string): Promise<unknown>
  abort(): Promise<unknown>
  setModel(provider: string, modelId: string): Promise<unknown>
  getAvailableModels(): Promise<unknown>
  getHistory(): Promise<unknown>
  compact(): Promise<unknown>
  clear(): Promise<unknown>
  sendCommand(type: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown>
  getCommands(): Promise<unknown>
  onEvent(listener: PiEventListener): () => void
  onExit(callback: (code: number | null) => void): void
  readonly exited: boolean
  kill(): Promise<void>
  start(): Promise<void>
}

// ── IProcessManager ───────────────────────────────────────────────

/** pi subprocess lifecycle manager. */
export interface IProcessManager {
  createSession(sessionId: string, cwd: string, options?: {
    cwd?: string
    provider?: string
    model?: string
    env?: Record<string, string>
    skillPaths?: string[]
    extensionPaths?: string[]
    piCommand?: string
  }): Promise<IRpcClient>
  destroySession(sessionId: string): Promise<void>
  getClient(sessionId: string): IRpcClient | undefined
  getSessionIdByClient(client: IRpcClient): string | undefined
  hasClient(sessionId: string): boolean
  rekey(oldId: string, newId: string): void
  onSessionExit(callback: (sessionId: string, code: number | null) => void): void
  destroyAll(): Promise<void>
}

// ── IMessageBroker ────────────────────────────────────────────────

/**
 * Transport-layer message broker.
 *
 * Uses `unknown` for the WebSocket parameter to avoid coupling
 * the Service layer to the `ws` module.
 */
export interface IMessageBroker {
  send(ws: unknown, msg: ServerMessage): void
  broadcast(msg: ServerMessage): void
  sendError(ws: unknown, code: string, message: string, id?: string, sessionId?: string): void
}

// ── IEventAdapter ─────────────────────────────────────────────────

/** Translates pi RPC events into WS protocol ServerMessages. */
export interface IEventAdapter {
  attach(client: { onEvent: (listener: PiEventListener) => (() => void) }): void
  detach(): void
}

// ── ISessionService ───────────────────────────────────────────────

/** Session lifecycle: creation, deletion, messaging, history. */
export interface ISessionService {
  create(cwd?: string, label?: string): Promise<SessionSummary>
  delete(sessionId: string): Promise<void>
  renameSession(sessionId: string, newName: string): Promise<void>
  sendMessage(sessionId: string, content: string): Promise<void>
  sendSubagentMessage(sessionId: string, agent: string, task: string, content?: string): Promise<void>
  abort(sessionId: string): Promise<void>
  switchModel(sessionId: string, provider: string, modelId: string): Promise<string>
  compact(sessionId: string): Promise<void>
  clear(sessionId: string): Promise<void>
  getHistory(sessionId: string): Promise<Message[]>
  restoreSession(sessionId: string): Promise<SessionSummary>
  hasActiveSession(sessionId: string): boolean
  getSummary(sessionId: string): SessionSummary | undefined
  /** Get the underlying RpcClient for direct command sending (e.g., extension responses). */
  getRpcClient(sessionId: string): IRpcClient | undefined
  listPersistedSessions(): SessionGroup[]
  destroyAll(): Promise<void>
}

// ── IConfigService ────────────────────────────────────────────────

/** Provider / Skill / Agent CRUD and tool permissions. */
export interface IConfigService {
  listProviders(): ProviderInfo[]
  setProvider(providerId: string, data: {
    name?: string
    type?: string
    apiKey?: string
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; contextWindow?: number }>
    enabled?: boolean
  }): void
  deleteProvider(providerId: string): boolean
  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined
  updateToolPermissions(permissions: Record<string, string>): void
  loadSkills(projectRoot: string): SkillInfo[]
  saveSkills(projectRoot: string, skills: SkillInfo[]): void
  upsertSkill(skill: SkillInfo): void
  deleteSkill(skillId: string): void
  loadAgents(projectRoot: string): AgentInfo[]
  saveAgents(projectRoot: string, agents: AgentInfo[]): void
  upsertAgent(agent: AgentInfo): void
  deleteAgent(agentId: string): void
  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[]
  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[]
}

// ── IExtensionService ──────────────────────────────────────────────

/** Extension lifecycle: discovery, enable/disable, path resolution. */
export interface IExtensionService {
  scanExtensions(): Promise<import('@xyz-agent/shared').ExtensionInfo[]>
  getEnabledExtensions(): Promise<import('@xyz-agent/shared').ExtensionInfo[]>
  toggleExtension(name: string, enabled: boolean): Promise<void>
  getExtensionPaths(): Promise<string[]>
}

// ── IModelService ─────────────────────────────────────────────────

/** Model aggregation and API discovery. */
export interface IModelService {
  aggregateModels(providers: ProviderInfo[]): ModelInfo[]
  discoverModelsFromApi(
    baseUrl: string,
    apiKey?: string,
    providerType?: string,
  ): Promise<Array<{ id: string; name: string; contextWindow?: number }>>
}
