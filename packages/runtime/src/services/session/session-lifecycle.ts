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
import { basename, join } from 'node:path'
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import type { SessionSummary, BatchDeleteResult, ThinkingLevel } from '@xyz-agent/shared'
import { BUILTIN_PRESET_IDS } from '@xyz-agent/shared'
import type { IProcessManager } from '../ports/pi-engine.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IManagedSessionView } from './types.js'
import type { PresetResolution } from '../preset-service.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { toErrorMessage, errorWithCode, MODEL_NOT_CONFIGURED } from '../../utils/errors.js'
import { createForkedSessionFile } from './session-fork.js'
import { getSessionsDir } from '../../infra/pi/pi-paths.js'

/**
 * 从 JSONL 文本中剔除 session_end 行（W9）。
 *
 * 背景：B7 sidecar 方案下 runtime 不再往 JSONL 写 session_end（改写 .meta.json sidecar）。
 * 但历史 session（迁移前写入的）JSONL 仍可能含 `type:"session_end"` 行；extractSessionOutcome 的
 * fallback 也仍会读 JSONL 中的 session_end。pi switchSession 对该 entry type 的处理未验证，
 * restore/fork 拷贝整份 JSONL 时保守 strip 掉比让 pi 报错更安全。
 *
 * 实现按行扫描：匹配 `"type":"session_end"` 或 `'type':'session_end'`（容忍引号/空格差异），
 * 命中的整行丢弃，其余行原样保留（含换行）。纯文本扫描不解析 JSON，避免格式异常的行被误吞。
 *
 * @param jsonlContent 原始 JSONL 文本
 * @returns 剔除 session_end 行后的文本（行数可能减少；末尾换行保留）
 */
export function stripSessionEndEntries(jsonlContent: string): string {
  // 匹配 "type":"session_end" / "type": "session_end" / 'type':'session_end' 等变体。
  // 用单/双引号字符类容忍 JSON.stringify（双引号）与手写（单引号）两种写法。
  const sessionEndRe = /["']type["']\s*:\s*["']session_end["']/
  const lines = jsonlContent.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (line === '') continue // split 末尾产生的空串（原末尾换行）跳过，末尾统一补回
    if (sessionEndRe.test(line)) continue
    kept.push(line)
  }
  // 末尾统一补一个换行（pi _persist 期望每行以 \n 结尾）
  return kept.length > 0 ? kept.join('\n') + '\n' : ''
}

/**
 * thinkingLevel 合法值集合（S-RT-5）。
 *
 * 与 shared ThinkingLevel 类型对齐（pi CLI --thinking 参数值域，附录 A.4）。
 * 用 readonly 数组做运行时校验：lifecycle 透传 thinkingOverride 到 pi 前先校验，
 * 非法值 warn 后忽略（不传给 pi，避免 pi 报错或行为异常）。
 */
const VALID_THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

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

  /**
   * 构建 create/restoreSession/forkSession 三处共用的 preset + override client options 子集（S-RT-4）。
   *
   * 三处原先用完全相同的 spread 模式（toolArgs/flags/modelOverride/thinkingOverride 条件 spread），
   * 抽 helper 消除重复，保证三处 preset 字段映射逻辑完全一致（避免一处改动另两处漏改）。
   *
   * 输入：
   *  - resolution：PresetService.resolve 的结果（可能 undefined → 返回空对象，仅 override 生效）。
   *  - modelOverride / thinkingOverride：Landing Chip 传入值，覆盖 preset 的同名字段（C-RL-6 优先级）。
   *
   * 输出：PiSessionOptions 的子集（preset 相关字段），调用方再与 skillPaths/extensionPaths/systemPrompt
   * 等基础字段合并 spread 进 createSession。返回的子集字段都是可选的，undefined 字段不出现（条件 spread）。
   *
   * S-RT-5：thinkingOverride 校验合法值，非法值 warn 后忽略（不透传给 pi）。
   */
  private buildPresetClientOptions(
    resolution: PresetResolution | undefined,
    modelOverride: string | undefined,
    thinkingOverride: string | undefined,
  ): {
    tools?: string[]
    excludeTools?: string[]
    noTools?: boolean
    noSkills?: boolean
    noContextFiles?: boolean
    model?: string
    thinkingLevel?: ThinkingLevel
  } {
    // C-RL-6 优先级（设计文档 §5.2）：Landing 传入 > preset 字段。
    // model 不校验值域（provider/modelId 形式自由，pi 报错由用户感知）。
    const effectiveModel = modelOverride ?? resolution?.modelOverride
    // S-RT-5：thinkingLevel 校验合法值。Landing 传入与 preset 字段都可能是非法值
    //（如前端未约束 / preset JSON 手改），透传给 pi 会触发 pi 报错或静默忽略，统一在此拦截。
    const rawThinking = thinkingOverride ?? resolution?.thinkingLevel
    const effectiveThinking = rawThinking && VALID_THINKING_LEVELS.includes(rawThinking)
      ? rawThinking
      : undefined
    if (rawThinking && !VALID_THINKING_LEVELS.includes(rawThinking)) {
      console.warn(`[lifecycle] invalid thinking level: ${rawThinking}, ignored`)
    }

    return {
      // preset 字段（resolution 存在时才设，条件 spread 避免 undefined 覆盖默认）
      ...(resolution?.toolArgs.tools && { tools: resolution.toolArgs.tools }),
      ...(resolution?.toolArgs.excludeTools && { excludeTools: resolution.toolArgs.excludeTools }),
      ...(resolution?.toolArgs.noTools && { noTools: true }),
      ...(resolution?.flags.noSkills && { noSkills: true }),
      ...(resolution?.flags.noContextFiles && { noContextFiles: true }),
      ...(effectiveModel && { model: effectiveModel }),
      ...(effectiveThinking && { thinkingLevel: effectiveThinking as ThinkingLevel }),
    }
  }

  async create(cwd?: string, label?: string, options?: {
    hidden?: boolean
    /** Launch preset id（设计文档 §5，绑定到新 session 并解析为 pi 启动参数）。 */
    presetId?: string
    /** Landing Model Chip 传入值，覆盖 preset.modelOverride（C-RL-6 优先级）。 */
    modelOverride?: string
    /** Landing Thinking Chip 传入值，覆盖 preset.thinkingLevel（C-RL-6 优先级）。 */
    thinkingOverride?: string
  }): Promise<SessionSummary> {
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
      throw errorWithCode('No model configured. Please configure a provider and model in Settings before starting a session.', MODEL_NOT_CONFIGURED)
    }

    // Preset 解析（设计文档 §5/§8.1）：presetId 存在时委托 PresetService.resolve，
    // 返回 PresetResolution 供 options 映射；undefined（presetService 未注入/preset 被删）
    // 时 fallback 现有 svc.getExtensionPaths/getSkillPaths 逻辑。
    const presetId = options?.presetId
    const resolution = presetId ? await this.svc.getLaunchPresetOptions(presetId, sessionCwd) : undefined

    const allExtPaths = resolution?.extensionPaths ?? await this.svc.getExtensionPaths(sessionCwd)
    // preset + override 字段经 buildPresetClientOptions 统一构建（S-RT-4 消除三处重复），
    // 含 C-RL-6 优先级（Landing 传入 > preset 字段）与 thinkingLevel 合法值校验（S-RT-5）。
    const presetClientOptions = this.buildPresetClientOptions(
      resolution, options?.modelOverride, options?.thinkingOverride,
    )
    const client = await this.pm.createSession(tempId, sessionCwd, {
      skillPaths: resolution?.skillPaths ?? this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
      systemPrompt: this.svc.getReplaceSystemPrompt(),
      ...presetClientOptions,
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

    // M3: initializeManagedSession 失败时（adapterFactory/attach 可能抛错），
    // pi 进程已 spawn 但未进 sessions Map → 不可见不可销毁的僵尸进程。
    // try-catch + safeDestroy 保证异常时清理 pi 进程。
    let session: IManagedSessionView
    try {
      // Staging Mode（ADR-0056）：透传 effectiveModel（presetClientOptions.model，已含 C-RL-6 优先级解析）
      // 让 session 元数据 modelId 反映实际启动模型，前端 composer chip 正确显示。
      session = await this.svc.initializeManagedSession(
        id, client, sessionCwd, label ?? basename(sessionCwd), sessionFilePath, options?.hidden,
        undefined, undefined, presetClientOptions.model,
      )
    } catch (initErr) {
      await this.safeDestroy(id)
      throw initErr
    }

    // [HISTORICAL] 不再调 ensureSessionFile 提前创建 session 文件。
    // 之前的实现在此处用 openSync(wx) 创建含 session+session_info 两行的最小文件，理由是
    // 「pi 延迟写入期间 scanPiSessions 找不到该 session」。但这与 pi 0.80.3 SessionManager._persist
    // 的写入策略冲突：_persist 首次 flush（收到 assistant 消息时）也用 openSync("wx")，撞上已存在文件
    // → EEXIST → pi 抛 message_start{stopReason:"error"} → 整个 session 永久卡死。
    // 现在依赖 SessionScanner.listAll 的合并机制：active session 从内存 Map（this.sessions）读，
    // 即使磁盘无文件也显示（restart 后内存清空，但此时未 flush 的 session 本就无内容，丢失合理）。
    this.sessionStore.refreshAll()
    // 持久化 preset 绑定到 .preset.json sidecar（设计文档 §4）。
    // presetId 存在时写 sidecar，供 fork/restore 继承；sessionFilePath 不存在（pi 延迟写入窗口）
    // 时 persistPresetBinding 内部 existsSync 守卫跳过（ES-RL-1，wave2 实现）。
    // W-RT-4：sidecar 跳过时内存态兜底——patch session 对象的 launchPresetId 字段
    //（ManagedSession 实例可扩展），fork 在 active 期经 getSession(srcId)?.launchPresetId
    // 读到（W-RT-5），避免拿不到 preset。toSummary 透传此字段到 SessionSummary。
    if (presetId) {
      ;(session as { launchPresetId?: string }).launchPresetId = presetId
      if (session.sessionFilePath) {
        this.sessionStore.persistPresetBinding(session.sessionFilePath, presetId)
      }
    }
    // hidden session（公共 session）不记工作区历史——cwd 是数据目录，不应污染最近工作区列表。
    // homedir 过滤（含降级 homedir）由 WorkspaceService.record 统一负责（方案A，一处堵死全部路径），
    // lifecycle 层不再关心 cwd 是否降级。
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
        // 清理 sidecar（删除失败不阻塞主流程）
        try { unlinkSync(session.sessionFilePath + '.meta.json') } catch { void 0 }
        // 清理 preset 绑定 sidecar（设计文档 §4，delete 是唯一清理点）
        try { unlinkSync(session.sessionFilePath + '.preset.json') } catch { void 0 }
        // W-Runtime4：清理 sessionMetaCache 中的 stale 条目（避免无界增长）
        this.sessionStore.invalidateMetaCache(session.sessionFilePath)
      }
    } else {
      const target = this.svc.findScannedSession(sessionId)
      if (!target) throw new Error(`Session ${sessionId} not found`)
      if (existsSync(target.filePath)) await this.sessionStore.trash(target.filePath)
      // 清理 sidecar（删除失败不阻塞主流程）
      try { unlinkSync(target.filePath + '.meta.json') } catch { void 0 }
      // 清理 preset 绑定 sidecar（设计文档 §4，delete 是唯一清理点）
      try { unlinkSync(target.filePath + '.preset.json') } catch { void 0 }
      // W-Runtime4：清理 sessionMetaCache 中的 stale 条目（避免无界增长）
      this.sessionStore.invalidateMetaCache(target.filePath)
    }
    this.sessionStore.refreshAll()
  }

  /**
   * 批量删除指定 cwd（folder）下所有 session。
   *
   * best-effort 策略：单个 session 删除失败不中断循环，聚合 deleted/failed 返回。
   * 查询合并 active（getActiveSummaries）+ persisted（scanSessions）去重，
   * 覆盖 active 但 JSONL 未 flush 的边界场景（AGENTS.md 关键规则 #6）。
   * 不调广播——广播由 caller（session-message-handler）控制。
   *
   * cwd 匹配用字面 === ：依赖 caller 传入与 summary.cwd 一致的字符串
   *（前端 folder 删除按钮传的是 listPersistedSessions 返回的原始 cwd，不经规范化）。
   *
   * 故意包含 hidden session（与 SessionScanner.listAll 的 !s.hidden 过滤不同）：
   * folder 删除是按 cwd 的彻底清理，hidden session 也属于该 cwd。
   * 若未来要改为排除 hidden，需同步评估前端列表（listAll 过滤）与删除的语义对齐。
   */
  async deleteByCwd(cwd: string): Promise<BatchDeleteResult> {
    const cwdSessions = new Set<string>()
    for (const s of this.svc.getActiveSummaries()) {
      if (s.cwd === cwd) cwdSessions.add(s.id)
    }
    for (const s of this.sessionStore.scanSessions()) {
      if (s.cwd === cwd) cwdSessions.add(s.id)
    }
    const deleted: string[] = []
    const failed: Array<{ sessionId: string; error: string }> = []
    for (const id of cwdSessions) {
      try {
        await this.delete(id)
        deleted.push(id)
      } catch (e) {
        console.warn(`[session-lifecycle] deleteByCwd: failed to delete ${id}`, toErrorMessage(e))
        failed.push({ sessionId: id, error: toErrorMessage(e) })
      }
    }
    return { cwd, deleted, failed }
  }

  /** 从持久化文件恢复 session。 */
  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const target = this.svc.findScannedSession(sessionId)
    if (!target) throw new Error(`Persisted session ${sessionId} not found`)

    if (!this.configStore.getDefaultModel()) {
      throw errorWithCode('No model configured. Please configure a provider and model in Settings before restoring a session.', MODEL_NOT_CONFIGURED)
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
    // preset 是 launch 配置不是终态（设计文档 §4.5），restore 后仍属同一 preset，
    // .preset.json sidecar 不清理。target.launchPresetId undefined 时（历史 session 无 sidecar）
    // 用 'builtin:full' 兜底（FR-10）。
    const presetId = target.launchPresetId ?? BUILTIN_PRESET_IDS.FULL
    const resolution = await this.svc.getLaunchPresetOptions(presetId, sessionCwd)
    const allExtPaths = resolution?.extensionPaths ?? await this.svc.getExtensionPaths(sessionCwd)
    // restore 不接收 Landing Chip override（无用户交互），只透传 preset 自身的 model/thinking。
    const presetClientOptions = this.buildPresetClientOptions(resolution, undefined, undefined)
    const client = await this.pm.createSession(id, sessionCwd, {
      skillPaths: resolution?.skillPaths ?? this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
      systemPrompt: this.svc.getReplaceSystemPrompt(),
      ...presetClientOptions,
    })

    try {
      // B7: sidecar 方案下 JSONL 无 session_end entry（persistSessionEnd 写 .meta.json sidecar），无需 strip。
      // 保守隔离：pi switchSession 对源文件的写回行为未确认，先拷贝到 tmpdir 再 switchSession，
      // 避免 pi 可能的写回污染原 JSONL（原文件仍是 source of truth，需保持完整）。
      // W9：历史 session（迁移前写入的）JSONL 可能含 session_end 行，pi 对该 type 处理未验证 →
      // 拷贝时 stripSessionEndEntries 保守剔除（比让 pi 报错更安全；其他行原样保留）。
      const cleaned = stripSessionEndEntries(readFileSync(target.filePath, 'utf-8'))
      const tmpFile = join(tmpdir(), `xyz-session-${sessionId}-${Date.now()}.jsonl`)
      writeFileSync(tmpFile, cleaned)
      try {
        await client.switchSession(tmpFile)
      } finally {
        // switch 完成后清理临时文件，pi 已读入内存
        try { unlinkSync(tmpFile) } catch { void 0 }
      }
      // W2-4：清理旧 sidecar 移到 switchSession 成功之后。
      // 原顺序是 switchSession 之前 unlink，若 switchSession 抛错，原 session 的终态 sidecar
      //（done/stopped）已被删 → 原会话终态永久丢失。现在只在切换成功后才删，失败时保留旧终态。
      try { unlinkSync(target.filePath + '.meta.json') } catch { void 0 }
    } catch (e) {
      // switch_session 失败时清理已创建的资源,避免子进程/监听器泄漏
      await this.safeDestroy(id)
      throw e
    }

    // M3: initializeManagedSession 失败时清理 pi 进程（与 create 同模式）
    let session: IManagedSessionView
    try {
      session = await this.svc.initializeManagedSession(
        id, client, sessionCwd, target.name ?? basename(sessionCwd), target.filePath,
      )
    } catch (initErr) {
      await this.safeDestroy(id)
      throw initErr
    }
    // 恢复后兜底广播一次上下文用量（pi 从历史估算 contextUsage）。
    // 注意：此广播可能早于前端订阅新 sessionId 通道（时序竞争，见架构约定 #7），
    // 前端 useSidebar.selectSession 会主动调 session.getContext 再拉一次保证到达。
    // fire-and-forget：拉取失败不阻塞 session 恢复。
    void this.svc.fetchAndBroadcastContext(id)
    // W-RT-4：恢复后 session 变 active，patch 内存态 launchPresetId（与 sidecar 并列兜底）。
    ;(session as { launchPresetId?: string }).launchPresetId = presetId
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
    options?: {
      /**
       * Staging Mode（ADR-0056）：composer 暂存的模型覆盖，优先于源 preset.modelOverride。
       * undefined 时 fork 仅继承源 preset（旧行为）。
       */
      modelOverride?: string
      /** Staging Mode（ADR-0056）：composer 暂存的思考等级覆盖，优先于源 preset.thinkingLevel。 */
      thinkingOverride?: string
    },
  ): Promise<SessionSummary> {
    if (!this.configStore.getDefaultModel()) {
      throw errorWithCode('No model configured. Please configure a provider and model in Settings before forking a session.', MODEL_NOT_CONFIGURED)
    }

    // 1. 查源 session 文件路径（scanSessions 合并磁盘 + 内存 active）
    const source = this.svc.findScannedSession(srcSessionId)
    if (!source) {
      throw new Error(`fork: source session not found: ${srcSessionId}`)
    }

    // FR-20 parentSession fallback：源 session 可能尚未落盘（pi 延迟写入窗口，
    // 内存 active session 的 sessionFilePath=undefined）。fork 时若用未落盘的临时路径
    // 作 parentSession 会断裂血缘链，故用源 sessionId 作 fallback 键。
    // 仅当源 sessionFilePath 缺失时才传 fallbackParentId（落盘则用真实路径，更可读）。
    const sourceActive = this.svc.getSession(srcSessionId)
    const fallbackParentId = sourceActive?.sessionFilePath ? undefined : srcSessionId

    // 2. 截断源 JSONL → 写新文件（parentSession 指回源文件/源 sessionId，形成父子链）
    // forkEntryId 字段写入新 header（= 截断锚点 fromPiEntryId），供后续 merge 定位 fork 点
    const { filePath: forkedFilePath, sessionId: forkedId } = await createForkedSessionFile(
      source.filePath,
      fromPiEntryId,
      includeFrom,
      getSessionsDir(),
      fromPiEntryId,
      fallbackParentId,
    )

    // 3. spawn 新 pi 进程（与 restore 同模式）
    // fork 继承源 session 的 preset（设计文档 §4.5）。
    // W-RT-5：优先读 active 源 session 的内存态 launchPresetId（pi 延迟写入窗口下
    // sidecar 未写时，内存态兜底——getSession 返回 ManagedSession 实例，as 读 launchPresetId 字段），
    // 再 fallback 到扫描结果的 sidecar 值（source.launchPresetId），
    // 最后兜底 'builtin:full'（FR-10，历史 session 无 sidecar）。
    const sessionCwd = existsSync(source.cwd) ? source.cwd : homedir()
    const forkPresetId = (this.svc.getSession(srcSessionId) as { launchPresetId?: string } | undefined)?.launchPresetId
      ?? source.launchPresetId
      ?? BUILTIN_PRESET_IDS.FULL
    const forkResolution = await this.svc.getLaunchPresetOptions(forkPresetId, sessionCwd)
    const allExtPaths = forkResolution?.extensionPaths ?? await this.svc.getExtensionPaths(sessionCwd)
    // Staging Mode（ADR-0056）：override 优先于源 preset 的 modelOverride/thinkingLevel（见 buildPresetClientOptions
    // 内 C-RL-6 优先级）。undefined 时仅继承源 preset（旧行为），不影响现有 fork。
    const presetClientOptions = this.buildPresetClientOptions(
      forkResolution,
      options?.modelOverride,
      options?.thinkingOverride,
    )
    const client = await this.pm.createSession(forkedId, sessionCwd, {
      skillPaths: forkResolution?.skillPaths ?? this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
      systemPrompt: this.svc.getReplaceSystemPrompt(),
      ...presetClientOptions,
    })

    try {
      // 4. switch_session 让 pi 加载截断后的历史。
      // B7: sidecar 方案下 JSONL 无 session_end entry（persistSessionEnd 写 .meta.json sidecar），无需 strip。
      // 保守隔离：pi switchSession 对源文件的写回行为未确认，先拷贝到 tmpdir 再 switchSession，
      // 避免 pi 可能的写回污染 forkedFilePath（fork 产物需保持完整）。
      // W9：fork 产物虽由 createForkedSessionFile 按树过滤生成（session_end 不在 keepIds 内本就不写入），
      // 但保守 strip 一道——防御 createForkedSessionFile 行为变更或源文件含游离 session_end 行。
      const cleaned = stripSessionEndEntries(readFileSync(forkedFilePath, 'utf-8'))
      const tmpFile = join(tmpdir(), `xyz-fork-${forkedId}-${Date.now()}.jsonl`)
      writeFileSync(tmpFile, cleaned)
      try {
        await client.switchSession(tmpFile)
      } finally {
        try { unlinkSync(tmpFile) } catch { void 0 }
      }
      // W2-4：清理旧 sidecar 移到 switchSession 成功之后。
      // 原顺序是 switchSession 之前 unlink，若 switchSession 抛错，session 的终态 sidecar
      //（done/stopped）已被删 → 终态永久丢失。现在只在切换成功后才删，失败时保留旧终态。
      try { unlinkSync(forkedFilePath + '.meta.json') } catch { void 0 }
      // 写 preset 绑定到 forkedFilePath 的 sidecar（设计文档 §4.5）。
      // fork 继承源 preset，forkedFilePath 是新文件（已写出），existsSync 守卫会通过。
      this.sessionStore.persistPresetBinding(forkedFilePath, forkPresetId)
    } catch (e) {
      // L5: switchSession 失败时清理孤儿 fork 文件（已写出但 pi 未能加载）
      await this.safeDestroy(forkedId)
      await unlink(forkedFilePath).catch(() => {})
      throw e
    }

    // 5. 初始化 managed session（adapter、入 sessions Map）
    // FR-2 active 路径回传血缘：parentSession + forkEntryId 透传到 IManagedSessionView，
    // toSummary 输出到 SessionSummary，前端据此渲染 fork 父子关系。
    // parentSession 键与 createForkedSessionFile 写入 header 的 resolvedParentSession 一致
    //（源 sessionFilePath 落盘→用文件路径；未落盘→用源 sessionId）。
    // M3: initializeManagedSession 失败时清理 pi 进程（与 create/restore 同模式）
    const parentSessionKey = sourceActive?.sessionFilePath ?? srcSessionId
    let session: IManagedSessionView
    try {
      // Staging Mode（ADR-0056）：透传 effectiveModel（presetClientOptions.model）让 fork 新 session
      // 元数据 modelId 反映实际启动模型（override > 源 preset.modelOverride）。
      session = await this.svc.initializeManagedSession(
        forkedId, client, sessionCwd, label ?? basename(sessionCwd), forkedFilePath,
        undefined, parentSessionKey, fromPiEntryId, presetClientOptions.model,
      )
    } catch (initErr) {
      // L5: initializeManagedSession 失败时清理孤儿 fork 文件（已写出但 session 未进 Map）
      await this.safeDestroy(forkedId)
      await unlink(forkedFilePath).catch(() => {})
      throw initErr
    }

    void this.svc.fetchAndBroadcastContext(forkedId)
    // W-RT-4：fork 出的新 session 变 active，patch 内存态 launchPresetId（继承源 preset）。
    ;(session as { launchPresetId?: string }).launchPresetId = forkPresetId
    return this.svc.toSummary(session)
  }
}
