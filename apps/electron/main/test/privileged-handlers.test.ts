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
import { getDataDir } from '@xyz-agent/shared/paths'

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

describe('write-session-image IPC handler (W3)', () => {
  // 真实文件 I/O：write-session-image 写真实 attachments/tmpdir 文件，测试读回校验后清理。
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

  it('W3TC3: panel 态（sessionId 非空）→ 写 attachments/<sessionId>/ 返回 {path,name,id}', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const base64 = bytes.toString('base64')
    const result = (await writeSessionImage({}, {
      sessionId: 'sess-panel-1',
      base64,
      mimeType: 'image/png',
      name: 'shot.png',
    })) as { path: string; name: string; id: string }
    writtenPaths.push(result.path)
    // path 在 <dataDir>/attachments/sess-panel-1/ 下
    const expectedDir = join(getDataDir(), 'attachments', 'sess-panel-1')
    expect(result.path.startsWith(expectedDir)).toBe(true)
    // 文件真实写入 + 内容 round-trip
    expect(existsSync(result.path)).toBe(true)
    const written = readFileSync(result.path)
    expect(Array.from(written)).toEqual(Array.from(bytes))
    // name 是 uuid-shot.png 格式
    expect(result.name).toMatch(/^[0-9a-f-]+-shot\.png$/)
    // id 是 uuid 格式
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('W3TC4: landing 降级（sessionId 为空）→ 写 tmpdir 返回 {path,name,id}', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const bytes = Buffer.from([0x01])
    const result = (await writeSessionImage({}, {
      sessionId: '',
      base64: bytes.toString('base64'),
      mimeType: 'image/png',
      name: 'x.png',
    })) as { path: string; name: string; id: string }
    writtenPaths.push(result.path)
    // path 在 tmpdir 下（降级路径）
    expect(result.path.startsWith(tmpdir())).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    // id 是 uuid 格式
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('W3TC5: 非 image/* mimeType → throw「mimeType must start with image/」（ERR1）', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    await expect(writeSessionImage({}, {
      sessionId: 's1',
      base64: 'x',
      mimeType: 'text/plain',
      name: 'x',
    })).rejects.toThrow('mimeType must start with image/')
  })

  it('W3TC6: 超过 20MB → throw「图片过大...20MB」（ERR2 ATTACH_TOO_LARGE）不写文件', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const targetBytes = 21 * 1024 * 1024
    const base64Len = Math.ceil((targetBytes * 4) / 3)
    const oversizedBase64 = 'A'.repeat(base64Len)
    await expect(writeSessionImage({}, {
      sessionId: 's1',
      base64: oversizedBase64,
      mimeType: 'image/png',
      name: 'big.png',
    })).rejects.toThrow(/图片过大.*20MB/)
  })

  it('W3TC7: name 含路径分隔符 → sanitize 剥离，path 不逃逸 attachments 目录', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const bytes = Buffer.from([0x01])
    const result = (await writeSessionImage({}, {
      sessionId: 's1',
      base64: bytes.toString('base64'),
      mimeType: 'image/png',
      name: '../../etc/passwd.png',
    })) as { path: string; name: string; id: string }
    writtenPaths.push(result.path)
    // path 不含穿越片段
    expect(result.path).not.toContain('etc/passwd')
    // path 仍在 attachments/s1 下
    const expectedDir = join(getDataDir(), 'attachments', 's1')
    expect(result.path.startsWith(expectedDir)).toBe(true)
    expect(existsSync(result.path)).toBe(true)
  })

  it('W3TC8: 19MB（上限内）→ 正常写入不 throw', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    // 用 19MB（上限 20MB 内，留余量避开 base64 padding 估算误差）验证大图正常落地。
    const targetBytes = 19 * 1024 * 1024
    const bytes = Buffer.alloc(targetBytes, 0x01)
    const result = (await writeSessionImage({}, {
      sessionId: 's1',
      base64: bytes.toString('base64'),
      mimeType: 'image/png',
      name: 'big.png',
    })) as { path: string; name: string }
    writtenPaths.push(result.path)
    expect(existsSync(result.path)).toBe(true)
  })

  it('mimeType=image/jpeg → ext=jpg', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const result = (await writeSessionImage({}, {
      sessionId: 's1',
      base64: Buffer.from([0x01]).toString('base64'),
      mimeType: 'image/jpeg',
      name: 'pic',
    })) as { path: string; name: string }
    writtenPaths.push(result.path)
    expect(result.name.endsWith('.jpg')).toBe(true)
  })

  it('name 为空 → sanitize 退化为 image 占位', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const result = (await writeSessionImage({}, {
      sessionId: 's1',
      base64: Buffer.from([0x01]).toString('base64'),
      mimeType: 'image/png',
      name: '',
    })) as { path: string; name: string }
    writtenPaths.push(result.path)
    expect(result.name).toMatch(/-image\.png$/)
  })

  it('写入失败 → throw「write-session-image failed」+ console.error（超长文件名触发 ENAMETOOLONG）', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const longName = 'a'.repeat(5000)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      writeSessionImage({}, {
        sessionId: 's1',
        base64: Buffer.from([0x01]).toString('base64'),
        mimeType: 'image/png',
        name: longName,
      }),
    ).rejects.toThrow('write-session-image failed')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
