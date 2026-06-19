/**
 * SessionLifecycle — 从 session-service 巨石拆出的会话生命周期职责。
 *
 * 负责:create / delete / renameSession / restoreSession / rebindAfterFork。
 *
 * sessions Map 单写者:本模块不持有 Map,经 ISessionServiceInternal 接口
 * 查(getSession)/ 删(removeSessionEntry)/ 初始化(initializeManagedSession)/
 * detach(detachSession)/ 查持久化(findScannedSession)。
 *
 * 依赖经构造注入:svc(Facade 内部协议)、pm(进程创建/销毁/rekey)、
 * treeService(register/unregister)。
 */
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { SessionSummary } from '@xyz-agent/shared'
import type { IProcessManager, ISessionServiceInternal } from '../../interfaces.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'

export class SessionLifecycle {
  constructor(
    private readonly svc: ISessionServiceInternal,
    private readonly pm: IProcessManager,
    private readonly treeService: { unregisterSession: (sessionId: string) => void },
    private readonly configStore: IConfigStore,
    private readonly sessionStore: ISessionStore,
  ) {}

  /**
   * 静默销毁 session 进程：吞掉 destroy 自身的异常（用于错误清理路径，
   * 避免清理失败掩盖原始错误）。调用方的控制流不变。
   */
  private async safeDestroy(id: string): Promise<void> {
    await this.pm.destroySession(id).catch(() => {})
  }

  async create(cwd?: string, label?: string): Promise<SessionSummary> {
    const tempId = crypto.randomUUID()
    const sessionCwd = cwd ?? process.cwd()

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
      const stateResp = await client.sendCommand('get_state') as { data?: Record<string, unknown>; payload?: Record<string, unknown> }
      const stateData = stateResp.data ?? stateResp.payload
      piSessionId = (stateData?.sessionId as string) ?? ''
      sessionFilePath = stateData?.sessionFile as string | undefined
    } catch (e) {
      await this.safeDestroy(tempId)
      throw new Error(`Failed to get session state from pi: ${e instanceof Error ? e.message : e}`)
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
      id, client, sessionCwd, label ?? basename(sessionCwd), sessionFilePath,
    )

    // pi 延迟写入:session 文件在首次 assistant 消息前可能不存在。
    // 主动创建最小文件确保 scanPiSessions 能找到该 session。
    if (sessionFilePath) {
      this.sessionStore.ensureSessionFile(sessionFilePath, id, sessionCwd, label)
    }

    this.sessionStore.refreshAll()
    return this.svc.toSummary(session)
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.svc.getSession(sessionId)
    if (session) {
      session.label = newName
      // 活跃 session:写入 sessionFilePath 使重启后保留
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
      this.treeService.unregisterSession(sessionId)
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
      await client.sendCommand('switch_session', { sessionPath: target.filePath })
    } catch (e) {
      // switch_session 失败时清理已创建的资源,避免子进程/监听器泄漏
      await this.safeDestroy(id)
      throw e
    }

    const session = await this.svc.initializeManagedSession(
      id, client, sessionCwd, target.name ?? basename(sessionCwd), target.filePath,
    )
    return this.svc.toSummary(session)
  }

  /**
   * Fork 后重新绑定:原 session 的 pi 进程已被 rebind 到新 session,
   * 需更新 runtime 的 sessions Map 和 process manager 的 key。
   * 必须同步等待初始化完成,否则后续请求(tree-data、navigate)可能因注册未完成而失败。
   */
  async rebindAfterFork(oldSessionId: string, newSessionId: string, label: string, sessionFilePath?: string): Promise<void> {
    const old = this.svc.getSession(oldSessionId)
    if (!old) throw new Error(`Session ${oldSessionId} not found in sessions map`)

    // 先 rekey process manager(client 仍是同一个 pi 进程)。
    // 必须在 detach/delete 之前执行,确保 rekey 失败时旧状态不被破坏。
    this.pm.rekey(oldSessionId, newSessionId)

    // rekey 成功后,安全地清理旧 session 的 adapter/listener/registry
    this.svc.detachSession(oldSessionId)
    this.treeService.unregisterSession(oldSessionId)
    this.svc.removeSessionEntry(oldSessionId)

    // 用新 ID 重新注册 managed session(label 由调用方传入,已含 -fork/-clone 后缀)
    const client = this.pm.getClient(newSessionId)
    if (!client) throw new Error(`Client not found after rekey: ${newSessionId}`)
    await this.svc.initializeManagedSession(newSessionId, client, old.cwd, label, sessionFilePath)
  }
}
