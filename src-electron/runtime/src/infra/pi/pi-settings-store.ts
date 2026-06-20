/**
 * PiSettingsStore — settings.json 的唯一读写层（D17 收口 + P0-1）。
 *
 * 背景：settings.json 是 pi 的配置文件（pi 读取它，路径 ~/.xyz-agent/pi/agent/settings.json），
 * 无法拆分成多个文件（pi 只认一个 schema/路径）。历史上两个域直接读写它：
 *   - model 域（defaultModel/enabledModels/skills/...）经 pi-provider-store
 *   - extension 域（packages[]）经 extension-service 直接 readFileSync/writeFileSync
 * 两域各自 read-modify-write，extension 的 install 是 async，await 期间 model 域的同步写可能被
 * 覆盖——跨域 RMW 竞态。
 *
 * 本模块是 settings.json 的**单一所有者**：
 *   - 唯一读写点：read() / write() / updateSync()，模块外不直接碰文件。
 *   - 分区：每个域只经自己的字段读写（model 域经 pi-provider-store 的封装函数，extension 域经
 *     IExtensionSettings port），物理上同一个文件，逻辑上各管各的 key。
 *
 * P0-1：底层 read-through 缓存 + atomicWrite 收敛到 JsonStore，删除手写缓存/读写层。
 * P1-1：删除 async updateSettings + updateChain 互斥队列——sync IO 的 RMW（run 无内部 await）
 * 在 Node 单线程内天然不交错，async 版本无调用方（extension 域改用 updateSettingsSync，
 * 签名保持 async 守 port 契约）。
 *
 * disabled-packages.json 是 xyz-agent 自己的文件（pi 不读），不在本 store 管辖（C4 单独收口）。
 *
 * 🔒 三层架构：本模块属 infra（直接碰文件系统），services 经 port 访问，不直接 import 本模块。
 */

import { JsonStore } from '../../utils/json-store.js'
import { getSettingsPath } from './pi-paths.js'

/**
 * settings.json 的完整 schema（pi 认的形状）。
 * model 域与 extension 域的字段都在这里，分区靠「调用方只改自己的 key」约定 + updateSync() 的 mutator 范围。
 */
export interface PiSettings {
  // ── model 域（pi-provider-store 管理）──
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  enabledModels?: string[]
  hideThinkingBlock?: boolean
  skills?: string[]
  // ── extension 域（extension-service 管理）──
  packages?: string[]
  extensions?: string[]
  // ── pi 其他未知字段（透传，不破坏）──
  [key: string]: unknown
}

/**
 * settings.json 存储：read-through（TTL 缓存 + ENOENT 容错）+ atomicWrite。
 * schema guard（必须是 object）放进 deserialize 钩子。
 */
let settingsStore = createSettingsStore(getSettingsPath())

function createSettingsStore(path: string): JsonStore<PiSettings> {
  return new JsonStore<PiSettings>(path, {}, {
    ttlMs: 3_000,
    deserialize: (raw): PiSettings => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        console.warn(`[pi-settings-store] ${path} schema 不匹配，使用 fallback`)
        return {}
      }
      return raw as PiSettings
    },
  })
}

/**
 * 覆盖 settings.json 路径（仅测试用）。生产不应调用。
 * 重建 store 实例并清空缓存，确保后续读拿到新路径的文件。
 */
export function setSettingsPath(path: string): void {
  settingsStore = createSettingsStore(path)
}

/** 当前 settings.json 路径（getSettingsPath() 或测试覆盖值）。 */
export function getActiveSettingsPath(): string {
  return settingsStore.getPath()
}

/** 失效缓存（外部改了文件后调用）。 */
export function invalidateSettingsCache(): void {
  settingsStore.invalidate()
}

/**
 * 读取 settings.json（带 3s 缓存）。
 * 模块外的「读」统一经此函数；缓存让高频读（getDefaultModel 等）不每次触盘。
 */
export function readSettings(): PiSettings {
  return settingsStore.read()
}

/**
 * 写入 settings.json（全量覆盖，刷新缓存）。
 * 仅在 updateSync 内部或确需全量覆盖时调用；RMW 请用 updateSync()。
 */
export function writeSettings(settings: PiSettings): void {
  settingsStore.write(settings)
}

/**
 * 同步 read-modify-write。
 *
 * @param mutator 接收当前 settings 的深拷贝，原地修改自己负责的字段后返回（void 即可，回写拷贝）。
 *   - model 域只改 defaultModel/enabledModels/skills/...
 *   - extension 域只改 packages[]
 *   分区靠调用方自觉（每个域的封装函数只动自己的 key），物理同文件、逻辑分区。
 *
 * Node 单线程 + 同步 IO：mutator 与 write 之间无 await，microtask 不在中间插入，
 * RMW 天然不交错，无需异步互斥队列。
 */
export function updateSettingsSync(mutator: (settings: PiSettings) => void): void {
  settingsStore.invalidate()
  const draft: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  mutator(draft)
  writeSettings(draft)
}
