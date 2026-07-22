/**
 * Tasks Drawer P0 E2E —— Playwright + Electron + mock 轨。
 *
 * 验证 Tasks Drawer 的 P0 case：todo/goal tool call 到达后，drawer 能正确渲染。
 *
 * mock 数据流（run-send-stream.ts 按 text 关键词分支）：
 *   · text 含 'todo'/'任务' → todo tool_call 序列（details.todos + __gui__ list-tree）
 *   · text 含 'goal'/'目标' → goal_control tool_call 序列（details.slug + __gui__ card）
 *                             + goal ANSI widget（widgetKey='goal'）
 *   · 其他 → read tool 序列（gui-components.spec.ts 覆盖，零回归）
 *
 * 写入链路：
 *   tool_call_start → routeToolStartToTasks 提 input.objective → setGoalMeta
 *   tool_call_end   → routeToolResultToTasks 提 details.__gui__/slug/todos → setGoalFromGui/setTodoFromGui/setTodos/setGoalMeta
 *   extension:widget(widgetKey='goal') → SideDrawer → mergeGoalWidget（保留 objective/slug）
 *   → tasks store 按 sessionId 分区 → SideDrawer tabs computed 检测 hasData → 追加 tasks tab icon
 *   → 点 drawer-tab-tasks → TasksPanel/GoalCard 渲染
 *
 * 运行：npx playwright test e2e/tasks-drawer.spec.ts
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 s3 session（「API 性能优化」，空 session 发消息后进入流式）。
 * 与 gui-components.spec.ts 同范式——已验证能成功发消息。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

/**
 * 发送消息并等待流式完成。
 * 复用 gui-components.spec.ts 的等待范式：stop-btn 消失 + assistant 回复「已处理」可见。
 */
async function sendMessageAndWaitComplete(page: import('@playwright/test').Page, text: string): Promise<void> {
  const input = page.getByRole('textbox')
  await input.click()
  await input.pressSequentially(text)
  await input.press('Enter')
  const stopBtn = page.locator('.stop-btn')
  await expect(stopBtn).toBeVisible({ timeout: 3_000 }).catch(() => {})
  await expect(stopBtn).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByText(/已处理/)).toBeVisible({ timeout: 5_000 })
}

/**
 * 打开 SideDrawer 并切到 tasks tab。
 *
 * 前置：tasks store 已写入数据（SideDrawer tabs computed 在 hasData=true 时才追加 tasks tab icon）。
 * 流程：drawer-toggle → aside 可见 → drawer-tab-tasks 可见（有数据时才渲染）→ 点切 tab。
 */
async function openTasksDrawer(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('drawer-toggle').click()
  const aside = page.locator('aside[aria-label="侧边抽屉"]')
  await expect(aside).toBeVisible({ timeout: 5_000 })
  // tasks tab icon 只在有数据时存在；发消息后应出现
  const tasksTab = aside.getByTestId('drawer-tab-tasks')
  await expect(tasksTab).toBeVisible({ timeout: 5_000 })
  await tasksTab.click()
}

test.describe('Tasks Drawer P0', () => {
  test('smoke：app 加载', async ({ page }) => {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
  })

  test('Case 1: todo tool call → drawer 渲染 5 项 + 三态 + VERIFY', async ({ page }) => {
    await activateSession(page)
    await sendMessageAndWaitComplete(page, '测 todo')

    await openTasksDrawer(page)
    const aside = page.locator('aside[aria-label="侧边抽屉"]')

    // tasks-panel 可见
    await expect(aside.getByTestId('tasks-panel')).toBeVisible({ timeout: 5_000 })

    // 5 个 todo-item
    const todoItems = aside.locator('.todo-item')
    await expect(todoItems).toHaveCount(5, { timeout: 5_000 })

    // section header 计数 3/5（3 个 completed）
    await expect(aside.locator('.todo-section')).toContainText('3/5')

    // in_progress 项（#4）含 animate-pulse-strong（复选框内的脉冲点）
    await expect(aside.locator('.todo-item .animate-pulse-strong')).toHaveCount(1)

    // completed 项（#1/#2/#3）含 line-through（todoItemClass）
    await expect(aside.locator('.todo-item.line-through')).toHaveCount(3)

    // VERIFY 标签 2 个（#3 #4 是 isVerification）
    await expect(aside.locator('.verify-tag')).toHaveCount(2)

    // 文案断言：#4 文本可见（确认渲染了 in_progress 项）
    await expect(aside.getByText('编写单元测试覆盖边界')).toBeVisible()
  })

  test('Case 2: goal tool call → GoalCard 渲染', async ({ page }) => {
    await activateSession(page)
    await sendMessageAndWaitComplete(page, '测 goal')

    await openTasksDrawer(page)
    const aside = page.locator('aside[aria-label="侧边抽屉"]')

    // goal-card 可见
    const goalCard = aside.getByTestId('goal-card')
    await expect(goalCard).toBeVisible({ timeout: 5_000 })

    // slug 'fix-auth-bug' 显示（displaySlug 来自 store.goal.slug）
    await expect(goalCard).toContainText('fix-auth-bug')

    // progress-bar 渲染（GoalCard 遍历 card body 找 progress-bar，渲染 .h-1 track）
    // value 文案 '71/200'（不传 unit，避免单位错配）
    await expect(goalCard).toContainText('71/200')
    await expect(goalCard).toContainText('tokens')

    // status 徽章 '进行中'（active → t('panel.panel.tasks.goalStatusActive')）
    await expect(goalCard).toContainText('进行中')
  })

  test('Case 3: goal objective 从 input.objective 提取', async ({ page }) => {
    await activateSession(page)
    await sendMessageAndWaitComplete(page, '测 goal')

    await openTasksDrawer(page)
    const aside = page.locator('aside[aria-label="侧边抽屉"]')

    // objective 文本渲染
    // 链路：tool_call_start.input.objective → routeToolStartToTasks → setGoalMeta
    //       → tool_call_end/widget 不覆盖（setGoalFromGui/mergeGoalWidget 保留 prev.objective）
    //       → GoalCard goal.objective → <p> 两行截断渲染
    const goalCard = aside.getByTestId('goal-card')
    await expect(goalCard).toBeVisible({ timeout: 5_000 })
    await expect(goalCard).toContainText('修复登录模块 token 过期无限重定向问题')
  })
})
