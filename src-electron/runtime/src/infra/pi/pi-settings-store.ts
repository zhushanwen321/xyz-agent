/**
 * PiSettingsStore — settings.json 的唯一读写层（D17 收口）。
 *
 * 背景：settings.json 是 pi 的配置文件（pi 读取它，路径 ~/.xyz-agent/pi/agent/settings.json），
 * 无法拆分成多个文件（pi 只认一个 schema/路径）。历史上两个域直接读写它：
 *   - model 域（defaultModel/enabledModels/skills/...）经 pi-provider-store
 *   - extension 域（packages[]）经 extension-service 直接 readFileSync/writeFileSync
 * 两域各自 read-modify-write，extension 的 install 是 async，await 期间 model 域的同步写可能被
 * 覆盖——跨域 RMW 竞态。
 *
 * 本模块是 settings.json 的**单一所有者**：
 *   - 唯一读写点：read() / write() / update()，模块外不直接碰文件。
 *   - 异步互斥：update(mutator) 把 RMW 串行化，async 调用也安全。
 *   - 分区：每个域只经自己的字段读写（model 域经 pi-provider-store 的封装函数，extension 域经
 *     IExtensionSettings port），物理上同一个文件，逻辑上各管各的 key。
 *
 * disabled-packages.json 是 xyz-agent 自己的文件（pi 不读），不在本 store 管辖，保持独立
 * （见 ExtensionService 内的 disabled 操作，或后续单独收口）。
 *
 * 🔒 三层架构：本模块属 infra（直接碰文件系统），services 经 port 访问，不直接 import 本模块。
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite } from '../../utils/fs-utils.js'
import { getSettingsPath } from './pi-paths.js'

/**
 * settings.json 的路径。生产用 getSettingsPath()（= ~/.xyz-agent/pi/agent/settings.json）。
 * 测试可经 setSettingsPath() 指向临时目录——这样 model 域与 extension 域在测试中也指向同一文件，
 * 保持「单一所有者」特性。
 */
let settingsFilePath: string = getSettingsPath()

/**
 * 覆盖 settings.json 路径（仅测试用）。生产不应调用。
 * 调用后自动失效缓存，确保后续读拿到新路径的文件。
 */
export function setSettingsPath(path: string): void {
  settingsFilePath = path
  invalidateSettingsCache()
}

/** 当前 settings.json 路径（getSettingsPath() 或测试覆盖值）。 */
export function getActiveSettingsPath(): string {
  return settingsFilePath
}

/**
 * settings.json 的完整 schema（pi 认的形状）。
 * model 域与 extension 域的字段都在这里，分区靠「调用方只改自己的 key」约定 + update() 的 mutator 范围。
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

// ── 缓存 ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 3_000

interface CacheEntry<T> {
  data: T
  timestamp: number
}

let settingsCache: CacheEntry<PiSettings> | null = null

function isExpired(entry: { timestamp: number } | null): boolean {
  return !entry || Date.now() - entry.timestamp > CACHE_TTL_MS
}

/** 失效缓存（外部改了文件后调用，或写后立即生效）。 */
export function invalidateSettingsCache(): void {
  settingsCache = null
}

// ── 原子读写（settings.json 唯一的文件接触点）────────────────

const JSON_INDENT = 2

function readSettingsFromDisk(): PiSettings {
  try {
    const raw = readFileSync(settingsFilePath, 'utf-8')
    return JSON.parse(raw) as PiSettings
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[pi-settings-store] 读取 ${settingsFilePath} 失败:`, err)
    }
    return {}
  }
}

function writeSettingsToDisk(settings: PiSettings): void {
  const dir = dirname(settingsFilePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(settings, null, JSON_INDENT) + '\n'
  atomicWrite(settingsFilePath, json)
}

/**
 * 读取 settings.json（带 3s 缓存）。
 * 模块外的「读」统一经此函数；缓存让高频读（getDefaultModel 等）不每次触盘。
 */
export function readSettings(): PiSettings {
  if (!isExpired(settingsCache)) return settingsCache!.data
  const data = readSettingsFromDisk()
  if (!data || typeof data !== 'object') {
    console.warn(`[pi-settings-store] ${settingsFilePath} schema 不匹配，使用 fallback`)
    return {}
  }
  settingsCache = { data, timestamp: Date.now() }
  return data
}

/**
 * 写入 settings.json（全量覆盖，刷新缓存）。
 * 仅在持有 update 锁的内部路径调用；外部请用 update() 做 RMW。
 */
export function writeSettings(settings: PiSettings): void {
  writeSettingsToDisk(settings)
  settingsCache = { data: JSON.parse(JSON.stringify(settings)), timestamp: Date.now() }
}

// ── 异步互斥的 RMW ───────────────────────────────────────────

/**
 * RMW 操作队列。所有「读 → 改 → 写」经此串行，async 调用之间不会交错，
 * 杜绝 extension async install 与 model 同步写在 settings.json 上的跨域竞态。
 *
 * 实现要点：写后立即失效缓存并立刻重读，确保链式 update 拿到最新值（而非过期的缓存副本）。
 */
let updateChain: Promise<unknown> = Promise.resolve()

/**
 * 原子的 read-modify-write。
 *
 * @param mutator 接收当前 settings 的深拷贝，原地修改自己负责的字段后返回（void 即可，回写拷贝）。
 *   - model 域只改 defaultModel/enabledModels/skills/...
 *   - extension 域只改 packages[]
 *   分区靠调用方自觉（每个域的封装函数只动自己的 key），物理同文件、逻辑分区。
 * @returns 一个 Promise，resolve 时写入已落盘。
 *
 * 用法：
 *   await updateSettings(s => { s.packages = [...s.packages ?? [], src] })
 */
export function updateSettings(mutator: (settings: PiSettings) => void): Promise<void> {
  const run = (): Promise<void> => {
    // 写后失效缓存：上一轮 update 写盘后，这里要拿到最新的（而非 3s 内的缓存）。
    invalidateSettingsCache()
    const draft: PiSettings = JSON.parse(JSON.stringify(readSettings()))
    mutator(draft)
    writeSettings(draft)
    return Promise.resolve()
  }
  // 串行：每次接到链尾，保证 RMW 不交错。
  const next = updateChain.then(run, run)
  // 不让单次失败永久毒化链：失败也复位为 resolved，后续 update 可继续。
  updateChain = next.catch(() => undefined)
  return next
}

/**
 * 同步 RMW（用于 model 域现有的同步封装函数：setDefaultModel 等）。
 *
 * Node 单线程 + 同步 IO，同步 RMW 内部天然无交错；但与 async 的 updateSettings 之间，
 * 靠 updateChain 队列的 microtask 调度保证不交错——同步调用发生时，要么在某个 async update 的
 * run() 之前、要么在其之后，不会在其 await 间隙（run 本身是同步函数，无内部 await）。
 */
export function updateSettingsSync(mutator: (settings: PiSettings) => void): void {
  invalidateSettingsCache()
  const draft: PiSettings = JSON.parse(JSON.stringify(readSettings()))
  mutator(draft)
  writeSettings(draft)
}
