/**
 * chat-flow-merged E2E —— message-stream-main-fusion 融合改动的 streaming 边界行为验证。
 *
 * 依据：.xyz-harness/2026-07-27-message-stream-main-fusion/e2e-real-test-plan.md
 * 场景 1/2/5（mock 轨，确定性优先）。
 *
 * 测试哲学：实际测出 bug 并修复，不为覆盖率。每个用例用 MutationObserver / DOM 锚点
 * 量化判定（mount 次数、重排次数），不用「最终稳定存在」这种测不出过程问题的弱断言。
 *
 * 数据流（mock 轨）：VITE_MOCK=true → run-send-stream.ts 按 user 输入关键字分发：
 *   - 含 'test-fail-mid-stream' → emitFailMidStreamBranch（并发 running tool 中途失败）
 *   - 含 'test-multi-thinking'  → emitMultiThinkingBranch（3 个连续 thinking 块）
 *
 * 已知坑（§6）：
 * - mock 回显双匹配：用 testid 锚点，不用 getByText 匹配 user 输入
 * - contenteditable composer：pressSequentially 不用 fill
 * - 改 renderer 后要 build:e2e 重建 mock bundle
 *
 * 运行：npx playwright test e2e/chat-flow-merged.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 s3 session（空会话「API 性能优化」，避免 s1 复杂流式干扰）。
 *
 * 侧栏会话列表的「会话」tab 按钮仅在会话组折叠时渲染；展开态下直接显 session 列表项。
 * 故先尝试点 tab 按钮（若存在），再直接定位 session 文本（generic 元素），双路径保证稳健。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  // 若「会话」tab 按钮存在（会话组折叠态），点开它
  const sessionTab = page.getByRole('button', { name: /^会话/ })
  if (await sessionTab.count() > 0) {
    await sessionTab.click()
  }
  // session 列表项是带 cursor 的 generic（非 button），直接点文本最稳
  await expect(page.getByText('API 性能优化', { exact: true })).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化', { exact: true }).click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

/**
 * 在当前 session 发送消息（contenteditable composer，pressSequentially 触发 input）。
 * 发送后等待 stop-btn 出现（message_start 后 isGenerating=true）。
 */
async function sendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const input = page.getByRole('textbox')
  await input.click()
  await input.pressSequentially(text)
  await expect(input).toContainText(text)
  await input.press('Enter')
  // 等 busy 态（stop-btn 出现证明流式已启动）。
  // 给足 10s 超时：mock send 有 TIMING.ack 延迟 + message_start 处理链路，5s 偶发不够。
  await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 10_000 })
}

/** 等待当前 session 流式完成（stop-btn 消失）。 */
async function waitForStreamComplete(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 30_000 })
}

test.describe('merged block streaming 边界行为（message-stream-main-fusion）', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 场景 1：streaming 中途 tool 失败导致 merged 卡片重排
  // bug 假设：A B 两 tool 同时 running 合并成 merged 卡，B 变 error 时 merged 卡卸载重挂，
  //          MergedBlockCard 本地 expanded ref 丢失（v-for key 从 merged-tool 变 single-tool）。
  // ─────────────────────────────────────────────────────────────────────────
  test('场景1: 并发 running tool 中途失败 → merged 卡重排，失败块醒目（无异常重挂）', async ({ page }) => {
    await activateSession(page)

    // 发送前注入 MutationObserver：记录 merged 卡的 mount 次数（added 到 DOM 的次数）
    // 用于检测 merged→single 重排时是否发生异常多次 mount（闪烁）。
    // merged→single 的预期重排是 1 次 mount（流式开始时 merged 卡创建）+ 最终 1 次 unmount（B 失败拆组）。
    // 若中途出现多次 added = 异常重挂 bug。
    await page.evaluate(() => {
      // @ts-expect-error -- 注入到 window 供测试后读取
      window.__mergedMountCount = 0
      // @ts-expect-error -- 同上
      window.__mergedUnmountCount = 0
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((n) => {
            if (n instanceof HTMLElement && n.dataset?.testid === 'merged-block-card') {
              // @ts-expect-error -- 读 window 计数
              window.__mergedMountCount = (window.__mergedMountCount ?? 0) + 1
            }
          })
          m.removedNodes.forEach((n) => {
            if (n instanceof HTMLElement && n.dataset?.testid === 'merged-block-card') {
              // @ts-expect-error -- 读 window 计数
              window.__mergedUnmountCount = (window.__mergedUnmountCount ?? 0) + 1
            }
          })
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      // @ts-expect-error -- 存 observer 引用防止 GC
      window.__mergedObserver = observer
    })

    await sendMessage(page, 'test-fail-mid-stream 触发并发失败场景')

    // ── 阶段 1：merged 卡应出现（A B 同时 running 时合并）──
    // fail-mid-stream 流序：thinking → toolA start → toolB start（并发 running）→ 2s 保持窗口
    // 在保持窗口内 merged 卡可见（两个 running tool 合并）
    await expect(page.locator('[data-testid="merged-block-card"]')).toBeVisible({ timeout: 10_000 })

    // ── 阶段 2：merged 卡应可手动展开/收起（header 点击）──
    const header = page.locator('[data-testid="merged-block-card-header"]')
    await expect(header).toBeVisible()
    // working 时默认展开，点 header 收起（验可交互 + 建立用户展开态）
    await header.click()

    // ── 阶段 3：等待流式完成（含 toolB error 到达，触发 merged→single 重排）──
    await waitForStreamComplete(page)

    // ── 阶段 4：断言重排后状态 ──
    // (a) merged 卡消失：B 失败后 isFailedTool 断开合并链，拆为 2 个 single 块
    await expect(page.locator('[data-testid="merged-block-card"]')).toHaveCount(0)

    // (b) complete 态 turn 默认折叠（showTrace=false），需展开 turn 才能看到 trace 内 tool 块。
    //     点 turn-meta 的 toggle 按钮展开 turn（useTurnExpansion.toggle）。
    //     注：turn.index 从 1 开始（messageTurns.ts turnSeq 预递增），首条消息 turn = turn-1。
    const turnMeta = page.locator('[data-testid="turn-meta-1"]')
    await expect(turnMeta).toBeVisible({ timeout: 5_000 })
    await turnMeta.getByRole('button').click()
    // 等 trace 展开渲染（Transition + v-if showTrace）
    await page.waitForTimeout(300)

    // (c) 失败 tool 块可见 + 错误文本可见：B 失败后 isFailed → Block 强制展开（toolExpanded=true），
    //     错误输出 'File not found' 在 tool-result 区可见。
    //     注：completed tool（A）默认收起，失败 tool（B）强制展开——错误须直视。
    await expect(page.getByText('File not found').first()).toBeVisible({ timeout: 5_000 })

    // (d) 读 MutationObserver 计数：merged 卡 mount 次数应 == 1（仅流式开始时创建一次）
    //     重排是 unmount（merged 卡消失），不是重复 mount。mount > 1 = 异常重挂闪烁 bug。
    const mountCount = await page.evaluate(() => (window as any).__mergedMountCount ?? 0)
    // 记录实测值便于诊断
    // eslint-disable-next-line no-console
    console.log(`[场景1] merged 卡 mount 次数 = ${mountCount}`)

    // 核心 bug 判定：merged 卡仅 mount 一次。多次 mount = 流式中 merged 卡被反复卸载重挂（闪烁 bug）。
    // 注：场景 1 的「expanded ref 丢失」属设计预期（merged 卡整体卸载，ref 必然丢），
    //     这里测的是「是否额外产生不必要的多次重挂」——mount==1 即无异常重挂。
    expect(mountCount).toBe(1)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 场景 2：连续 thinking 块到达时 single→merged 边界闪烁
  // bug 假设：每加一个 thinking 块触发前一个 single 销毁 + merged 重挂，N 个块 N-1 次闪烁。
  // 量化判定：merged 卡 mount 次数应 = 1（首块 single，第 2 块到达 mount merged，第 3 块只 update）。
  // ─────────────────────────────────────────────────────────────────────────
  test('场景2: 连续 thinking 块到达 → merged 卡 mount 次数应=1（无闪烁）', async ({ page }) => {
    await activateSession(page)

    // 发送前注入 MutationObserver（在 sendMessage 之前，确保捕获从 0 到 1 的首次 mount）
    await page.evaluate(() => {
      // @ts-expect-error -- 注入到 window
      window.__mergedMountCount = 0
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((n) => {
            if (n instanceof HTMLElement && n.dataset?.testid === 'merged-block-card') {
              // @ts-expect-error -- 读 window 计数
              window.__mergedMountCount = (window.__mergedMountCount ?? 0) + 1
            }
          })
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      // @ts-expect-error -- 存 observer 引用
      window.__mergedObserver = observer
    })

    await sendMessage(page, 'test-multi-thinking 触发多思考块场景')

    // multi-thinking 流序：3 个连续 thinking 块逐个到达。
    // 预期：第 1 块 single，第 2 块到达时 mount merged（count 0→1），第 3 块加入只 update（count 不变）。
    // 最终 merged 卡可见（3 个 thinking 合并）
    await waitForStreamComplete(page)

    // 断言：流结束后 merged 卡存在（3 个 thinking 合并）
    await expect(page.locator('[data-testid="merged-block-card"]')).toBeVisible({ timeout: 5_000 })

    const mountCount = await page.evaluate(() => (window as any).__mergedMountCount ?? 0)
    // eslint-disable-next-line no-console
    console.log(`[场景2] merged 卡 mount 次数 = ${mountCount}`)

    // 核心 bug 判定：3 个连续 thinking 块，merged 卡应仅 mount 1 次。
    // mount > 1 = 每加一块都重挂 merged 卡 = 闪烁 bug（v-for key 含 blk.kind 变化触发重挂）。
    expect(mountCount).toBe(1)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 场景 5：useTurnExpansion 的 session 切换隔离
  // bug 假设：W1 从本地 ref 迁移到 Pinia store，session 切换时折展状态可能泄漏到新 session。
  // ─────────────────────────────────────────────────────────────────────────
  test('场景5: session 切换折展状态隔离（A 展开 → B 折叠 → 切回 A 仍展开）', async ({ page }) => {
    // ── 步骤 1：s3 发消息，等流式完成（生成一个 turn）──
    await activateSession(page)
    await sendMessage(page, '场景5 隔离测试 A')
    await waitForStreamComplete(page)

    // 等 turn 渲染（turn-meta + turn-1，turn.index 从 1 开始）
    const turnMetaA = page.locator('[data-testid="turn-meta-1"]')
    await expect(turnMetaA).toBeVisible({ timeout: 5_000 })

    // ── 步骤 2：展开 turn（点 turn-meta 按钮；complete 态可点击）──
    // complete 态 turn-meta 的 Button 可点击（非 sessionActive，非 disabled）
    // 初始默认折叠，点击后展开
    const toggleBtnA = turnMetaA.getByRole('button')
    await toggleBtnA.click()

    // 断言 A 的 turn 已展开（chevron rotate-90）
    // 用 chevron 的 rotate-90 class 判定展开态（TurnMeta.vue:34）
    await expect(turnMetaA.locator('.chev')).toHaveClass(/rotate-90/)

    // ── 步骤 3：新建/切换到 session B（点「新建任务」进 landing，发消息生成新 turn）──
    await page.getByRole('button', { name: /^新建任务/ }).click()
    await expect(page.getByTestId('new-task-landing')).toBeVisible({ timeout: 5_000 })

    // 在 B 发消息生成 turn（landing 态 composer 发送后建 session）
    const inputB = page.getByRole('textbox')
    await inputB.click()
    await inputB.pressSequentially('场景5 隔离测试 B')
    await inputB.press('Enter')
    await waitForStreamComplete(page)

    // ── 步骤 4：断言 B 的 turn 折叠（未展开，不继承 A 的展开态）──
    const turnMetaB = page.locator('[data-testid="turn-meta-1"]')
    await expect(turnMetaB).toBeVisible({ timeout: 5_000 })
    // B 的 chevron 不应有 rotate-90（折叠态）。无 hasFoldable 时无 chev，故用 count 或 class 判定
    const chevBRotated = await turnMetaB.locator('.chev.rotate-90').count()
    expect(chevBRotated).toBe(0)

    // ── 步骤 5：切回 session A（侧栏点「API 性能优化」）──
    // session 列表项是带 cursor 的 generic（非 button），直接点文本最稳。
    // 若侧栏收起，先点「切换侧栏」展开。
    const toggleSidebar = page.locator('button:has-text("切换侧栏")')
    if (await toggleSidebar.count() > 0) {
      // 已展开态无此按钮或按钮无展开动作，直接尝试点 session 文本
    }
    await expect(page.getByText('API 性能优化', { exact: true })).toBeVisible({ timeout: 10_000 })
    await page.getByText('API 性能优化', { exact: true }).click()
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })

    // ── 步骤 6：断言 A 的 turn 仍展开（per-session 隔离，状态保留）──
    const turnMetaAReloaded = page.locator('[data-testid="turn-meta-1"]')
    await expect(turnMetaAReloaded).toBeVisible({ timeout: 5_000 })
    await expect(turnMetaAReloaded.locator('.chev')).toHaveClass(/rotate-90/)
  })
})
