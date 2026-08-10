/**
 * ConfigService — facade for Provider/Skill/Agent/Preferences CRUD.
 *
 * Delegates Provider CRUD to IConfigStore (injected port; impl wraps pi's
 * models.json), Skill/Agent discovery to discovery.json SSOT + scanners
 * (ADR-0021 §1：强制目录 ∪ discovery 目录，按优先级合并去重).
 * Tool permissions are persisted to ~/.xyz-agent/config.json (xyz-agent own config).
 *
 * 重构说明（Phase 1 拆分）：本文件曾是 Config 域唯一 facade（1059 行，超 ESLint max-lines）。
 * 现已按职责拆到多个 config helper（provider / skill / agent / system-prompt / terminal /
 * app-config-store / worktree-config-helper），本文件退化为构造 + appConfig IO + 单行委托桩，
 * 行为 / 签名 / import 路径零变化（复用 worktree-config-helper 验证的 accessors 注入模式）。
 * IConfigService 接口不动，现有测试不改动即全绿（行为零变化的证据）。
 */
import { homedir } from 'node:os'
import {
  type ProviderInfo,
  type BuiltinProviderTemplate,
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
  type SkillDirConfig,
} from '@xyz-agent/shared'
import type { IConfigService } from '../interfaces.js'
import type { IConfigStore } from './ports/config.js'
import type { AuthStorage } from './auth/auth-storage.js'
import type { DirScopes } from './skill-dir-config.js'
import { detectSources as detectSourcesImpl, previewImport as previewImportImpl, applyImport as applyImportImpl } from './migration/index.js'
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
  getAutoRenameEnabled as getAutoRenameEnabledImpl,
  setAutoRenameEnabled as setAutoRenameEnabledImpl,
} from './worktree-config-helper.js'
import { loadAppConfig as loadAppConfigImpl, saveAppConfig as saveAppConfigImpl } from './app-config-store.js'
import {
  getDefaultModel as getDefaultModelImpl,
  setDefaultModel as setDefaultModelImpl,
  listProviders as listProvidersImpl,
  listBuiltinProviders as listBuiltinProvidersImpl,
  checkEnvVars as checkEnvVarsImpl,
  getProvider as getProviderImpl,
  setProvider as setProviderImpl,
  toggleProviderEnabled as toggleProviderEnabledImpl,
  deleteProvider as deleteProviderImpl,
  removeProviderByKind as removeProviderByKindImpl,
  type SetProviderInput,
} from './provider-config-helper.js'
import {
  loadSkills as loadSkillsImpl,
  saveSkills as saveSkillsImpl,
  upsertSkill as upsertSkillImpl,
  deleteSkill as deleteSkillImpl,
  scanSkills as scanSkillsImpl,
} from './skill-config-helper.js'
import {
  loadAgents as loadAgentsImpl,
  saveAgents as saveAgentsImpl,
  upsertAgent as upsertAgentImpl,
  deleteAgent as deleteAgentImpl,
  scanAgents as scanAgentsImpl,
} from './agent-config-helper.js'
import {
  getSystemPromptConfig as getSystemPromptConfigImpl,
  setSystemPromptConfig as setSystemPromptConfigImpl,
  getReplaceSystemPrompt as getReplaceSystemPromptImpl,
} from './system-prompt-config-helper.js'
import {
  getTerminalConfig as getTerminalConfigImpl,
  setTerminalConfig as setTerminalConfigImpl,
} from './terminal-config-helper.js'

// ── Service ─────────────────────────────────────────────────────

export class ConfigService implements IConfigService {
  constructor(
    private projectRoot: string,
    private configStore: IConfigStore,
    /**
     * auth.json 存储（OAuth 路径 B）。
     * I9 清理①：setProvider 保存 apiKey 时清 auth.json oauth 凭据（both provider 切换凭据源）；
     * I8：deleteProvider 时同步清 auth.json（防 OAuth token 永久残留）。
     * 可选注入：未注入时两处清理 no-op（测试/无 OAuth 场景）。
     */
    private authStorage?: Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>,
  ) {}

  // ── Provider CRUD（委托 provider-config-helper）─────────────────

  getDefaultModel(): { provider: string; modelId: string } | null {
    return getDefaultModelImpl(this.configStore)
  }

  setDefaultModel(provider: string, modelId: string): void {
    setDefaultModelImpl(this.configStore, provider, modelId)
  }

  listProviders(): ProviderInfo[] {
    return listProvidersImpl(this.configStore, this.authStorage)
  }

  listBuiltinProviders(): BuiltinProviderTemplate[] {
    return listBuiltinProvidersImpl()
  }

  checkEnvVars(names: string[]): Record<string, boolean> {
    return checkEnvVarsImpl(names)
  }

  setProvider(providerId: string, data: SetProviderInput): { newDefault?: { provider: string; modelId: string } } {
    return setProviderImpl(this.configStore, this.authStorage, providerId, data)
  }

  toggleProviderEnabled(providerId: string, enabled: boolean): { newDefault?: { provider: string; modelId: string } } {
    return toggleProviderEnabledImpl(this.configStore, this.authStorage, providerId, enabled)
  }

  deleteProvider(providerId: string): { removed: boolean; newDefault?: { provider: string; modelId: string } } {
    return deleteProviderImpl(this.configStore, this.authStorage, providerId)
  }

  removeProviderByKind(providerId: string, kind: 'catalog' | 'custom'): { removed: boolean; newDefault?: { provider: string; modelId: string } } {
    return removeProviderByKindImpl(this.configStore, this.authStorage, providerId, kind)
  }

  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined {
    return getProviderImpl(this.configStore, providerId)
  }

  // ── Tool permissions (persisted to ~/.xyz-agent/config.json) ───

  getPiAgentDir(): string {
    return this.configStore.getPiAgentDir()
  }

  getConfigDir(): string {
    return this.configStore.getConfigDir()
  }

  private loadAppConfig(): Record<string, unknown> {
    return loadAppConfigImpl(this.configStore.getConfigDir())
  }

  private saveAppConfig(config: Record<string, unknown>): void {
    saveAppConfigImpl(this.configStore.getConfigDir(), config)
  }

  updateToolPermissions(permissions: Record<string, string>): void {
    const config = this.loadAppConfig()
    config['toolPermissions'] = permissions
    this.saveAppConfig(config)
  }

  // ── Worktree config（git-cwt-anywhere，委托 worktree-config-helper）──
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

  /** 读取 auto-rename 开关（标志文件存在=开，默认 false）。不经 appConfig（独立标志文件，非 config.json 字段）。 */
  getAutoRenameEnabled(): boolean {
    return getAutoRenameEnabledImpl()
  }

  /** 设置 auto-rename 开关（true 创建标志文件 / false 删除）。 */
  setAutoRenameEnabled(enabled: boolean): void {
    setAutoRenameEnabledImpl(enabled)
  }

  // ── Skill CRUD（委托 skill-config-helper）─────────────────────────

  loadSkills(projectRoot: string): SkillInfo[] {
    return loadSkillsImpl(this.configStore, projectRoot)
  }

  /** No-op: skills are discovered from discovery.json + forced dirs, not independently persisted. */
  saveSkills(projectRoot: string, skills: SkillInfo[]): void {
    saveSkillsImpl(projectRoot, skills)
  }

  /** @deprecated ADR-0021 §5 目录级管道：文件级注册已废弃，保留兼容期。新代码用 setSkillDirs。 */
  upsertSkill(skill: SkillInfo): void {
    upsertSkillImpl(this.configStore, skill)
  }

  /** @deprecated ADR-0021 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setSkillDirs。 */
  deleteSkill(skillId: string): void {
    deleteSkillImpl(this.configStore, this.projectRoot, skillId)
  }

  // ── Skill 加载路径（ADR-0021 §1 discovery.json v2 SSOT，单行委托 configStore）──

  setSkillDirs(dirs: SkillDirConfig[]): void {
    this.configStore.setSkillPaths(dirs)
  }

  getSkillDirs(): string[] {
    return this.configStore.getSkillPaths()
  }

  getSkillPathScopes(): DirScopes {
    return this.configStore.getSkillPathScopes()
  }

  getAgentDirs(): string[] {
    return this.configStore.getAgentDirs()
  }

  getAgentPathScopes(): DirScopes {
    return this.configStore.getAgentPathScopes()
  }

  setAgentDirs(dirs: SkillDirConfig[]): void {
    this.configStore.setAgentDirs(dirs)
  }

  getExtensionDirs(): string[] {
    return this.configStore.getExtensionDirs()
  }

  getExtensionPathScopes(): DirScopes {
    return this.configStore.getExtensionPathScopes()
  }

  setExtensionDirs(dirs: SkillDirConfig[]): void {
    this.configStore.setExtensionDirs(dirs)
  }

  migrateSettingsSkillsToDiscovery(): void {
    this.configStore.migrateSettingsSkillsToDiscovery()
  }

  // ── Agent CRUD（委托 agent-config-helper）────────────────────────

  loadAgents(projectRoot: string): AgentInfo[] {
    return loadAgentsImpl(this.configStore, projectRoot)
  }

  /** No-op: agents are discovered from discovery.json + forced dirs, not independently persisted. */
  saveAgents(projectRoot: string, agents: AgentInfo[]): void {
    saveAgentsImpl(projectRoot, agents)
  }

  /** @deprecated ADR-0021 §5 目录级管道：文件级写入已废弃，保留兼容期。新代码用 setAgentDirs。 */
  upsertAgent(agent: AgentInfo): void {
    upsertAgentImpl(this.configStore, agent)
  }

  /** @deprecated ADR-0021 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setAgentDirs。 */
  deleteAgent(agentId: string): void {
    deleteAgentImpl(this.configStore, agentId)
  }

  // ── Scanning（委托 scanner）──────────────────────────────────────

  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[] {
    return scanSkillsImpl(sources, existingIds)
  }

  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[] {
    return scanAgentsImpl(sources, existingIds)
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

  async applyImportProviders(importId: string, selectedIds: string[]): Promise<{ result: ProviderImportResult } | { error: { code: string; message: string } }> {
    return applyImportImpl(importId, selectedIds, this.authStorage)
  }

  // ── System prompt config（FR-6/FR-7，ADR-0044，委托 system-prompt-config-helper）──
  // 独立文件 system-prompt.json（不复用 config.json）：replace/append 两段提示词配置，
  // 插件读此文件热生效（replace 启动期注入、append 每轮 before_agent_start 注入）。

  getSystemPromptConfig(): { config: SystemPromptConfig; corrupted: boolean } {
    return getSystemPromptConfigImpl(this.configStore.getConfigDir())
  }

  setSystemPromptConfig(config: SystemPromptConfig): { ok: boolean; error?: string } {
    return setSystemPromptConfigImpl(this.configStore.getConfigDir(), config)
  }

  getReplaceSystemPrompt(): string | undefined {
    return getReplaceSystemPromptImpl(this.configStore.getConfigDir())
  }

  // ── Terminal config（Phase 6 settings，委托 terminal-config-helper）──
  // 独立文件 terminal.json（不复用 config.json）：shell/字体/scrollback 等终端偏好。
  // 仅对新 spawn 的 PTY 生效（已启动的 PTY 不动态切换 shell），由 TerminalService.resolveShell 读取。

  getTerminalConfig(): { config: TerminalConfig; corrupted: boolean } {
    return getTerminalConfigImpl(this.configStore.getConfigDir())
  }

  setTerminalConfig(config: TerminalConfig): { ok: boolean; error?: string } {
    return setTerminalConfigImpl(this.configStore.getConfigDir(), config)
  }
}
