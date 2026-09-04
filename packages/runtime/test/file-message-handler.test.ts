/**
 * FileMessageHandler 单测 — file.search case（composer # 文件候选入口）。
 *
 * 直接注入 mock ctx + mock fileService，覆盖 switch 分支的 reply/error 两条路径。
 * 模板照 tree-message-handler.test.ts（mock-ctx 捕获 reply/errors）。
 *
 * 注：file.tree / file.tree.expand / file.read / file.write.* 的路由测试不在本文件——
 * 它们的领域逻辑由 file-service.test.ts 覆盖，handler 是薄路由层。本文件聚焦 file.search
 * 与 file.search.cwd（新增 case，需独立覆盖 reply 形状 + error envelope 透传）。
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

/** 构造 mock ctx + 捕获 reply/error。fileService 两方法均可按用例 override。 */
function makeHandler(
  searchFiles: ReturnType<typeof vi.fn>,
  searchFilesInCwd: ReturnType<typeof vi.fn> = vi.fn(),
) {
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
    fileService: { searchFiles, searchFilesInCwd },
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
    const { replies, handler } = makeHandler(vi.fn().mockResolvedValue(files))

    await handler.handleFileMessage(buildMsg('file.search', { sessionId: 's1' }), WS)

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'file.search:result' })
    expect(replies[0].payload).toMatchObject({ sessionId: 's1' })
    expect((replies[0].payload as { files: unknown[] }).files).toHaveLength(1)
  })

  it('U13 error：searchFiles reject session_not_found → error envelope 透传 sessionId', async () => {
    const { replies, errors, handler } = makeHandler(
      vi.fn().mockRejectedValue(new FileError('session_not_found', 'Session 不存在: sX')),
    )

    await handler.handleFileMessage(buildMsg('file.search', { sessionId: 'sX' }, 'm2'), WS)

    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'session_not_found', id: 'm2', details: { sessionId: 'sX' } })
  })

  it('U14 handles 清单含 file.search', () => {
    const { handler } = makeHandler(vi.fn())
    expect(handler.handles).toContain('file.search')
  })
})

describe('FileMessageHandler — file.search.cwd（landing cwd 路）', () => {
  it('U15 success：searchFilesInCwd 返回 → reply file.search.cwd:result {files}（payload 无 sessionId 字段）', async () => {
    const files = [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }]
    const { replies, handler } = makeHandler(vi.fn(), vi.fn().mockResolvedValue(files))

    await handler.handleFileMessage(buildMsg('file.search.cwd', { cwd: '/repo' }), WS)

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 'm1', type: 'file.search.cwd:result' })
    expect(replies[0].payload).toEqual({ files })
    expect(replies[0].payload).not.toHaveProperty('sessionId')
  })

  it('U16 cwd 参数透传 searchFilesInCwd（协议 payload 仅 { cwd }，无 showIgnored）', async () => {
    const searchFilesInCwd = vi.fn().mockResolvedValue([])
    const { handler } = makeHandler(vi.fn(), searchFilesInCwd)

    await handler.handleFileMessage(buildMsg('file.search.cwd', { cwd: '/repo' }, 'm9'), WS)

    expect(searchFilesInCwd).toHaveBeenCalledWith('/repo')
  })

  it('U17 error：searchFilesInCwd reject not_found → error envelope（cwd 路无 sessionId，details 省略）', async () => {
    const { replies, errors, handler } = makeHandler(
      vi.fn(),
      vi.fn().mockRejectedValue(new FileError('not_found', 'cwd 不存在或不是目录: /gone')),
    )

    await handler.handleFileMessage(buildMsg('file.search.cwd', { cwd: '/gone' }, 'm3'), WS)

    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'not_found', id: 'm3' })
    expect(errors[0].details).toBeUndefined()
  })

  it('U18 handles 清单含 file.search.cwd', () => {
    const { handler } = makeHandler(vi.fn())
    expect(handler.handles).toContain('file.search.cwd')
  })
})
