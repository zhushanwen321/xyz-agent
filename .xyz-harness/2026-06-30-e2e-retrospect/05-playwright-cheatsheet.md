# 05 — Playwright Electron E2E 操作速查

> **定位**：写 E2E 用例时的参数/选择器/断言速查。每个 API 列出签名、参数、期望返回、常见坑。
>
> **框架**：`@playwright/test` 的 `_electron`（Electron 专用，不是普通 browser 测试）。

---

## 一、启动 Electron app

### `_electron.launch(options)`

```typescript
import { _electron as electron } from '@playwright/test'

const app = await electron.launch({
  executablePath: ELECTRON_EXECUTABLE,  // 必填：electron 二进制路径（本项目在 src-electron/node_modules）
  cwd: SRC_ELECTRON,                    // Electron 进程 cwd（含 package.json main 字段）
  env: {                                // 注入子进程环境变量
    ...process.env,
    VITE_MOCK: 'true',      // renderer 走 mock API
    VITE_E2E: 'true',       // mock 注入 e2eTestSession
    XYZ_MOCK: '1',          // main 跳过 runtime spawn
    XYZ_E2E: '1',           // window-factory 跳过 waitForVite，loadFile 构建产物
    XYZ_AGENT_DATA_DIR: tmpDataDir,  // 隔离数据目录
  },
  args: ['.'],              // 启动参数（'.' 表示当前目录 = cwd）
})
// 返回：ElectronApplication

const page = await app.firstWindow()  // 拿第一个 BrowserWindow 的 Page
```

**坑**：
- `executablePath` 必填。electron 装在 `src-electron/node_modules`（workspace 隔离），不在 root。用 `createRequire(path.join(SRC_ELECTRON, 'noop.js'))('electron')` 解析
- `cwd` 必须是 `src-electron`（含 `package.json` 的 `main: dist/main/main.cjs`），否则 `app.getAppPath()` 解析错
- 每个 test 独立 app 实例（per-test 重启更安全，Electron 跨用例复用有状态泄漏风险）

### 本项目封装（`e2e/fixtures/launch-app.ts`）

```typescript
import { test, expect } from './fixtures/launch-app'

test('用例名', async ({ page }) => {
  // test fixture 自动启动 + 清理 app
  // page 是 Electron 的 firstWindow
})
```

---

## 二、定位元素（选择器）

### 首选：`data-testid`（最稳定）

```typescript
// 组件加 data-testid="xxx"
// 测试用 getByTestId
await page.getByTestId('file-view-root')          // 单元素
await page.getByTestId('file-tree-dir-src')       // 动态 testid：file-tree-dir-{path}
await page.getByTestId('file-tree-file-src/index.ts')  // path 含 /，testid 整体作字符串
```

**规则**：本项目所有可交互/可断言元素必须加 `data-testid`。动态 testid 用 path 拼接（`file-tree-dir-${node.path}`）。

### 文本定位（`getByText`）

```typescript
await page.getByText('E2E 文件树测试')              // 精确文本
await page.getByText(/export function/)            // 正则
await expect(page.getByTestId('detail-content')).toContainText('diff --git')  // 包含
```

### Role 定位（`getByRole`，语义化）

```typescript
await page.getByRole('button', { name: /^会话/ })   // button，name 前缀匹配（避免计数变化）
await page.getByRole('textbox', { name: /描述你想让 AI/ })  // 输入框
await page.getByRole('heading', { level: 1 })       // h1
```

**name 匹配**：
- 字符串：精确匹配（含空格）
- `/正则/`：部分匹配
- 按钮的 name = 文本内容（如"会话 6"含计数），用 `/^会话/` 前缀匹配避免计数变化失配

### CSS 定位（`locator`）

```typescript
await page.locator('.session-item').nth(1)   // 第二个 session item
await page.locator('[data-testid="detail-content"] pre').count()  // 子元素计数
```

### 链式 + 过滤

```typescript
await page.getByTestId('file-tree-file-src/new-feature.ts').filter({ hasText: 'A' })
await page.getByRole('listitem').filter({ hasText: /sample-project/ })
```

---

## 三、交互操作

### 点击 `click()`

```typescript
await page.getByTestId('file-tree-dir-src').click()
await page.getByText('E2E 文件树测试').click()
// 选项：click({ position: {x,y}, modifier: ['Shift'], timeout: 5000 })
```

**自动等待**：click 自带 Actionability 检查（元素可见、可点、稳定），默认等 30s。不用手动 sleep。

### 输入 `fill()` / `type()`

```typescript
await page.getByTestId('file-filter-input').fill('readme')      // 整体替换（推荐）
await page.getByTestId('file-filter-input').fill('')            // 清空
// type 是逐字符（慢，模拟真实键盘，一般不需要）
```

**v-model 组件**：用 `fill` 触发 `@update:modelValue`。本项目 Input 组件用 `:model-value` + `@update:model-value`，fill 能正确触发。

### 键盘 `keyboard`

```typescript
await page.keyboard.press('Escape')           // 关 SideDrawer
await page.keyboard.press('Meta+N')           // 新建任务
await page.keyboard.press('Control+Shift+I')  // 打开 DevTools
await page.keyboard.type('hello')             // 逐字符
```

---

## 四、等待（自动等待优先，显式等待兜底）

### 自动等待（首选）

Playwright 的 `click`/`fill`/`expect` 自带自动等待，**大多数情况不需要手动 wait**：
```typescript
// click 自动等元素可见可点
await page.getByTestId('file-tree-dir-src').click()
```

### 显式等待 `expect(...).toBeVisible()`（推荐）

```typescript
await expect(page.getByTestId('file-view-root')).toBeVisible({ timeout: 10000 })
await expect(page.getByTestId('file-loading')).not.toBeVisible()  // 等消失
```

**timeout 参数**：默认 5000ms，mock 模式延迟 40ms 但组件挂载有开销，建议关键元素 `timeout: 10000`。

### 等待状态 `waitForLoadState` / `waitForTimeout`

```typescript
await page.waitForLoadState('domcontentloaded')   // 等 DOM 加载
await page.waitForLoadState('networkidle')        // 等网络空闲
await page.waitForTimeout(2000)                   // 固定等待（最后手段，避免）
```

### 等待条件 `waitForFunction`

```typescript
await page.waitForFunction(() => {
  return document.querySelector('[data-testid="file-view-root"]')?.children.length > 0
})
```

### race 断言（二选一可见）

```typescript
// 适用于"快速切换的状态"（如 loading → content 40ms 切换）
await expect(
  page.getByTestId('detail-loading').or(page.getByTestId('detail-content'))
).toBeVisible({ timeout: 5000 })
```

---

## 五、断言（`expect`）

### 元素断言

```typescript
await expect(loc).toBeVisible()                  // 可见
await expect(loc).toBeHidden()                   // 隐藏
await expect(loc).toHaveCount(0)                 // 不存在（0 个匹配）
await expect(loc).toHaveCount(1)                 // 恰好 1 个
await expect(loc).toContainText('diff --git')    // 文本包含
await expect(loc).toHaveText('确切的文本')        // 文本精确等于
await expect(loc).toHaveClass(/text-accent/)     // class 含
await expect(loc).toHaveAttribute('aria-expanded', 'true')  // 属性
```

### 反向断言（元素不存在）

```typescript
// ❌ 容易超时：toBeVisible 会等元素出现
await expect(page.getByTestId('xxx')).not.toBeVisible()

// ✅ 推荐：toHaveCount(0) 直接判定不存在，不等待
await expect(page.getByTestId('xxx')).toHaveCount(0)
```

### 数值断言

```typescript
const count = await page.locator('script').count()
expect(count).toBe(0)
```

---

## 六、Electron 专属（主进程交互）

### 执行主进程代码 `evaluate`

```typescript
// 在 renderer 上下文执行（page.evaluate）
const version = await page.evaluate(() => window.electronAPI?.getVersion?.())

// 在主进程执行（app.evaluate）
const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
```

### 读 console / pageerror（验证无错误）

```typescript
const errors = []
page.on('pageerror', (err) => errors.push(err.message))         // 未捕获异常
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())           // console.error
})
// ... 操作后 ...
expect(errors).toEqual([])
```

### 窗口操作

```typescript
await app.firstWindow()                          // 第一个窗口
const wins = await app.windows()                 // 所有窗口
await app.close()                                // 关闭 app（fixture 自动做）
```

---

## 七、Mock 模式时序（等待时机）

本项目 mock 延迟（`mock/index.ts` TIMING）：

| 操作 | 延迟 | 说明 |
|------|------|------|
| session.list / config 等 ack | 40ms | mock TIMING.ack |
| session.switchSession | 30ms | TIMING.switchCmd |
| file.tree / expand / read | 40ms | mock/file.ts MOCK_ACK_MS |
| git.status / getDiff | 40ms | mock/git.ts TIMING.ack |

**实战**：连续操作间用 `expect(...).toBeVisible({timeout:10000})` 兜底，不要硬编码 sleep。loadTree 并行拉 file.tree + git.status，FileView 渲染在两者都完成后（Promise.allSettled）。

---

## 八、调试

### headed 模式（看窗口）

```bash
npx playwright test --headed
```

### 暂停 + Inspector

```typescript
await page.pause()  // 代码中插入，打开 Playwright Inspector
```

```bash
PWDEBUG=1 npx playwright test
```

### trace（失败时自动保留）

```bash
npx playwright show-trace test-results/xxx/trace.zip
```

playwright.config.ts 已配 `trace: 'retain-on-failure'`，失败时自动生成 trace.zip。

### screenshot（失败时自动保留）

`test-results/xxx/test-failed-1.png` 直接看。

### error-context.md（失败时自动生成）

`test-results/xxx/error-context.md` 含失败时的 accessibility 快照（yaml 格式，是定位"页面到底渲染了什么"的第一手材料）。

---

## 九、常见坑

| 坑 | 现象 | 解法 |
|----|------|------|
| 不切 sessions tab 直接找 session | `getByText('E2E 文件树测试')` 超时 | 先 `getByRole('button',{name:/^会话/}).click()` |
| 按钮含动态计数 | `{name:'会话'}` 失配（实际"会话 6"） | 用 `/^会话/` 前缀正则 |
| 元素短暂出现就消失 | `toBeVisible` 在元素已消失后断言失败 | 用 `.or()` race 断言 |
| mock 太快捕捉不到 loading | `detail-loading` 断言超时 | mock 轨用 race 兜底，real 轨延迟大能稳定测 |
| 路径含 `/` 的 testid | `getByTestId('file-tree-file-src/index.ts')` | testid 是完整字符串，整串传入即可 |
| cwd 残留导致 vitest 误跑 | Playwright 跑了 vitest 的测试 | 每条命令 `cd <repo-root> && npx playwright test` |
| `node:path` 类错误 E2E 不报 | E2E 全绿但 dev 崩 | E2E mock 不触发 getter，必须配套 dev 冒烟（见 01-dev-smoke-test.md）|

---

## 十、写新 E2E 用例的模板

```typescript
import { test, expect } from './fixtures/launch-app'

test('用例名（用例 ID: T-x.x）', async ({ page }) => {
  // 1. 前置：导航到功能起点
  await gotoFileTree(page)  // 或自定义前置函数

  // 2. 操作：触发被测行为
  await page.getByTestId('xxx').click()

  // 3. 断言：验证期望结果（用 data-testid + toBeVisible/toContainText）
  await expect(page.getByTestId('yyy')).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('yyy')).toContainText('期望文本')
})
```

**规则**：
- 每个用例独立（不依赖前序用例状态）
- 用 `gotoFileTree` 或显式导航设定起点，不依赖 app 初始状态
- 断言必须有 DOM 可见性（三视角之"观察者视角"），不止断内部状态
