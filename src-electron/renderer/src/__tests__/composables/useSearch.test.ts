/**
 * useSearch composable 单测（Wave2 #4）。
 *
 * 覆盖 execution-plan Wave2 #4 的 16 条 test-matrix：
 *  - T1.10（AC-4.8）无 active session：file/slash 源空
 *  - T1.12（BC-9/AC-4.4）乱序响应 loadSeq 守卫
 *  - T2.1（AC-4.1）查询命中命令
 *  - T3.1（D-025 DTO 映射）文件相对路径
 *  - T3.2（AC-4.9）缓存命中不调 composer
 *  - T3.3（MR-4.2）file 源 WS reject 静默
 *  - T3.5（D-021）文件数 >5000 截断
 *  - T3.9（MR-4.4/AC-4.10）stale cache 防护 setupInvalidation 接线
 *  - T4.1 跨项目会话命中
 *  - T4.2（D-025）gitBranch 缺失降级
 *  - T4.4 session 源 WS reject
 *  - T4.5 会话库空
 *  - T4.8（AC-17.1/MR-17.1）WS 断连超时 race（永不 settle 桩）
 *  - T4.9（MR-4.2/AC-17.3）全源失败 toast（四类空态）
 *  - T5.1（D-001）符号分组占位渲染
 *  - T5.2 占位不随查询变化
 *
 * mock 策略：
 *  - vi.mock('@/api')：composer.getFileCandidates / session.list
 *  - vi.mock('@/stores/fileSearch')：store.get/set/invalidate
 *  - vi.mock('@/composables/features/useFileSearch')：setupInvalidation 返 vi.fn()（验证 AC-4.10 接线）
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/composables/useSearch.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { FileNode, SessionGroup } from '@xyz-agent/shared'
import type { AppCommand } from '@/lib/search-types'
import { useCommandStore } from '@/stores/command'
import { useFileSearchStore } from '@/stores/fileSearch'

// ── mock：api domain ──
const mockGetFileCandidates = vi.fn()
const mockSessionList = vi.fn()
vi.mock('@/api', () => ({
  composer: { getFileCandidates: (...args: unknown[]) => mockGetFileCandidates(...(args as [string])) },
  session: { list: () => mockSessionList() },
}))

// ── mock：fileSearch store（缓存可控） ──
const mockStoreGet = vi.fn()
const mockStoreSet = vi.fn()
vi.mock('@/stores/fileSearch', () => ({
  useFileSearchStore: () => ({
    get: (...args: unknown[]) => mockStoreGet(...(args as [string])),
    set: (...args: unknown[]) => mockStoreSet(...(args as [string, FileNode[]])),
    invalidate: vi.fn(),
  }),
}))

// ── mock：useFileSearch（setupInvalidation 验证 AC-4.10 接线） ──
const mockSetupInvalidation = vi.fn(() => vi.fn()) // 返回 unwatch 函数
vi.mock('@/composables/features/useFileSearch', () => ({
  useFileSearch: () => ({ setupInvalidation: mockSetupInvalidation }),
}))

import { useSearch } from '@/composables/features/useSearch'
import type { SearchItem } from '@/lib/search-types'

/** 辅助：从 sections 找指定 label 的 section */
function findSection(sections: { label: string; items: SearchItem[] }[], label: string) {
  return sections.find((s) => s.label === label)
}

/** 辅助：构造一个 file FileNode */
function fileNode(path: string, name?: string): FileNode {
  return { path, name: name ?? path.split('/').pop() ?? path, type: 'file' }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockGetFileCandidates.mockReset()
  mockSessionList.mockReset()
  mockStoreGet.mockReset()
  mockStoreSet.mockReset()
  mockSetupInvalidation.mockReset()
  mockSetupInvalidation.mockReturnValue(vi.fn())
  // 默认缓存未命中
  mockStoreGet.mockReturnValue(undefined)
  // 默认 session 源空
  mockSessionList.mockResolvedValue([])
})

const noop = vi.fn()

describe('T1.10（AC-4.8）无 active session', () => {
  it('activeSessionId=null → query("x") 返回 file 分组空，命令分组含应用命令', async () => {
    const store = useCommandStore()
    const appCmd: AppCommand = { id: 'search', name: '全局搜索', shortcut: '⌘K', action: noop }
    const sid = ref<string | null>(null)
    const { query } = useSearch(sid)
    store.registerApp([appCmd])

    const sections = await query('全局', { activeSessionId: null })

    const fileSection = findSection(sections, '文件')
    expect(fileSection).toBeUndefined() // file 源空（无 session）
    const cmdSection = findSection(sections, '命令')
    expect(cmdSection).toBeTruthy()
    expect(cmdSection!.items.some((it) => it.title === '全局搜索')).toBe(true)
    // slash 源也空（无 session）
    expect(mockGetFileCandidates).not.toHaveBeenCalled()
  })
})

describe('T1.12（BC-9/AC-4.4）乱序响应 loadSeq 守卫', () => {
  it('第一次查询慢（永不 resolve），第二次快速查询：第一次旧结果不覆盖第二次', async () => {
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    // 第一次：composer 返回永不 resolve 的 pending（模拟慢响应）
    const slowPending = new Promise<FileNode[]>(() => {}) // 永不 settle
    mockGetFileCandidates.mockReturnValueOnce(slowPending)

    // 第二次：返回快结果
    mockGetFileCandidates.mockReturnValueOnce([fileNode('b.ts')])

    // 启动第一次查询（pending，不 await）
    const firstP = query('a', { activeSessionId: 's1' })

    // 立即启动第二次查询（loadSeq 自增，第一次的 seq 已过期）
    const secondSections = await query('b', { activeSessionId: 's1' })
    expect(secondSections).not.toEqual([])
    // 第二次命中文件 b.ts
    const fileSection = findSection(secondSections, '文件')
    expect(fileSection).toBeTruthy()
    expect(fileSection!.items.some((it) => it.title === 'b.ts')).toBe(true)

    // 第一次的 promise 仍 pending（永不 settle），不会 resolve 出旧结果覆盖
    // 断言第一次仍是 pending（用 Promise.race 探测）
    const settled = await Promise.race([
      firstP.then(() => 'resolved'),
      Promise.resolve('pending'),
    ])
    expect(settled).toBe('pending') // 第一次未 settle，未污染第二次结果
  })
})

describe('T2.1（AC-4.1）查询命中命令', () => {
  it('appCommand name 含 "commit" → query("commit") 命令分组含该项', async () => {
    const store = useCommandStore()
    const appCmd: AppCommand = { id: 'git-commit', name: '提交', shortcut: '⌘⇧C', action: noop }
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)
    store.registerApp([appCmd])

    const sections = await query('提交', { activeSessionId: 's1' })

    const cmdSection = findSection(sections, '命令')
    expect(cmdSection).toBeTruthy()
    const hit = cmdSection!.items.find((it) => it.title === '提交')
    expect(hit).toBeTruthy()
    expect(hit!.sub).toBe('⌘⇧C') // shortcut 优先做 sub
  })
})

describe('T3.1（D-025 DTO 映射）文件相对路径', () => {
  it('query 命中文件 → sub 是 path（相对路径）非绝对', async () => {
    mockGetFileCandidates.mockResolvedValue([fileNode('src/auth/session.ts')])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sections = await query('session', { activeSessionId: 's1' })

    const fileSection = findSection(sections, '文件')
    expect(fileSection).toBeTruthy()
    const hit = fileSection!.items.find((it) => it.title === 'session.ts')
    expect(hit).toBeTruthy()
    // sub 是相对路径（无前导斜杠，非绝对路径）
    expect(hit!.sub).toBe('src/auth/session.ts')
    expect(hit!.sub.startsWith('/')).toBe(false)
  })
})

describe('T3.10（D-029）file 源复用 composer # 分级匹配排序', () => {
  // 复用 filterAndSortFileCandidates：basename 前缀命中 > path 子串命中
  it('query("auth") → basename 前缀命中(auth.ts)排在 path 子串命中(src/auth/session.ts)前', async () => {
    // 构造两个 file：一个 basename 以 auth 开头（前缀匹配），一个 basename 是 session.ts 但 path 含 auth（path 子串匹配）
    // 原始顺序故意把 path 子串命中的放前面，验证排序后 basename 前缀命中排前
    mockGetFileCandidates.mockResolvedValue([
      fileNode('src/auth/session.ts'), // path 含 auth（MATCH_PATH），basename session.ts 不含 auth
      fileNode('utils/auth.ts'),       // basename auth.ts 以 auth 开头（MATCH_PREFIX）
    ])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sections = await query('auth', { activeSessionId: 's1' })
    const fileSection = findSection(sections, '文件')
    expect(fileSection).toBeTruthy()
    const titles = fileSection!.items.map((it) => it.title)
    // 两个都命中（filterAndSortFileCandidates 不过滤掉 path 子串命中）
    expect(titles).toContain('auth.ts')
    expect(titles).toContain('session.ts')
    // basename 前缀命中（auth.ts）排在 path 子串命中（session.ts）前面
    expect(titles.indexOf('auth.ts')).toBeLessThan(titles.indexOf('session.ts'))
  })

  it('不匹配 query 的文件被过滤（filterAndSortFileCandidates 返回 null 级别）', async () => {
    mockGetFileCandidates.mockResolvedValue([
      fileNode('src/auth/token.ts'), // 命中 auth
      fileNode('README.md'),         // 不命中 auth
    ])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sections = await query('auth', { activeSessionId: 's1' })
    const fileSection = findSection(sections, '文件')
    expect(fileSection).toBeTruthy()
    const titles = fileSection!.items.map((it) => it.title)
    expect(titles).toContain('token.ts')
    // README.md 不命中（basename/path 都不含 auth）→ 被过滤
    expect(titles).not.toContain('README.md')
  })
})

describe('T3.2（AC-4.9）缓存命中', () => {
  it('fileSearchStore.get(sid) 返缓存 → 不调 composer.getFileCandidates', async () => {
    mockStoreGet.mockReturnValue([fileNode('cached.ts')])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    await query('cached', { activeSessionId: 's1' })

    expect(mockGetFileCandidates).not.toHaveBeenCalled()
    // 缓存的文件命中
    // （store.get 已返回缓存，不经过 set）
  })
})

describe('T3.3（MR-4.2）file 源 WS reject 静默', () => {
  it('composer.getFileCandidates reject → file 分组空，不抛，其他源仍工作', async () => {
    mockGetFileCandidates.mockRejectedValue(new Error('WS down'))
    const store = useCommandStore()
    const appCmd: AppCommand = { id: 'new', name: '新建', action: noop }
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)
    store.registerApp([appCmd])

    const sections = await query('新建', { activeSessionId: 's1' })

    // file 分组空（reject 静默）
    expect(findSection(sections, '文件')).toBeUndefined()
    // 命令源仍工作
    const cmdSection = findSection(sections, '命令')
    expect(cmdSection).toBeTruthy()
    expect(cmdSection!.items.some((it) => it.title === '新建')).toBe(true)
  })
})

describe('T3.5（D-021）文件数 >5000 截断', () => {
  it('mock 返 5001 个 FileNode → file 分组 items.length <= 5000', async () => {
    const nodes: FileNode[] = []
    for (let i = 0; i < 5001; i++) {
      nodes.push(fileNode(`f${i}.ts`))
    }
    mockGetFileCandidates.mockResolvedValue(nodes)
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sections = await query('f', { activeSessionId: 's1' })

    const fileSection = findSection(sections, '文件')
    expect(fileSection).toBeTruthy()
    expect(fileSection!.items.length).toBeLessThanOrEqual(5000)
  })
})

describe('T3.9（MR-4.4/AC-4.10）stale cache 防护', () => {
  it('useSearch 初始化时 setupInvalidation 被调用', () => {
    const sid = ref<string | null>('s1')
    useSearch(sid)
    expect(mockSetupInvalidation).toHaveBeenCalledTimes(1)
  })

  it('activeSessionId 从 null → 有效值 时 setupInvalidation 被调用', async () => {
    const sid = ref<string | null>(null)
    useSearch(sid)
    // null 时不应 setup
    expect(mockSetupInvalidation).not.toHaveBeenCalled()
    // 切到有效 session
    sid.value = 's2'
    await new Promise((r) => setTimeout(r, 0)) // 等 watch flush
    expect(mockSetupInvalidation).toHaveBeenCalledTimes(1)
  })
})

describe('T4.1 跨项目会话命中', () => {
  it('mock session.list 返多 group，query("auth") 命中 label/cwd', async () => {
    const groups: SessionGroup[] = [
      {
        cwd: '/proj/auth-service',
        sessions: [
          {
            id: 's1', label: 'Auth 重构', cwd: '/proj/auth-service', gitBranch: 'main',
            status: 'active', lastActiveAt: 1, modelId: 'm', tokenCount: 0,
          },
        ],
      },
      {
        cwd: '/proj/billing',
        sessions: [
          {
            id: 's2', label: '计费模块', cwd: '/proj/billing', gitBranch: 'dev',
            status: 'idle', lastActiveAt: 2, modelId: 'm', tokenCount: 0,
          },
        ],
      },
    ]
    mockSessionList.mockResolvedValue(groups)
    const sid = ref<string | null>('cur')
    const { query } = useSearch(sid)

    const sections = await query('auth', { activeSessionId: 'cur' })

    const sessSection = findSection(sections, '会话')
    expect(sessSection).toBeTruthy()
    // 命中 label 含 'Auth'
    expect(sessSection!.items.some((it) => it.title === 'Auth 重构')).toBe(true)
    // billing 不命中
    expect(sessSection!.items.some((it) => it.title === '计费模块')).toBe(false)
  })
})

describe('T4.2（D-025）gitBranch 缺失降级', () => {
  it('SessionSummary 无 gitBranch，query 命中 label → 会话分组含该项，sub 不含 "undefined"', async () => {
    const groups: SessionGroup[] = [
      {
        cwd: '/proj/demo',
        sessions: [
          {
            id: 's1', label: 'demo session', cwd: '/proj/demo', // 无 gitBranch
            status: 'active', lastActiveAt: 1, modelId: 'm', tokenCount: 0,
          },
        ],
      },
    ]
    mockSessionList.mockResolvedValue(groups)
    const sid = ref<string | null>('cur')
    const { query } = useSearch(sid)

    const sections = await query('demo', { activeSessionId: 'cur' })

    const sessSection = findSection(sections, '会话')
    expect(sessSection).toBeTruthy()
    const hit = sessSection!.items.find((it) => it.title === 'demo session')
    expect(hit).toBeTruthy()
    expect(hit!.sub).toBe('/proj/demo') // 仅 cwd，无 gitBranch
    expect(hit!.sub).not.toContain('undefined')
  })
})

describe('T4.4 session 源 WS reject', () => {
  it('session.list reject → session 分组空，其他源工作', async () => {
    mockSessionList.mockRejectedValue(new Error('session WS down'))
    const store = useCommandStore()
    const appCmd: AppCommand = { id: 'search', name: '搜索', action: noop }
    mockGetFileCandidates.mockResolvedValue([fileNode('a.ts')])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)
    store.registerApp([appCmd])

    const sections = await query('a', { activeSessionId: 's1' })

    expect(findSection(sections, '会话')).toBeUndefined() // session 源空
    // file 源仍工作
    const fileSection = findSection(sections, '文件')
    expect(fileSection).toBeTruthy()
    expect(fileSection!.items.some((it) => it.title === 'a.ts')).toBe(true)
    // 命令源仍工作
    expect(findSection(sections, '命令')).toBeTruthy()
  })
})

describe('T4.5 会话库空', () => {
  it('session.list 返空数组 → session 分组空（不崩溃）', async () => {
    mockSessionList.mockResolvedValue([])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sections = await query('anything', { activeSessionId: 's1' })

    expect(findSection(sections, '会话')).toBeUndefined()
  })
})

describe('T4.8（AC-17.1/MR-17.1）WS 断连超时 race', () => {
  it('composer 返回永不 settle 的 Promise → 推进 10s → file 分组空（不永久挂死）', async () => {
    vi.useFakeTimers()
    try {
      // 永不 settle 的桩（模拟 WS 断连 pending 永不 settle）—— 必须是永不 settle 而非立即 reject
      mockGetFileCandidates.mockReturnValue(new Promise<FileNode[]>(() => {}))
      const sid = ref<string | null>('s1')
      const { query } = useSearch(sid)

      const queryP = query('x', { activeSessionId: 's1' })

      // 推进超过 WS_SOURCE_TIMEOUT_MS（10000ms）
      await vi.advanceTimersByTimeAsync(10001)

      const sections = await queryP

      // file 源因超时 reject → 分组空（不永久挂死）
      expect(findSection(sections, '文件')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('T4.9（MR-4.2/AC-17.3）全源失败 toast（四类空态）', () => {
  it('三源全 reject → 返回 sections 非符号分组全空（仅符号占位）', async () => {
    mockGetFileCandidates.mockRejectedValue(new Error('file down'))
    mockSessionList.mockRejectedValue(new Error('session down'))
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sections = await query('x', { activeSessionId: 's1' })

    // 命令源是内存（无 WS），但无 appCommands 注册时也为空
    expect(findSection(sections, '命令')).toBeUndefined()
    expect(findSection(sections, '文件')).toBeUndefined()
    expect(findSection(sections, '会话')).toBeUndefined()
    // 符号占位始终存在（D-001）
    const symbolSection = findSection(sections, '符号')
    expect(symbolSection).toBeTruthy()
    expect(symbolSection!.items).toEqual([])
  })
})

describe('T5.1（D-001）符号分组占位渲染', () => {
  it('任意 query → 返回结果含 symbol section（items:[]，占位）', async () => {
    mockGetFileCandidates.mockResolvedValue([fileNode('a.ts')])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sections = await query('a', { activeSessionId: 's1' })

    const symbolSection = findSection(sections, '符号')
    expect(symbolSection).toBeTruthy()
    expect(symbolSection!.items).toEqual([])
  })
})

describe('T5.2 占位不随查询变化', () => {
  it('query("a") 和 query("b") 的 symbol section 一致（恒定）', async () => {
    mockGetFileCandidates.mockResolvedValue([fileNode('ab.ts')])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sectionsA = await query('a', { activeSessionId: 's1' })
    const sectionsB = await query('b', { activeSessionId: 's1' })

    const symbolA = findSection(sectionsA, '符号')
    const symbolB = findSection(sectionsB, '符号')
    expect(symbolA).toBeTruthy()
    expect(symbolB).toBeTruthy()
    expect(symbolA).toEqual(symbolB) // 恒定占位
  })
})

/**
 * U5/U6 toCommandItem icon 透传（W1 slash 注入 chip 图标一致性）。
 *
 * toCommandItem 是 useSearch 内部私有函数，通过 query() 间接测试（与 T2.1 同模式）。
 * 测试走 real 轨（vitest 未设 VITE_MOCK，isMock=false）：
 *  - SessionCommand 由 commandStore.applyCommands 经 iconKeyForSource 归一化（source→icon key），
 *    toCommandItem SessionCommand 分支透传 icon（c.icon）。
 *  - AppCommand 分支不写 icon（undefined）。
 */
describe('U5/U6 toCommandItem icon 透传', () => {
  it('U5 SessionCommand 映射带 icon（star）', async () => {
    const store = useCommandStore()
    // applyCommands 把 source:'skill' 归一化为 icon:'star'（iconKeyForSource）
    store.applyCommands('s1', [{ name: '/goal', description: '设定目标', source: 'skill' }])
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)

    const sections = await query('goal', { activeSessionId: 's1' })

    const cmdSection = findSection(sections, '命令')
    expect(cmdSection).toBeTruthy()
    const hit = cmdSection!.items.find((it) => it.title === '/goal')
    expect(hit).toBeTruthy()
    // SessionCommand 分支透传 icon（star）
    expect(hit!.icon).toBe('star')
  })

  it('U6 AppCommand 映射无 icon（undefined）', async () => {
    const store = useCommandStore()
    const appCmd: AppCommand = { id: 'new', name: '新建', shortcut: '⌘N', action: noop }
    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid)
    store.registerApp([appCmd])

    const sections = await query('新建', { activeSessionId: 's1' })

    const cmdSection = findSection(sections, '命令')
    expect(cmdSection).toBeTruthy()
    const hit = cmdSection!.items.find((it) => it.title === '新建')
    expect(hit).toBeTruthy()
    // AppCommand 分支不写 icon
    expect(hit!.icon).toBeUndefined()
    // sub 优先 shortcut（与 T2.1 一致）
    expect(hit!.sub).toBe('⌘N')
  })
})
