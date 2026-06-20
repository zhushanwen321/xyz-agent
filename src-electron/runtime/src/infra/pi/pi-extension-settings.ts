/**
 * PiExtensionSettings — IExtensionSettings port 的 infra 实现。
 *
 * 实现 settings.json packages[]（经 pi-settings-store 统一读写层）+
 * disabled-packages.json（xyz-agent 自己的文件，独立原子读写）。
 *
 * 🔒 settings.json 的 RMW 经 pi-settings-store.updateSettingsSync（sync，单线程不交错），
 * 与 model 域（pi-provider-store）共享同一读写层，杜绝跨域竞态（D17）。
 */

import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { atomicWrite } from '../../utils/fs-utils.js'
import { dirname, join } from 'node:path'
import type { IExtensionSettings } from '../../services/ports/extension-settings.js'
import { updateSettingsSync, readSettings, invalidateSettingsCache, setSettingsPath } from './pi-settings-store.js'
import { getPiAgentDir } from './pi-paths.js'
import { toErrorMessage } from '../../utils/errors.js'

const INDENT_SPACES = 2
const DISABLED_FILE = 'disabled-packages.json'

const log = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  debug: (..._args: unknown[]) => { /* no-op in production */ },
  warn: (...args: unknown[]) => console.warn('[pi-extension-settings]', ...args),
}

/**
 * 读 disabled-packages.json，返回 disabled 数组。文件不存在/解析失败返回 []。
 * 纯同步读，无缓存（调用频率低：仅 scanExtensions / toggle）。
 */
function readDisabledArray(disabledPath: string): string[] {
  if (!existsSync(disabledPath)) return []
  try {
    const raw = readFileSync(disabledPath, 'utf-8')
    return (JSON.parse(raw) as { disabled?: string[] }).disabled ?? []
  } catch (e) {
    log.warn(`failed to parse ${disabledPath}: ${toErrorMessage(e)}`)
    return []
  }
}

/** 原子写 disabled-packages.json（tmp + rename）。空数组则删文件。 */
function writeDisabledArray(disabledPath: string, disabled: string[]): void {
  if (disabled.length > 0) {
    const dir = dirname(disabledPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    atomicWrite(disabledPath, JSON.stringify({ disabled }, null, INDENT_SPACES))
  } else if (existsSync(disabledPath)) {
    try {
      rmSync(disabledPath)
    } catch (e) {
      log.warn(`failed to remove ${disabledPath}: ${toErrorMessage(e)}`)
    }
  }
}

/**
 * IExtensionSettings 实现。
 * @param settingsDir pi agent 配置目录（~/.xyz-agent/pi/agent），settings.json + disabled-packages.json 所在地。
 *                    测试可注入临时目录；生产默认 getPiAgentDir()。
 */
export class PiExtensionSettings implements IExtensionSettings {
  private readonly settingsDir: string
  private readonly disabledPath: string

  constructor(settingsDir: string = getPiAgentDir()) {
    this.settingsDir = settingsDir
    this.disabledPath = join(settingsDir, DISABLED_FILE)
    // 让 pi-settings-store 指向同一 settingsDir 的 settings.json，保证 model 域与
    // extension 域在测试（注入临时目录）和生产（getPiAgentDir）都读写同一文件（D17 单一所有者）。
    setSettingsPath(join(settingsDir, 'settings.json'))
  }

  // ── settings.json packages[] ──

  getPackages(): string[] {
    // 经 pi-settings-store 读（带缓存）。注意：读的是 settings.json，不是 disabled。
    // readSettings 来自 pi-settings-store，路径固定为 getSettingsPath()——测试需把 settingsDir
    // 的 settings.json 放到对应位置（与原 ExtensionService 行为一致，原代码也读 getPiAgentDir()）。
    invalidateSettingsCache()
    const settings = readSettings()
    return settings.packages ?? []
  }

  async addPackage(source: string): Promise<void> {
    // sync RMW（Node 单线程 + sync IO 天然不交错）。签名保持 async 守 IExtensionSettings port 契约。
    updateSettingsSync(s => {
      const packages = s.packages ?? []
      if (!packages.includes(source)) {
        packages.push(source)
        s.packages = packages
      }
    })
  }

  async removePackage(source: string): Promise<void> {
    updateSettingsSync(s => {
      const packages = (s.packages ?? []).filter(p => p !== source)
      s.packages = packages
    })
  }

  // ── disabled-packages.json ──

  getDisabled(): string[] {
    return readDisabledArray(this.disabledPath)
  }

  async setEnabled(source: string, enabled: boolean): Promise<void> {
    const disabled = readDisabledArray(this.disabledPath)
    let next: string[]
    if (enabled) {
      next = disabled.filter(d => d !== source)
    } else {
      next = disabled.includes(source) ? disabled : [...disabled, source]
    }
    writeDisabledArray(this.disabledPath, next)
  }

  async removeDisabled(source: string): Promise<void> {
    const disabled = readDisabledArray(this.disabledPath).filter(d => d !== source)
    writeDisabledArray(this.disabledPath, disabled)
  }
}
