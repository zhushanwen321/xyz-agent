/**
 * useSettings —— settings 域订阅生命周期编排 composable（R2 features 层）。
 *
 * 重构动机（2026-07-02 架构返工 G2）：settings store 曾是「唯一打破 store 不拉数据铁律的 store」
 * ——它 store→api 直连 + 主动管理 7 个订阅生命周期（init/refreshProviders/dispose）+ DOM 副作用 +
 * i18n 副作用。其余 store 均为纯状态容器、由 composable 喂数据。
 *
 * 重构后职责分离：
 * - settings store 退化为纯状态容器（只持 9 域 state + 纯写入方法，不含订阅/副作用编排）。
 * - 本 composable 持有订阅句柄，负责 init/refreshProviders/dispose 的生命周期编排，
 *   与 useSidebar 持 session.list 订阅、useChat 持 chat 订阅同构（features 层管订阅，store 只存）。
 *
 * 持有什么：
 * - 7 个常驻订阅句柄（config.onProviders / model.onModels / config.onSkills / config.onAgents /
 *   config.onSkillDirs / config.onAgentDirs / config.onDefaults / extension.onExtensions）。
 * - 幂等守卫（initialized 去重；模块级 refCount 让多消费方只挂载一次订阅）。
 *
 * 不持有什么：
 * - 不持状态本身（状态在 settings store，本 composable 只做「订阅推回 → store 写入」的接线）。
 * - 不做 DOM/i18n 副作用（applySystemToDom 留在 store 的 setSystem action 内，是纯函数式副作用，
 *   store 的 action 允许做无外部依赖的同步副作用；订阅生命周期才必须归 composable）。
 *
 * 依赖方向（features 层是跨 api + stores 的唯一合法层）：
 * - 读 @/api（config / model / extension / settings 域订阅与请求）。
 * - 写 settings store（providers/models/skills/agents/extensions/skillDirs/agentDirs/defaultModel/system）。
 */
import { config, model as modelApi, extension as extensionApi, settings as settingsApi } from '@/api'
import { useSettingsStore } from '@/stores/settings'
import type { ExtensionItem } from '@/stores/settings'

/**
 * 订阅句柄 + 幂等守卫。
 *
 * 模块级（跨 useSettings 实例共享）：AppShell 应用级调用一次 init() 即挂载全部常驻订阅，
 * 其余消费方（SettingsModal/ModelSelectPopover 等）只读 store，不重复挂载。
 * initialized 守卫保证多次 init() 安全（订阅只注册一次）。
 */
const unsubs: Array<() => void> = []
let initialized = false

/**
 * 幂等初始化：挂载 7 域常驻订阅 + 同步 system 偏好到 store（store 的 setSystem 内部再落 DOM/i18n）。
 *
 * 由 AppShell（应用级，常驻）调用一次即可；多次调用安全（initialized 去重）。
 * 订阅常驻不随 modal 关闭断开，保证 settings 数据全局可消费。
 *
 * 7 个通道（行为不变约束）：
 * 1. config.onProviders → providers
 * 2. model.onModels → models（与 providers 同源，故常驻）
 * 3. config.onSkills → skills
 * 4. config.onAgents → agents
 * 5. config.onSkillDirs → skillDirs
 * 6. config.onAgentDirs → agentDirs
 * 7. config.onDefaults → defaultModel
 * 8. extension.onExtensions → extensions（extension 本地桥接类型转译）
 */
async function init(): Promise<void> {
  if (initialized) return
  initialized = true

  const store = useSettingsStore()

  unsubs.push(config.onProviders((p) => { store.providers = p }))
  // models 与 providers 同源（sendInitialState 同 step 推、provider 增删同广播），故常驻订阅
  unsubs.push(modelApi.onModels((m) => { store.models = m }))
  unsubs.push(config.onSkills((s) => { store.skills = s }))
  unsubs.push(config.onAgents((a) => { store.agents = a }))
  unsubs.push(config.onSkillDirs((d) => { store.skillDirs = d }))
  unsubs.push(config.onAgentDirs((d) => { store.agentDirs = d }))
  unsubs.push(config.onDefaults((m) => { store.defaultModel = m }))
  // onExtensions real 签名返 ExtensionInfo[]；mock 用 GlobalHandler<unknown>（数据是
  // fixtureExtensions，缺 dirName/path/source 但 ExtensionPage 不消费这些字段）。
  // 类型联合后 e 是 unknown，这里 cast 到 ExtensionItem（= ExtensionInfo alias）。
  // TODO: mock onExtensions 签名应对齐 real 的 ExtensionInfo[]（补全 dirName/path/source），
  // 消除此 cast。
  unsubs.push(extensionApi.onExtensions((e) => { store.extensions = e as ExtensionItem[] }))

  // system 是纯前端偏好（localStorage），初始化时读并同步到 DOM + i18n
  // store.setSystem 内部会 applySystemToDom（theme→data-theme + locale→i18n）
  const system = await settingsApi.getSystem()
  await store.setSystem(system)
}

/**
 * 打开 modal 时刷新 providers（拿最新快照）；skills/agents 靠订阅，不主动拉。
 * 失败时不阻塞 UI：onProviders 订阅会兜底推回最新数据。
 */
async function refreshProviders(): Promise<void> {
  const store = useSettingsStore()
  try {
    store.providers = await config.listProviders()
  // eslint-disable-next-line taste/no-silent-catch -- 拉取失败不阻塞 UI：onProviders 订阅会兜底推回最新数据，无需打扰用户
  } catch (e) {
    console.warn('[settings] listProviders 失败，依赖订阅兜底', e)
  }
}

/** 销毁订阅（AppShell 卸载时调用，应用生命周期内通常不触发）。 */
function dispose(): void {
  unsubs.splice(0).forEach((u) => u())
  initialized = false
}

/**
 * 测试隔离：重置 init 守卫（与 settings store 重置配合，beforeEach 调）。
 * 让 settings-store-models.test 的「init 幂等 / dispose 清订阅」用例可重复运行。
 */
function resetSettingsInit(): void {
  dispose()
}

/**
 * settings 域编排 composable。
 *
 * 返回订阅生命周期方法（init/refreshProviders/dispose）。状态读取直接用 useSettingsStore()
 * （各消费方按需 storeToRefs / 直读，不强制经本 composable）。
 */
export function useSettings() {
  return {
    init,
    refreshProviders,
    dispose,
    resetSettingsInit,
  }
}
