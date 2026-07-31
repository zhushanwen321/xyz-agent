/**
 * 升级设置存储读写 SSOT（Single Source Of Truth）。
 *
 * 持久化用户对升级行为的偏好设置，当前含「预下载开关」：
 * 开启后检测到新版时自动在后台下载安装包，用户点击更新时跳过下载等待直接进入替换重启。
 *
 * 仿 proxy-config.ts 的 SSOT 模式：本模块只依赖 @xyz-agent/shared + node:fs/node:path，
 * 不静态依赖 electron，gateway 层（update-handlers）调用。
 *
 * 落盘位置：<UPDATE_DIR>/update-settings.json（与升级产物同目录，便于统一清理）。
 *
 * 依赖方向：update-settings → constants + @xyz-agent/shared + node:fs/path
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { UpdateSettings } from '@xyz-agent/shared'
import { UPDATE_SETTINGS_FILE } from './constants.js'

/**
 * 升级设置默认值。
 *
 * preDownload 默认 false：新用户不自动消耗流量/磁盘，需主动到设置页开启。
 */
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  preDownload: false,
}

/**
 * 读取升级设置。
 *
 * 容错策略：文件不存在 / JSON 解析失败 / 字段缺失 → 返回默认值（不阻断升级流程）。
 * 逐字段校验类型，确保未知/损坏的字段不污染返回值。
 */
export function getUpdateSettings(): UpdateSettings {
  if (!existsSync(UPDATE_SETTINGS_FILE)) {
    return { ...DEFAULT_UPDATE_SETTINGS }
  }

  let raw: string
  try {
    raw = readFileSync(UPDATE_SETTINGS_FILE, 'utf-8')
  } catch (err) {
    console.warn('[update-settings] read failed, using defaults:', err)
    return { ...DEFAULT_UPDATE_SETTINGS }
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    console.warn('[update-settings] parse failed, using defaults:', err)
    return { ...DEFAULT_UPDATE_SETTINGS }
  }

  // 逐字段校验，缺失/类型错误的字段回退默认值
  const settings: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (typeof obj.preDownload === 'boolean') {
      settings.preDownload = obj.preDownload
    }
  }
  return settings
}

/**
 * 写入升级设置。
 *
 * 自动 mkdirSync 父目录（recursive）。best-effort：写入失败抛错由调用方决定容错
 * （gateway 层 IPC handler 已有 try/catch 包裹）。
 */
export function setUpdateSettings(settings: UpdateSettings): void {
  mkdirSync(path.dirname(UPDATE_SETTINGS_FILE), { recursive: true })
  // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
  writeFileSync(UPDATE_SETTINGS_FILE, JSON.stringify(settings, null, 2))
}
