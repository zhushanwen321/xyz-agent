/**
 * TreeService — session tree operations: read tree, navigate, fork.
 *
 * Extracted from SessionService to isolate tree concerns (navigate
 * capability detection, JSONL tree parsing, navigate interceptor
 * coordination) from session lifecycle management.
 */

import type { IProcessManager, IRpcClient } from '../interfaces.js'
import type { PiMessage } from '../rpc-client.js'
import type { TreeData, NavigateResult, ForkResult } from '../types.js'
import { buildTreeFromFile, countBranches, extractFullText } from '../session-tree-reader.js'
import { NavigateInterceptor } from '../navigate-interceptor.js'

interface TreeManagedSession {
  interceptor: NavigateInterceptor
  unsubPiEvents: (() => void) | null
}

export class TreeService {
  private sessions = new Map<string, TreeManagedSession>()
  private navigateCapableMap = new Map<string, boolean>()

  constructor(private pm: IProcessManager) {}

  /** Register a session's interceptor (called during session creation). */
  registerSession(sessionId: string, interceptor: NavigateInterceptor): void {
    const client = this.pm.getClient(sessionId)
    let unsubPiEvents: (() => void) | null = null
    if (client) {
      unsubPiEvents = client.onEvent((event) => {
        if (((event as unknown) as Record<string, unknown>).type === 'message_end') {
          interceptor.onMessageEnd()
        }
      })
    }
    this.sessions.set(sessionId, { interceptor, unsubPiEvents })
  }

  /** Unregister a session (called during session destruction). */
  unregisterSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.unsubPiEvents) session.unsubPiEvents()
    this.sessions.delete(sessionId)
    this.navigateCapableMap.delete(sessionId)
  }

  /** Update navigate capability after detecting extension commands. */
  setNavigateCapable(sessionId: string, capable: boolean): void {
    this.navigateCapableMap.set(sessionId, capable)
  }

  /** Check if navigate extension is available for a session. */
  isNavigateCapable(sessionId: string): boolean {
    return this.navigateCapableMap.get(sessionId) ?? false
  }

  /** Read the session tree from JSONL file. */
  async getTree(sessionId: string): Promise<TreeData> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)

    const stateResp = await client.sendCommand('get_state') as PiMessage
    const stateData = stateResp.data ?? stateResp.payload
    let leafId = (stateData?.leafId as string | null) ?? null
    const sessionFile = stateData?.sessionFile as string | undefined

    if (!sessionFile) {
      return { sessionId, tree: [], leafId, branchCount: 0, navigateCapable: this.navigateCapableMap.get(sessionId) ?? false }
    }

    const { rootNodes, lastEntryId } = await buildTreeFromFile(sessionFile)
    const branchCount = countBranches(rootNodes)

    // Fallback: 如果 get_state 仍然没返回 leafId（旧版 pi），用 tree 最后一个 entry 近似
    if (!leafId) {
      leafId = lastEntryId
    }

    return {
      sessionId,
      tree: rootNodes,
      leafId,
      branchCount,
      navigateCapable: this.navigateCapableMap.get(sessionId) ?? false,
    }
  }

  /** Navigate to a specific entry in the session tree. */
  async navigateTree(sessionId: string, targetEntryId: string): Promise<NavigateResult> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)

    if (!this.navigateCapableMap.get(sessionId)) {
      return { success: false, error: 'Navigate extension not available' }
    }

    // 从 JSONL 读取目标 entry，提取完整 editorText + 验证 entry 存在
    let editorText: string | undefined
    try {
      const sessionFile = await this.getSessionFile(client)
      if (sessionFile) {
        const { byId, rawEntries } = await buildTreeFromFile(sessionFile)
        if (!byId.has(targetEntryId)) {
          return { success: false, error: `Entry ${targetEntryId} not found in session tree` }
        }
        const targetNode = byId.get(targetEntryId)!
        if (targetNode.role === 'user') {
          const raw = rawEntries.get(targetEntryId)
          if (raw) editorText = extractFullText(raw)
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- navigate: failure to read editor text is non-critical, continue with available content
    } catch (e) {
      console.warn('Failed to read editorText for navigate entry:', e)
    }

    // Prevent navigate result from leaking to UI
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.interceptor.setResolver(() => {})
    }

    // 发送 navigate 命令，5s 超时保护（spec AC3）
    const NAVIGATE_TIMEOUT_MS = 5_000
    try {
      await Promise.race([
        client.prompt(`/xyz-navigate ${targetEntryId}`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Navigate timeout')), NAVIGATE_TIMEOUT_MS)
        ),
      ])
    } catch (e) {
      managed?.interceptor.clearResolver()
      const msg = e instanceof Error ? e.message : String(e)
      const isTimeout = msg.includes('timeout')
      return { success: false, error: isTimeout ? 'Navigate timeout' : msg }
    }

    return { success: true, newLeafId: targetEntryId, editorText }
  }

  /** Get session file path from pi's get_state. */
  private async getSessionFile(client: IRpcClient): Promise<string | undefined> {
    const stateResp = await client.sendCommand('get_state') as PiMessage
    const stateData = stateResp.data ?? stateResp.payload
    return stateData?.sessionFile as string | undefined
  }

  /** Clone the current session (snapshot at current leaf). */
  async cloneSession(sessionId: string): Promise<ForkResult> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)

    try {
      const result = await client.sendCommand('clone') as PiMessage
      if (result.success === false) {
        return { success: false, error: result.error ?? 'Clone failed' }
      }

      const stateResp = await client.sendCommand('get_state') as PiMessage
      const stateData = stateResp.data ?? stateResp.payload
      const newSessionId = stateData?.sessionId as string | undefined

      if (!newSessionId) {
        return { success: false, error: 'Clone succeeded but could not get new session ID' }
      }

      return { success: true, newSessionId }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Fork a new session from a specific entry. */
  async forkFromEntry(sessionId: string, entryId: string): Promise<ForkResult> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)

    try {
      const result = await client.sendCommand('fork', { entryId }) as PiMessage
      if (result.success === false) {
        return { success: false, error: result.error ?? 'Fork failed' }
      }

      const stateResp = await client.sendCommand('get_state') as PiMessage
      const stateData = stateResp.data ?? stateResp.payload
      const newSessionId = stateData?.sessionId as string | undefined

      if (!newSessionId) {
        return { success: false, error: 'Fork succeeded but could not get new session ID' }
      }

      return { success: true, newSessionId }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
