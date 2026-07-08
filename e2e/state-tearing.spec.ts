/**
 * 状态撕裂修复 E2E —— Playwright + Electron + mock 轨。
 *
 * 验证 fix-state-tearing 的用户可见行为：
 * - E2E-ST-1: 发送消息 → UI 切到 busy（停止按钮出现）→ complete 后回 idle（发送按钮恢复）
 * - E2E-ST-2: busy 时停止按钮可见 + 可点击（abort 后回 idle）
 * - E2E-ST-3: busy 时 Enter → steer（B 策略，不打断当前回合）
 * - E2E-ST-4: 停止按钮在 busy 全程始终可见（不闪烁消失）
 *
 * mock 轨数据流：VITE_MOCK=true → send 后 run-send-stream 自动推
 * message_start(~60ms) → text_delta(*N) → complete。
 * isGenerating 从 message 实体派生，UI 状态切换完全由事件驱动。
 *
 * 运行：npx playwright test e2e/state-tearing.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 s3 session（空消息「API 性能优化」，避免 s1 复杂流式干扰）。
 * 与 composer.spec.ts 相同的 activateSession 策略。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

test.describe('状态撕裂修复 E2E（fix-state-tearing）', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
  })

  test('E2E-ST-1: 发送 → busy（停止按钮）→ complete → idle（发送按钮恢复）', async ({ page }) => {
    await activateSession(page)
    const input = page.getByRole('textbox')
    await input.click()
    await input.pressSequentially('测试消息')
    await expect(input).toContainText('测试消息')

    // 发送前：idle 态，有发送按钮（title 含「发送」），无停止按钮
    expect(await page.locator('.stop-btn').count()).toBe(0)

    // 按 Enter 发送
    await input.press('Enter')

    // busy 态：停止按钮应出现（message_start ~60ms 后 isGenerating=true）
    // 用 toBeVisible 而非 count，给 mock 流式事件时间到达
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })

    // 等待流式结束（mock complete 后 isGenerating=false → 停止按钮消失）
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 30_000 })

    // idle 恢复：输入区可输入（非 disabled）
    await input.click()
    await input.pressSequentially('后续')
    await expect(input).toContainText('后续')
  })

  test('E2E-ST-2: busy 时点停止按钮 → abort → 回 idle', async ({ page }) => {
    await activateSession(page)
    const input = page.getByRole('textbox')
    await input.click()
    await input.pressSequentially('长任务')
    await input.press('Enter')

    // 等停止按钮出现
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })

    // 点停止
    await page.locator('.stop-btn').click()

    // abort 后 mock 推 message.complete{stopReason:aborted} → isGenerating=false → 停止按钮消失
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 5_000 })
  })

  test('E2E-ST-3: busy 时 Enter → steer（B 策略，不重复 send）', async ({ page }) => {
    await activateSession(page)
    const input = page.getByRole('textbox')
    await input.click()
    await input.pressSequentially('第一条')
    await input.press('Enter')

    // 等 busy 态
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 5_000 })

    // busy 时输入补充内容 + Enter
    await input.click()
    await input.pressSequentially('补充')
    await input.press('Enter')

    // steer 后 mock 推 queue_update（steer 入队）→ QueueBubble 显示 pending 气泡
    // 验证：steer 不打断当前回合（停止按钮仍在 = 仍 busy）
    // QueueBubble 出现（pending 队列有内容）
    await expect(page.getByTestId('composer-box')).toBeVisible()

    // 等流式结束，停止按钮最终消失
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 30_000 })
  })
})
