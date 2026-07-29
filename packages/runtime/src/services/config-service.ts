/**
 * ConfigService — facade for Provider/Skill/Agent/Preferences CRUD.
 *
 * Delegates Provider CRUD to IConfigStore (injected port; impl wraps pi's
 * models.json), Skill/Agent discovery to discovery.json SSOT + scanners
 * (ADR-0020 §1：强制目录 ∪ discovery 目录，按优先级合并去重).
 * Tool permissions are persisted to ~/.xyz-agent/config.json (xyz-agent own config).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  SYSTEM_PROMPT_MAX_LENGTH,
  type ProviderInfo,
  type SkillInfo,
  type AgentInfo,
  type ScannedSkillInfo,
  type ScannedAgentInfo,
  type SystemPromptConfig,
  type TerminalConfig,
  type SourceDetectResult,
  type ProviderSource,
  type ProviderImportPreview,
  type ProviderImportResult,
} from '@xyz-agent/shared'
import type { IConfigService } from '../interfaces.js'
import type { IConfigStore, ConfigModelDefinition } from './ports/config.js'
import { atomicWrite } from '../utils/fs-utils.js'
import { extractFrontmatter, extractDescription } from '../utils/frontmatter.js'
import { expandHome } from '../utils/path-utils.js'
import { scanSkills, loadSkillFromDir } from './scanners/skill-scanner.js'
import {
  resolveGlobalSkillDirs,
  resolveProjectSkillDirs,
} from './skill-dirs.js'
import { scanAgents } from './scanners/agent-scanner.js'
import { pickModelCapabilityFields } from './model-mapper.js'
import { getConfigDir } from '../infra/pi/pi-paths.js'
import { detectSources as detectSourcesImpl } from './migration/index.js'
import { previewImport as previewImportImpl, applyImport as applyImportImpl } from './migration/index.js'
import {
  getWorktreeRootDir as getWorktreeRootDirImpl,
  setWorktreeRootDir as setWorktreeRootDirImpl,
  getSetupScript as getSetupScriptImpl,
  setSetupScript as setSetupScriptImpl,
  getBareSetupScript as getBareSetupScriptImpl,
  setBareSetupScript as setBareSetupScriptImpl,
  getTimeout as getTimeoutImpl,
  setTimeout as setTimeoutImpl,
  getDefaultBaseBranch as getDefaultBaseBranchImpl,
  setDefaultBaseBranch as setDefaultBaseBranchImpl,
} from './worktree-config-helper.js'
import {
  defaultSystemPromptConfig,
  mergeSystemPromptConfig,
  defaultTerminalConfig,
  mergeTerminalConfig,
} from './config-merge-helpers.js'

// ── ADR-0020 §1.1 强制目录（桥接层硬编码注入，不进 discovery.json）──
// 强制·项目（最高优先）> 强制·全局 > 可选（discovery 数组顺序）。
//
// ⚠️ 路径修正：ADR 文档写的逻辑路径是 ~/.xyz-agent/skills 等，但 pi 桥接层把 agentDir
// 重定向到 ~/.xyz-agent/pi/agent/，pi 实际扫的是 <piAgentDir>/skills 与 <piAgentDir>/agents。
// 故强制目录用 pi 实际路径（getPiAgentDir 拼出），而非 ADR 文档的逻辑路径——后者不存在，
// 会导致强制目录扫描落空（agent 页扫不到任何 agent）。
// 项目级强制目录（.xyz-agent/skills 等）保留 ADR 逻辑路径（项目相对路径，存在则扫）。
//
// W1：全局强制目录从硬编码 '~/.xyz-agent/skills' 改为动态 getConfigDir()。
// 必须用函数在 loadSkills/loadAgents 调用时求值——不能是模块加载时的常量：
// 测试在 beforeEach 设 XYZ_AGENT_DATA_DIR，模块导入早于 beforeEach，模块加载时求值
// 会捕获到缺省 ~/.xyz-agent（env 未设）。getConfigDir 委托 getDataDir 读 env，调用时求值
// 才能跟随实例隔离 / 自定义数据目录切换。
// 注：FORCED_PROJECT_SKILL_DIR / forcedGlobalSkillDir 已迁移至 skill-dirs.ts（scanner + watcher SSOT）。
// 此处仅保留 agent 的对应常量（agent 目录发现尚未统一到 SSOT，未来若统一再迁）。
const FORCED_PROJECT_AGENT_DIR = '.xyz-agent/agents'
/** 全局强制 agent 目录：<configDir>/agents（configDir = getConfigDir()，读 env）。 */
const forcedGlobalAgentDir = (): string => join(getConfigDir(), 'agents')

/** JSON 序列化缩进（saveAppConfig / setSystemPromptConfig 的 atomicWrite 共用）。 */
const JSON_INDENT = 2

/** Terminal config 校验范围（setTerminalConfig 写入期校验，与 TerminalPage 前端一致） */
const FONT_SIZE_MIN = 6
const FONT_SIZE_MAX = 72
const SCROLLBACK_MAX = 100000

/**
 * P6 D3 config CAS 版本冲突错误。
 *
 * setProvider/deleteProvider 读 currentVersion 对比 expectedVersion，不等时抛出。
 * settings-message-handler 捕获后 reply error{code:'version_conflict', currentVersion}，
 * 客户端收到后重新拉 config 刷新 + toast 提示「配置已被其他设备修改，已刷新，请重试」。
 *
 * 扁平错误模式（code 挂在实例上），与 worktreeError/terminalError 同构——handler 用 instanceof 判定。
 */
export class VersionConflictError extends Error {
  readonly code = 'version_conflict' as const
  constructor(public readonly currentVersion: number) {
    super(`config version conflict: expected version mismatch, current version is ${currentVersion}`)
    this.name = 'VersionConflictError'
  }
}

/**
 * 生成 atomicWrite 的唯一 tmp 后缀（时间戳 + 随机串），避免并发写入撞固定 .tmp 文件。
 * saveAppConfig / setSystemPromptConfig 共用。
 */
function uniqueTmpSuffix(): string {
  // eslint-disable-next-line no-magic-numbers -- base36 radix + slice 掉 "0." 前缀（惯用唯一串生成）
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

// ── Helpers ─────────────────────────────────────────────────────

/** Extract name and description from agent markdown frontmatter. */
function parseAgentMd(content: string): { name: string; description: string } {
  const { frontmatter } = extractFrontmatter(content)
  // name 是简单单行键值，inline 提取（不进通用 helper——name 是 agent 专属字段）
  let name = ''
  for (const fl of frontmatter.split('\n')) {
    if (fl.startsWith('name:')) name = fl.slice('name:'.length).trim()
  }
  const description = extractDescription(frontmatter)
  return { name, description }
}

/** Runtime type guard for thinkingLevelMap values. */
function isValidThinkingLevelMap(v: unknown): v is Record<string, string | null> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(val => val === null || typeof val === 'string')
}

// ── Service ─────────────────────────────────────────────────────

export class ConfigService implements IConfigService {
  constructor(
    private projectRoot: string,
    private configStore: IConfigStore,
  ) {}

  // ── Provider CRUD ──────────────────────────────────────────────

  getDefaultModel(): { provider: string; modelId: string } | null {
    return this.configStore.getDefaultModel()
  }

  /**
   * P6 D3 config CAS：返回当前 models.json 的 version（旧文件无字段时 default 0）。
   * broker 广播 config.providers 时携带，客户端据此缓存 version 用于下次 set 的 expectedVersion。
   */
  getConfigVersion(): number {
    return this.configStore.readModels().version ?? 0
  }

  /**
   * 持久化默认模型（写 settings.json，非 models.json）。
   *
   * **P6 D3 CAS 范围说明**：本方法**不纳入 config CAS**（无 expectedVersion / 不抛 VersionConflictError）。
   * spec §3.3 列举 set 路径时提到 setDefaultModel，但 §2.3 R3-M2 已澄清 setDefaultModel 改的是
   * settings.json（与 models.json 是两个独立 JsonStore 实例，version 不共享）。实施决策（与客户端
   * `renderer/src/api/domains/config.ts` 对齐）：setDefaultModel 不走 CAS，状态变更经
   * config.defaults 广播推回。models.json 的 version 字段（getConfigVersion）只覆盖
   * setProvider/deleteProvider，与 spec §2.3 目标 schema 一致。
   */
  setDefaultModel(provider: string, modelId: string): void {
    this.configStore.setDefaultModel(provider, modelId)
  }

  listProviders(): ProviderInfo[] {
    const models = this.configStore.readModels()
    // eslint-disable-next-line taste/no-unsafe-object-entries -- providers is a known schema Record<string, PiProviderConfig>, not arbitrary user input
    return Object.entries(models.providers).map(([id, config]) => ({
      id,
      name: config.name || id,
      // W2：回填 provider 级 api 字段，修复前端编辑 provider 时 type 下拉丢失（P0-1）
      api: config.api,
      baseUrl: config.baseUrl,
      apiKeySet: !!config.apiKey,
      status: config.apiKey ? 'connected' as const : 'not_configured' as const,
      models: (config.models ?? []).map(m => ({
        id: m.id,
        name: m.name,
        api: m.api,
        baseUrl: m.baseUrl,
        input: m.input,
        compat: m.compat,
        // W2：model 级 enabled 透传（默认 true 向上兼容存量无此字段的 model）
        enabled: m.enabled !== false,
        ...pickModelCapabilityFields(m),
      })),
      // W2：从 config.enabled 读，undefined/true 视为启用（向上兼容存量无此字段的 provider）
      enabled: config.enabled !== false,
      // Coding Plan 额度查询配置：透传 quota（fetcher/enabled/cookieSet）到 ProviderInfo，
      // 供 Settings UI 显示状态 + ContextCapacityPopover 判断是否显示额度区
      quota: config.quota,
    }))
  }

  setProvider(providerId: string, data: {
    name?: string
    type?: string
    apiKey?: string
    baseUrl?: string
    models?: Array<string | { id: string; name?: string; api?: string; baseUrl?: string; contextWindow?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Record<string, string | null>; enabled?: boolean; compat?: Record<string, unknown> }>
    enabled?: boolean
    /** Coding Plan 额度查询配置（手动选择 fetcher + 启用状态）。 */
    quota?: { fetcher?: string; enabled: boolean; cookieSet?: boolean }
  }, expectedVersion: number): { newDefault?: { provider: string; modelId: string }; newVersion: number } {
    // P6 D3 config CAS：先校验 expectedVersion，不等抛 VersionConflictError（handler 转 version_conflict）。
    // 必须在 upsert 前校验——避免冲突时仍写入 providers（version 自增只在成功路径触发）。
    const currentVersion = this.configStore.readModels().version ?? 0
    if (currentVersion !== expectedVersion) {
      throw new VersionConflictError(currentVersion)
    }
    const existing = this.configStore.getProviderConfig(providerId) ?? {}
    // TODO: 当 pi models.json 支持 schema 后收窄类型（现有 Record<string, unknown> 是架构限制）
    const merged: Record<string, unknown> = { ...existing }
    if (data.apiKey !== undefined) merged.apiKey = data.apiKey as string
    if (data.baseUrl !== undefined) merged.baseUrl = data.baseUrl as string
    if (data.type !== undefined) merged.api = this.configStore.applyTypeTranslation(data.type as string)
    if (data.name !== undefined) merged.name = data.name as string
    // W2：provider 级 enabled 透传到合并结果（data 类型已声明 enabled，原合并逻辑漏处理）
    if (data.enabled !== undefined) merged.enabled = data.enabled
    // Coding Plan 额度查询：整体覆写 quota（fetcher/enabled/cookieSet 三字段一起持久化）
    if (data.quota !== undefined) merged.quota = data.quota
    if (data.models !== undefined) {
      const rawModels = data.models as Array<Record<string, unknown>>
      const existingModels = (existing.models ?? []) as ConfigModelDefinition[]
      merged.models = rawModels.map(m => {
        const id = String(m.id ?? '')
        const base = existingModels.find(em => em.id === id) ?? {} as Partial<ConfigModelDefinition>
        const model: Record<string, unknown> = { ...base, id }
        if (m.name) model.name = String(m.name)
        if (typeof m.contextWindow === 'number') model.contextWindow = m.contextWindow
        if (Array.isArray(m.input)) {
          model.input = (m.input as unknown[]).filter(
            (v): v is 'text' | 'image' => v === 'text' || v === 'image',
          )
        }
        if (isValidThinkingLevelMap(m.thinkingLevelMap)) {
          model.thinkingLevelMap = m.thinkingLevelMap
        } else if (m.thinkingLevelMap === undefined && base.thinkingLevelMap) {
          // buildMap() returned undefined (all passthrough) → remove from model
          delete model.thinkingLevelMap
        }
        // review must_fix #1：前端回传的 model 级 api/baseUrl/enabled 必须写回，
        // 否则编辑保存即丢失（新模型 base={} 全丢，编辑现有模型被 base 旧值覆盖）。
        // 对齐 provider 级的「if (m.X !== undefined) model.X = ...」模式。
        if (typeof m.api === 'string') model.api = m.api
        if (typeof m.baseUrl === 'string') model.baseUrl = m.baseUrl
        if (typeof m.enabled === 'boolean') model.enabled = m.enabled
        // compat 透传：前端 compat 编辑器回传的兼容性覆盖必须写回，
        // 否则编辑保存即丢失用户手动配置的 compat（隐性数据丢失 bug）。
        // 类型守卫对齐 isValidThinkingLevelMap：必须排除 null（typeof null === 'object'）
        // 与数组（typeof [] === 'object'），否则下游遍历 null 会崩或把数组当对象写入。
        if (m.compat != null && typeof m.compat === 'object' && !Array.isArray(m.compat)) {
          // sanitize compat（守卫通过后、赋值前）：
          // - 剔除 __proto__/prototype/constructor 防 prototype pollution（compat 类型是
          //   Record<string, unknown> 前向兼容扩展点，不能假定 key 安全）
          // - 剔除 undefined value（避免 JSON 序列化丢 key 造成困惑）
          // 不做 key 白名单：compat schema 未稳定，白名单会限制前向扩展。
          const sanitized: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(m.compat)) {
            if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue
            if (v === undefined) continue
            sanitized[k] = v
          }
          model.compat = sanitized
        } else if (m.compat === undefined && base.compat) {
          // 前端 clearAll 发 undefined → 删除盘上已有的 compat（对齐 thinkingLevelMap undefined 分支），
          // 否则 base spread 会保留旧 compat，导致「清除所有 compat」按钮失效。
          delete model.compat
        }
        return model as unknown as ConfigModelDefinition
      })
    }
    const result = this.configStore.upsertProvider(providerId, merged)
    // P6 D3：upsert 成功后自增 version 落盘（bumpModelsVersion 内部 read+write 同步无竞态）。
    const newVersion = this.configStore.bumpModelsVersion()
    return { ...result, newVersion }
  }

  deleteProvider(providerId: string, expectedVersion: number): { removed: boolean; newDefault?: { provider: string; modelId: string }; newVersion: number } {
    // P6 D3 config CAS：先校验 expectedVersion（与 setProvider 同模式）。
    const currentVersion = this.configStore.readModels().version ?? 0
    if (currentVersion !== expectedVersion) {
      throw new VersionConflictError(currentVersion)
    }
    const result = this.configStore.removeProvider(providerId)
    // remove 返回 removed=false（provider 不存在）时仍走 version 自增？
    // 决策：removed=false 不自增 version（无实际写入，version 不变避免误报冲突）。
    // 但 CAS 校验已通过（expectedVersion 匹配），调用方拿到 removed=false 知道 provider 不存在。
    if (!result.removed) {
      return { ...result, newVersion: currentVersion }
    }
    const newVersion = this.configStore.bumpModelsVersion()
    return { ...result, newVersion }
  }

  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined {
    return this.configStore.getProviderConfig(providerId)
  }

  // ── Tool permissions (persisted to ~/.xyz-agent/config.json) ───

  getPiAgentDir(): string {
    return this.configStore.getPiAgentDir()
  }

  getConfigDir(): string {
    return this.configStore.getConfigDir()
  }

  private appConfigPath(): string {
    return join(this.configStore.getConfigDir(), 'config.json')
  }

  private loadAppConfig(): Record<string, unknown> {
    try {
      const cp = this.appConfigPath()
      if (existsSync(cp)) {
        const raw = readFileSync(cp, 'utf-8')
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
        console.error('[config-service] config.json is not a valid object, ignoring')
      }
    // eslint-disable-next-line taste/no-silent-catch -- intentional: config file missing/corrupt is handled by fallback
    } catch (e) {
      console.error('[config-service] load config.json error:', e)
    }
    return {}
  }

  private saveAppConfig(config: Record<string, unknown>): void {
    try {
      const cd = this.configStore.getConfigDir()
      if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
      // 用唯一 tmp 后缀避免并发 saveAppConfig 撞固定 .tmp 文件（同 setSystemPromptConfig）。
      atomicWrite(
        this.appConfigPath(),
        JSON.stringify(config, null, JSON_INDENT),
        uniqueTmpSuffix(),
      )
    // eslint-disable-next-line taste/no-silent-catch -- intentional: save failure is best-effort
    } catch (e) {
      console.error('[config-service] save config.json error:', e)
    }
  }

  updateToolPermissions(permissions: Record<string, string>): void {
    const config = this.loadAppConfig()
    config['toolPermissions'] = permissions
    this.saveAppConfig(config)
  }

  // ── Worktree config（git-cwt-anywhere）──
  // 委托 worktree-config-helper（控 max-lines 500；签名 / 行为不变，对外零感知）。
  // loadAppConfig / saveAppConfig 仍为 private，通过 appConfig() 暴露 accessors 注入。

  private appConfig(): { load(): Record<string, unknown>; save(config: Record<string, unknown>): void } {
    return {
      load: () => this.loadAppConfig(),
      save: c => this.saveAppConfig(c),
    }
  }

  getWorktreeRootDir(): string {
    return getWorktreeRootDirImpl(this.appConfig())
  }

  setWorktreeRootDir(dir: string): void {
    setWorktreeRootDirImpl(this.appConfig(), dir)
  }

  getSetupScript(): string {
    return getSetupScriptImpl(this.appConfig())
  }

  setSetupScript(script: string): void {
    setSetupScriptImpl(this.appConfig(), script)
  }

  getBareSetupScript(): string {
    return getBareSetupScriptImpl(this.appConfig())
  }

  setBareSetupScript(script: string): void {
    setBareSetupScriptImpl(this.appConfig(), script)
  }

  getTimeout(): number {
    return getTimeoutImpl(this.appConfig())
  }

  setTimeout(timeout: number): void {
    setTimeoutImpl(this.appConfig(), timeout)
  }

  getDefaultBaseBranch(): string {
    return getDefaultBaseBranchImpl(this.appConfig())
  }

  setDefaultBaseBranch(baseBranch: string): void {
    setDefaultBaseBranchImpl(this.appConfig(), baseBranch)
  }

  // ── Skill CRUD ─────────────────────────────────────────────────

  /**
   * 扫描已加载 skill：强制目录（§1.1 层 1-2）∪ discovery.json.skillDirs（层 3）。
   * 按 ADR §1.1 优先级合并去重，填 effective（最高优先那条）+ sources（多来源 badge 链）。
   * 强制目录靠桥接层重定向注入 pi 原生扫描；可选目录靠 discovery→settings 投影 + argv 注入。
   */
   
  loadSkills(projectRoot: string): SkillInfo[] {
    // 目录发现 SSOT（skill-dirs.ts）：scanner 与 watcher 共用同一份逻辑，
    // 从结构上保证 watch 范围 = scan 范围（修复 EMFILE 事故的 watch 整个 cwd 问题）。
    // 相对路径（.xyz-agent/skills + discovery 相对路径）按 projectRoot resolve 成绝对路径。
    const orderedDirs = [
      ...resolveGlobalSkillDirs(this.configStore, getConfigDir()),
      ...resolveProjectSkillDirs(projectRoot, this.configStore),
    ]

    // name → 按 priority 收集的所有来源（用于合并去重 + sources badge 链）
    const byName = new Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>()

    for (const dir of orderedDirs) {
      const expanded = expandHome(dir)
      if (!existsSync(expanded)) continue
      // discovery 目录可能含多个 skill 子目录，强制目录同理——用 loadSkillFromDir 处理单目录（含 SKILL.md），
      // 但外部目录（~/.agents/skills 等）是「含多个 skill 子目录的容器」，需遍历子目录。
      // 复用 skill-scanner 的 forEachScannedDir 语义：对容器目录遍历子目录找 SKILL.md。
      this.collectSkillsFromDir(dir, byName)
    }

    // 合并去重：每个 name 取最高优先来源为 effective，其余进 sources badge 链
    const results: SkillInfo[] = []
    for (const [, entries] of byName) {
      const primary = entries[0] // 数组按优先级顺序，第一个为最高优先
      const scanned = primary.scanned
      const sources = entries.length > 1
        ? entries.map(e => ({ source: e.scanned.sourceType, sourcePath: e.scanned.sourcePath }))
        : undefined
      results.push({
        id: scanned.id,
        name: scanned.name,
        description: scanned.description,
        enabled: true, // ADR §5：目录在 = 启用，恒 true
        source: scanned.sourceType,
        triggers: scanned.triggers,
        argumentHint: scanned.argumentHint,
        sourcePath: scanned.sourcePath,
        content: scanned.content,
        fileSize: scanned.fileSize,
        tools: scanned.tools,
        effective: true, // 最高优先来源标生效
        sources,
      })
    }
    return results
  }

  /**
   * 从单个目录收集 skill。dir 可能是：
   * - 含 SKILL.md 的单 skill 目录（强制目录的典型）→ loadSkillFromDir
   * - 含多个 skill 子目录的容器（~/.agents/skills 等）→ 遍历子目录
   */
  private collectSkillsFromDir(dir: string, byName: Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>): void {
    const expanded = expandHome(dir)
    // 先尝试 dir 本身含 SKILL.md（单 skill 目录）
    const direct = loadSkillFromDir(dir)
    if (direct) {
      this.pushSkillSource(byName, dir, direct)
      return
    }
    // 否则当作容器，遍历子目录
    if (!existsSync(expanded)) return
    try {
      const names = readdirSync(expanded)
      for (const name of names) {
        const childDir = join(expanded, name)
        try {
          if (!statSync(childDir).isDirectory()) continue
        } catch { continue }
        const childScanned = loadSkillFromDir(join(dir, name))
        if (childScanned) this.pushSkillSource(byName, join(dir, name), childScanned)
      }
    // eslint-disable-next-line taste/no-silent-catch -- 容器不可读则跳过
    } catch {
      // dir 不可读，跳过
    }
  }

  /** 把一个 skill 来源按优先级顺序追加进 byName（靠前目录 = 高优先，先入为主）。 */
  private pushSkillSource(
    byName: Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>,
    dir: string,
    scanned: ScannedSkillInfo,
  ): void {
    const list = byName.get(scanned.name) ?? []
    list.push({ dir, scanned })
    byName.set(scanned.name, list)
  }

  /** No-op: skills are discovered from discovery.json + forced dirs, not independently persisted. */
   
  saveSkills(_projectRoot: string, _skills: SkillInfo[]): void {
    // no-op — skill persistence is managed by discovery.json SSOT (ADR-0020 §1)
  }

  /** @deprecated ADR-0020 §5 目录级管道：文件级注册已废弃，保留兼容期。新代码用 setSkillDirs。 */
  upsertSkill(skill: SkillInfo): void {
    console.warn('[config-service] upsertSkill is deprecated (ADR-0020 §5). Use setSkillDirs for directory-level config.')
    if (skill.sourcePath) {
      const dir = dirname(skill.sourcePath)
      this.configStore.addSkillPath(dir)
    }
  }

  /** @deprecated ADR-0020 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setSkillDirs。 */
  deleteSkill(skillId: string): void {
    console.warn('[config-service] deleteSkill is deprecated (ADR-0020 §5). Use setSkillDirs for directory-level config.')
    const skills = this.loadSkills(this.projectRoot)
    const skill = skills.find(s => s.id === skillId)
    if (skill?.sourcePath) {
      const dir = dirname(skill.sourcePath)
      this.configStore.removeSkillPath(dir)
    }
  }

  // ── Skill 加载路径（ADR-0020 §1 discovery.json SSOT）──

  setSkillDirs(dirs: string[]): void {
    this.configStore.setSkillPaths(dirs)
  }

  getSkillDirs(): string[] {
    return this.configStore.getSkillPaths()
  }

  getAgentDirs(): string[] {
    return this.configStore.getAgentDirs()
  }

  setAgentDirs(dirs: string[]): void {
    this.configStore.setAgentDirs(dirs)
  }

  getExtensionDirs(): string[] {
    return this.configStore.getExtensionDirs()
  }

  setExtensionDirs(dirs: string[]): void {
    this.configStore.setExtensionDirs(dirs)
  }

  migrateSettingsSkillsToDiscovery(): void {
    this.configStore.migrateSettingsSkillsToDiscovery()
  }

  // ── Agent CRUD ─────────────────────────────────────────────────

  /**
   * 扫描已加载 agent：强制目录（§1.1 层 1-2）∪ discovery.json.agentDirs（层 3）。
   * 多目录扫描经 IConfigStore.listAgentFiles(dirs)（同名按数组顺序去重），
   * 转 AgentInfo（目录在 = 启用，ADR §5）。
   *
   * 强制目录含 pi 实际路径 <piAgentDir>/agents（pi 重定向后的真实扫描位置，
   * 旧 listAgentFiles() 默认扫此）+ ADR 项目/全局逻辑路径（存在则扫）。
   */
   
  loadAgents(_projectRoot: string): AgentInfo[] {
    const orderedDirs = [
      join(this.configStore.getPiAgentDir(), 'agents'), // pi 实际路径（最高优先，真实 agent 落点）
      FORCED_PROJECT_AGENT_DIR,
      forcedGlobalAgentDir(),
      ...this.configStore.getAgentDirs(),
    ].map(expandHome).filter(d => existsSync(d))

    // listAgentFiles(dirs) 已按数组顺序去重（靠前胜出），单来源即生效无需额外 sources
    const files = this.configStore.listAgentFiles(orderedDirs)
    return files.map(f => {
      const { name, description } = parseAgentMd(f.content)
      // W1：sourceType 从 agent-crud 推断结果读（按 discovered 目录推断，如 ~/.claude/agents → 'claude'），
      // 不再恒 'pi'——否则 Settings Agent 页按 Claude/Agents tab 过滤永远空。
      // ?? 'pi' 兜底：向上兼容旧 entry 无 sourceType 字段。
      const sourceType = f.sourceType ?? 'pi'
      return {
        id: f.name,
        name: name || f.name,
        description: description || '',
        enabled: true, // ADR §5：目录在 = 启用，恒 true
        modelStrategy: 'auto',
        source: sourceType,
        sourceType,
        content: f.content,
        tools: [],
        effective: true,
      }
    })
  }

  /** No-op: agents are discovered from discovery.json + forced dirs, not independently persisted. */
   
  saveAgents(_projectRoot: string, _agents: AgentInfo[]): void {
    // no-op — agent persistence is managed as .md files + discovery.json SSOT (ADR-0020 §1)
  }

  /** @deprecated ADR-0020 §5 目录级管道：文件级写入已废弃，保留兼容期。新代码用 setAgentDirs。 */
  upsertAgent(agent: AgentInfo): void {
    console.warn('[config-service] upsertAgent is deprecated (ADR-0020 §5). Use setAgentDirs for directory-level config.')
    if (agent.content) {
      this.configStore.writeAgentFile(agent.name || agent.id, agent.content)
    }
  }

  /** @deprecated ADR-0020 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setAgentDirs。 */
  deleteAgent(agentId: string): void {
    console.warn('[config-service] deleteAgent is deprecated (ADR-0020 §5). Use setAgentDirs for directory-level config.')
    this.configStore.deleteAgentFile(agentId)
  }

  // ── Scanning ───────────────────────────────────────────────────

  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[] {
    return scanSkills(sources, existingIds)
  }

  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[] {
    return scanAgents(sources, existingIds)
  }

  // ── 迁移源检测（W1，cw-2026-07-26-migration-other-agents）──
  // 只读检测本机其他 agent（Claude/Codex/Pi/ZCode）的 skill/agent 配置目录，
  // 返回每个源的安装状态 + 资源计数（不读文件内容）。详见 services/migration/source-detector.ts。
  detectSources(): SourceDetectResult[] {
    return detectSourcesImpl(process.env.HOME || homedir())
  }

  // ── Provider 导入（W2，cw-2026-07-26-migration-other-agents）──
  // preview→apply 两步数据流 + 内存缓存。安全红线（DM1）：apiKey 明文不进前端。
  // preview 返回脱敏数据（只 apiKeyExtracted 布尔），完整配置暂存 preview-cache（5min TTL）。
  // 实现委托 services/migration/provider-importer（与 detectSources 同模式：纯函数 + 直接读 pi-provider-store，
  // 对齐 quota-service 的 provider 级直访先例，不经 IConfigStore port）。

  previewImportProviders(source: ProviderSource): { importId: string; preview: ProviderImportPreview } | { error: { code: string; message: string } } {
    return previewImportImpl(source, process.env.HOME || homedir())
  }

  applyImportProviders(importId: string, selectedIds: string[]): { result: ProviderImportResult } | { error: { code: string; message: string } } {
    return applyImportImpl(importId, selectedIds)
  }

  // ── System prompt config（FR-6/FR-7，ADR-0038）──
  // 独立文件 system-prompt.json（不复用 config.json）：replace/append 两段提示词配置，
  // 插件读此文件热生效（replace 启动期注入、append 每轮 before_agent_start 注入）。
  // 默认值 / 合并纯逻辑见 config-merge-helpers.ts。

  private systemPromptPath(): string {
    return join(this.configStore.getConfigDir(), 'system-prompt.json')
  }

  getSystemPromptConfig(): { config: SystemPromptConfig; corrupted: boolean } {
    const cp = this.systemPromptPath()
    if (!existsSync(cp)) {
      return { config: defaultSystemPromptConfig(), corrupted: false }
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(cp, 'utf-8'))
    } catch {
      return { config: defaultSystemPromptConfig(), corrupted: true }
    }
    return { config: mergeSystemPromptConfig(raw), corrupted: false }
  }

  setSystemPromptConfig(config: SystemPromptConfig): { ok: boolean; error?: string } {
    if (config.replace.prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
      return {
        ok: false,
        error: `replace prompt exceeds max length (${SYSTEM_PROMPT_MAX_LENGTH})`,
      }
    }
    // append 同样校验长度：append 虽不走 argv（无 Windows 32k 限制），但无上限会导致
    // 每轮拼进 systemPrompt 的 token 失控。复用同一上限保持双卡 UX 一致。
    if (config.append.prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
      return {
        ok: false,
        error: `append prompt exceeds max length (${SYSTEM_PROMPT_MAX_LENGTH})`,
      }
    }
    const cd = this.configStore.getConfigDir()
    if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
    // 用唯一 tmp 后缀避免并发 setSystemPromptConfig 撞固定 .tmp 文件
    // （两次并发写入会共用同一 system-prompt.json.tmp，后写的 writeFileSync 覆盖前者数据）。
    atomicWrite(
      this.systemPromptPath(),
      JSON.stringify(config, null, JSON_INDENT),
      uniqueTmpSuffix(),
    )
    return { ok: true }
  }

  getReplaceSystemPrompt(): string | undefined {
    const { config } = this.getSystemPromptConfig()
    if (config.replace.enabled && config.replace.prompt.trim() !== '') {
      // 防御性长度兜底：setSystemPromptConfig 写入期已校验上限，但 replace/append 启用态切换
      // 或外部直接篡改 system-prompt.json 可能写入超长 prompt。原样返回会让超长 prompt 进
      // pi spawn argv，触发 Windows 32k 命令行截断。降级为不注入（返回 undefined）比注入
      // 残缺内容更安全。错误信息风格与 setSystemPromptConfig 一致。
      if (config.replace.prompt.length > SYSTEM_PROMPT_MAX_LENGTH) {
        console.warn(
          `[config-service] replace prompt exceeds max length (${SYSTEM_PROMPT_MAX_LENGTH}), falling back to undefined (replace disabled this run)`,
        )
        return undefined
      }
      return config.replace.prompt
    }
    return undefined
  }

  // ── Terminal config（Phase 6 settings）──
  // 独立文件 terminal.json（不复用 config.json）：shell/字体/scrollback 等终端偏好。
  // 仅对新 spawn 的 PTY 生效（已启动的 PTY 不动态切换 shell），由 TerminalService.resolveShell 读取。
  // 默认值 / 合并纯逻辑见 config-merge-helpers.ts。

  private terminalPath(): string {
    return join(this.configStore.getConfigDir(), 'terminal.json')
  }

  getTerminalConfig(): { config: TerminalConfig; corrupted: boolean } {
    const tp = this.terminalPath()
    if (!existsSync(tp)) {
      return { config: defaultTerminalConfig(), corrupted: false }
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(tp, 'utf-8'))
    } catch {
      return { config: defaultTerminalConfig(), corrupted: true }
    }
    return { config: mergeTerminalConfig(raw), corrupted: false }
  }

  setTerminalConfig(config: TerminalConfig): { ok: boolean; error?: string } {
    // 校验数值字段的合理范围（防异常值写盘后破坏 xterm 渲染或终端启动）
    if (!Number.isFinite(config.fontSize) || config.fontSize < FONT_SIZE_MIN || config.fontSize > FONT_SIZE_MAX) {
      return { ok: false, error: `fontSize out of range (${FONT_SIZE_MIN}-${FONT_SIZE_MAX}): ${config.fontSize}` }
    }
    if (!Number.isFinite(config.scrollback) || config.scrollback < 0 || config.scrollback > SCROLLBACK_MAX) {
      return { ok: false, error: `scrollback out of range (0-${SCROLLBACK_MAX}): ${config.scrollback}` }
    }
    const validCursorStyles: TerminalConfig['cursorStyle'][] = ['block', 'underline', 'bar']
    if (!validCursorStyles.includes(config.cursorStyle)) {
      return { ok: false, error: `invalid cursorStyle: ${config.cursorStyle}` }
    }
    const cd = this.configStore.getConfigDir()
    if (!existsSync(cd)) mkdirSync(cd, { recursive: true })
    // 用唯一 tmp 后缀避免并发 setTerminalConfig 撞固定 .tmp 文件（同 setSystemPromptConfig）
    atomicWrite(
      this.terminalPath(),
      JSON.stringify(config, null, JSON_INDENT),
      uniqueTmpSuffix(),
    )
    return { ok: true }
  }
}
