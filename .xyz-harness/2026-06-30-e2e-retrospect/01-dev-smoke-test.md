# 01 — Dev 启动冒烟测试流程

> **用途**：拦住本次 `node:path` 崩溃 bug 的闸门。E2E mock 模式验证不了 dev 启动，本测试专门补这个缺口。
>
> **何时跑**：每个 Wave 开发完成提交前、W8 验收前、任何改动了 shared/renderer/runtime 模块加载逻辑后。

---

## 原理

`node:path` 类错误的特征：
- vite **build** 时 externalize 成惰性代理（不报错）
- vite **dev** 时模块求值更激进，import 解析阶段就可能触发
- 只有**真实浏览器加载页面**才会暴露（node 跑 typecheck/单测都不触发）

所以验证必须用**真实浏览器（chromium）加载 dev server 页面**，捕获 console error。

---

## 前置准备

```bash
# 安装 chromium（首次）
npx playwright install chromium
```

---

## 手动验证（一次性，调试用）

```bash
# 1. 启动 vite dev server（不走 electron，隔离验证 renderer）
cd src-electron && VITE_MOCK=true npm run dev:vite
# 输出：VITE ready in 134ms → Local: http://localhost:1420/

# 2. 浏览器打开 http://localhost:1420/，开 DevTools Console
#    期望：无红色 error（CSP 警告是 electron 打包相关，dev 下可忽略）
```

---

## 自动化脚本（推荐，纳入 CI/验收）

脚本位置：项目根 `scripts/dev-smoke.mjs`（待创建）。以下是完整实现：

```javascript
// scripts/dev-smoke.mjs — dev 启动冒烟，捕获 renderer console error
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'

const PORT = 1420
const URL = `http://localhost:${PORT}/`

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`vite dev server 未在 ${timeoutMs}ms 内就绪: ${url}`)
}

async function main() {
  // 1. 启动 vite dev server（子进程）
  const vite = spawn('npm', ['run', 'dev:vite'], {
    cwd: path.join(process.cwd(), 'src-electron'),
    env: { ...process.env, VITE_MOCK: 'true' },
    stdio: 'pipe',
  })

  try {
    // 2. 等待 server 就绪
    await waitForServer(URL)

    // 3. 用 chromium 加载页面，捕获所有 console error + pageerror
    const browser = await chromium.launch()
    const page = await browser.newPage()
    const errors = []
    const consoleErrors = []

    page.on('pageerror', (err) => errors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 })
    await page.waitForTimeout(2000) // 等 mock 初始化 + 组件挂载

    // 4. 断言：无 node:path externalize 错误（拦本次 bug）
    const allErrors = [...errors, ...consoleErrors]
    const fatalPatterns = ['node:path', 'externalized for browser', 'Cannot access']

    const fatal = allErrors.filter((m) =>
      fatalPatterns.some((p) => m.includes(p)),
    )

    console.log('=== pageerror ===')
    console.log(errors.length ? errors.join('\n') : '(none)')
    console.log('=== console error ===')
    console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)')

    await browser.close()

    if (fatal.length > 0) {
      console.error('❌ 发现致命错误（模块加载/externalize）:')
      fatal.forEach((e) => console.error('  -', e))
      process.exit(1)
    }
    console.log('✅ dev 启动冒烟通过（0 致命 error）')
  } finally {
    vite.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

### 运行

```bash
node scripts/dev-smoke.mjs
```

### 期望输出

```
=== pageerror ===
(none)
=== console error ===
(none)
✅ dev 启动冒烟通过（0 致命 error）
```

### 失败时的输出（本次 bug 场景）

```
=== pageerror ===
Module "node:path" has been externalized for browser compatibility. Cannot access "node:path.relative" in client code.
=== console error ===
... 同上 ...
❌ 发现致命错误（模块加载/externalize）:
  - Module "node:path" has been externalized...
```

---

## 检查清单（每次跑完确认）

- [ ] vite dev server 启动成功（`VITE ready in XXXms`）
- [ ] chromium 加载 `http://localhost:1420/` 返回 200
- [ ] `pageerror` 列表为空
- [ ] `console error` 无 `node:path` / `externalized` / `Cannot access` 关键词
- [ ] 脚本 exit 0

任一项失败 = dev 启动有问题，**禁止声称"验收通过"**。

---

## 与 E2E mock 模式的关系

| 测试 | 验证什么 | 抓本次 bug |
|------|---------|-----------|
| E2E mock（`npx playwright test`） | mock 模式 renderer 渲染 + 交互 | ❌ mock 不触发 node:path getter |
| dev 冒烟（`scripts/dev-smoke.mjs`） | dev 模式 renderer 模块加载 | ✅ 加载即触发 externalize 报错 |

**两者互补，不可替代**。E2E mock 验证功能逻辑，dev 冒烟验证启动健康。
