/**
 * 文件树 E2E —— W0 占位 spec，W8 验收 Wave 填实现。
 *
 * 当前只验证 harness 可启动（smoke），具体文件树交互用例（E2E-1~E2E-4）在 W8 实现，
 * 因 W1-W5（后端 FileService + 前端 store/view/preview）尚未完成，mock 层暂无文件树数据源。
 *
 * W8 实现的用例（见 execution-plan §测试验收清单 E2E 层补充）：
 * - E2E-1: 切「文件」tab → 顶层节点 DOM 可见（T1.8 e2e 化）
 * - E2E-2: 点目录展开 → 子节点 DOM 出现 → 角标渲染（UC-1+UC-2 旅程）
 * - E2E-3: 点文件 → SideDrawer 打开 → 内容/diff 显示（UC-6 旅程）
 * - E2E-4: 切 session 再切回 → 展开态恢复（AC-3.5 rehydrate 旅程）
 */
import { test, expect } from './fixtures/launch-app'

test.describe('文件树 E2E（W0 harness smoke）', () => {
  test('harness 可启动：Electron app 加载首窗口', async ({ page }) => {
    // W0 smoke：验证 _electron.launch 成功 + renderer 加载
    // 断言 renderer 至少渲染了根节点（App.vue 的某个稳定容器）
    // 具体 sidebar/panel 结构在 W8 实现时验证
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
  })

  // W8 验收 Wave 填实现（W1-W5 完成后 mock 层才有文件树数据源）
  test('E2E-1: 切「文件」tab → 顶层节点 DOM 可见', async () => {
    test.skip(true, 'W8 填实现：依赖 W1（后端 FileService）+ W3（store）+ W4（FileView）')
  })

  test('E2E-2: 点目录展开 → 子节点 DOM 出现', async () => {
    test.skip(true, 'W8 填实现：依赖 W1（expand）+ W4（FileTreeRow）')
  })

  test('E2E-3: 点文件 → SideDrawer 打开 → 内容显示', async () => {
    test.skip(true, 'W8 填实现：依赖 W2（file.read）+ W5（DetailPane）')
  })

  test('E2E-4: 切 session 再切回 → 展开态恢复', async () => {
    test.skip(true, 'W8 填实现：依赖 W3（rehydrate）+ W6（invalidation）')
  })
})
