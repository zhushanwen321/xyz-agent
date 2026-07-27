/**
 * 验证脚本：chokidar watcher 对「已 watch 目录下新建 skill 子目录」事件的可靠性。
 *
 * 用法：node tools/verify-skill-watcher.cjs
 *
 * 背景：chokidar v4 移除 native fsevents 绑定后，macOS 上 fs.watch 对新建子目录/文件事件不可靠
 * （nodejs/node#52601 启动竞态 + FSEvents coalescing）。本脚本对比默认 fs.watch 后端 vs
 * usePolling 后端，验证 usePolling 才是 macOS 可靠方案（skill-registry.ts WATCH_OPTIONS 用的就是它）。
 *
 * 隔离 UI 层干扰，直接用 chokidar 监听临时 skill 目录，跨进程（spawn）创建子目录模拟用户磁盘操作。
 *
 * 退出码：0 = usePolling 模式稳定触发（PASS）；非 0 = FAIL。
 */
const { watch } = require('chokidar')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawn } = require('node:child_process')

const WATCH_IGNORED = /(^|[\/\\])(node_modules|dist|build|\.git|\.next|coverage|out)([\/\\]|$)/

async function runScenario(label, usePolling) {
  const root = mkdtempSync(join(tmpdir(), `skill-watcher-${label}-`))
  const skillsDir = join(root, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(join(skillsDir, 'existing-skill'), { recursive: true })
  writeFileSync(join(skillsDir, 'existing-skill', 'SKILL.md'), '---\nname: existing\n---\nbody\n')

  const events = []
  const opts = {
    ignored: WATCH_IGNORED,
    ignoreInitial: true,
    persistent: true,
  }
  if (usePolling) {
    opts.usePolling = true
    opts.interval = 500
    opts.binaryInterval = 500
  }
  const watcher = watch([skillsDir], opts)
  watcher.on('all', (event, path) => events.push({ event, path }))

  return new Promise((resolve) => {
    watcher.on('ready', () => {
      // 跨进程创建 skill 子目录（模拟用户从 shell/Finder 创建）
      setTimeout(() => {
        spawn('sh', ['-c', `mkdir -p ${skillsDir}/new-skill && sleep 0.2 && echo body > ${skillsDir}/new-skill/SKILL.md`])
      }, 500)
      // 等 usePolling 最多 2 个周期（1s）+ debounce 余量
      setTimeout(async () => {
        const gotAddDir = events.some(e => e.event === 'addDir' && e.path.endsWith('new-skill'))
        const gotAdd = events.some(e => e.event === 'add' && e.path.endsWith('SKILL.md'))
        await watcher.close()
        rmSync(root, { recursive: true, force: true })
        resolve({ label, usePolling, events, gotAddDir, gotAdd })
      }, 3000)
    })
  })
}

;(async () => {
  console.log('=== Scenario 1: 默认 fs.watch 后端（macOS 不可靠） ===')
  const s1 = await runScenario('fswatch', false)
  console.log(`  events: ${s1.events.length} gotAddDir=${s1.gotAddDir} gotAdd=${s1.gotAdd}`)
  console.log(`  ${s1.gotAddDir ? 'PASS' : 'FAIL (flaky — 预期，这就是预存 bug)'}\n`)

  console.log('=== Scenario 2: usePolling 后端（修复方案） ===')
  const s2 = await runScenario('polling', true)
  console.log(`  events: ${s2.events.length} gotAddDir=${s2.gotAddDir} gotAdd=${s2.gotAdd}`)
  console.log(`  ${s2.gotAddDir && s2.gotAdd ? 'PASS' : 'FAIL'}\n`)

  console.log(`=== RESULT ===`)
  console.log(`usePolling 模式 ${s2.gotAddDir && s2.gotAdd ? '可靠触发 (修复生效)' : '未触发 (FAIL)'}`)
  process.exit(s2.gotAddDir && s2.gotAdd ? 0 : 1)
})()
