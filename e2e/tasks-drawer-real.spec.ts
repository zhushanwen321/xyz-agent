/**
 * Tasks Drawer REAL E2E —— 真实 runtime + pi 子进程 + 真实 LLM。
 *
 * 与 mock 轨（tasks-drawer.spec.ts）的差异：
 * - 不设 VITE_MOCK/XYZ_MOCK → main spawn runtime → runtime spawn pi 子进程
 * - 真实 goal/todo extension 被 pi load，真实协议格式（__gui__ / ANSI widget）
 * - 真实 LLM 调用（慢/flaky，断言宽松，timeout 长）
 *
 * 三条 case：
 * - R1：extension load 契约（无 LLM，确定性强）—— pi 能 load goal/todo extension 无报错
 * - R2：真实 todo tool 调用 → drawer 渲染 todo 列表（LLM，宽松断言）
 * - R3：真实 goal_control 调用 → GoalCard 渲染（LLM，宽松断言）
 *
 * 运行（单独跑，real case 慢且花 token）：
 *   npx playwright test e2e/tasks-drawer-real.spec.ts --grep R1
 *   npx playwright test e2e/tasks-drawer-real.spec.ts --grep R2
 *   npx playwright test e2e/tasks-drawer-real.spec.ts --grep R3
 *
 * 前置依赖：real renderer bundle（build 时不传 VITE_MOCK，见 launch-app-real.ts 注释）。
 */
import { test, expect } from '@playwright/test'
import { launchRealApp, waitForRuntime } from './fixtures/launch-app-real'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV_PI_AGENT = path.join(os.homedir(), '.xyz-agent-dev', 'pi', 'agent')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

/**
 * 预建 dataDir + pi provider/model 配置 + npm extension 目录。
 *
 * pi 读 <dataDir>/pi/agent/settings.json，settings.json 的 packages 字段引用
 * npm:@zhushanwen/pi-goal 等，pi 去 <dataDir>/pi/agent/npm/node_modules/ 解析。
 * 临时目录没有 npm 目录 → symlink 到 dev 的 npm 目录（复用已安装的 node_modules）。
 */
function makePresetDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-real-tasks-'))
  const piAgentDir = path.join(dataDir, 'pi', 'agent')
  fs.mkdirSync(piAgentDir, { recursive: true })
  // provider/model 配置
  fs.copyFileSync(path.join(DEV_PI_AGENT, 'models.json'), path.join(piAgentDir, 'models.json'))
  fs.copyFileSync(path.join(DEV_PI_AGENT, 'settings.json'), path.join(piAgentDir, 'settings.json'))
  // npm extension 目录：symlink 到 dev 已安装的 node_modules（pi 按 npm:<pkg> 解析）
  const devNpmDir = path.join(DEV_PI_AGENT, 'npm')
  if (fs.existsSync(devNpmDir)) {
    fs.symlinkSync(devNpmDir, path.join(piAgentDir, 'npm'), 'dir')
  }
  return dataDir
}

/** 连 runtime WS，发消息，等指定 id 的 reply */
async function wsRoundTrip(port: number, msg: object, replyId: string, timeoutMs = 30_000): Promise<any> {
  const ws: WebSocket = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  try {
    return await new Promise<any>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`WS reply ${replyId} timeout ${timeoutMs}ms`)), timeoutMs)
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString())
        if (m.id === replyId) {
          clearTimeout(to)
          resolve(m)
        }
      })
      ws.send(JSON.stringify(msg))
    })
  } finally {
    ws.close()
  }
}

/** 读 dataDir/logs 下所有 runtime 日志合并成一个字符串（排查 extension load / error 的证据源） */
function readRuntimeLogs(dataDir: string): string {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return ''
  return fs.readdirSync(logDir)
    .filter((f) => f.startsWith('runtime-'))
    .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
    .join('\n')
}

/** 读 dataDir/logs 下所有 pi stdout jsonl 合并（extension error / tool 调用证据） */
function readPiLogs(dataDir: string): string {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return ''
  return fs.readdirSync(logDir)
    .filter((f) => f.startsWith('pi-') && f.endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
    .join('\n')
}

/**
 * 通过 WS 创建 session 并激活（对齐 workspace-real.spec.ts 范式）。
 * OS 原生目录选择 dialog 不可自动化，TEST-STRATEGY 约定用 WS 直连触发等效业务动作。
 *
 * @returns sessionId（创建的 session 的 id）
 */
async function createAndActivateSession(port: number): Promise<string> {
  const createReply = await wsRoundTrip(port, {
    type: 'session.create',
    id: 'tasks-real-create',
    payload: { cwd: SAMPLE_PROJECT, label: 'tasks-real-sample' },
  }, 'tasks-real-create')
  expect(createReply.type).toBe('session.created')
  return (createReply.payload.session as { id: string }).id
}

// ── R1: extension load 契约（无 LLM，确定性强） ──────────────────────────

/** 从 runtime 日志提取 extension load 结果的摘要（resolved N extensions） */
function extractExtensionResolveSummary(logs: string): string[] {
  const matches = logs.match(/\[extension-resolver\] resolved (\d+) extensions from (\d+) sources/g)
  return matches ?? []
}

test('R1: pi load goal/todo extension + session.create 成功', async () => {
  const dataDir = makePresetDataDir()
  const { page, cleanup } = await launchRealApp({ dataDir })
  try {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)

    // runtime 启动后给 1s 让 extension load 日志落盘
    await new Promise((r) => setTimeout(r, 1000))

    const runtimeLogs = readRuntimeLogs(dataDir)

    // 契约 1：extension-resolver 成功解析了 extension（resolve N from M sources）
    const resolveSummary = extractExtensionResolveSummary(runtimeLogs)
    expect(resolveSummary.length, 'extension-resolver 应至少被调用一次').toBeGreaterThan(0)
    // 解析出 4 个 extension（goal + todo + 2 个 file-based xyz-agent extension）
    const lastResolve = resolveSummary[resolveSummary.length - 1]
    expect(lastResolve).toMatch(/resolved [1-9]\d* extensions from [1-9]\d* sources/)

    // 契约 2：session.create 成功（pi 能正常响应）
    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 'r1-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'r1-sample' },
    }, 'r1-create')
    if (createReply.type !== 'session.created') {
      const diag = JSON.stringify({
        createReply,
        runtimeLogsTail: runtimeLogs.slice(-3000),
      }, null, 2)
      fs.writeFileSync('/tmp/r1-session-create-error.json', diag)
      console.log('[R1] session.create error, diag written to /tmp/r1-session-create-error.json')
    }
    expect(createReply.type).toBe('session.created')
    const session = createReply.payload.session as { id: string }
    const sessionId = session.id

    // 契约 3（核心）：goal/todo extension 被 pi load，出现在 commands 列表里。
    // 这是 real E2E 独有的验证：真实 pi load 真实 npm extension，source 为 npm:@zhushanwen/pi-*。
    const cmdsReply = await wsRoundTrip(port, {
      type: 'session.getCommands',
      id: 'r1-cmds',
      payload: { sessionId },
    }, 'r1-cmds')
    if (cmdsReply.type !== 'session.commands') {
      fs.writeFileSync('/tmp/r1-cmds-reply.json', JSON.stringify(cmdsReply, null, 2))
      console.log('[R1] getCommands reply type:', cmdsReply.type, '(diag → /tmp/r1-cmds-reply.json)')
    }
    expect(cmdsReply.type).toBe('session.commands')
    const cmds = cmdsReply.payload.commands as Array<{ name: string; source: string; sourceInfo?: { source?: string } }>
    const goalCmd = cmds.find((c) => c.name === 'goal')
    const todosCmd = cmds.find((c) => c.name === 'todos')
    expect(goalCmd, 'goal extension command 应被 pi load').toBeDefined()
    expect(todosCmd, 'todos extension command 应被 pi load').toBeDefined()
    // source 验证：来自 npm 包（真实 extension load 契约）
    expect(goalCmd?.source).toBe('extension')
    expect(goalCmd?.sourceInfo?.source).toBe('npm:@zhushanwen/pi-goal')
    expect(todosCmd?.sourceInfo?.source).toBe('npm:@zhushanwen/pi-todo')
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } else {
      console.log('[cleanup] dataDir 保留:', dataDir)
    }
  }
})

// ── R2: 真实 todo tool 调用 → 验证 todo 协议格式（__gui__ list-tree）（LLM，flaky） ──

/**
 * WS 驱动 + 监听广播事件。R2/R3 不走 UI 输入（real 模式 UI session 切换需 OS dialog），
 * 改为 WS 发 prompt + 监听 runtime 广播的 tool_call_end 事件，验证真实 extension
 * 返回的 __gui__ GuiComponent 格式（这是 real 轨独有的协议契约验证）。
 *
 * UI drawer 渲染部分由 mock 轨覆盖（tasks-drawer.spec.ts）。
 */
test('R2: 真实 todo tool 调用 → 协议格式含 __gui__ list-tree', async () => {
  test.setTimeout(180_000) // LLM 慢，3 分钟
  const dataDir = makePresetDataDir()
  const { page, cleanup } = await launchRealApp({ dataDir })
  try {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
    const port = await waitForRuntime(dataDir, 30_000)
    const sessionId = await createAndActivateSession(port)

    // 连第二个 WS 专门监听广播事件（第一个 WS 被 wsRoundTrip 用了）
    const listenWs: WebSocket = await new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}`)
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    const events: any[] = []
    listenWs.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString())
        // 只收广播事件（无 id），不收 reply
        if (!m.id) events.push(m)
      } catch { /* ignore */ }
    })

    // WS 发 prompt（强引导 todo tool）
    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'r2-send',
      payload: { sessionId, content: '请用 todo tool 把这三个步骤加进任务清单：1. 分析根因 2. 修复代码 3. 验证修复。必须调用 todo tool。' },
    }, 'r2-send', 30_000)

    // 等模型响应 + tool 调用（最多 120s）
    // 匹配策略：先找 tool_call_start(toolName=todo)，再取其后第一个 tool_call_end
    const deadline = Date.now() + 120_000
    let todoToolEnd: any = undefined
    while (Date.now() < deadline) {
      const startIdx = events.findIndex(
        (e) => e.type === 'message.tool_call_start' && /todo/i.test(e.payload?.toolName ?? ''),
      )
      if (startIdx >= 0) {
        const endEvt = events.find(
          (e, i) => i > startIdx && e.type === 'message.tool_call_end',
        )
        if (endEvt) {
          todoToolEnd = endEvt
          break
        }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }

    listenWs.close()

    if (!todoToolEnd) {
      // flaky 容忍：模型未调 todo tool。记录诊断信息。
      const runtimeLogs = readRuntimeLogs(dataDir)
      const toolEvents = events.filter((e) => e.type?.includes('tool_call')).map((e) => ({ type: e.type, toolName: e.payload?.toolName }))
      fs.writeFileSync('/tmp/r2-diag.json', JSON.stringify({
        eventCount: events.length,
        eventTypes: events.map((e) => e.type),
        toolEvents,
        runtimeLogsTail: runtimeLogs.slice(-3000),
      }, null, 2))
      console.log(`[R2] 模型未调 todo tool（events=${events.length}），diag → /tmp/r2-diag.json`)
      test.skip(true, '模型未调用 todo tool（flaky，见 /tmp/r2-diag.json）')
      return
    }

    // 协议契约断言：todo tool result 含 details.__gui__（list-tree GuiComponent）
    const payload = todoToolEnd.payload
    const details = payload.details
    // 诊断：dump 完整 tool_call_end payload 供协议分析
    fs.writeFileSync('/tmp/r2-tool-end.json', JSON.stringify(todoToolEnd, null, 2))

    // details.todos 原始数组（TasksPanel 渲染主数据源，含 isVerification + 准确三态）
    const todos = details.todos
    expect(Array.isArray(todos), 'details.todos 应为数组（TasksPanel 渲染数据源）').toBe(true)
    expect(todos.length, '至少 1 个 todo').toBeGreaterThan(0)
    expect(todos[0].id, 'todos item 应有 id').toBeDefined()
    expect(todos[0].text, 'todos item 应有 text').toBeDefined()
    expect(['pending', 'in_progress', 'completed', 'cancelled']).toContain(todos[0].status)

    // details.__gui__ GuiComponent（SideDrawer 根据 hasData 决定显隐）
    // 真实格式：{ v: 1, component: { type, props } }（有 v+component 包装层）
    const guiWrapper = details.__gui__
    expect(guiWrapper, 'todo tool result 应含 details.__gui__').toBeDefined()
    const gui = guiWrapper.component ?? guiWrapper  // 兼容有/无包装层
    expect(gui.type, `__gui__.component.type 应为 list-tree，实际 ${guiWrapper.component ? '有包装层' : '无包装层'}`).toBe('list-tree')
    const guiItems = gui.props?.items
    expect(Array.isArray(guiItems), 'list-tree props.items 应为数组').toBe(true)
    console.log(`[R2] todo tool 协议契约验证通过：todos=${todos.length} 项，gui type=${gui.type}，wrapper v=${guiWrapper.v}`)
    console.log(`[R2] 注意：真实 __gui__ 格式为 { v:1, component: GuiComponent }（有包装层），list-tree items 用 label/icon 非 text/status`)
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ── R3: 真实 goal_control 调用 → 验证 goal 协议格式（__gui__ card）（LLM，flaky） ─

test('R3: 真实 goal_control create → 协议格式含 __gui__ card', async () => {
  test.setTimeout(180_000)
  const dataDir = makePresetDataDir()
  const { page, cleanup } = await launchRealApp({ dataDir })
  try {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
    const port = await waitForRuntime(dataDir, 30_000)
    const sessionId = await createAndActivateSession(port)

    const listenWs: WebSocket = await new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}`)
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    const events: any[] = []
    listenWs.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString())
        if (!m.id) events.push(m)
      } catch { /* ignore */ }
    })

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'r3-send',
      payload: { sessionId, content: '请用 goal_control tool 创建一个 goal：追踪「优化登录性能」，slug 用 optimize-login-perf。必须调用 goal_control tool。' },
    }, 'r3-send', 30_000)

    const deadline = Date.now() + 120_000
    let goalToolEnd: any = undefined
    while (Date.now() < deadline) {
      const startIdx = events.findIndex(
        (e) => e.type === 'message.tool_call_start' && /goal/i.test(e.payload?.toolName ?? ''),
      )
      if (startIdx >= 0) {
        const endEvt = events.find(
          (e, i) => i > startIdx && e.type === 'message.tool_call_end',
        )
        if (endEvt) {
          goalToolEnd = endEvt
          break
        }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }

    listenWs.close()

    if (!goalToolEnd) {
      const runtimeLogs = readRuntimeLogs(dataDir)
      const toolEvents = events.filter((e) => e.type?.includes('tool_call')).map((e) => ({ type: e.type, toolName: e.payload?.toolName }))
      fs.writeFileSync('/tmp/r3-diag.json', JSON.stringify({
        eventCount: events.length,
        eventTypes: [...new Set(events.map((e) => e.type))],
        toolEvents,
        runtimeLogsTail: runtimeLogs.slice(-3000),
      }, null, 2))
      console.log(`[R3] 模型未调 goal_control tool（events=${events.length}），diag → /tmp/r3-diag.json`)
      test.skip(true, '模型未调用 goal_control tool（flaky，见 /tmp/r3-diag.json）')
      return
    }

    // 协议契约断言：goal_control tool result 含 details.__gui__（card GuiComponent）
    const payload = goalToolEnd.payload
    const details = payload.details
    // 诊断：dump 完整 payload
    fs.writeFileSync('/tmp/r3-tool-end.json', JSON.stringify(goalToolEnd, null, 2))
    const guiWrapper = details.__gui__
    expect(guiWrapper, 'goal_control tool result 应含 details.__gui__').toBeDefined()
    const gui = guiWrapper.component ?? guiWrapper
    // card 或 stats-line GuiComponent（goal extension buildGoalCard 产出）
    expect(['card', 'stats-line']).toContain(gui.type)

    // goal slug 契约（GoalCard.displaySlug 来源）
    const slug = details.slug
    if (slug) {
      console.log(`[R3] goal_control 协议契约验证通过，slug=${slug}, gui.type=${gui.type}`)
    } else {
      console.log(`[R3] goal_control tool result 无 details.slug，但 __gui__ ${gui.type} OK`)
    }
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
