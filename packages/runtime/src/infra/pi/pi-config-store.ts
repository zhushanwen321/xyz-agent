/**
 * IConfigStore 的 infra 实现 —— 封装 pi-provider-store/agent-crud/pi-paths，type 透传。
 *
 * 🔒 归属（R3a，三层架构）：infra/pi/ 内部，实现 services/ports.ts 的 IConfigStore。
 * pi 的协议类型（PiProviderConfig/PiModelDefinition）只在此处出现；
 * service 经 IConfigStore 拿到的是 ConfigProviderConfig（service 视图）。
 *
 * 本类是 pi 配置的「连接」层：连接 pi-provider-store（pi 的 models.json
 * CRUD）、agent-crud（agent .md 文件）、pi-paths（配置目录）。
 *
 * W1：applyTypeTranslation 改为透传。历史上此处有 mapTypeToApi 别名翻译表
 * （anthropic→anthropic-messages、ollama→openai-completions 等），但前端已直接发送
 * pi 终值，runtime 翻译属于死代码；更糟的是 ollama 翻译会掩盖前端 bug
 * （pi 不支持 ollama）。故删除翻译表，runtime 原样透传，未知值 warn 但不阻断。
 */
import type {
  IConfigStore,
  ConfigProviderConfig,
  ConfigModelsConfig,
} from '../../services/ports/config.js'
import { KNOWN_PI_API_TYPES } from '@xyz-agent/shared'
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

  /**
   * 透传 provider type → pi api 标识。
   * 前端已直接发送 pi 终值（anthropic-messages / openai-completions），runtime 不再翻译别名。
   * 未知值（非 pi 支持的 api）warn 但不阻断，便于排查前端误传，避免静默吞错。
   */
  applyTypeTranslation(type: string): string {
    // pi 支持的 api 终值白名单（SSOT：@xyz-agent/shared 的 KNOWN_PI_API_TYPES）；
    // 非白名单值仅 warn 不阻断（前端可能在迭代中）。
    if (!KNOWN_PI_API_TYPES.has(type)) {
      console.warn(`[pi-config-store] 未知 provider api type "${type}"，原样透传（pi 可能不支持）`)
    }
    return type
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
