/**
 * gitcode-release-sync.mjs 单测（MF-3）：
 * assetList / buildExistingAssetMap（分页形态字段候选 + 同名去重 + size null 语义）
 * 与 fetchUploadTarget（成功补默认 header / 失败信号），mock fetch 不打真 API。
 * runProbe 全链路失败信号 = fetchUploadTarget 非 ok 时 throw 的恢复指引文案（下方锁定）。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

beforeAll(() => {
  process.env.GITCODE_TOKEN = 'test-token'
  process.env.GITCODE_REPO = 'owner/repo'
})

async function loadModule() {
  vi.resetModules()
  return import('../gitcode-release-sync.mjs')
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  }
}

describe('assetList', () => {
  it('assets 标准形态（name + size 缺失 → null）', async () => {
    const { assetList } = await loadModule()
    const list = assetList({ assets: [{ name: 'a.dmg' }, { name: 'b.exe', size: 5 }] })
    expect(list).toEqual([
      { name: 'a.dmg', size: null },
      { name: 'b.exe', size: 5 },
    ])
  })
  it('attach_files / attachFiles 备选字段名 + 候选 size 字段名（filesize/file_size/attach_size）', async () => {
    const { assetList } = await loadModule()
    expect(assetList({ attach_files: [{ file_name: 'x', filesize: 3 }] })).toEqual([{ name: 'x', size: 3 }])
    expect(assetList({ attachFiles: [{ path: 'y', file_size: '7' }] })).toEqual([{ name: 'y', size: 7 }])
    expect(assetList({ assets: [{ filename: 'z', attach_size: 1 }] })).toEqual([{ name: 'z', size: 1 }])
  })
  it('assets 非数组 / name 空条目过滤 / releaseJson null 安全', async () => {
    const { assetList } = await loadModule()
    expect(assetList({ assets: 'nope' })).toEqual([])
    expect(assetList({ assets: [{ size: 1 }, { name: 'ok' }] })).toEqual([{ name: 'ok', size: null }])
    expect(assetList(null)).toEqual([])
  })
})

describe('buildExistingAssetMap（runSync 幂等跳过判定）', () => {
  it('同名条目去重（Map 构造 last-wins），null size 语义保留（同名即跳过）', async () => {
    const { buildExistingAssetMap } = await loadModule()
    const m = buildExistingAssetMap({
      assets: [{ name: 'a', size: 1 }, { name: 'a', size: 2 }, { name: 'b' }],
    })
    expect(m.get('a')).toBe(2)
    expect(m.get('b')).toBeNull()
    expect(m.size).toBe(2)
  })
})

describe('fetchUploadTarget', () => {
  it('成功：相对 upload_url 补 API 域 + headers 缺 Content-Type 就地补默认', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ upload_url: '/presigned/xyz', headers: { 'x-oss': '1' } }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { fetchUploadTarget } = await loadModule()
      const t = await fetchUploadTarget('v1.0.0', 'app.dmg')
      expect(t.finalUrl).toBe('https://api.gitcode.com/presigned/xyz')
      expect(t.headerArgs).toContain('-H \'x-oss: 1\'')
      expect(t.headerArgs).toContain('-H \'Content-Type: application/octet-stream\'')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('失败信号：非 ok 时 throw 恢复指引（确认 release 存在 + 文档核对）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { fetchUploadTarget } = await loadModule()
      await expect(fetchUploadTarget('v1.0.0', 'app.dmg')).rejects.toThrow(/获取附件上传地址失败（HTTP 404）/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('失败信号：响应无 upload_url/url 字段时 throw（API 形态漂移显式报错）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ foo: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { fetchUploadTarget } = await loadModule()
      await expect(fetchUploadTarget('v1.0.0', 'app.dmg')).rejects.toThrow(/无 upload_url\/url 字段/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
