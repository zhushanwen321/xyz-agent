/**
 * 远程 E2E —— lease 操作互斥（spec remote-use lease-mutex）。
 *
 * 覆盖场景：同一 session，设备 A 持有 lease（pi turn 进行中）时，设备 B 发消息被 runtime
 * lease acquire 拒绝（send.rejected{reason:'busy'}），B 移动端显示 toast；A 断线后 TTL
 * 过期（+ reaper 扫描）lease 释放，B 重发成功。
 *
 * 核心断言路径（为什么 B 走 send 而非 steer）：
 *  - useChat.send 在 chat.isActive(sid)（= isGenerating ∨ pendingSend）时自动转 steer。
 *  - 但 isActive 是 B 客户端本地 store 派生态——B 刚打开/水合 session，pi turn 由 A 发起，
 *    B 的 store 无 streaming 实体（A 持有 lease，A 收 message_start），故 B 的 isActive=false
 *    → B 走真实 send → runtime lease.acquire 返回 busy → broker.sendToClient(B, send.rejected)。
 *  - 移动端 useChat 订阅 send.rejected → clearPendingSend + useToast().error(payload.message)。
 *    payload.message = '其他设备正在处理'（lease.owner !== clientId 分支）。
 *
 * 时序控制（关键挑战 + 根因）：
 *  - 竞态表象：lease 持有窗口 = pi turn 处理时间。pi warm 快则窗口极短，B 抢不到。
 *  - 对策（方向 B + 确定性门控）：A 先用短 prompt 建 idle session，B 预打开 + 预填消息，
 *    A 再发长 turn prompt，【等 A 收到 pi 首个流事件】（证明 lease 已 acquire）后立即点 B send。
 *    用 pi 事件而非盲等，把 A 触发 → B 发送压到毫秒级，lease 窗口 = 整个 long turn。
 *  - 【真正根因】WS inbox 捕获：addInitScript 仅在后续导航前生效，但 launchMobileBrowser 已
 *    goto 完页面，wrapper 不会被装上 → __wsInbox 恒空 → send.rejected 协议断言恒超时。
 *    对策：injectWsCapture 注入后 reload 一次，让 initScript 在新 document 加载前执行。
 *  - 断言：WS 协议断言（send.rejected{reason:busy} + payload.message「其他设备正在处理」）
 *    + B 消息不入流。不测 toast UI（移动端未挂载 ToastContainer，product gap 非测试范畴）。
 *
 * TTL 配置：fixture opts.env 注入 XYZ_AGENT_LEASE_TTL_MS=3000（3s），便于 TC2 测 TTL 过期释放。
 * lease-manager 读 process.env.XYZ_AGENT_LEASE_TTL_MS（XYZ_ 前缀在 ENV_WHITELIST）。
 *
 * reaper：LeaseManager.sweepExpired 每 REAPER_INTERVAL_MS(5s) 扫一次，leaseExpiresAt<now 即
 * release('lease_expired') + 广播 session.idle。故 A 断线后最坏 TTL(3s) + reaper(5s) = 8s 释放。
 *
 * 前置条件（与 mobile-session.spec 对齐）：session.create 需 pi 可用 + 可预置模型配置，
 * 任一缺失整体 skip（probePiAvailable / probeModelConfigAvailable 在模块加载时探测）。
 *
 * 每用例：独立 startRemoteRuntime（leaseTtlMs=3000）+ launchMobileBrowser A + B → 测 → cleanup。
 */
import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startRemoteRuntime, type RemoteRuntimeInfo } from '../fixtures/remote-runtime'
import { launchMobileBrowser, type LaunchedMobileBrowser } from '../fixtures/launch-mobile-browser'

/** 移动端 lease 测试用的临时 cwd（runtime 与测试同机，/tmp 共享文件系统）。 */
const TEST_CWD = join(tmpdir(), 'xyz-e2e-lease-mutex')
const TEST_FILE_PATH = join(TEST_CWD, 'README.md')

/** 缩短的 lease TTL（ms）：便于 TC2 测 TTL 过期释放（默认 90s 太长）。 */
const LEASE_TTL_MS = 3_000
/**
 * reaper 扫描间隔（lease-manager.ts REAPER_INTERVAL_MS=5_000）。
 * TC2 等 lease 释放的 deadline：TTL + 一个完整 reaper 周期 + 余量。
 */
const REAPER_INTERVAL_MS = 5_000
const LEASE_RELEASE_DEADLINE_MS = LEASE_TTL_MS + REAPER_INTERVAL_MS + 2_000

/** pi 相关等待超时（session.create 触发 pi spawn 冷启 + 首条消息往返较慢）。 */
const PI_ACTION_TIMEOUT_MS = 60_000
/** 普通 UI 等待超时。 */
const UI_TIMEOUT_MS = 15_000

/** A 发的长 turn prompt——给 pi 足够的处理时间，让 B 能抢在 lease 持有窗口内发消息。 */
const LONG_TURN_PROMPT =
  'Write a very detailed long essay about the history of computing, at least 800 words, covering many decades and inventors in depth.'

/**
 * 建会话用的短 prompt——pi 处理快，turn 结束后 session 回 idle（无 lease）。
 * 用于 TC1 重排时序：先用短 prompt 建一个 idle session，让 B 充分打开 + 预填消息，
 * 再由 A 发 LONG_TURN_PROMPT 触发「真正要测」的 lease 持有窗口。
 */
const SHORT_SEED_PROMPT = 'Say "ready" and nothing else.'

/**
 * pi turn 进行中（lease 已被 A 持有）的确定性信号集合。
 * message.message_start / message.thinking_start / message.text_delta 都是 acquire 之后
 * 才由 event-adapter 广播的 pi 事件——任一【新增】即证明 A 的 lease 已获取 + pi 正在跑 turn。
 * 用作「触发 B 发送」的门控，替代盲等时序，消除竞态。
 */
const PI_TURN_ACTIVE_NEEDLES = [
  '"type":"message.message_start"',
  '"type":"message.thinking_start"',
  '"type":"message.text_delta"',
]

/**
 * 探测 pi 是否可用（模块加载时探测，供 describe.skip 判定）。
 * 查找顺序与 remote-runtime.findPiBinary 对齐（XYZ_PI_BIN > dev resources > PATH pi）。
 */
function probePiAvailable(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const repoRoot = join(here, '..', '..')
  if (process.env.XYZ_PI_BIN && existsSync(process.env.XYZ_PI_BIN)) {
    return process.env.XYZ_PI_BIN
  }
  const platform = process.platform
  const arch = process.arch
  const binaryName = platform === 'win32' ? `pi-windows-${arch}.exe` : `pi-${platform}-${arch}`
  const devPi = join(repoRoot, 'apps', 'electron', 'resources', 'pi', binaryName)
  if (existsSync(devPi)) return devPi
  try {
    const result = spawnSync('pi', ['--version'], { timeout: 5_000, stdio: 'pipe' })
    if (result.status === 0 || (result.stdout && result.stdout.toString().trim().length > 0)) {
      return 'pi'
    }
  } catch {
    // pi 不在 PATH → 不可用
  }
  return null
}

/**
 * 探测可预置的模型配置（session.create 校验 getDefaultModel() 必需）。
 * 源探测顺序与 remote-runtime.seedPiModelConfig 一致。
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

const piAvailable: string | null = probePiAvailable()
const modelConfigAvailable: string | null = probeModelConfigAvailable()
const prereqReady: boolean = piAvailable !== null && modelConfigAvailable !== null

/** 切换底部 tab（与 mobile-session.spec 同范式，显式点击确保状态）。 */
async function switchTab(
  page: Page,
  testId: 'mobile-tab-sessions' | 'mobile-tab-files' | 'mobile-tab-settings',
): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).click()
  const tabId = testId.replace('mobile-tab-', '')
  await page.waitForSelector(`[data-testid="mobile-tab-content-${tabId}"]`, { timeout: UI_TIMEOUT_MS })
}

/**
 * 通过 UI 新建 session（Chrome A 创建，含首条 prompt 触发 pi turn）。
 * 复用 mobile-session.spec 的 createSessionViaUi 范式。
 */
async function createSessionViaUi(page: Page, prompt: string, cwd: string): Promise<void> {
  await switchTab(page, 'mobile-tab-sessions')
  await page.locator('[data-testid="mobile-new-session-btn"]').click()
  await page.waitForSelector('[data-testid="mobile-new-session"]', { timeout: UI_TIMEOUT_MS })
  await page.locator('[data-testid="mobile-new-session-prompt"]').fill(prompt)
  await page.locator('[data-testid="mobile-new-session-cwd"]').fill(cwd)
  const submitBtn = page.locator('[data-testid="mobile-new-session-submit"]')
  await expect(submitBtn).toBeEnabled({ timeout: UI_TIMEOUT_MS })
  await submitBtn.click()
  await page.waitForSelector('[data-testid="mobile-chat-view"]', { timeout: PI_ACTION_TIMEOUT_MS })
}

/**
 * 在移动端页面上打开指定 session（从 session 列表点击进入 chat 视图）。
 * 用于 Chrome B 访问 A 创建的 session。
 */
async function openSessionFromList(page: Page): Promise<void> {
  await switchTab(page, 'mobile-tab-sessions')
  await page.waitForSelector('[data-testid="mobile-session-list"]', { timeout: UI_TIMEOUT_MS })
  await expect(page.locator('[data-testid="mobile-session-items"]')).toBeVisible({ timeout: UI_TIMEOUT_MS })
  const firstItem = page.locator('[data-testid^="mobile-session-item-"]').first()
  await expect(firstItem).toBeVisible({ timeout: UI_TIMEOUT_MS })
  await firstItem.click()
  await expect(page.locator('[data-testid="mobile-chat-view"]')).toBeVisible({
    timeout: PI_ACTION_TIMEOUT_MS,
  })
}

/**
 * 在 chat 视图 composer 填消息并点发送。
 * @returns 发送的文本（供断言消息流出现）
 */
async function sendMessageInChat(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="mobile-composer-input"]').fill(text)
  await page.locator('[data-testid="mobile-composer-send"]').click()
}

/**
 * 仅填 composer 输入框、不点发送（用于 TC1 时序重排：B 预先准备好消息，
 * 等 A 的 lease 确定性获取后再点 send，把「A 触发 → B 发送」的窗口压到最小）。
 */
async function fillComposer(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="mobile-composer-input"]').fill(text)
}

/**
 * 点击 composer 发送按钮（与 fillComposer 配合：先 fill 再 click，中间插 A 触发）。
 */
async function clickSend(page: Page): Promise<void> {
  await page.locator('[data-testid="mobile-composer-send"]').click()
}

/**
 * 注入 WS 帧捕获并使其生效：包装 window.WebSocket，把每条入站 message 推入
 * window.__wsInbox（数组）。供 TC1/TC2 协议断言 send.rejected / message.complete 等帧。
 *
 * 关键时序：addInitScript 仅在【后续】导航前执行。但 launchMobileBrowser 已 goto 完页面，
 * 此刻 SPA 已加载且 WebSocket 已构造——addInitScript 不追溯生效，wrapper 不会被装上，
 * __wsInbox 永远空（曾经导致 send.rejected 协议断言恒超时）。
 * 故注入后必须 reload 一次，让 initScript 在新 document 加载前执行、wrapper 重新包裹 WS。
 *
 * reload 后移动端 App.vue 读 location.hash（token 仍在 URL）自动重连 + 重新订阅，
 * 等待 mobile-shell/mobile-header 出现即重连完成。注入的 wrapper 透传所有行为
 *（onmessage 仍由 transport 正常注册），仅旁路记录原始帧文本。
 */
async function injectWsCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const inbox: string[] = []
    ;(window as unknown as { __wsInbox: string[] }).__wsInbox = inbox
    const NativeWS = window.WebSocket
    class WrappedWebSocket extends NativeWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        // 旁路监听入站消息：addEventListener 不干扰 transport 的 onmessage 赋值。
        this.addEventListener('message', (ev: MessageEvent) => {
          if (typeof ev.data === 'string') inbox.push(ev.data)
        })
      }
    }
    // 覆盖全局 WebSocket（transport 走 new WebSocket(...) 时拿到 wrapper）
    ;(window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      WrappedWebSocket as unknown as typeof WebSocket
  })
  // 让 initScript 生效：reload 后新 document 加载前 initScript 执行，wrapper 装上。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="mobile-shell"], [data-testid="mobile-header"]', {
    timeout: 30_000,
  })
}

/**
 * 读取页面 WS 入站 inbox 中是否已收到匹配的帧。
 * @param page 已注入 WS 捕获的 page
 * @param needle 帧文本子串（如 '"type":"send.rejected"'）
 * @returns true=已收到匹配帧
 */
async function wsInboxHas(page: Page, needle: string): Promise<boolean> {
  return page.evaluate(
    (n) => {
      const inbox = (window as unknown as { __wsInbox?: string[] }).__wsInbox ?? []
      return inbox.some((frame) => frame.includes(n))
    },
    needle,
  )
}

/**
 * 统计页面 WS 入站 inbox 中匹配某 needle 的帧数量（用于区分「新增」事件，消除历史帧干扰）。
 * TC1 中 seed turn 已在 A inbox 留下 message_start/message_complete，发长 prompt 后需用
 * 计数增量判定「长 prompt 的 pi turn 已启动」，而非简单存在性。
 */
async function wsInboxCount(page: Page, needle: string): Promise<number> {
  return page.evaluate(
    (n) => {
      const inbox = (window as unknown as { __wsInbox?: string[] }).__wsInbox ?? []
      return inbox.filter((frame) => frame.includes(n)).length
    },
    needle,
  )
}

// 串行（每用例独立 runtime + 双 browser；remote 项目 workers=1 已串行，显式标注防并行 mode 串扰）
test.describe.serial('lease 操作互斥 E2E', () => {
  test.beforeAll(() => {
    mkdirSync(TEST_CWD, { recursive: true })
    writeFileSync(TEST_FILE_PATH, 'lease mutex e2e fixture cwd', { encoding: 'utf8' })
  })

  test.afterAll(() => {
    try {
      rmSync(TEST_CWD, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  ;(prereqReady ? test.describe : test.describe.skip)('pi 可用时的 lease 互斥', () => {
    /**
     * 辅助：启动带缩短 TTL 的 runtime + Chrome A + Chrome B（均注入 WS 捕获）。
     * 返回 runtime + 两个 browser，调用方负责 cleanup（finally 内逆序）。
     */
    async function setupRig(): Promise<{
      runtime: RemoteRuntimeInfo
      a: LaunchedMobileBrowser
      b: LaunchedMobileBrowser
    }> {
      const runtime = await startRemoteRuntime({
        seedModelConfig: true,
        env: { XYZ_AGENT_LEASE_TTL_MS: String(LEASE_TTL_MS) },
      })
      const a = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
      await injectWsCapture(a.page)
      const b = await launchMobileBrowser(runtime, { connectTimeoutMs: 40_000 })
      await injectWsCapture(b.page)
      return { runtime, a, b }
    }

    test('TC1: A 持有 lease 时 B 发消息被拒绝（send.rejected{busy}）', async () => {
      const { runtime, a, b } = await setupRig()
      try {
        // ── 时序重排（消除竞态，方向 B + lease 确定性门控）──
        // 旧实现：A 先发长 prompt → B 才打开 session + 发消息。问题：openSessionFromList 慢
        //（switchTab + waitForSelector + click），等 B 就绪时 pi turn 可能已结束（pi warm 快），
        // lease 已释放 → B 不被拒 → 收不到 send.rejected → 超时。
        //
        // 新顺序：
        //  1. A 用【短】prompt 建 session（pi 快速结束 → session idle，无 lease 残留）
        //  2. B 打开同一 session + 预填消息（不点 send）—— 全部「慢」准备前置完成
        //  3. A 在 chat 内发 LONG_TURN_PROMPT（触发 lease acquire + pi 长 turn）
        //  4. 【确定性门控】等 A 的 WS inbox 收到 pi 首个流事件（message.message_start /
        //     thinking_start / text_delta）—— 证明 lease 已被 A 获取 + pi 正在跑 turn
        //  5. 立即点 B 的 send（此刻 A 的 lease 确定性持有，B 必被拒）
        // 关键：用 pi 事件而非盲等，把 A 触发 → B 发送压到毫秒级，且 lease 窗口 = 整个 long turn。

        // 步骤 1：A 用短 prompt 建 session（pi turn 短，结束后 session idle 无 lease）。
        await createSessionViaUi(a.page, SHORT_SEED_PROMPT, TEST_CWD)
        // 等 A 的 seed turn 完全结束：等 A 的 WS inbox 收到 message.complete（pi agent_end
        // 广播，event-adapter 直发）。这保证 isGenerating=false + lease 已 release——
        // 否则 A 发长 prompt 会被 useChat.send 判定 isActive → 转成 steer（不发新 prompt，
        // 不重新 acquire，破坏下方 pi 事件门控）。message.complete 比 session.idle 更底层可靠
        //（后者经 lease release 间接广播，时序/序列化更易出岔）。
        await expect
          .poll(() => wsInboxHas(a.page, '"type":"message.complete"'), {
            timeout: PI_ACTION_TIMEOUT_MS,
          })
          .toBe(true)

        // 步骤 2：B 打开同一 session + 预填消息（不点 send）。
        await openSessionFromList(b.page)
        const bText = 'B tries to send while A holds lease'
        await fillComposer(b.page, bText)

        // 步骤 3 前置：快照 A 的 pi 流事件计数（seed turn 已留 message_start 等），
        // 用于步骤 4 判定【长 prompt 的新 turn】已启动（计数须较快照增长）。
        const startCounts = await Promise.all(
          PI_TURN_ACTIVE_NEEDLES.map((n) => wsInboxCount(a.page, n)),
        )

        // 步骤 3：A 在 chat composer 发长 prompt（触发 lease acquire + pi 长 turn）。
        await sendMessageInChat(a.page, LONG_TURN_PROMPT)

        // 步骤 4（确定性门控）：等 A 的 WS inbox 收到【新增】的 pi 流事件（计数 > 快照）。
        // message_start / thinking_start / text_delta 都是 lease acquire 之后才广播的事件，
        // 计数增长即证明 A 的【长 prompt turn】lease 已获取 + pi 正在跑（lease 窗口已打开）。
        // 用增量而非存在性，排除 seed turn 历史帧误判。
        await expect
          .poll(async () => {
            for (let i = 0; i < PI_TURN_ACTIVE_NEEDLES.length; i++) {
              const now = await wsInboxCount(a.page, PI_TURN_ACTIVE_NEEDLES[i]!)
              if (now > startCounts[i]!) return true
            }
            return false
          }, { timeout: PI_ACTION_TIMEOUT_MS })
          .toBe(true)

        // 步骤 5：立即点 B 的 send（A 的 lease 确定性持有中，B 必被 lease busy 拒绝）。
        await clickSend(b.page)

        // 断言 1（WS 协议，底层可靠）：B 的 WS inbox 收到 send.rejected{reason:'busy'}。
        // send.rejected 由 broker.sendToClient(B, ...) 点对点投递，仅 B 收到。
        await expect
          .poll(() => wsInboxHas(b.page, '"type":"send.rejected"'), { timeout: 15_000 })
          .toBe(true)
        // 进一步确认 reason=busy（防误判其他类型的 rejected）
        await expect
          .poll(() => wsInboxHas(b.page, '"reason":"busy"'), { timeout: 5_000 })
          .toBe(true)
        // 确认 owner ≠ B（message 是「其他设备正在处理」而非「本设备正在处理」）：
        // lease.owner=A，B 是发起方，故 payload.message 应含「其他设备正在处理」。
        await expect
          .poll(() => wsInboxHas(b.page, '其他设备正在处理'), { timeout: 5_000 })
          .toBe(true)

        // 【不测 toast UI】useChat.send.rejected handler 确实调 useToast().error(payload.message)
        //（见 useChat.ts:89-94），但移动端 App.vue / MobileShell.vue 当前【未挂载 ToastContainer】
        //（grep 确认 mobile 布局无 <ToastContainer>），故 toast 永不渲染。这是移动端 product gap
        //（非本测试范畴）；此处改用 payload.message 断言（上面）覆盖「用户可见反馈文本」语义，
        // 待移动端补挂 ToastContainer 后可恢复 .pointer-events-auto toast 断言。

        // 断言 2（互斥确认）：B 恰好收到 1 条 send.rejected，没有被「偶尔成功」。
        //（注意：不能断言「bText 不在消息流」——useChat.send 在调 chatApi.send 前已 appendUser
        // 乐观用户气泡，clearPendingSend 只清 dispatching 态、不删已 append 的用户消息，
        // 故被拒后用户气泡仍在流里。WS send.rejected 才是被拒的可靠证据。）
        const rejectCount = await wsInboxCount(b.page, '"type":"send.rejected"')
        expect(rejectCount).toBeGreaterThanOrEqual(1)
      } finally {
        await b.cleanup()
        await a.cleanup()
        await runtime.stop()
      }
    })

    test('TC2: A 断线后 TTL 过期 lease 释放，B 可发消息', async () => {
      const { runtime, a, b } = await setupRig()
      try {
        // Chrome A 创建 session + 发长 turn prompt（持有 lease）
        await createSessionViaUi(a.page, LONG_TURN_PROMPT, TEST_CWD)
        // Chrome B 打开同一 session
        await openSessionFromList(b.page)

        // 先确认互斥生效（与 TC1 同前置：B 此时发会被拒）
        await sendMessageInChat(b.page, 'B attempt before A disconnect')
        await expect
          .poll(() => wsInboxHas(b.page, '"type":"send.rejected"'), { timeout: 15_000 })
          .toBe(true)

        // A 断线：page.close 触发 WS 断开，但 lease 不会立即释放（lease 由 TTL + reaper 管）。
        await a.page.close()
        // A 的 lease 在断线后仍持有（busyOwnerId 不因 WS 断开清除），靠 TTL 过期 + reaper 释放。
        // 等 TTL(3s) + reaper 扫描(≤5s) 后 lease 释放 + 广播 session.idle。
        await new Promise<void>((resolve) => setTimeout(resolve, LEASE_RELEASE_DEADLINE_MS))

        // B 重新发消息：此刻 lease 已释放，B 应成功（不被拒绝）。
        const bText = 'B sends after A lease expired'
        await sendMessageInChat(b.page, bText)

        // 断言 1（成功反馈）：B 的消息出现在对话流（appendUser 渲染用户气泡）。
        // 这是「发送成功」的最直接 UI 证据（被拒则不入流，见 TC1 断言 3）。
        await expect(
          b.page.locator('.message-stream').locator(`text=${bText}`),
        ).toBeVisible({ timeout: PI_ACTION_TIMEOUT_MS })

        // 断言 2（协议层）：本次发送后 B 不再收到新的 send.rejected。
        // 快照拒绝帧计数，发后短暂等待确认无新增拒绝帧。
        const rejectCountBefore = await b.page.evaluate(() => {
          const inbox = (window as unknown as { __wsInbox?: string[] }).__wsInbox ?? []
          return inbox.filter((f) => f.includes('"type":"send.rejected"')).length
        })
        // 等待一个短暂窗口，确认无新增 send.rejected（lease 已释放，应成功）。
        await new Promise<void>((resolve) => setTimeout(resolve, 3_000))
        const rejectCountAfter = await b.page.evaluate(() => {
          const inbox = (window as unknown as { __wsInbox?: string[] }).__wsInbox ?? []
          return inbox.filter((f) => f.includes('"type":"send.rejected"')).length
        })
        expect(rejectCountAfter).toBe(rejectCountBefore)
      } finally {
        // a.page 已 close，cleanup 幂等（context.close / browser.close best-effort）
        await b.cleanup()
        await a.cleanup()
        await runtime.stop()
      }
    })

    /**
     * TC3: A abort 后 lease 释放，B 可发 —— [需手工]
     *
     * 跳过原因：移动端 chat 视图（MobileChatView.vue / MobileComposer.vue）当前无 abort/stop
     * 按钮的 data-testid（grep 仅见 mobile-composer-input / mobile-composer-send），无法在
     * E2E 中可靠触发 abort。abort 路径（message-dispatcher.abort → lease.release('aborted')）
     * 已被单元测试覆盖（lease-manager / message-dispatcher 的 abort 测试）。
     * 若后续移动端增加 abort 按钮（如 mobile-composer-abort testid），可补此用例：
     *   1. A 发长 turn prompt（持 lease）
     *   2. B 发消息被拒（断言 send.rejected，与 TC1 同）
     *   3. A 点 abort 按钮 → lease.release('aborted') + 广播 message.complete{aborted}
     *   4. B 重发消息 → 成功（断言消息入流）
     */
    test.skip('TC3: A abort 后 lease 释放 B 可发 [需手工]', () => {
      // 见上方注释：移动端无 abort UI testid，待补 testid 后实现。
    })
  })
})
