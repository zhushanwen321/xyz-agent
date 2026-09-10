/**
 * toolResult 图片落盘编排测试（crash-resilience §3.3 D6-⑨ / u7-memory-governance，core 侧）。
 *
 * 覆盖（落盘执行方 main 侧生命周期在 apps/electron/main/images/__tests__/，此处测编排层）：
 * - persistImagesNewestFirst：消息序（旧→新）输入反转为新→旧交 port（设计 v8 顺序契约）
 * - 内容 hash 记账读口（getCachedImagePath）+ quota-full session 标记（isSessionImageCacheFull）
 * - requestImageWrite：单图写 + in-flight 去重（同内容并发共享同一 Promise）+ 帽满快速失败
 * - port 缺省（headless/mock 宿主）编排 no-op
 * - port 异常消化（fire-and-forget 契约：编排失败不 reject）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageCacheWriteImage, ImageCacheWriteResult } from '@xyz-agent/shared'
import {
  collectImagesFromMessages,
  getCachedImagePath,
  isSessionImageCacheFull,
  persistImagesNewestFirst,
  requestImageWrite,
  setImageCacheWritePort,
  _resetImageCacheForTest,
  type ImageCacheWritePort,
} from '../image-cache'
import type { Message } from '@xyz-agent/shared'

function img(data: string): ImageCacheWriteImage {
  return { data, mimeType: 'image/png' }
}

function okResult(paths: string[]): ImageCacheWriteResult {
  return { results: paths.map((p) => ({ status: 'written' as const, path: p, bytes: 10 })), quotaFull: false }
}

/** 捕获 port 收到的 images 数组序（顺序断言用）与按预设脚本回结果。 */
function makeRecordingPort(script: Array<'ok' | 'quota'> = []): { port: ImageCacheWritePort; calls: Array<{ sessionId: string; order: string[] }> } {
  const calls: Array<{ sessionId: string; order: string[] }> = []
  let batch = 0
  return {
    calls,
    port: (sessionId, images) => {
      calls.push({ sessionId, order: images.map((i) => i.data) })
      const mode = script[batch] ?? 'ok'
      batch++
      if (mode === 'quota') {
        return Promise.resolve({
          results: images.map((_, i) => (i === 0 ? { status: 'written' as const, path: `/cache/${sessionId}/${images[0]!.data}.png`, bytes: 10 } : { status: 'quota-full' as const })),
          quotaFull: true,
        })
      }
      return Promise.resolve(okResult(images.map((i) => `/cache/${sessionId}/${i.data}.png`)))
    },
  }
}

beforeEach(() => {
  _resetImageCacheForTest()
})

afterEach(() => {
  _resetImageCacheForTest()
})

describe('collectImagesFromMessages', () => {
  it('按消息序收集 toolCalls.images，跳过空 data 与 user 消息 images', () => {
    const a = img('A')
    const b = img('B')
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '', status: 'complete', timestamp: 0, images: [img('USER')] },
      { id: 'a1', role: 'assistant', content: '', status: 'complete', timestamp: 0, toolCalls: [{ id: 't1', toolName: 'shot', input: {}, status: 'completed', startTime: 0, images: [a] }] },
      { id: 'a2', role: 'assistant', content: '', status: 'complete', timestamp: 0, toolCalls: [{ id: 't2', toolName: 'shot', input: {}, status: 'completed', startTime: 0, images: [b, { data: '', mimeType: 'image/png' }] }] },
    ]
    expect(collectImagesFromMessages(messages)).toEqual([a, b])
  })
})

describe('persistImagesNewestFirst（hydrate 新→旧有序编排）', () => {
  it('消息序（旧→新）输入 → port 收到反序（新→旧）——设计 v8 落盘顺序契约', async () => {
    const { port, calls } = makeRecordingPort()
    setImageCacheWritePort(port)
    // 收集顺序 = 消息序：图1(旧) → 图2(新)
    await persistImagesNewestFirst('s1', [img('old-1'), img('new-2')])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.order).toEqual(['new-2', 'old-1'])
  })

  it('quota-full 后 session 标记帽满，已写图记入路径表', async () => {
    const { port } = makeRecordingPort(['quota'])
    setImageCacheWritePort(port)
    const first = img('first')
    const second = img('second')
    // 消息序（旧→新）=[first, second]；反序落盘 [second, first]——quota 脚本写新图、弃旧图
    await persistImagesNewestFirst('s1', [first, second])
    expect(getCachedImagePath(second)).toBe('/cache/s1/second.png')
    expect(getCachedImagePath(first)).toBeUndefined()
    expect(isSessionImageCacheFull('s1')).toBe(true)
  })

  it('已记账（内容 hash 命中）的图不重复交 port（幂等编排）', async () => {
    const { port, calls } = makeRecordingPort()
    setImageCacheWritePort(port)
    const seen = img('seen')
    await persistImagesNewestFirst('s1', [seen])
    await persistImagesNewestFirst('s1', [seen]) // 重进/重复 hydrate：pending 全被剔除，不再发 port
    expect(calls).toHaveLength(1)
  })

  it('空列表 / port 缺省 / port 抛错：静默 no-op（fire-and-forget 契约）', async () => {
    await expect(persistImagesNewestFirst('s1', [])).resolves.toBeUndefined()
    await expect(persistImagesNewestFirst('s1', [img('X')])).resolves.toBeUndefined() // 无 port
    setImageCacheWritePort(vi.fn(() => Promise.reject(new Error('ipc down'))))
    await expect(persistImagesNewestFirst('s1', [img('X')])).resolves.toBeUndefined()
  })
})

describe('requestImageWrite（live 单图）', () => {
  it('写入成功记路径；帽满（quota-full 结果）后同 session 新图快速失败不再发 port', async () => {
    let quotaFullNext = false
    const port = vi.fn((_sid: string, images: ImageCacheWriteImage[]): Promise<ImageCacheWriteResult> => {
      if (quotaFullNext) {
        return Promise.resolve({ results: images.map(() => ({ status: 'quota-full' as const })), quotaFull: true })
      }
      return Promise.resolve(okResult(images.map((i) => `/cache/s2/${i.data}.png`)))
    }) as unknown as ImageCacheWritePort
    setImageCacheWritePort(port)
    const live = img('live-1')
    await expect(requestImageWrite('s2', live)).resolves.toBe('/cache/s2/live-1.png')
    // 翻转脚本：下一张命中帽 → quota-full → 标记 session 帽满
    quotaFullNext = true
    const full = img('hits-cap')
    await expect(requestImageWrite('s2', full)).resolves.toBeUndefined()
    expect(isSessionImageCacheFull('s2')).toBe(true)
    // 帽满后：新图直接占位（port 不再被调）
    const after = img('after-full')
    await expect(requestImageWrite('s2', after)).resolves.toBeUndefined()
    expect(port).toHaveBeenCalledTimes(2)
  })

  it('in-flight 去重：同内容并发请求共享同一写入（不双发 port）', async () => {
    const port = vi.fn((_sid: string, images: ImageCacheWriteImage[]) =>
      Promise.resolve(okResult(images.map((i) => `/cache/s3/${i.data}.png`))),
    ) as unknown as ImageCacheWritePort
    setImageCacheWritePort(port)
    const shared = img('shared')
    const [r1, r2] = await Promise.all([requestImageWrite('s3', shared), requestImageWrite('s3', shared)])
    expect(r1).toBe('/cache/s3/shared.png')
    expect(r2).toBe(r1)
    expect(port).toHaveBeenCalledTimes(1)
  })
})
