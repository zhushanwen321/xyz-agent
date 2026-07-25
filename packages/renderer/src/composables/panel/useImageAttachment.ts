/**
 * 图片粘贴附件处理（Cmd+V/Ctrl+V 双通路共用）。
 *
 * 职责单一：把剪贴板 image blob 转成 base64，经 writeTmpImage IPC 落地到 OS tmpdir，
 * 返回联合结果（badge / text 降级 / noop）由调用方（useContenteditableInput.onPaste）
 * 决定如何写入 DOM——本 composable 不碰 DOM。
 *
 * 降级矩阵（C3 契约）：
 * - metaKey=false（Ctrl+V 路径文本通路）→ {kind:'noop'}，onPaste 自行插字面路径文本
 * - base64 读取失败（FileReader.onerror）→ {kind:'text', text:'[图片读取失败]'}
 * - 非 electron 环境（writeTmpImage 返回 undefined）→ {kind:'text', text:'[图片粘贴：需桌面环境]'}
 * - IPC 写入失败（throw）→ {kind:'text', text:'[图片粘贴失败]'}
 * - 成功 → {kind:'badge', path, name}，onPaste 调 insertImageBadge(path, name)
 *
 * 依赖方向：useImageAttachment → lib/ipc（唯一 electronAPI 适配点）
 */
import { writeTmpImage } from '@/lib/ipc'

/** handleImagePaste 返回联合类型（C3 契约） */
export type HandleImagePasteResult =
  | { kind: 'badge'; path: string; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'noop' }

/** File → base64（分块 btoa 防 stack 溢出，大图直接 btoa 二进制串会爆栈）。 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const buf = reader.result
      if (!(buf instanceof ArrayBuffer)) {
        reject(new Error('FileReader did not return ArrayBuffer'))
        return
      }
      const bytes = new Uint8Array(buf)
      // 二进制字符串分块 btoa：每块 0x8000 字节（btoa 单次安全上限经验值），避免大图爆栈
      let binary = ''
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
      }
      resolve(btoa(binary))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * 处理剪贴板图片粘贴。
 *
 * @param blob 剪贴板取出的 image File（clipboardData.items[i].getAsFile()）
 * @param opts.metaKey Cmd 富呈现（true）/ Ctrl 路径文本（false）通路区分
 * @returns 联合结果，调用方按 kind 决定写 badge / 降级文本 / noop
 */
export async function handleImagePaste(
  blob: File,
  opts: { metaKey: boolean },
): Promise<HandleImagePasteResult> {
  // Ctrl+V（非 metaKey）走路径文本通路：本 composable 不处理，onPaste 自行插字面路径
  if (!opts.metaKey) return { kind: 'noop' }

  let base64: string
  try {
    base64 = await fileToBase64(blob)
  } catch {
    return { kind: 'text', text: '[图片读取失败]' }
  }

  let result: { path: string; name: string } | undefined
  try {
    result = await writeTmpImage({
      base64,
      mimeType: blob.type,
      suggestedName: blob.name || undefined,
    })
  } catch {
    // IPC 写入失败（磁盘满 / 权限 / 主进程 throw）→ 降级文本提示
    return { kind: 'text', text: '[图片粘贴失败]' }
  }
  // 非 electron 环境（web/mock）：writeTmpImage 返回 undefined → 降级文本提示
  if (!result) return { kind: 'text', text: '[图片粘贴：需桌面环境]' }
  return { kind: 'badge', path: result.path, name: result.name }
}

/** composable 入口（保留 useXxx 范式，当前无实例状态，纯函数导出便于未来扩展） */
export function useImageAttachment() {
  return { handleImagePaste }
}
