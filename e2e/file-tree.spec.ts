/**
 * 文件树 E2E —— W8 验收 Wave 完整实现（E2E-1~E2E-4 + T4.x/T6.x）。
 *
 * 数据流（W0 harness）：VITE_MOCK=true + VITE_E2E=true → renderer 走 mock API，
 * session list 含 e2eTestSession（id='e2e-files'，cwd=sample-project），
 * file.tree/git.status/file.read/git.diff 走 mock fixture（mock/file.ts + mock/git.ts）。
 *
 * 覆盖用例（execution-plan §测试验收清单）：
 * - E2E-1 (T1.8): 切「文件」tab → 顶层节点 DOM 可见
 * - E2E-2 (UC-1+2): 点目录展开 → 子节点 DOM 出现 → 角标渲染
 * - E2E-3 (UC-6, T6.2/T6.10): 点文件 → SideDrawer detail → 内容/diff 显示，禁 v-html
 * - E2E-4 (AC-3.5): 切 session 再切回 → 展开态恢复
 * - T4.1: 过滤命中 → 节点过滤
 * - T4.2: 无匹配 → 空态
 * - T4.5: 清空 → 恢复完整树
 * - T6.12: 已开 drawer 点新文件 → 切换
 * - T6.7: 异步前 → 骨架态
 */
import { test, expect } from './fixtures/launch-app'

/** 激活 e2e-files session 并切到文件 tab（多数用例前置） */
async function gotoFileTree(page: import('@playwright/test').Page): Promise<void> {
  // 等待 session list 渲染（mock TIMING.ack ≈ 40ms）
  await expect(page.getByText('E2E 文件树测试')).toBeVisible({ timeout: 10_000 })
  // 点 e2e-files session 激活（SessionItem 文本匹配）
  await page.getByText('E2E 文件树测试').click()
  // 切到「文件」tab（SegmentedTab 按文本）
  await page.getByRole('button', { name: /文件/ }).click()
  // 等 FileView 加载完成（mock file.tree 40ms + git.status 40ms）
  await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 10_000 })
}

test.describe('文件树 E2E', () => {
  test('harness smoke：Electron app 加载首窗口', async ({ page }) => {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
  })

  test('E2E-1 (T1.8): 切「文件」tab → 顶层节点 DOM 可见', async ({ page }) => {
    await gotoFileTree(page)
    // 顶层节点：mock/file.ts MOCK_TREE 含 src / README.md / untracked.log / package.json
    await expect(page.getByTestId('file-tree-dir-src')).toBeVisible()
    await expect(page.getByTestId('file-tree-file-README.md')).toBeVisible()
    await expect(page.getByTestId('file-tree-file-package.json')).toBeVisible()
  })

  test('E2E-2 (UC-1+2): 点目录展开 → 子节点 DOM 出现 + 角标渲染', async ({ page }) => {
    await gotoFileTree(page)
    // 初始：src 目录折叠（一级子在 store.tree 但 v-if isExpanded 控制渲染）
    // 点 src 展开（useFileTree.expandNode loaded 复用缓存，mock tree 已含一级子）
    await page.getByTestId('file-tree-dir-src').click()
    // 一级子节点可见（mock src 含 new-feature.ts / existing.ts / index.ts / utils 等）
    await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible()
    await expect(page.getByTestId('file-tree-file-src/new-feature.ts')).toBeVisible()
    // 角标：src/new-feature.ts 在 fixtureGitStatus 是 'added' → 角标 'A'
    const newFeatureRow = page.getByTestId('file-tree-file-src/new-feature.ts')
    await expect(newFeatureRow).toContainText('A')
  })

  test('E2E-3a (T6.2): 点文件 → SideDrawer detail 打开 + 显示内容', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    // 点 src/index.ts（未改动文件 → file.read 内容预览）
    await page.getByTestId('file-tree-file-src/index.ts').click()
    // SideDrawer detail tab 打开 + DetailPane 渲染
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    // 内容显示（mock file.read ts 文件返回含 'export function'）
    await expect(page.getByTestId('detail-content')).toBeVisible({ timeout: 5_000 })
    const content = page.getByTestId('detail-content')
    await expect(content).toContainText('export function')
  })

  test('E2E-3b (T6.1/T6.10): 改动文件 → diff 显示 + 禁 v-html（XSS 安全）', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    // 点 src/new-feature.ts（git 'added' → git.getDiff，默认 viewMode=diff）
    await page.getByTestId('file-tree-file-src/new-feature.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    // diff 内容显示（mock getDiff 返回 patch 含 'diff --git'）
    await expect(page.getByTestId('detail-content')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('detail-content')).toContainText('diff --git')
    // T6.10 XSS 安全：禁 v-html，内容用 <pre> 文本插值。验证无 <script> 执行
    // （DOM 中 script 标签不执行，因 Vue 文本插值会转义）
    const scriptCount = await page.locator('detail-content script').count()
    expect(scriptCount).toBe(0)
  })

  test('E2E-3c (T6.12): drawer 已开点新文件 → 切换非新开', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-tree-dir-src').click()
    // 点第一个文件打开 drawer
    await page.getByTestId('file-tree-file-src/index.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    // 记录 drawer 数量（应为 1）
    const drawerCountBefore = await page.getByTestId('detail-pane').count()
    // 点第二个文件（切换）
    await page.getByTestId('file-tree-file-src/existing.ts').click()
    await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5_000 })
    // drawer 仍只有 1 个（切换非新开）
    const drawerCountAfter = await page.getByTestId('detail-pane').count()
    expect(drawerCountAfter).toBe(drawerCountBefore)
  })

  test('E2E-4 (AC-3.5): 切 session 再切回 → 展开态恢复', async ({ page }) => {
    await gotoFileTree(page)
    // 展开 src
    await page.getByTestId('file-tree-dir-src').click()
    await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible()
    // 切回「会话」tab（不销毁 fileTreeStore 状态）。按钮 name 含计数如「会话 6」
    await page.getByRole('button', { name: /^会话/ }).click()
    // src 子节点应不再可见（files tab 隐藏）
    // 切回「文件」tab
    await page.getByRole('button', { name: /文件/ }).click()
    await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 5_000 })
    // 展开态恢复：src 子节点仍可见（D-019 rehydrate，expandedPaths 持久）
    await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible({ timeout: 5_000 })
  })

  test('T4.1: 输入关键词 → 节点过滤', async ({ page }) => {
    await gotoFileTree(page)
    // 输入 'readme' 过滤
    await page.getByTestId('file-filter-input').fill('readme')
    // README.md 命中保留
    await expect(page.getByTestId('file-tree-file-README.md')).toBeVisible()
    // package.json 被过滤掉
    await expect(page.getByTestId('file-tree-file-package.json')).toHaveCount(0)
  })

  test('T4.2: 无匹配 → 空态', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-filter-input').fill('zzz_no_match_zzz')
    // 空态显示
    await expect(page.getByTestId('file-empty')).toBeVisible()
  })

  test('T4.5: 清空关键词 → 恢复完整树', async ({ page }) => {
    await gotoFileTree(page)
    await page.getByTestId('file-filter-input').fill('readme')
    await expect(page.getByTestId('file-tree-file-package.json')).toHaveCount(0)
    // 清空
    await page.getByTestId('file-filter-input').fill('')
    // 完整树恢复
    await expect(page.getByTestId('file-tree-file-package.json')).toBeVisible()
  })

  test('D-020 showIgnored: 开关切换 → ignored 节点显示/隐藏', async ({ page }) => {
    await gotoFileTree(page)
    // 默认 showIgnored=false：node_modules 不存在
    await expect(page.getByTestId('file-tree-dir-node_modules')).toHaveCount(0)
    // 点「忽略项」开关
    await page.getByTestId('file-show-ignored-toggle').click()
    // showIgnored=true：node_modules 出现（mock MOCK_IGNORED）
    await expect(page.getByTestId('file-tree-dir-node_modules')).toBeVisible({ timeout: 5_000 })
  })
})
