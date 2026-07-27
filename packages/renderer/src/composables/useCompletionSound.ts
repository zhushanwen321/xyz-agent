/**
 * useCompletionSound —— 系统原生提示音播放（经 main 进程 IPC）。
 *
 * 原实现是 Web Audio 合成（OscillatorNode），现改为调用各平台原生系统声音：
 * - macOS：afplay /System/Library/Sounds/<name>.aiff
 * - Windows：main 读 C:\Windows\Media\<name>.wav 返 base64，renderer new Audio() 播
 * - Linux：paplay / pw-play / aplay /usr/share/sounds/freedesktop/stereo/<name>.oga
 *
 * 为什么走 main 进程：
 * - sandbox renderer 不能 fs 读 /System/Library/Sounds
 * - Chromium 不支持 macOS .aiff 格式
 * - Linux .oga + file:// 沙箱受限
 *
 * 平台默认声音映射（与 main/sound-handlers.ts 的 DEFAULT_SUCCESS/ERROR 保持同步）：
 * 成功：mac=Glass / win=Windows Notify System Generic / linux=complete
 * 失败：mac=Funk  / win=Windows Notify Email           / linux=message-new-instant
 */
import { getDefaultSound } from './sound-defaults'
import { playSystemSound } from '@/lib/ipc'

/** playSystemSound 返回类型（win 返 wav base64，mac/linux 无） */
interface SoundPlayResult {
  audioData?: string
  mimeType?: string
}

/** 平台检测（main 进程 process.platform 同义） */
function detectPlatform(): 'darwin' | 'win32' | 'linux' | 'other' {
  if (typeof navigator === 'undefined') return 'other'
  const p = navigator.platform.toLowerCase()
  // navigator.platform: 'MacIntel' / 'Win32' / 'Linux x86_64' 等
  if (p.includes('mac')) return 'darwin'
  if (p.includes('win')) return 'win32'
  if (p.includes('linux')) return 'linux'
  return 'other'
}

/**
 * 按名字播放系统提示音。
 * name 为空或未知时，main 侧 resolve 空结果（静默 no-op）。
 * win 返回 audioData（base64）时，用 new Audio() 播 wav（Chromium 原生支持）。
 */
export async function playByName(name: string): Promise<void> {
  // 经 lib/ipc 门面（B1）：web/mock 环境无 IPC 时 playSystemSound 返回空对象，下方 audioData 判空跳过。
  try {
    const result: SoundPlayResult = await playSystemSound(name)
    // win32 路径：main 返 wav base64，renderer 播
    if (result.audioData && result.mimeType) {
      const audio = new Audio(`data:${result.mimeType};base64,${result.audioData}`)
      void audio.play().catch(() => {
        // autoplay policy 拒绝时静默（后台完成场景，用户已交互过通常不会拒）
      })
    }
    // mac/linux 由 main spawn 播，此处无返回值
  } catch (err) {
    // 提示音失败不阻塞对话流
    console.error('[sound] playByName failed:', err)
  }
}

/**
 * 解析实际要播放的声音名：传入名优先，空则用平台默认。
 * 跨平台失效兜底也在此——若传入名在当前平台不存在，main 静默 no-op，
 * 但用户体验不佳；此处不做二次校验（main 侧 isKnownSound 已守门）。
 */
function resolveName(preferred: string | undefined, kind: 'success' | 'error'): string {
  if (preferred && preferred.trim()) return preferred
  return getDefaultSound(detectPlatform(), kind)
}

/**
 * 播放成功提示音。
 * @param soundName 用户设置的声音名（undefined 用平台默认）
 */
export async function playSuccess(soundName?: string): Promise<void> {
  await playByName(resolveName(soundName, 'success'))
}

/**
 * 播放失败提示音。
 * @param soundName 用户设置的声音名（undefined 用平台默认）
 */
export async function playError(soundName?: string): Promise<void> {
  await playByName(resolveName(soundName, 'error'))
}

/**
 * useCompletionSound composable（函数式封装，便于 vitest mock 整个模块）。
 * 返回 { playSuccess, playError }，与直接 import 同名函数等价。
 */
export function useCompletionSound() {
  return { playSuccess, playError }
}
