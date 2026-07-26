#!/usr/bin/env node

/**
 * 诊断脚本：复现浏览器页面残留问题
 *
 * 使用 Playwright 连接 xyz-agent dev 模式的 Electron app（remote-debugging-port=9222），
 * 执行以下操作序列来复现问题：
 * 1. 打开 drawer 的 browser tab
 * 2. 导航到一个网页
 * 3. 切到其他 session
 * 4. 关闭 drawer
 * 5. 截图验证：屏幕中间不应有残留的网页内容
 *
 * 使用方法：
 * 1. 启动 xyz-agent dev 模式：pnpm dev
 * 2. 运行诊断脚本：node scripts/diagnose-browser-residue.js
 */

import { chromium } from 'playwright'

const DEBUG_PORT = 9222

const SCREENSHOT_PATHS = {
  initial: '/tmp/diagnose-01-initial.png',
  drawerOpen: '/tmp/diagnose-02-after-cmd-b.png',
  browserOpen: '/tmp/diagnose-03-browser-open.png',
  afterSwitch: '/tmp/diagnose-04-after-switch.png',
  drawerClosed: '/tmp/diagnose-05-drawer-closed.png',
  error: '/tmp/diagnose-error.png',
}

/** 截图工具：保存截图并打印路径 */
async function screenshot(page, name) {
  await page.screenshot({ path: SCREENSHOT_PATHS[name] })
  console.log(`[诊断] ${name} 截图已保存: ${SCREENSHOT_PATHS[name]}`)
}

/** 连接到 Electron app 的 remote debugging port */
async function connectToElectron() {
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`)
  const contexts = browser.contexts()
  if (contexts.length === 0) {
    console.error('[错误] 未找到 Electron app 的 context，请确认 xyz-agent dev 模式已启动')
    process.exit(1)
  }
  const pages = contexts[0].pages()
  if (pages.length === 0) {
    console.error('[错误] 未找到页面')
    process.exit(1)
  }
  const page = pages[0]
  console.log(`[诊断] 连接到页面: ${page.url()}`)
  return { browser, page }
}

/** 打开 drawer（先尝试 Cmd+B，再找按钮） */
async function openDrawer(page) {
  console.log('[诊断] 步骤2: 尝试打开 drawer...')

  // 尝试直接点击 browser tab
  const browserTab = await page.$('[data-testid="drawer-tab-browser"]')
  if (browserTab) {
    await browserTab.click()
    console.log('[诊断] 已点击 browser tab')
    return
  }

  // 通过快捷键打开 drawer
  console.log('[诊断] 未找到 drawer-tab-browser，尝试 Cmd+B...')
  await page.keyboard.press('Meta+b')
  await page.waitForTimeout(500)
  await screenshot(page, 'drawerOpen')

  // 再次查找 browser tab
  const browserTab2 = await page.$('[data-testid="drawer-tab-browser"]')
  if (browserTab2) {
    await browserTab2.click()
    console.log('[诊断] 已点击 browser tab')
  }
}

/** 导航到指定 URL */
async function navigateToUrl(page, url) {
  console.log(`[诊断] 步骤3: 尝试导航到 ${url}...`)
  const urlInput = await page.$('[data-testid="browser-urlbar-input"]')
  if (urlInput) {
    await urlInput.click()
    await urlInput.fill(url)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2000)
    console.log(`[诊断] 已导航到 ${url}`)
  } else {
    console.log('[诊断] 未找到 URL 输入框')
  }
  await page.waitForTimeout(500)
}

/** 切换到其他 session */
async function switchSession(page) {
  console.log('[诊断] 步骤4: 尝试切换 session...')
  const sessionItems = await page.$$('[data-testid^="session-item-"]')
  console.log(`[诊断] 找到 ${sessionItems.length} 个 session`)

  if (sessionItems.length > 1) {
    await sessionItems[1].click()
    await page.waitForTimeout(500)
    console.log('[诊断] 已切换到另一个 session')
  } else {
    console.log('[诊断] 只有一个 session，无法切换')
  }
}

/** 关闭 drawer */
async function closeDrawer(page) {
  console.log('[诊断] 步骤5: 关闭 drawer...')
  const closeButton = await page.$('[data-testid="drawer-close"]')
  if (closeButton) {
    await closeButton.click()
    console.log('[诊断] 已点击关闭按钮')
  } else {
    await page.keyboard.press('Meta+b')
    console.log('[诊断] 已按 Cmd+B 关闭 drawer')
  }
  await page.waitForTimeout(500)
}

/** 检查是否有残留的网页内容 */
async function checkResidue(page) {
  console.log('[诊断] 步骤6: 检查是否有残留...')
  const viewport = await page.$('[data-testid="browser-vp"]')
  if (viewport) {
    const box = await viewport.boundingBox()
    if (box && box.width > 0 && box.height > 0) {
      console.log('[警告] browser-vp 仍然可见！可能存在残留问题')
      console.log(`[警告] browser-vp 位置: x=${box.x}, y=${box.y}, width=${box.width}, height=${box.height}`)
    } else {
      console.log('[正常] browser-vp 不可见')
    }
  }

  console.log('[诊断] 诊断完成。请检查截图：')
  Object.entries(SCREENSHOT_PATHS).forEach(([name, path]) => {
    console.log(`  - ${path} (${name})`)
  })
  console.log('')
  console.log('[诊断] 如果 drawerClosed 中间有网页内容残留，则问题已复现')
}

async function main() {
  console.log('[诊断] 启动浏览器页面残留诊断脚本')

  const { browser, page } = await connectToElectron()

  try {
    // 步骤1：初始状态截图
    console.log('[诊断] 步骤1: 查看初始状态...')
    await screenshot(page, 'initial')

    // 步骤2：打开 drawer
    await openDrawer(page)

    // 步骤3：导航到网页
    await navigateToUrl(page, 'https://example.com')
    await screenshot(page, 'browserOpen')

    // 步骤4：切换 session
    await switchSession(page)
    await screenshot(page, 'afterSwitch')

    // 步骤5：关闭 drawer
    await closeDrawer(page)
    await screenshot(page, 'drawerClosed')

    // 步骤6：检查残留
    await checkResidue(page)

  } catch (error) {
    console.error('[错误] 诊断过程中出错:', error)
    await screenshot(page, 'error')
  } finally {
    await browser.close()
  }
}

main().catch(console.error)
