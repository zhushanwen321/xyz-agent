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

async function main() {
  console.log('[诊断] 启动浏览器页面残留诊断脚本')
  
  // 连接到 Electron app 的 remote debugging port
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`)
  const contexts = browser.contexts()
  
  if (contexts.length === 0) {
    console.error('[错误] 未找到 Electron app 的 context，请确认 xyz-agent dev 模式已启动')
    process.exit(1)
  }
  
  const context = contexts[0]
  const pages = context.pages()
  
  if (pages.length === 0) {
    console.error('[错误] 未找到页面')
    process.exit(1)
  }
  
  const page = pages[0]
  console.log(`[诊断] 连接到页面: ${page.url()}`)
  
  try {
    // 步骤1：检查是否有 open drawer 的按钮
    console.log('[诊断] 步骤1: 查找 drawer 控制按钮...')
    
    // 先截图看看当前状态
    await page.screenshot({ path: '/tmp/diagnose-01-initial.png' })
    console.log('[诊断] 初始状态截图已保存: /tmp/diagnose-01-initial.png')
    
    // 步骤2：尝试打开 drawer 的 browser tab
    console.log('[诊断] 步骤2: 尝试打开 drawer...')
    
    // 查找 browser tab 按钮（drawer-tab-browser）
    const browserTab = await page.$('[data-testid="drawer-tab-browser"]')
    if (browserTab) {
      await browserTab.click()
      console.log('[诊断] 已点击 browser tab')
    } else {
      console.log('[诊断] 未找到 drawer-tab-browser，尝试其他方式...')
      
      // 尝试通过快捷键打开 drawer
      await page.keyboard.press('Meta+b')  // Cmd+B 打开 drawer
      await page.waitForTimeout(500)
      
      await page.screenshot({ path: '/tmp/diagnose-02-after-cmd-b.png' })
      console.log('[诊断] Cmd+B 后截图已保存: /tmp/diagnose-02-after-cmd-b.png')
      
      // 再次查找 browser tab
      const browserTab2 = await page.$('[data-testid="drawer-tab-browser"]')
      if (browserTab2) {
        await browserTab2.click()
        console.log('[诊断] 已点击 browser tab')
      }
    }
    
    await page.waitForTimeout(500)
    
    // 步骤3：尝试导航到一个网页
    console.log('[诊断] 步骤3: 尝试导航到网页...')
    const urlInput = await page.$('[data-testid="browser-urlbar-input"]')
    if (urlInput) {
      await urlInput.click()
      await urlInput.fill('https://example.com')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(2000)  // 等待加载
      console.log('[诊断] 已导航到 https://example.com')
    } else {
      console.log('[诊断] 未找到 URL 输入框')
    }
    
    await page.screenshot({ path: '/tmp/diagnose-03-browser-open.png' })
    console.log('[诊断] 浏览器打开后截图已保存: /tmp/diagnose-03-browser-open.png')
    
    // 步骤4：查找 session 列表并切换
    console.log('[诊断] 步骤4: 尝试切换 session...')
    
    // 查找 session 列表（在 sidebar 中）
    const sessionItems = await page.$$('[data-testid^="session-item-"]')
    console.log(`[诊断] 找到 ${sessionItems.length} 个 session`)
    
    if (sessionItems.length > 1) {
      // 点击另一个 session
      await sessionItems[1].click()
      await page.waitForTimeout(500)
      console.log('[诊断] 已切换到另一个 session')
    } else {
      console.log('[诊断] 只有一个 session，无法切换')
    }
    
    await page.screenshot({ path: '/tmp/diagnose-04-after-switch.png' })
    console.log('[诊断] 切换 session 后截图已保存: /tmp/diagnose-04-after-switch.png')
    
    // 步骤5：关闭 drawer
    console.log('[诊断] 步骤5: 关闭 drawer...')
    
    const closeButton = await page.$('[data-testid="drawer-close"]')
    if (closeButton) {
      await closeButton.click()
      console.log('[诊断] 已点击关闭按钮')
    } else {
      // 尝试通过快捷键关闭
      await page.keyboard.press('Meta+b')
      console.log('[诊断] 已按 Cmd+B 关闭 drawer')
    }
    
    await page.waitForTimeout(500)
    
    await page.screenshot({ path: '/tmp/diagnose-05-drawer-closed.png' })
    console.log('[诊断] drawer 关闭后截图已保存: /tmp/diagnose-05-drawer-closed.png')
    
    // 步骤6：检查是否有残留的网页内容
    console.log('[诊断] 步骤6: 检查是否有残留...')
    
    // 检查 viewport 区域是否有非空内容
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
    
    // 检查是否有隐藏的 WebContentsView
    // 注意：WebContentsView 是由主进程管理的，我们无法直接从 renderer 检测
    // 但可以通过检查屏幕截图来判断
    
    console.log('[诊断] 诊断完成。请检查截图：')
    console.log('  - /tmp/diagnose-01-initial.png (初始状态)')
    console.log('  - /tmp/diagnose-02-after-cmd-b.png (打开 drawer)')
    console.log('  - /tmp/diagnose-03-browser-open.png (浏览器打开)')
    console.log('  - /tmp/diagnose-04-after-switch.png (切换 session)')
    console.log('  - /tmp/diagnose-05-drawer-closed.png (drawer 关闭)')
    console.log('')
    console.log('[诊断] 如果 /tmp/diagnose-05-drawer-closed.png 中间有网页内容残留，则问题已复现')
    
  } catch (error) {
    console.error('[错误] 诊断过程中出错:', error)
    await page.screenshot({ path: '/tmp/diagnose-error.png' })
  } finally {
    await browser.close()
  }
}

main().catch(console.error)
