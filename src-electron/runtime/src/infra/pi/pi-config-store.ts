/**
 * IConfigStore 的 infra 实现 —— 封装 pi-provider-store/agent-crud/pi-paths，吸收 mapTypeToApi 翻译。
 *
 * 🔒 归属（R3a，三层架构）：infra/pi/ 内部，实现 services/ports.ts 的 IConfigStore。
 * pi 的协议类型（PiProviderConfig/PiModelDefinition）只在此处出现；
 * service 经 IConfigStore 拿到的是 ConfigProviderConfig（service 视图）。
 *
 * 本类是 pi 配置的「翻译 + 连接」合一层：连接 pi-provider-store（pi 的 models.json
 * CRUD）、agent-crud（agent .md 文件）、pi-paths（配置目录），翻译 xyz provider type → pi
 * api（mapTypeToApi，从 config-service 迁入）。
 */
import type {
  IConfigStore,
  ConfigProviderConfig,
  ConfigModelsConfig,
} from '../../services/ports/config.js'
import {
  getDefaultModel,
  setDefaultModel,
  readModels,
  getProviderConfig,
  upsertProvider,
  removeProvider,
  getSkillPaths,
  setSkillPaths,
  addSkillPath,
  removeSkillPath,
  migrateSettingsSkillsToDiscovery,
} from './pi-provider-store.js'
import { listAgentFiles, writeAgentFile, deleteAgentFile } from './agent-crud.js'
import { getConfigDir, getPiAgentDir } from './pi-paths.js'
import {
  getAgentDirs as getDiscoveryAgentDirs,
  setAgentDirs as setDiscoveryAgentDirs,
} from './discovery-store.js'

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Map xyz-agent provider type strings to pi's api identifiers.
 * 从 config-service.ts 迁入（R3a）：这是 pi 协议翻译，归属 infra 而非 service。
 */
function mapTypeToApi(type: string): string {
  const map: Record<string, string> = {
    anthropic: 'anthropic-messages',
    openai: 'openai-completions',
    'openai-compatible': 'openai-completions',
    google: 'openai-completions',
    deepseek: 'openai-completions',
    ollama: 'openai-completions',
  }
  return map[type] ?? type
}

// ── IConfigStore 实现 ───────────────────────────────────────────

export class PiConfigStore implements IConfigStore {
  // ── 默认模型 ──

  getDefaultModel() {
    return getDefaultModel()
  }

  setDefaultModel(provider: string, modelId: string): void {
    setDefaultModel(provider, modelId)
  }

  // ── Provider CRUD ──

  readModels(): ConfigModelsConfig {
    // pi-provider-store 的 readModels 返回 PiModelsConfig，其 providers 字段是
    // Record<string, PiProviderConfig>。PiProviderConfig 与 ConfigProviderConfig
    // 字段结构一致（name/apiKey/baseUrl/api/models），直接 as 即可（结构同构）。
    return readModels() as unknown as ConfigModelsConfig
  }

  getProviderConfig(providerId: string): ConfigProviderConfig | undefined {
    return getProviderConfig(providerId) as unknown as ConfigProviderConfig | undefined
  }

  /** 翻译 xyz provider type → pi api 标识。 */
  applyTypeTranslation(type: string): string {
    return mapTypeToApi(type)
  }

  upsertProvider(providerId: string, merged: ConfigProviderConfig) {
    return upsertProvider(
      providerId,
      merged as unknown as Parameters<typeof upsertProvider>[1],
    )
  }

  removeProvider(providerId: string) {
    return removeProvider(providerId)
  }

  // ── Skill paths（discovery.json SSOT）──

  getSkillPaths(): string[] {
    return getSkillPaths()
  }

  setSkillPaths(paths: string[]): void {
    setSkillPaths(paths)
  }

  addSkillPath(dir: string): void {
    addSkillPath(dir)
  }

  removeSkillPath(dir: string): void {
    removeSkillPath(dir)
  }

  migrateSettingsSkillsToDiscovery(): void {
    migrateSettingsSkillsToDiscovery()
  }

  // ── Agent dirs（discovery.json SSOT）──

  getAgentDirs(): string[] {
    return getDiscoveryAgentDirs()
  }

  setAgentDirs(dirs: string[]): void {
    setDiscoveryAgentDirs(dirs)
  }

  // ── Agent files ──

  listAgentFiles(dirs?: string[]) {
    return listAgentFiles(dirs)
  }

  writeAgentFile(name: string, content: string): void {
    writeAgentFile(name, content)
  }

  deleteAgentFile(name: string): boolean {
    return deleteAgentFile(name)
  }

  // ── 配置目录 ──

  getConfigDir(): string {
    return getConfigDir()
  }

  getPiAgentDir(): string {
    return getPiAgentDir()
  }
}
