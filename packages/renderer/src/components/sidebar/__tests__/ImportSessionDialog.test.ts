/**
 * ImportSessionDialog 组件测试（import-session U5 验收 8 项，三视角）。
 *
 * 覆盖（impl-plan u5 验收条款；每条至少一个用户可见 DOM 断言）：
 *  1. 默认列表：打开即拉候选 + 日期分组渲染 + 目录 chip 分组过滤
 *  2. 搜索过滤三通道：名称 / 完整+短 Session ID / .jsonl 绝对路径前缀
 *  3. 路径模式切换：query 以 '/' '~' 开头时列表隐藏、路径行展示命中元信息（demo 方案 A path-bar）
 *  4. 已导入候选项禁用：徽标 + 行按钮 disabled + 选中后底部导入仍不可用
 *  5. 选目标 project：下拉默认当前激活 project、可改、导入 payload 跟随
 *  6. 导入成功 emit('imported') + sidecar_failed 走 toast warning 通道（非 error）
 *  7. 错误内联恢复指引：error envelope code → i18n 文案（含恢复动作）可见，不弹系统对话框
 *  8. cwdExists=false 标注：「原目录已不存在…」降级提示可见
 *  9. 目录切换（V8）：「选择其他目录」→ pickDirectory 选中根 → RPC 带新 rootDir
 *     重载列表/dirs/计数；取消无操作；搜索词跨根保留；重开回默认根
 *
 * mock 策略：vi.mock('@/api')（session 两方法模拟 runtime D5 S7 匹配语义 + project save
 * 供 store 持久化 watch）+ vi.mock('@/composables/useToast')（捕获 warning 通道）
 * + vi.mock('@/lib/ipc')（pickDirectory 目录选择器，useCommandPopoverTrigger 先例）。
 * vue-i18n 由 vitest-i18n-setup.ts 全局 mock（zh-CN 取值）。Dialog 经 reka DialogPortal
 * teleport 到 body：DOM 断言统一走 document.body（project-switcher.test.ts 先例）。
 *
 * 测试框架：vitest + @vue/test-utils（fake timers 控 250ms debounce）。
 * 运行：cd packages/renderer && npx vitest run src/components/sidebar/__tests__/ImportSessionDialog.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImportCandidate, Project } from '@xyz-agent/shared'
import ImportSessionDialog from '@/components/sidebar/ImportSessionDialog.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import { IMPORT_SEARCH_DEBOUNCE_MS } from '@/composables/features/sidebar/useImportSession'
import zhCN from '@/i18n/locales/zh-CN/importSession'

// ── api mock：session 域两方法（默认实现模拟 runtime 匹配语义，用例可覆写）；project.save 供 store 持久化 watch ──
const apiMocks = vi.hoisted(() => ({
  importCandidates: vi.fn(),
  importSession: vi.fn(),
}))
vi.mock('@/api', () => ({
  session: {
    importCandidates: apiMocks.importCandidates,
    importSession: apiMocks.importSession,
  },
  project: {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  },
}))

// ── toast mock：捕获 warning 通道（sidecar_failed 降级提示）──
const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMocks }))

// ── ipc mock：pickDirectory 目录选择器（V8「选择其他目录」；默认取消，用例覆写选中）──
const ipcMocks = vi.hoisted(() => ({
  pickDirectory: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ({ pickDirectory: ipcMocks.pickDirectory }))

/** 1 天毫秒数（fixture 相对时间分桶） */
const ONE_DAY = 86_400_000

const STOCK_DIR = '--Users-test-Stock--'
const XYZ_DIR = '--Users-test-xyz-agent--'

/** 候选工厂（字段契约 = shared ImportCandidate） */
function makeCandidate(overrides: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    sessionId: '01a04420-1111-2222-3333-444444444444',
    name: null,
    cwd: '/Users/test/Stock',
    sourcePath: `/Users/test/.pi/agent/sessions/${STOCK_DIR}/2026-08-27T09-11-00Z_01a04420-1111-2222-3333-444444444444.jsonl`,
    lastModified: Date.now(),
    size: 8_100_000,
    dirLabel: STOCK_DIR,
    alreadyImported: false,
    cwdExists: true,
    ...overrides,
  }
}

/** fixture（时间以用例内冻结的 fake Date 为基准，保证分组稳定） */
function makeFixture(): ImportCandidate[] {
  return [
    makeCandidate({ name: 'clickhouse 日线迁移', lastModified: Date.now() - 1_000 }),
    makeCandidate({
      name: '已导入的调研',
      sessionId: 'aa11bb22-3333-4444-5555-666666666666',
      sourcePath: `/Users/test/.pi/agent/sessions/${STOCK_DIR}/2026-08-20T10-00-00Z_aa11bb22-3333-4444-5555-666666666666.jsonl`,
      lastModified: Date.now() - 2_000,
      alreadyImported: true,
    }),
    makeCandidate({
      name: null,
      sessionId: 'bb22cc33-4444-5555-6666-777777777777',
      sourcePath: `/Users/test/.pi/agent/sessions/${XYZ_DIR}/2026-08-25T08-00-00Z_bb22cc33-4444-5555-6666-777777777777.jsonl`,
      cwd: '/Users/test/gone-dir',
      lastModified: Date.now() - ONE_DAY,
      dirLabel: XYZ_DIR,
      cwdExists: false,
    }),
    makeCandidate({
      name: '更早的 agent 会话',
      sessionId: 'cc33dd44-5555-6666-7777-888888888888',
      sourcePath: `/Users/test/.pi/agent/sessions/${XYZ_DIR}/2026-08-01T08-00-00Z_cc33dd44-5555-6666-7777-888888888888.jsonl`,
      cwd: '/Users/test/xyz-agent',
      lastModified: Date.now() - ONE_DAY * 8,
      dirLabel: XYZ_DIR,
    }),
  ]
}

/**
 * runtime D5 S7 匹配语义模拟：字段集 = name ∪ 完整 sessionId ∪ uuid 前 6 位短 ID ∪
 * sourcePath ∪ dirLabel，全部 case-insensitive includes（过滤发生在 runtime，组件测试
 * 用 mock 复刻同一语义，断言 renderer 的「发 query + 展示过滤结果」协作）。
 */
function matchCandidates(items: ImportCandidate[], query: string): ImportCandidate[] {
  if (!query) return items
  const q = query.toLowerCase()
  return items.filter(
    (c) =>
      (c.name ?? '').toLowerCase().includes(q) ||
      c.sessionId.toLowerCase().includes(q) ||
      c.sessionId.slice(0, 6).toLowerCase().includes(q) ||
      c.sourcePath.toLowerCase().includes(q) ||
      c.dirLabel.toLowerCase().includes(q),
  )
}

let fixture: ImportCandidate[]
let wrapper: VueWrapper | null = null

function seedProjects(): void {
  const projectStore = useProjectStore()
  const projects: Project[] = [
    { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
    { id: 'stock-id', name: 'Stock', lastUsedAt: 2 },
    { id: 'beta-id', name: 'Beta', lastUsedAt: 1 },
  ]
  projectStore.projects = projects
  projectStore.activeProjectId = 'stock-id'
}

/** mount 对话框（open=true 即触发 resetForOpen 首拉）并排空异步 */
async function mountDialog(): Promise<void> {
  wrapper = mount(ImportSessionDialog, {
    props: { open: true },
    attachTo: document.body,
  })
  await flushPromises()
}

/** Dialog 经 reka DialogPortal teleport 到 body：按 testid 从 body 取 DOMWrapper */
function byTestId(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`)
  return el ? new DOMWrapper(el) : null
}

function allByTestId(testid: string): DOMWrapper<Element>[] {
  return Array.from(document.body.querySelectorAll(`[data-testid="${testid}"]`)).map(
    (el) => new DOMWrapper(el),
  )
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

/** 搜索输入：setValue 触发 query watch → 推进 250ms debounce → 排空 RPC 微任务 */
async function typeSearch(text: string): Promise<void> {
  const input = byTestId('import-search-input')
  expect(input, '搜索框应存在').not.toBeNull()
  await input!.setValue(text)
  await vi.advanceTimersByTimeAsync(IMPORT_SEARCH_DEBOUNCE_MS)
  await flushPromises()
}

/** 点列表条目行（select 高亮） */
async function clickItemRow(index: number): Promise<void> {
  const items = allByTestId('import-item')
  expect(items[index], `import-item[${index}] 应存在`).toBeTruthy()
  await items[index].trigger('click')
  await flushPromises()
}

/** 通过行内按钮发起导入（不经底部确认，sourcePath 直接来自该行候选） */
async function importViaRowButton(index: number): Promise<void> {
  const items = allByTestId('import-item')
  const btn = items[index].find('[data-testid="import-item-import-btn"]')
  expect(btn.exists(), `import-item[${index}] 的导入按钮应存在`).toBe(true)
  await btn.trigger('click')
  await flushPromises()
}

function importErrorWithCode(code: string): Error {
  return Object.assign(new Error(`rpc failure: ${code}`), { code })
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  vi.clearAllMocks()
  fixture = makeFixture()
  apiMocks.importCandidates.mockImplementation(async (req?: { query?: string }) => {
    const items = matchCandidates(fixture, (req?.query ?? '').trim())
    return {
      total: fixture.length,
      items,
      dirs: [
        { label: STOCK_DIR, count: fixture.filter((c) => c.dirLabel === STOCK_DIR).length },
        { label: XYZ_DIR, count: fixture.filter((c) => c.dirLabel === XYZ_DIR).length },
      ],
    }
  })
  apiMocks.importSession.mockImplementation(async (req: { sourcePath: string }) => ({
    sessionId: 'imported-new-session-id',
    targetPath: `/Users/test/.xyz-agent/pi/sessions/${STOCK_DIR}/copied.jsonl`,
    sourcePath: req.sourcePath,
  }))
  // 默认取消（对齐真实 pickDirectory 无 electronAPI 时的降级契约），选中场景用例内覆写
  ipcMocks.pickDirectory.mockResolvedValue({ canceled: true, path: null })
  seedProjects()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('ImportSessionDialog（U5 验收）', () => {
  it('首屏冒烟：对话框结构元素齐备（观察者视角）', async () => {
    await mountDialog()

    for (const testid of [
      'import-session-dialog',
      'import-search-input',
      'import-dir-chip',
      'import-choose-dir-btn',
      'import-item',
      'import-project-select',
      'import-cancel-btn',
      'import-confirm-btn',
    ]) {
      expect(byTestId(testid), `${testid} 应存在`).not.toBeNull()
    }
    expect(bodyText()).toContain(zhCN.title)
    expect(byTestId('import-search-input')!.attributes('placeholder')).toBe(zhCN.searchPlaceholder)
    expect(bodyText()).toContain(zhCN.importTo)
  })

  describe('验收1：默认列表（打开即拉候选 + 目录分组渲染）', () => {
    it('打开即发全量候选 RPC（无 query），日期分组 + 目录 chip + 计数可见', async () => {
      await mountDialog()

      // 构建者：打开即拉，payload 无 query（全量）
      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1)
      expect(apiMocks.importCandidates).toHaveBeenCalledWith({})
      // 使用者：4 条候选渲染；目录 chip = 全部目录 + 2 个子目录
      expect(allByTestId('import-item')).toHaveLength(4)
      expect(allByTestId('import-dir-chip')).toHaveLength(3)
      expect(bodyText()).toContain(zhCN.allDirs)
      expect(bodyText()).toContain(STOCK_DIR)
      // 观察者：日期分组头（今天 / 更早；昨天条目在 fixture 中为空组不渲染）
      expect(bodyText()).toContain(zhCN.group.today)
      expect(bodyText()).toContain(zhCN.group.earlier)
      // 计数 = 可见候选数
      expect(bodyText()).toContain('4 个 session')
    })

    it('目录 chip 点击 → 客户端按 dirLabel 过滤（不发新 RPC），再点切回全部', async () => {
      await mountDialog()
      const chip = allByTestId('import-dir-chip').find((c) => c.text() === XYZ_DIR)
      expect(chip, 'XYZ 目录 chip 应存在').toBeTruthy()
      await chip!.trigger('click')
      await flushPromises()

      // 使用者：只剩 XYZ 目录的 2 条 + 计数联动
      expect(allByTestId('import-item')).toHaveLength(2)
      expect(bodyText()).toContain('2 个 session')
      expect(bodyText()).not.toContain('clickhouse 日线迁移')
      // 构建者：目录过滤纯客户端，不重复发 RPC
      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1)
    })
  })

  describe('验收2：搜索过滤三通道（debounce 250ms 后发 query）', () => {
    it('通道一 名称关键词：列表过滤出目标条目', async () => {
      await mountDialog()
      await typeSearch('clickhouse')

      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ query: 'clickhouse' })
      expect(allByTestId('import-item')).toHaveLength(1)
      expect(bodyText()).toContain('clickhouse 日线迁移')
    })

    it('通道二 完整 Session ID / 短 ID（uuid 前 6 位）：各过滤出唯一条目', async () => {
      await mountDialog()

      // 完整 sessionId
      await typeSearch('bb22cc33-4444-5555-6666-777777777777')
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({
        query: 'bb22cc33-4444-5555-6666-777777777777',
      })
      expect(allByTestId('import-item')).toHaveLength(1)

      // 短 ID（uuid 前 6 位，pi TUI 式标识；name 为 null 的条目回退目录名显示）
      await typeSearch('01a044')
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ query: '01a044' })
      const items = allByTestId('import-item')
      expect(items).toHaveLength(1)
      expect(items[0].text()).toContain(STOCK_DIR)
    })

    it('通道三 .jsonl 绝对路径前缀：RPC 收到路径 query（形态切路径模式，见验收3）', async () => {
      await mountDialog()
      const pathPrefix = `/Users/test/.pi/agent/sessions/${STOCK_DIR}/2026-08-27`
      await typeSearch(pathPrefix)

      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ query: pathPrefix })
    })

    it('清空搜索立即回全量（不走 debounce）', async () => {
      await mountDialog()
      await typeSearch('clickhouse')
      expect(allByTestId('import-item')).toHaveLength(1)

      const input = byTestId('import-search-input')!
      await input.setValue('')
      await flushPromises()

      expect(allByTestId('import-item')).toHaveLength(4)
    })
  })

  describe('验收3：路径模式切换（query 以 / ~ 开头）', () => {
    it('输入绝对路径：分组列表隐藏，路径行展示命中元信息，「导入此文件」直达导入', async () => {
      await mountDialog()
      const fullPath = fixture[0].sourcePath
      await typeSearch(fullPath)

      // 观察者：形态切换——列表隐藏、路径行出现
      expect(byTestId('import-path-bar')).not.toBeNull()
      expect(allByTestId('import-item')).toHaveLength(0)
      // 使用者：路径行展示 query 与命中元信息（大小 · 相对时间）
      const bar = byTestId('import-path-bar')!
      expect(bar.text()).toContain(fullPath)
      expect(bar.find('[data-testid="import-path-meta"]').text()).toContain('7.7 MB')
      const btn = bar.find('[data-testid="import-path-import-btn"]')
      expect(btn.attributes('disabled')).toBeUndefined()

      // 构建者：路径行按钮直达导入，payload.sourcePath = 命中条目
      await btn.trigger('click')
      await flushPromises()
      expect(apiMocks.importSession).toHaveBeenCalledWith({
        sourcePath: fullPath,
        projectId: 'stock-id',
      })
    })

    it('路径未命中任何候选：显示「未找到匹配」+ 按钮禁用', async () => {
      await mountDialog()
      await typeSearch('/nonexistent/path/other.jsonl')

      const bar = byTestId('import-path-bar')!
      expect(bar.find('[data-testid="import-path-meta"]').text()).toContain(zhCN.pathNoMatch)
      expect(bar.find('[data-testid="import-path-import-btn"]').attributes('disabled')).toBeDefined()
    })

    it('路径命中已导入候选：「导入此文件」禁用（不重复导入）', async () => {
      await mountDialog()
      await typeSearch(fixture[1].sourcePath)

      const bar = byTestId('import-path-bar')!
      expect(bar.text()).toContain(fixture[1].sourcePath)
      expect(bar.find('[data-testid="import-path-import-btn"]').attributes('disabled')).toBeDefined()
    })

    it('~ 开头同样进入路径模式；退出（清空 query）恢复分组列表', async () => {
      await mountDialog()
      const input = byTestId('import-search-input')!
      await input.setValue('~/sessions/some.jsonl')
      await flushPromises()

      expect(byTestId('import-path-bar')).not.toBeNull()
      expect(allByTestId('import-item')).toHaveLength(0)

      await input.setValue('')
      await flushPromises()
      expect(byTestId('import-path-bar')).toBeNull()
      expect(allByTestId('import-item')).toHaveLength(4)
    })
  })

  describe('验收4：已导入候选项禁用 / 不可重复导入', () => {
    it('已导入条目：徽标可见 + 行按钮禁用 + 点击不触发导入 RPC', async () => {
      await mountDialog()

      // fixture[1] = alreadyImported 条目
      const importedRow = allByTestId('import-item').find((r) => r.text().includes('已导入的调研'))
      expect(importedRow, '已导入条目应渲染').toBeTruthy()

      // 观察者：徽标 + 半透明降维
      expect(importedRow!.find('[data-testid="import-item-imported"]').exists()).toBe(true)
      expect(importedRow!.find('[data-testid="import-item-imported"]').text()).toBe(zhCN.importedBadge)
      expect(importedRow!.classes()).toContain('opacity-50')
      // 使用者：行内导入按钮禁用
      const rowBtn = importedRow!.find('[data-testid="import-item-import-btn"]')
      expect(rowBtn.attributes('disabled')).toBeDefined()
      await rowBtn.trigger('click')
      await flushPromises()
      // 构建者：composable alreadyImported 守卫兜底（disabled 吞 click 或守卫 return，均不得发 RPC）
      expect(apiMocks.importSession).not.toHaveBeenCalled()
    })

    it('选中已导入条目后底部「导入」仍禁用（canConfirm 含 alreadyImported）', async () => {
      await mountDialog()
      await clickItemRow(1)

      expect(byTestId('import-confirm-btn')!.attributes('disabled')).toBeDefined()
    })
  })

  describe('验收5：选目标 project（默认当前激活，可改）', () => {
    // reka Select 打开依赖其内部 setTimeout（open 状态推进），fake timers 会冻结在
    // closed——本组用例不涉 debounce，切真实 timers（describe 级 hook 晚于文件级执行）
    beforeEach(() => {
      vi.useRealTimers()
    })

    it('打开即默认当前激活 project（trigger 可见），下拉含全部 project', async () => {
      await mountDialog()

      // 使用者：trigger 常显当前激活 project（SelectValue 自算名，不依赖下拉打开）
      expect(byTestId('import-project-select')!.text()).toContain('Stock')

      // 打开下拉（reka SelectTrigger 在 pointerdown 打开，happy-dom 需显式 dispatch）
      const trigger = byTestId('import-project-select')!.element as HTMLElement
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      trigger.click()
      await flushPromises()

      const options = Array.from(document.body.querySelectorAll('[role="option"]')).map(
        (el) => el.textContent ?? '',
      )
      expect(options).toContain('Stock')
      expect(options).toContain('Beta')
      expect(options).toContain(zhCN.defaultProjectName)
    })

    it('下拉改选 Beta → 导入 payload.projectId 跟随新目标', async () => {
      await mountDialog()

      const trigger = byTestId('import-project-select')!.element as HTMLElement
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      trigger.click()
      await flushPromises()

      const beta = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) =>
        (el.textContent ?? '').includes('Beta'),
      )
      expect(beta, 'Beta option 应存在').toBeTruthy()
      beta!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      beta!.click()
      await flushPromises()

      // 使用者：trigger 显示新目标
      expect(byTestId('import-project-select')!.text()).toContain('Beta')

      await importViaRowButton(0)
      expect(apiMocks.importSession).toHaveBeenCalledWith({
        sourcePath: fixture[0].sourcePath,
        projectId: 'beta-id',
      })
    })

    it('不改动时导入走默认（当前激活 project）', async () => {
      await mountDialog()
      await importViaRowButton(0)

      expect(apiMocks.importSession).toHaveBeenCalledWith({
        sourcePath: fixture[0].sourcePath,
        projectId: 'stock-id',
      })
    })
  })

  describe('验收6：导入成功 emit + toast warning 通道', () => {
    it('sidecar_failed warning：toast.warning（非 error）+ imported emit 单 payload + 对话框请求关闭', async () => {
      await mountDialog()
      apiMocks.importSession.mockResolvedValueOnce({
        sessionId: 'sid-new',
        targetPath: '/target/copied.jsonl',
        warning: 'sidecar_failed',
      })

      await importViaRowButton(0)

      // 使用者：降级 toast 可见（warning 通道，非 error 弹窗）
      expect(toastMocks.warning).toHaveBeenCalledTimes(1)
      expect(toastMocks.warning).toHaveBeenCalledWith(zhCN.toastSidecarFailed)
      expect(toastMocks.error).not.toHaveBeenCalled()
      // 构建者：emit 单 payload 对象（项目规则：emit 只传单 payload）
      const imported = wrapper!.emitted('imported')
      expect(imported).toHaveLength(1)
      expect(imported![0]).toEqual([
        {
          sessionId: 'sid-new',
          sessionName: 'clickhouse 日线迁移',
          projectName: 'Stock',
          targetPath: '/target/copied.jsonl',
          warning: 'sidecar_failed',
        },
      ])
      // 对话框请求父层关闭（v-model:open 收口）
      const openEvents = wrapper!.emitted('update:open')
      expect(openEvents?.[openEvents.length - 1]).toEqual([false])
    })

    it('无 warning 的成功：不触发 warning toast，payload.warning 为 undefined', async () => {
      await mountDialog()
      apiMocks.importSession.mockResolvedValueOnce({
        sessionId: 'sid-clean',
        targetPath: '/target/clean.jsonl',
      })

      await importViaRowButton(0)

      expect(toastMocks.warning).not.toHaveBeenCalled()
      const imported = wrapper!.emitted('imported')
      expect(imported![0][0]).toMatchObject({ sessionId: 'sid-clean', warning: undefined })
    })

    it('导入进行中：按钮呈导入中态并禁用；完成后关闭', async () => {
      await mountDialog()
      let resolveImport: (v: { sessionId: string; targetPath: string }) => void = () => {}
      apiMocks.importSession.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveImport = resolve
          }),
      )

      const rowBtn = allByTestId('import-item')[0].find('[data-testid="import-item-import-btn"]')
      await rowBtn.trigger('click')
      await flushPromises()

      // 使用者：进行中态（文案 + 禁用，防双击连点）
      const confirm = byTestId('import-confirm-btn')!
      expect(confirm.text()).toContain(zhCN.importing)
      expect(confirm.attributes('disabled')).toBeDefined()

      resolveImport({ sessionId: 'sid-p', targetPath: '/target/p.jsonl' })
      await flushPromises()
      const openEvents = wrapper!.emitted('update:open')
      expect(openEvents?.[openEvents.length - 1]).toEqual([false])
    })
  })

  describe('验收7：错误内联恢复指引（error envelope code → 文案）', () => {
    it.each([
      'import_source_missing',
      'import_invalid_session',
      'import_marker_filename',
      'import_dir_unreadable',
      'import_already_imported',
      'import_target_conflict',
      'import_copy_failed',
      'import_project_invalid',
      'timeout',
    ])('%s：内联展示对应恢复指引文案，对话框不关', async (code) => {
      await mountDialog()
      apiMocks.importSession.mockRejectedValueOnce(importErrorWithCode(code))

      await importViaRowButton(0)

      // 使用者：错误内联可见且等于 i18n 文案（每条文案都含「后重试/请」恢复动作）
      const errorEl = byTestId('import-error')
      expect(errorEl, 'import-error 元素应存在').not.toBeNull()
      expect(errorEl!.text()).toBe(zhCN.errors[code as keyof typeof zhCN.errors])
      // 失败不关闭对话框（可继续操作 / 重试）
      expect(wrapper!.emitted('update:open')).toBeUndefined()
    })

    it('未识别 code 归一化为 unknown 文案；无 code 同样兜底', async () => {
      await mountDialog()
      apiMocks.importSession.mockRejectedValueOnce(importErrorWithCode('weird_unlisted'))

      await importViaRowButton(0)
      expect(byTestId('import-error')!.text()).toBe(zhCN.errors.unknown)
    })

    it('错误后可重试导入（按钮恢复可用）', async () => {
      await mountDialog()
      apiMocks.importSession.mockRejectedValueOnce(importErrorWithCode('import_copy_failed'))
      await importViaRowButton(0)
      expect(byTestId('import-error')).not.toBeNull()

      apiMocks.importSession.mockResolvedValueOnce({ sessionId: 'sid-ok', targetPath: '/t/ok.jsonl' })
      await importViaRowButton(0)
      expect(wrapper!.emitted('imported')).toHaveLength(1)
    })
  })

  describe('验收8：cwdExists=false 标注（原目录不存在的降级提示）', () => {
    it('原目录不存在的条目：「原目录已不存在」标注可见；正常条目无标注', async () => {
      await mountDialog()

      const missingRow = allByTestId('import-item').find((r) => r.text().includes(XYZ_DIR))
      expect(missingRow, 'cwdExists=false 条目应渲染').toBeTruthy()

      // 使用者：降级标注可见（用户知情，无静默语义漂移）
      const badge = missingRow!.find('[data-testid="import-item-cwd-missing"]')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toBe(zhCN.cwdMissing)

      // 观察者：cwdExists=true 条目不渲染标注
      const normalRow = allByTestId('import-item').find((r) => r.text().includes('clickhouse 日线迁移'))
      expect(normalRow!.find('[data-testid="import-item-cwd-missing"]').exists()).toBe(false)
    })
  })

  describe('验收9：目录切换（V8「选择其他目录」）', () => {
    const CUSTOM_ROOT = '/Users/test/custom-sessions'
    const CUSTOM_DIR = '--Users-test-custom-sessions--'

    /** 新根 fixture（V8 场景：只有少量 session 的目录） */
    function makeCustomFixture(): ImportCandidate[] {
      return [
        makeCandidate({
          name: '其他目录的会话',
          sessionId: 'ddee0011-1111-2222-3333-444444444444',
          sourcePath: `${CUSTOM_ROOT}/${CUSTOM_DIR}/2026-08-28T10-00-00Z_ddee0011-1111-2222-3333-444444444444.jsonl`,
          lastModified: Date.now(),
          dirLabel: CUSTOM_DIR,
        }),
      ]
    }

    /** 点「选择其他目录」按钮（触发 pickDirectory → 选中后切根重拉） */
    async function clickChooseDir(): Promise<void> {
      const btn = byTestId('import-choose-dir-btn')
      expect(btn, '「选择其他目录」按钮应存在').not.toBeNull()
      await btn!.trigger('click')
      await flushPromises()
    }

    it('选中目录：RPC 带新 rootDir 重载，当前根可见 + 列表/dirs/chip/计数更新', async () => {
      await mountDialog()
      const customFixture = makeCustomFixture()
      apiMocks.importCandidates.mockImplementationOnce(async () => ({
        total: customFixture.length,
        items: customFixture,
        dirs: [{ label: CUSTOM_DIR, count: customFixture.length }],
      }))
      ipcMocks.pickDirectory.mockResolvedValueOnce({ canceled: false, path: CUSTOM_ROOT })

      await clickChooseDir()

      // 构建者：目录选择器被调（标题文案）+ RPC 收到新 rootDir（缺省根时 payload 不含该字段）
      expect(ipcMocks.pickDirectory).toHaveBeenCalledTimes(1)
      expect(ipcMocks.pickDirectory).toHaveBeenCalledWith({ title: zhCN.chooseDirTitle })
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ rootDir: CUSTOM_ROOT })
      // 使用者：当前扫描根可见（chip 区更新）+ 按钮仍在
      expect(byTestId('import-root-dir')!.text()).toBe(CUSTOM_ROOT)
      expect(bodyText()).toContain(zhCN.chooseDirBtn)
      // 列表重载为新根数据：1 条 + 新子目录 chip（全部目录 + 1）+ 计数正确
      expect(allByTestId('import-item')).toHaveLength(1)
      expect(bodyText()).toContain('其他目录的会话')
      expect(allByTestId('import-dir-chip')).toHaveLength(2)
      expect(bodyText()).toContain(CUSTOM_DIR)
      expect(bodyText()).toContain('1 个 session')
    })

    it('取消选择：无重载（RPC 次数不变），扫描根保持默认', async () => {
      await mountDialog()
      const callsBefore = apiMocks.importCandidates.mock.calls.length
      ipcMocks.pickDirectory.mockResolvedValueOnce({ canceled: true, path: null })

      await clickChooseDir()

      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(callsBefore)
      expect(byTestId('import-root-dir')).toBeNull()
    })

    it('切换根后搜索：payload 同时带 rootDir + query（搜索词跨根保留）', async () => {
      await mountDialog()
      ipcMocks.pickDirectory.mockResolvedValueOnce({ canceled: false, path: CUSTOM_ROOT })
      await clickChooseDir()

      await typeSearch('clickhouse')

      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({
        rootDir: CUSTOM_ROOT,
        query: 'clickhouse',
      })
    })

    it('关闭重开：扫描根回到默认（RPC 不带 rootDir，根路径标注消失）', async () => {
      await mountDialog()
      ipcMocks.pickDirectory.mockResolvedValueOnce({ canceled: false, path: CUSTOM_ROOT })
      await clickChooseDir()
      expect(byTestId('import-root-dir')).not.toBeNull()

      await wrapper!.setProps({ open: false })
      await flushPromises()
      await wrapper!.setProps({ open: true })
      await flushPromises()

      expect(byTestId('import-root-dir')).toBeNull()
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({})
    })
  })

  it('取消按钮：emit update:open false（父层收口关闭）', async () => {
    await mountDialog()
    await byTestId('import-cancel-btn')!.trigger('click')

    const openEvents = wrapper!.emitted('update:open')
    expect(openEvents?.[openEvents.length - 1]).toEqual([false])
  })
})
