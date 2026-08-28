/**
 * 升级设置存储读写 SSOT（Single Source Of Truth）。
 *
 * 持久化用户对升级行为的偏好设置，当前含「预下载开关」与「自动更新开关」：
 * - preDownload：检测到新版时自动在后台下载安装包，用户点击更新时跳过下载等待直接进入替换重启
 * - autoUpdate：启动时自动检查更新并提示下载（v6 demo 语义）
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
 * autoUpdate 默认 true（2026-08-28 用户拍板，设计 §3.6 RM1）：存量用户现状即
 * 无条件自动检查（Sidebar.vue 无条件 initAutoCheck），若默认 false 则升级到本批次
 * 后存量用户的自动检查/升级提醒会静默消失，属行为倒退；默认 true 后须在 release
 * note 说明「自动检查现为可在设置中关闭」。
 */
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  preDownload: false,
  autoUpdate: true,
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
    if (typeof obj.autoUpdate === 'boolean') {
      settings.autoUpdate = obj.autoUpdate
    }
  }
  return settings
}

/**
 * 写入升级设置（局部更新语义）。
 *
 * 自动 mkdirSync 父目录（recursive）。best-effort：写入失败抛错由调用方决定容错
 * （gateway 层 IPC handler 已有 try/catch 包裹）。
 *
 * 合并语义：以现有设置（含默认值）为基底合并传入字段后整体写盘，
 * 调用方只传要修改的字段（如仅 { preDownload } 或仅 { autoUpdate }），不会覆盖其他开关的持久化值。
 */
export function setUpdateSettings(settings: Partial<UpdateSettings>): void {
  mkdirSync(path.dirname(UPDATE_SETTINGS_FILE), { recursive: true })
  // 合并写入：读现有设置做基底，局部更新不丢其他字段
  const merged: UpdateSettings = { ...getUpdateSettings(), ...settings }
  // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
  writeFileSync(UPDATE_SETTINGS_FILE, JSON.stringify(merged, null, 2))
}
