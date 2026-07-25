/**
 * Coding Plan 额度查询 — Provider 预设配置。
 *
 * SSOT：5 个内置 provider 的 fetcher 映射、认证方式、自动关联规则。
 * 设计文档：docs/page-design/v3/coding-plan-quota/design.md §2.2.1
 */

/** 单个 provider 的额度查询预设。 */
export interface QuotaPreset {
  /** 匹配 ProviderQuotaFetcher.id（fetcher 注册表的 key）。 */
  fetcher: string
  /** 显示名（如 '智谱 GLM Coding Plan'）。 */
  label: string
  /** 认证方式：决定 UI 渲染哪种凭证输入。 */
  auth: 'api-key' | 'cookie'
  /** Provider 自动关联规则：判断某个 ProviderInfo 是否命中此预设。 */
  match: {
    /** 按 baseUrl 域名匹配（如 'bigmodel.cn'）。baseUrl 包含此字符串即命中。 */
    baseUrlPattern?: string
    /** 按 provider name 关键字匹配（不区分大小写，支持 | 分隔多个关键字）。 */
    namePattern?: string
  }
  /** 帮助页面 URL（UI 上显示「如何获取凭证」链接）。 */
  helpUrl?: string
  /** 帮助说明文案。 */
  helpText?: string
}

/** 内置 5 个 provider 预设（SSOT）。 */
export const QUOTA_PRESETS: QuotaPreset[] = [
  {
    fetcher: 'zhipu',
    label: '智谱 GLM Coding Plan',
    auth: 'api-key',
    match: {
      baseUrlPattern: 'bigmodel.cn',
      namePattern: 'zhipu|glm|zai',
    },
    helpUrl: 'https://bigmodel.cn/usercenter/glm-coding/usage',
    helpText: '在 bigmodel.cn 控制台 → API Keys 页面获取',
  },
  {
    fetcher: 'kimi-coding',
    label: 'Kimi Coding Plan',
    auth: 'api-key',
    match: {
      baseUrlPattern: 'kimi.com',
      namePattern: 'kimi',
    },
    helpUrl: 'https://platform.moonshot.cn/',
    helpText: '在 Kimi 开放平台 → API Key 管理页面获取',
  },
  {
    fetcher: 'minimax',
    label: 'MiniMax Coding Plan',
    auth: 'api-key',
    match: {
      baseUrlPattern: 'minimaxi.com',
      namePattern: 'minimax',
    },
    helpUrl: 'https://platform.minimaxi.com/',
    helpText: '在 MiniMax 开放平台 → 账户管理获取',
  },
  {
    fetcher: 'mimo',
    label: '小米 MiMo Coding Plan',
    auth: 'cookie',
    match: {
      baseUrlPattern: 'xiaomimimo.com',
      namePattern: 'mimo',
    },
    helpUrl: 'https://platform.xiaomimimo.com/',
    helpText: '登录 platform.xiaomimimo.com 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串',
  },
  {
    fetcher: 'opencode-go',
    label: 'opencode.go',
    auth: 'cookie',
    match: {
      namePattern: 'opencode',
    },
    helpUrl: 'https://opencode.ai/',
    helpText: '登录 opencode.ai 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串',
  },
]

/**
 * 根据 provider 的 baseUrl 和 name 匹配内置预设。
 *
 * @param provider - 提供 baseUrl 和/或 name 的对象（来自 ProviderInfo）。
 * @returns 匹配到的 QuotaPreset，或 undefined（无匹配）。
 */
export function matchQuotaPreset(provider: {
  baseUrl?: string
  name?: string
}): QuotaPreset | undefined {
  const { baseUrl, name } = provider
  if (!baseUrl && !name) return undefined

  const normalizedName = name?.toLowerCase() ?? ''

  for (const preset of QUOTA_PRESETS) {
    const { baseUrlPattern, namePattern } = preset.match

    // baseUrl 匹配：provider 的 baseUrl 包含 pattern
    if (baseUrlPattern && baseUrl?.includes(baseUrlPattern)) {
      return preset
    }

    // name 匹配：支持 | 分隔的多关键字正则
    if (namePattern && normalizedName) {
      const regex = new RegExp(namePattern, 'i')
      if (regex.test(normalizedName)) {
        return preset
      }
    }
  }

  return undefined
}
