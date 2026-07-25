/**
 * W7: pick-directory IPC handler 的 try/catch 风格一致性。
 *
 * 背景：同文件 open-external 有 try/catch + 返回 false 降级，pick-directory 没有，
 * 靠 ipcMain.handle 的 invoke rejection 兜底（renderer openDirDialog catch 接住）。
 * 不是 bug，但风格不一致，维护者易误判为「故意吞错」。
 *
 * 修复：pick-directory 补 try/catch，dialog 抛异常时返回 {canceled:true, path:null}，
 * 与 getFocusedWindow null 的降级 + open-external 风格对称。
 *
 * Mock 策略：vi.mock('electron') 注入 ipcMain.handle 捕获 handler、dialog 控制抛错/返回。
 *
 * 运行：cd apps/electron/main && npx vitest run test/privileged-handlers.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()
// dialog.showOpenDialog 可被测试替换：默认正常，测试 2 替换为 reject
const dialogMock = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/picked'] })),
}))
const shellMock = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({})), // 默认有聚焦窗口
    fromWebContents: vi.fn(() => ({})),
  },
  dialog: dialogMock,
  shell: shellMock,
}))

import { registerPrivilegedHandlers } from '../gateway/privileged-handlers.js'

describe('W7: pick-directory IPC try/catch 一致性', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPrivilegedHandlers({} as never)
  })

  it('dialog 正常返回选中目录 → handler 返回 {canceled:false, path}', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/my/repo'] })
    const pickDir = handlers.get('pick-directory')!
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: false, path: '/my/repo' })
  })

  it('dialog 抛异常 → handler 返回 {canceled:true, path:null} 不 reject', async () => {
    dialogMock.showOpenDialog.mockRejectedValueOnce(new Error('dialog crash'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pickDir = handlers.get('pick-directory')!
    // 不该抛（ipcMain.handle 的 rejection 兜底虽存在，但本修复要求 handler 自身降级）
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: true, path: null })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('用户取消 → handler 返回 {canceled:true, path:null}（既有降级回归防护）', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const pickDir = handlers.get('pick-directory')!
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: true, path: null })
  })

  it('传入存在的 defaultPath → dialog 用该路径作为初始位置', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickDir = handlers.get('pick-directory')!
    await pickDir({}, { defaultPath: process.cwd() })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: process.cwd() }),
    )
  })

  it('传入已删除的 defaultPath → 回退到 homedir（不回退到 Documents）', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickDir = handlers.get('pick-directory')!
    const ghostPath = '/this/path/definitely/does/not/exist/xyz-12345'
    await pickDir({}, { defaultPath: ghostPath })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: homedir() }),
    )
  })

  it('不传 defaultPath → 回退到 homedir', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickDir = handlers.get('pick-directory')!
    await pickDir({}, {})
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: homedir() }),
    )
  })
})

describe('pick-file IPC handler', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPrivilegedHandlers({} as never)
  })

  it('dialog 正常返回选中文件 → handler 返回 {canceled:false, path}', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/my/file.png'] })
    const pickFile = handlers.get('pick-file')!
    const result = await pickFile({}, {})
    expect(result).toEqual({ canceled: false, path: '/my/file.png' })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ properties: ['openFile'] }),
    )
  })

  it('dialog 抛异常 → handler 返回 {canceled:true, path:null} 不 reject', async () => {
    dialogMock.showOpenDialog.mockRejectedValueOnce(new Error('dialog crash'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pickFile = handlers.get('pick-file')!
    const result = await pickFile({}, {})
    expect(result).toEqual({ canceled: true, path: null })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('用户取消 → handler 返回 {canceled:true, path:null}', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const pickFile = handlers.get('pick-file')!
    const result = await pickFile({}, {})
    expect(result).toEqual({ canceled: true, path: null })
  })

  it('传入 filters → dialog 收到 filters 且 properties 含 openFile', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked.png'] })
    const pickFile = handlers.get('pick-file')!
    const filters = [{ name: '图片', extensions: ['png', 'jpg'] }]
    await pickFile({}, { filters })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ properties: ['openFile'], filters }),
    )
  })

  it('传入存在的 defaultPath → dialog 用该路径作为初始位置', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickFile = handlers.get('pick-file')!
    await pickFile({}, { defaultPath: process.cwd() })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: process.cwd() }),
    )
  })

  it('传入已删除的 defaultPath → 回退到 homedir', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked'] })
    const pickFile = handlers.get('pick-file')!
    const ghostPath = '/this/path/definitely/does/not/exist/xyz-12345'
    await pickFile({}, { defaultPath: ghostPath })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ defaultPath: homedir() }),
    )
  })

  it('无聚焦窗口 → handler 返回 {canceled:true, path:null} 不调 dialog', async () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce(null)
    const pickFile = handlers.get('pick-file')!
    const result = await pickFile({}, {})
    expect(result).toEqual({ canceled: true, path: null })
    expect(dialogMock.showOpenDialog).not.toHaveBeenCalled()
  })
})

describe('write-tmp-image IPC handler (TC3)', () => {
  // 真实 tmp 文件 I/O：write-tmp-image 写真实 tmpdir 文件，测试读回校验后清理。
  // 不 mock node:fs/os/path/crypto——这些模块 mock 会破坏同文件 pick-directory/pick-file 测试
  //（它们依赖真实 existsSync 的 ghost path 回退 + 真实 homedir）。
  const writtenPaths: string[] = []
  afterEach(() => {
    for (const p of writtenPaths.splice(0)) {
      try { rmSync(p) } catch { /* 忽略清理失败 */ }
    }
  })

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPrivilegedHandlers({} as never)
  })

  it('TC3: base64 + mimeType=image/png → 写 tmpdir 返回 {path,name}，文件名含 xyz-img 前缀', async () => {
    const writeTmpImage = handlers.get('write-tmp-image')!
    // 完整 base64（6 字节 → 8 字符，无填充歧义，可精确 round-trip）
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const base64 = bytes.toString('base64') // 'iVBOBg0K'
    const result = (await writeTmpImage({}, { base64, mimeType: 'image/png' })) as {
      path: string
      name: string
    }
    writtenPaths.push(result.path)
    // 返回 name 形如 xyz-img-<digits>-<alnum>.png
    expect(result.name).toMatch(/^xyz-img-\d+-[a-z0-9]+\.png$/)
    // path = join(tmpdir(), name)
    expect(result.path).toBe(join(tmpdir(), result.name))
    // 文件真实写入 + 内容 round-trip 还原原字节
    expect(existsSync(result.path)).toBe(true)
    const written = readFileSync(result.path)
    expect(Array.from(written)).toEqual(Array.from(bytes))
  })

  it('非 image/* mimeType → throw「invalid mimeType」（防借道写任意文件）', async () => {
    const writeTmpImage = handlers.get('write-tmp-image')!
    await expect(writeTmpImage({}, { base64: 'x', mimeType: 'text/plain' })).rejects.toThrow(
      'invalid mimeType',
    )
  })

  it('传入 suggestedName → 用作文件名（补 ext 若无）', async () => {
    const writeTmpImage = handlers.get('write-tmp-image')!
    const bytes = Buffer.from([0x01])
    const result = (await writeTmpImage({}, {
      base64: bytes.toString('base64'),
      mimeType: 'image/jpeg',
      suggestedName: 'screenshot',
    })) as { path: string; name: string }
    writtenPaths.push(result.path)
    expect(result.name).toBe('screenshot.jpg')
  })

  it('mimeType=image/jpeg → ext=jpg', async () => {
    const writeTmpImage = handlers.get('write-tmp-image')!
    const result = (await writeTmpImage({}, {
      base64: Buffer.from([0x01]).toString('base64'),
      mimeType: 'image/jpeg',
    })) as { path: string; name: string }
    writtenPaths.push(result.path)
    expect(result.name.endsWith('.jpg')).toBe(true)
  })

  it('写入失败 → throw「write-tmp-image failed」+ console.error（指向不存在父目录触发真实 fs 错误）', async () => {
    const writeTmpImage = handlers.get('write-tmp-image')!
    // 用一个绝对不存在的目录前缀作 suggestedName，join(tmpdir, '...') 仍合法但写不进去：
    // 改用「目录穿越 + 非法文件名」更稳——此处用 suggestedName 含路径分隔符在多数 OS 写失败。
    // 简化：直接断言 throw 路径——用一个超长文件名触发 ENAMETOOLONG。
    const longName = 'a'.repeat(5000)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      writeTmpImage({}, {
        base64: Buffer.from([0x01]).toString('base64'),
        mimeType: 'image/png',
        suggestedName: longName,
      }),
    ).rejects.toThrow('write-tmp-image failed')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('M1: 解码后超 20MB → throw「图片过大」不写文件（防超大输入撑爆内存/磁盘）', async () => {
    const writeTmpImage = handlers.get('write-tmp-image')!
    // 构造 base64 使解码字节数 > 20MB：21MB = 21*1024*1024 字节，base64 长度 ≈ 21MB*4/3
    const targetBytes = 21 * 1024 * 1024
    const base64Len = Math.ceil((targetBytes * 4) / 3)
    const oversizedBase64 = 'A'.repeat(base64Len)
    // 不应 console.error（M1 拒绝在 fs 写入之前，属校验层而非写入失败）
    await expect(
      writeTmpImage({}, { base64: oversizedBase64, mimeType: 'image/png' }),
    ).rejects.toThrow('图片过大')
  })

  it('M1: 解码后接近 20MB（19MB，上限内）→ 正常写入', async () => {
    const writeTmpImage = handlers.get('write-tmp-image')!
    // 用 19MB（上限 20MB 内，留余量避开 base64 padding 估算误差）验证大图正常落地。
    // 解码字节数估算 Math.ceil(base64.length*3/4) 对带 padding 的 base64 会高估 1-3 字节，
    // 故用 19MB 而非恰好 20MB 避免边界抖动（拒绝判定语义是「明显超大」，非字节精确）。
    const targetBytes = 19 * 1024 * 1024
    const bytes = Buffer.alloc(targetBytes, 0x01)
    const result = (await writeTmpImage({}, {
      base64: bytes.toString('base64'),
      mimeType: 'image/png',
    })) as { path: string; name: string }
    writtenPaths.push(result.path)
    expect(existsSync(result.path)).toBe(true)
  })
})
