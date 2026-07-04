# 02 — 文件树功能 E2E 测试流程

> **被测功能**：侧栏「文件」tab → 完整文件树浏览器（UC-1 浏览、UC-2 展开、UC-4 过滤、D-020 showIgnored）。
>
> **测试轨**：mock 轨（VITE_MOCK=true，renderer 走 mock API）。验证渲染 + 交互逻辑，不验证 runtime。

---

## 数据流（mock 模式）

```
E2E 启动（launch-app.ts）
  → env VITE_MOCK=true → renderer api/index.ts isMock=true → 走 mock/file.ts + mock/git.ts
  → env VITE_E2E=true → mock/index.ts buildGroups() 注入 e2eTestSession（id='e2e-files'）
  → e2eTestSession.cwd = __E2E_SAMPLE_PROJECT_CWD__（vite build 期 define 注入 sample-project 绝对路径）
```

### mock 数据 fixture（`src-electron/renderer/src/api/mock/file.ts`）

```
MOCK_TREE（顶层 + 一级子，file.tree 返回）:
  src/                    # dir
    new-feature.ts        # file (git: added → 角标 A)
    existing.ts           # file (git: modified → 角标 M)
    dirty.ts              # file (git: modified → 角标 M)
    old-file.ts           # file (git: deleted → 角标 D)
    conflict.ts           # file (git: unmerged → 角标 U)
    utils/                # dir (可展开，MOCK_EXPAND 有子)
    index.ts              # file (无 git 改动)
  README.md               # file (git: renamed → 角标 R)
  untracked.log           # file (git: untracked → 角标 A)
  package.json            # file (无 git 改动)

MOCK_EXPAND（file.tree.expand 返回）:
  src/utils → [format.ts, helpers.ts]

MOCK_IGNORED（showIgnored=true 时追加，标 ignored=true）:
  node_modules/ dist/ .env
```

---

## 前置：进入文件树（gotoFileTree）

**为什么需要**：app 初始状态不确定（可能 Landing 态 / files tab / sessions tab），必须显式切到 sessions tab 点 session 激活。

```typescript
// e2e/file-tree.spec.ts gotoFileTree()
async function gotoFileTree(page: Page): Promise<void> {
  // 1. 切到 sessions tab（按钮 name 含计数，用前缀匹配）
  await page.getByRole('button', { name: /^会话/ }).click()
  // 期望：sidebar 的 SessionList 区域渲染

  // 2. 等 session list 数据加载（mock session.list 延迟 40ms）
  await expect(page.getByText('E2E 文件树测试')).toBeVisible({ timeout: 10000 })
  // 期望：e2eTestSession 的 label "E2E 文件树测试" 文本可见

  // 3. 点 e2e-files session 激活
  await page.getByText('E2E 文件树测试').click()
  // 期望：session.activeId = 'e2e-files'，main 区从 Landing 切到该 session 的 chat 界面

  // 4. 切到「文件」tab
  await page.getByRole('button', { name: /^文件/ }).click()
  // 期望：FileView 挂载

  // 5. 等 FileView 加载完成（mock file.tree 40ms + git.status 40ms）
  await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 10000 })
  // 期望：file-view-root DOM 存在且可见
}
```

### 调用链（点 session 后）

```
page.getByText('E2E 文件树测试').click()
  → SessionItem @click → emit('select', 'e2e-files')
  → Sidebar.onSelectSession('e2e-files')
  → useSidebar.selectSession('e2e-files')
    → session.switchSession api（mock: 40ms 延迟）
    → sessionStore.activeId = 'e2e-files'
  → 切到 files tab 后 FileView watch(sessionId) 触发
  → useFileTree.loadTree('e2e-files')
    → Promise.allSettled([fileApi.tree('e2e-files', false), gitApi.status('e2e-files')])
      → mock file.tree: 40ms 后返回 MOCK_TREE（深拷贝）
      → mock git.status: 40ms 后返回 fixtureGitStatus（isRepo=true）
    → store.setTree('e2e-files', tree)
    → store.setNodeState('e2e-files', '', { status: 'loaded' })
    → store.setGitOverlay('e2e-files', gitFiles)
  → FileView 渲染 visibleNodes（tree 顶层节点）
```

---

## 用例 1：顶层节点 DOM 可见（E2E-1 / T1.8）

```typescript
test('E2E-1: 切文件 tab → 顶层节点 DOM 可见', async ({ page }) => {
  await gotoFileTree(page)

  // 断言：MOCK_TREE 的顶层节点都在 DOM
  await expect(page.getByTestId('file-tree-dir-src')).toBeVisible()
  await expect(page.getByTestId('file-tree-file-README.md')).toBeVisible()
  await expect(page.getByTestId('file-tree-file-package.json')).toBeVisible()
})
```

**期望**：3 个顶层节点（src 目录 + README.md + package.json 文件）可见。

**data-testid 规则**：目录 = `file-tree-dir-{path}`，文件 = `file-tree-file-{path}`。path 是相对 cwd 的完整路径（如 `src/index.ts`，不是 `index.ts`）。

---

## 用例 2：展开目录 + 角标渲染（E2E-2 / UC-1+2）

```typescript
test('E2E-2: 点目录展开 → 子节点 + 角标', async ({ page }) => {
  await gotoFileTree(page)

  // 点 src 目录展开
  await page.getByTestId('file-tree-dir-src').click()
  // 调用链：FileTreeRow.toggle() → useFileTree.expandNode('e2e-files', 'src')
  //   → store.getNodeState('src') = unloaded
  //   → 检查 store.getTree() 的 src 节点已有 children（首加载带的一级子）
  //   → 视为 loaded 复用，addExpanded('e2e-files', 'src')
  //   → 不发 expand 请求（避免空响应覆盖 children）

  // 断言：src 的一级子节点可见（MOCK_TREE src.children）
  await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible()
  await expect(page.getByTestId('file-tree-file-src/new-feature.ts')).toBeVisible()

  // 断言：角标渲染（src/new-feature.ts git status=added → 角标 'A'）
  const newRow = page.getByTestId('file-tree-file-src/new-feature.ts')
  await expect(newRow).toContainText('A')
})
```

**期望**：src 展开后显示 7 个一级子（new-feature.ts/existing.ts/dirty.ts/old-file.ts/conflict.ts/utils/index.ts），其中 5 个带 git 角标（A/M/M/D/U）。

### 角标对照表

| 文件 | git status | 角标文字 | 角标颜色 class |
|------|-----------|---------|---------------|
| src/new-feature.ts | added | A | bg-success/12 text-success |
| src/existing.ts | modified | M | bg-warning/12 text-warning |
| src/dirty.ts | modified | M | bg-warning/12 text-warning |
| src/old-file.ts | deleted | D | bg-danger/12 text-danger |
| src/conflict.ts | unmerged | U | bg-danger/16 text-danger font-semibold |
| README.md | renamed | R | bg-info/12 text-info |
| untracked.log | untracked | A | bg-success/12 text-success |
| src/index.ts | 无 | 无角标 | — |

---

## 用例 3：过滤命中（T4.1）

```typescript
test('T4.1: 输入关键词 → 节点过滤', async ({ page }) => {
  await gotoFileTree(page)

  // 输入 'readme'
  await page.getByTestId('file-filter-input').fill('readme')
  // 调用链：Input @update:modelValue → useFileTree.setFilter('readme')
  //   → store.filterText = 'readme'
  //   → FileView.visibleNodes computed 重算（nodeMatchesFilter）

  // 断言：README.md 命中保留
  await expect(page.getByTestId('file-tree-file-README.md')).toBeVisible()

  // 断言：package.json 被过滤掉
  await expect(page.getByTestId('file-tree-file-package.json')).toHaveCount(0)
})
```

**nodeMatchesFilter 逻辑**：递归检查节点 path 是否含关键词（`path.toLowerCase().includes(q)`），保留含命中的整条祖先链。`README.md`.path 含 'readme' → 命中。

---

## 用例 4：无匹配空态（T4.2）

```typescript
test('T4.2: 无匹配 → 空态', async ({ page }) => {
  await gotoFileTree(page)

  await page.getByTestId('file-filter-input').fill('zzz_no_match_zzz')

  // 断言：file-empty 空态显示（hasFilter=true → 显示 "无匹配文件"）
  await expect(page.getByTestId('file-empty')).toBeVisible()
})
```

**期望**：`file-empty` 元素可见，文本含"无匹配文件"。

---

## 用例 5：清空恢复完整树（T4.5）

```typescript
test('T4.5: 清空关键词 → 恢复完整树', async ({ page }) => {
  await gotoFileTree(page)

  await page.getByTestId('file-filter-input').fill('readme')
  await expect(page.getByTestId('file-tree-file-package.json')).toHaveCount(0)

  // 清空
  await page.getByTestId('file-filter-input').fill('')
  // store.filterText = '' → visibleNodes = 全量 treeNodes

  // 断言：完整树恢复
  await expect(page.getByTestId('file-tree-file-package.json')).toBeVisible()
})
```

---

## 用例 6：showIgnored 开关（D-020）

```typescript
test('D-020: showIgnored 开关 → ignored 节点显隐', async ({ page }) => {
  await gotoFileTree(page)

  // 默认 showIgnored=false：node_modules 不存在
  await expect(page.getByTestId('file-tree-dir-node_modules')).toHaveCount(0)

  // 点开关
  await page.getByTestId('file-show-ignored-toggle').click()
  // 调用链：FileView.onToggleShowIgnored()
  //   → useFileTree.toggleShowIgnored() → store.showIgnored = true
  //   → store.clearSession('e2e-files')（清缓存）
  //   → loadTree('e2e-files')（重拉，这次 showIgnored=true）
  //     → mock file.tree(_, true) → MOCK_TREE + MOCK_IGNORED（标 ignored=true）

  // 断言：node_modules 出现
  await expect(page.getByTestId('file-tree-dir-node_modules')).toBeVisible({ timeout: 5000 })
})
```

**期望**：开关后 node_modules / dist / .env 三个 ignored 节点出现，渲染为灰斜体（`text-subtle italic`）。

---

## 常见失败排查

| 现象 | 原因 | 修复 |
|------|------|------|
| `getByText('E2E 文件树测试')` 超时 | 没切 sessions tab，app 在 Landing/files tab | gotoFileTree 先 `getByRole('button', {name:/^会话/}).click()` |
| `file-tree-dir-src` 找不到但 `file-loading` 可见 | file.tree mock 请求没返回（检查 useFileTree 是否走 facade `@/api` 而非 `@/api/domains/file`） | composable 必须 `import { file } from '@/api'` |
| 展开后显示"空目录" | expandNode 误发 expand 请求覆盖了首加载带的一级子 children | expandNode 须检查 `getTree().children` 已存在则复用（D-009） |
| 角标不显示 | gitOverlay 没注入（git.status mock 没返回或路径不匹配 MOCK_TREE） | mock/git.ts fixtureGitStatus 的 path 须与 mock/file.ts MOCK_TREE 的 path 对齐 |
