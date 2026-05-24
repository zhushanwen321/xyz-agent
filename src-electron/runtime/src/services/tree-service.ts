/**
 * TreeService — session tree operations: read tree, navigate, fork.
 *
 * Extracted from SessionService to isolate tree concerns (navigate
 * capability detection, JSONL tree parsing, navigate interceptor
 * coordination) from session lifecycle management.
 */

import type { IProcessManager } from '../interfaces.js'
import type { PiMessage } from '../rpc-client.js'
import type { TreeData, NavigateResult, ForkResult } from '../types.js'
import { buildTreeFromFile, countBranches } from '../session-tree-reader.js'
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
    // Subscribe to pi events to detect message_end for navigate cleanup
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
    const leafId = (stateData?.leafId as string) ?? null
    const sessionFile = stateData?.sessionFile as string | undefined

    if (!sessionFile) {
      return { sessionId, tree: [], leafId, branchCount: 0, navigateCapable: this.navigateCapableMap.get(sessionId) ?? false }
    }

    const { rootNodes } = await buildTreeFromFile(sessionFile)
    const branchCount = countBranches(rootNodes)

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

    // no-op: navigate to current leaf
    const stateResp = await client.sendCommand('get_state') as PiMessage
    const currentLeafId = (stateResp.data ?? stateResp.payload)?.leafId as string | undefined
    if (currentLeafId === targetEntryId) {
      return { success: true, newLeafId: targetEntryId }
    }

    if (!this.navigateCapableMap.get(sessionId)) {
      return { success: false, error: 'Navigate extension not available' }
    }

    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} tree state not found`)

    return new Promise<NavigateResult>((resolve) => {
      const timeout = setTimeout(() => {
        session.interceptor.clearResolver()
        resolve({ success: false, error: 'Navigate 超时' })
      }, 5000)

      session.interceptor.setResolver((data: unknown) => {
        clearTimeout(timeout)
        const result = data as { cancelled?: boolean; newLeafId?: string; editorText?: string | null }
        resolve({
          success: !result.cancelled,
          newLeafId: result.newLeafId,
          editorText: result.editorText ?? undefined,
        })
      })

      client.prompt(`/xyz-navigate ${targetEntryId}`).catch((e) => {
        clearTimeout(timeout)
        session.interceptor.clearResolver()
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) })
      })
    })
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
