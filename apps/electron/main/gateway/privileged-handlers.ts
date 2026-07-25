/**
 * 特权 IPC handler（需 OS 能力）。
 *
 * 对应 spec §4.2 M4「特权 handler」：openExternal / pickDirectory。
 * 每个单独做输入校验（委托 input-validators）。
 *
 * [HISTORICAL] 不变量：
 * - openExternal 校验 http/https（isValidExternalUrl）
 * - pickDirectory 用 BrowserWindow.getFocusedWindow()（无聚焦窗口返回 canceled）
 * - pickFile 同范式：getFocusedWindow 降级 + defaultPath homedir 兜底 + try/catch 返回 canceled
 *
 * 依赖方向：privileged-handlers → electron(dialog/shell/BrowserWindow) + input-validators + interfaces
 */
import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomInt } from 'node:crypto'
import type { IpcHandlerDeps } from '../interfaces.js'
import { isValidExternalUrl } from './input-validators.js'

/**
 * 注册特权 IPC handler（open-external / pick-directory / pick-file / write-tmp-image）。
 *
 * @param deps 注入的依赖
 */
export function registerPrivilegedHandlers(deps: IpcHandlerDeps): void {
  void deps
  // open-external：校验 http/https 后交给系统浏览器
  ipcMain.handle('open-external', async (_event, url: string): Promise<boolean> => {
    // [HISTORICAL] 安全检查：只允许 http/https 协议（防 file:// / javascript: 等）
    if (!isValidExternalUrl(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch (err) {
      // openExternal 失败不致命，返回 false 让调用方降级
      console.error('[ipc] open-external failed:', err)
      return false
    }
  })

  // pick-directory：用聚焦窗口打开目录选择器（无聚焦窗口返回 canceled）
  // [W7] 风格对齐 open-external：dialog 抛异常时 console.error + 返回 {canceled:true, path:null}，
  // 而非依赖 ipcMain.handle 的 invoke rejection 兜底。降级目标对称：无聚焦窗口 / dialog 崩溃都返回 canceled。
  //
  // [HISTORICAL] defaultPath 兜底到 homedir：
  // 省略 defaultPath 时 macOS 原生目录选择器会用 OS 记忆的上次位置；若该位置已被删除，
  // Finder 会回退到 Documents（非预期，用户期望回退到 ~）。由渲染端传入候选 defaultPath
  //（通常是 currentCwd），主进程 existsSync 守卫——存在则用，否则降级 homedir。
  // 不能把"已删除目录"原样传给 dialog：否则又触发 OS 的 Documents 回退，丢失意义。
  ipcMain.handle(
    'pick-directory',
    async (_event, options?: { title?: string; defaultPath?: string }) => {
      const focusedWin = BrowserWindow.getFocusedWindow()
      if (!focusedWin) return { canceled: true, path: null }
      try {
        const fallbackPath =
          options?.defaultPath && existsSync(options.defaultPath)
            ? options.defaultPath
            : homedir()
        const result = await dialog.showOpenDialog(focusedWin, {
          properties: ['openDirectory'],
          title: options?.title ?? '选择项目目录',
          defaultPath: fallbackPath,
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { canceled: true, path: null }
        }
        return { canceled: false, path: result.filePaths[0] }
      } catch (err) {
        console.error('[ipc] pick-directory failed:', err)
        return { canceled: true, path: null }
      }
    },
  )

  // pick-file：用聚焦窗口打开文件选择器（无聚焦窗口返回 canceled）。
  // [W7] 风格对齐 pick-directory：dialog 抛异常时 console.error + 返回 {canceled:true, path:null}，
  // 而非依赖 ipcMain.handle 的 invoke rejection 兜底。降级目标对称：无聚焦窗口 / dialog 崩溃都返回 canceled。
  //
  // [HISTORICAL] defaultPath 兜底到 homedir（与 pick-directory 同一不变量）：
  // 省略 defaultPath 时 macOS 原生文件选择器会用 OS 记忆的上次位置；若该位置已被删除，
  // Finder 会回退到 Documents（非预期，用户期望回退到 ~）。由渲染端传入候选 defaultPath，
  // 主进程 existsSync 守卫——存在则用，否则降级 homedir。
  //
  // filters 透传：渲染端传入 Electron 原生 FileFilter[]（{name, extensions}），主进程不转换
  // 直接传给 dialog，让渲染端决定业务类型（图片/文档/视频），IPC 保持薄通道语义。
  ipcMain.handle(
    'pick-file',
    async (
      _event,
      options?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
    ) => {
      const focusedWin = BrowserWindow.getFocusedWindow()
      if (!focusedWin) return { canceled: true, path: null }
      try {
        const fallbackPath =
          options?.defaultPath && existsSync(options.defaultPath) ? options.defaultPath : homedir()
        const result = await dialog.showOpenDialog(focusedWin, {
          properties: ['openFile'],
          title: options?.title ?? '选择文件',
          defaultPath: fallbackPath,
          filters: options?.filters,
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { canceled: true, path: null }
        }
        return { canceled: false, path: result.filePaths[0] }
      } catch (err) {
        console.error('[ipc] pick-file failed:', err)
        return { canceled: true, path: null }
      }
    },
  )

  // write-tmp-image：把剪贴板图片（base64）写到 OS tmpdir，返回绝对路径。
  // Cmd+V/Ctrl+V 粘贴截图走此 handler：renderer 读剪贴板 image blob → base64 → 经此 IPC
  // 落地成文件，后续由 renderer 走富呈现 badge（Cmd/Ctrl+V 统一通路）。
  //
  // 安全：
  // - mimeType 必须以 image/ 开头（防借道写任意文件），且 base64 经 Buffer 解码。
  // - 解码后大小上限 MAX_IMAGE_BYTES（20MB）：防超大输入撑爆内存/磁盘。base64 长度按 3/4 估算
  //   解码字节数（误差仅尾部填充，足够拒超大输入）。超限 throw，让 renderer 的 invoke reject 被
  //   catch，降级为 [图片粘贴失败] 文本提示。
  // 失败语义：与 pick-* 不同，此处 fs 写失败直接 throw（让 renderer 的 invoke reject 被
  // catch，降级为 [图片粘贴失败] 文本提示），而非返回 null——因为返回 null 与「未取到 blob」
  // 语义混淆，throw 让 renderer 明确区分「IPC 不可用」(undefined) vs 「写入失败」(catch)。
  ipcMain.handle(
    'write-tmp-image',
    async (
      _event,
      payload: { base64: string; mimeType: string; suggestedName?: string },
    ): Promise<{ path: string; name: string }> => {
      const { base64, mimeType, suggestedName } = payload
      if (!mimeType.startsWith('image/')) {
        throw new Error(`write-tmp-image: invalid mimeType ${mimeType}`)
      }
      // M1 大小上限：解码前按 base64 长度估算解码字节数（3/4 比例），超 20MB 拒绝。
      // 估算仅尾部 padding 有 1-2 字节误差，对 20MB 量级拒绝判定无影响。
      const MAX_IMAGE_BYTES = 20 * 1024 * 1024
      const decodedBytes = Math.ceil((base64.length * 3) / 4)
      if (decodedBytes > MAX_IMAGE_BYTES) {
        throw new Error(
          `图片过大（${Math.round(decodedBytes / 1024 / 1024)}MB），上限 20MB`,
        )
      }
      // mimeType → ext 映射（覆盖常见剪贴板图类型）
      const extByMime: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
      }
      const ext = extByMime[mimeType] ?? 'png'
      try {
        // 文件名：suggestedName 优先（保留原始截图名），否则时间戳+随机数保证唯一
        const name = suggestedName
          ? suggestedName.includes('.')
            ? suggestedName
            : `${suggestedName}.${ext}`
          : `xyz-img-${Date.now()}-${randomInt(0, 0xffffff).toString(36)}.${ext}`
        const fullPath = join(tmpdir(), name)
        writeFileSync(fullPath, Buffer.from(base64, 'base64'))
        return { path: fullPath, name }
      } catch (err) {
        console.error('[ipc] write-tmp-image failed:', err)
        throw new Error('write-tmp-image failed')
      }
    },
  )

  // ── 窗口控制（win/linux 自绘 traffic-light 圆点点击，shell spec §五方案 X）─────
  // mac 红黄绿是系统按钮不走这里。fromWebContents 按 sender 定位调用窗口，多窗口安全。
  ipcMain.handle('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('window-toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
