/**
 * chat domain send images 透传单测（feature:add-file-picture-attach slice6 TC5-TC6）。
 *
 * 覆盖：
 * - TC5 send 不传 images → message.send payload 不含 images 键（既有行为不变）
 * - TC6 send 传 images → payload 含 images 数组（对齐 protocol.ts:199）
 *
 * mock 策略：vi.mock core request 模块捕获 command 调用（chat.ts 经 command 发 message.send；
 * domains 已迁 core，桥不转发 mock——说明符直指 core 模块文件，跨包相对路径）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/api/chat-send-images.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const commandMock = vi.fn()
vi.mock('../../../../core/src/transport/api/request', () => ({
  command: (...args: unknown[]) => commandMock(...args),
}))

import { send } from '@/api/domains/chat'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('chat.send images 透传（slice6 TC5-TC6）', () => {
  it('TC5 不传 images → payload 不含 images 键（既有行为不变）', async () => {
    commandMock.mockResolvedValue(undefined)

    await send('s1', 'hi')

    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('message.send', {
      sessionId: 's1',
      content: 'hi',
    })
    const payload = commandMock.mock.calls[0]![1] as Record<string, unknown>
    expect('images' in payload).toBe(false)
  })

  it('TC5b 显式传 images=undefined → payload 同样不含 images 键', async () => {
    commandMock.mockResolvedValue(undefined)

    await send('s1', 'hi', undefined)

    const payload = commandMock.mock.calls[0]![1] as Record<string, unknown>
    expect('images' in payload).toBe(false)
  })

  it('TC6 传 images → payload 含 images 数组', async () => {
    commandMock.mockResolvedValue(undefined)
    const images = [{ data: 'BASE64', mimeType: 'image/png' }]

    await send('s1', 'hi', images)

    expect(commandMock).toHaveBeenCalledWith('message.send', {
      sessionId: 's1',
      content: 'hi',
      images: [{ data: 'BASE64', mimeType: 'image/png' }],
    })
  })
})
