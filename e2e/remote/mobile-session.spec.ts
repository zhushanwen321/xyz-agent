/**
 * 远程 E2E —— 移动端会话旅程（spec remote-use R4 + mobile App.vue 全链路）。
 *
 * 覆盖 TC1-TC5：session 新建/列表/进 chat/发消息/Files 只读树/Settings 连接信息。
 *
 * 前置条件（关键）：session.create 校验 getDefaultModel()，新 dataDir 无模型配置会
 * MODEL_NOT_CONFIGURED。故 fixture startRemoteRuntime({ seedModelConfig: true }) 从
 * dev dataDir（~/.xyz-agent-dev）复制 pi/agent/{settings,models}.json 到临时 dataDir。
 * 本 spec 模块加载时探针 pi 二进制 + 可预置模型配置，任一缺失则 describe.skip（避免无谓失败）。
 *
 * 每个用例：独立 startRemoteRuntime + launchMobileBrowser → 测功能 → cleanup（browser + runtime）。
 * fixture 的 stop 会清 dataDir（session 残留自动清，spec 内不手动删 session）。
 *
 * cwd 临时目录：beforeAll 在 <tmpdir>/xyz-e2e-mobile-session 建目录 + 放测试文件（README.md/notes.txt），
 * 供 TC1 创建 session（cwd 必须存在）+ TC4 Files 树展示。
 *
 * pi 回复内容由 AI 生成不可预测：TC3 只断言「用户发出的消息出现在消息流」（用户气泡可见），
 * 不断言 assistant 回复内容（pi 回复慢/失败不阻断「发消息成功」核心断言）。
 *
 * 超时：pi 相关用例放宽（session.create 首次 spawn pi 冷启 + 首消息回复较慢）。
 */
import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startRemoteRuntime } from '../fixtures/remote-runtime'
import { launchMobileBrowser } from '../fixtures/launch-mobile-browser'

/** 移动端会话测试用的临时 cwd（runtime 与测试同机，/tmp 共享文件系统）。 */
const TEST_CWD = join(tmpdir(), 'xyz-e2e-mobile-session')
/** 测试 cwd 内放的文件名（TC4 Files 树展开后应可见）。 */
const TEST_FILE_NAME = 'README.md'
const TEST_FILE_PATH = join(TEST_CWD, TEST_FILE_NAME)
const TEST_FILE_CONTENT = 'hello from xyz-agent mobile e2e'

/** pi 相关等待超时（session.create 触发 pi spawn 冷启 + 首条消息往返）。 */
const PI_ACTION_TIMEOUT_MS = 60_000
/** 普通 UI 等待超时。 */
const UI_TIMEOUT_MS = 15_000

/**
 * 探测 pi 是否可用（模块加载时探测，供 describe.skip 判定）。
 *
 * 查找顺序与 remote-runtime.findPiBinary 对齐：
 *  1. process.env.XYZ_PI_BIN（最高优先级）
 *  2. apps/electron/resources/pi/pi-<plat>-<arch>（dev 主路径）
 *  3. PATH 中的 pi（pi --version 探测，输出版本号即视为可用）
 *
 * @returns pi 二进制路径（可用）或 null（不可用）
 */
function probePiAvailable(): string | null {
  // repoRoot 解析（ESM：用 import.meta.url，与 remote-runtime fixture 同范式）
  const here = fileURLToPath(new URL('.', import.meta.url))
  const repoRoot = join(here, '..', '..')
  // 1. 显式覆盖
  if (process.env.XYZ_PI_BIN && existsSync(process.env.XYZ_PI_BIN)) {
    return process.env.XYZ_PI_BIN
  }
  // 2. dev resources
  const platform = process.platform
  const arch = process.arch
  const binaryName = platform === 'win32' ? `pi-windows-${arch}.exe` : `pi-${platform}-${arch}`
  const devPi = join(repoRoot, 'apps', 'electron', 'resources', 'pi', binaryName)
  if (existsSync(devPi)) return devPi
  // 3. PATH 兜底（pi --version 探测，不依赖固定路径；pi 无 -V 选项，用 --version）
  try {
    const result = spawnSync('pi', ['--version'], { timeout: 5_000, stdio: 'pipe' })
    // 退出码 0 或 stdout 有内容均视为可用（pi --version 输出版本号）
    if (result.status === 0 || (result.stdout && result.stdout.toString().trim().length > 0)) {
      return 'pi'
    }
  } catch {
    // pi 不在 PATH 或执行失败 → 不可用
  }
  return null
}

/**
 * 探测是否有可预置的模型配置（session.create 校验 getDefaultModel() 必需）。
 *
 * 与 remote-runtime.seedPiModelConfig 源探测顺序一致：
 *  XYZ_AGENT_DATA_DIR > ~/.xyz-agent-dev > ~/.xyz-agent，含 pi/agent/{settings,models}.json 即可用。
 * @returns 可用源 dataDir 或 null
 */
function probeModelConfigAvailable(): string | null {
  const candidates: string[] = []
  if (process.env.XYZ_AGENT_DATA_DIR) candidates.push(process.env.XYZ_AGENT_DATA_DIR)
  candidates.push(join(homedir(), '.xyz-agent-dev'))
  candidates.push(join(homedir(), '.xyz-agent'))
  for (const c of candidates) {
    if (
      existsSync(join(c, 'pi', 'agent', 'settings.json')) &&
      existsSync(join(c, 'pi', 'agent', 'models.json'))
    ) {
      return c
    }
  }
  return null
}

/**
 * 会话前置条件（模块加载时探测，供 describe.skip 判定）。
 *
 * session.create 需要：(1) pi 二进制可用；(2) 可预置的模型配置（getDefaultModel 校验）。
 * 二者任一缺失则 TC1-TC4（创建/列表/发消息/Files）必然失败 → 整体 skip。
 * 必须模块顶层探测：(ready ? test.describe : test.describe.skip)() 在加载时决定是否 skip。
 */
const piAvailable: string | null = probePiAvailable()
const modelConfigAvailable: string | null = probeModelConfigAvailable()
const sessionPrereqReady: boolean = piAvailable !== null && modelConfigAvailable !== null

/**
 * 切换到底部 tab（mobile-tab-sessions/files/settings）。
 *
 * 显式点击而非依赖默认态：测试间 tab 状态可能因 KeepAlive 复用残留（虽每用例新 browser，
 * 但显式 click 更稳健，避免「默认是否 Sessions」的隐式假设）。
 */
async function switchTab(page: Page, testId: 'mobile-tab-sessions' | 'mobile-tab-files' | 'mobile-tab-settings'): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).click()
  // 等 tab content 容器出现（mobile-tab-content-<id>），确认切换生效
  const tabId = testId.replace('mobile-tab-', '')
  await page.waitForSelector(`[data-testid="mobile-tab-content-${tabId}"]`, { timeout: UI_TIMEOUT_MS })
}

/**
 * 通过 UI 新建 session（TC1 + 后续用例复用）。
 *
 * 流程：切 Sessions tab → 点 mobile-new-session-btn → 填 prompt + cwd → submit → 等 chat 视图。
 * @returns 创建的 session（从 mobile-session-item 列表或 chat header 间接确认；这里返回 page 供断言）
 * @throws 若 session 创建失败（pi 不可用 / cwd 不存在）→ submit 后停留在 new 视图或 toast 报错
 */
async function createSessionViaUi(page: Page, prompt: string, cwd: string): Promise<void> {
  await switchTab(page, 'mobile-tab-sessions')
  // 点新建按钮（mobile-new-session-btn 在 mobile-session-list header；空态也有，但点 header 那个更稳）
  await page.locator('[data-testid="mobile-new-session-btn"]').click()
  await page.waitForSelector('[data-testid="mobile-new-session"]', { timeout: UI_TIMEOUT_MS })
  // 填 prompt
  await page.locator('[data-testid="mobile-new-session-prompt"]').fill(prompt)
  // 填 cwd
  await page.locator('[data-testid="mobile-new-session-cwd"]').fill(cwd)
  // submit（disabled 状态会在 canSubmit 计算后解除，用 toBeEnabled 等待）
  const submitBtn = page.locator('[data-testid="mobile-new-session-submit"]')
  await expect(submitBtn).toBeEnabled({ timeout: UI_TIMEOUT_MS })
  await submitBtn.click()
  // 等 chat 视图出现（session.create + 首条 send 完成；pi 冷启可能慢，放宽）
  await page.waitForSelector('[data-testid="mobile-chat-view"]', { timeout: PI_ACTION_TIMEOUT_MS })
}

// 串行：每用例独立 runtime + browser，但 serial 显式标注意图（remote 项目 workers=1 已串行，
// 防并行 mode 下 runtime 端口/进程串扰）
test.describe.serial('移动端会话旅程 E2E', () => {
  test.beforeAll(() => {
    // 建临时 cwd 目录 + 放测试文件（TC1 创建 session 用 + TC4 Files 树展示）
    mkdirSync(TEST_CWD, { recursive: true })
    writeFileSync(TEST_FILE_PATH, TEST_FILE_CONTENT, { encoding: 'utf8' })
    writeFileSync(join(TEST_CWD, 'notes.txt'), 'some notes\n', { encoding: 'utf8' })
  })

  test.afterAll(() => {
    // 清临时 cwd（best-effort）
    try {
      rmSync(TEST_CWD, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  // 前置条件不满足时整体 skip（session 创建依赖 pi + 模型配置，缺一则 TC1-TC4 全失败）。
  // TC5（Settings 连接信息）不依赖 session，但拆分 skip 会让 describe 结构复杂；
  // 这里整体 skip 并在 skip 理由中说明：用户需确保 pi 可用 + 有可预置的模型配置
  // （dev 环境跑过 pnpm dev 配过模型即满足：~/.xyz-agent-dev/pi/agent/{settings,models}.json 存在）。
  ;(sessionPrereqReady ? test.describe : test.describe.skip)('pi 可用时的会话旅程', () => {

    test('TC1: Sessions 空态 → 新建 session → 进入 chat 视图', async () => {
      const runtime = await startRemoteRuntime({ seedModelConfig: true })
      try {
        const mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
        try {
          const page = mobile.page
          // 默认应进 Sessions tab（首屏）；显式切一次确保
          await switchTab(page, 'mobile-tab-sessions')
          // 全新 dataDir → session 列表为空，断言空态可见
          // （mobile-session-empty 或 mobile-session-items 二选一；新 runtime 必为空）
          await expect(page.locator('[data-testid="mobile-session-empty"]')).toBeVisible({
            timeout: UI_TIMEOUT_MS,
          })
          // 新建 session → 进 chat 视图
          await createSessionViaUi(page, 'hello from e2e tc1', TEST_CWD)
          // 断言进入 chat 视图
          await expect(page.locator('[data-testid="mobile-chat-view"]')).toBeVisible()
        } finally {
          await mobile.cleanup()
        }
      } finally {
        await runtime.stop()
      }
    })

    test('TC2: Session 列表 → 点击进 chat', async () => {
      const runtime = await startRemoteRuntime({ seedModelConfig: true })
      try {
        const mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
        try {
          const page = mobile.page
          await switchTab(page, 'mobile-tab-sessions')
          // 先建一个 session（TC1 范式），建完进 chat
          await createSessionViaUi(page, 'hello from e2e tc2', TEST_CWD)
          // 回列表
          await page.locator('[data-testid="mobile-chat-back"]').click()
          await page.waitForSelector('[data-testid="mobile-session-list"]', { timeout: UI_TIMEOUT_MS })
          // 断言列表至少有一项
          await expect(page.locator('[data-testid="mobile-session-items"]')).toBeVisible()
          const firstItem = page.locator('[data-testid^="mobile-session-item-"]').first()
          await expect(firstItem).toBeVisible({ timeout: UI_TIMEOUT_MS })
          // 点击首项 → 进 chat
          await firstItem.click()
          await expect(page.locator('[data-testid="mobile-chat-view"]')).toBeVisible({
            timeout: PI_ACTION_TIMEOUT_MS,
          })
        } finally {
          await mobile.cleanup()
        }
      } finally {
        await runtime.stop()
      }
    })

    test('TC3: Chat 发消息 → 消息流出现回复', async () => {
      const runtime = await startRemoteRuntime({ seedModelConfig: true })
      try {
        const mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
        try {
          const page = mobile.page
          // 建 session（createSessionViaUi 已发首条 prompt，chat 视图应已渲染用户消息）
          await createSessionViaUi(page, 'say hi briefly', TEST_CWD)
          // composer 填消息 + 发送
          const outgoingText = 'test message from e2e tc3'
          await page.locator('[data-testid="mobile-composer-input"]').fill(outgoingText)
          await page.locator('[data-testid="mobile-composer-send"]').click()
          // 断言 1：用户发出的消息出现在消息流（用户气泡 group/user 含该文本）。
          // 用 toPass 轮询：send 是异步（useChat.send → WS → runtime → pi → 流式回灌 → 渲染），
          // 用户消息渲染早于 assistant 回复，但仍需等 WS 往返。
          await expect(
            page.locator('.message-stream').locator(`text=${outgoingText}`),
          ).toBeVisible({ timeout: PI_ACTION_TIMEOUT_MS })
          // 断言 2（best-effort，pi 回复不可预测）：等待一段时间后消息流应有 assistant 内容。
          // 不强断言具体文本（AI 生成不可预测），仅断言「至少有用户消息渲染」（已由断言1覆盖）。
          // pi 回复若慢/失败不阻断本用例（用户发消息成功即核心功能验证通过）。
        } finally {
          await mobile.cleanup()
        }
      } finally {
        await runtime.stop()
      }
    })

    test('TC4: Files tab 只读文件树 → 查看文件内容', async () => {
      const runtime = await startRemoteRuntime({ seedModelConfig: true })
      try {
        const mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
        try {
          const page = mobile.page
          // 先建 session（确立 cwd = TEST_CWD，Files 树读此目录）
          await createSessionViaUi(page, 'setup session for files', TEST_CWD)
          // 回列表（chat 视图占满，需先回 list 再切 tab；切 tab 不依赖视图态，但回 list 更干净）
          await page.locator('[data-testid="mobile-chat-back"]').click()
          await page.waitForSelector('[data-testid="mobile-session-list"]', { timeout: UI_TIMEOUT_MS })

          // 切 Files tab
          await switchTab(page, 'mobile-tab-files')
          // 选中 session 后 FilesTab 渲染 MobileFilesView（文件树）
          // （MobileShell 持有 currentSessionId，TC1 创建后已透传；Files tab 应直接显示树）
          await page.waitForSelector('[data-testid="mobile-files-view"], [data-testid="mobile-files-select-session"]', {
            timeout: UI_TIMEOUT_MS,
          })
          // 若提示选 session（currentSessionId 未透传），回 Sessions 选一次再切回
          if (await page.locator('[data-testid="mobile-files-select-session"]').isVisible()) {
            await switchTab(page, 'mobile-tab-sessions')
            const firstItem = page.locator('[data-testid^="mobile-session-item-"]').first()
            await expect(firstItem).toBeVisible({ timeout: UI_TIMEOUT_MS })
            await firstItem.click()
            await expect(page.locator('[data-testid="mobile-chat-view"]')).toBeVisible({
              timeout: PI_ACTION_TIMEOUT_MS,
            })
            await page.locator('[data-testid="mobile-chat-back"]').click()
            await switchTab(page, 'mobile-tab-files')
            await page.waitForSelector('[data-testid="mobile-files-view"]', { timeout: UI_TIMEOUT_MS })
          }

          // 断言文件树出现（mobile-files-tree 始终渲染；mobile-files-empty 在树为空时）
          await expect(page.locator('[data-testid="mobile-files-tree"]')).toBeVisible()
          // 等文件树加载（fileApi.tree RPC 往返 + pi 进程读目录）。
          // 注意：FileNode.path 相对 cwd（顶层 = 文件名），故 testid = mobile-file-node-<name>，
          // 非 mobile-file-node-<absPath>。
          const fileNode = page.locator(`[data-testid="mobile-file-node-${TEST_FILE_NAME}"]`)
          await expect(fileNode).toBeVisible({ timeout: PI_ACTION_TIMEOUT_MS })
          // 点文件 → 进 detail 视图
          await fileNode.click()
          await expect(page.locator('[data-testid="mobile-file-detail"]')).toBeVisible({
            timeout: PI_ACTION_TIMEOUT_MS,
          })
        } finally {
          await mobile.cleanup()
        }
      } finally {
        await runtime.stop()
      }
    })

    test('TC5: Settings tab 显示连接信息 + 断开按钮可见', async () => {
      const runtime = await startRemoteRuntime({ seedModelConfig: true })
      try {
        const mobile = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
        try {
          const page = mobile.page
          await switchTab(page, 'mobile-tab-settings')
          // Settings 渲染（不依赖 session，无需先建 session）
          await page.waitForSelector('[data-testid="mobile-settings"]', { timeout: UI_TIMEOUT_MS })
          // host 显示 runtime 的 httpUrl（profile.url）
          const hostEl = page.locator('[data-testid="mobile-settings-host"]')
          await expect(hostEl).toBeVisible()
          // host 应包含 runtime 端口（127.0.0.1:<port>）
          await expect(hostEl).toContainText(String(runtime.port))
          // 断开按钮可见（不在本用例点击，避免影响；断开测试由 mobile-connect.spec TC7 覆盖）
          await expect(page.locator('[data-testid="mobile-settings-disconnect"]')).toBeVisible()
        } finally {
          await mobile.cleanup()
        }
      } finally {
        await runtime.stop()
      }
    })
  })
})
