/**
 * GUI 组件渲染 E2E —— Playwright + Electron + mock 轨。
 *
 * 验证 GUI 渲染协议的两条路径全链路：
 *
 * 路径 B（tool result __gui__）:
 *   mock tool_call_end 携带 details.__gui__ → Block.vue extractGui 提取
 *   → GuiComponentRenderer 路由 → card 嵌套 progress-bar + stats-line 渲染
 *
 * 路径 A（extension:widgetGui）:
 *   mock 推送 extension:widgetGui → SideDrawer useSessionEvents 消费
 *   → guiWidgetsByTab 存储 → GuiComponentRenderer 渲染
 *   - stats-line widget（widgetKey='gui-demo' → terminal tab）
 *   - list-tree widget（widgetKey='gui-browser-demo' → browser tab）
 *
 * mock 轨数据流：VITE_MOCK=true → chat.send → run-send-stream 自动推送
 * tool_call_end(含 __gui__) + extension:widgetGui × 2。
 *
 * 运行：npx playwright test e2e/gui-components.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 s3 session（「API 性能优化」，空 session 发消息后进入流式）。
 * 与 state-tearing.spec.ts 相同的 activateSession 策略——已验证能成功发消息。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

/**
 * 发送消息并等待流式完成。
 * mock run-send-stream 推送序列：message_start → thinking → tool_call_end(含 __gui__)
 * → extension:widgetGui × 2 → text_delta → file_changes → complete。
 *
 * 等待 complete 的信号：stop-btn 消失（isGenerating=false）。
 */
async function sendMessageAndWaitComplete(page: import('@playwright/test').Page): Promise<void> {
  const input = page.getByRole('textbox')
  await input.click()
  await input.pressSequentially('GUI 测试')
  await input.press('Enter')
  // 等 busy → idle（mock complete 后 isGenerating=false → stop-btn 消失）。
  // stop-btn 可能出现得很快又消失（mock 流式快），用 toHaveCount(0) + 长 timeout 兜底。
  // 注意：此处 .catch(() => {}) 非关键断言——stop-btn 可能闪现太快 3s 内没看到。
  // 真实的「消息未发出」失败由下方 `已处理` 文案断言兜底（mock canned reply 才含该词）。
  const stopBtn = page.locator('.stop-btn')
  await expect(stopBtn).toBeVisible({ timeout: 3_000 }).catch(() => {})
  await expect(stopBtn).toHaveCount(0, { timeout: 30_000 })
  // 等 assistant 回复内容可见（mock canned reply 含「已处理」）
  await expect(page.getByText(/已处理/)).toBeVisible({ timeout: 5_000 })
}

test.describe('GUI 组件渲染 E2E', () => {
  test('harness smoke：Electron app 加载首窗口 + 关键交互元素', async ({ page }) => {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
    // 首屏关键交互元素：sidebar 会话按钮（后续用例都依赖它）
    await expect(page.getByRole('button', { name: /^会话/ })).toBeVisible({ timeout: 10_000 })
  })

  test('路径 B: tool result __gui__ → Block.vue → card 嵌套渲染', async ({ page }) => {
    await activateSession(page)
    await sendMessageAndWaitComplete(page)

    // turn 完成后默认收起 trace（含 tool 块）。点 turn-meta header 展开 trace。
    const turnMeta = page.locator('.turn-meta').first()
    await expect(turnMeta).toBeVisible({ timeout: 5_000 })
    await turnMeta.click()

    // trace 展开后，tool 块 header 可见（mock 推了 toolName='read'），点击展开 tool 详情
    const toolHeader = page.getByTestId('tool-block-header')
    await expect(toolHeader).toBeVisible({ timeout: 5_000 })
    await toolHeader.click()

    // 展开后 guiComponent 渲染出 card（mock details.__gui__ = card 嵌套 progress-bar + stats-line）
    // card 存在（递归渲染导致 gui-component-renderer 有多个，直接断言 gui-card 更精确）
    const card = page.getByTestId('gui-card')
    await expect(card).toBeVisible({ timeout: 5_000 })
    // header 文本
    await expect(card).toContainText('CI Pipeline')

    // 内嵌 progress-bar
    const progressBar = page.getByTestId('gui-progress-bar')
    await expect(progressBar).toBeVisible()
    await expect(progressBar).toContainText('build')
    await expect(progressBar).toContainText('7')
    await expect(progressBar).toContainText('8')

    // 内嵌 stats-line
    const statsLine = page.getByTestId('gui-stats-line')
    await expect(statsLine).toBeVisible()
    await expect(statsLine).toContainText('turns')
    await expect(statsLine).toContainText('15')
  })

  test('路径 A: widgetGui stats-line → SideDrawer terminal tab 渲染', async ({ page }) => {
    await activateSession(page)
    await sendMessageAndWaitComplete(page)

    // 用 PanelHeader 的 drawer-toggle 按钮打开 SideDrawer（不依赖 git 仓库）
    await page.getByTestId('drawer-toggle').click()
    await expect(page.locator('aside[aria-label="侧边抽屉"]')).toBeVisible({ timeout: 5_000 })

    // 默认 terminal tab，stats-line widget 渲染（widgetKey='gui-demo' → terminal tab）
    const statsLine = page.locator('aside[aria-label="侧边抽屉"]').getByTestId('gui-stats-line')
    await expect(statsLine).toBeVisible({ timeout: 5_000 })
    await expect(statsLine).toContainText('turns')
    await expect(statsLine).toContainText('tokens')
    await expect(statsLine).toContainText('duration')
  })

  test('路径 A: widgetGui list-tree → SideDrawer browser tab 渲染', async ({ page }) => {
    await activateSession(page)
    await sendMessageAndWaitComplete(page)

    // 打开 SideDrawer
    await page.getByTestId('drawer-toggle').click()
    await expect(page.locator('aside[aria-label="侧边抽屉"]')).toBeVisible({ timeout: 5_000 })

    // 切到 browser tab
    await page.getByTestId('drawer-tab-browser').click()

    // list-tree widget 渲染（widgetKey='gui-browser-demo' → browser tab）
    // 递归渲染导致 gui-list-tree 有多个（父树 + 子树），用 first 精确定位外层
    const listTree = page.locator('aside[aria-label="侧边抽屉"]').getByTestId('gui-list-tree').first()
    await expect(listTree).toBeVisible({ timeout: 5_000 })
    await expect(listTree).toContainText('Deploy')
    await expect(listTree).toContainText('VPC')
    await expect(listTree).toContainText('RDS')
    await expect(listTree).toContainText('Redis')
  })
})
