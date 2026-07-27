/**
 * 系统提示音默认映射（renderer 侧副本）。
 *
 * [HISTORICAL] SSOT 双写说明：
 * 真正的 SSOT 在 main 进程 `apps/electron/main/gateway/sound-handlers.ts` 的
 * DEFAULT_SUCCESS / DEFAULT_ERROR。但 renderer 不能 import main 模块（会把 electron
 * 拖进 renderer bundle），且 handleCompletion 是同步函数，不能 await main 的
 * listSystemSounds 拿默认值。故在 renderer 侧维护一份副本，**两份必须同步修改**。
 *
 * 修改检查：改任一处时 grep 另一处的对应平台 id 确认一致。
 */

/** 各平台默认成功音 id */
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

/**
 * 返回指定平台 + 类型（成功/失败）的默认声音 id。
 * 未知平台返回空串（main 侧 isKnownSound 会静默 no-op）。
 */
export function getDefaultSound(
  platform: 'darwin' | 'win32' | 'linux' | 'other',
  kind: 'success' | 'error',
): string {
  const map = kind === 'success' ? DEFAULT_SUCCESS : DEFAULT_ERROR
  return map[platform] ?? ''
}
