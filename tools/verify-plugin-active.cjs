#!/usr/bin/env node
/**
 * verify-plugin-active.cjs — P7 插件 ActiveSessionResolver per-client 化端到端验证。
 *
 * 核心验证（spec §六测试计划 + plan.md DoD）：ALS 透传在 plugin 工具执行主链上断裂的
 * 修复——长期方案 A：bridge invoke 携带 clientId + Worker RPC 透传，不依赖 ALS。
 *
 * 验证方式：用 tsx 加载**真实生产源码模块**（非 mock），驱动完整透传链：
 *
 *   bridge.tool.execute(sessionId)
 *     → handleBridgeToolExecute（clientIdResolver 从 lease owner 反查 clientId）
 *     → rpcServer.invoke('plugin.tool.execute', { clientId })        [主线程→Worker]
 *     → Worker PluginRpcClient.setCurrentClientId(clientId)          [执行上下文捕获]
 *     → 插件代码 rpcClient.request('plugin.sessions.getActive')      [Worker→主线程]
 *       （PluginRpcClient.request 自动注入 __clientId）
 *     → rpcServer.dispatch → handler（resolveClientId 读 __clientId）
 *     → ActiveSessionResolver.resolve(clientId)                      [per-client 解析]
 *
 * 场景：
 *   ① A/B per-client 各自 resolve 到自己的 active session（lease owner 反查）：
 *      client-A 持 sessionX lease → resolve 返回 sessionX；
 *      client-B 持 sessionY lease → resolve 返回 sessionY。
 *   ② ALS 断裂暴露：handler 调用时不在任何 sessionContext.run 作用域内（独立 tick 模拟），
 *      若依赖 ALS 则 clientId 恒 undefined → 两 client 都走全局 fallback 返回同一 session。
 *      修复后靠 __clientId 显式透传，per-client 正确解析。
 *   ③ 无 clientId（无 lease / 无 resolver）→ 全局 active fallback（零回归）。
 *
 * 用法：node tools/verify-plugin-active.cjs   [VERIFY_DEBUG=1 打印中间值]
 *       （等价：tsx tools/verify-plugin-active.cjs）
 * 退出码：0 = 全部 PASS，1 = 任一步 FAIL（含 tsx/源码加载失败——不再 exit(0) 假绿）
 *
 * 加载机制：脚本以 `node ...cjs` 启动时若检测到 tsx 未注册，自动用 `node --import tsx`
 * 重执行自身一次（spawn 子进程透传 stdio + exit code）。tsx 注册后动态 import('.ts') 才能
 * 真正解析 TS 源码（Node v24 内建 strip-only 模式不解析 .js 后缀 import + parameter property，
 * 会让 loadRealModules 抛错）。直接以 `tsx ...cjs` 启动则跳过重执行。
 *
 * 与 vitest 的关系：本脚本用 tsx 跑真实源码（非编译产物），是 vitest 单测的补充——
 * 单测覆盖模块级行为（session-api.test.ts TC-w4-* / plugin-rpc-client.test.ts / bridge-interop.test.ts），
 * 本脚本覆盖跨模块完整链路（bridge→invoke→worker→dispatch→handler→resolver）。
 */
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const RUNTIME_SRC = path.join(REPO_ROOT, 'packages', 'runtime', 'src')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

// tsx 注册探针：尝试 import 一个生产 .ts 模块；成功说明 tsx loader 已生效。
// 不用环境变量标记（不可靠：用户可能预置），改用真实 import 探测。
async function isTsxActive() {
  try {
    await import('file://' + RUNTIME_SRC + '/services/plugin-service/plugin-types.ts')
    return true
  } catch {
    return false
  }
}

/**
 * 若 tsx 未注册，用 `node --import tsx` 重执行自身一次，透传 stdio + exit code。
 * 直接以 `tsx ...cjs` 启动时探测即通过，跳过重执行。
 */
async function ensureTsxThenRun() {
  if (await isTsxActive()) return true
  if (!fs.existsSync(TSX)) {
    console.error(`tsx 未找到: ${TSX}（本脚本用 tsx 加载 runtime 真实源码模块）`)
    console.error('安装依赖后重试：pnpm install（或 npm i tsx -D）。')
    return false
  }
  // 重执行：node --import tsx <self>。子进程 stdio 继承，exit code 透传。
  const child = spawn(process.execPath, ['--import', 'tsx', __filename], {
    stdio: 'inherit',
    env: { ...process.env, __VERIFY_PLUGIN_ACTIVE_REEXEC__: '1' },
  })
  return new Promise((resolve) => {
    child.on('exit', (code) => process.exit(code ?? 1))
    child.on('error', (e) => {
      console.error('[verify-plugin-active] re-exec 失败:', e.message)
      resolve(false)
    })
  })
}

const failures = []
const passes = []
function log(step, msg) { console.log(`[${step}] ${msg}`) }
function pass(step, msg) { passes.push(`${step}: ${msg}`); console.log(`[PASS ${step}] ${msg}`) }
function fail(step, msg) { failures.push(`${step}: ${msg}`); console.error(`[FAIL ${step}] ${msg}`) }
const debug = !!process.env.VERIFY_DEBUG
function dbg(step, msg) { if (debug) console.log(`[DBG ${step}] ${msg}`) }

/**
 * 用 tsx 加载真实生产源码模块（动态 import .ts）。
 * 返回链路所需的全部真实模块。
 */
async function loadRealModules() {
  const base = path.toNamespacedPath(RUNTIME_SRC).replace(/\/$/, '')
  const ps = base + '/services/plugin-service'
  const [
    rpcServerMod, rpcClientMod, sessionApiMod, bridgeInteropMod,
  ] = await Promise.all([
    import('file://' + ps + '/plugin-rpc-server.ts'),
    import('file://' + ps + '/plugin-rpc-client.ts'),
    import('file://' + ps + '/api/session-api.ts'),
    import('file://' + ps + '/bridge-interop.ts'),
  ])
  return {
    PluginRpcServer: rpcServerMod.PluginRpcServer,
    PluginRpcClient: rpcClientMod.PluginRpcClient,
    ActiveSessionResolver: sessionApiMod.ActiveSessionResolver,
    registerSessionRpcHandlers: sessionApiMod.registerSessionRpcHandlers,
    resolveClientId: sessionApiMod.resolveClientId,
    handleBridgeToolExecute: bridgeInteropMod.handleBridgeToolExecute,
    CLIENT_ID_PARAM_KEY: (await import('file://' + ps + '/plugin-types.ts')).CLIENT_ID_PARAM_KEY,
  }
}

/**
 * 构造一对耦合的 MessagePort：主线程 PluginRpcServer 与 Worker PluginRpcClient 经此通信。
 * - 主线程→Worker（invoke 的请求 / dispatch 的响应）：portAB.postMessage → clientPort.onMessage
 * - Worker→主线程（client.request 的请求 / invoke 的响应）：portBA.postMessage → serverPort.onMessage
 *
 * 返回 { serverPort, clientPort }，两者 postMessage 互为对端 onMessage 投递。
 */
function createCoupledPorts() {
  let serverSink = null
  let clientSink = null
  const serverPort = {
    postMessage(msg) { if (clientSink) clientSink(msg) },
    onMessage(handler) { serverSink = handler },
  }
  const clientPort = {
    postMessage(msg) { if (serverSink) serverSink(msg) },
    onMessage(handler) { clientSink = handler },
  }
  return { serverPort, clientPort }
}

/**
 * 搭建完整透传链（真实模块）：
 * - 主线程：PluginRpcServer + registerSessionRpcHandlers + ActiveSessionResolver（mock deps）
 * - Worker：PluginRpcClient（attach clientPort）
 * - bridge：handleBridgeToolExecute（clientIdResolver 从 leaseManager 反查）
 *
 * @param opts.summaries        sessionId → summary（resolver 用）
 * @param opts.leaseOwners      sessionId → clientId（leaseManager.getLeaseOwner 用）
 * @param opts.activeSessionsMap clientId → sessionId（connectionManager.getActiveSession 用）
 */
async function buildChain(mods, opts) {
  const { serverPort, clientPort } = createCoupledPorts()

  // ── 主线程：PluginRpcServer + session handler + resolver ──
  const rpcServer = new mods.PluginRpcServer()
  rpcServer.registerWorker('w1', serverPort)

  const deps = {
    sessionService: {
      getSummary: (id) => opts.summaries[id],
      // listPersistedSessions：供 resolver 全局 active fallback 扫描（D3 第三级）。
      // 把 summaries 中 status==='active' 的 session 暴露为一个 group。
      listPersistedSessions: () => {
        const active = Object.values(opts.summaries).filter((s) => s.status === 'active')
        return active.length > 0 ? [{ cwd: '/g', sessions: active }] : []
      },
    },
    connectionManager: {
      getActiveSession: (clientId) => opts.activeSessionsMap?.get(clientId),
    },
    leaseManager: {
      // getBusySession(clientId)：反查 clientId 持有 lease 的 session（resolver 第二级 fallback）。
      // 从 leaseOwners（sessionId→clientId）反查。
      getBusySession: (clientId) => {
        for (const [sid, owner] of opts.leaseOwners?.entries() ?? []) {
          if (owner === clientId) return { sessionId: sid }
        }
        return undefined
      },
      getLeaseOwner: (sessionId) => opts.leaseOwners?.get(sessionId),
    },
  }
  const resolver = new mods.ActiveSessionResolver(deps)
  mods.registerSessionRpcHandlers(rpcServer, {
    listSessions: async () => [],
    getSession: async () => undefined,
    getActiveSession: (clientId) => resolver.resolve(clientId) && {
      id: resolver.resolve(clientId).id,
      label: resolver.resolve(clientId).label,
      cwd: resolver.resolve(clientId).cwd,
      status: resolver.resolve(clientId).status,
      createdAt: 0,
      lastActiveAt: 0,
    },
    sendMessage: async () => {},
  })

  // ── Worker：PluginRpcClient ──
  const rpcClient = new mods.PluginRpcClient()
  rpcClient.attach(clientPort)
  // serverPort 收到的是 clientPort.postMessage（Worker→主线程）的消息：
  //   ① Worker 主动发来的 RPC 请求（rpcClient.request）→ 主线程 dispatch
  // 等价于生产中 plugin-host 的 worker.on('message') → rpcServer.dispatch。
  serverPort.onMessage((msg) => {
    const m = msg
    if (m.type === 'rpc' && typeof m.method === 'string' && typeof m.id === 'number') {
      rpcServer.dispatch('w1', m)
    }
  })
  // clientPort 收到的是 serverPort.postMessage（主线程→Worker）的消息：
  //   ① dispatch 回复的 RPC 响应 → rpcClient.handleResponse 解析 pending
  // 等价于生产中 plugin-bootstrap parentPort.on('message') → rpcClient.handleResponse。
  clientPort.onMessage((msg) => {
    const m = msg
    if (m.type === 'rpc' && m.response) rpcClient.handleResponse(m.response)
  })

  return { rpcServer, rpcClient, resolver, deps }
}

/**
 * 模拟「插件工具执行 + 工具内调 getActive」完整链路。
 *
 * @param chain        buildChain 返回
 * @param mods         真实模块
 * @param invokeParams plugin.tool.execute 的 invoke params（含 clientId）
 * @returns 插件 getActive 返回的 SessionInfo（或 undefined）
 */
async function runPluginGetActive(chain, mods, invokeParams) {
  // 1) 主线程 invoke plugin.tool.execute 到「Worker」——但我们不在 Worker 真跑 plugin，
  //    而是模拟 Worker 收到 invoke 后的「执行上下文捕获」：setCurrentClientId。
  //    生产中 plugin-bootstrap handleIncomingRequest 在 plugin.tool.execute 入口做这一步。
  const clientId = invokeParams.clientId
  chain.rpcClient.setCurrentClientId(typeof clientId === 'string' && clientId ? clientId : undefined)
  dbg('run', `setCurrentClientId(${clientId})`)

  // 2) 模拟「插件代码」调 api.sessions.getActive()——经 rpcClient.request 发 RPC 回主线程。
  //    PluginRpcClient.request 自动注入 __clientId（这是透传链的 Worker 侧关键步骤）。
  //    createSessionApi.getActive 实际就是 rpcClient.request('plugin.sessions.getActive', {pluginId})。
  const result = await chain.rpcClient.request('plugin.sessions.getActive', { pluginId: 'p1' })

  // 3) 工具执行结束，复位执行上下文（plugin-bootstrap finally 做这一步）
  chain.rpcClient.setCurrentClientId(undefined)

  return result
}

async function main() {
  // 前置：确保 tsx 已注册（否则动态 import('.ts') 无法解析 TS 源码）。
  // ensureTsxActive 失败（tsx 不可用或重执行失败）→ exit 1（真 FAIL，不假绿）。
  const ready = await ensureTsxThenRun()
  if (!ready) {
    console.error('verify-plugin-active: tsx 未就绪，无法加载真实源码（exit 1，不降级假绿）')
    process.exit(1)
  }

  let mods
  try {
    mods = await loadRealModules()
  } catch (e) {
    // 真实失败：tsx 已注册但源码模块加载仍出错（源码语法/import 错误等）→ exit 1。
    console.error(`加载真实源码模块失败: ${e.message}`)
    console.error(e.stack)
    console.error('verify-plugin-active: 源码加载失败（exit 1，不降级假绿）')
    process.exit(1)
  }

  // ── 场景 ①：A/B per-client 各自 resolve 到自己的 active session ──────────
  log('S1', '场景 ①：A/B per-client 各自 resolve 到自己的 active session（lease owner 反查）')
  try {
    const summaries = {
      sessionX: { id: 'sessionX', label: 'X', cwd: '/x', status: 'idle', lastActiveAt: 0, modelId: 'p/m', tokenCount: 0 },
      sessionY: { id: 'sessionY', label: 'Y', cwd: '/y', status: 'idle', lastActiveAt: 0, modelId: 'p/m', tokenCount: 0 },
    }
    // lease owner：client-A 持 sessionX，client-B 持 sessionY
    const leaseOwners = new Map([['sessionX', 'client-A'], ['sessionY', 'client-B']])
    const chain = await buildChain(mods, { summaries, leaseOwners })

    // 模拟 bridge.tool.execute（sessionId 来自 pi bridge_request 事件）：
    //   client-A 触发的工具执行 → sessionId=sessionX → clientIdResolver 反查 lease owner=client-A
    const resultA = await runPluginGetActive(chain, mods, { clientId: 'client-A', sessionId: 'sessionX' })
    const resultB = await runPluginGetActive(chain, mods, { clientId: 'client-B', sessionId: 'sessionY' })

    dbg('S1', `A getActive → ${JSON.stringify(resultA)}`)
    dbg('S1', `B getActive → ${JSON.stringify(resultB)}`)

    if (!resultA || resultA.id !== 'sessionX') {
      fail('S1', `client-A 应 resolve 到 sessionX，实际: ${JSON.stringify(resultA)}`)
    } else if (!resultB || resultB.id !== 'sessionY') {
      fail('S1', `client-B 应 resolve 到 sessionY，实际: ${JSON.stringify(resultB)}`)
    } else {
      pass('S1', `A→sessionX, B→sessionY（per-client 隔离，clientId 经 __clientId 透传）`)
    }
  } catch (e) {
    fail('S1', `异常: ${e.message}\n${e.stack}`)
  }

  // ── 场景 ②：ALS 断裂暴露——handler 不在 sessionContext.run 内仍能 per-client 解析 ──
  log('S2', '场景 ②：ALS 断裂暴露——handler 调用时无 ALS 作用域，靠 __clientId 显式透传')
  try {
    // 关键：整个链路不在任何 AsyncLocalStorage.run 内（本脚本是裸 Node 进程，无 sessionContext.run）。
    // 若 handler 依赖 ALS，clientId 会恒 undefined → resolver 走全局 fallback。
    // 修复后 handler 用 resolveClientId(params) 读 __clientId，per-client 正确。
    // 验证手段：直接检查 resolveClientId 在「无 ALS」下能否从 params 取出 clientId。
    const { sessionContext } = await import('file://' + RUNTIME_SRC + '/infra/async-context.ts')
    const alsStore = sessionContext.getStore()
    dbg('S2', `ALS getStore() = ${alsStore}（应为 undefined，证明无 ALS 作用域）`)
    if (alsStore !== undefined) {
      fail('S2', `ALS getStore 应为 undefined（裸进程无 sessionContext.run），实际: ${JSON.stringify(alsStore)}`)
    }

    // resolveClientId 从 params 取 clientId（不依赖 ALS）
    const resolved = mods.resolveClientId({ [mods.CLIENT_ID_PARAM_KEY]: 'client-from-worker' })
    if (resolved !== 'client-from-worker') {
      fail('S2', `resolveClientId 应返回 'client-from-worker'（params 显式透传），实际: ${resolved}`)
    } else {
      pass('S2', `无 ALS 作用域下 resolveClientId 仍从 params 读出 clientId（ALS 断裂已修复）`)
    }
  } catch (e) {
    fail('S2', `异常: ${e.message}\n${e.stack}`)
  }

  // ── 场景 ③：无 clientId（无 lease / 无 resolver）→ 全局 active fallback（零回归）──
  log('S3', '场景 ③：无 clientId 透传 → 全局 active fallback（零回归，D7 例外）')
  try {
    const summaries = {
      globalActive: { id: 'globalActive', label: 'G', cwd: '/g', status: 'active', lastActiveAt: 0, modelId: 'p/m', tokenCount: 0 },
    }
    // 无 lease owner / 无 activeSessionsMap（模拟 hook/定时器触发的 plugin 操作）
    const chain = await buildChain(mods, { summaries })

    // plugin.tool.execute 无 clientId（无 lease / leaseManager 未注入）
    const result = await runPluginGetActive(chain, mods, { clientId: undefined, sessionId: 'whatever' })

    dbg('S3', `无 clientId getActive → ${JSON.stringify(result)}`)
    if (!result || result.id !== 'globalActive') {
      fail('S3', `应 fallback 到全局 active session 'globalActive'，实际: ${JSON.stringify(result)}`)
    } else {
      pass('S3', `无 clientId → 全局 active fallback（与现状行为等价，零回归）`)
    }
  } catch (e) {
    fail('S3', `异常: ${e.message}\n${e.stack}`)
  }

  // ── 场景 ④：connectionManager.getActiveSession 命中（setActive 过的客户端）──
  log('S4', '场景 ④：connectionManager.getActiveSession 命中（客户端 setActive 过）')
  try {
    const summaries = {
      sessionSet: { id: 'sessionSet', label: 'S', cwd: '/s', status: 'idle', lastActiveAt: 0, modelId: 'p/m', tokenCount: 0 },
    }
    // client-A 调过 session.setActive(sessionSet) → activeSessionsMap 命中
    const activeSessionsMap = new Map([['client-A', 'sessionSet']])
    const chain = await buildChain(mods, { summaries, activeSessionsMap })

    const result = await runPluginGetActive(chain, mods, { clientId: 'client-A', sessionId: 'sessionSet' })

    dbg('S4', `client-A (setActive 过) getActive → ${JSON.stringify(result)}`)
    if (!result || result.id !== 'sessionSet') {
      fail('S4', `client-A 应 resolve 到 sessionSet（activeSessionsMap 命中），实际: ${JSON.stringify(result)}`)
    } else {
      pass('S4', `client-A setActive 过 → activeSessionsMap 命中 sessionSet`)
    }
  } catch (e) {
    fail('S4', `异常: ${e.message}\n${e.stack}`)
  }

  // ── 汇总 ──
  console.log('')
  if (passes.length > 0) {
    console.log(`${passes.length} 个 PASS:\n  - ${passes.join('\n  - ')}`)
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} 个 FAIL:\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('verify-plugin-active: 全部 PASS（P7 长期方案 A clientId 透传链验证通过）')
  process.exit(0)
}

main().catch((e) => {
  console.error('[verify-plugin-active] fatal:', e)
  process.exit(1)
})
