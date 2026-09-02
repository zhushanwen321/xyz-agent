/**
 * SessionRecords — subagent/workflow 记录域（S6/D2③ 迁出，原 Facade 两大半截合并）。
 *
 * 域内容（一个概念域的两半，冷热同源）：
 * - W18 派生缓存族：recordEntriesCaches + get_entries 增量重拉编排（entry_appended
 *   失效信号 → 防抖 → cursor 三路径拉取 → merge → 变化发布）；
 * - 磁盘读侧/动作/引擎配置：getSubagents/getWorkflows（冷启动磁盘扫描，与缓存刷新
 *   共用 scanSubagentEntries/scanWorkflowEntries 同一份派生代码，D4）、
 *   getSubagentHistory/getAgentCall*（record.sessionFile 直读）、
 *   workflowAction/subagentAction（经扩展 slash command 的生命周期/定向消息操作）、
 *   U7 引擎配置三方法（engines.json/config.json 读写）。
 *
 * 订阅接线（D2③「S5/S6 后订阅者换成 record 模块自身」）：组装根（Facade 构造器）
 * 先调 subscribe(lifecycle)——注册顺序在 projection（播种）之后、reconciler 对账之前，
 * 与迁移前 Facade 订阅体内顺序逐一等价（播种 → record 注册 → reconciler）。
 * 销毁侧无事件——onSessionDisposed 由 Facade removeSessionEntry 第 ⑤ 步直调
 * （与 TraceSync/SessionStateProjection.onSessionDisposed 并列）。
 *
 * Facade 消费面：对外 9 方法 + invalidateRecordEntries 一行委托（ISessionService 契约
 * 不变，transport/index.ts 组合根经 Facade 委托到达——u-s5 同款形态）。
 */
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Message, SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'
import { SUBAGENT_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { SubagentEngineConfigView, SubagentEnginesFile } from '@xyz-agent/extension-protocol'
import { SUBAGENTS_ENGINES_FILENAME } from '@xyz-agent/extension-protocol'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getDataDir } from '@xyz-agent/shared/paths'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import { getHistoryFromFilePath } from '../session-history.js'
import { extractSubagentsFromSessionFile, scanSubagentEntries } from './subagent-extractor.js'
import {
  extractRecordEngine,
  readEngineSubagentHistory,
  DEFAULT_SUBAGENT_ENGINE,
} from './subagent-engine-history.js'
import { extractWorkflowsFromSessionFile, scanWorkflowEntries } from './workflow-extractor.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { isStrictlyUnder } from '../../utils/path-utils.js'
import type { ISessionStore } from '../ports/session.js'
import { toErrorMessage } from '../../utils/errors.js'
import { withFileLockSync } from '../../utils/file-lock.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { isEntryNotFoundError } from './trace-sync.js'
import { SCALAR_STATE_DEBOUNCE_MS } from './replicated-states.config.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import type { SessionRegisteredSource } from './session-state-projection.js'

/**
 * W18：per-session record entry 派生缓存（subagent/workflow 列表的 runtime 侧 owner）。
 *
 * 三路径（父文档 §3.1 失效-重拉模式）：
 * - 初始态：cursor = null → 首次失效触发全量 get_entries 拉取，扫描结果整体建缓存。
 * - 增量：cursor 指向最后已拉 entryId → get_entries(since=cursor)，增量 entry 扫描结果
 *   merge 入派生 Map（自描述 entry 是完整快照，同 id 后到覆盖）。
 * - 失效自愈：游标指向的 entry 不在 pi 当前集合（"Entry not found"，session 文件被外部
 *   改写 / pi 重启）→ 丢 cursor 全量重拉重建（纯派生缓存可随时丢弃，正确性优先）。
 *
 * 数据写路径唯一 = refreshRecordEntries 的 entry 扫描（scanSubagentEntries /
 * scanWorkflowEntries，与冷启动磁盘路径同一份派生代码，D4）；发布经 messageBus
 * stateSnapshot（'subagents' / 'workflows' typeKey，W12 语义延续）。
 */
export interface RecordEntriesCache {
  /** 最后已拉 entryId（增量游标）。null = 从未拉过（下次全量）。 */
  cursor: string | null
  /** subagent 派生缓存（subagentId → 最新快照记录）。 */
  subagents: Map<string, SubagentRecord>
  /** workflow 派生缓存（runId → 最新快照记录）。 */
  workflows: Map<string, WorkflowRunRecord>
  /** 防抖定时器（null = 未在等待）。 */
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** in-flight 拉取 promise（并发失效共享一次拉取，消除重复 RPC）。 */
  inflight: Promise<void> | null
}

/** get_entries RPC 响应的域内收窄（u-s4 EntriesSinceResult 同款先例，见 fetchRecordEntriesRound）。 */
type EntriesSinceResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/**
 * SessionRecords 装配依赖（窄注入，S5/D2 风格：deps 面构造期固定，messageBus 经
 * getter 每次调用动态读——与 Facade setter 晚期注入语义逐字等价）。
 */
export interface SessionRecordsDeps {
  /** pi 进程管理（getClient：缓存刷新 RPC + 动作命令的活跃 client 获取）。 */
  pm: IProcessManager
  /** session 存储端口（scanSessions：磁盘读侧的 session 文件路径解析）。 */
  sessionStore: ISessionStore
  /** sessions Map 存在性查询（publish 前销毁守卫：已销毁不 publish，防 bus 重建已 clearSession 的 entry）。 */
  hasSession(sessionId: string): boolean
  /** MessageBus 当前值（Facade setter 晚期注入，未注入时 null → 广播 no-op）。 */
  getMessageBus(): IMessageBus | null
  /** 扩展路径解析（readDeclaredEnginesFallback 定位 subagent-workflow 安装目录；Facade getExtensionPaths 委托面）。 */
  getExtensionPaths(): Promise<string[]>
}

/** JSON 落盘缩进（全仓 JSON_INDENT = 2 约定）。 */
const JSON_INDENT = 2

/**
 * 定向消息文本的换行编码（composer 四符号 §3.3.3 / 探针 P3 转义协议）。
 *
 * 为什么编码：`/subagents message <id> <text>` 经 client.prompt 单行传输（pi 以首个
 * 空格拆命令名后取剩余全文，真实换行会破坏命令的单行性），故发送前把真实换行编码为
 * 字面 `\n` 两字符、原生反斜杠编码为 `\\`。
 *
 * 为什么连反斜杠一起转义：extension 侧 decodeNewlineEscapes（command-actions.ts）
 * 与本函数互逆——若只编码换行不编码反斜杠，原文里的字面反斜杠+n（如路径 `C:\new`）
 * 会被误解码成换行（歧义）。反斜杠先转义消除该歧义，两侧测试对三种原文
 * （字面 \n / 反斜杠 / 真实换行）钉死往返不变。
 */
export function encodeDirectiveText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

export class SessionRecords {
  /**
   * W18（data-source-governance P3.1）：per-session record entry 派生缓存——subagent /
   * workflow 列表的唯一 runtime 数据持有（entry 扫描结果纯派生，事件 payload 永不直写）。
   * 注册点 subscribe（onSessionRegistered，与 replicatedStates 同汇聚），销毁点
   * onSessionDisposed（清防抖定时器）。
   */
  private readonly recordEntriesCaches = new Map<string, RecordEntriesCache>()

  constructor(private readonly deps: SessionRecordsDeps) {}

  /**
   * 组装期订阅接线（D2③「换订阅者」）：向 lifecycle 注册本模块的缓存注册 handler。
   * 注册顺序在 projection（播种）之后、reconciler 对账之前——lifecycle 按订阅顺序
   * 同步直发，与迁移前 Facade 订阅体内顺序逐一等价。
   */
  subscribe(source: SessionRegisteredSource): void {
    source.onSessionRegistered((sessionId) => {
      // W18：注册 record entry 派生缓存（不播种——首个 entry_appended 失效时全量拉取；
      // 激活后 renderer 的初始列表由 getSubagents/getWorkflows RPC 磁盘扫描承接，同 scan 函数）。
      this.ensureRecordEntriesCache(sessionId)
    })
  }

  /**
   * W18：自描述 record entry 失效信号唯一入口（interpreter 经组合根注入；entry_appended
   * 主信号 + subagent/workflow 事件兜底信号都汇于此）。
   *
   * 只做失效（防抖调度 markDirty 等价），事件 payload 不进数据缓存。防抖窗口内多次失效
   * 合并为一次增量拉取（自描述 entry append 频率 = record 状态迁移频率，防抖削峰）。
   * session 未激活（无缓存条目）时 no-op——冷启动路径由 getSubagents/getWorkflows RPC
   * 的磁盘扫描承接。
   */
  invalidateRecordEntries(sessionId: string, customType: string): void {
    if (customType !== SUBAGENT_RECORD_CUSTOM_TYPE && customType !== WORKFLOW_RECORD_CUSTOM_TYPE) return
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache) return
    if (cache.debounceTimer !== null) return // 已在防抖等待中：合并
    cache.debounceTimer = setTimeout(() => {
      cache.debounceTimer = null
      void this.refreshRecordEntries(sessionId)
    }, SCALAR_STATE_DEBOUNCE_MS)
  }

  /** 取/建 per-session record entry 派生缓存（subscribe 注册点调用）。 */
  private ensureRecordEntriesCache(sessionId: string): RecordEntriesCache {
    const existing = this.recordEntriesCaches.get(sessionId)
    if (existing) return existing
    const cache: RecordEntriesCache = {
      cursor: null,
      subagents: new Map(),
      workflows: new Map(),
      debounceTimer: null,
      inflight: null,
    }
    this.recordEntriesCaches.set(sessionId, cache)
    return cache
  }

  /**
   * W18：get_entries 拉取编排（cursor 三路径见 RecordEntriesCache 注释）。
   *
   * 拉取 → scanSubagentEntries / scanWorkflowEntries（与冷启动同一份派生代码）→ merge
   * 派生 Map → 有变化才发布（session.subagents 全量帧 / session.workflowUpdate 增量信号）。
   * 失败语义：Entry not found → 丢 cursor 就地重试一次全量自愈（两轮上限，防坏 pi 反复全量）；
   * 其他 RPC 错误 → warn 后保留 cursor（下次失效重试仍走增量），不发布（快照未变）。
   */
  private async refreshRecordEntries(sessionId: string): Promise<void> {
    const cache = this.recordEntriesCaches.get(sessionId)
    if (!cache) return
    if (cache.inflight) return cache.inflight // 并发失效共享一次拉取
    const run = async (): Promise<void> => {
      const client = this.deps.pm.getClient(sessionId)
      if (!client) return // session 已死：缓存冻结（onSessionDisposed 会清），冷启动走磁盘路径
      // 两轮：第 1 轮按 cursor 增量；Entry not found 丢 cursor 后第 2 轮全量自愈
      const MAX_REFRESH_ROUNDS = 2
      for (let round = 0; round < MAX_REFRESH_ROUNDS; round++) {
        let fetched: { entries: unknown[]; leafId: string | undefined }
        try {
          fetched = await this.fetchRecordEntriesRound(client, cache)
        } catch (e) {
          if (cache.cursor !== null && isEntryNotFoundError(e)) {
            // 游标失效自愈：since 指向的 entry 不在 pi 当前集合 → 丢 cursor 全量重拉重建
            console.warn(`[session-service] record entries incremental Entry-not-found for ${sessionId}, dropping cursor and full rebuild`)
            cache.cursor = null
            continue
          }
          // 其他错误（超时 / pi 内部错误）：不发布（快照未变），cursor 保留，下次失效重试仍走增量
          console.warn(`[session-service] refresh record entries via getEntries failed for ${sessionId}: ${toErrorMessage(e)}`)
          return
        }
        this.applyRecordEntries(cache, fetched.entries, sessionId)
        if (fetched.leafId !== undefined) cache.cursor = fetched.leafId
        return
      }
    }
    cache.inflight = run().finally(() => { cache.inflight = null })
    return cache.inflight
  }

  /**
   * W18：单轮 get_entries 拉取——按 cursor 有无分流增量/全量。
   * 全量重建时派生缓存整体重置（纯派生语义——全量扫描结果就是新基线）。
   *
   * 响应收窄（u-s4 EntriesSinceResult 同款先例）：entries 零字段消费——整体透传
   * scanSubagentEntries / scanWorkflowEntries（unknown[] 形参）。
   */
  private async fetchRecordEntriesRound(
    client: IPiEngine,
    cache: RecordEntriesCache,
  ): Promise<{ entries: unknown[]; leafId: string | undefined }> {
    if (cache.cursor !== null) {
      const inc = await client.getEntries(cache.cursor) as EntriesSinceResult
      return { entries: inc.data?.entries ?? [], leafId: inc.data?.leafId ?? undefined }
    }
    const full = await client.getEntries() as EntriesSinceResult
    cache.subagents.clear()
    cache.workflows.clear()
    return { entries: full.data?.entries ?? [], leafId: full.data?.leafId ?? undefined }
  }

  /**
   * 扫描结果 merge 入派生缓存 + 变化发布。
   *
   * - subagents：merge 后与发布基线（缓存内当前值）比对，有变化 publish session.subagents
   *   全量帧（payload = 派生缓存快照数组）。
   * - workflows：merge 时收集状态变化的 run（含新增），按扫描序逐个 publish
   *   session.workflowUpdate 增量信号——最后一条即 stateSnapshot 'workflows' last-value
   *   （话题 last-value 语义与 W12 一致）。
   */
  private applyRecordEntries(cache: RecordEntriesCache, entries: unknown[], sessionId: string): void {
    const subagents = scanSubagentEntries(entries)
    let subagentsChanged = false
    for (const record of subagents) {
      const prev = cache.subagents.get(record.subagentId)
      if (prev === undefined || !subagentRecordEquals(prev, record)) subagentsChanged = true
      cache.subagents.set(record.subagentId, record)
    }

    const workflows = scanWorkflowEntries(entries)
    const workflowUpdates: Array<{ runId: string; status: string; reason?: string }> = []
    for (const record of workflows) {
      const prev = cache.workflows.get(record.runId)
      if (prev === undefined || prev.status !== record.status || prev.reason !== record.reason) {
        workflowUpdates.push({ runId: record.runId, status: record.status, reason: record.reason })
      }
      cache.workflows.set(record.runId, record)
    }

    if (!this.deps.hasSession(sessionId)) return // session 已销毁：不 publish（防 bus 重建已 clearSession 的 entry）
    if (subagentsChanged) {
      this.deps.getMessageBus()?.publish(sessionId, {
        type: 'session.subagents',
        payload: { sessionId, subagents: Array.from(cache.subagents.values()) },
      })
    }
    for (const update of workflowUpdates) {
      this.deps.getMessageBus()?.publish(sessionId, {
        type: 'session.workflowUpdate',
        payload: { sessionId, update },
      })
    }
  }

  async getSubagents(sessionId: string): Promise<SubagentRecord[]> {
    // 找主 session 文件路径（scanSessions 扫 pi/sessions/，含 cwd-encoded 子目录）。
    // wave:perf-w26（plan M-3）：路径解析消费方 force 旁路 TTL（刚落盘 session 的
    // subagent 面板在窗口内不静默返回空）。
    const target = this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    if (!target) return []
    return extractSubagentsFromSessionFile(target.filePath)
  }

  async getSubagentHistory(sessionId: string, subagentId: string): Promise<Message[]> {
    // 先从主 session 提取 subagent 列表，找到 sessionFile 路径
    const subagents = await this.getSubagents(sessionId)
    const record = subagents.find((s) => s.subagentId === subagentId)
    if (!record) return []

    // P5 分协议路由：非 pi 引擎（record.engine 字段路由，缺省 pi）走 extractor 的
    // 三级降级读取链（①引擎原生 reader ②journal ③outcome-only）。pi 的现有直读链
    // 零变化（A1 守护）
    const engine = extractRecordEngine(record)
    if (engine !== DEFAULT_SUBAGENT_ENGINE) {
      return readEngineSubagentHistory(record, getDataDir())
    }

    if (!record.sessionFile) return []

    // 路径穿越校验：sessionFile 必须严格落在 piAgentDir 下（~/.xyz-agent/pi/agent/）。
    // record.sessionFile 由 subagent-extractor 从 JSONL 文本提取，不可信——攻击者构造的
    // session JSONL 可塞入任意路径（如 /etc/passwd），不校验直接读会泄露任意文件内容。
    if (!isStrictlyUnder(getPiAgentDir(), record.sessionFile)) return []

    // 直读 subagent JSONL，复用 getHistoryFromFilePath 转换链路（parseJsonl + filter + convertHistory）。
    // subagent JSONL 格式与主 session 一致（pi SessionManager._persist 写入）。
    return getHistoryFromFilePath(record.sessionFile, this.deps.sessionStore)
  }

  /**
   * [U7] 子代理引擎配置视图：engines.json（extension 权威写入的动态引擎列表）+
   * config.json defaultEngine（extension ModelConfigService 读同一文件）。
   * 纯磁盘读取，Settings 冷启动（无活跃 session）也可用。
   *
   * 回退链（U7b 冷启动：app 刚打开、尚无 pi 进程 → engines.json 不存在）：
   * subagent-workflow 安装目录 package.json 的 `xyz-agent.subagentEngines` 静态声明
   * （守护测试防与代码注册表漂移）→ 最终兜底 ['pi']。
   */
  async getSubagentEngineConfig(): Promise<SubagentEngineConfigView> {
    const subagentsDir = join(getPiAgentDir(), 'subagents')
    let engines: string[] | undefined
    try {
      const raw = readFileSync(join(subagentsDir, SUBAGENTS_ENGINES_FILENAME), 'utf8')
      const parsed = JSON.parse(raw) as Partial<SubagentEnginesFile>
      if (Array.isArray(parsed.engines) && parsed.engines.every((e) => typeof e === 'string') && parsed.engines.length > 0) {
        engines = parsed.engines
      }
    } catch (e) {
      // 缺失/损坏 → 走静态声明回退
      console.warn(`[session-service] read engines.json failed, falling back to static declaration: ${toErrorMessage(e)}`)
    }
    if (engines === undefined) {
      engines = await this.readDeclaredEnginesFallback()
    }
    let defaultEngine = 'pi'
    try {
      const conf = JSON.parse(readFileSync(join(subagentsDir, 'config.json'), 'utf8')) as { defaultEngine?: unknown }
      if (typeof conf.defaultEngine === 'string' && conf.defaultEngine.trim() !== '') {
        defaultEngine = conf.defaultEngine.trim()
      }
    } catch (e) {
      // 无 config / 坏 JSON → 缺省 pi（extension 侧同缺省语义）
      console.warn(`[session-service] read subagents config.json failed, defaulting engine to pi: ${toErrorMessage(e)}`)
    }
    return { engines, defaultEngine }
  }

  /**
   * [U7b] 静态声明回退：经 getExtensionPaths 定位 subagent-workflow 安装目录（dev 源码
   * / packaged staged / live env 三形态统一由扩展路径解析覆盖），读 package.json
   * 的 xyz-agent.subagentEngines。任何失败返回 ['pi']（pi 恒可用）。
   */
  private async readDeclaredEnginesFallback(): Promise<string[]> {
    try {
      const paths = await this.deps.getExtensionPaths()
      const swDir = paths.find((p) => p.endsWith('subagent-workflow') || p.includes(`${sep}subagent-workflow`))
      if (!swDir) return ['pi']
      const pkg = JSON.parse(readFileSync(join(swDir, 'package.json'), 'utf8')) as {
        'xyz-agent'?: { subagentEngines?: unknown }
      }
      const declared = pkg['xyz-agent']?.subagentEngines
      if (Array.isArray(declared) && declared.every((e) => typeof e === 'string') && declared.length > 0) {
        return declared as string[]
      }
    } catch (e) {
      // 回退链的回退——静默到 ['pi']
      console.warn(`[session-service] read declared engines fallback failed, defaulting to pi: ${toErrorMessage(e)}`)
    }
    return ['pi']
  }

  /**
   * [U7] 设置全局默认子代理引擎：读改写 config.json（保留其他字段）+ tmp+rename 原子写。
   * engineId 校验：engines.json 清单内才允许（防 GUI 端把未知引擎写进配置）。
   *
   * 🔒 跨进程锁（C-data-09）：config.json 与 agent bash 写（subagent-ext-config skill
   * 指导）、用户手编构成多写方——RMW 全程持 withFileLockSync（lockfile = config.json.lock，
   * 协议对齐 worktree-config-helper ext-config / settings.json 先例）。锁失败 fail-fast
   * 抛错（ELOCKED，预算 1s），经 RPC 错误通路返回 GUI。不取锁的 bash/手编写方作为
   * last-write-wins 残余风险由 data-source-registry.md §6 登记。
   */
  async setSubagentDefaultEngine(engineId: string): Promise<void> {
    const view = await this.getSubagentEngineConfig()
    if (!view.engines.includes(engineId)) {
      throw new Error(`unknown subagent engine '${engineId}' (available: ${view.engines.join(', ')})`)
    }
    const configPath = join(getPiAgentDir(), 'subagents', 'config.json')
    withFileLockSync(configPath, () => {
      let conf: Record<string, unknown> = {}
      try {
        conf = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      } catch {
        // 无既有配置 → 新建（extension 读侧对缺字段的容忍与 DEFAULT_CONFIG 对齐）
        conf = {}
      }
      if (conf['defaultEngine'] === engineId) return
      conf['defaultEngine'] = engineId
      // subagents 目录无需再建：withFileLockSync 取锁前已兜底 mkdir dirname(configPath)
      // （无锁时代这行 mkdir 承重，引入锁后成为死代码）。原子写单点走 fs-utils.atomicWrite
      // （tmp+rename）；写失败时 .tmp 残留不被清理——与 worktree-config-helper ext-config
      // 先例同款取舍，磁盘孤儿文件无害，不在此另复制一份清理逻辑
      atomicWrite(configPath, JSON.stringify(conf, null, JSON_INDENT), `${process.pid}-${Date.now()}`)
    })
  }

  /**
   * 获取 session 派生的 workflow 列表（从主 session JSONL 的 workflow-state-link 提取）。
   * 纯磁盘读取，不依赖 pi 进程活跃。文件不存在或无 workflow 调用时返回空数组。
   */
  async getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
    // wave:perf-w26（plan M-3）：路径解析消费方 force 旁路 TTL（与 getSubagents 同理）。
    const target = this.deps.sessionStore.scanSessions({ force: true }).find((s) => s.id === sessionId)
    if (!target) return []
    return extractWorkflowsFromSessionFile(target.filePath)
  }

  /**
   * 获取 workflow 内 agent call 的对话流历史。
   *
   * agentCallSessionId 是 trace[].sessionId。agent call 本质是 subagent（D4）：
   * trace[].sessionId 存的是 subagent record id（sa-xxx），不是 pi session uuidv7，
   * 故复用 getSubagentHistory 的 record 查找路径（subagentId → 主 session JSONL 的
   * record.sessionFile）直读，不按 header.id 扫 subagents 目录（sa-xxx 永远不匹配
   * uuidv7 header——历史上曾按目录扫描，2026-08-14 修正）。
   *
   * 找不到 record 返回 []（前端显空对话流）。
   */
  async getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<Message[]> {
    return this.getSubagentHistory(sessionId, agentCallSessionId)
  }

  /**
   * 解析 agent call 对话流 JSONL 绝对路径（record.sessionFile 直查）。
   *
   * 与 getAgentCallHistory 的区别：找不到时返回空串而非 throw——这是展示型功能
   *（PanelHeader overlay 文件名），找不到路径不应阻断 UI，前端 v-if 据空串隐藏按钮。
   */
  async getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string> {
    // 同 getAgentCallHistory：agent call 是 subagent，trace.sessionId 是 subagentId（sa-xxx），
    // 复用 record 查找（subagentId → record.sessionFile），不扫目录按 header.id 匹配。
    const subagents = await this.getSubagents(sessionId)
    const record = subagents.find((s) => s.subagentId === agentCallSessionId)
    if (!record?.sessionFile) return ''
    if (!isStrictlyUnder(getPiAgentDir(), record.sessionFile)) return ''
    return record.sessionFile
  }

  /**
   * 触发 workflow 生命周期操作（pause/resume/abort）。
   * 经 client.prompt("/workflows <action> <runId>") 调扩展 slash command，
   * pi 检测 / 开头直接执行 command handler（不经 LLM）。
   * 扩展侧 RPC 分支已实现（commands.ts ctx.mode==='rpc'）。
   */
  async workflowAction(sessionId: string, action: 'pause' | 'resume' | 'abort', runId: string): Promise<void> {
    const client = this.deps.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    await client.prompt(`/workflows ${action} ${runId}`)
  }

  /**
   * subagent 生命周期/定向消息操作（经扩展 slash command，不经 LLM）。
   * 对称 workflowAction 的转发模式：client.prompt("/subagents <action> ...")。
   * 扩展侧 RPC 分支解析（command-actions.ts parseSubagentRpcCommand）：
   * - cancel：<subagentId>（service.cancel → SIGTERM kill 子进程）
   * - message：<subagentId> <text>（subagent 续聊，热路径 stdin 直写 prompt）
   * - start：<slug> <task>（conversation:true 可续聊的新 subagent）
   * text/task 经 encodeDirectiveText 编码（换行 → 字面 \n，命令保持单行）。
   *
   * 刻意直接 client.prompt 绕过 dispatcher busy 预检 / BeforeSend hook（对称
   * promptReload 的绕过模式）：定向消息必须「主 agent 生成中也能发」（设计 §3.3.4
   * 直达目标），且 hook 审核的是主 agent prompt，不适用于 subagent 定向文本。
   */
  async subagentAction(
    sessionId: string,
    action: 'cancel' | 'message' | 'start',
    params: { subagentId?: string; text?: string; slug?: string; task?: string },
  ): Promise<void> {
    const client = this.deps.pm.getClient(sessionId)
    if (!client) throw new Error(`Session ${sessionId} not active`)
    if (action === 'cancel') {
      // 错误指向恢复动作：字段缺失是调用方协议错误，fail-fast 让 WS error envelope 暴露
      if (!params.subagentId) throw new Error('[session-service] subagentAction cancel: subagentId is required')
      await client.prompt(`/subagents cancel ${params.subagentId}`)
      return
    }
    if (action === 'message') {
      if (!params.subagentId || !params.text) {
        throw new Error('[session-service] subagentAction message: subagentId and text are required')
      }
      await client.prompt(`/subagents message ${params.subagentId} ${encodeDirectiveText(params.text)}`)
      return
    }
    if (!params.slug || !params.task) {
      throw new Error('[session-service] subagentAction start: slug and task are required')
    }
    await client.prompt(`/subagents start ${params.slug} ${encodeDirectiveText(params.task)}`)
  }

  // ── 销毁清理（Facade removeSessionEntry 第 ⑤ 步直调，与 TraceSync/SessionStateProjection.onSessionDisposed 并列）──

  /**
   * W18：销毁 record entry 派生缓存（主动删 + 进程退出汇聚点）。停防抖定时器
   * （在途 inflight 的拉取完成后 applyRecordEntries 的 hasSession 守卫拦住发布，
   * 不复活已清 bus 条目）。
   */
  onSessionDisposed(sessionId: string): void {
    const cache = this.recordEntriesCaches.get(sessionId)
    if (cache) {
      if (cache.debounceTimer !== null) clearTimeout(cache.debounceTimer)
      this.recordEntriesCaches.delete(sessionId)
    }
  }
}

/**
 * W18：SubagentRecord 逐字段相等判定（record entry 派生缓存的发布 diff 基线）。
 * 结构固定（shared SubagentRecord），逐字段比对而非 JSON.stringify（顺序无关、无序列化抖动）。
 */
function subagentRecordEquals(a: SubagentRecord, b: SubagentRecord): boolean {
  return a.subagentId === b.subagentId
    && a.sessionFile === b.sessionFile
    && a.agent === b.agent
    && a.slug === b.slug
    && a.task === b.task
    && a.status === b.status
    && a.model === b.model
    && a.thinkingLevel === b.thinkingLevel
    && a.turns === b.turns
    && a.totalTokens === b.totalTokens
    && a.elapsedSeconds === b.elapsedSeconds
    && a.startedAt === b.startedAt
    && a.endedAt === b.endedAt
    && a.error === b.error
    && a.closedReason === b.closedReason
}
