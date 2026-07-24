/**
 * useCompletionSound —— Web Audio 合成完成提示音。
 *
 * 无外部资源文件依赖，纯振荡器合成：
 * - 成功音：C5 (523Hz) 150ms 指数衰减
 * - 失败音：A3 (220Hz) 300ms 指数衰减，频率下滑增加紧迫感
 *
 * AudioContext lazy singleton + resume 处理 Electron autoplay 策略。
 */

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
  }
  return audioCtx
}

/**
 * 播放合成音效。内部处理 AudioContext resume（Electron autoplay 可能 suspended）。
 * @param frequency 振荡器频率 (Hz)
 * @param duration 持续时间 (秒)
 * @param type 振荡器波形
 * @param frequencyEnd 频率下滑终点（失败音用，给紧迫感）
 */
function playTone(frequency: number, duration: number, type: OscillatorType = 'sine', frequencyEnd?: number): void {
  const ctx = getAudioContext()

  // Electron autoplay policy: AudioContext 可能 suspended，需要 resume
  if (ctx.state === 'suspended') {
    void ctx.resume()
  }

  const oscillator = ctx.createOscillator()
  const gainNode = ctx.createGain()

  oscillator.type = type
  oscillator.frequency.setValueAtTime(frequency, ctx.currentTime)

  // 频率下滑（失败音的紧迫感）
  if (frequencyEnd !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(frequencyEnd, ctx.currentTime + duration)
  }

  // 音量包络：快速起 → 指数衰减
  gainNode.gain.setValueAtTime(0.3, ctx.currentTime)
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)

  oscillator.connect(gainNode)
  gainNode.connect(ctx.destination)

  oscillator.start(ctx.currentTime)
  oscillator.stop(ctx.currentTime + duration)
}

/** 播放成功提示音：C5 (523Hz) 150ms */
export function playSuccess(): void {
  playTone(523, 0.15, 'sine')
}

/** 播放失败提示音：A3 (220Hz) 300ms，频率下滑到 A2 (110Hz) */
export function playError(): void {
  playTone(220, 0.3, 'sawtooth', 110)
}

/**
 * useCompletionSound composable（函数式封装，方便测试 mock）。
 * 返回 { playSuccess, playError }，与直接 import 同名函数等价，
 * 但 composable 形式便于 vitest mock 整个模块。
 */
export function useCompletionSound() {
  return { playSuccess, playError }
}
