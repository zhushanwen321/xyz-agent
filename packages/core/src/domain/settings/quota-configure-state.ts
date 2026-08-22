/**
 * QuotaConfigure 状态契约 —— renderer useQuotaConfigure 返回态与 ui 注入 key 的共享 SSOT。
 *
 * [BL round1 monorepo S] 原 ui injection-keys 逐字段手工镜像 renderer UseQuotaConfigureReturn
 * （398 行 × 2 处重复）：provide 接线的 structural typing 只能 catch 字段缺失，接口本体
 * 漂移（一侧改字段语义）编译器不守护 → 契约提升到 core，renderer 真实返回类型从本类型
 * 派生（UseQuotaConfigureReturn = QuotaConfigureState），ui injection-keys import 本类型，
 * 双侧同一类型消除镜像。
 *
 * 放置：core/domain/settings（core 已依赖 vue + shared；renderer/ui 均依赖 core，
 * 对齐 core domain 类型放置惯例）。
 */
import type { Ref } from 'vue'
import type { NormalizedQuotaRow, QuotaAuthKind, QuotaFetchFailureReason } from '@xyz-agent/shared'

/** 测试查询状态 */
export type QuotaTestStatus = 'idle' | 'loading' | 'success' | 'error'

/** QuotaConfigure 返回态（renderer 实现见 useQuotaConfigure composable） */
export interface QuotaConfigureState {
  /** 当前选中的 fetcher id（未选择 = undefined） */
  fetcherId: Ref<string | undefined>
  /** 下拉框选项列表（QUOTA_PRESETS 映射） */
  fetcherOptions: Array<{ value: string; label: string }>
  /** 是否启用额度查询（Switch 双向绑定） */
  enabled: Ref<boolean>
  /** cookie 输入值（cookie 类 provider 专用） */
  cookieInput: Ref<string>
  /** Coding Plan 专属 API Key 输入值（api-key 类，留空 = 复用 provider.apiKey） */
  apiKeyInput: Ref<string>
  /** 是否已配置专属 API Key（provider.quota.apiKeySet） */
  apiKeyConfigured: Ref<boolean>
  /** 测试查询状态 */
  testStatus: Ref<QuotaTestStatus>
  /** 测试查询错误信息（testStatus='error' 且无 reason 时有值） */
  testError: Ref<string>
  /** 最近一次成功查询的额度数据（失败态下旧缓存保留在此，经「查看上次成功数据」展开） */
  quotaData: Ref<NormalizedQuotaRow | null>
  /** 最后成功查询时间戳（ms） */
  lastFetchAt: Ref<number | null>
  /** 当前选中 fetcher 是否为 cookie 类认证（源实现为 computed，类型兼容 Ref） */
  isCookieAuth: Ref<boolean>
  /** 当前选中 fetcher 的凭证能力声明（B-3：凭证态按 fetcher.auth 渲染；源实现为 computed） */
  authKinds: Ref<readonly QuotaAuthKind[]>
  /** 最近一次查询失败原因（A2-4 reason 透传；null = 无失败） */
  testFailReason: Ref<QuotaFetchFailureReason | null>
  /** 帮助链接（基于当前选中 fetcher；源实现为 computed） */
  helpUrl: Ref<string | undefined>
  /** 帮助文案（基于当前选中 fetcher；源实现为 computed） */
  helpText: Ref<string | undefined>
  /** 是否正在保存配置 */
  configuring: Ref<boolean>
  /** 保存配置错误 */
  configureError: Ref<string>
  /** 切换启用状态 */
  toggleEnabled: () => Promise<void>
  /** 选择 fetcher 类型（同步到本地 + 持久化 quota.fetcher） */
  selectFetcher: (id: string) => Promise<void>
  /** 保存 cookie 并启用 */
  saveCookie: () => Promise<void>
  /** 保存专属 API Key（api-key 类，空字符串 = 清除，复用 provider.apiKey） */
  saveApiKey: () => Promise<void>
  /** 测试查询（触发 quota.refresh，绕过 throttle） */
  testQuery: () => Promise<void>
  /** 重置状态（provider 切换时调用） */
  reset: () => void
}
