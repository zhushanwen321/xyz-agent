/**
 * SessionLifecycle — 从 session-service 巨石拆出的会话生命周期职责。
 *
 * 负责:create / delete / renameSession / restoreSession。
 *
 * sessions Map 单写者:本模块不持有 Map,经 ISessionServiceInternal 接口
 * 查(getSession)/ 删(removeSessionEntry)/ 初始化(initializeManagedSession)/
 * detach(detachSession)/ 查持久化(findScannedSession)。
 *
 * 依赖经构造注入:svc(Facade 内部协议)、pm(进程创建/销毁/rekey)。
 */
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { SessionSummary } from '@xyz-agent/shared'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { toErrorMessage } from '../../utils/errors.js'
import { createForkedSessionFile } from './session-fork.js'
import { getSessionsDir } from '../../infra/pi/pi-paths.js'

export class SessionLifecycle {
  constructor(
    private readonly svc: ISessionServiceInternal,
    private readonly pm: IProcessManager,
    private readonly configStore: IConfigStore,
    private readonly sessionStore: ISessionStore,
    private readonly workspaceService: WorkspaceService,
  ) {}

  /**
   * 静默销毁 session 进程：吞掉 destroy 自身的异常（用于错误清理路径，
   * 避免清理失败掩盖原始错误）。调用方的控制流不变。
   */
  private async safeDestroy(id: string): Promise<void> {
    await this.pm.destroySession(id).catch(() => {})
  }

  async create(cwd?: string, label?: string, options?: { hidden?: boolean }): Promise<SessionSummary> {
    const tempId = crypto.randomUUID()
    const requestedCwd = cwd ?? process.cwd()
    // INV-7: cwd 可能已被删除（worktree 清理/手动删目录），降级 homedir（与 restoreSession 对称）。
    // 前端 useNewTaskFlow 通过比对「请求 cwd」vs「reply session.cwd」判断是否 fallback 并 toast。
    const sessionCwd = existsSync(requestedCwd) ? requestedCwd : (() => {
      console.warn(`[session-lifecycle] create cwd does not exist: ${requestedCwd}, falling back to home`)
      return homedir()
    })()

    // 启动 pi 前检查 model 配置,避免 pi 因无 model 直接 exit(1)
    if (!this.configStore.getDefaultModel()) {
      throw new Error('No model configured. Please configure a provider and model in Settings before starting a session.')
    }

    const allExtPaths = await this.svc.getExtensionPaths()
    const client = await this.pm.createSession(tempId, sessionCwd, {
      skillPaths: this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
    })

    // 从 pi 获取真实 session ID
    let piSessionId: string
    let sessionFilePath: string | undefined
    try {
      const stateData = await client.getState()
      piSessionId = (stateData?.sessionId as string) ?? ''
      sessionFilePath = stateData?.sessionFile as string | undefined
    } catch (e) {
      await this.safeDestroy(tempId)
      throw new Error(`Failed to get session state from pi: ${toErrorMessage(e)}`)
    }

    if (!piSessionId) {
      await this.safeDestroy(tempId)
      throw new Error('pi did not return a session ID')
    }

    // 用 pi 的真实 ID 替换临时 ID
    const id = piSessionId
    if (id !== tempId) {
      this.pm.rekey(tempId, id)
    }

    const session = await this.svc.initializeManagedSession(
      id, client, sessionCwd, label ?? basename(sessionCwd), sessionFilePath, options?.hidden,
    )

    // [HISTORICAL] 不再调 ensureSessionFile 提前创建 session 文件。
    // 之前的实现在此处用 openSync(wx) 创建含 session+session_info 两行的最小文件，理由是
    // 「pi 延迟写入期间 scanPiSessions 找不到该 session」。但这与 pi 0.80.3 SessionManager._persist
    // 的写入策略冲突：_persist 首次 flush（收到 assistant 消息时）也用 openSync("wx")，撞上已存在文件
    // → EEXIST → pi 抛 message_start{stopReason:"error"} → 整个 session 永久卡死。
    // 现在依赖 SessionScanner.listAll 的合并机制：active session 从内存 Map（this.sessions）读，
    // 即使磁盘无文件也显示（restart 后内存清空，但此时未 flush 的 session 本就无内容，丢失合理）。
    this.sessionStore.refreshAll()
    // hidden session（公共 session）不记工作区历史——cwd 是数据目录，不应污染最近工作区列表
    if (!options?.hidden) {
      this.workspaceService.record(sessionCwd)
    }
    return this.svc.toSummary(session)
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.svc.getSession(sessionId)
    if (session) {
      session.label = newName
      // 重置 labelPersisted：rename 后新名需要重新写盘。
      // 若文件已存在（pi 已 flush），persistSessionName 的 append 分支立即写 session_info；
      // 若文件不存在（pi 延迟写入窗口），persistSessionName no-op，labelPersisted=false 让
      // tryPersistLabel 在下次 turn_end/agent_end 兜底写新名（规则 #6：绝不提前建文件）。
      session.labelPersisted = false
      if (session.sessionFilePath) {
        this.sessionStore.persistSessionName(session.sessionFilePath, newName, session.id, session.cwd)
      }
    } else {
      // 非 active session:从磁盘查找 jsonl 文件并写入
      const target = this.svc.findScannedSession(sessionId)
      if (target) {
        this.sessionStore.persistSessionName(target.filePath, newName, target.id, target.cwd)
      }
    }

    this.sessionStore.refreshAll()
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.svc.getSession(sessionId)
    if (session) {
      this.svc.detachSession(sessionId)
      await this.pm.destroySession(sessionId)
      this.svc.removeSessionEntry(sessionId)
      if (session.sessionFilePath && existsSync(session.sessionFilePath)) {
        await this.sessionStore.trash(session.sessionFilePath)
      }
    } else {
      const target = this.svc.findScannedSession(sessionId)
      if (!target) throw new Error(`Session ${sessionId} not found`)
      if (existsSync(target.filePath)) await this.sessionStore.trash(target.filePath)
    }
    this.sessionStore.refreshAll()
  }

  /** 从持久化文件恢复 session。 */
  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const target = this.svc.findScannedSession(sessionId)
    if (!target) throw new Error(`Persisted session ${sessionId} not found`)

    if (!this.configStore.getDefaultModel()) {
      throw new Error('No model configured. Please configure a provider and model in Settings before restoring a session.')
    }
    const existing = this.svc.getSession(sessionId)
    if (existing) {
      this.svc.detachSession(sessionId)
      await this.safeDestroy(sessionId)
      this.svc.removeSessionEntry(sessionId)
    }

    // session cwd 可能已被删除(如 worktree 清理后),降级到 home + patch session 文件
    const sessionCwd = existsSync(target.cwd) ? target.cwd : (() => {
      console.warn(`[session-lifecycle] session cwd does not exist: ${target.cwd}, falling back to home`)
      this.sessionStore.patchSessionCwd(target.filePath, homedir())
      return homedir()
    })()

    const id = sessionId
    const allExtPaths = await this.svc.getExtensionPaths()
    const client = await this.pm.createSession(id, sessionCwd, {
      skillPaths: this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
    })

    try {
      await client.switchSession(target.filePath)
    } catch (e) {
      // switch_session 失败时清理已创建的资源,避免子进程/监听器泄漏
      await this.safeDestroy(id)
      throw e
    }

    const session = await this.svc.initializeManagedSession(
      id, client, sessionCwd, target.name ?? basename(sessionCwd), target.filePath,
    )
    // 恢复后兜底广播一次上下文用量（pi 从历史估算 contextUsage）。
    // 注意：此广播可能早于前端订阅新 sessionId 通道（时序竞争，见架构约定 #7），
    // 前端 useSidebar.selectSession 会主动调 session.getContext 再拉一次保证到达。
    // fire-and-forget：拉取失败不阻塞 session 恢复。
    void this.svc.fetchAndBroadcastContext(id)
    return this.svc.toSummary(session)
  }

  /**
   * Fork session（路径 A：runtime 读 JSONL 截断 + 新进程 switch_session）。
   *
   * 与 restoreSession 的差异：restore 切到已存在的完整文件；fork 先按 fromPiEntryId 截断
   * 源 JSONL 写新文件，再 switch_session 到截断后的文件。源 session 的 pi 进程不动。
   *
   * fork 后的新 session 独立运行（独立 pi 进程），原 session 保持不变。
   * 这符合 UI 语义（fork 到另一 panel，原 panel 继续）。
   *
   * @param srcSessionId   源 session id
   * @param fromPiEntryId  fork 点的 pi entryId（前端 Message.piEntryId）
   * @param includeFrom    true: 保留到该 entry（含）；false: 保留到该 entry 前（不含）
   * @param label          可选 session 名
   */
  async forkSession(
    srcSessionId: string,
    fromPiEntryId: string,
    includeFrom: boolean,
    label?: string,
  ): Promise<SessionSummary> {
    if (!this.configStore.getDefaultModel()) {
      throw new Error('No model configured. Please configure a provider and model in Settings before forking a session.')
    }

    // 1. 查源 session 文件路径（scanSessions 合并磁盘 + 内存 active）
    const source = this.svc.findScannedSession(srcSessionId)
    if (!source) {
      throw new Error(`fork: source session not found: ${srcSessionId}`)
    }

    // 2. 截断源 JSONL → 写新文件（parentSession 指回源文件，形成父子链）
    const { filePath: forkedFilePath, sessionId: forkedId } = await createForkedSessionFile(
      source.filePath,
      fromPiEntryId,
      includeFrom,
      getSessionsDir(),
    )

    // 3. spawn 新 pi 进程（与 restore 同模式）
    const sessionCwd = existsSync(source.cwd) ? source.cwd : homedir()
    const allExtPaths = await this.svc.getExtensionPaths()
    const client = await this.pm.createSession(forkedId, sessionCwd, {
      skillPaths: this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
    })

    try {
      // 4. switch_session 让 pi 加载截断后的历史
      await client.switchSession(forkedFilePath)
    } catch (e) {
      await this.safeDestroy(forkedId)
      throw e
    }

    // 5. 初始化 managed session（adapter、入 sessions Map）
    const session = await this.svc.initializeManagedSession(
      forkedId, client, sessionCwd, label ?? basename(sessionCwd), forkedFilePath,
    )

    void this.svc.fetchAndBroadcastContext(forkedId)
    return this.svc.toSummary(session)
  }
}
