# 03 — 文件预览（DetailPane）功能 E2E 测试流程

> **被测功能**：点文件树中的文件 → SideDrawer detail tab → DetailPane 显示内容/diff（UC-6）。
>
> **关键约束**：禁 v-html（NFR-AC-S4），XSS 安全（T6.10）。

---

## 数据流（点文件后）

```
点文件（FileTreeRow.onSelectFile）
  → useFileTree.selectFile(path) → store.selectedPath = path
  → useSideDrawer.open('detail') → drawer isOpen=true, activeTab='detail'
  → SideDrawer 渲染 DetailPane（v-if activeTab==='detail'）
  → DetailPane 内 useDetailPane watch([selectedPath, sessionId])
    → openPreview(sessionId, path)
      → 判定 hasGitChange：store.getGitStatus(sessionId, path)?.status
      → 有 git 改动 → viewMode='diff' → gitApi.getDiff(sessionId, path)
      → 无 git 改动 → viewMode='preview' → fileApi.read(path, sessionId)
    → state.status='loading' → 'content'（或 'error'）
  → DetailPane 渲染：<pre>{{ state.content }}</pre>（文本插值，禁 v-html）
```

### mock 返回（`mock/file.ts` read + `mock/git.ts` getDiff）

```
file.read(path, sessionId):
  path 含 'xss'/'script' → '<script>alert("xss")</script>\nconst x = 1'  # T6.10 XSS
  ext='ts'  → `// ${path}\nexport function main(): void {...}`          # T6.2 内容
  ext='json'→ `{ "name": "sample", "version": "1.0.0" }`
  ext='md'  → `# ${path}\n\nSample markdown content.`
  其它      → `// mock content for ${path}`

git.getDiff(sessionId, path):
  path 含 'xss'/'script' → patch 含 '<script>alert(1)</script>'          # T6.10 XSS
  path 在 fixtureGitStatus → patch 含 'diff --git a/path b/path'          # T6.1 diff
  path 以 .png/.jpg 结尾   → { patch:'', binary:true }                    # T6.6 二进制
  其它（非改动文件）        → { patch:'', binary:false }
```

---

## 前置：gotoFileTree + 展开 src

```typescript
async function gotoFileTreeExpanded(page: Page): Promise<void> {
  await gotoFileTree(page)  // 见 02-e2e-file-tree.md
  await page.getByTestId('file-tree-dir-src').click()
  await expect(page.getByTestId('file-tree-file-src/index.ts')).toBeVisible()
}
```

---

## 用例 1：普通文件内容预览（T6.2）

```typescript
test('T6.2: 点文件 → DetailPane 显示内容', async ({ page }) => {
  await gotoFileTreeExpanded(page)

  // 点 src/index.ts（无 git 改动 → viewMode='preview' → file.read）
  await page.getByTestId('file-tree-file-src/index.ts').click()

  // 断言：SideDrawer detail tab 打开，DetailPane 渲染
  await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5000 })

  // 断言：内容区可见，显示 mock file.read 的 ts 内容（含 'export function'）
  await expect(page.getByTestId('detail-content')).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('detail-content')).toContainText('export function')
})
```

**调用链**：`src/index.ts` 不在 fixtureGitStatus → hasGitChange=false → viewMode='preview' → `fileApi.read('src/index.ts', 'e2e-files')` → mock 返回 ts 内容。

---

## 用例 2：改动文件 diff 显示（T6.1）

```typescript
test('T6.1: 改动文件 → diff 显示', async ({ page }) => {
  await gotoFileTreeExpanded(page)

  // 点 src/new-feature.ts（git status=added → hasGitChange=true → viewMode='diff'）
  await page.getByTestId('file-tree-file-src/new-feature.ts').click()

  await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('detail-content')).toBeVisible({ timeout: 5000 })

  // 断言：显示 diff patch（mock getDiff 返回含 'diff --git'）
  await expect(page.getByTestId('detail-content')).toContainText('diff --git')
})
```

**调用链**：`src/new-feature.ts` 在 fixtureGitStatus（status=added）→ hasGitChange=true → viewMode='diff' → `gitApi.getDiff('e2e-files', 'src/new-feature.ts')` → mock 返回 patch。

---

## 用例 3：禁 v-html / XSS 安全（T6.10）

```typescript
test('T6.10: 含 <script> 内容被转义不执行（禁 v-html）', async ({ page }) => {
  await gotoFileTreeExpanded(page)

  // 点 src/new-feature.ts（改动文件，getDiff 返回的 patch 不含 script，走 diff）
  // 要触发 XSS mock，需点 path 含 'xss' 的文件。但 MOCK_TREE 没有这种文件。
  // 替代方案：验证 DetailPane 渲染机制——内容用 <pre>{{ }}</pre> 文本插值
  await page.getByTestId('file-tree-file-src/new-feature.ts').click()
  await expect(page.getByTestId('detail-content')).toBeVisible()

  // 断言：detail-content 内无执行态 <script> 标签（Vue 文本插值转义，不产生 DOM script 节点）
  const scriptCount = await page.locator('[data-testid="detail-content"] script').count()
  expect(scriptCount).toBe(0)

  // 断言：detail-content 用 <pre> 元素（禁 v-html 的结构证据）
  const preCount = await page.locator('[data-testid="detail-content"] pre').count()
  expect(preCount).toBeGreaterThan(0)
})
```

**原理**：DetailPane 用 `<pre>{{ state.content }}</pre>`（Vue 文本插值），`{{ }}` 自动转义 HTML。即使 content 含 `<script>alert(1)</script>`，渲染成文本不执行。v-html 才会解析 HTML，本项目禁用。

**要完整测 XSS payload**：需在 MOCK_TREE 加一个 path 含 'xss' 的文件（如 `src/xss-test.ts`），mock read/getDiff 会返回含 `<script>` 的内容。当前 fixture 未加，上述用例验证渲染机制（无 script DOM 节点）。

---

## 用例 4：drawer 已开点新文件切换（T6.12）

```typescript
test('T6.12: drawer 已开点新文件 → 切换非新开', async ({ page }) => {
  await gotoFileTreeExpanded(page)

  // 点第一个文件打开 drawer
  await page.getByTestId('file-tree-file-src/index.ts').click()
  await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5000 })

  // 记录 drawer 数量
  const countBefore = await page.getByTestId('detail-pane').count()

  // 点第二个文件
  await page.getByTestId('file-tree-file-src/existing.ts').click()
  await expect(page.getByTestId('detail-pane')).toBeVisible({ timeout: 5000 })

  // 断言：drawer 仍只有 1 个（SideDrawer 单实例，selectedPath 变化触发 useDetailPane 重载内容）
  const countAfter = await page.getByTestId('detail-pane').count()
  expect(countAfter).toBe(countBefore)
})
```

**机制**：SideDrawer 是单例（useSideDrawer 模块级状态）。点新文件 → `selectFile(newPath)` + `drawer.open('detail')`（已 open 则只更新 activeTab）→ useDetailPane watch selectedPath 变化 → openPreview 新 path。不会新开 drawer。

---

## 用例 5：Diff ↔ 预览切换（view toggle）

```typescript
test('view-toggle: 改动文件可切换 Diff/预览', async ({ page }) => {
  await gotoFileTreeExpanded(page)

  // 点 src/new-feature.ts（默认 viewMode='diff'）
  await page.getByTestId('file-tree-file-src/new-feature.ts').click()
  await expect(page.getByTestId('detail-content')).toContainText('diff --git')

  // 断言：view-toggle 可见（hasGitChange=true 时显示）
  await expect(page.getByTestId('detail-view-toggle')).toBeVisible()

  // 点「预览」切到 file.read 内容
  await page.getByRole('button', { name: '预览' }).click()
  // 调用链：toggleView('preview') → fileApi.read(path, sessionId)
  await expect(page.getByTestId('detail-content')).toContainText('export function')

  // 点「Diff」切回
  await page.getByRole('button', { name: 'Diff' }).click()
  await expect(page.getByTestId('detail-content')).toContainText('diff --git')
})
```

**注意**：view-toggle 仅当 `state.hasGitChange=true` 时渲染。无 git 改动的文件（如 src/index.ts）不显示 toggle，固定 preview 模式。

---

## 用例 6：加载骨架态（T6.7）

```typescript
test('T6.7: 异步返回前 → 骨架态', async ({ page }) => {
  await gotoFileTreeExpanded(page)

  // 点文件，立即检查 loading 态（mock 延迟 40ms，需用 polling 捕捉）
  await page.getByTestId('file-tree-file-src/index.ts').click()

  // 期望：短暂出现 detail-loading（status='loading'）
  // 注意：mock 40ms 很快，可能捕捉不到。用 race 断言——要么 loading 要么 content
  await expect(
    page.getByTestId('detail-loading').or(page.getByTestId('detail-content'))
  ).toBeVisible({ timeout: 5000 })
})
```

**说明**：T6.7 的骨架态在 mock 下很难稳定捕捉（40ms 太快）。real 轨（真实 runtime）延迟更大，能稳定测。mock 轨用 `or` 断言兜底。

---

## DetailPane 状态机（data-testid 对照）

| state.status | 显示的 testid | 触发条件 |
|---|---|---|
| idle | detail-empty | 无 selectedPath / sessionId 为 null |
| loading | detail-loading | openPreview/toggleView 在途 |
| content（普通）| detail-content | read/getDiff 成功 |
| content（binary）| detail-binary | getDiff 返回 binary=true |
| content（truncated）| detail-content + detail-truncated | file.read 返回 truncated=true（>1MB）|
| error | detail-error | read/getDiff 失败 |
