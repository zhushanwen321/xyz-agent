/**
 * 升级设置存储 SSOT（update-settings）单元测试。
 *
 * 覆盖 update-settings.ts 全部导出：
 *   1. 无文件时 getUpdateSettings 返回默认值 { preDownload: false }
 *   2. setUpdateSettings 后 getUpdateSettings 读回
 *   3. 损坏 JSON 时 getUpdateSettings 降级默认值
 *
 * Mock 策略参考 pending-update.test.ts：用真实 fs（临时目录），经
 * XYZ_AGENT_DATA_DIR 重定向 UPDATE_SETTINGS_FILE（必须在 import constants 前设，
 * constants.ts 顶层读 getDataDir）。env 设好后动态 import 模块拿独立实例。
 *
 * 运行：cd apps/electron/main && npx vitest run test/update-settings.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { UpdateSettings } from '@xyz-agent/shared'

// ── 必须在 import constants（间接被 update-settings import）前设 ──────
// constants.ts 顶层计算 UPDATE_SETTINGS_FILE = path.join(getDataDir(), 'update', ...),
// getDataDir 读 XYZ_AGENT_DATA_DIR。赋值放最前，下方模块经动态 import 在 env 就绪后加载。
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'update-settings-'))
process.env.XYZ_AGENT_DATA_DIR = TMP_DATA_DIR

interface UpdateSettingsModule {
  getUpdateSettings: () => UpdateSettings
  setUpdateSettings: (settings: Partial<UpdateSettings>) => void
  DEFAULT_UPDATE_SETTINGS: UpdateSettings
}

// 动态 import：确保 env 赋值先生效
async function loadModule(): Promise<UpdateSettingsModule> {
  return await import('../update/update-settings.js')
}

/** update-settings.json 落盘路径（与 constants.ts 推导一致） */
const UPDATE_SETTINGS_FILE = path.join(TMP_DATA_DIR, 'update', 'update-settings.json')

describe('update-settings (升级设置存储 SSOT)', () => {
  let mod: UpdateSettingsModule

  beforeEach(async () => {
    mod = await loadModule()
    // 每个用例独立：清掉残留的 update-settings.json
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  afterEach(() => {
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  // ── 1. 无文件时 getUpdateSettings 返回默认值 ────────────────────
  it('getUpdateSettings：无文件时返回默认值 { preDownload: false, autoUpdate: false }', () => {
    expect(existsSync(UPDATE_SETTINGS_FILE)).toBe(false)
    const settings = mod.getUpdateSettings()
    expect(settings).toEqual({ preDownload: false, autoUpdate: false })
    // 默认值常量与本模块导出一致
    expect(settings).toEqual(mod.DEFAULT_UPDATE_SETTINGS)
    // 返回的是副本，修改不影响默认常量
    settings.preDownload = true
    expect(mod.DEFAULT_UPDATE_SETTINGS.preDownload).toBe(false)
  })

  // ── 2. setUpdateSettings 后 getUpdateSettings 读回 ──────────────
  it('setUpdateSettings：写入后 getUpdateSettings 读回相同值', () => {
    mod.setUpdateSettings({ preDownload: true })
    // 文件确实写到了 UPDATE_SETTINGS_FILE
    expect(existsSync(UPDATE_SETTINGS_FILE)).toBe(true)

    const settings = mod.getUpdateSettings()
    expect(settings).toEqual({ preDownload: true, autoUpdate: false })
    expect(settings.preDownload).toBe(true)
  })

  it('setUpdateSettings：写入 false 后 getUpdateSettings 读回 false', () => {
    // 先写 true 再写 false，验证覆盖而非追加
    mod.setUpdateSettings({ preDownload: true })
    mod.setUpdateSettings({ preDownload: false })

    const raw = readFileSync(UPDATE_SETTINGS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as UpdateSettings
    expect(parsed.preDownload).toBe(false)

    expect(mod.getUpdateSettings()).toEqual({ preDownload: false, autoUpdate: false })
  })

  // ── 2.5 autoUpdate：局部更新合并语义（不覆盖其他开关） ──────────────
  it('setUpdateSettings：仅传 { autoUpdate: true } 读回 autoUpdate true 且 preDownload 保持默认', () => {
    mod.setUpdateSettings({ autoUpdate: true })
    expect(mod.getUpdateSettings()).toEqual({ preDownload: false, autoUpdate: true })
  })

  it('setUpdateSettings：局部更新合并——先后写 preDownload 与 autoUpdate 互不覆盖', () => {
    mod.setUpdateSettings({ preDownload: true })
    mod.setUpdateSettings({ autoUpdate: true })
    expect(mod.getUpdateSettings()).toEqual({ preDownload: true, autoUpdate: true })
    // 反向顺序同样成立
    mod.setUpdateSettings({ autoUpdate: false })
    expect(mod.getUpdateSettings()).toEqual({ preDownload: true, autoUpdate: false })
  })

  // ── 3. 损坏 JSON 时 getUpdateSettings 降级默认值 ────────────────
  it('getUpdateSettings：文件损坏（非法 JSON）→ 降级返回默认值，不抛错', () => {
    const dir = path.dirname(UPDATE_SETTINGS_FILE)
    mkdirSync(dir, { recursive: true })
    writeFileSync(UPDATE_SETTINGS_FILE, 'this is not valid json {{{', 'utf-8')
    expect(existsSync(UPDATE_SETTINGS_FILE)).toBe(true)

    const settings = mod.getUpdateSettings()
    expect(settings).toEqual({ preDownload: false, autoUpdate: false })
    // 注意：损坏时不自动清除文件（与 pending-update 不同），但下次读仍降级默认值
    expect(() => mod.getUpdateSettings()).not.toThrow()
  })

  it('getUpdateSettings：preDownload 字段类型错误（非 boolean）→ 降级默认值', () => {
    const dir = path.dirname(UPDATE_SETTINGS_FILE)
    mkdirSync(dir, { recursive: true })
    // preDownload 写成字符串，逐字段校验应回退默认值
    writeFileSync(UPDATE_SETTINGS_FILE, JSON.stringify({ preDownload: 'yes' }), 'utf-8')

    const settings = mod.getUpdateSettings()
    expect(settings.preDownload).toBe(false)
  })

  it('getUpdateSettings：autoUpdate 字段类型错误（非 boolean）→ 降级默认值', () => {
    const dir = path.dirname(UPDATE_SETTINGS_FILE)
    mkdirSync(dir, { recursive: true })
    // autoUpdate 写成字符串，逐字段校验应回退默认值
    writeFileSync(UPDATE_SETTINGS_FILE, JSON.stringify({ preDownload: true, autoUpdate: 'yes' }), 'utf-8')

    const settings = mod.getUpdateSettings()
    expect(settings.preDownload).toBe(true)
    expect(settings.autoUpdate).toBe(false)
  })
})
