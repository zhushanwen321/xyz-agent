/**
 * SettingsTransport adapter —— core settings 域 → transport 接入面（IF1）的 renderer 壳实现（W4）。
 *
 * core 域内只依赖 SettingsTransport 接口（transport.ts），不感知 WS/transport 实现。
 * 本 adapter 在 useSettingsShell providePlatform/provideSettingsTransport 时构造，
 * 逐方法转发 @/api/domains/{config,model,extension}（P1 transport 迁移完成后换 core/transport 直连，
 * 域内代码不动）。
 *
 * 签名对齐 core SettingsTransport 接口；mock 兼容硬约束（@/api 的 on* 订阅 / listProviders 等已就位）。
 */
import type { SettingsTransport, DiscoverModelsRequest, DiscoverModelsResponse } from '@xyz-agent/core/domain/settings'
import type { ProviderId } from '@xyz-agent/shared'
import * as configApi from '@/api/domains/config'
import * as modelApi from '@/api/domains/model'
import * as extensionApi from '@/api/domains/extension'

/**
 * 构造 SettingsTransport 实现：逐方法转发 @/api。
 * 订阅函数（on*）返回取消函数；请求函数签名与 @/api 对齐。
 */
export function createSettingsTransport(): SettingsTransport {
  return {
    // ── 请求 ──
    listProviders: () => configApi.listProviders(),
    listModels: () => modelApi.listModels(),
    setProvider: (id, data) => configApi.setProvider(id as ProviderId, data),
    setScopedModels: async (models) => {
      const reply = await configApi.setScopedModels(models)
      return reply
    },
    discoverModels: async (req: DiscoverModelsRequest): Promise<DiscoverModelsResponse> => {
      // core DiscoverModelsRequest（baseUrl? / providerType 必）与 @/api config.discoverModels
      // （baseUrl 必 / providerType?）形状互补；实际调用方（use-provider-edit runDiscover）
      // 总是传 baseUrl。此处显式 guard：baseUrl 缺失时短路返失败，不做 silent cast。
      if (!req.baseUrl) {
        return { success: false, error: 'baseUrl is required for model discovery' }
      }
      return configApi.discoverModels({
        baseUrl: req.baseUrl,
        apiKey: req.apiKey,
        providerType: req.providerType,
        providerId: req.providerId,
      })
    },
    setSkillDirs: (dirs) => configApi.setSkillDirs(dirs),
    setAgentDirs: (dirs) => configApi.setAgentDirs(dirs),
    setExtensionDirs: (dirs) => configApi.setExtensionDirs(dirs),

    // ── 订阅（返回取消函数）──
    onProviders: (h) => configApi.onProviders(h),
    onModels: (h) => modelApi.onModels(h),
    onSkills: (h) => configApi.onSkills(h),
    onAgents: (h) => configApi.onAgents(h),
    onExtensions: (h) => extensionApi.onExtensions(h),
    onSkillDirs: (h) => configApi.onSkillDirs(h),
    onAgentDirs: (h) => configApi.onAgentDirs(h),
    onExtensionDirs: (h) => configApi.onExtensionDirs(h),
    onDefaults: (h) => configApi.onDefaults(h),
    onSystemPrompt: (h) => configApi.onSystemPrompt(h),
    onTerminalConfig: (h) => configApi.onTerminalConfig(h),
  }
}

