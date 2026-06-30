/**
 * Composer E2E —— `#` 文件候选 + `@` 入口移除 + landing 守门（02-composer.md §8/§9）。
 *
 * 数据流（MOCK 轨）：VITE_MOCK=true → composer domain 走 mockApi.composer，
 * getFileCandidates 返回 FILE_CANDIDATES 映射的 FileNode[]（src/auth/、AuthService.ts、token.ts）。
 * real file.search 的数据正确性由 runtime 单测（file-service.test.ts U1-U12）覆盖，
 * 本 E2E 验证 UI 流程（浮层弹出 / 选中插 chip / 入口移除 / landing 守门）。
 *
 * 覆盖用例（对照 02-composer.md §9 覆盖缺口 backlog）：
 * - E2E-CF-1: composer 渲染（输入区可见）
 * - E2E-CF-2: 点 + 菜单「文件」→ # 浮层弹出 + 候选可见
 * - E2E-CF-3: 选中文件 → 插入 # chip
 * - E2E-CF-4: AddMenuPopover 无「引用」(@) 入口（@ 已废弃）
 * - E2E-CF-5: landing 态（无 session）AddMenuPopover 无「文件」(#) 入口（landing 守门 G10）
 *
 * 约束（见 00-test-strategy-overview.md §6）：
 * - contenteditable 用 pressSequentially（fill 可能不触发 input）
 * - CommandPopover portal 到 body，全局查命令 button
 * - SegmentedTab 按钮文本带计数，用正则前缀匹配
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 session（panel variant composer 出现在对话流下方）。
 * 用 s3「API 性能优化」（空消息 session，验证欢迎语）——避免 s1 的复杂流式干扰。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  // 等 composer 渲染（panel variant）
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

test.describe('Composer # 文件候选 E2E', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
  })

  test('E2E-CF-1: composer 渲染（输入区可见可聚焦）', async ({ page }) => {
    await activateSession(page)
    await page.getByRole('textbox').click()
    await expect(page.getByRole('textbox')).toBeFocused()
  })

  test('E2E-CF-2: 点 + 菜单「文件」→ # 浮层弹出 + 候选可见', async ({ page }) => {
    await activateSession(page)
    // 点 + 按钮（AddMenuPopover trigger，title 含「添加内容」）
    await page.getByTitle(/添加内容/).click()
    // + 菜单弹出（portal 到 body），点「文件」项（button name 含 hint '#'）
    await page.getByRole('button', { name: '文件 #' }).click()
    // CommandPopover 浮层弹出（portal 到 body），展示 mock 候选
    // FILE_CANDIDATES 经映射后含：src/auth/、AuthService.ts、token.ts
    await expect(page.getByText('AuthService.ts')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText('token.ts')).toBeVisible()
  })

  test('E2E-CF-3: 选中文件 → 插入 # chip', async ({ page }) => {
    await activateSession(page)
    await page.getByTitle(/添加内容/).click()
    await page.getByRole('button', { name: '文件 #' }).click()
    // 等 token.ts 候选可见后选中
    const tokenItem = page.getByText('token.ts')
    await expect(tokenItem).toBeVisible({ timeout: 5_000 })
    await tokenItem.click()
    // 浮层关闭：候选 button 消失（chip 是 span 非 button，不干扰）
    await expect(page.getByRole('button', { name: /token\.ts/ })).toHaveCount(0)
    // 输入区含 # chip（chip 是 span，文本含 token.ts）
    await expect(page.getByRole('textbox')).toContainText(/token\.ts/)
  })

  test('E2E-CF-4: AddMenuPopover 无「引用」(@) 入口', async ({ page }) => {
    await activateSession(page)
    await page.getByTitle(/添加内容/).click()
    // + 菜单弹出，应含「文件 #」「命令 /」，不含「引用」（@ 已废弃）
    await expect(page.getByRole('button', { name: '文件 #' })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: '命令 /' })).toBeVisible()
    await expect(page.getByRole('button', { name: '引用 @' })).toHaveCount(0)
  })

  test('E2E-CF-5: landing 态（无 session）AddMenuPopover 无「文件」(#) 入口', async ({ page }) => {
    // 不激活 session，保持 landing 态。等 landing composer 渲染
    await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 10_000 })
    await page.getByTitle(/添加内容/).click()
    // landing 守门（G10）：+ 菜单应含「命令 /」但不含「文件 #」（无 cwd，# 无意义）
    await expect(page.getByRole('button', { name: '命令 /' })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: '文件 #' })).toHaveCount(0)
  })
})
