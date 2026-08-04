/**
 * useSettingsShell —— settings 域壳接入编排（W4 · p3-strangler-domains::settings）。
 *
 * 承接架构 §9（PlatformPort）+ §11.0.3（bootstrap 时序）+ w3 交接项①②③④：
 * core settings 域（w1/w2 headless）+ ui settings 组件（w3）已就位，但 renderer 壳从未注入
 * platform/transport（core settings-lifecycle.init 内 getSystem(getPlatform().storage) 会 fail-fast），
 * matchMedia 系统色监听仍在旧 useSettings，ui ProviderEditModal 的 3 个注入 key 无 provide 点。
 *
 * 本 composable 在 AppShell setup 调用一次，按序完成 settings 域壳接入五件事：
 *  ① providePlatform（桌面壳入口 main.ts 已注入；此处保留调用，幂等无害）
 *  ② provideSettingsTransport（转发 @/api 的 adapter）
 *  ③ core useSettings().init()（挂常驻订阅 + 同步 system 偏好到 store）
 *  ④ provide 3 个 ui 注入 key（toast / useQuotaConfigure 工厂 / configApi）—— 向 SettingsModal 子树注入
 *  ⑤ watch system.theme 挂/卸 matchMedia listener（theme=system 时 OS 深浅色实时切换）+ 初始 apply 兜底
 *
 * [HISTORICAL] 2026-08-04：providePlatform 原只在此调用，但 AppShell 仅在连接成功后渲染
 * （App.vue v-if connectionState==='connected'）→ core ws-client.connect 的 getPlatform()
 * fail-fast 死锁（永远「连接中」）。注入已上提至 main.ts（platform/desktop-platform.ts），
 * 此处保留原调用（providePlatform 幂等，模块级单例覆盖无害）。
 *
 * core 零 DOM（架构 §11.0.1 DOM 审计）：applySystemToDom + matchMedia 是浏览器 API，下沉壳。
 * 完整 bootstrap.ts 合并（跨域 transport/session/extension-host 统一编排）留给后续壳整合 wave，
 * 本 wave 仅满足 settings 域 platform/transport 注入（strangler 逐域收编，架构 §9）。
 */
import { provide, watch, onBeforeUnmount } from 'vue'
import {
  getSettingsStore,
  useSettings,
} from '@xyz-agent/core'
import { provideSettingsTransport } from '@xyz-agent/core/domain/settings'
import {
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
  SETTINGS_CONFIG_API_KEY,
  applySystemToDom,
} from '@xyz-agent/ui/features/settings'
import { createSettingsTransport } from './settings-transport-adapter'
import { provideDesktopPlatform } from '@/platform/desktop-platform'
import { createMockPlatform } from '@/mock/mock-ws'
import { providePlatform } from '@xyz-agent/core'
import { useToast } from '@/composables/useToast'
import { useQuotaConfigure } from '@/composables/features/useQuotaConfigure'
import { config } from '@/api'
import { setLocale } from '@/i18n'
import type { Locale } from '@/i18n'

/**
 * settings 域壳接入（AppShell setup 调用一次）。
 *
 * providePlatform 幂等（core 模块级单例覆盖），重复调用无害（未来其他域壳接入复用同模式）。
 */
export function useSettingsShell(): void {
  // ① providePlatform：桌面壳 main.ts bootstrap 已注入（provideDesktopPlatform / mock 分支
  //    createMockPlatform）。此处保留调用但按 VITE_MOCK 分支（AppShell 仅在连接成功后渲染，
  //    mock 模式此处的无条件 provideDesktopPlatform 会覆盖 mock platform → 后续 connect 崩）；
  //    providePlatform 幂等（模块级单例覆盖），正常模式重复调用无害。
  if (import.meta.env.VITE_MOCK === 'true') {
    providePlatform(createMockPlatform())
  } else {
    provideDesktopPlatform()
  }

  // ② provideSettingsTransport：转发 @/api 的 adapter
  provideSettingsTransport(createSettingsTransport())

  // ③ core useSettings().init()：挂 11 域常驻订阅 + 同步 system 偏好到 store（fire-and-forget）
  const { init, dispose } = useSettings()
  void init()

  // ④ provide 3 个 ui 注入 key（向 SettingsModal 子树注入；ui 零 renderer import 铁律的依赖注入侧）
  const toast = useToast()
  provide(SETTINGS_TOAST_KEY, {
    error: (m: string) => toast.error(m),
    info: (m: string) => toast.info(m),
    warning: (m: string) => toast.warning(m),
  })
  provide(USE_QUOTA_CONFIGURE_KEY, useQuotaConfigure)
  provide(SETTINGS_CONFIG_API_KEY, { detectSources: () => config.detectSources() })

  // ⑤ matchMedia 系统色监听 + applySystemToDom 兜底
  const store = getSettingsStore()

  /** apply 当前 system 偏好到 DOM（theme/themePreset/fontSize + locale） */
  const applyCurrent = (): void => {
    // ui deps.setLocale 签名为 string；@/i18n setLocale 窄化为 Locale（locale 来自 SystemSettings.locale，运行时必合法）。
    applySystemToDom(store.system.value, { setLocale: (l) => setLocale(l as Locale) })
  }

  // 初始 apply：init() 内 setSystem 已把 storage 值同步到 store（async），但 watch 默认 lazy 不触发初始；
  // 此处兜底首次 apply（init 的 setSystem 与本调用竞态时，watch 会再纠正）。
  applyCurrent()

  // watch system.theme：theme=system 时挂 matchMedia listener（OS 深浅色实时切换），非 system 时卸载。
  // watch 的 onCleanup 自动在 theme 变化/组件卸载时卸载旧 listener，避免泄漏。
  watch(
    () => store.system.value.theme,
    (theme, _old, onCleanup) => {
      if (theme !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return
      }
      const mql = window.matchMedia('(prefers-color-scheme: light)')
      const handler = (): void => applyCurrent()
      mql.addEventListener('change', handler)
      onCleanup(() => mql.removeEventListener('change', handler))
    },
    { flush: 'pre' },
  )

  // AppShell 卸载时销毁 settings 订阅（应用生命周期内通常不触发，HMR/测试场景兜底）
  onBeforeUnmount(() => {
    dispose()
  })
}
