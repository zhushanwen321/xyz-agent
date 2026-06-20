/**
 * PiExtensionSettings — IExtensionSettings port 的 infra 实现。
 *
 * 实现 settings.json packages[]（经 pi-settings-store 统一读写层）+
 * disabled-packages.json（xyz-agent 自己的文件，独立原子读写）。
 *
 * 🔒 settings.json 的 RMW 经 pi-settings-store.updateSettingsSync（sync，单线程不交错），
 * 与 model 域（pi-provider-store）共享同一读写层，杜绝跨域竞态（D17）。
 *
 * P0-1：disabled-packages.json 的读写收敛到 JsonStore（shouldDeleteWhen 实现空则删）。
 */

import { join } from 'node:path'
import { JsonStore } from '../../utils/json-store.js'
import type { IExtensionSettings } from '../../services/ports/extension-settings.js'
import { updateSettingsSync, readSettings, invalidateSettingsCache, setSettingsPath } from './pi-settings-store.js'
import { getPiAgentDir } from './pi-paths.js'

const DISABLED_FILE = 'disabled-packages.json'

type DisabledRecord = { disabled: string[] }

/**
 * disabled-packages.json 存储：read-through（ENOENT 容错）+ atomicWrite。
 * 空数组时删文件（shouldDeleteWhen），与原 writeDisabledArray 行为一致。
 * 不带 TTL 缓存（调用频率低：仅 scanExtensions / toggle，每次触盘与原行为一致）。
 */
function createDisabledStore(path: string): JsonStore<DisabledRecord> {
  return new JsonStore<DisabledRecord>(path, { disabled: [] }, {
    ttlMs: 0,
    shouldDeleteWhen: (v) => v.disabled.length === 0,
  })
}

/**
 * IExtensionSettings 实现。
 * @param settingsDir pi agent 配置目录（~/.xyz-agent/pi/agent），settings.json + disabled-packages.json 所在地。
 *                    测试可注入临时目录；生产默认 getPiAgentDir()。
 */
export class PiExtensionSettings implements IExtensionSettings {
  private readonly settingsDir: string
  private readonly disabledStore: JsonStore<DisabledRecord>

  constructor(settingsDir: string = getPiAgentDir()) {
    this.settingsDir = settingsDir
    this.disabledStore = createDisabledStore(join(settingsDir, DISABLED_FILE))
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
    return this.disabledStore.read().disabled
  }

  async setEnabled(source: string, enabled: boolean): Promise<void> {
    const current = this.disabledStore.read().disabled
    let next: string[]
    if (enabled) {
      next = current.filter(d => d !== source)
    } else {
      next = current.includes(source) ? current : [...current, source]
    }
    this.disabledStore.write({ disabled: next })
  }

  async removeDisabled(source: string): Promise<void> {
    const next = this.disabledStore.read().disabled.filter(d => d !== source)
    this.disabledStore.write({ disabled: next })
  }
}
