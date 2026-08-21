/**
 * useProviderPageOauth —— ProviderPage 的 OAuth 编排（Phase B B-1，自 ProviderPage.vue 提取，
 * vue_rules_checker script ≤300 行约束）。
 *
 * 职责：
 * - 持有唯一 useProviderOAuth 实例（QuickSetup 与编辑体凭证区共用 → auth.* listener 单份注册，
 *   AGENTS 事件规则 2「组件可能多实例」由 ProviderPage 单例天然消除，无需 refCount）
 * - 登录来源路由：quicksetup（auth.success 保持 QuickSetup 打开，保存时落 authMethod）/
 *   edit（auth.success 立即 setProvider 持久化 authMethod='oauth' → broadcast 回推编辑体）
 * - OAuthDialog 的 provider 信息派生（QuickSetup 模板优先，编辑体目标兜底）
 * - 编辑体展开时刷新 OAuth presence（has ? add : delete，MF-3 语义）
 *
 * 依赖注入：builtinProviders（模板表，判 oauthSupported / oauthName）/ providers（props ref）/
 * expandedId + newId（手风琴守卫，presence 刷新触发时机）。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BuiltinProviderTemplate, ProviderInfo, ProviderId } from '@xyz-agent/shared'
import { config } from '@/api'
import { useToast } from '@/composables/useToast'
import { useProviderOAuth } from './useProviderOAuth'
/** OAuth flow 发起方（决定 auth.success 后的收尾路径） */
type OAuthLoginSource = 'quicksetup' | 'edit'

export function useProviderPageOauth(options: {
  builtinProviders: Ref<BuiltinProviderTemplate[]>
  providers: Ref<ProviderInfo[]>
  /** 手风琴展开 id（presence 刷新触发时机）。useAccordionGuard 的 expandedId 为宽松 string */
  expandedId: Ref<string | null>
  /** 新建态 sentinel id（不参与 presence 刷新） */
  newId: string
}) {
  const { t } = useI18n()
  const toast = useToast()
  const { builtinProviders, providers, expandedId, newId } = options

  const oauth = useProviderOAuth((providerId) => { void onOAuthAuthorized(providerId) })

  const oauthLoginSource = ref<OAuthLoginSource>('quicksetup')
  /** 编辑体凭证区发起登录的目标 provider（null = 无；驱动 OAuthDialog 的 provider 信息） */
  const editOauthTarget = ref<ProviderInfo | null>(null)

  /** OAuthDialog 显示用 provider 信息：QuickSetup 模板（由调用方经 selectedTemplate 判定）优先，
   *  编辑体目标兜底（oauthName 从 builtinProviders 模板取，custom provider 无模板时缺省） */
  const oauthDialogProvider = computed(() => {
    const target = editOauthTarget.value
    if (target) {
      const builtin = builtinProviders.value.find((b) => b.id === target.id)
      return { id: target.id, name: target.name, oauthName: builtin?.oauthName }
    }
    return null
  })

  /** provider 是否支持 OAuth 登录（builtinProviders 模板 oauthSupported 判定；custom 恒 false） */
  function isOauthSupported(providerId: ProviderId): boolean {
    return builtinProviders.value.some((b) => b.id === providerId && b.oauthSupported)
  }

  /** 该 provider 的 OAuth presence（auth.json 已有凭据；编辑体凭证区「已登录」态数据源） */
  function hasOauthPresence(providerId: ProviderId): boolean {
    return oauth.oauthPresent.value.has(providerId)
  }

  /** 编辑体凭证区「登录/重新登录」（B-1）→ 共享 oauth 状态机启动 flow */
  function onEditOauthLogin(p: ProviderInfo): void {
    oauthLoginSource.value = 'edit'
    editOauthTarget.value = p
    void oauth.login(p.id)
  }

  /** QuickSetup「登录」按钮 → quicksetup 来源（auth.success 保持打开，保存时落 authMethod） */
  function onQuickSetupOauthLogin(template: BuiltinProviderTemplate): void {
    oauthLoginSource.value = 'quicksetup'
    void oauth.login(template.id)
  }

  /** auth.success 收尾（编辑体来源）：持久化 authMethod='oauth' + 刷新 OAuth presence。
   *  name/api/baseUrl 随行携带（对齐 QuickSetup payload 形态，避免 models.json 空壳条目）。 */
  async function onOAuthAuthorized(providerId: string): Promise<void> {
    if (oauthLoginSource.value !== 'edit') return
    const target = editOauthTarget.value
    editOauthTarget.value = null
    if (!target) return
    try {
      await config.setProvider(target.id, {
        name: target.name,
        type: target.api,
        baseUrl: target.baseUrl,
        authMethod: 'oauth',
      })
      toast.info(t('settings.provider.builtinTemplate.oauthAuthorized', { name: target.name }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
    await oauth.refreshOAuthPresence(providerId)
  }

  // B-1：展开 provider 时刷新 OAuth presence（凭证区「已登录」态与额度区 oauthReady 的数据源）。
  // 仅 oauth 相关 provider（authMethod=oauth 或模板 oauthSupported）拉取，其余不查询。
  watch(expandedId, (id) => {
    if (!id || id === newId) return
    const p = providers.value.find((x) => x.id === id)
    if (p && (p.authMethod === 'oauth' || isOauthSupported(p.id))) {
      void oauth.refreshOAuthPresence(id)
    }
  })

  return {
    oauth,
    oauthDialogProvider,
    isOauthSupported,
    hasOauthPresence,
    onEditOauthLogin,
    onQuickSetupOauthLogin,
  }
}
