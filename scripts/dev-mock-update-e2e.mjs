#!/usr/bin/env node
/**
 * P2 半 E2E 验证脚本（自动升级 UI 流程）。
 *
 * 前置：先启动 dev app（带 mock 环境变量）：
 *   XYZ_DEV_MOCK_UPDATE=1 pnpm dev
 * 等 Electron 窗口起来后（9222 端口可用），另开终端跑此脚本。
 *
 * 流程：
 *   1. 连接 9222 端口的 dev Electron renderer（connectOverCDP，对策 1 不抢焦点）
 *   2. 选 URL 含 localhost:1420 的 page（vite dev server，AGENTS.md §9）
 *   3. 等 sidebar 加载完成
 *   4. 手动触发 useAppUpdate().checkForUpdate（不等 30s 自动触发）——
 *      通过 evaluate 注入的 window.__testTriggerUpdate 调用。
 *      若该入口不存在（dev app 未暴露），降级为等 35s 让 initAutoCheck 自动跑。
 *   5. 断言 [data-testid="update-button"] 出现（available 态）
 *   6. hover [data-testid="update-available"] → 等 release note 浮层渲染
 *   7. 截图保存到 /tmp/dev-update-e2e-*.png（全页面 + 浮层区域）
 *   8. 断言 release note 浮层含 markdown 渲染的 HTML（<h2>/<code> 标签）
 *
 * 用法：node scripts/dev-mock-update-e2e.mjs
 *
 * 退出码：0=全部通过，非 0=失败（任一断言不过或连接异常）。
 */
import { chromium } from 'playwright'

const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://localhost:9222'
const SCREENSHOT_DIR = '/tmp'
const VITE_URL_SUBSTRING = 'localhost:1420' // AGENTS.md §9：renderer 经 vite dev server 加载
// 手动触发超时：useAppUpdate.checkForUpdate 走 IPC（mock 立即返回）+ markdown 渲染（shiki WASM 首次约 1-2s）
const MANUAL_TRIGGER_TIMEOUT_MS = 15_000
// 自动触发降级等待：initAutoCheck 30s + 渲染 buffer 5s
const AUTO_CHECK_WAIT_MS = 35_000

/** 简单 pass/fail 日志，累计断言结果用于最终汇总。 */
const results = []
function pass(msg) {
  results.push({ ok: true, msg })
  console.log(`  [PASS] ${msg}`)
}
function fail(msg, err) {
  results.push({ ok: false, msg, err })
  console.error(`  [FAIL] ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`)
}
function step(n, msg) {
  console.log(`\n[步骤 ${n}] ${msg}`)
}

/** 退出码：任一 fail 则非 0 */
function exitCode() {
  return results.some((r) => !r.ok) ? 1 : 0
}

/**
 * 找到 vite dev server 的 page（renderer）。
 * Electron 主进程自身也有 page，但 URL 不含 localhost:1420——必须按 URL 过滤。
 */
async function findRendererPage(browser) {
  const pages = browser.contexts().flatMap((c) => c.pages())
  const renderer = pages.find((p) => p.url().includes(VITE_URL_SUBSTRING))
  if (!renderer) {
    throw new Error(
      `未找到 URL 含 "${VITE_URL_SUBSTRING}" 的 page。` +
        `现有 page URL：${pages.map((p) => p.url()).join(', ') || '(空)'}。` +
        `确认 dev app 已起来且 vite dev server 正常监听 1420。`,
    )
  }
  return renderer
}

/**
 * 手动触发 useAppUpdate().checkForUpdate。
 *
 * 渲染进程里 useAppUpdate 是 module-level 单例，无法直接从外部访问。
 * 此函数尝试两条路径：
 *   1. window.__testTriggerUpdate（dev app 若暴露的测试钩子，最可靠）
 *   2. 直接调 preload 暴露的 window.xyz.checkForUpdate（更新 main 缓存，但需配合 Vue 刷新——
 *      此路径只验证 IPC 通，状态机刷新靠自动触发）
 *
 * 返回 true 表示已成功触发；false 表示需降级到等自动触发。
 */
async function tryManualTrigger(page) {
  // 路径 1：测试钩子（若 dev app 在 window 上挂了 __testTriggerUpdate）
  const hasHook = await page.evaluate(() => typeof window.__testTriggerUpdate === 'function')
  if (hasHook) {
    console.log('  发现 window.__testTriggerUpdate 钩子，调用以触发检测')
    await page.evaluate(async () => {
      await window.__testTriggerUpdate()
    })
    return true
  }

  // 路径 2：直接通过 Vue app 实例访问组件树（Vue3 dev 模式 app.config.globalProperties）
  // 多数 dev app 不暴露，此处尝试一次，失败则返回 false 让上层降级。
  console.log('  未发现 __testTriggerUpdate 钩子，尝试通过 Vue devtools 入口...')
  const triggered = await page.evaluate(() => {
    // Vue3 dev build 会在带 __vue_app__ 的根元素挂 app 实例
    const root = document.querySelector('#app')
    if (!root || !root.__vue_app__) return false
    const app = root.__vue_app__
    // useAppUpdate 是 composable，其 state 是 module-level 单例——
    // 无法经 app 实例直接拿，但可经 Pinia/globalProperties 尝试（项目未挂则 false）
    const tryFn = app.config?.globalProperties?.$testTriggerUpdate
    if (typeof tryFn === 'function') {
      tryFn()
      return true
    }
    return false
  })
  return triggered
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  自动升级 P2 半 E2E 验证（dev mock releaseChecker）')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`CDP 端点：${CDP_ENDPOINT}`)

  step(1, `连接 dev Electron renderer（${CDP_ENDPOINT}）`)
  let browser
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT)
  } catch (err) {
    fail(`连接 CDP 端点失败（确认 dev app 已起来：XYZ_DEV_MOCK_UPDATE=1 pnpm dev）`, err)
    process.exit(exitCode())
  }
  pass(`已连接 CDP（contexts=${browser.contexts().length}）`)

  try {
    step(2, '定位 vite dev server page')
    const page = await findRendererPage(browser)
    pass(`renderer page URL：${page.url()}`)

    step(3, '等待 sidebar 挂载（UpdateButton 容器）')
    // sidebar 是左固定栏，应用挂载后立即可见。等 #app 出现即可。
    try {
      await page.waitForSelector('#app', { timeout: MANUAL_TRIGGER_TIMEOUT_MS })
      pass('#app 已挂载')
    } catch (err) {
      fail('等待 #app 挂载超时（dev app 可能未正常加载）', err)
      process.exit(exitCode())
    }

    step(4, '触发 checkForUpdate（手动优先，降级等自动）')
    const manuallyTriggered = await tryManualTrigger(page).catch((err) => {
      console.log(`  手动触发评估出错（降级到自动）：${err.message}`)
      return false
    })
    if (manuallyTriggered) {
      pass('已手动触发 checkForUpdate')
    } else {
      console.log(`  未找到手动触发入口，降级：等 ${AUTO_CHECK_WAIT_MS / 1000}s 让 initAutoCheck 自动跑`)
      await page.waitForTimeout(AUTO_CHECK_WAIT_MS)
      pass('自动触发等待完成（initAutoCheck 30s + buffer）')
    }

    step(5, '断言 update-button 可见（state=available）')
    try {
      // available 态会渲染 data-testid="update-available"（hover trigger 按钮）
      await page.waitForSelector('[data-testid="update-available"]', {
        timeout: MANUAL_TRIGGER_TIMEOUT_MS,
      })
      pass('update-button visible (state=available)')
    } catch (err) {
      fail('update-button 未进入 available 态（检查 mock 是否注入：XYZ_DEV_MOCK_UPDATE=1 + isDev）', err)
      // 仍继续，截图记录当前状态
    }

    step(6, 'hover update-available → 等 release note 浮层渲染')
    const hoverTarget = await page.$('[data-testid="update-available"]')
    if (hoverTarget) {
      await hoverTarget.hover()
      // HoverCardContent 由 radix-like 机制异步挂载，等带 testid 的容器
      try {
        await page.waitForSelector('[data-testid="update-release-notes"]', {
          timeout: MANUAL_TRIGGER_TIMEOUT_MS,
        })
        pass('release note 浮层已渲染')
      } catch (err) {
        fail('release note 浮层未渲染（hover 失败或 markdown 渲染挂掉）', err)
      }
    } else {
      fail('找不到 hover target（update-available），跳过浮层验证')
    }

    step(7, '截图保存到 /tmp')
    const fullShot = `${SCREENSHOT_DIR}/dev-update-e2e-full.png`
    await page.screenshot({ path: fullShot, fullPage: true })
    pass(`全页面截图：${fullShot}`)

    const notesEl = await page.$('[data-testid="update-release-notes"]')
    if (notesEl) {
      const popoverShot = `${SCREENSHOT_DIR}/dev-update-e2e-popover.png`
      await notesEl.screenshot({ path: popoverShot })
      pass(`浮层区域截图：${popoverShot}`)
    } else {
      fail('浮层元素不存在，跳过区域截图')
    }

    step(8, '断言 release note markdown 渲染（HTML 含 <h2> + <code>）')
    if (notesEl) {
      const innerHTML = await notesEl.innerHTML()
      const hasH2 = /<h2[\s>]/i.test(innerHTML)
      // 行内 <code> 或代码块 <pre><code> 都算
      const hasCode = /<code[\s>]/i.test(innerHTML)
      if (hasH2) {
        pass('release notes 含 <h2>（markdown 标题已渲染）')
      } else {
        fail(`release notes 缺 <h2>（HTML 片段：${innerHTML.slice(0, 200)}...）`)
      }
      if (hasCode) {
        pass('release notes 含 <code>（markdown 代码块已渲染）')
      } else {
        fail(`release notes 缺 <code>（HTML 片段：${innerHTML.slice(0, 200)}...）`)
      }
    } else {
      fail('浮层元素不存在，跳过 markdown 渲染断言')
    }
  } finally {
    // connectOverCDP 只断开我们的连接，不会关闭 dev app 窗口（对策 1 不抢焦点也不杀进程）
    browser.close().catch(() => {})
  }

  // ── 汇总 ──────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  console.log(`  汇总：${passed} pass / ${failed} fail`)
  console.log('═══════════════════════════════════════════════════════════')
  process.exit(exitCode())
}

main().catch((err) => {
  console.error('\n[FATAL] 脚本异常退出：', err)
  process.exit(2)
})
