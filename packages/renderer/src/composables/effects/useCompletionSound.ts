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
 * 平台默认声音映射 SSOT 在 @xyz-agent/shared（sound-defaults.ts），
 * main 与 renderer 共享同一份（W4 去重）。
 */
import { getDefaultSound, detectPlatform } from '../sound-platform'
import { playSystemSound } from '@/lib/ipc'

/** playSystemSound 返回类型（win 返 wav base64，mac/linux 无） */
interface SoundPlayResult {
  audioData?: string
  mimeType?: string
}

/**
 * 按名字播放系统提示音。
 * name 为空或未知时，main 侧 resolve 空结果（静默 no-op）。
 * win 返回 audioData（base64）时，用 new Audio() 播 wav（Chromium 原生支持）。
 *
 * @param name 实际播放的声音名
 * @param kind 逻辑分类（成功/失败），用于 main 侧跨平台失效时回落到对应平台默认（W3）。
 *             试听场景（已知声音）可不传。
 *
 * 防抖责任：本函数不做防抖。完成提示音场景由调用方 useCompletionNotify 负责（1s 模块级
 * 防抖，handleCompletion）；试听场景由 SoundPreviewButton 的 previewingKey 防重入。
 * 若未来有新调用方，需自行决定是否在调用点防抖（mac/linux spawn 多次会叠加播放）。
 */
export async function playByName(name: string, kind?: 'success' | 'error'): Promise<void> {
  // 经 lib/ipc 门面（B1）：web/mock 环境无 IPC 时 playSystemSound 返回空对象，下方 audioData 判空跳过。
  try {
    const result: SoundPlayResult = await playSystemSound(name, kind)
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
 * 跨平台失效兜底由 main 侧处理（W3）：若传入名在当前平台不存在，main 回落到对应平台默认。
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
  await playByName(resolveName(soundName, 'success'), 'success')
}

/**
 * 播放失败提示音。
 * @param soundName 用户设置的声音名（undefined 用平台默认）
 */
export async function playError(soundName?: string): Promise<void> {
  await playByName(resolveName(soundName, 'error'), 'error')
}

/**
 * useCompletionSound composable（函数式封装，便于 vitest mock 整个模块）。
 * 返回 { playSuccess, playError }，与直接 import 同名函数等价。
 */
export function useCompletionSound() {
  return { playSuccess, playError }
}
