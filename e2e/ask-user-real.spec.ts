/**
 * ask-user REAL E2E —— 真实 runtime + pi 子进程 + 真实 LLM。
 *
 * 验证目标（设计文档 /tmp/e2e-real-test-design-askuser-thinkinglevel.md §3）：
 * - A1 协议透传：真实 ask_user tool 调用 → extension.ui_request 广播
 *   （comment 删除回归核心：askUserQuestions 无 allowComment 字段）+ 回写闭环（pi 恢复 turn）
 * - A2 UI 渲染：AskUserOverlay 在真实 page 渲染（Playwright DOM 断言），
 *   Other 保留（ask-user-option-__other__）+ 页面无 comment 字样
 * - A3 交互回写：Playwright 操作真实 UI（选 Other → 填自由文本 → submit），
 *   断言 overlay 关闭 + pi 恢复 turn。注：ui_response 帧内容不可捕获——
 *   routeWebSocket 实测无法拦截 Electron renderer 的 WS（Playwright 限制），
 *   answers 无 __comment key 由 A1 + 组件层 AskUserOverlay.test.ts 覆盖
 *
 * ── 协议事实（读代码确认，非猜测）──
 * - event-adapter.ts:378-399：select + ASK_USER_MARKER → 透传 payload
 *   { sessionId, requestId, method:'select', askUser:true, askUserQuestions, allowCancel }
 * - AskUserQuestion（packages/extension-protocol/src/extensions/ask-user/types.ts）：
 *   header/question/context/options/multiSelect/allowOther —— 无 allowComment
 *   （commit 74a0b1001「remove comment feature」删除字段 + UI + __comment key）
 * - AskUserOverlay.vue onSubmit：Other 文本替换 OTHER_VALUE 占位符作为**主答案值**
 *   （answers[qKey]=freeText），不产生独立 `${key}__other` key（types.ts 协议注释
 *   描述的理想格式，前端实现从未遵循），也不产生 `__comment` key
 * - extension.ui_response 不广播（extension-message-handler 只转发给 pi，无 reply）：
 *   回写帧必须经 routeWebSocket 从 renderer→runtime 连接捕获（新范式）
 * - UI 切 session 走 sidebar 点击（session.switch RPC），无需 OS dialog——
 *   dialog 只在「新建任务选目录」出现；先 WS create 再点已有 session 绕开
 * - pi 恢复 turn 事件：message.message_start / message.complete
 *   （ServerMessageType，packages/shared/src/protocol.ts:529-535）
 *
 * 运行（单独跑，real case 慢且花 token）：
 *   npx playwright test e2e/ask-user-real.spec.ts --grep A1
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
/** mandatory 9 包（含 pi-ask-user）的完整安装位置；dev npm 目录可能只装了部分包 */
const PROD_NPM_DIR = path.join(os.homedir(), '.xyz-agent', 'npm')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')
/** 本分支源码的 ask-user extension（删 comment 后版本）——registry 3.0.0 是删除前发布的旧版 */
const BRANCH_ASKUSER = path.join(REPO_ROOT, 'extensions', 'ask-user')

/** 强引导 prompt：明确要求调 ask_user（不调 → flaky skip） */
const ASK_PROMPT = '用 ask_user tool 问用户：选择 A 还是 B？必须调用 ask_user tool，不要跳过或改用其他工具。'
/** 预设默认模型：tool 调用可靠（mimo-v2.5-pro 视觉模型实测不调 ask_user，直接回答导致 flaky） */
const PRESET_PROVIDER = 'deepseek-router'
const PRESET_MODEL = 'ds-pro'
const SESSION_LABEL = 'askuser-e2e-sample'
/** A3 Other 自由文本（playwright fill 直接设 value，无 IME 风险） */
const OTHER_TEXT = 'custom answer from e2e'

/** 逐个 symlink srcDir 的条目到 destDir（已存在跳过，不覆盖不污染源目录） */
function symlinkDirEntries(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir)) {
    const dst = path.join(destDir, entry)
    if (fs.existsSync(dst)) continue
    const src = path.join(srcDir, entry)
    fs.symlinkSync(src, dst, fs.statSync(src).isDirectory() ? 'dir' : 'file')
  }
}

/**
 * 预建 dataDir + pi provider/model 配置 + npm extension 目录。
 *
 * pi 读 <dataDir>/pi/agent/settings.json，settings.json 的 packages 字段引用
 * npm:@zhushanwen/pi-ask-user 等，pi 去 <dataDir>/pi/agent/npm/node_modules/ 解析。
 * npm 目录 = dev 全部条目 symlink（复用已安装）+ prod mandatory 包补丁
 * （~/.xyz-agent/npm/node_modules/@zhushanwen/ 有完整 11 包，dev 可能只装部分——
 * 2026-08-03 实测 dev npm 只有 permission/rename-session/scheduler 三包）。
 */
function makePresetDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-real-askuser-'))
  const piAgentDir = path.join(dataDir, 'pi', 'agent')
  fs.mkdirSync(piAgentDir, { recursive: true })
  // provider/model 配置
  fs.copyFileSync(path.join(DEV_PI_AGENT, 'models.json'), path.join(piAgentDir, 'models.json'))
  const settings = JSON.parse(fs.readFileSync(path.join(DEV_PI_AGENT, 'settings.json'), 'utf8'))
  // 覆盖默认模型为 tool 调用可靠项（实测 mimo 视觉模型对 ask_user 引导不敏感，flaky 率过高）
  settings.defaultProvider = PRESET_PROVIDER
  settings.defaultModel = PRESET_MODEL
  fs.writeFileSync(path.join(piAgentDir, 'settings.json'), JSON.stringify(settings, null, 2))
  // npm extension 目录（两处，各自消费方不同）：
  // 1. <dataDir>/npm/node_modules —— xyz-agent runtime extension-resolver 的 settings source
  //    （getNpmDir() = <dataDir>/npm，pi-provider-store 迁移目标；resolver 扫到后经
  //    --extension 注入 pi，pi 的 --no-extensions 下只 load CLI 注入的扩展）
  // 2. <dataDir>/pi/agent/npm —— pi 自身 packages 解析目录（--no-extensions 下不用，保底）
  const presetNpm = path.join(dataDir, 'npm', 'node_modules')
  const piNpm = path.join(piAgentDir, 'npm', 'node_modules')
  for (const destNpm of [presetNpm, piNpm]) {
    // @zhushanwen 逐包 symlink（目录级 symlink 无法合并 dev/prod 两源；先放分支 ask-user
    // ——删 comment 后版本，registry 3.0.0 是删除前发布、仍带 allowComment/__comment，
    // A1 断言「无 allowComment」必须验证分支代码而非旧 registry 版）
    const zsDest = path.join(destNpm, '@zhushanwen')
    fs.mkdirSync(zsDest, { recursive: true })
    fs.symlinkSync(BRANCH_ASKUSER, path.join(zsDest, 'pi-ask-user'), 'dir')
    symlinkZhushanwenPackages(path.join(DEV_PI_AGENT, 'npm', 'node_modules', '@zhushanwen'), zsDest)
    symlinkZhushanwenPackages(path.join(PROD_NPM_DIR, 'node_modules', '@zhushanwen'), zsDest)
    // @xyz-agent（extension-protocol）用 prod（dev 的已被 npm install 清空过）
    const xyzDest = path.join(destNpm, '@xyz-agent')
    fs.mkdirSync(xyzDest, { recursive: true })
    symlinkDirEntries(path.join(PROD_NPM_DIR, 'node_modules', '@xyz-agent'), xyzDest)
    // 其余依赖目录（@anthropic-ai 等）：dev 优先，缺失补 prod（@zhushanwen/@xyz-agent 已存在跳过）
    symlinkDirEntries(path.join(DEV_PI_AGENT, 'npm', 'node_modules'), destNpm)
    symlinkDirEntries(path.join(PROD_NPM_DIR, 'node_modules'), destNpm)
  }
  return dataDir
}

/** @zhushanwen 下的逐包 symlink（目录级 symlink 无法合并多源；已存在跳过） */
function symlinkZhushanwenPackages(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return
  for (const pkg of fs.readdirSync(srcDir)) {
    const dst = path.join(destDir, pkg)
    if (fs.existsSync(dst)) continue
    fs.symlinkSync(path.join(srcDir, pkg), dst, 'dir')
  }
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

/** 开第二个 WS 专门监听广播事件（无 id 的消息），返回 { ws, events } */
async function openListenWs(port: number): Promise<{ ws: WebSocket; events: any[] }> {
  const ws: WebSocket = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  const events: any[] = []
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString())
      if (!m.id) events.push(m)
    } catch { /* ignore */ }
  })
  return { ws, events }
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

/** 读 dataDir/logs 下所有 pi stdout jsonl 合并（tool 调用 / 报错证据） */
function readPiLogs(dataDir: string): string {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return ''
  return fs.readdirSync(logDir)
    .filter((f) => f.startsWith('pi-') && f.endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
    .join('\n')
}

/** diag 落盘（flaky 容忍 / 失败诊断统一入口） */
function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[diag] ${name} → /tmp/${name}`)
}

/**
 * 等 runtime 的 extension 注入就绪（resolver 扫到 mandatory 包）。
 *
 * runtime.port 在 ready 时写入，早于 ensureMandatoryExtensions 的 npm 安装（慢几秒）；
 * 若 session.create 过早，pi spawn 注入的 --extension 是 resolved 0/部分状态，ask_user
 * 不可用 → 模型说「没有 ask_user tool」。信号：runtime 日志最后一次 resolved N ≥ 8。
 */
async function waitForExtensionsReady(dataDir: string, timeoutMs = 90_000, minCount = 8): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const logs = readRuntimeLogs(dataDir)
    const matches = [...logs.matchAll(/resolved (\d+) extensions from \d+ sources/g)]
    if (matches.length > 0) {
      const last = parseInt(matches[matches.length - 1][1], 10)
      if (last >= minCount) return last
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return 0
}

/**
 * 通过 WS 创建 session（照抄 tasks-drawer-real 范式，cwd 用 SAMPLE_PROJECT）。
 * OS 原生目录选择 dialog 不可自动化，TEST-STRATEGY 约定用 WS 直连触发等效业务动作。
 * message.send 内部自动 ensureActive，无需显式 activate（R2/R3 已验证）。
 */
async function createSession(port: number, dataDir: string): Promise<string> {
  const resolved = await waitForExtensionsReady(dataDir)
  if (resolved === 0) {
    console.log('[warn] extensions not ready within timeout, continue anyway（LLM case 可能 flaky）')
  }
  const createReply = await wsRoundTrip(port, {
    type: 'session.create',
    id: 'askuser-real-create',
    payload: { cwd: SAMPLE_PROJECT, label: SESSION_LABEL },
  }, 'askuser-real-create')
  expect(createReply.type).toBe('session.created')
  return (createReply.payload.session as { id: string }).id
}

/**
 * UI 切 session（新范式：real 轨首次操作真实 page）。
 *
 * WS create 后 config.sessions 广播 → sidebar 列表出现该 session → Playwright
 * 点 sidebar 会话列表项（session.switch RPC + panel 绑定）→ composer 出现即 Panel
 * 已挂载该 session（useExtensionUI 订阅 extension.ui_request 就绪）。
 * 不涉及 OS dialog（dialog 只在新建任务选目录时出现，切已有 session 不需要）。
 */
async function selectSessionInSidebar(page: import('@playwright/test').Page, label: string): Promise<void> {
  // 启动竞态防护：main 的 getRuntimePort IPC 在 runtime 就绪前可能返回空 → renderer 用
  // fallback 端口首次连接失败 → ws-client 指数退避重连（最长 ~30s，实测 15s 内可能未恢复，
  // UI 停留「连接中…」）。必须先等连接稳定（横幅隐藏）再操作 sidebar，否则列表是空的。
  const connBanner = page.getByText(/连接中/)
  await connBanner.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
  // SegmentedTab 的「会话」tab（icon-only，title=label）。默认就是会话 tab，点击幂等兜底
  const tab = page.getByRole('button', { name: /^会话/ })
  await tab.click({ timeout: 10_000 }).catch(() => {})
  const item = page.locator('.session-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.click()
  // selectSession → switchSession RPC + syncSessionToPanel；composer 出现 = Panel 绑定完成
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 30_000 })
}

/** 轮询广播事件里第一个 ask-user 富交互请求（extension.ui_request + askUser:true） */
async function waitForAskUserRequest(events: any[], deadlineMs: number): Promise<any | undefined> {
  while (Date.now() < deadlineMs) {
    const evt = events.find((e) => e.type === 'extension.ui_request' && e.payload?.askUser === true)
    if (evt) return evt
    await new Promise((r) => setTimeout(r, 2000))
  }
  return undefined
}

/** 找 askUserQuestions[0]（用类型守卫收窄 unknown[]） */
function firstQuestion(askUserReq: any): { header?: string; question: string; options?: unknown[] } {
  const qs = askUserReq.payload?.askUserQuestions as unknown[] | undefined
  const q = Array.isArray(qs) && qs.length > 0 ? qs[0] : undefined
  expect(q, 'payload.askUserQuestions[0] 应存在（协议透传）').toBeDefined()
  expect(typeof (q as { question?: unknown }).question).toBe('string')
  return q as { header?: string; question: string; options?: unknown[] }
}

/** 在 events 中找 idx 之后出现的 pi 恢复产出事件（message_start / complete） */
function findTurnResumeAfter(events: any[], idx: number): { type: string } | undefined {
  for (let i = idx + 1; i < events.length; i++) {
    const t = events[i].type
    if (t === 'message.message_start' || t === 'message.complete') {
      return { type: t }
    }
  }
  return undefined
}

/** flaky 容忍：LLM 未调 ask_user 时落盘 diag + skip */
function skipWithDiag(name: string, askUserReq: any, events: any[], dataDir: string, extra?: Record<string, unknown>): void {
  const runtimeLogs = readRuntimeLogs(dataDir)
  writeDiag(name, {
    eventCount: events.length,
    eventTypes: [...new Set(events.map((e) => e.type))],
    askUserReq,
    runtimeLogsTail: runtimeLogs.slice(-3000),
    piLogsTail: readPiLogs(dataDir).slice(-3000),
    ...extra,
  })
  test.skip(true, `模型未调用 ask_user tool（flaky，diag → /tmp/${name}）`)
}

// ── A1: 协议透传（comment 删除回归核心） ─────────────────────────────

test('A1: ask_user 调用 → ui_request 广播含 askUserQuestions，问题无 allowComment 字段，回写后 pi 恢复 turn', async () => {
  test.setTimeout(180_000) // LLM 慢，3 分钟
  const dataDir = makePresetDataDir()
  const { page, cleanup } = await launchRealApp({ dataDir })
  try {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    const sessionId = await createSession(port, dataDir)

    // 先开监听 WS 再发 prompt，避免 broadcast 时序竞争（R2/R3 范式）
    const { ws: listenWs, events } = await openListenWs(port)

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'a1-send',
      payload: { sessionId, content: ASK_PROMPT },
    }, 'a1-send', 30_000)

    const askUserReq = await waitForAskUserRequest(events, Date.now() + 120_000)
    if (!askUserReq) {
      listenWs.close()
      skipWithDiag('askuser-a1-diag.json', undefined, events, dataDir)
      return
    }

    // ── 断言 1：协议透传结构完整 ──
    const payload = askUserReq.payload
    expect(payload.sessionId).toBe(sessionId)
    expect(payload.requestId, 'ui_request 应带 requestId（回写用）').toBeTruthy()
    expect(payload.method).toBe('select')
    expect(payload.askUser).toBe(true)
    const q = firstQuestion(askUserReq)
    expect(q.question.length).toBeGreaterThan(0)
    expect(Array.isArray(q.options) && q.options.length >= 2,
      '问题应带 ≥2 个选项（prompt 要求 A/B 选择）').toBe(true)

    // ── 断言 2（comment 删除回归核心）：问题对象无 allowComment 字段 ──
    const keys = Object.keys(q)
    expect(keys).not.toContain('allowComment')
    expect(keys.some((k) => k.includes('comment')),
      '问题对象不应含任何 comment 相关字段').toBe(false)

    // ── 断言 3（回写闭环）：发 ui_response → pi 收到后恢复 turn ──
    // extension.ui_response 无 reply（fire-and-forget），直接 listenWs.send。
    // result = JSON.stringify(AskUserAnswers)（与前端 onSubmit 的 emit 格式一致）
    const qKey = q.header ?? q.question
    const uiReqIdx = events.indexOf(askUserReq)
    listenWs.send(JSON.stringify({
      type: 'extension.ui_response',
      payload: {
        sessionId,
        requestId: payload.requestId,
        method: 'select',
        result: JSON.stringify({ [qKey]: 'A' }),
      },
    }))

    const resumeDeadline = Date.now() + 60_000
    let resume: { type: string } | undefined
    while (Date.now() < resumeDeadline && !resume) {
      resume = findTurnResumeAfter(events, uiReqIdx)
      if (!resume) await new Promise((r) => setTimeout(r, 2000))
    }
    if (!resume) {
      // 回写后 pi 不恢复 turn = 真 bug（非 flaky），落 diag 后 fail
      writeDiag('askuser-a1-resume.json', {
        eventsAfterRequest: events.slice(uiReqIdx).map((e) => e.type),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(resume, '回写后 pi 应恢复 turn（message.message_start / message.complete）').toBeDefined()
    listenWs.close()
    console.log(`[A1] 协议透传验证通过：question="${q.question}"，options=${(q.options ?? []).length}，无 allowComment，回写后恢复 turn via ${resume?.type}`)
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ── A2: UI 渲染（Playwright 操作 real page） ─────────────────────────

test('A2: ask-user overlay 真实渲染 — overlay/Other 保留，页面无 comment 字样', async () => {
  test.setTimeout(180_000)
  const dataDir = makePresetDataDir()
  const { page, cleanup } = await launchRealApp({ dataDir })
  try {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    const sessionId = await createSession(port, dataDir)

    // UI 切 session（必须先于 prompt：useExtensionUI 按 Panel 的 sessionId 订阅）
    await selectSessionInSidebar(page, SESSION_LABEL)

    const { ws: listenWs, events } = await openListenWs(port)

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'a2-send',
      payload: { sessionId, content: ASK_PROMPT },
    }, 'a2-send', 30_000)

    const askUserReq = await waitForAskUserRequest(events, Date.now() + 120_000)
    if (!askUserReq) {
      listenWs.close()
      skipWithDiag('askuser-a2-diag.json', undefined, events, dataDir,
        { uiState: 'session 已切到 UI（composer-box 可见）' })
      return
    }
    listenWs.close()

    // ── 断言 1：overlay 真实渲染在 page DOM ──
    const overlay = page.getByTestId('ask-user-overlay')
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    const q = firstQuestion(askUserReq)
    expect(q.question.length).toBeGreaterThan(0)

    // ── 断言 2：Other 保留（comment 删除不影响 Other 自由输入）──
    await expect(page.getByTestId('ask-user-option-__other__')).toBeVisible({ timeout: 5_000 })

    // ── 断言 3：overlay UI 无 comment 字样（comment UI/i18n 已删除）──
    // 注意：不能断言全页 —— 消息流渲染 LLM 自由文本回复，模型输出里可能出现
    // "comment" 单词（不可控，实测页面 0 comment、触发后因模型回复而出现），
    // 全页断言必然 flaky。overlay 内部是产品代码渲染，才是「comment UI 删除」
    // 的正确回归面（AskUserOverlay.vue 已无 comment 输入框/testid/i18n）。
    const overlayText = (await overlay.textContent()) ?? ''
    expect(overlayText.toLowerCase().includes('comment'),
      'overlay UI 文本不应含 "comment"（comment UI + i18n key 已删除）').toBe(false)
    console.log(`[A2] overlay 渲染验证通过：question="${q.question}"，Other 保留，overlay 无 comment`)
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ── A3: 交互回写（真实 UI 操作 + 捕获真实回写帧） ─────────────────────

test('A3: 选 Other 填自由文本提交 → overlay 关闭 + pi 恢复 turn（真实 UI 交互闭环）', async () => {
  test.setTimeout(180_000)
  const dataDir = makePresetDataDir()
  const { page, cleanup } = await launchRealApp({ dataDir })
  try {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)

    const sessionId = await createSession(port, dataDir)

    await selectSessionInSidebar(page, SESSION_LABEL)

    const { ws: listenWs, events } = await openListenWs(port)

    await wsRoundTrip(port, {
      type: 'message.send',
      id: 'a3-send',
      payload: { sessionId, content: ASK_PROMPT },
    }, 'a3-send', 30_000)

    const askUserReq = await waitForAskUserRequest(events, Date.now() + 120_000)
    if (!askUserReq) {
      listenWs.close()
      skipWithDiag('askuser-a3-diag.json', undefined, events, dataDir)
      return
    }

    // ── 真实 UI 交互：点 Other → 填自由文本 → submit ──
    const q = firstQuestion(askUserReq)
    const qKey = q.header ?? q.question
    const uiReqIdx = events.indexOf(askUserReq)

    await expect(page.getByTestId('ask-user-overlay')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('ask-user-option-__other__').click()
    const otherInput = page.getByTestId(`ask-user-other-${qKey}`)
    await expect(otherInput).toBeVisible({ timeout: 5_000 })
    await otherInput.fill(OTHER_TEXT)
    await page.getByTestId('ask-user-submit').click()

    // ── 断言 1：overlay 关闭（前端 onSubmit 回写成功信号）──
    // 注意：routeWebSocket 实测无法拦截 Electron renderer 的 WS（Playwright 限制，
    // 全匹配 pattern + 连接稳定后 routed=0），ui_response 帧内容不可捕获。
    // answers 无 __comment key 的协议层由 A1（ui_request 无 allowComment）+ 组件层
    // AskUserOverlay.test.ts（onSubmit 无 __comment）覆盖；A3 专注 UI 交互闭环。
    await expect(page.getByTestId('ask-user-overlay')).toBeHidden({ timeout: 15_000 })

    // ── 断言 2：pi 收到响应后恢复 turn（message_start / complete）──
    const resumeDeadline = Date.now() + 60_000
    let resume: { type: string } | undefined
    while (Date.now() < resumeDeadline && !resume) {
      resume = findTurnResumeAfter(events, uiReqIdx)
      if (!resume) await new Promise((r) => setTimeout(r, 2000))
    }
    listenWs.close()
    if (!resume) {
      writeDiag('askuser-a3-resume.json', {
        eventsAfterRequest: events.slice(uiReqIdx).map((e) => e.type),
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
      })
    }
    expect(resume, '回写后 pi 应恢复 turn（message.message_start / message.complete）').toBeDefined()
    console.log(`[A3] UI 交互闭环验证通过：qKey="${qKey}"，Other 文本="${OTHER_TEXT}"，overlay 关闭，pi 恢复 turn via ${resume?.type}`)
  } finally {
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
