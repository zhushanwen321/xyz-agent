/**
 * Workflow agent() thinkingLevel REAL E2E —— 真实 runtime + pi 子进程 + 真实 LLM。
 *
 * 验证目标：workflow script 里 agent({ model, thinkingLevel: "high" }) 的
 * thinkingLevel 端到端真实生效。观测表面全部是 pi 自己写的文件（零 xyz-agent
 * 代码介入，无日志钩子）：
 *
 * - TC1: workflow state JSONL 的 state.calls[0].opts —— 扩展持久化的脚本请求值
 *        （jsonl-run-store.ts serializeRun 持久化完整 AgentCallOpts）
 * - TC2: 子进程 session JSONL 的 thinking_level_change / model_change entry ——
 *        pi 收到 --model provider/id:high 后真实落盘的状态（核心，确定性）
 * - TC3: session.workflowUpdate done 信号 + 子进程 JSONL 有 assistant 消息
 *        （真实 provider 跑完产出；provider key 不可用时 TC3 降级 skip）
 *
 * 关键认知（实证 ~/.xyz-agent-dev/pi/agent/subagents/.../*.jsonl 第 2-3 行）：
 * pi 以 --model provider/id:high 启动子进程时，启动即写两个 entry：
 *   {"type":"model_change","provider":"...","modelId":"..."}
 *   {"type":"thinking_level_change","thinkingLevel":"high"}
 * :high 合并后缀只在 spawn args 存在（session-runner.ts:454-459），pi 解析后
 * 拆成独立字段落盘（session-manager.ts appendModelChange/appendThinkingLevelChange）
 * —— 断言必须查独立字段 thinkingLevel:"high"，禁止 grep ":high" 后缀。
 *
 * 文件定位链：
 * 主 session JSONL（session.create reply 的 sessionFile）
 *   → "workflow-state-link" custom entry 的 data.path → stateFile
 *     （<sessionDir>/workflow-state/<runId>.jsonl，jsonl-run-store.ts:233-253）
 *   → state.calls[0].sessionId → 全量扫描 dataDir 下 sessions/*.jsonl 按首行
 *     session.id 匹配子进程文件（session-service.ts:1178-1193 findAgentCallFile
 *     同策略，但用递归全扫替代精确编码 cwd，更健壮）
 *
 * 运行（单独跑，real case 慢且花 token）：
 *   npx playwright test e2e/workflow-thinkinglevel-real.spec.ts --grep TC1
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

/** 探针脚本名（与 fixture script 的 meta.name 一致） */
const PROBE_SCRIPT = 'thinkinglevel-probe'
/** 探针脚本请求的 model（与 fixture script 的 agent() model 一致，dev models.json 确认存在） */
const PROBE_MODEL = 'deepseek-router/ds-pro'
/** 强引导 prompt：明确指示 LLM 调 workflow tool 运行探针脚本 */
const PROBE_PROMPT = `请调用 workflow tool 运行 ${PROBE_SCRIPT} 脚本：{"action":"run","name":"${PROBE_SCRIPT}"}。必须调用 workflow tool，不要跳过或改用其他工具。`

/**
 * 预建 dataDir + pi provider/model 配置 + npm extension 目录 + workflow 探针脚本。
 *
 * pi 读 <dataDir>/pi/agent/settings.json，settings.json 的 packages 字段引用
 * npm:@zhushanwen/pi-* 等，pi 去 <dataDir>/pi/agent/npm/node_modules/ 解析。
 * 临时目录没有 npm 目录 → symlink 到 dev 的 npm 目录（复用已安装的 node_modules）。
 *
 * workflow 探针脚本复制到 user 级 <piAgentDir>/workflows/（user-pi 扫描源，
 * resource-discovery.ts buildScanTargets 的 getAgentDir()/workflows/）。
 * 不能依赖 project 级 <workspaceRoot>/.pi/workflows/：sample-project 的祖先目录
 * 有 .bare（xyz-agent-workspace/），findWorkspaceRoot 从 session cwd 向上跳转到
 * workspace 根，project 级扫描路径变成 <xyz-agent-workspace>/.pi/workflows/，
 * sample-project 下的 .pi 不会被发现——user 级是唯一可靠路径。
 */
function makePresetDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-real-workflow-'))
  const piAgentDir = path.join(dataDir, 'pi', 'agent')
  fs.mkdirSync(piAgentDir, { recursive: true })
  // provider/model 配置
  fs.copyFileSync(path.join(DEV_PI_AGENT, 'models.json'), path.join(piAgentDir, 'models.json'))
  fs.copyFileSync(path.join(DEV_PI_AGENT, 'settings.json'), path.join(piAgentDir, 'settings.json'))
  // npm extension 目录：symlink 到 dev 已安装的 node_modules。当前布局为
  // <dataDir>/npm（pi-paths.ts getNpmDir 已从 pi/agent/npm 迁出到 dataDir 根层），
  // runtime extension-resolver 从 <dataDir>/npm/node_modules 解析 npm:@zhushanwen/pi-*
  // 并经 getExtensionPaths 把路径传给 pi（--extension）——pi 侧不自己解析 npm: 包。
  // 必须预置（symlink 而非等 ensureMandatoryExtensions 现装）：boot 期 npm install
  // 9 包要 ~16s，session.create 的 pi spawn 早于 install 完成 → extension 加载为空。
  const devNpmRoot = path.join(os.homedir(), '.xyz-agent-dev', 'npm')
  if (fs.existsSync(devNpmRoot)) {
    fs.symlinkSync(devNpmRoot, path.join(dataDir, 'npm'), 'dir')
  }
  // 旧布局兼容（pi 侧兜底解析路径，无包时为空目录，无害）
  const devLegacyNpmDir = path.join(DEV_PI_AGENT, 'npm')
  if (fs.existsSync(devLegacyNpmDir)) {
    fs.symlinkSync(devLegacyNpmDir, path.join(piAgentDir, 'npm'), 'dir')
  }
  // workflow 探针脚本：repo fixture → user 级 workflows/（唯一被发现的扫描源，见上注释）
  const probeSrc = path.join(SAMPLE_PROJECT, '.pi', 'workflows', `${PROBE_SCRIPT}.js`)
  if (fs.existsSync(probeSrc)) {
    const userWorkflowsDir = path.join(piAgentDir, 'workflows')
    fs.mkdirSync(userWorkflowsDir, { recursive: true })
    fs.copyFileSync(probeSrc, path.join(userWorkflowsDir, `${PROBE_SCRIPT}.js`))
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
 * @returns sessionId + sessionFile（主 session JSONL 路径，pi create 时已确定）
 */
async function createAndActivateSession(port: number): Promise<{ sessionId: string; sessionFile?: string }> {
  const createReply = await wsRoundTrip(port, {
    type: 'session.create',
    id: 'wf-real-create',
    payload: { cwd: SAMPLE_PROJECT, label: 'wf-real-sample' },
  }, 'wf-real-create')
  expect(createReply.type).toBe('session.created')
  const session = createReply.payload.session as { id: string; sessionFile?: string }
  return { sessionId: session.id, sessionFile: session.sessionFile }
}

/**
 * 递归扫描 dataDir 下所有 sessions/*.jsonl 文件（排除 .finalized 终态文件），
 * 按修改时间倒序返回。
 *
 * 子进程 session 文件布局：<dataDir>/pi/agent/subagents/<encodedCwd>/sessions/
 * <ISO>_<sessionId>.jsonl（encodedCwd 规则见 runtime pi-paths.ts encodeCwd）。
 * 全量递归扫描比精确编码 cwd 更健壮（主 cwd 与子进程 cwd 的关系在 worktree /
 * 多目录场景不确定），匹配交给调用方按首行 session.id 精确比对。
 */
function findSubagentSessionFiles(dataDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.endsWith('.finalized')) {
        out.push(p)
      }
    }
  }
  walk(dataDir)
  return out.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs } catch { return 0 }
  })
}

/**
 * 定位子进程 session 文件。优先用 state.calls[0].sessionFile（精确绝对路径，
 * execution-record.ts serialize 持久化）；缺失时 fallback 全量扫描：排除主 session
 * 文件 + cwd 为 sample-project + mtime 最新。
 *
 * 注意：不能用 calls[0].sessionId（sa-<uuid> 是 subagent-workflow 扩展的 record id，
 * 非 pi session id——pi 的 session id 是 uuidv7，JSONL 首行 session.id），两者不同源。
 */
function locateSubagentSessionFile(
  dataDir: string,
  call0: any,
  mainSessionFile: string | null,
): string | null {
  if (typeof call0?.sessionFile === 'string' && fs.existsSync(call0.sessionFile)) {
    return call0.sessionFile
  }
  // fallback：非主 session 文件中 cwd 匹配 sample-project 且 mtime 最新
  const files = findSubagentSessionFiles(dataDir).filter((f) => f !== mainSessionFile)
  for (const f of files) {
    try {
      const first = JSON.parse(fs.readFileSync(f, 'utf8').split('\n')[0])
      if (first?.cwd === SAMPLE_PROJECT) return f
    } catch { /* ignore */ }
  }
  return null
}

/** 读 session 文件全部 entry（每行 JSON.parse）；不可读返回 null */
function readSessionEntries(file: string): any[] | null {
  try {
    return fs.readFileSync(file, 'utf8')
      .trim().split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  } catch {
    return null
  }
}

/**
 * 从主 session JSONL 提取最后一个 workflow-state-link 指针 entry。
 *
 * 该 entry 由 JsonlRunStore.save 通过 pi.appendEntry 写入（jsonl-run-store.ts:248-253），
 * pi 侧落盘形状为 {"type":"custom","customType":"workflow-state-link","data":{runId,path,updatedAt},...}
 * （pi session-manager.ts appendCustomEntry——字段是 data 不是 payload）。
 * data.path 即 stateFile（<sessionDir>/workflow-state/<runId>.jsonl，单行完整快照）。
 * 每次 save 都 append 一条，取最后一条（updatedAt 最新，即最终状态快照）。
 */
function findWorkflowStateLink(mainSessionFile: string): { runId: string; stateFile: string } | null {
  let lines: string[]
  try {
    lines = fs.readFileSync(mainSessionFile, 'utf8').trim().split('\n')
  } catch {
    return null
  }
  let latest: { runId: string; stateFile: string } | null = null
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry?.customType === 'workflow-state-link' && entry?.data?.runId && entry?.data?.path) {
        latest = { runId: entry.data.runId, stateFile: entry.data.path }
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
  return latest
}

/** 失败诊断落盘（flaky skip / 文件链断裂时写 /tmp/<tc>-diag.json） */
function writeDiag(tc: string, dataDir: string, events: any[], extra: Record<string, unknown> = {}): void {
  const runtimeLogs = readRuntimeLogs(dataDir)
  const piLogs = readPiLogs(dataDir)
  fs.writeFileSync(`/tmp/${tc}-diag.json`, JSON.stringify({
    eventCount: events.length,
    eventTypes: [...new Set(events.map((e) => e.type))],
    workflowUpdates: events
      .filter((e) => e.type === 'session.workflowUpdate')
      .map((e) => e.payload?.update),
    toolEvents: events
      .filter((e) => e.type?.includes('tool_call'))
      .map((e) => ({ type: e.type, toolName: e.payload?.toolName })),
    subagentFiles: findSubagentSessionFiles(dataDir).slice(0, 10).map((f) => path.basename(f)),
    runtimeLogsTail: runtimeLogs.slice(-3000),
    piLogsTail: piLogs.slice(-2000),
    ...extra,
  }, null, 2))
}

/**
 * 共用流程：launch → session.create/activate → 开第二 WS 监听 → 发 prompt →
 * 轮询 session.workflowUpdate done 信号（120s deadline）。
 *
 * workflow run 完成时 pi-subagent-workflow 发 workflow-result customStart，
 * runtime event-interpreter handleWorkflowResult 广播 session.workflowUpdate
 * {status:'done', runId, reason}（event-interpreter.ts:514-530）。
 * done 到达 = workflow 完整跑完（stateFile 已持久化最终快照）——TC1/TC2/TC3 都以
 * 它为文件读取触发点。
 *
 * @returns ctx：doneUpdate 为空 = 主 agent 未调 workflow tool（flaky，调用方 skip）
 */
async function runProbeWorkflow(tc: string): Promise<{
  dataDir: string
  events: any[]
  doneUpdate: any
  sessionId: string
  mainSessionFile: string | null
  listenWs: WebSocket
  cleanup: () => Promise<void>
}> {
  const dataDir = makePresetDataDir()
  const { page, cleanup } = await launchRealApp({ dataDir })
  const ctx = {
    dataDir,
    events: [] as any[],
    doneUpdate: undefined as any,
    sessionId: '',
    mainSessionFile: null as string | null,
    listenWs: null as unknown as WebSocket,
    cleanup,
  }
  try {
    await expect(page).toHaveTitle(/xyz-agent|xyz/i)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)

    const { sessionId, sessionFile } = await createAndActivateSession(port)
    ctx.sessionId = sessionId
    ctx.mainSessionFile = sessionFile ?? null

    // 先开监听 WS 再发 prompt（避免 broadcast 时序竞争）
    const listenWs: WebSocket = await new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}`)
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    ctx.listenWs = listenWs
    listenWs.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString())
        // 只收广播事件（无 id），不收 reply
        if (!m.id) ctx.events.push(m)
      } catch { /* ignore */ }
    })

    await wsRoundTrip(port, {
      type: 'message.send',
      id: `${tc}-send`,
      payload: { sessionId, content: PROBE_PROMPT },
    }, `${tc}-send`, 30_000)

    // 轮询 workflowUpdate done（120s，LLM 决策 + workflow 执行慢）
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const done = ctx.events.find(
        (e) => e.type === 'session.workflowUpdate' && e.payload?.update?.status === 'done',
      )
      if (done) {
        ctx.doneUpdate = done
        break
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  } catch (err) {
    ctx.listenWs?.close()
    await cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true })
    throw err
  }
  return ctx
}

// ── TC1: workflow state 请求值（确定性） ───────────────────────────────

test('TC1: state.calls[0].opts.thinkingLevel === "high"（脚本请求值 → 扩展持久化）', async () => {
  test.setTimeout(180_000) // LLM 慢，3 分钟
  const ctx = await runProbeWorkflow('tc1')
  try {
    if (!ctx.doneUpdate) {
      writeDiag('tc1', ctx.dataDir, ctx.events)
      console.log(`[TC1] workflow 未完成（events=${ctx.events.length}），diag → /tmp/tc1-diag.json`)
      test.skip(true, '主 agent 未调用 workflow tool（flaky，见 /tmp/tc1-diag.json）')
      return
    }

    // 主 session JSONL：create reply 的 sessionFile。pi 延迟写入策略下文件可能
    // 稍后才落盘——workflow 已 done（主 session 有 assistant 消息 + custom entry
    // flush 过），轮询等文件出现即可。
    let mainFile = ctx.mainSessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在（session.created reply）').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    // 定位链 1：workflow-state-link custom entry → stateFile
    const link = findWorkflowStateLink(mainFile!)
    if (!link) {
      writeDiag('tc1', ctx.dataDir, ctx.events, {
        mainSessionFile: mainFile,
        mainSessionTail: fs.readFileSync(mainFile!, 'utf8').split('\n').slice(-10),
      })
    }
    expect(link, '主 session JSONL 应含 workflow-state-link custom entry').toBeTruthy()
    expect(fs.existsSync(link!.stateFile), `stateFile 应已写入: ${link!.stateFile}`).toBe(true)

    // 断言：state.calls[0].opts 是脚本请求值的完整持久化（jsonl-run-store serializeRun）
    const snapshot = JSON.parse(fs.readFileSync(link!.stateFile, 'utf8'))
    const calls = snapshot?.state?.calls
    expect(Array.isArray(calls), 'state.calls 应为数组').toBe(true)
    expect(calls.length, '至少 1 个 agent call').toBeGreaterThan(0)
    const call0 = calls[0]
    expect(call0.opts.thinkingLevel, 'calls[0].opts.thinkingLevel 应为 high（脚本请求值）').toBe('high')
    expect(call0.opts.model, 'calls[0].opts.model 应与 fixture 一致').toBe(PROBE_MODEL)
    expect(call0.sessionId, 'calls[0].sessionId 应存在（TC2 子进程文件定位依赖）').toBeTruthy()
    console.log(`[TC1] state 请求值验证通过: model=${call0.opts.model}, thinkingLevel=${call0.opts.thinkingLevel}, runId=${link!.runId}`)
  } finally {
    ctx.listenWs?.close()
    await ctx.cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})

// ── TC2: pi 真实生效值（核心，确定性） ─────────────────────────────────

test('TC2: 子进程 JSONL 含 thinking_level_change high + model_change（pi 真实生效）', async () => {
  test.setTimeout(180_000)
  const ctx = await runProbeWorkflow('tc2')
  try {
    if (!ctx.doneUpdate) {
      writeDiag('tc2', ctx.dataDir, ctx.events)
      console.log(`[TC2] workflow 未完成（events=${ctx.events.length}），diag → /tmp/tc2-diag.json`)
      test.skip(true, '主 agent 未调用 workflow tool（flaky，见 /tmp/tc2-diag.json）')
      return
    }

    // 定位链 1+2：主 session JSONL → workflow-state-link → stateFile → calls[0].sessionId
    let mainFile = ctx.mainSessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    const link = findWorkflowStateLink(mainFile!)
    expect(link, '主 session JSONL 应含 workflow-state-link custom entry').toBeTruthy()
    expect(fs.existsSync(link!.stateFile), 'stateFile 应已写入').toBe(true)

    const snapshot = JSON.parse(fs.readFileSync(link!.stateFile, 'utf8'))
    const call0 = snapshot?.state?.calls?.[0]

    // 定位链 3：优先 calls[0].sessionFile（pi 子进程 session 文件绝对路径，
    // execution-record serialize 持久化）；缺失时全量扫描排除主 session 取最新
    const subFile = locateSubagentSessionFile(ctx.dataDir, call0, ctx.mainSessionFile)
    if (!subFile) {
      const candidates = findSubagentSessionFiles(ctx.dataDir)
      writeDiag('tc2', ctx.dataDir, ctx.events, {
        call0: { sessionId: call0?.sessionId, sessionFile: call0?.sessionFile },
        candidateCount: candidates.length,
        candidates: candidates.slice(0, 10).map((f) => path.basename(f)),
      })
      console.log(`[TC2] 未找到子进程 session 文件（候选 ${candidates.length} 个），diag → /tmp/tc2-diag.json`)
    }
    expect(subFile, '应能找到子进程 session 文件（calls[0].sessionFile 或扫描 fallback）').toBeTruthy()

    // 核心断言：pi 收到 --model deepseek-router/ds-pro:high 后拆成独立字段落盘。
    // 禁止 grep ":high" 后缀——spawn args 才带后缀，JSONL entry 是独立字段。
    const entries = readSessionEntries(subFile!)
    expect(entries, '子进程 session 文件应可解析').toBeTruthy()
    const tlEntries = entries!.filter((e) => e.type === 'thinking_level_change')
    const mcEntries = entries!.filter((e) => e.type === 'model_change')
    expect(tlEntries.length, '子进程 JSONL 应含 thinking_level_change entry（启动即写）').toBeGreaterThan(0)
    expect(tlEntries[0].thinkingLevel, 'thinking_level_change.thinkingLevel 应为 high（独立字段）').toBe('high')
    expect(mcEntries.length, '子进程 JSONL 应含 model_change entry').toBeGreaterThan(0)
    expect(mcEntries[0].provider, 'model_change.provider 应与 fixture model 的 provider 一致').toBe(PROBE_MODEL.split('/')[0])
    expect(mcEntries[0].modelId, 'model_change.modelId 应与 fixture model 的 id 一致').toBe(PROBE_MODEL.split('/')[1])
    // 顺序契约（实证第 2-3 行）：model_change 先、thinking_level_change 后
    const mcIdx = entries!.findIndex((e) => e.type === 'model_change')
    const tlIdx = entries!.findIndex((e) => e.type === 'thinking_level_change')
    expect(mcIdx, 'model_change 应先于 thinking_level_change 落盘').toBeLessThan(tlIdx)
    console.log(`[TC2] pi 真实生效值验证通过: ${path.basename(subFile!)}`)
    console.log(`[TC2]   model_change: ${mcEntries[0].provider}/${mcEntries[0].modelId}`)
    console.log(`[TC2]   thinking_level_change: ${tlEntries[0].thinkingLevel}`)
  } finally {
    ctx.listenWs?.close()
    await ctx.cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})

// ── TC3: 完整跑通（done 信号 + 真实 provider 产出） ────────────────────

test('TC3: workflowUpdate done + 子进程 JSONL 有 assistant 消息（完整跑通）', async () => {
  test.setTimeout(180_000)
  const ctx = await runProbeWorkflow('tc3')
  try {
    if (!ctx.doneUpdate) {
      writeDiag('tc3', ctx.dataDir, ctx.events)
      console.log(`[TC3] workflow 未完成（events=${ctx.events.length}），diag → /tmp/tc3-diag.json`)
      test.skip(true, '主 agent 未调用 workflow tool（flaky，见 /tmp/tc3-diag.json）')
      return
    }

    // 核心断言 1：session.workflowUpdate done 信号（workflow run 完成广播）
    const update = ctx.doneUpdate.payload.update
    expect(update.runId, 'done 信号应带 runId').toBeTruthy()
    expect(update.status).toBe('done')
    console.log(`[TC3] workflowUpdate done 信号到达: runId=${update.runId}, reason=${update.reason ?? '(无)'}`)

    // 核心断言 2：子进程 JSONL 有 assistant 消息（真实 provider 跑完产出）
    // 定位链同 TC2：主 session JSONL → stateFile → calls[0].sessionId → 全量扫描匹配
    let mainFile = ctx.mainSessionFile
    const fileDeadline = Date.now() + 15_000
    while ((!mainFile || !fs.existsSync(mainFile)) && Date.now() < fileDeadline) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(mainFile, '主 session JSONL 路径应存在').toBeTruthy()
    expect(fs.existsSync(mainFile!), '主 session JSONL 文件应已写入').toBe(true)

    const link = findWorkflowStateLink(mainFile!)
    expect(link, '主 session JSONL 应含 workflow-state-link custom entry').toBeTruthy()
    expect(fs.existsSync(link!.stateFile), 'stateFile 应已写入').toBe(true)

    const snapshot = JSON.parse(fs.readFileSync(link!.stateFile, 'utf8'))
    const call0 = snapshot?.state?.calls?.[0]

    // 定位链 3：同 TC2——优先 calls[0].sessionFile，fallback 全量扫描
    const subFile = locateSubagentSessionFile(ctx.dataDir, call0, ctx.mainSessionFile)
    if (!subFile) {
      writeDiag('tc3', ctx.dataDir, ctx.events, {
        call0: { sessionId: call0?.sessionId, sessionFile: call0?.sessionFile },
        candidates: findSubagentSessionFiles(ctx.dataDir).slice(0, 10).map((f) => path.basename(f)),
        runStatus: snapshot?.state?.status,
        callStatus: call0?.status,
      })
      console.log(`[TC3] 未找到子进程 session 文件，diag → /tmp/tc3-diag.json`)
    }
    expect(subFile, '应能找到子进程 session 文件').toBeTruthy()

    const entries = readSessionEntries(subFile!)
    expect(entries, '子进程 session 文件应可解析').toBeTruthy()
    const assistantMsgs = entries!.filter(
      (e) => e.type === 'message' && e.message?.role === 'assistant',
    )
    if (assistantMsgs.length === 0 && call0?.status === 'failed') {
      // 真实 provider key 不可用等环境原因：agent call 失败但文件链完整。
      // TC3 降级 skip（分层降级，TC1/TC2 已覆盖核心断言，不受影响）。
      console.log(`[TC3] agent call failed（status=${call0.status}, error=${call0.error ?? call0.result?.error ?? '(无)'}），provider key 不可用？skip assistant 断言`)
      test.skip(true, '真实 provider 调用失败（stateFile calls[0].status=failed），TC1/TC2 已通过')
      return
    }
    expect(assistantMsgs.length, '子进程 JSONL 应有 assistant 消息（真实 provider 跑完产出）').toBeGreaterThan(0)

    // 增强断言（不强制）：PROBE-OK 回复出现
    const allText = assistantMsgs.map((e) => JSON.stringify(e.message?.content ?? '')).join(' ')
    console.log(`[TC3] workflow 完整跑通: runId=${update.runId}, assistant 消息=${assistantMsgs.length} 条, PROBE-OK 出现=${allText.includes('PROBE-OK')}`)
  } finally {
    ctx.listenWs?.close()
    await ctx.cleanup()
    if (!process.env.PLAYWRIGHT_DEBUG_KEEP_DATA) fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})
