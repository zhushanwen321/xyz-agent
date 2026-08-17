/**
 * SettingsTransport —— settings 域 → transport 接入面（IF1）。
 *
 * core 域内只依赖本接口，不感知 WS/transport 实现。renderer 壳（W4）provide 时
 * 构造适配实现转发 @/api/domains（config + settings）；P1 transport 迁移完成后
 * 仅换实现为 core/transport 直连，域内代码不动。
 *
 * 注入机制（C-W1-2）：仿 platform/port.ts 模块级单例模式——provideSettingsTransport
 * 注入、getSettingsTransport 注入前调用 fail-fast 抛错（防隐式 undefined）。
 */
import type {
  ProviderInfo,
  ModelInfo,
  SkillInfo,
  AgentInfo,
  ExtensionInfo,
  SkillDirConfig,
  SystemPromptConfig,
  TerminalConfig,
  SetProviderData,
} from '@xyz-agent/shared'

/** discoverModels 的请求载荷（与 api/domains/config.ts 的 discoverModels 签名对齐）。 */
export interface DiscoverModelsRequest {
  baseUrl?: string
  apiKey?: string
  providerType: string
  providerId?: string
}

/** discoverModels 的响应载荷（config.discoveredModels reply 形状）。 */
export interface DiscoverModelsResponse {
  success: boolean
  error?: string
  models?: Array<{ id: string; name?: string; contextWindow?: number }>
}

/**
 * settings 域所需的最小 transport facade。
 * - 订阅函数（on*）返回取消函数（与现有 @/api on* 签名一致）。
 * - 请求函数与现有 api/domains/config.ts + settings.ts 签名对齐（mock 兼容硬约束）。
 */
export interface SettingsTransport {
  // ── 请求 ──
  listProviders(): Promise<ProviderInfo[]>
  /** 聚合模型列表主动拉取（对齐 listProviders，连接后兜底防订阅时序竞态） */
  listModels(): Promise<ModelInfo[]>
  setProvider(id: string, data: SetProviderData): Promise<void>
  discoverModels(req: DiscoverModelsRequest): Promise<DiscoverModelsResponse>
  setSkillDirs(dirs: SkillDirConfig[]): Promise<void>
  setAgentDirs(dirs: SkillDirConfig[]): Promise<void>
  setExtensionDirs(dirs: SkillDirConfig[]): Promise<void>
  // ── 订阅（返回取消函数）──
  onProviders(h: (p: ProviderInfo[]) => void): () => void
  /** 聚合模型列表（与 providers 同源，常驻订阅，model.onModels 对应） */
  onModels(h: (m: ModelInfo[]) => void): () => void
  onSkills(h: (s: SkillInfo[]) => void): () => void
  onAgents(h: (a: AgentInfo[]) => void): () => void
  onExtensions(h: (e: ExtensionInfo[]) => void): () => void
  onSkillDirs(h: (d: SkillDirConfig[]) => void): () => void
  onAgentDirs(h: (d: SkillDirConfig[]) => void): () => void
  onExtensionDirs(h: (d: SkillDirConfig[]) => void): () => void
  onDefaults(h: (m: string) => void): () => void
  onSystemPrompt(h: (cfg: SystemPromptConfig, corrupted: boolean) => void): () => void
  onTerminalConfig(h: (cfg: TerminalConfig, corrupted: boolean) => void): () => void
}

let currentTransport: SettingsTransport | null = null

/** 壳 bootstrap / 测试注入 transport 适配实现（模块级单例）。 */
export function provideSettingsTransport(transport: SettingsTransport): void {
  currentTransport = transport
}

/** 获取已注入的 transport。注入前调用 fail-fast 抛错（防隐式 undefined）。 */
export function getSettingsTransport(): SettingsTransport {
  if (!currentTransport) {
    throw new Error(
      '[core/domain/settings] getSettingsTransport() called before provideSettingsTransport() — transport not injected',
    )
  }
  return currentTransport
}

/** 仅测试用：重置为 null（单测隔离，避免跨用例污染）。 */
export function __resetSettingsTransportForTesting(): void {
  currentTransport = null
}

