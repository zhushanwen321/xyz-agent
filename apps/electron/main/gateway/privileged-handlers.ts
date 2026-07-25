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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IpcHandlerDeps } from '../interfaces.js'
import { IMAGE_LIMITS } from '@xyz-agent/shared'
import type { SegmentsMetadataEntry, SegmentsMetadataFile } from '@xyz-agent/shared'
import { getAttachmentsDir } from '@xyz-agent/shared/paths'
import { isValidExternalUrl } from './input-validators.js'

/** 生成 YYYYMMDD-HHMM 时间戳（displayName 用，本地时区） */
function formatTimestamp(): string {
  const d = new Date()
  // padStart 目标宽度（月份/日期/时/分都是 2 位）；getMonth 从 0 计数需 +1。
  // 提取为具名常量避免 magic-numbers 规则（规则对常量赋值处不报，仅对内联使用处报）。
  const PAD_WIDTH = 2
  const JANUARY_OFFSET = 1
  const pad = (n: number) => String(n).padStart(PAD_WIDTH, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + JANUARY_OFFSET)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * 注册特权 IPC handler（open-external / pick-directory / pick-file / write-session-image）。
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

  // write-session-image：把剪贴板图片（base64）写到 <getDataDir>/attachments/<sessionId>/（持久化）。
  // Cmd+V/Ctrl+V 粘贴截图走此 handler：renderer 读剪贴板 image blob → base64 → 经此 IPC
  // 落地成文件，后续由 renderer 走富呈现 badge（Cmd/Ctrl+V 统一通路）。
  //
  // 持久化 vs tmpdir：原 write-tmp-image 落 OS tmpdir（macOS 3 天未访问自动清理），重开 session
  // 历史图片丢失。现落 <getDataDir>/attachments/<sessionId>/ 持久化（架构约定 #4 数据目录同策略）。
  // landing 态（sessionId 为空字符串，session 延迟创建）降级走 tmpdir——session 尚未创建无 sessionId
  // 可挂，landing 粘图后通常立即发送（session 随即创建），丢失窗口小且走 w2 降级 badge 兜底。
  //
  // 安全：
  // - mimeType 必须以 image/ 开头（防借道写任意文件），且 base64 经 Buffer 解码。
  // - 解码后大小上限 IMAGE_LIMITS.SINGLE_MAX_BYTES（20MB，SSOT）：防超大输入撑爆内存/磁盘。
  //   base64 长度按 3/4 估算解码字节数（误差仅尾部填充，足够拒超大输入）。超限 throw，让 renderer
  //   的 invoke reject 被 catch，降级为 [图片粘贴失败] 文本提示。
  // - name 经 sanitize 剥离路径分隔符（/ \ :）和控制字符，防目录穿越。uuid 前缀保证唯一性。
  //
  // 失败语义：与 pick-* 不同，此处 fs 写失败直接 throw（让 renderer 的 invoke reject 被
  // catch，降级为 [图片粘贴失败] 文本提示），而非返回 null——因为返回 null 与「未取到 blob」
  // 语义混淆，throw 让 renderer 明确区分「IPC 不可用」(undefined) vs 「写入失败」(catch)。
  ipcMain.handle(
    'write-session-image',
    async (
      _event,
      payload: { sessionId: string; base64: string; mimeType: string; name: string },
    ): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }> => {
      const { sessionId, base64, mimeType, name } = payload
      if (!mimeType.startsWith('image/')) {
        throw new Error('mimeType must start with image/')
      }
      // M1 大小上限：解码前按 base64 长度估算解码字节数（3/4 比例），超 SINGLE_MAX_BYTES 拒绝。
      // 估算仅尾部 padding 有 1-2 字节误差，对 20MB 量级拒绝判定无影响。
      // eslint-disable-next-line no-magic-numbers
      const decodedBytes = Math.ceil((base64.length * 3) / 4)
      if (decodedBytes > IMAGE_LIMITS.SINGLE_MAX_BYTES) {
        // eslint-disable-next-line no-magic-numbers
        const sizeMB = Math.round(decodedBytes / 1024 / 1024)
        throw new Error(`图片过大（${sizeMB}MB），上限 20MB`)
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
      // sanitize name：剥离路径分隔符（/ \ :）和控制字符防目录穿越，trim 首尾空白。
      // 保留中英文/数字/点/连字符/下划线/空格（可读性）。空则退化为 'image' 占位。
      // 剥离已有的同名扩展名（用户 name 可能含 .png，避免重拼接成 .png.png）。
      const extRegExp = new RegExp(`\\.${ext}$`, 'i')
      const sanitized = name.replace(/[/\\:\x00-\x1f]/g, '').trim().replace(extRegExp, '') || 'image'
      try {
        // sessionId 非空 → <dataDir>/attachments/<sessionId>/（持久化）；空 → tmpdir（landing 降级）
        const dir = sessionId ? getAttachmentsDir(sessionId) : tmpdir()
        if (sessionId) mkdirSync(dir, { recursive: true })
        // 文件名：uuid 前缀（唯一性主力）+ sanitize(name)（可读性辅助）+ 扩展名
        const filename = `${randomUUID()}-${sanitized}.${ext}`
        const fullPath = join(dir, filename)
        writeFileSync(fullPath, Buffer.from(base64, 'base64'))
        // displayName: 用户可读名（badge/alt 显示），不含 uuid 前缀。
        // - name 经 sanitize 非空（用户拖拽/+菜单选文件时有原文件名）→ 用 sanitized + .ext
        // - name 退化（sanitized 为 'image'，说明是粘贴截图无原文件名）→ 用 截图-时间戳.ext
        const isPlaceholder = sanitized === 'image'
        const displayName = isPlaceholder
          ? `截图-${formatTimestamp()}.${ext}`
          : `${sanitized}.${ext}`
        // persisted：sessionId 非空 → 落 attachments（已持久化，不需要迁移）；空 → 落 tmpdir
        //（landing 降级，session 创建后需迁移到 attachments）。调用方据 !persisted 标记 segment.needsMigrate。
        return { path: fullPath, fileName: filename, displayName, id: randomUUID(), persisted: !!sessionId }
      } catch (err) {
        console.error('[ipc] write-session-image failed:', err)
        throw new Error('write-session-image failed')
      }
    },
  )

  // write-segments-metadata：追加/覆盖一条 segments 元数据到 <dataDir>/attachments/<sessionId>/segments.json。
  // 与 write-session-image 同目录，复用 getAttachmentsDir。atomic 写（临时文件 + rename）防并发损坏。
  // 同 clientUuid 重发（editAndResend 场景）→ 后者覆盖前者（按 clientUuid 去重）。
  ipcMain.handle(
    'write-segments-metadata',
    async (
      _event,
      payload: { sessionId: string; entry: SegmentsMetadataEntry },
    ): Promise<void> => {
      const { sessionId, entry } = payload
      if (!sessionId) throw new Error('write-segments-metadata requires non-empty sessionId')
      try {
        const dir = getAttachmentsDir(sessionId)
        mkdirSync(dir, { recursive: true })
        const filePath = join(dir, 'segments.json')
        // 读已有（文件不存在 → 空）
        let file: SegmentsMetadataFile = { version: 1, entries: [] }
        if (existsSync(filePath)) {
          try {
            const raw = readFileSync(filePath, 'utf-8')
            const parsed = JSON.parse(raw) as SegmentsMetadataFile
            if (parsed && Array.isArray(parsed.entries)) file = parsed
          } catch {
            // 损坏的 segments.json → 重置（best-effort，不阻断写入）
            console.warn('[ipc] segments.json malformed, resetting:', filePath)
          }
        }
        // 按 clientUuid 去重：同 uuid 覆盖，新 uuid 追加
        const idx = file.entries.findIndex((e) => e.clientUuid === entry.clientUuid)
        if (idx >= 0) file.entries[idx] = entry
        else file.entries.push(entry)
        // atomic 写：临时文件 + rename。JSON_INDENT 提取常量避免 magic-numbers 规则。
        // POSIX 同文件系统 rename 原子；Windows 上目标文件已存在时 renameSync 会抛
        // EPERM/ENOTEMPTY（M5 修复）→ 先 unlink 目标再 rename 兜底（写窗口极短，可接受）。
        const JSON_INDENT = 2
        const tmpPath = filePath + '.tmp'
        writeFileSync(tmpPath, JSON.stringify(file, null, JSON_INDENT), 'utf-8')
        try {
          renameSync(tmpPath, filePath)
        } catch {
          // Windows: 目标已存在时 rename 失败，unlink 后重试
          try { unlinkSync(filePath) } catch { /* 目标不存在，忽略 */ }
          renameSync(tmpPath, filePath)
        }
      } catch (err) {
        console.error('[ipc] write-segments-metadata failed:', err)
        throw new Error('write-segments-metadata failed')
      }
    },
  )

  // read-segments-metadata：读 <dataDir>/attachments/<sessionId>/segments.json。
  // 文件不存在/损坏 → 返回 null（调用方降级为 textToSegments）。
  ipcMain.handle(
    'read-segments-metadata',
    async (
      _event,
      payload: { sessionId: string },
    ): Promise<SegmentsMetadataFile | null> => {
      const { sessionId } = payload
      if (!sessionId) return null
      try {
        const dir = getAttachmentsDir(sessionId)
        const filePath = join(dir, 'segments.json')
        if (!existsSync(filePath)) return null
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as SegmentsMetadataFile
        if (!parsed || !Array.isArray(parsed.entries)) return null
        return parsed
      } catch (err) {
        console.warn('[ipc] read-segments-metadata failed (returning null):', err)
        return null
      }
    },
  )

  // migrate-session-image：landing 态图片落 tmpdir 后，session.create 成功时迁移到 attachments 持久化目录。
  // 解决「landing 粘图 → tmpdir → session 创建 → path 仍指 tmpdir → 重开 session 几天后图丢」的缺口。
  // 调用时机：useNewTaskFlow.submitFirstMessage 在 sessionApi.create 成功后，扫描 segments 找 image
  // segment，对 path 在 tmpdir 的调此 IPC。
  //
  // 行为：
  // - 把 fromPath 文件 move（rename）到 <dataDir>/attachments/<sessionId>/<fileName>
  // - 返回 { path: newPath }（调用方据此更新 segment.path）
  //
  // 失败语义：fromPath 不存在（OS 已清理 tmpdir）/ move 失败 → throw，让 renderer 的 invoke reject
  // 被 catch，走降级（保留原 tmpdir path，toast 提示迁移失败，extractImages 发送时 fetch 失败跳过）。
  ipcMain.handle(
    'migrate-session-image',
    async (
      _event,
      payload: { fromPath: string; sessionId: string; fileName: string },
    ): Promise<{ path: string }> => {
      const { fromPath, sessionId, fileName } = payload
      if (!sessionId) throw new Error('migrate-session-image requires non-empty sessionId')
      if (!existsSync(fromPath)) {
        throw new Error(`source file not found: ${fromPath}`)
      }
      try {
        const dir = getAttachmentsDir(sessionId)
        mkdirSync(dir, { recursive: true })
        const newPath = join(dir, fileName)
        renameSync(fromPath, newPath)
        return { path: newPath }
      } catch (err) {
        console.error('[ipc] migrate-session-image failed:', err)
        throw new Error('migrate-session-image failed')
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
