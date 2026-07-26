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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { BrowserWindow } from 'electron'
import { getDataDir } from '@xyz-agent/shared/paths'
import type { SegmentsMetadataEntry, SegmentsMetadataFile } from '@xyz-agent/shared'

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

  it('W3TC3: panel 态（sessionId 非空）→ 写 attachments/<sessionId>/ 返回 {path,fileName,displayName,id,persisted:true}', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const base64 = bytes.toString('base64')
    const result = (await writeSessionImage({}, {
      sessionId: 'sess-panel-1',
      base64,
      mimeType: 'image/png',
      name: 'shot.png',
    })) as { path: string; fileName: string; displayName: string; id: string; persisted: boolean }
    writtenPaths.push(result.path)
    // path 在 <dataDir>/attachments/sess-panel-1/ 下
    const expectedDir = join(getDataDir(), 'attachments', 'sess-panel-1')
    expect(result.path.startsWith(expectedDir)).toBe(true)
    // 文件真实写入 + 内容 round-trip
    expect(existsSync(result.path)).toBe(true)
    const written = readFileSync(result.path)
    expect(Array.from(written)).toEqual(Array.from(bytes))
    // fileName 是 uuid-shot.png 格式（含 uuid 前缀）
    expect(result.fileName).toMatch(/^[0-9a-f-]+-shot\.png$/)
    // displayName 用 sanitized basename（无 uuid 前缀），用户传 'shot.png' → 'shot.png'
    expect(result.displayName).toBe('shot.png')
    // id 是 uuid 格式
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // M1：sessionId 非空 → 落 attachments → persisted=true（不需迁移）
    expect(result.persisted).toBe(true)
  })

  it('W3TC4: landing 降级（sessionId 为空）→ 写 tmpdir 返回 {path,fileName,displayName,id,persisted:false}', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const bytes = Buffer.from([0x01])
    const result = (await writeSessionImage({}, {
      sessionId: '',
      base64: bytes.toString('base64'),
      mimeType: 'image/png',
      name: 'x.png',
    })) as { path: string; fileName: string; displayName: string; id: string; persisted: boolean }
    writtenPaths.push(result.path)
    // path 在 tmpdir 下（降级路径）
    expect(result.path.startsWith(tmpdir())).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    // id 是 uuid 格式
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // M1：sessionId 空 → 落 tmpdir → persisted=false（session 创建后需迁移）
    expect(result.persisted).toBe(false)
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
    })) as { path: string; fileName: string; displayName: string; id: string }
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
    })) as { path: string; fileName: string; displayName: string }
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
    })) as { path: string; fileName: string; displayName: string }
    writtenPaths.push(result.path)
    expect(result.fileName.endsWith('.jpg')).toBe(true)
    expect(result.displayName.endsWith('.jpg')).toBe(true)
  })

  it('拖拽/+菜单（name 非空）→ displayName 用原 basename（sanitized + .ext）', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const result = (await writeSessionImage({}, {
      sessionId: 's1',
      base64: Buffer.from([0x01]).toString('base64'),
      mimeType: 'image/png',
      name: 'photo.png',
    })) as { path: string; fileName: string; displayName: string }
    writtenPaths.push(result.path)
    // displayName 用 sanitized basename，无 uuid 前缀
    expect(result.displayName).toBe('photo.png')
    // fileName 含 uuid 前缀
    expect(result.fileName).toMatch(/^[0-9a-f-]+-photo\.png$/)
  })

  it('粘贴截图（name 为空，sanitized 退化 image）→ displayName 形如 截图-YYYYMMDD-HHMM.png', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const result = (await writeSessionImage({}, {
      sessionId: 's1',
      base64: Buffer.from([0x01]).toString('base64'),
      mimeType: 'image/png',
      name: '',
    })) as { path: string; fileName: string; displayName: string }
    writtenPaths.push(result.path)
    // fileName 仍是 uuid-image.png 形式（uuid 前缀 + 占位 basename）
    expect(result.fileName).toMatch(/^[0-9a-f-]+-image\.png$/)
    // displayName 走截图-时间戳 分支（正则校验，不硬编码时间）
    expect(result.displayName).toMatch(/^截图-\d{8}-\d{4}\.png$/)
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

describe('migrate-session-image IPC handler', () => {
  // 真实文件 I/O：migrate 把 tmpdir 文件 move 到 attachments 目录。
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

  it('happy path: landing 写 tmpdir 后 migrate 到 attachments/<sessionId>/，原 tmpdir 文件已 move', async () => {
    const writeSessionImage = handlers.get('write-session-image')!
    const migrateSessionImage = handlers.get('migrate-session-image')!
    // 1. landing 态先写 tmpdir（sessionId 为空）
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const writeResult = (await writeSessionImage({}, {
      sessionId: '',
      base64: bytes.toString('base64'),
      mimeType: 'image/png',
      name: 'shot.png',
    })) as { path: string; fileName: string; displayName: string; id: string }
    writtenPaths.push(writeResult.path)
    const tmpPath = writeResult.path
    expect(existsSync(tmpPath)).toBe(true)
    // 2. session 创建后 migrate 到真实 sessionId
    const migrateResult = (await migrateSessionImage({}, {
      fromPath: tmpPath,
      sessionId: 'sess-real-1',
      fileName: writeResult.fileName,
    })) as { path: string }
    writtenPaths.push(migrateResult.path)
    // 新 path 在 attachments 目录下
    const expectedDir = join(getDataDir(), 'attachments', 'sess-real-1')
    expect(migrateResult.path.startsWith(expectedDir)).toBe(true)
    expect(migrateResult.path.endsWith(writeResult.fileName)).toBe(true)
    // 新文件存在 + 内容 round-trip
    expect(existsSync(migrateResult.path)).toBe(true)
    expect(Array.from(readFileSync(migrateResult.path))).toEqual(Array.from(bytes))
    // 原 tmpdir 文件已被 move（不存在）—— rename 是 move 不是 copy
    expect(existsSync(tmpPath)).toBe(false)
  })

  it('fromPath 不存在 → invoke reject（throw），可被 catch 降级', async () => {
    const migrateSessionImage = handlers.get('migrate-session-image')!
    const ghostPath = join(tmpdir(), 'definitely-not-exist-' + Date.now() + '.png')
    expect(existsSync(ghostPath)).toBe(false)
    await expect(migrateSessionImage({}, {
      fromPath: ghostPath,
      sessionId: 'sess-1',
      fileName: 'x.png',
    })).rejects.toThrow(/source file not found/)
  })

  it('sessionId 为空 → throw requires non-empty sessionId', async () => {
    const migrateSessionImage = handlers.get('migrate-session-image')!
    // 先写一个 tmpdir 文件让 fromPath 真实存在，验证空 sessionId 早于 fs 检查就 throw
    const writeSessionImage = handlers.get('write-session-image')!
    const writeResult = (await writeSessionImage({}, {
      sessionId: '',
      base64: Buffer.from([0x01]).toString('base64'),
      mimeType: 'image/png',
      name: 'x.png',
    })) as { path: string; fileName: string }
    writtenPaths.push(writeResult.path)
    await expect(migrateSessionImage({}, {
      fromPath: writeResult.path,
      sessionId: '',
      fileName: writeResult.fileName,
    })).rejects.toThrow('migrate-session-image requires non-empty sessionId')
  })

  it('B1: fromPath 在白名单外（home 目录）→ throw，不 move 文件（防任意文件移动）', async () => {
    const migrateSessionImage = handlers.get('migrate-session-image')!
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // 在 home 下造一个文件，尝试迁移（不应被允许——home 既非 tmpdir 也非 attachments）
    const evilFile = join(homedir(), '.xyz-agent-test-evil-' + Date.now() + '.txt')
    writeFileSync(evilFile, 'secret')
    writtenPaths.push(evilFile)
    expect(existsSync(evilFile)).toBe(true)
    await expect(migrateSessionImage({}, {
      fromPath: evilFile,
      sessionId: 'sess-b1',
      fileName: 'leaked.txt',
    })).rejects.toThrow('migrate-session-image failed')
    // 原文件仍在原位（未被 move）
    expect(existsSync(evilFile)).toBe(true)
    // 目标 attachments 目录下没有 leaked.txt
    expect(existsSync(join(getDataDir(), 'attachments', 'sess-b1', 'leaked.txt'))).toBe(false)
    errSpy.mockRestore()
  })

  it('B1: fileName 含路径分隔符 → sanitize 剥离，newPath 落在 attachments/<sid>/ 下不穿越', async () => {
    const migrateSessionImage = handlers.get('migrate-session-image')!
    // 先在 tmpdir 造一个 fromPath（合法来源）
    const bytes = Buffer.from([0x01, 0x02])
    const fromPath = join(tmpdir(), 'xyz-test-migrate-' + Date.now() + '.png')
    writeFileSync(fromPath, bytes)
    writtenPaths.push(fromPath)
    // fileName 含穿越片段
    const result = (await migrateSessionImage({}, {
      fromPath,
      sessionId: 'sess-sanitize',
      fileName: '../../../etc/foo.png',
    })) as { path: string }
    writtenPaths.push(result.path)
    // newPath 落在 attachments/sess-sanitize/ 下（starts with 守门，穿越后不会满足）
    const expectedDir = join(getDataDir(), 'attachments', 'sess-sanitize')
    expect(result.path.startsWith(expectedDir)).toBe(true)
    // 路径分隔符被剥离——结果路径相对 expectedDir 只剩一个扁平文件名（不含任何 / 或 \ 段）
    const rel = relative(expectedDir, result.path)
    expect(rel).not.toMatch(/[\\/]/)
    // 文件已 move 到 newPath，内容 round-trip
    expect(existsSync(result.path)).toBe(true)
    expect(Array.from(readFileSync(result.path))).toEqual(Array.from(bytes))
    expect(existsSync(fromPath)).toBe(false)
  })

  it('B1: sessionId 含 ../ → throw（getAttachmentsDir 校验防路径穿越）', async () => {
    const migrateSessionImage = handlers.get('migrate-session-image')!
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // 在 tmpdir 造合法来源文件（绕过 fromPath 白名单，专门测 sessionId 校验）
    const fromPath = join(tmpdir(), 'xyz-test-migrate-sid-' + Date.now() + '.png')
    writeFileSync(fromPath, Buffer.from([0x01]))
    writtenPaths.push(fromPath)
    await expect(migrateSessionImage({}, {
      fromPath,
      sessionId: '../etc',
      fileName: 'x.png',
    })).rejects.toThrow('migrate-session-image failed')
    // 原文件未被 move
    expect(existsSync(fromPath)).toBe(true)
    errSpy.mockRestore()
  })
})

describe('write-segments-metadata IPC handler', () => {
  // 真实文件 I/O：复用 write-session-image 测试的 tmpdir 清理模式（afterEach rmSync）。
  // 每个用例用独立 sessionId 子目录，互不干扰（getAttachmentsDir 按 sessionId 分区）。
  //
  // 注意：read-segments-metadata handler 已删除（W6），原 round-trip 校验改用 readFileSync
  // 直接读 segments.json 验证落地内容（不再经 IPC read）。
  const writtenDirs: string[] = []
  afterEach(() => {
    for (const d of writtenDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
    }
  })

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPrivilegedHandlers({} as never)
  })

  /** 构造一条测试用 segments entry（含 text/image/file 段，覆盖实际 user message 形态） */
  function makeEntry(clientUuid: string, timestamp = 1234567890): SegmentsMetadataEntry {
    return {
      clientUuid,
      segments: [
        { type: 'text', text: '看下这张图' },
        {
          type: 'image',
          id: 'img-id-1',
          path: '/tmp/foo.png',
          fileName: 'foo.png',
          displayName: 'foo.png',
        },
        { type: 'file', path: '/repo/src/index.ts', lineRange: [10, 20] },
      ],
      timestamp,
    }
  }

  /** 读 segments.json 并 parse（替代已删的 read-segments-metadata IPC，纯测试辅助） */
  function readSidecar(sessionId: string): SegmentsMetadataFile {
    const dir = join(getDataDir(), 'attachments', sessionId)
    const raw = readFileSync(join(dir, 'segments.json'), 'utf-8')
    return JSON.parse(raw) as SegmentsMetadataFile
  }

  it('write 单条 → 落地 segments.json 含该条（round-trip 保真）', async () => {
    const writeSegmentsMetadata = handlers.get('write-segments-metadata')!
    const sessionId = 'seg-test-write-read-single'
    writtenDirs.push(join(getDataDir(), 'attachments', sessionId))

    const entry = makeEntry('u-aaa')
    await writeSegmentsMetadata({}, { sessionId, entry })

    const file = readSidecar(sessionId)
    expect(file.version).toBe(1)
    expect(file.entries).toHaveLength(1)
    expect(file.entries[0]).toEqual(entry)
  })

  it('write 多条（不同 clientUuid）→ 落地含全部', async () => {
    const writeSegmentsMetadata = handlers.get('write-segments-metadata')!
    const sessionId = 'seg-test-write-multi'
    writtenDirs.push(join(getDataDir(), 'attachments', sessionId))

    const entry1 = makeEntry('u-1', 1000)
    const entry2 = makeEntry('u-2', 2000)
    const entry3 = makeEntry('u-3', 3000)
    await writeSegmentsMetadata({}, { sessionId, entry: entry1 })
    await writeSegmentsMetadata({}, { sessionId, entry: entry2 })
    await writeSegmentsMetadata({}, { sessionId, entry: entry3 })

    const file = readSidecar(sessionId)
    expect(file.entries).toHaveLength(3)
    expect(file.entries.map((e) => e.clientUuid).sort()).toEqual(['u-1', 'u-2', 'u-3'])
  })

  it('write 同 clientUuid 两次（editAndResend 场景）→ 后者覆盖前者，不重复', async () => {
    const writeSegmentsMetadata = handlers.get('write-segments-metadata')!
    const sessionId = 'seg-test-edit-resend'
    writtenDirs.push(join(getDataDir(), 'attachments', sessionId))

    const v1 = makeEntry('u-overwrite', 1000)
    const v2 = makeEntry('u-overwrite', 9999)
    // 改 v2 的 segments 内容，验证覆盖的是后者而非前者
    v2.segments = [{ type: 'text', text: 'edited' }]
    await writeSegmentsMetadata({}, { sessionId, entry: v1 })
    await writeSegmentsMetadata({}, { sessionId, entry: v2 })

    const file = readSidecar(sessionId)
    expect(file.entries).toHaveLength(1)
    expect(file.entries[0].timestamp).toBe(9999)
    expect(file.entries[0].segments).toEqual([{ type: 'text', text: 'edited' }])
  })

  it('write 时目录不存在 → 自动创建并写入', async () => {
    const writeSegmentsMetadata = handlers.get('write-segments-metadata')!
    const sessionId = 'seg-test-mkdir-' + Date.now()
    const dir = join(getDataDir(), 'attachments', sessionId)
    writtenDirs.push(dir)
    // 目录不存在
    expect(existsSync(dir)).toBe(false)

    await writeSegmentsMetadata({}, { sessionId, entry: makeEntry('u-mkdir') })
    // 目录 + segments.json 已创建
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, 'segments.json'))).toBe(true)
    const file = readSidecar(sessionId)
    expect(file.entries).toHaveLength(1)
  })

  it('write 到已损坏的 segments.json → 重置后写入成功（best-effort，不阻断）', async () => {
    const writeSegmentsMetadata = handlers.get('write-segments-metadata')!
    const sessionId = 'seg-test-write-corrupted-' + Date.now()
    const dir = join(getDataDir(), 'attachments', sessionId)
    writtenDirs.push(dir)
    // 先构造损坏文件
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'segments.json'), '{corrupted!!!', 'utf-8')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // write 不抛（捕获了 parse 错误 → 重置为新文件 → 写入成功）
    await writeSegmentsMetadata({}, { sessionId, entry: makeEntry('u-recover') })
    warnSpy.mockRestore()

    const file = readSidecar(sessionId)
    expect(file.entries).toHaveLength(1)
    expect(file.entries[0].clientUuid).toBe('u-recover')
  })

  it('write 空 sessionId → throw requires non-empty sessionId', async () => {
    const writeSegmentsMetadata = handlers.get('write-segments-metadata')!
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      writeSegmentsMetadata({}, { sessionId: '', entry: makeEntry('u-x') }),
    ).rejects.toThrow('write-segments-metadata requires non-empty sessionId')
    errSpy.mockRestore()
  })

  it('atomic 写：临时文件 .tmp 写完才 rename（写后 .tmp 不残留）', async () => {
    const writeSegmentsMetadata = handlers.get('write-segments-metadata')!
    const sessionId = 'seg-test-atomic-' + Date.now()
    const dir = join(getDataDir(), 'attachments', sessionId)
    writtenDirs.push(dir)

    await writeSegmentsMetadata({}, { sessionId, entry: makeEntry('u-atomic') })
    // segments.json 存在，.tmp 不残留（已 rename 走）
    expect(existsSync(join(dir, 'segments.json'))).toBe(true)
    expect(existsSync(join(dir, 'segments.json.tmp'))).toBe(false)
  })
})
