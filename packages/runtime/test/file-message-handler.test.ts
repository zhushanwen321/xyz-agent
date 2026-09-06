/**
 * FileMessageHandler 单测 — file.search case（composer # 文件候选入口）。
 *
 * 直接注入 mock ctx + mock fileService，覆盖 switch 分支的 reply/error 两条路径。
 * 模板照 tree-message-handler.test.ts（mock-ctx 捕获 reply/errors）。
 *
 * 注：file.tree / file.tree.expand 的路由测试不在本文件——它们的领域逻辑由
 * file-service.test.ts 覆盖，handler 是薄路由层。本文件聚焦 file.search（新增 case，
 * 需独立覆盖 reply 形状 + error envelope 透传），并补齐 U07 盘点出的覆盖缺口：
 * file.read 分流（有/无 sessionId）与 file.write 骨架 not_implemented → 结构化 result
 * （该分支语义非显然：catch 后 reply result 而非 error envelope）。
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/file-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { FileMessageHandler } from '../src/transport/file-message-handler.js'
import { FileError } from '../src/services/file-error.js'
import type { ClientMessage } from '@xyz-agent/shared'

interface CapturedReply {
  id: string | undefined
  type: string
  payload: Record<string, unknown>
}

interface CapturedError {
  code: string
  message: string
  id: string | undefined
  details?: Record<string, unknown>
}

/** 构造 mock ctx + 捕获 reply/error。fileService 各方法可按用例 override（未给的为 undefined）。 */
function makeHandler(fileServiceMethods: Record<string, ReturnType<typeof vi.fn>>) {
  const replies: CapturedReply[] = []
  const errors: CapturedError[] = []
  const ctx = {
    send: vi.fn(),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id: string | undefined, details?: Record<string, unknown>) => {
      errors.push({ code, message, id, details })
    }),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      replies.push({ id, type, payload })
    }),
    fileService: fileServiceMethods,
  }
  const handler = new FileMessageHandler(ctx as unknown as ConstructorParameters<typeof FileMessageHandler>[0])
  return { replies, errors, handler }
}

function buildMsg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('FileMessageHandler — file.search', () => {
  it('U12 success：searchFiles 返回 → reply file.search:result {sessionId, files}', async () => {
    const files = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    const { replies, handler } = makeHandler({ searchFiles: vi.fn().mockResolvedValue(files) })

    await handler.handleFileMessage(buildMsg('file.search', { sessionId: 's1' }), WS)

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'file.search:result' })
    expect(replies[0].payload).toMatchObject({ sessionId: 's1' })
    expect((replies[0].payload as { files: unknown[] }).files).toHaveLength(1)
  })

  it('U13 error：searchFiles reject session_not_found → error envelope 透传 sessionId', async () => {
    const { replies, errors, handler } = makeHandler({
      searchFiles: vi.fn().mockRejectedValue(new FileError('session_not_found', 'Session 不存在: sX')),
    })

    await handler.handleFileMessage(buildMsg('file.search', { sessionId: 'sX' }, 'm2'), WS)

    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'session_not_found', id: 'm2', details: { sessionId: 'sX' } })
  })

  it('U14 handles 清单含 file.search', () => {
    const { handler } = makeHandler({ searchFiles: vi.fn() })
    expect(handler.handles).toContain('file.search')
  })
})

describe('FileMessageHandler — file.read 分流 + file.write 骨架（U07 覆盖缺口补齐）', () => {
  it('file.read 有 sessionId → readFile(sessionId, path)（cwd 守门，文件树预览）', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'hello', truncated: true })
    const { replies, handler } = makeHandler({ readFile })

    await handler.handleFileMessage(buildMsg('file.read', { sessionId: 's1', path: 'x/a.ts' }), WS)

    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith('s1', 'x/a.ts')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({
      id: 'm1',
      type: 'file.read:result',
      payload: { content: 'hello', truncated: true, path: 'x/a.ts' },
    })
  })

  it('file.read 无 sessionId → readFileFromWhitelist（BC-3 三目录白名单：skill 文件预览，向后兼容）', async () => {
    const readFileFromWhitelist = vi.fn().mockResolvedValue({ content: 'skill body', truncated: false })
    const { replies, handler } = makeHandler({ readFileFromWhitelist })

    await handler.handleFileMessage(buildMsg('file.read', { path: 'skills/x/SKILL.md' }), WS)

    expect(readFileFromWhitelist).toHaveBeenCalledTimes(1)
    expect(readFileFromWhitelist).toHaveBeenCalledWith('skills/x/SKILL.md')
    expect(replies).toHaveLength(1)
    expect(replies[0]?.payload).toEqual({ content: 'skill body', truncated: false, path: 'skills/x/SKILL.md' })
  })

  it.each([
    { type: 'file.write.create', method: 'createFile', payload: { sessionId: 's1', path: 'x/n.md', content: 'hi' }, expected: { sessionId: 's1', path: 'x/n.md', implemented: false } },
    { type: 'file.write.rename', method: 'renameFile', payload: { sessionId: 's1', oldPath: 'a.md', newPath: 'b.md' }, expected: { sessionId: 's1', newPath: 'b.md', implemented: false } },
    { type: 'file.write.delete', method: 'deleteFile', payload: { sessionId: 's1', path: 'x/n.md' }, expected: { sessionId: 's1', path: 'x/n.md', implemented: false } },
  ])('AC-14.4：$type 抛 not_implemented → 转结构化 result（非 error envelope）', async ({ type, method, payload, expected }) => {
    const svcMethod = vi.fn().mockRejectedValue(new FileError('not_implemented'))
    const { replies, errors, handler } = makeHandler({ [method]: svcMethod })

    await handler.handleFileMessage(buildMsg(type, payload), WS)

    expect(errors).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({ id: 'm1', type: `${type}:result`, payload: expected })
  })

  it('AC-14.4 反向：file.write.create 抛非 not_implemented 的 FileError → 仍走 error envelope', async () => {
    const createFile = vi.fn().mockRejectedValue(new FileError('permission_denied', 'denied'))
    const { replies, errors, handler } = makeHandler({ createFile })

    await handler.handleFileMessage(buildMsg('file.write.create', { sessionId: 's1', path: 'x/n.md', content: 'hi' }), WS)

    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'permission_denied', id: 'm1', details: { sessionId: 's1' } })
  })
})
