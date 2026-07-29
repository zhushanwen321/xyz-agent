/**
 * DetailPane 组件单测：header 文件路径查看与复制 + 远程/本地图片加载（T6 wave w1）。
 *
 * 覆盖：
 * - header 显示文件名 + 复制绝对路径按钮
 * - hover 文件名时 tooltip 展示绝对路径 + 复制文件名按钮
 * - 点击复制按钮写入剪贴板
 * - TC1 本地模式 imageUrl 保持 local-file:// 协议（零回归）
 * - TC2 远程模式 imageUrl 走 signUrl + http origin 拼 src
 * - TC3 防竞态：快速切换 path 时旧 signUrl 晚到不覆盖新图
 * - TC4 signUrl RPC 失败 → 降级占位（复用 imageLoadFailed）
 * - TC5 切文件时 imageLoadFailed 重置（切文件重试语义）
 *
 * mock 策略：vi.mock('@/composables/features/useDetailPane') 控制 state 与 sessionCwd，
 * vi.mock('@/lib/remote/connection-config') 控制 isRemoteMode/getActiveProfile，
 * vi.mock('@/api/domains/file') 控制 signUrl 返回值/pending/reject，
 * HoverCard 相关子组件 stub 掉以便断言 tooltip 内容。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/DetailPane.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DetailPane from '@/components/panel/DetailPane.vue'

const mockToggleView = vi.fn()

// 可控 state ref（各用例 mutate path 触发 watch）
const mockState = ref({
  path: 'src/index.ts',
  status: 'content' as const,
  content: '',
  truncated: false,
  binary: false,
  error: '',
  viewMode: 'preview' as const,
  hasGitChange: false,
  kind: 'text' as const,
})

vi.mock('@/composables/features/useDetailPane', () => ({
  useDetailPane: () => ({
    state: mockState,
    toggleView: mockToggleView,
    sessionCwd: (sid: string | null) => (sid ? '/Users/demo/project' : null),
  }),
}))

// 远程模式判定 mock（各 describe 设定）
let remoteMode = false
let activeProfileUrl = 'ws://myserver.tail.ts.net:3210'
// isRemoteMode()=true 但 getActiveProfile() 返回 null（active-server-id 指向的 profile 被外部清掉）
let profileIsNull = false
vi.mock('@/lib/remote/connection-config', () => ({
  isRemoteMode: () => remoteMode,
  getActiveProfile: () => (remoteMode && !profileIsNull ? { id: 'srv1', name: 's', url: activeProfileUrl, token: 't', networkKind: 'tail' } : null),
}))

// signUrl mock（各用例控制返值/pending/reject）
const signUrlMock = vi.fn()
vi.mock('@/api/domains/file', () => ({
  signUrl: (path: string) => signUrlMock(path),
}))

function mountDetailPane() {
  return mount(DetailPane, {
    props: { sessionId: 's1' },
    global: {
      stubs: {
        MarkdownRenderer: { template: '<div data-testid="markdown-stub" />' },
        CodeBlock: { template: '<div data-testid="codeblock-stub" />' },
        DiffView: { template: '<div data-testid="diffview-stub" />' },
        HoverCard: { template: '<div class="hover-card-stub"><slot /></div>' },
        HoverCardTrigger: { template: '<div class="hover-card-trigger-stub"><slot /></div>' },
        HoverCardContent: { template: '<div class="hover-card-content-stub"><slot /></div>' },
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  remoteMode = false
  activeProfileUrl = 'ws://myserver.tail.ts.net:3210'
  profileIsNull = false
  signUrlMock.mockReset()
  // 重置 state 到非图片初始态（各用例按需改 path/kind）
  mockState.value = {
    path: 'src/index.ts',
    status: 'content',
    content: '',
    truncated: false,
    binary: false,
    error: '',
    viewMode: 'preview',
    hasGitChange: false,
    kind: 'text',
  }
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  })
})

describe('DetailPane header 文件路径查看与复制', () => {
  it('U1: 显示文件名和复制绝对路径按钮', () => {
    const wrapper = mountDetailPane()
    expect(wrapper.text()).toContain('index.ts')
    const btn = wrapper.find('[data-testid="detail-copy-path"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('复制路径')
  })

  it('U2: hover 文件名时 tooltip 内展示绝对路径和复制文件名按钮', async () => {
    const wrapper = mountDetailPane()
    const filename = wrapper.find('[data-testid="detail-filename"]')
    expect(filename.exists()).toBe(true)
    await filename.trigger('mouseenter')
    const tooltip = wrapper.find('[data-testid="detail-path-tooltip"]')
    expect(tooltip.exists()).toBe(true)
    expect(tooltip.text()).toContain('/Users/demo/project/src/index.ts')
    expect(tooltip.find('[data-testid="detail-copy-filename"]').attributes('title')).toBe('复制文件名')
  })

  it('U3: 点击复制绝对路径按钮写入剪贴板', async () => {
    const wrapper = mountDetailPane()
    const btn = wrapper.find('[data-testid="detail-copy-path"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/Users/demo/project/src/index.ts')
  })

  it('U4: 点击 tooltip 内复制文件名按钮写入剪贴板', async () => {
    const wrapper = mountDetailPane()
    const filename = wrapper.find('[data-testid="detail-filename"]')
    await filename.trigger('mouseenter')
    const btn = wrapper.find('[data-testid="detail-copy-filename"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('index.ts')
  })
})

describe('DetailPane i18n 契约', () => {
  it('E1: 中英文 locale 均包含复制相关文案', async () => {
    const { default: zh } = await import('@/i18n/locales/zh-CN/panel')
    const { default: en } = await import('@/i18n/locales/en-US/panel')
    expect(zh.detail.copyFilePath).toBe('复制路径')
    expect(zh.detail.copyFileName).toBe('复制文件名')
    expect(en.detail.copyFilePath).toBe('Copy path')
    expect(en.detail.copyFileName).toBe('Copy file name')
  })
})

/**
 * 图片加载用例辅助：把 mockState 切到图片文件并 flush watch。
 * kind='image' 触发 detail-image 分支（v-else-if state.kind === 'image'）。
 */
async function setImgState(path: string) {
  mockState.value = { ...mockState.value, path, kind: 'image' }
  // watch immediate 已在挂载时触发一次；改 path 后 watch 回调异步执行，flush 之
  await wrapperFlush()
}

// vue nextTick flush（mounted wrapper 在用例内创建，此处仅 flush 微任务）
async function wrapperFlush() {
  // 多次微任务循环确保 watch + signUrl Promise 都 settle
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

describe('DetailPane 本地图片零回归（TC1/TC5）', () => {
  beforeEach(() => {
    remoteMode = false
  })

  it('TC1: 本地模式 imageUrl 走 local-file:// 协议（与改造前 computed 逐字节一致）', async () => {
    signUrlMock.mockResolvedValue({ url: '/file?should-not-call', expiresAt: 0 })
    const wrapper = mountDetailPane()
    await setImgState('assets/logo.png')

    const img = wrapper.find('[data-testid="detail-image"] img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(
      'local-file:///%2FUsers%2Fdemo%2Fproject%2Fassets%2Flogo.png',
    )
    // 本地模式不应调用 signUrl RPC
    expect(signUrlMock).not.toHaveBeenCalled()
  })

  it('TC5: 切文件时 imageLoadFailed 重置，新 path 的 imageUrl 重新生效', async () => {
    const wrapper = mountDetailPane()
    await setImgState('a.png')
    // 触发 img onerror → imageLoadFailed=true → 占位显示
    const imgBefore = wrapper.find('[data-testid="detail-image"] img')
    await imgBefore.trigger('error')
    // 占位分支渲染（img 消失，loadFailed 文案出现）
    expect(wrapper.find('[data-testid="detail-image"] img').exists()).toBe(false)

    // 切到新文件，imageLoadFailed 应重置，新 imageUrl 生效
    await setImgState('b.png')
    const imgAfter = wrapper.find('[data-testid="detail-image"] img')
    expect(imgAfter.exists()).toBe(true)
    expect(imgAfter.attributes('src')).toBe(
      'local-file:///%2FUsers%2Fdemo%2Fproject%2Fb.png',
    )
  })
})

describe('DetailPane 远程图片 signUrl（TC2/TC3/TC4）', () => {
  beforeEach(() => {
    remoteMode = true
    activeProfileUrl = 'ws://myserver.tail.ts.net:3210'
  })

  it('TC2: 远程模式 imageUrl 走 signUrl + http origin 拼 src', async () => {
    signUrlMock.mockResolvedValue({
      url: '/file?path=/abs.png&sig=abc&expires=999',
      expiresAt: 999,
    })
    const wrapper = mountDetailPane()
    await setImgState('assets/logo.png')

    // signUrl 被调用（kind=image 时），参数是 resolvePreviewPath 后的绝对路径
    expect(signUrlMock).toHaveBeenCalled()
    expect(signUrlMock).toHaveBeenCalledWith('/Users/demo/project/assets/logo.png')

    const img = wrapper.find('[data-testid="detail-image"] img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(
      'http://myserver.tail.ts.net:3210/file?path=/abs.png&sig=abc&expires=999',
    )
  })

  it('TC3: 防竞态——快速切换 path 时旧 signUrl 晚到不覆盖新图', async () => {
    // 第一次 signUrl 返 pending（手动控制 resolve），第二次立即 resolve
    let resolveFirst!: (v: { url: string; expiresAt: number }) => void
    const firstPending = new Promise<{ url: string; expiresAt: number }>((r) => {
      resolveFirst = r
    })
    let callCount = 0
    signUrlMock.mockImplementation(() => {
      callCount++
      if (callCount === 1) return firstPending
      return Promise.resolve({ url: '/file?second.png&sig=2', expiresAt: 2 })
    })

    const wrapper = mountDetailPane()
    // 切到 a.png 触发第一次 signUrl（pending）
    await setImgState('a.png')
    // 切到 b.png 触发第二次 signUrl（立即 resolve）—— reqId 递增
    await setImgState('b.png')
    await wrapperFlush()

    // 此时第二次结果应已生效（reqId 最新）
    const imgAfterSecond = wrapper.find('[data-testid="detail-image"] img')
    expect(imgAfterSecond.exists()).toBe(true)
    expect(imgAfterSecond.attributes('src')).toContain('second.png')

    // 现在让第一次晚到的 signUrl resolve（reqId 已过期，应被丢弃）
    resolveFirst({ url: '/file?STALE-first.png&sig=1', expiresAt: 1 })
    await wrapperFlush()

    // imageUrl 不被晚到的第一次结果覆盖
    const imgFinal = wrapper.find('[data-testid="detail-image"] img')
    expect(imgFinal.attributes('src')).toContain('second.png')
    expect(imgFinal.attributes('src')).not.toContain('STALE-first')
  })

  it('TC4: signUrl RPC 失败 → 降级占位（imageUrl=null，不抛未捕获异常）', async () => {
    signUrlMock.mockRejectedValue(new Error('file_failed'))
    const wrapper = mountDetailPane()
    await setImgState('x.png')

    // 失败后 imageUrl=null → img 不渲染，占位分支显示
    const img = wrapper.find('[data-testid="detail-image"] img')
    expect(img.exists()).toBe(false)
    // 占位区含 loadFailed 文案（i18n panel.detail.loadFailed）
    const placeholder = wrapper.find('[data-testid="detail-image"]')
    expect(placeholder.text()).toBeTruthy()
  })

  it('TC6: isRemoteMode=true 但 getActiveProfile()=null → imageUrl=null 跳过 signUrl', async () => {
    remoteMode = true
    profileIsNull = true
    signUrlMock.mockResolvedValue({ url: '/file?should-not-call', expiresAt: 0 })
    const wrapper = mountDetailPane()
    await setImgState('x.png')

    // profile 为 null 时直接 imageUrl=null 跳过 signUrl RPC（不浪费注定失败的请求）
    expect(signUrlMock).not.toHaveBeenCalled()
    const img = wrapper.find('[data-testid="detail-image"] img')
    expect(img.exists()).toBe(false)
  })
})
