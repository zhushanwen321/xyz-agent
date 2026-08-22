/**
 * Worktree 偏好 + auto-rename 标志文件 helper（从 config-service.ts 抽出，控 max-lines 500）。
 *
 * 本模块含两类职责，落盘路径不同，注意区分：
 *
 * 1. worktree/git-cwt-anywhere 偏好（root dir / setup 脚本 / 超时 / 默认 base branch）：
 *    经注入的 AppConfigAccessors 读写，落在 app config.json 顶层字段。本模块只负责
 *    字段级读写 + 校验，不关心 config.json 的落盘细节（由 load/save 回调负责，避免
 *    循环依赖 + 不暴露 ConfigService 的私有方法可见性）。
 *
 * 2. auto-rename 标志文件（getAutoRenameEnabled / setAutoRenameEnabled /
 *    getAutoRenameEnabledPath）：不经 AppConfigAccessors、不落 config.json，而是直接
 *    读写 ${PI_CODING_AGENT_DIR}/auto-rename-enabled 独立标志文件（与 pi extension 契约
 *    对齐：文件存在=开，不存在=关）。
 *
 * 3. rename-session 模型配置（getRenameModel / setRenameModel）：读改写
 *    ${PI_CODING_AGENT_DIR}/config/rename-session-ext-config.json 的 model 字段
 *    （与 pi-rename-session extension 的 llm-shared getConfigPath 路径契约对齐）。
 *    extension 每次 turn_end 读时刷新（mtime+size 缓存），本侧写入后下一 turn 自动生效。
 *    只改 model 字段，保留文件内其他字段（enabled/maxTitleLength/thinkingLevel 及未来新增）。
 *
 * 4. smart-context 配置（getSmartContextConfig / setSmartContext*）：读改写
 *    ${PI_CODING_AGENT_DIR}/config/smart-context-ext-config.json（与 pi-smart-context
 *    extension 的 llm-shared getConfigPath('smart-context') 路径契约对齐）。锁协议与
 *    setRenameModel 逐字对齐（该文件同样被 runtime 与 extension 双方 RMW）。
 *
 * 抽出原因：config-service.ts 因本次 PR 新增 migration 委托方法触顶 max-lines(500)。
 * worktree 偏好是 config-service 内最内聚、对外接口稳定（IConfigService 已声明）的块，
 * 移到本模块后 ConfigService 仅保留单行委托，行为 / 签名 / import 路径零变化。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPiAgentDir } from '../infra/pi/pi-paths.js'
import { logger } from '../infra/logger.js'
import { atomicWrite } from '../utils/fs-utils.js'
import { withFileLockSync, type SyncFileLockOptions } from '../utils/file-lock.js'

/** app config.json 的 load/save 能力（ConfigService 注入，避免暴露其私有方法）。 */
type AppConfigAccessors = {
  /** 读 app config.json（不存在 / 损坏返回 {}）。 */
  load(): Record<string, unknown>
  /** 全量覆写 app config.json。 */
  save(config: Record<string, unknown>): void
}

/** 默认 worktree 根目录（~/worktrees，与原 ConfigService 内联值一致）。 */
const DEFAULT_WORKTREE_ROOT_DIR = '~/worktrees'
/** 默认 setup 脚本相对路径（裸仓 / 普通仓共用同一默认）。 */
const DEFAULT_SETUP_SCRIPT = 'custom-hooks/setup-worktree.sh'
/** 默认 worktree 操作超时（秒）。 */
const DEFAULT_TIMEOUT = 60
/** 超时上限（秒）：与 setSystemPromptConfig 的窗口约束风格一致，防异常大值卡死 PTY。 */
const TIMEOUT_MAX = 3600
/** 默认 base branch（origin/main）。 */
const DEFAULT_BASE_BRANCH = 'origin/main'
/** auto-rename 开关标志文件名（放在 PI_CODING_AGENT_DIR 下，文件存在=开，不存在=关）。 */
const AUTO_RENAME_ENABLED_FILE = 'auto-rename-enabled'
/** auto-rename 初始化标记文件名（存在=已执行过默认初始化，防止 boot 反复覆盖用户的关闭操作）。 */
const AUTO_RENAME_INITIALIZED_FILE = 'auto-rename-initialized'

export function getWorktreeRootDir(app: AppConfigAccessors): string {
  const val = app.load()['worktreeRootDir']
  return typeof val === 'string' ? val : DEFAULT_WORKTREE_ROOT_DIR
}

export function setWorktreeRootDir(app: AppConfigAccessors, dir: string): void {
  if (!dir || !dir.trim()) {
    throw new Error('worktreeRootDir cannot be empty')
  }
  const config = app.load()
  config['worktreeRootDir'] = dir
  app.save(config)
}

export function getSetupScript(app: AppConfigAccessors): string {
  const val = app.load()['setupScript']
  return typeof val === 'string' ? val : DEFAULT_SETUP_SCRIPT
}

export function setSetupScript(app: AppConfigAccessors, dir: string): void {
  if (dir.includes('..')) {
    throw new Error('setupScript path cannot contain ..')
  }
  const config = app.load()
  config['setupScript'] = dir
  app.save(config)
}

export function getBareSetupScript(app: AppConfigAccessors): string {
  const val = app.load()['bareSetupScript']
  return typeof val === 'string' ? val : DEFAULT_SETUP_SCRIPT
}

export function setBareSetupScript(app: AppConfigAccessors, script: string): void {
  const config = app.load()
  config['bareSetupScript'] = script
  app.save(config)
}

export function getTimeout(app: AppConfigAccessors): number {
  const val = app.load()['worktreeTimeout']
  return typeof val === 'number' ? val : DEFAULT_TIMEOUT
}

export function setTimeout(app: AppConfigAccessors, timeout: number): void {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > TIMEOUT_MAX) {
    throw new Error(`timeout must be a positive number in (0, ${TIMEOUT_MAX}], got ${timeout}`)
  }
  const config = app.load()
  config['worktreeTimeout'] = timeout
  app.save(config)
}

export function getDefaultBaseBranch(app: AppConfigAccessors): string {
  const val = app.load()['defaultBaseBranch']
  return typeof val === 'string' ? val : DEFAULT_BASE_BRANCH
}

export function setDefaultBaseBranch(app: AppConfigAccessors, baseBranch: string): void {
  const config = app.load()
  config['defaultBaseBranch'] = baseBranch
  app.save(config)
}

/**
 * auto-rename 开关标志文件路径（${PI_CODING_AGENT_DIR}/auto-rename-enabled）。
 * 与 pi extension 契约一致：extension 读 process.env.PI_CODING_AGENT_DIR 下同名文件。
 * 注意：不走 AppConfigAccessors / config.json —— 开关是独立标志文件，不落 config 字段。
 */
export function getAutoRenameEnabledPath(): string {
  return join(getPiAgentDir(), AUTO_RENAME_ENABLED_FILE)
}

/**
 * 读取 auto-rename 开关状态。标志文件存在=开，不存在/出错=关。
 * 不抛错（读异常一律当关，防御性设计）。
 */
export function getAutoRenameEnabled(): boolean {
  try {
    return existsSync(getAutoRenameEnabledPath())
  } catch {
    return false
  }
}

/**
 * 设置 auto-rename 开关。enabled=true 创建标志文件（空内容，若不存在），
 * enabled=false 删除标志文件（不存在时吞 ENOENT，不报错）。
 */
export function setAutoRenameEnabled(enabled: boolean): void {
  const filePath = getAutoRenameEnabledPath()
  if (enabled) {
    mkdirSync(dirname(filePath), { recursive: true })
    if (!existsSync(filePath)) {
      writeFileSync(filePath, '', 'utf-8')
    }
  } else {
    try {
      rmSync(filePath)
    } catch (e: unknown) {
      // 文件不存在视为成功（吞 ENOENT）
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw e
    }
  }
}

/**
 * 首次启动时默认开启 auto-rename（创建 flag file）。
 * 用 auto-rename-initialized 标记防止后续 boot 反复覆盖用户的关闭操作：
 *   - initialized 不存在 → 首次，创建 enabled flag（默认开）+ initialized 标记
 *   - initialized 存在 → 用户已设置过，不干预
 * 不抛错（与 getAutoRenameEnabled 防御性设计一致）。
 */
export function ensureAutoRenameDefault(): void {
  try {
    const initializedPath = join(getPiAgentDir(), AUTO_RENAME_INITIALIZED_FILE)
    if (existsSync(initializedPath)) return
    mkdirSync(dirname(initializedPath), { recursive: true })
    // 标记已初始化（先写标记，再开开关；即使 enabled 写失败，标记已防重复）
    writeFileSync(initializedPath, '', 'utf-8')
    setAutoRenameEnabled(true)
  } catch (e) {
    // 初始化失败不阻塞 boot，但记录原因便于诊断
    logger.warn(`[worktree-config] ensureAutoRenameDefault failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── rename-session 模型配置（config/rename-session-ext-config.json 的 model 字段）──

/** 配置文件相对路径（与 pi-rename-session 的 llm-shared getConfigPath('rename-session') 契约一致）。 */
const RENAME_SESSION_CONFIG_REL = join('config', 'rename-session-ext-config.json')

/**
 * 文件缺失/损坏时的回退默认值（与 extension 的 DEFAULT_RENAME_CONFIG 一致：
 * extensions/universal/rename-session/src/pure.ts）。仅 setRenameModel 落盘时用作基底。
 */
const RENAME_MODEL_DEFAULT_CONFIG: Record<string, unknown> = {
  enabled: false,
  model: { type: 'ref', ref: '' },
  maxTitleLength: 50,
  thinkingLevel: 'off',
}

/** rename-session 配置文件完整路径（${PI_CODING_AGENT_DIR}/config/rename-session-ext-config.json）。 */
export function getRenameConfigPath(): string {
  return join(getPiAgentDir(), RENAME_SESSION_CONFIG_REL)
}

/**
 * 锁参数覆盖（仅测试用，如把重试预算压到几十 ms 快速验证 fail-fast）。
 * 生产保持 file-lock.ts 的默认值（stale 30s / 25ms / 1s），与 pi-settings-store 同协议。
 */
let renameConfigLockOptions: SyncFileLockOptions = {}

/** 覆盖 rename-session-ext-config.json 写锁参数（仅测试用）。传 {} 恢复默认。 */
export function setRenameConfigLockTimingForTest(opts: SyncFileLockOptions): void {
  renameConfigLockOptions = opts
}

/** JSON 序列化缩进格数（与 extension 侧 llm-shared saveConfig 的 JSON_INDENT 一致）。 */
const JSON_INDENT = 2

/** tmp 后缀随机段参数（36 进制 / 跳过 "0." 前缀 / 取 6 位），与 llm-shared uniqueTmpPath 同形态。 */
const TMP_RANDOM_BASE = 36
const TMP_RANDOM_SLICE_START = 2
const TMP_RANDOM_SLICE_END = 8

/** 并发唯一 tmp 后缀：pid + 36 进制随机段（rename-session / smart-context 两个 RMW 写点共用）。 */
function uniqueTmpSuffix(): string {
  return `${process.pid}_${Math.random().toString(TMP_RANDOM_BASE).slice(TMP_RANDOM_SLICE_START, TMP_RANDOM_SLICE_END)}`
}

/** 从原始 JSON 对象提取 model.ref（仅认 {type:"ref", ref:string} 形态，其余返回空串）。 */
function extractModelRef(raw: Record<string, unknown>): string {
  const model = raw['model']
  if (typeof model !== 'object' || model === null || Array.isArray(model)) return ''
  const ref = (model as Record<string, unknown>)['ref']
  return typeof ref === 'string' ? ref : ''
}

/**
 * 读取 rename 标题生成模型（"provider/modelId"，未设置返回空串）。
 * 文件不存在/坏 JSON/model 字段非法 → 空串（与 extension normalizeRenameConfig 的回退语义一致）。
 * 不抛错（读异常一律当未设置，防御性设计，与 getAutoRenameEnabled 一致）。
 */
export function getRenameModel(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getRenameConfigPath(), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
    return extractModelRef(parsed as Record<string, unknown>)
  } catch {
    return ''
  }
}

/**
 * 设置 rename 标题生成模型（读改写，只覆盖 model 字段，保留其他字段）。
 * model 为空串 = 清除回未设置；非空但不含 "/"（provider/modelId 格式非法）归一为空串
 * （extension 的 parseRef 对无 "/" 的 ref 返回 null，写进去也不会生效，不如归一）。
 * 写入为原子写（tmp+rename），与 extension saveConfig 的序列化格式一致（2 空格缩进 + 尾换行）。
 * 写失败（如目录不可写）抛错由调用方处理。
 *
 * 🔒 跨进程锁（D1e，integrity-hardening.md §3.1）：RMW 全程持 withFileLockSync
 * （lockfile 路径 = <rename-session-ext-config.json>.lock，锁目标文件自身）。
 * 该文件被 runtime 与 pi-rename-session extension 双方 RMW——extension 侧
 * （extensions/shared/llm-shared saveConfig）W4 起已持同一把锁（@zhushanwen/pi-file-lock
 * withFileLockSync，协议与本侧逐字对齐），双端闭环；extension 侧锁失败返回
 * success:false 不降级（对端持锁时无锁写会交错丢字段）。见登记表 §6 rename-session 行。
 */
export function setRenameModel(model: string): void {
  const normalized = model.includes('/') ? model : ''
  const configPath = getRenameConfigPath()
  withFileLockSync(configPath, () => {
    let base: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
      base = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : { ...RENAME_MODEL_DEFAULT_CONFIG }
    } catch {
      // 文件不存在/坏 JSON → 默认基底（与 extension 读取侧的回退语义一致：坏文件本来就无效）
      base = { ...RENAME_MODEL_DEFAULT_CONFIG }
    }
    base['model'] = { type: 'ref', ref: normalized }
    mkdirSync(dirname(configPath), { recursive: true })
    // tmp 唯一化：对端（rename-session 扩展 llm-shared saveConfig）写同一文件，其 tmp 已带
    // pid+随机段；本侧留固定 .tmp 会与旧版对端碰撞（锁互斥下无害但脏残留），对齐同形态。
    atomicWrite(configPath, `${JSON.stringify(base, null, JSON_INDENT)}\n`, uniqueTmpSuffix())
  }, renameConfigLockOptions)
}

// ── smart-context 配置（config/smart-context-ext-config.json）──

/**
 * GUI 侧的 smart-context 配置快照（extension 侧 SmartContextConfig 的扁平视图：
 * compactModel 折叠为 "provider/modelId" 复合串，空串 = 未设置/跟随当前会话模型）。
 */
export interface SmartContextConfigSnapshot {
  enabled: boolean
  /** 压缩模型 ref（"provider/modelId"，空串 = 未设置）。 */
  compactModel: string
  /** 3 档提醒阈值（token 绝对数，升序）。 */
  reminderThresholds: number[]
  /** 排除模型列表（完整 provider/modelId 精准匹配）。 */
  excludedModels: string[]
}

/** 配置文件相对路径（与 pi-smart-context 的 llm-shared getConfigPath('smart-context') 契约一致）。 */
const SMART_CONTEXT_CONFIG_REL = join('config', 'smart-context-ext-config.json')

/** 3 档提醒阈值默认值（token 绝对数，与 extension 的 DEFAULT_REMINDER_THRESHOLDS 一致）。 */
// eslint-disable-next-line no-magic-numbers -- 200K/400K/600K 是与 pi-smart-context extension 契约对齐的默认档位
const SMART_CONTEXT_DEFAULT_THRESHOLDS = [200_000, 400_000, 600_000]

/** 提醒阈值最大档数（与 extension 的 MAX_THRESHOLD_TIERS 一致）。 */
const SMART_CONTEXT_MAX_THRESHOLD_TIERS = 3

/**
 * 文件缺失/损坏时的回退默认值（与 extension 的 DEFAULT_SMART_CONTEXT_CONFIG 一致：
 * extensions/universal/smart-context/src/pure.ts）。仅落盘时用作基底。
 */
const SMART_CONTEXT_DEFAULT_CONFIG: Record<string, unknown> = {
  enabled: true,
  compactModel: { type: 'ref', ref: '' },
  reminderThresholds: [...SMART_CONTEXT_DEFAULT_THRESHOLDS],
  excludedModels: [],
}

/** smart-context 配置文件完整路径（${PI_CODING_AGENT_DIR}/config/smart-context-ext-config.json）。 */
export function getSmartContextConfigPath(): string {
  return join(getPiAgentDir(), SMART_CONTEXT_CONFIG_REL)
}

/**
 * 锁参数覆盖（仅测试用）。生产保持 file-lock.ts 默认值，与 setRenameModel 同协议。
 */
let smartContextLockOptions: SyncFileLockOptions = {}

/** 覆盖 smart-context-ext-config.json 写锁参数（仅测试用）。传 {} 恢复默认。 */
export function setSmartContextLockTimingForTest(opts: SyncFileLockOptions): void {
  smartContextLockOptions = opts
}

/** 从原始 JSON 对象提取 compactModel.ref（仅认 {type:"ref", ref:string} 形态，其余返回空串）。 */
function extractCompactModelRef(raw: Record<string, unknown>): string {
  const model = raw['compactModel']
  if (typeof model !== 'object' || model === null || Array.isArray(model)) return ''
  const ref = (model as Record<string, unknown>)['ref']
  return typeof ref === 'string' ? ref : ''
}

/**
 * 阈值归一（与 extension normalizeSmartContextConfig 同款纪律）：过滤非正数/非有限数
 * → 升序 → 截 3 档；空数组回退默认。
 */
function normalizeThresholds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...SMART_CONTEXT_DEFAULT_THRESHOLDS]
  const thresholds = [...raw]
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b)
    .slice(0, SMART_CONTEXT_MAX_THRESHOLD_TIERS)
  return thresholds.length > 0 ? thresholds : [...SMART_CONTEXT_DEFAULT_THRESHOLDS]
}

/** 排除模型归一（与 extension 同款）：过滤非字符串与不含 "/" 的条目 → 去重（保序）。 */
function normalizeExcludedModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((m): m is string => typeof m === 'string' && m.includes('/')))]
}

/**
 * 读取 smart-context 配置快照。文件不存在/坏 JSON/字段非法 → 默认值
 * （与 extension normalizeSmartContextConfig 的回退语义一致）。不抛错（防御性设计，与 getRenameModel 一致）。
 */
export function getSmartContextConfig(): SmartContextConfigSnapshot {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getSmartContextConfigPath(), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return smartContextDefaults()
    }
    const r = parsed as Record<string, unknown>
    return {
      enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : true,
      compactModel: extractCompactModelRef(r),
      reminderThresholds: normalizeThresholds(r['reminderThresholds']),
      excludedModels: normalizeExcludedModels(r['excludedModels']),
    }
  } catch {
    return smartContextDefaults()
  }
}

/** 默认快照（与 SMART_CONTEXT_DEFAULT_CONFIG 对应的扁平视图）。 */
function smartContextDefaults(): SmartContextConfigSnapshot {
  return {
    enabled: true,
    compactModel: '',
    reminderThresholds: [...SMART_CONTEXT_DEFAULT_THRESHOLDS],
    excludedModels: [],
  }
}

/**
 * RMW 只覆盖指定字段（锁协议与 setRenameModel 逐字对齐）：读文件 → 展开基底 → apply 覆盖 →
 * 原子写（2 空格缩进 + 尾换行，与 extension llm-shared saveConfig 序列化格式一致）。
 * 文件不存在/坏 JSON → 默认基底（保留字段全部落默认值，与 extension 读取侧回退语义一致）。
 */
function writeSmartContextField(apply: (base: Record<string, unknown>) => void): void {
  const configPath = getSmartContextConfigPath()
  withFileLockSync(configPath, () => {
    let base: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
      base = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : { ...SMART_CONTEXT_DEFAULT_CONFIG, reminderThresholds: [...SMART_CONTEXT_DEFAULT_THRESHOLDS] }
    } catch {
      base = { ...SMART_CONTEXT_DEFAULT_CONFIG, reminderThresholds: [...SMART_CONTEXT_DEFAULT_THRESHOLDS] }
    }
    apply(base)
    mkdirSync(dirname(configPath), { recursive: true })
    // tmp 唯一化理由同 setRenameModel：对端（smart-context 扩展 llm-shared saveConfig）写同一文件。
    atomicWrite(configPath, `${JSON.stringify(base, null, JSON_INDENT)}\n`, uniqueTmpSuffix())
  }, smartContextLockOptions)
}

/** 设置智能上下文压缩开关（只覆盖 enabled 字段，保留其他字段）。 */
export function setSmartContextEnabled(enabled: boolean): void {
  writeSmartContextField((base) => {
    base['enabled'] = enabled
  })
}

/**
 * 设置压缩模型（只覆盖 compactModel 字段）。空串 = 跟随当前会话模型（same-model 模式）；
 * 非空但不含 "/" 归一为空串（extension pickMode 只认 ref 串，无 "/" 的 ref 等于未设置，不如归一）。
 */
export function setSmartContextCompactModel(model: string): void {
  const normalized = model.includes('/') ? model : ''
  writeSmartContextField((base) => {
    base['compactModel'] = { type: 'ref', ref: normalized }
  })
}

/** 设置 3 档提醒阈值（token 绝对数；clamp：过滤正数 → 升序 → 截 3 档，空回退默认）。 */
export function setSmartContextThresholds(thresholds: number[]): void {
  const normalized = normalizeThresholds(thresholds)
  writeSmartContextField((base) => {
    base['reminderThresholds'] = normalized
  })
}

/** 设置排除模型列表（过滤无 "/" 条目 + 去重，只覆盖 excludedModels 字段）。 */
export function setSmartContextExcludedModels(models: string[]): void {
  const normalized = normalizeExcludedModels(models)
  writeSmartContextField((base) => {
    base['excludedModels'] = normalized
  })
}
