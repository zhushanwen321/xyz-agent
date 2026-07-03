/**
 * TreeService — session tree operations: read tree, navigate, fork.
 *
 * Extracted from SessionService to isolate tree concerns (navigate
 * capability detection, JSONL tree parsing, navigate interceptor
 * coordination) from session lifecycle management.
 */

import type { IProcessManager, IPiEngine } from './ports/pi-engine.js'
import { readPiState } from './ports/pi-engine.js'
import type { TreeData, NavigateResult, ForkResult } from '../types.js'
import type { ITreeReader, INavigateInterceptor } from './ports/tree.js'
import type { ISessionTreeService } from '../interfaces.js'
import { toErrorMessage } from '../utils/errors.js'

interface TreeManagedSession {
  interceptor: INavigateInterceptor
  unsubPiEvents: (() => void) | null
}

export class TreeService implements ISessionTreeService {
  private sessions = new Map<string, TreeManagedSession>()
  private navigateCapableMap = new Map<string, boolean>()

  constructor(
    private pm: IProcessManager,
    private treeReader: ITreeReader,
  ) {}

  /** Register a session's interceptor (called during session creation). */
  registerSession(sessionId: string, interceptor: INavigateInterceptor): void {
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

    const stateData = await readPiState(client)
    const sessionFile = stateData?.sessionFile as string | undefined

    if (!sessionFile) {
      return { sessionId, tree: [], leafId: null, branchCount: 0, navigateCapable: this.isNavigateCapable(sessionId) }
    }

    const { rootNodes, lastEntryId } = await this.treeReader.buildTreeFromFile(sessionFile)
    const branchCount = this.treeReader.countBranches(rootNodes)

    return {
      sessionId,
      tree: rootNodes,
      leafId: lastEntryId,
      branchCount,
      navigateCapable: this.isNavigateCapable(sessionId),
    }
  }

  /** Navigate to a specific entry in the session tree. */
  async navigateTree(sessionId: string, targetEntryId: string): Promise<NavigateResult> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)

    if (!this.isNavigateCapable(sessionId)) {
      return { success: false, error: 'Navigate extension not available' }
    }

    // 从 JSONL 读取目标 entry，提取完整 editorText + 验证 entry 存在
    let editorText: string | undefined
    try {
      const sessionFile = await this.getSessionFile(client)
      if (sessionFile) {
        const { byId, rawEntries } = await this.treeReader.buildTreeFromFile(sessionFile)
        if (!byId.has(targetEntryId)) {
          return { success: false, error: `Entry ${targetEntryId} not found in session tree` }
        }
        const targetNode = byId.get(targetEntryId)!
        if (targetNode.role === 'user') {
          const raw = rawEntries.get(targetEntryId)
          if (raw) editorText = this.treeReader.extractFullText(raw)
        }
      }
    // eslint-disable-next-line taste/no-silent-catch -- navigate: failure to read editor text is non-critical, continue with available content
    } catch (e) {
      console.warn('Failed to read editorText for navigate entry:', e)
    }

    // Prevent navigate result from leaking to UI + collect result for validation
    const managed = this.sessions.get(sessionId)
    let navigateResult: { newLeafId?: string; cancelled?: boolean } | undefined
    if (managed) {
      managed.interceptor.setResolver((result: unknown) => {
        navigateResult = result as { newLeafId?: string; cancelled?: boolean } | undefined
      })
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
      const msg = toErrorMessage(e)
      const isTimeout = msg.includes('timeout')
      return { success: false, error: isTimeout ? 'Navigate timeout' : msg }
    }

    // Validate navigate actually executed (pi extension may silently fail)
    if (navigateResult?.cancelled) {
      return { success: false, error: 'Navigate was cancelled by pi extension' }
    }
    const actualLeafId = navigateResult?.newLeafId ?? targetEntryId
    return { success: true, newLeafId: actualLeafId, editorText }
  }

  /** Get session file path from pi's get_state. */
  private async getSessionFile(client: IPiEngine): Promise<string | undefined> {
    const stateData = await readPiState(client)
    return stateData?.sessionFile as string | undefined
  }

  /** Clone the current session (snapshot at current leaf). */
  async cloneSession(sessionId: string): Promise<ForkResult> {
    return this.forkOrClone(sessionId, 'clone', {}, 'Clone')
  }

  /** Fork a new session from a specific entry. */
  async forkFromEntry(sessionId: string, entryId: string): Promise<ForkResult> {
    return this.forkOrClone(sessionId, 'fork', { entryId }, 'Fork')
  }

  /**
   * clone / fork 共享实现（D9）：发命令 → 读 state → 提取 newSessionId/sessionFile。
   * 两个公开方法仅命令名/参数/错误标签不同，逻辑完全一致。
   * sendCommand 在 success===false 时已 reject，所以走到 readPiState 即代表命令成功。
   */
  private async forkOrClone(
    sessionId: string,
    command: 'clone' | 'fork',
    params: Record<string, unknown>,
    label: string,
  ): Promise<ForkResult> {
    const client = this.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not found`)

    try {
      await client.sendCommand(command, params)
      const stateData = await readPiState(client)
      const newSessionId = stateData?.sessionId as string | undefined

      if (!newSessionId) {
        return { success: false, error: `${label} succeeded but could not get new session ID` }
      }

      const sessionFile = stateData?.sessionFile as string | undefined
      return { success: true, newSessionId, sessionFile }
    } catch (e) {
      return { success: false, error: toErrorMessage(e) }
    }
  }
}
