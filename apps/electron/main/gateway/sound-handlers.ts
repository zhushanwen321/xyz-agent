/**
 * 系统提示音 IPC handler（mac afplay / win wav 返 base64 / linux paplay）。
 *
 * 跨平台播放系统原生提示音。sandbox renderer 不能 fs 读系统声音目录，也播不了
 * macOS .aiff（Chromium 不支持），故全部下沉到 main 进程处理。
 *
 * 平台分发：
 * - darwin：spawn `afplay /System/Library/Sounds/<name>.aiff`（fire-and-forget，unref）
 * - win32：读 `C:\Windows\Media\<name>.wav` 为 base64 返回，renderer 用 `new Audio()` 播
 * - linux：spawn `paplay` / `pw-play` / `aplay`（探测存在性，按优先级 fallback）
 *
 * 安全：
 * - sound:play 的 name 必须在当前平台精选清单内（防借道 spawn 任意命令 / 读任意文件）
 * - 清单是模块级常量，不读用户输入构造路径
 *
 * 失败语义：播放失败 console.error 后 resolve（不 throw）——提示音失败不该打断对话流。
 */
import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

// ── 平台声音清单（精选，语义适合「完成提示」）──

/** macOS 系统声音根目录（Big Sur → Sequoia 稳定） */
const MAC_SOUND_DIR = '/System/Library/Sounds'
/** macOS 精选声音 id（= 文件名去 .aiff 后缀）。names 取系统原生名不翻译 */
const MAC_SOUNDS = [
  'Glass', 'Hero', 'Ping', 'Pop', 'Purr', 'Submarine', 'Morse', 'Funk',
] as const

/** Windows 系统声音目录（Win10/11，经典 tada/chimes 默认已移除，靠 existsSync 过滤） */
const WIN_SOUND_DIR = 'C:\\Windows\\Media';
/** Windows 精选声音 id（= 文件名去 .wav 后缀） */
const WIN_SOUNDS = [
  'Windows Notify System Generic',
  'Windows Notify Email',
  'Windows Notify Messaging',
  'Windows Background',
  'Windows Foreground',
  'chimes',
] as const

/** Linux freedesktop sound-theme 目录（需装 sound-theme-freedesktop） */
const LINUX_SOUND_DIR = '/usr/share/sounds/freedesktop/stereo';
/** Linux 精选声音 id（= 文件名去 .oga 后缀） */
const LINUX_SOUNDS = [
  'complete', 'message-new-instant', 'service-login', 'bell', 'window-attention', 'message',
] as const

/** 各平台默认成功音 id（用户未设置 successSound 时用） */
const DEFAULT_SUCCESS: Record<string, string> = {
  darwin: 'Glass',
  win32: 'Windows Notify System Generic',
  linux: 'complete',
}
/** 各平台默认失败音 id */
const DEFAULT_ERROR: Record<string, string> = {
  darwin: 'Funk',
  win32: 'Windows Notify Email',
  linux: 'message-new-instant',
}

/** SoundInfo：id=播放用标识，name=显示名（不翻译，用系统原生名） */
export interface SoundInfo {
  id: string
  name: string
}

/** sound:list 返回类型 */
export interface SoundListResult {
  platform: string
  sounds: SoundInfo[]
}

/** sound:play 返回类型。win 有 audioData（base64）让 renderer 播，mac/linux 空对象 */
export interface SoundPlayResult {
  audioData?: string
  mimeType?: string
}

// ── 命令存在性探测（Linux 播放器 fallback 用）──

/**
 * 探测命令是否在 PATH（用 `command -v`，POSIX 通用）。
 * 同步包装：spawnSync 比 spawn 更适合「探测」，且只跑一次结果可缓存。
 */
function commandExists(cmd: string): boolean {
  try {
    const r = spawnSync('command', ['-v', cmd], { shell: true, stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

/** Linux 播放器命令缓存（首次探测后记住，避免每次播放都 spawnSync） */
let linuxPlayerCmd: string | null | undefined

/** 返回可用的 Linux 播放器命令（paplay / pw-play / aplay 优先级），全部缺失返回 null */
function getLinuxPlayer(): string | null {
  if (linuxPlayerCmd !== undefined) return linuxPlayerCmd
  for (const cmd of ['paplay', 'pw-play', 'aplay']) {
    if (commandExists(cmd)) {
      linuxPlayerCmd = cmd
      return cmd
    }
  }
  linuxPlayerCmd = null
  return null
}

// ── 按平台列举可用声音（existsSync 过滤当前机器实际存在的）──

function listMacSounds(): SoundInfo[] {
  return MAC_SOUNDS
    .filter((id) => existsSync(join(MAC_SOUND_DIR, `${id}.aiff`)))
    .map((id) => ({ id, name: id }))
}

function listWinSounds(): SoundInfo[] {
  return WIN_SOUNDS
    .filter((id) => existsSync(join(WIN_SOUND_DIR, `${id}.wav`)))
    .map((id) => ({ id, name: id }))
}

function listLinuxSounds(): SoundInfo[] {
  return LINUX_SOUNDS
    .filter((id) => existsSync(join(LINUX_SOUND_DIR, `${id}.oga`)))
    .map((id) => ({ id, name: id }))
}

/** 按当前平台列举可用声音 */
function listForPlatform(platform: string): SoundListResult {
  switch (platform) {
    case 'darwin': return { platform, sounds: listMacSounds() }
    case 'win32': return { platform, sounds: listWinSounds() }
    case 'linux': return { platform, sounds: listLinuxSounds() }
    default: return { platform, sounds: [] }
  }
}

// ── 按平台播放 ──

/** 各平台精选清单查表（用于 isKnownSound 校验） */
const SOUND_LIST_BY_PLATFORM: Record<string, readonly string[]> = {
  darwin: MAC_SOUNDS,
  win32: WIN_SOUNDS,
  linux: LINUX_SOUNDS,
}

/** 校验 name 在当前平台精选清单内（防借道） */
function isKnownSound(name: string, platform: string): boolean {
  const known = SOUND_LIST_BY_PLATFORM[platform] ?? []
  return known.includes(name)
}

/**
 * macOS 播放：spawn afplay（fire-and-forget，unref 不阻塞主进程退出）。
 * afplay 是用户态命令，无沙箱限制，自己管理播放时长。
 */
function playMac(name: string): void {
  const path = join(MAC_SOUND_DIR, `${name}.aiff`)
  const child = spawn('afplay', [path], { stdio: 'ignore', detached: true })
  child.on('error', (err) => console.error('[sound] afplay failed:', err))
  child.unref()
}

/**
 * Linux 播放：探测 paplay/pw-play/aplay，spawn 后 unref。
 * 无可用播放器时静默 no-op（不抛错，提示音失败不该打断对话流）。
 */
function playLinux(name: string): void {
  const cmd = getLinuxPlayer()
  if (!cmd) return
  const path = join(LINUX_SOUND_DIR, `${name}.oga`)
  const child = spawn(cmd, [path], { stdio: 'ignore', detached: true })
  child.on('error', (err) => console.error(`[sound] ${cmd} failed:`, err))
  child.unref()
}

/**
 * Windows 播放：读 wav 为 base64 返回，由 renderer 用 new Audio() 播。
 * 不 spawn（PowerShell 重），wav 是 Chromium 原生支持格式。
 * 文件不存在时返回空对象（renderer 静默 no-op）。
 */
function playWin(name: string): SoundPlayResult {
  const path = join(WIN_SOUND_DIR, `${name}.wav`)
  if (!existsSync(path)) return {}
  try {
    const buf = readFileSync(path)
    return { audioData: buf.toString('base64'), mimeType: 'audio/wav' }
  } catch (err) {
    console.error('[sound] read wav failed:', err)
    return {}
  }
}

/**
 * 注册系统提示音 IPC handler。
 *
 * - sound:list：返回当前平台可用声音清单（existsSync 过滤）
 * - sound:play：按平台分发播放。name 必须在精选清单内，否则 resolve 空结果（防借道）
 */
export function registerSoundHandlers(): void {
  ipcMain.handle('sound:list', (): SoundListResult => {
    return listForPlatform(process.platform)
  })

  ipcMain.handle('sound:play', (_event, name: string): SoundPlayResult => {
    // 安全校验：name 必须在当前平台精选清单内（防借道 spawn/read 任意路径）
    if (!name || !isKnownSound(name, process.platform)) {
      console.warn('[sound] unknown sound name, ignored:', name)
      return {}
    }
    try {
      switch (process.platform) {
        case 'darwin':
          playMac(name)
          return {}
        case 'linux':
          playLinux(name)
          return {}
        case 'win32':
          return playWin(name)
        default:
          return {}
      }
    } catch (err) {
      // 播放失败不抛错：提示音是锦上添花，不该让对话流卡住
      console.error('[sound] play failed:', err)
      return {}
    }
  })
}

/** 导出默认声音映射（renderer 查询平台默认用，避免重复定义） */
export function getDefaultSound(platform: string, kind: 'success' | 'error'): string {
  return kind === 'success'
    ? (DEFAULT_SUCCESS[platform] ?? '')
    : (DEFAULT_ERROR[platform] ?? '')
}
