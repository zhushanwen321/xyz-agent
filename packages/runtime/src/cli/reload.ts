/**
 * Reload 编排：检查 session 状态，空闲时触发 reload。
 * 高危写操作（set-provider / set-skill-dirs / delete-provider）后需要 reload 生效。
 */
import { rpc } from './ws-client.js'

export interface ReloadResult {
  reloaded: boolean
  message: string
}

/**
 * 尝试 reload：检查 session 是否空闲，空闲则发 reload RPC。
 * @returns { reloaded, message }
 */
export async function attemptReload(): Promise<ReloadResult> {
  try {
    // 检查是否有 session 正在生成
    const state = await rpc<{ isGenerating?: boolean }>('session.getState', {})
    if (state.isGenerating) {
      return {
        reloaded: false,
        message: 'Session is busy (generating). Config persisted, will apply when session is idle.',
      }
    }

    // 空闲，触发 reload
    await rpc('session.reload', {})
    return {
      reloaded: true,
      message: 'Config reloaded successfully.',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      reloaded: false,
      message: `Reload failed: ${msg}`,
    }
  }
}
