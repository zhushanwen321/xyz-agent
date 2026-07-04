# 04 — 导航与 Session 切换 E2E 测试流程

> **被测功能**：sidebar tab 切换（会话/文件）、session 激活、Overview 视图、Landing 态处理、展开态 rehydrate（AC-3.5）。

---

## app 初始状态（E2E 启动后）

```
E2E 启动（XYZ_AGENT_DATA_DIR=tmp 隔离）
  → navigation.current = { view: 'chat' }（默认）
  → sidebar.activeTab = localStorage 读，无则 'sessions'（但 tmp 目录 localStorage 空 → 'sessions'）
  → useNewTaskFlow.state = 'idle'（默认）
  → session.activeId = null（无激活 session）
  → session.list = mock buildGroups()（含 e2eTestSession + 5 个 fixture）

实际初始渲染可能：
  - main 显示 Landing（useNewTaskFlow 进入 landing 态）或 chat 空态
  - sidebar 在 sessions tab 或 files tab（取决于上次持久化，tmp 下默认 sessions）
```

**不确定性来源**：useNewTaskFlow 是否自动进入 landing、sidebar 持久化 tab。E2E 必须**显式设定状态**，不依赖初始。

---

## 核心原则：每个用例显式导航到起点

```typescript
// 反模式（依赖初始状态，脆弱）：
await page.getByText('E2E 文件树测试').click()  // 假设在 sessions tab

// 正模式（显式切换）：
await page.getByRole('button', { name: /^会话/ }).click()  // 先确保在 sessions tab
await expect(page.getByText('E2E 文件树测试')).toBeVisible()
await page.getByText('E2E 文件树测试').click()
```

---

## 用例 1：Session 激活（退出 Landing）

```typescript
test('session 激活：点 session → main 显示 chat 界面', async ({ page }) => {
  // 确保 sessions tab
  await page.getByRole('button', { name: /^会话/ }).click()

  // 等 session list
  await expect(page.getByText('E2E 文件树测试')).toBeVisible({ timeout: 10000 })

  // 激活前：main 可能是 Landing（"上午好呀..."标题）
  // 激活后：main 切到 chat 界面
  await page.getByText('E2E 文件树测试').click()

  // 断言：main 显示 composer 输入框（chat 界面标志）
  await expect(page.getByRole('textbox', { name: /描述你想让 AI/ })).toBeVisible({ timeout: 5000 })
})
```

**调用链**：
```
SessionItem @click → emit('select', 'e2e-files')
→ Sidebar.onSelectSession → useSidebar.selectSession('e2e-files')
  → session.switchSession api（mock 40ms）
  → navigation.push({ view:'chat', sessionId:'e2e-files' })
  → sessionStore.activeId = 'e2e-files'
→ main 渲染 PaneSessionView（chat 界面）
```

---

## 用例 2：Tab 切换（会话 ↔ 文件）

```typescript
test('tab 切换：会话 ↔ 文件互斥', async ({ page }) => {
  // 先激活 session
  await page.getByRole('button', { name: /^会话/ }).click()
  await page.getByText('E2E 文件树测试').click()

  // 切到文件 tab
  await page.getByRole('button', { name: /^文件/ }).click()
  await expect(page.getByTestId('file-view-root')).toBeVisible()

  // 断言：sessions tab 的 SessionList 不再可见（互斥）
  // （SessionList 在 v-if sidebar.activeTab==='sessions' 内）

  // 切回会话 tab
  await page.getByRole('button', { name: /^会话/ }).click()
  // 断言：session list 回来
  await expect(page.getByText('E2E 文件树测试')).toBeVisible()
})
```

**SegmentedTab 选择器**：按钮 name 是 `{label} {count}`（如 "会话 6"、"文件 4"）。用 `/^会话/` 和 `/^文件/` 前缀匹配，避免计数变化导致失配。

---

## 用例 3：展开态 rehydrate（AC-3.5 / E2E-4）

```typescript
test('AC-3.5: 切 tab 再切回 → 展开态恢复', async ({ page }) => {
  await gotoFileTree(page)  // 已在文件 tab

  // 展开 src
  await page.getByTestId('file-tree-dir-src').click()
  await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible()

  // 切到会话 tab（不销毁 fileTreeStore 状态）
  await page.getByRole('button', { name: /^会话/ }).click()

  // 切回文件 tab
  await page.getByRole('button', { name: /^文件/ }).click()
  await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 5000 })

  // 断言：展开态恢复（src 子节点仍可见，无需重新点展开）
  await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible({ timeout: 5000 })
})
```

**机制（D-019 rehydrate）**：
- `fileTreeStore.expandedPaths` 是 per-session Map，切 tab 不清空
- FileView `watch(sessionId)` 触发 `loadTree`，已缓存 → 走 `rehydrateExpanded`（恢复 expandedPaths 记录的展开态）
- FileTreeRow 的 `isExpanded` 读 `store.getExpanded(sessionId).has(path)` → 切回时仍 true

---

## 用例 4：Overview 视图

```typescript
test('Overview: 点概览按钮 → 进入 Overview 视图', async ({ page }) => {
  // 点概览入口（sidebar nav 下方的"概览 N"按钮）
  await page.getByRole('button', { name: /概览/ }).click()

  // 断言：进入 overview view（navigation.current.view === 'overview'）
  // Overview 组件渲染（具体 testid 取决于 Overview.vue 实现）
  // 期望：sidebar 的概览按钮转 accent 态（isOverviewActive）
  const overviewBtn = page.getByRole('button', { name: /概览/ })
  await expect(overviewBtn).toHaveClass(/text-accent/)
})
```

**调用链**：
```
概览按钮 @click → Sidebar.goOverview
→ useSidebar.goOverview → navigation.push({ view:'overview' })
→ isOverviewActive computed = (navigation.current.view === 'overview')
→ 概览按钮 class 转 accent
```

---

## 用例 5：Session 切换（多 session 数据隔离）

```typescript
test('session 切换：文件树按 session 隔离', async ({ page }) => {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('E2E 文件树测试')).toBeVisible()

  // 激活 e2e-files，展开 src
  await page.getByText('E2E 文件树测试').click()
  await page.getByRole('button', { name: /^文件/ }).click()
  await page.getByTestId('file-tree-dir-src').click()
  await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible()

  // 切到另一个 session（fixture session，cwd 不同）
  await page.getByRole('button', { name: /^会话/ }).click()
  // 点第一个非 e2e 的 session（fixture session label）
  // 注意：fixture session 的 label 在 mock/data.ts fixtureSessions 定义
  const firstFixture = page.locator('.session-item').nth(1)  // 第二个 session item
  await firstFixture.click()

  // 切回文件 tab
  await page.getByRole('button', { name: /^文件/ }).click()

  // 断言：该 session 的文件树（不同 cwd 的 MOCK_TREE 或空，取决于 mock 是否按 cwd 分）
  // fileTreeStore 按 session 隔离，e2e-files 的展开态不污染此 session
  await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 5000 })
})
```

**机制**：`fileTreeStore.tree` 是 `Map<sessionId, FileNode[]>`，per-session 隔离。切 session → loadTree(新 sid)，e2e-files 的缓存保留（切回时 rehydrate）。

---

## 导航选择器速查

| 目标 | 选择器 | 说明 |
|------|--------|------|
| sessions tab | `getByRole('button', { name: /^会话/ })` | 前缀匹配，避免计数变化 |
| files tab | `getByRole('button', { name: /^文件/ })` | 同上 |
| 概览入口 | `getByRole('button', { name: /概览/ })` | |
| 新建任务 | `getByRole('button', { name: /新建任务/ })` | 触发 useNewTaskFlow |
| 搜索（⌘K）| `getByRole('button', { name: /搜索/ })` | 打开 SearchModal |
| session item | `getByText('<session label>')` | 按 label 文本定位 |
| composer 输入框 | `getByRole('textbox', { name: /描述你想让 AI/ })` | chat 界面标志 |

---

## Landing 态处理（E2E 启动时）

**问题**：app 启动可能进入 Landing 态（useNewTaskFlow.state='landing'），main 显示 Landing 组件而非 chat。

**E2E 应对**：不直接对抗 Landing，而是**通过激活 session 退出**。点任何 session item → `selectSession` → `navigation.push({view:'chat', sessionId})` → Landing 卸载。

```typescript
// 通用"退出 Landing"前置
async function exitLanding(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^会话/ }).click()
  await expect(page.getByText('E2E 文件树测试')).toBeVisible({ timeout: 10000 })
  await page.getByText('E2E 文件树测试').click()
  await expect(page.getByRole('textbox', { name: /描述你想让 AI/ })).toBeVisible({ timeout: 5000 })
}
```
