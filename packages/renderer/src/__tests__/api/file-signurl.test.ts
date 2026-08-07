/**
 * file.signUrl RPC 封装单测（T6 / wave w1 TC6）。
 *
 * 覆盖：
 * - signUrl(path) 转发 command('file.signUrl', {path})
 * - 解包 reply 返 {url, expiresAt}
 * - command 仅被调用 1 次，参数精确匹配
 *
 * mock 策略：vi.mock('@/api/request') 捕获 command 调用，控制返回值。
 *
 * 运行：npx vitest run src/__tests__/api/file-signurl.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 捕获 command 调用 + 控制返回值
const commandMock = vi.fn()
vi.mock('@/api/request', () => ({
  command: (...args: unknown[]) => commandMock(...args),
}))

import { signUrl } from '@/api/domains/file'

beforeEach(() => {
  commandMock.mockReset()
})

describe('file.signUrl RPC 封装（TC6）', () => {
  it('signUrl 转发 command(file.signUrl, {path}) 并解包 reply', async () => {
    commandMock.mockResolvedValue({
      url: '/file?path=%2Fabs%2Fimg.png&sig=abc&expires=999',
      expiresAt: 1700000000000,
    })

    const result = await signUrl('/abs/img.png')

    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('file.signUrl', { path: '/abs/img.png' })
    expect(result).toEqual({
      url: '/file?path=%2Fabs%2Fimg.png&sig=abc&expires=999',
      expiresAt: 1700000000000,
    })
  })

  it('signUrl 透传 command reject（错误不吞）', async () => {
    const rpcError = Object.assign(new Error('file_failed'), { code: 'file_failed' })
    commandMock.mockRejectedValue(rpcError)

    await expect(signUrl('/missing.png')).rejects.toThrow('file_failed')
    expect(commandMock).toHaveBeenCalledWith('file.signUrl', { path: '/missing.png' })
  })
})
