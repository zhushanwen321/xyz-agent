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
import { existsSync, unlinkSync, readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { SessionSummary, BatchDeleteResult, ThinkingLevel } from '@xyz-agent/shared'
import { BUILTIN_PRESET_IDS, PI_THINKING_LEVELS } from '@xyz-agent/shared'
import type { PiThinkingLevel } from '../../infra/pi/pi-protocol.js'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import type { ISessionServiceInternal } from './session-internal.js'
import type { IManagedSessionView, ScannedSession } from './types.js'
import type { PresetResolution } from '../preset-service.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { toErrorMessage, errorWithCode, MODEL_NOT_CONFIGURED, SESSION_NOT_FOUND } from '../../utils/errors.js'
import { createForkedSessionFile } from './session-fork.js'

// [arch 技术债登记，R3 ports 依赖倒置待收口] 下方三个 infra/pi 值 import（getSessionsDir /
// normalizeSessionFileInPlace + cleanupMigrateResidues / assertPiSessionFile）违反「services
// 禁止 import infra」三层规则（见 docs/architecture/runtime-three-layer-design.md 阶段 R3）。
// 未在本轮直接 port 化的原因：restore/fork 归一化管线是 W1 高危区（tmp+rename 原子覆盖 +
// 附着断言），包一层 port 接口属于行为敏感重构，应随 R3 阶段统一落地（ISessionStore 等
// port 扩展 + 专项测试），不在 review 修复批混入。新写 services 代码不得再效仿此处直引 infra。
import { getSessionsDir } from '../../infra/pi/pi-paths.js'
import { normalizeSessionFileInPlace, cleanupMigrateResidues } from '../../infra/pi/session-file-utils.js'
import { assertPiSessionFile } from '../../infra/pi/session-attach-assert.js'

/**
 * 匹配 `"type":"session_end"` 或 `'type':'session_end'`（容忍引号/空格差异）。
 * 用单/双引号字符类容忍 JSON.stringify（双引号）与手写（单引号）两种写法。
 *
 * stripSessionEndEntries（变换）与 containsSessionEndLine（F2/F3 分流判定）共用同一正则
 * ——判定与变换必须同源，否则会出现「判进 F3 却剔不干净」或反向的缝隙。
 */
const SESSION_END_RE = /["']type["']\s*:\s*["']session_end["']/

/**
 * 检测 JSONL 文本是否含 session_end 行（W1 restore-fork-attach-fix F2/F3 分流判定）。
 *
 * 与 stripSessionEndEntries 同款正则逐行检测。W1 设计文档明令禁止用
 * `stripSessionEndEntries(原文) === 原文` 字符串全等做本判定——strip 函数有末尾换行
 * 规范化副作用（原文末尾无 `\n` 时即使零剔除也产出不等文本），全等会把几乎所有文件
 * 误判进 F3 归一化路径。
 */
function containsSessionEndLine(jsonlContent: string): boolean {
  for (const line of jsonlContent.split('\n')) {
    if (line !== '' && SESSION_END_RE.test(line)) return true
  }
  return false
}

/**
 * 从 JSONL 文本中剔除 session_end 行。
 *
 * 背景（动机经 restore-fork-attach-fix §2.3 复核改判保留）：B7 sidecar 方案下 runtime
 * 不再往 JSONL 写 session_end（改写 .meta.json sidecar），但历史 session（迁移前写入的）
 * JSONL 仍可能含 `type:"session_end"` 行。pi 侧 `_buildIndex`（pi-mono
 * session-manager.ts）对所有非 session entry 无差别执行 `byId.set(entry.id);
 * leafId = entry.id`——legacy session_end 行无 id 无 parentId，使 leafId=undefined →
 * 后续 appendMessage 的 parentId 断链 → 全部旧历史不进 LLM 上下文（AI 失忆）。
 * 因此 restore 必须在附着前剔除该类行。
 *
 * 实现按行扫描：命中 SESSION_END_RE 的整行丢弃，其余行原样保留（含换行）。纯文本扫描
 * 不解析 JSON，避免格式异常的行被误吞。
 *
 * @param jsonlContent 原始 JSONL 文本
 * @returns 剔除 session_end 行后的文本（行数可能减少；末尾换行统一补一个）
 */
export function stripSessionEndEntries(jsonlContent: string): string {
  const lines = jsonlContent.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (line === '') continue // split 末尾产生的空串（原末尾换行）跳过，末尾统一补回
    if (SESSION_END_RE.test(line)) continue
    kept.push(line)
  }
  // 末尾统一补一个换行（W2/A-06 注释修正：pi 读取侧按行 trim 分行——session-manager.js
  // parseSessionEntries/parseSessionEntryLine 对内容先 trim 再 split("\n")，末尾 \n 非必须；
  // 补 \n 是保守对齐 pi 写出格式，非 pi 期望）
  return kept.length > 0 ? kept.join('\n') + '\n' : ''
}

/**
 * 对 JSONL 文本首行的 session header 应用 cwd fallback（W11 引入，语义随 W1 更新）。
 *
 * 纯字符串变换（不落盘）：restoreSession 的 F3 归一化管线内调用——session 原始 cwd 已被
 * 删除时，把首行 header 的 cwd 改为 fallback 值，使 pi switch_session 不因 cwd 不存在
 * 失败（pi 加载 header cwd 死路径的 session 直接 throw MissingSessionCwdError，pi-mono
 * session-cwd.ts；RPC switch_session 无 cwdOverride 字段，只能由 xyz 在附着前修）。
 * 变换产物经 normalizeSessionFileInPlace 原地 rename-over 落回原文件。
 *
 * 防御语义与原实现一致：首行缺失/非 session 类型/JSON parse 失败 → 原样返回（不抛）。
 *
 * @param jsonlContent stripSessionEndEntries 后的 JSONL 文本
 * @param fallbackCwd  降级 cwd（调用方传 homedir()）
 * @returns 首行 header.cwd 替换为 fallbackCwd 后的文本；无法解析时原样返回
 */
export function applyHeaderCwdFallback(jsonlContent: string, fallbackCwd: string): string {
  const lines = jsonlContent.split('\n')
  if (!lines[0]) return jsonlContent
  try {
    const header = JSON.parse(lines[0])
    if (typeof header !== 'object' || header === null || header.type !== 'session') {
      return jsonlContent
    }
    header.cwd = fallbackCwd
    lines[0] = JSON.stringify(header)
    return lines.join('\n')
  } catch {
    // 首行 JSON parse 失败：原样返回（交 pi switch_session 报错），不阻断 restore 主流程
    return jsonlContent
  }
}

/**
 * thinkingLevel 合法值集合（S-RT-5；W2 值域 SSOT 派生，A-03 修复）。
 *
 * 值 = shared PI_THINKING_LEVELS（pi 0.84.1 全集 7 值，锚点见 pi-preset.ts），
 * 不再手写数组——手写值域曾缺 'max' 导致 composer 最高档被静默丢弃。
 * 用 readonly 数组做运行时校验：lifecycle 透传 thinkingOverride 到 pi 前先校验，
 * 非法值 warn 后忽略（不传给 pi，避免 pi 报错或行为异常）。
 *
 * 类型标注同时做编译期双向防漂移（shared 不能反向 import runtime，由本文件——
 * 唯一同时 import 两边者——锁定一致性）：
 * - `readonly PiThinkingLevel[]`：shared 全集出现 pi-protocol 之外的值 → 编译错；
 * - `& AssertSharedCoversPi`：pi-protocol 全集有而 shared 缺（pi 升级加档位未同步）→ 编译错。
 */
type AssertSharedCoversPi = [Exclude<PiThinkingLevel, ThinkingLevel>] extends [never] ? unknown : never
const VALID_THINKING_LEVELS: readonly PiThinkingLevel[] & AssertSharedCoversPi = PI_THINKING_LEVELS

// D8-3 迁移 promise gate（06 §3.3，perf W29）：provider 迁移（apiKey → auth.json +
// enabledModels 白名单）完成前禁止 spawn pi——迁移窗口内 spawn 的 session 会读到迁移前
// 配置（pi AuthStorage 无文件监听，旧 session 不感知新 auth.json）。
// 组合根（index.ts）后台初始化块经 setMigrationGate 注入；gate 必须自带 catch——
// 迁移失败也 resolve（best-effort 语义：失败不阻塞任何功能，下次启动重试）。
// 默认 resolved（未注入时无 gate 语义：单测/无迁移场景行为与旧版一致）。
let migrationGate: Promise<unknown> = Promise.resolve()

/** 组合根注入迁移完成 gate（D8-3）。传入的 promise 必须已 catch（失败同样 resolve，不阻塞 spawn）。 */
export function setMigrationGate(gate: Promise<unknown>): void {
  migrationGate = gate
}

/** 当前 gate（测试断言/重置用）。 */
export function getMigrationGate(): Promise<unknown> {
  return migrationGate
}

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
   * W1（数据源治理）→ A' 修正（2026-08-24 rename-session 回归）：**语义性命名**的初始 label
   * 经 pi set_session_name RPC 持久化（取代原 turn_end/agent_end 兜底直写机制），调用点在
   * client 就绪后（create 流程 getState 成功即证 RPC 可用）。
   *
   * 「语义性命名」= 调用方明确期望跨重启保留且**不该被 auto-rename 覆盖**的名字，
   * 现有三处：handoff 承接名（"handoff from X"）、agent-managed session 的 agent 显式
   * 命名、fork 显式 label（当前前端恒不传，协议保留）——均经 options.persistLabel=true
   * 显式声明。
   *
   * 派生 label **不调 RPC**——display-only：含 basename(cwd) 与前端 prompt 预览名
   *（createSessionFlow 派生的首条 prompt 前 10 码点，2026-08-24 前曾被误当显式名持久化，
   * 踩死 pi-rename-session 防覆盖守卫 getSessionName() 非空即 skip → auto-rename 全量
   * 失效，v0.9.3 起）。显示由内存 session.label + 既有 scanner fallback（extractSessionName
   * 返回 null → basename(cwd)）承担；pi 内存 sessionName 保持空，auto-rename 守卫照常通过。
   * 代价：auto-rename 未跑（禁用/失败）时重启，侧边栏从预览名回退 basename（窗口极小）。
   *
   * RPC 失败**不阻断** create/fork：label 留内存显示 + console.error 上报，
   * 恢复动作 = 手动 rename（renameSession 的 RPC 路径）重试。
   */
  private async persistExplicitLabel(client: IPiEngine, sessionId: string, label: string | undefined, source: string): Promise<void> {
    if (label === undefined) return
    try {
      await client.setSessionName(label)
    // eslint-disable-next-line taste/no-silent-catch -- best-effort 降级（docstring：RPC 失败不阻断 create/fork，label 留内存显示 + console.error 上报，恢复动作 = 手动 rename 重试）
    } catch (e) {
      console.error(`[session-lifecycle] ${source}: setSessionName RPC failed for ${sessionId} (label kept in memory only):`, e)
    }
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
    // widening cast（与 shared isPiLaunchPreset 的 TOOL_MODES 同款惯例）：includes 收窄参数类型，
    // 此处本意就是对任意 string 做白名单判定。
    const knownThinking = rawThinking !== undefined && (VALID_THINKING_LEVELS as readonly string[]).includes(rawThinking)
    const effectiveThinking = knownThinking ? rawThinking : undefined
    if (rawThinking !== undefined && !knownThinking) {
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
    /** 归属 project id（D14 语义修正，2026-08-04）：创建时归属当前 activeProject；空 = 默认项目兑底。 */
    projectId?: string
    /** Landing Model Chip 传入值，覆盖 preset.modelOverride（C-RL-6 优先级）。 */
    modelOverride?: string
    /** Landing Thinking Chip 传入值，覆盖 preset.thinkingLevel（C-RL-6 优先级）。 */
    thinkingOverride?: string
    /** 发起来源：'user' | 'agent'。agent-managed session 标记。 */
    spawnSource?: 'user' | 'agent'
    /** 父 agent session id（spawnSource='agent' 时必填）。 */
    parentAgentSessionId?: string
    /**
     * label 是否为语义性命名（需持久化到 pi session_info 且防 auto-rename 覆盖）。
     * true：handoff 承接名 / agent-managed 显式命名。false（默认）：前端派生 prompt
     * 预览名 display-only（见 persistExplicitLabel docstring 的 A' 修正）。
     */
    persistLabel?: boolean
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
    // D8-3（perf W29）：迁移完成前 spawn pi 会读到未迁移配置——gate 等待。
    // gate 恒 resolve（迁移失败已 catch），正常迁移 <10ms 不可感知。
    await migrationGate
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

    // W1 → A'：仅语义性命名（options.persistLabel=true：handoff/agent-managed）持久化；
    // 前端派生 prompt 预览名 display-only（防覆盖守卫恢复，详见 persistExplicitLabel docstring）
    if (options?.persistLabel) {
      await this.persistExplicitLabel(client, id, label, 'create')
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
    // 持久化归属 project 到 .project.json sidecar（D14 语义修正，2026-08-04）。
    // 与 preset 同模式：pi 延迟写入窗口（sessionFilePath 未落盘）时 sidecar 写入内部
    // existsSync 守卫跳过，内存态兑底 patch session.projectId（toSummary 透传）。
    // 空 projectId（默认项目创建）不写 sidecar——等价于未归类，读取侧一致兑底默认项目。
    if (options?.projectId) {
      ;(session as { projectId?: string }).projectId = options.projectId
      if (session.sessionFilePath) {
        this.sessionStore.persistProjectBinding(session.sessionFilePath, options.projectId)
      }
    }
    // agent-managed session 标记：spawnSource / parentAgentSessionId。
    // 内存态 patch 到 session 对象（toSummary 透传），供 session-manager list 过滤。
    if (options?.spawnSource) {
      ;(session as { spawnSource?: 'user' | 'agent' }).spawnSource = options.spawnSource
    }
    if (options?.parentAgentSessionId) {
      ;(session as { parentAgentSessionId?: string }).parentAgentSessionId = options.parentAgentSessionId
    }
    // .agent.json sidecar 落盘（重启恢复链路，G-1）——与 preset/project 同模式：
    // pi 延迟写入窗口（sessionFilePath 未落盘）时 existsSync 守卫跳过，内存态兑底。
    if (options?.spawnSource && session.sessionFilePath) {
      // parentAgentSessionId 可选（#15）：spawnSource 单独成立即持久化，防异常路径下 badge 重启丢失
      this.sessionStore.persistAgentBinding(session.sessionFilePath, options.spawnSource, options.parentAgentSessionId)
    }
    // hidden session（公共 session）不记工作区历史——cwd 是数据目录，不应污染最近工作区列表。
    // homedir 过滤（含降级 homedir）由 WorkspaceService.record 统一负责（方案A，一处堵死全部路径），
    // lifecycle 层不再关心 cwd 是否降级。
    if (!options?.hidden) {
      this.workspaceService.record(sessionCwd)
    }
    const createdSummary = this.svc.toSummary(session)
    // S3-W2：创建入口收敛点（create 路径）——触发插件 didCreateSession 定向投递。
    this.svc.notifySessionCreated(createdSummary)
    return createdSummary
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const session = this.svc.getSession(sessionId)
    if (session) {
      // W1（数据源治理）：活跃 session 的 label 持久化唯一写入口 = pi set_session_name RPC
      //（pi 内部 appendSessionInfo 落盘 + 广播 session_info_changed）。xyz 不再直写 session
      // JSONL，消除「用户手动命名被 pi rename-session 扩展 auto-rename 直写竞争覆盖」的
      // last-write-wins bug。
      // client undefined（pi 崩溃窗口）或 RPC 失败（success:false / 超时）一律 throw 走上层
      // toast——静默 no-op 会造成 UI 显示新名、零持久化、无提示的静默丢写。先 RPC 后改内存：
      // 失败时旧名保留可重试。
      const client = this.pm.getClient(sessionId)
      if (!client) {
        throw new Error(`Cannot rename session ${sessionId}: pi process is not available (try again after the session is reactivated)`)
      }
      await client.setSessionName(newName)
      // 内存态同步（toSummary/config.sessions 的即时数据源；session.label 的写方全集 =
      // 此处 RPC 成功后直写 + 事件路径 setLabelCache，两写点同源 pi 权威——label 的
      // ReplicatedState 实例已撤销，PR #185 MF1，label 不再有第三份状态）。
      session.label = newName
    } else {
      // 非 active session：W11（绝对写规则）改经短命 pi——withEphemeralPi 附着该文件
      // 后调 set_session_name RPC，session JSONL 仍由 pi 写（pi 对已 flush 文件的
      // appendSessionInfo 立即落盘，尾部出现改名 session_info entry）。xyz 直写
      // （persistSessionName openSync('a')）已随 W11 删除。探针 ~600ms 端到端
      // （冷启动 ~500ms + RPC <1ms），逐次冷起（D2 裁决，无 warm pi）。
      // 失败（spawn 失败 / 附着超时 / RPC 失败）rethrow 走上层 toast——旧名保留可重试
      // （与活跃分支同语义）。
      const target = this.svc.findScannedSession(sessionId)
      // D3（p1p4-closure W1）：未命中必须 throw——旧形态 if (target) 无 else 静默
      // return，UI 改名静默不生效（无持久化、无提示）。错误信息含 sessionId 与恢复
      // 动作（全局规则 16），上层 toast 路径既有。
      if (!target) {
        throw new Error(
          `Cannot rename session ${sessionId}: not found in active sessions or persisted files `
          + `(refresh the sidebar and verify the session still exists, then retry the rename)`,
        )
      }
      // findings #4（p1p4-closure W1）：header cwd 死路径（如 worktree 清理后）时
      // pi 0.84.1 switchSession 内 assertSessionCwdExists 直接拒绝附着（pi-mono
      // coding-agent/src/core/agent-session-runtime.ts switchSession；binary strings
      // 实证，findings §4.1；RPC switch_session 不透传 cwdOverride，无法绕过）——
      // 附着前按 restoreSession 同款 F3 形态归一化（cwd fallback 落回原文件；
      // 判定含 session_end 时一并 strip），然后附着原文件。cwd 检测源 = scanner
      // 从 header 读出的 target.cwd（与 restoreSession 一致）；正常文件（cwd 活
      // 且无 session_end）判定不命中，零变换直附着（探针 ~600ms 预期不变）。
      const cwdFellBack = !existsSync(target.cwd)
      if (cwdFellBack) {
        console.warn(`[session-lifecycle] rename target cwd does not exist: ${target.cwd}, normalizing header cwd to home before attach`)
      }
      // 扫描 stale（文件已消失）时跳过预读归一化——「文件不存在」的报错分工归
      // withEphemeralPi 内 switchSession（pi 报错，见其 docstring 的 @param 语义），
      // 预读 ENOENT 会短路该分工。restoreSession 无此守卫（既有行为保持，不动）。
      if (existsSync(target.filePath)) {
        this.normalizeInactiveSessionFileIfNeeded(target.filePath, cwdFellBack)
      }
      await this.pm.withEphemeralPi(target.filePath, (c) => c.setSessionName(newName))
    }

    // wave:perf-w26（D9-1 rename 失效点）：写路径改变 name（活跃分支 RPC 更新 pi 内存
    // + 内存 label；非活跃分支短命 pi 落盘 session_info 改变文件 mtime/size），
    // 但目录列举 TTL 快照 1s 内仍返回旧 name——rename 后侧栏刷新立即显示新名，显式失效目录缓存。
    this.sessionStore.invalidateScanCache()
    this.sessionStore.refreshAll()
  }

  /**
   * active session 删除路径的主文件清理。
   *
   * 为什么单独成方法：原 delete 内联此块时，与 scanned 分支的 sidecar 清理逻辑重复，
   * 使 delete 圈复杂度 16 超阈值 15（metrics-gate FAIL）。提取后两分支共用
   * purgeSessionSidecars，delete 回归纯编排。
   *
   * 语义（与提取前 `sessionFilePath && existsSync` 整块守卫等价）：主文件存在时
   * trash + 清理全部关联产物；主文件不存在（外部已删）时**整体零动作**——
   * 与 scanned 分支「无条件清孤儿 sidecar」的行为差异见 delete 的 else 分支注释。
   */
  private async purgeActiveSessionFile(filePath: string): Promise<void> {
    if (!existsSync(filePath)) return
    await this.sessionStore.trash(filePath)
    this.purgeSessionSidecars(filePath)
  }

  /**
   * 清理 session 主文件的全部关联产物（delete 是唯一清理点）。
   *
   * active / scanned 两分支共用：原先两处各内联一份完全相同的清理序列，
   * 是 delete 圈复杂度超阈的主要来源。
   *
   * best-effort 语义：sidecar unlink 失败不阻塞主流程（孤儿 sidecar 无害，
   * 强失败会掩盖删除本身的成功）。
   */
  private purgeSessionSidecars(filePath: string): void {
    // 清理 sidecar（删除失败不阻塞主流程）
    try { unlinkSync(filePath + '.meta.json') } catch { void 0 }
    // 清理 preset 绑定 sidecar（设计文档 §4，delete 是唯一清理点）
    try { unlinkSync(filePath + '.preset.json') } catch { void 0 }
    try { unlinkSync(filePath + '.project.json') } catch { void 0 }
    try { unlinkSync(filePath + '.handoff.json') } catch { void 0 }
    // 清理 agent binding sidecar（agent-managed-session；delete 是唯一清理点，防孤儿 sidecar）
    try { unlinkSync(filePath + '.agent.json') } catch { void 0 }
    // 清理归一化残留 .tmp-migrate-*.jsonl（差距复审 suggestion 6，与 sidecar 同点 best-effort）
    cleanupMigrateResidues(filePath)
    // W-Runtime4：清理 session 文件头解析缓存（infra session-file-utils 的 filePath 键
    // 派生缓存，非已删的 label 影子缓存）中的 stale 条目（避免无界增长）
    this.sessionStore.invalidateMetaCache(filePath)
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.svc.getSession(sessionId)
    if (session) {
      this.svc.detachSession(sessionId)
      await this.pm.destroySession(sessionId)
      this.svc.removeSessionEntry(sessionId)
      if (session.sessionFilePath) {
        await this.purgeActiveSessionFile(session.sessionFilePath)
      }
    } else {
      const target = this.svc.findScannedSession(sessionId)
      if (!target) throw new Error(`Session ${sessionId} not found`)
      // 与 active 分支的行为差异（既有语义，保持）：主文件不存在（扫描 stale）时仅跳过
      // trash，孤儿 sidecar 仍无条件清理——不把 existsSync 折进 purgeSessionSidecars，
      // 否则 active 分支「文件不存在则整体零动作」的语义会被顺带改掉。
      if (existsSync(target.filePath)) await this.sessionStore.trash(target.filePath)
      this.purgeSessionSidecars(target.filePath)
    }
    // wave:perf-w26（D9-1 delete 失效点）：session 文件已 trash，目录 TTL 快照 1s 内仍含
    // 已删条目——显式失效，删除后立即从侧栏列表消失（05 文档 V5 验收）。
    this.sessionStore.invalidateScanCache()
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
   *
   * wave:perf-w26 修正（审查）：scanSessions 传 { force: true } 旁路目录 TTL 快照——
   * deleteByCwd 是写语义的彻底清理：走快照会漏删（TTL 窗口内刚落盘的 session 不在快照里）
   * 且误报失败（快照含已删条目时 delete 内 findScannedSession 找不到 → Session not found
   * → failed 数组 → 前端误报）。该调用点低频（用户点 folder 删除按钮），无性能顾虑。
   */
  async deleteByCwd(cwd: string): Promise<BatchDeleteResult> {
    const cwdSessions = new Set<string>()
    for (const s of this.svc.getActiveSummaries()) {
      if (s.cwd === cwd) cwdSessions.add(s.id)
    }
    for (const s of this.sessionStore.scanSessions({ force: true })) {
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

  /**
   * 附着前 F2/F3 分流归一化（restore-fork-attach-fix W1 形态；p1p4-closure W1 起
   * renameSession 非活跃分支共用——两处附着前检测/变换必须同源，否则行为漂移）。
   *
   * 判定：containsSessionEndLine(raw) || cwdFellBack。禁止用
   * stripSessionEndEntries(raw) === raw 字符串全等——strip 有末尾换行规范化副作用
   * （原文末尾无 \n 时零剔除也产出不等文本），见 containsSessionEndLine。
   *
   * 变换（F3 一次性归一化，legacy 文件；每文件最多一次，产物收敛到 F2，幂等）：
   * - strip session_end：legacy 行无 id/parentId，pi _buildIndex 对所有非 session
   *   entry 无差别 byId.set(entry.id); leafId = entry.id（pi-mono session-manager.ts），
   *   session_end 使 leafId=undefined → 新 entry parentId 断链 → 历史不进 LLM 上下文
   * - header cwd fallback：仅 cwd 死时应用（cwdFellBack）——pi 0.84.1 switchSession
   *   内 assertSessionCwdExists 对死 cwd 硬拒绝（pi-mono coding-agent/src/core/
   *   agent-session-runtime.ts switchSession，binary strings 实证见 findings §4.1；
   *   抛 MissingSessionCwdError，pi-mono session-cwd.ts；RPC switch_session 不透传
   *   cwdOverride，只能由 xyz 附着前修）
   *
   * 落盘经 normalizeSessionFileInPlace（同目录临时名 rename-over 原子替换，路径
   * 不变，登记表 §4 ⑨ 合法形态）。判定未命中（正常文件）时零变换：不写不拷贝，
   * 调用方直附着原文件。
   *
   * @param filePath    目标 session JSONL 绝对路径（原地归一化，路径不变）
   * @param cwdFellBack 调用方已判定的 session cwd 死路径标记（检测源 = scanner 从
   *                    header 读出的 ScannedSession.cwd）
   */
  private normalizeInactiveSessionFileIfNeeded(filePath: string, cwdFellBack: boolean): void {
    // 附着前清扫该文件的 .tmp-migrate-* 崩溃/失败残留（差距复审 suggestion 6；F2/F3
    // 两路都过此处——F2 判定未命中会提前 return，清扫必须在其前）。此刻无归一化在途
    //（restore 已销毁同 id 会话），同 basename 残留必然 stale，best-effort 清除。
    cleanupMigrateResidues(filePath)
    const raw = readFileSync(filePath, 'utf-8')
    const needsNormalize = containsSessionEndLine(raw) || cwdFellBack
    if (!needsNormalize) return
    let cleaned = stripSessionEndEntries(raw)
    if (cwdFellBack) {
      cleaned = applyHeaderCwdFallback(cleaned, homedir())
    }
    normalizeSessionFileInPlace(filePath, cleaned)
  }

  /** 从持久化文件恢复 session。 */
  async restoreSession(sessionId: string): Promise<SessionSummary> {
    const target = this.svc.findScannedSession(sessionId)
    // 文案是追加（非替换）：既有测试用 toThrow 子串匹配「Persisted session X not found」
    //（test/session-service.test.ts / test/session-pool-restoresession.test.ts），见设计文档 §7.3。
    if (!target) {
      throw errorWithCode(
        `Persisted session ${sessionId} not found — 该会话无已保存内容（进程在首次保存前退出），请新建会话`,
        SESSION_NOT_FOUND,
      )
    }

    if (!this.configStore.getDefaultModel()) {
      throw errorWithCode('No model configured. Please configure a provider and model in Settings before restoring a session.', MODEL_NOT_CONFIGURED)
    }
    const existing = this.svc.getSession(sessionId)
    if (existing) {
      this.svc.detachSession(sessionId)
      await this.safeDestroy(sessionId)
      this.svc.removeSessionEntry(sessionId)
    }

    // session cwd 可能已被删除(如 worktree 清理后),降级到 home。
    // W1（restore-fork-attach-fix）：cwd 死路径时两处都要兜底——spawn 侧 = 下方 sessionCwd
    // 降级（cwdFellBack 标记）；会话文件 header 侧 = F3 归一化时 applyHeaderCwdFallback
    // 落回原文件（归一化后 header cwd 持久化为 homedir——W11「源文件 header 永久保持
    // 旧 cwd」的声明已被本设计取代，登记表 §4 例外③已更新）。
    let cwdFellBack = false
    const sessionCwd = existsSync(target.cwd) ? target.cwd : (() => {
      console.warn(`[session-lifecycle] session cwd does not exist: ${target.cwd}, falling back to home`)
      cwdFellBack = true
      return homedir()
    })()

    const id = sessionId
    // preset 是 launch 配置不是终态（设计文档 §4.5），restore 后仍属同一 preset，
    // .preset.json sidecar 不清理。target.launchPresetId undefined 时（历史 session 无 sidecar）
    // 用 'builtin:full' 兜底（FR-10）。
    const presetId = target.launchPresetId ?? BUILTIN_PRESET_IDS.FULL
    const resolution = await this.svc.getLaunchPresetOptions(presetId, sessionCwd)
    const allExtPaths = resolution?.extensionPaths ?? await this.svc.getExtensionPaths(sessionCwd)
    // restore 不接收 Landing Chip override（无用户交互）。preset 的 model 是 launch 配置
    // 只在创建时生效——附着路径的模型终态由 pi 从 model_change entry 恢复（见下方
    // inheritSessionModel），presetClientOptions.model 在此处被显式清空；thinking 仍透传
    // preset（launch 档位；session 内切档由 thinking_level_change entry 承载）。
    const presetClientOptions = this.buildPresetClientOptions(resolution, undefined, undefined)
    // D8-3（perf W29）：restore 同样 spawn pi——gate 等待（启动时恢复路径与 create 一致过 gate）。
    await migrationGate
    const client = await this.pm.createSession(id, sessionCwd, {
      skillPaths: resolution?.skillPaths ?? this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
      systemPrompt: this.svc.getReplaceSystemPrompt(),
      ...presetClientOptions,
      // P1（pi-assumption final gate V1⑤）：pi CLI --model 恒优先于 session entry 恢复
      //（main.js buildSessionOptions），restore 路径曾因全局默认兜底把 --model 拼进 spawn
      // args，用户切换过的模型在重启重开时被静默压回默认。模型终态改由 pi 从
      // model_change entry 恢复（每次创建/切换都会写该 entry，W1a 实证）。
      model: undefined,
      inheritSessionModel: true,
    })

    try {
      // W1（restore-fork-attach-fix）F2/F3 分流：pi 的 switch_session 是「永久重绑读写目标」
      //（pi-mono session-manager.ts setSessionFile 把传入路径存为永久 sessionFile，_persist
      // 每轮 appendFileSync 该路径——文件被删后 append 按路径重建），必须直接附着 sessions
      // 目录内的正式文件。旧「拷贝 $TMPDIR → 附着 tmp → 立即 unlink」管线使 pi 终身写
      // tmp 孤儿文件、原会话文件永不更新（P0 数据丢失），已整体删除。
      // 判定/变换逻辑抽至 normalizeInactiveSessionFileIfNeeded（renameSession 非活跃
      // 分支共用，p1p4-closure W1），行为不变。
      this.normalizeInactiveSessionFileIfNeeded(target.filePath, cwdFellBack)
      // F2 直附着（归一化判定未命中）：零拷贝零改写，pi 的读写目标 = 登记路径 = 原文件。
      await client.switchSession(target.filePath)
      // W2（restore-fork-attach-fix F4）：附着必断言（I1「登记路径 ≡ pi 写路径」）——
      // get_state().sessionFile 与登记路径 resolve 归一后必须一致，不一致即 throw
      //（D3 fail loud；本 try 的 catch 分支 safeDestroy + rethrow 保证进程不泄漏）。
      await assertPiSessionFile(client, target.filePath, `restoreSession(${sessionId})`)
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
    const restoredSummary = this.svc.toSummary(session)
    // S3-W2：创建入口收敛点（restoreSession 路径）——session 复活进 Map，插件 didCreate 投递。
    this.svc.notifySessionCreated(restoredSummary)
    return restoredSummary
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
      /**
       * wave:perf-w26（微项 12 find 合并）：调用方（SessionService.forkSession facade）已解析的
       * 源 session 扫描结果。传入时本方法不再自扫（同 handler 单次 scanSessions）；
       * 直接调用方（测试）未传时保持原行为自行扫描。
       */
      source?: ScannedSession
    },
  ): Promise<SessionSummary> {
    if (!this.configStore.getDefaultModel()) {
      throw errorWithCode('No model configured. Please configure a provider and model in Settings before forking a session.', MODEL_NOT_CONFIGURED)
    }

    // 1. 查源 session 文件路径（scanSessions 合并磁盘 + 内存 active）
    // wave:perf-w26（微项 12）：facade 传入 source 时复用（find 合并），未传时自扫（force 旁路 TTL）。
    const source = options?.source ?? this.svc.findScannedSession(srcSessionId)
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
    let forked: { filePath: string; sessionId: string }
    try {
      forked = await createForkedSessionFile(
        source.filePath,
        fromPiEntryId,
        includeFrom,
        getSessionsDir(),
        fromPiEntryId,
        fallbackParentId,
      )
    } catch (e) {
      // wave:perf-w26（D9-1，审查修正）：createForkedSessionFile 写文件半程失败时可能留下
      // 残缺 fork 文件——失效目录 TTL 缓存避免快照收录残缺条目（与 switchSession/initialize
      // 失败分支的失效对称，见下）。
      this.sessionStore.invalidateScanCache()
      throw e
    }
    const { filePath: forkedFilePath, sessionId: forkedId } = forked
    // wave:perf-w26（D9-1 fork 失效点）：fork 新文件由 runtime 直接写出（非 pi 延迟落盘），
    // 显式失效目录 TTL 缓存让下一次列表构建立即包含新 session（不依赖 active 内存合并兜底）。
    this.sessionStore.invalidateScanCache()

    // 3. spawn 新 pi 进程（与 restore 同模式）
    // fork 继承源 session 的 preset（设计文档 §4.5）。
    // W-RT-5：优先读 active 源 session 的内存态 launchPresetId（pi 延迟写入窗口下
    // sidecar 未写时，内存态兜底——getSession 返回 ManagedSession 实例，as 读 launchPresetId 字段），
    // 再 fallback 到扫描结果的 sidecar 值（source.launchPresetId），
    // 最后兜底 'builtin:full'（FR-10，历史 session 无 sidecar）。
    // existsSync 兜底的**spawn cwd 参数**（pi 进程工作目录）；会话文件 header.cwd 的兜底
    // 在 createForkedSessionFile 生成 newHeader 时完成（W1 F1/MF2——fork 文件是创建型
    // 新文件，生成时兜底是最早、最便宜的拦截点）。
    const sessionCwd = existsSync(source.cwd) ? source.cwd : homedir()
    const forkPresetId = (this.svc.getSession(srcSessionId) as { launchPresetId?: string } | undefined)?.launchPresetId
      ?? source.launchPresetId
      ?? BUILTIN_PRESET_IDS.FULL
    // fork 继承源 session 的归属 project（D14 语义修正，2026-08-04）：
    // 与 preset 同模式——active 内存态兑底（延迟写入窗口），fallback 扫描 sidecar 值。
    // 无归属（undefined）= 默认项目，不写 fork sidecar。
    const forkProjectId = (this.svc.getSession(srcSessionId) as { projectId?: string } | undefined)?.projectId
      ?? source.projectId
    const forkResolution = await this.svc.getLaunchPresetOptions(forkPresetId, sessionCwd)
    const allExtPaths = forkResolution?.extensionPaths ?? await this.svc.getExtensionPaths(sessionCwd)
    // Staging Mode（ADR-0056）：override 优先于源 preset 的 modelOverride/thinkingLevel（见 buildPresetClientOptions
    // 内 C-RL-6 优先级）。undefined 时仅继承源 preset（旧行为），不影响现有 fork。
    const presetClientOptions = this.buildPresetClientOptions(
      forkResolution,
      options?.modelOverride,
      options?.thinkingOverride,
    )
    // D8-3（perf W29）：fork 同样 spawn pi——gate 等待（06 审查修正：fork 是第三处 spawn 点）。
    await migrationGate
    const client = await this.pm.createSession(forkedId, sessionCwd, {
      skillPaths: forkResolution?.skillPaths ?? this.svc.getSkillPaths(sessionCwd),
      extensionPaths: allExtPaths,
      systemPrompt: this.svc.getReplaceSystemPrompt(),
      ...presetClientOptions,
    })

    try {
      // 4. W1（restore-fork-attach-fix F1）：pi 的 switch_session 永久重绑读写目标
      //（pi-mono session-manager.ts setSessionFile 把传入路径存为永久 sessionFile，_persist
      // 每轮 appendFileSync 该路径），直接附着 sessions 目录内的 fork 产物正式文件——
      // 此后每轮对话落 forkedFilePath。旧「拷贝 $TMPDIR → 附着 tmp → 立即 unlink」管线
      // 已删（pi 终身写按路径重建的 tmp 孤儿文件，fork 后对话全部丢失）。
      // 无需 strip：fork 产物由 createForkedSessionFile 按树过滤生成（登记表 §4 ⑥ 创建型
      // 合法形态），游离的 legacy session_end 行（无 id 不在树内）天然不进产物。
      await client.switchSession(forkedFilePath)
      // W2（restore-fork-attach-fix F4）：附着必断言（I1「登记路径 ≡ pi 写路径」）——
      // 登记的 forkedFilePath 必须就是 pi 的终身写目标，不一致即 throw（D3 fail loud）。
      await assertPiSessionFile(client, forkedFilePath, `forkSession(${srcSessionId})`)
      // W2-4：清理旧 sidecar 移到 switchSession 成功之后。
      // 原顺序是 switchSession 之前 unlink，若 switchSession 抛错，session 的终态 sidecar
      //（done/stopped）已被删 → 终态永久丢失。现在只在切换成功后才删，失败时保留旧终态。
      try { unlinkSync(forkedFilePath + '.meta.json') } catch { void 0 }
      // fork 不继承 agent binding（binding 是创建时语义）——防御性清理同名残留 sidecar
      try { unlinkSync(forkedFilePath + '.agent.json') } catch { void 0 }
      // 写 preset 绑定到 forkedFilePath 的 sidecar（设计文档 §4.5）。
      // fork 继承源 preset，forkedFilePath 是新文件（已写出），existsSync 守卫会通过。
      this.sessionStore.persistPresetBinding(forkedFilePath, forkPresetId)
      // 写归属 project 到 forkedFilePath 的 sidecar（D14 语义修正）：fork 继承源归属。
      if (forkProjectId) {
        this.sessionStore.persistProjectBinding(forkedFilePath, forkProjectId)
      }
    } catch (e) {
      // L5: switchSession 失败时清理孤儿 fork 文件（已写出但 pi 未能加载）
      await this.safeDestroy(forkedId)
      await unlink(forkedFilePath).catch(() => {})
      // wave:perf-w26（D9-1）：fork 文件已删，失效目录 TTL 缓存（步骤 2 的失效到此刻的
      // 窗口内可能已被其他消费方扫进快照）。
      this.sessionStore.invalidateScanCache()
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
      // wave:perf-w26（D9-1）：同 switchSession 失败分支——孤儿文件已删，失效目录 TTL 缓存。
      this.sessionStore.invalidateScanCache()
      throw initErr
    }

    // W1 → A'：fork 显式 label（用户显式命名，语义性）持久化；当前前端恒不传 label
    //（undefined no-op），WS 协议保留该字段，传入时持久化（见 persistExplicitLabel docstring）
    await this.persistExplicitLabel(client, forkedId, label, 'forkSession')

    void this.svc.fetchAndBroadcastContext(forkedId)
    // W-RT-4：fork 出的新 session 变 active，patch 内存态 launchPresetId（继承源 preset）。
    ;(session as { launchPresetId?: string }).launchPresetId = forkPresetId
    const forkedSummary = this.svc.toSummary(session)
    // S3-W2：创建入口收敛点（forkSession 路径）——新 session 诞生，插件 didCreate 投递。
    this.svc.notifySessionCreated(forkedSummary)
    return forkedSummary
  }
}
