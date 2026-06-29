import { RuntimeServer } from './transport/server.js'
import { SessionService } from './services/session/session-service.js'
import { TreeService } from './services/tree-service.js'
import { ConfigService } from './services/config-service.js'
import { ModelService } from './services/model-service.js'

import { BASE_PORT, MAX_PORT } from '@xyz-agent/shared'

const MAX_PERCENT = 100
import { ProcessManager } from './infra/pi/process-manager.js'
import { PiConfigStore } from './infra/pi/pi-config-store.js'
import { PiSessionStore } from './infra/pi/session-store.js'
import { ModelApiDiscoverer } from './infra/model-api-discoverer.js'
import { NpmGitInstaller } from './infra/installers/npm-git-installer.js'
import { ExtensionResolver } from './infra/installers/extension-resolver.js'
import { PiExtensionSettings } from './infra/pi/pi-extension-settings.js'
import { EventAdapter } from './infra/pi/event-adapter.js'
import { NavigateInterceptorFactory } from './infra/pi/navigate-interceptor.js'
import { SessionTreeReaderAdapter } from './infra/pi/session-tree-reader-adapter.js'
import { join, resolve } from 'node:path'
import type { INavigateInterceptor } from './services/ports/tree.js'
import { ExtensionService } from './services/extension-service.js'
import { PluginRegistry } from './services/plugin-service/plugin-registry.js'
import { PluginService } from './services/plugin-service/plugin-service.js'
import { GitService } from './services/git-service.js'
import { GitExecutor } from './infra/git-executor.js'
import { FileService } from './services/file-service.js'
import { FsExecutor } from './infra/fs-executor.js'

function parseArgs(): { port: number; projectRoot?: string } {
  // eslint-disable-next-line no-magic-numbers -- argv[0] is node, argv[1] is script
  const args = process.argv.slice(2)
  const portOffset = Math.max(0, Math.min(parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10) || 0, MAX_PORT - BASE_PORT))
  let port = BASE_PORT + portOffset
  let projectRoot: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10)
      if (isNaN(parsed)) {
        console.error(`[runtime] invalid --port value: ${args[i + 1]}`)
        process.exit(1)
      }
      port = parsed
    } else if (args[i].startsWith('--port=')) {
      const parsed = parseInt(args[i].split('=')[1], 10)
      if (isNaN(parsed)) {
        console.error(`[runtime] invalid --port value: ${args[i].split('=')[1]}`)
        process.exit(1)
      }
      port = parsed
    } else if (args[i] === '--project-root' && i + 1 < args.length) {
      projectRoot = args[i + 1]
    } else if (args[i].startsWith('--project-root=')) {
      projectRoot = args[i].split('=')[1]
    }
  }
  return { port, projectRoot }
}

async function main(): Promise<void> {
  const { port, projectRoot } = parseArgs()
  const effectiveRoot = projectRoot ?? process.cwd()

  // Infrastructure
  const pm = new ProcessManager()

  // Transport layer
  const server = new RuntimeServer(port, projectRoot)

  // ── Phase 1: create all service instances (no cross-service deps at construction time) ──
  const configStore = new PiConfigStore()
  const sessionStore = new PiSessionStore()
  const modelSource = new ModelApiDiscoverer()
  const extensionInstaller = new NpmGitInstaller()
  const extensionResolver = new ExtensionResolver({
    settingsDir: configStore.getPiAgentDir(),
    thirdPartyDir: join(configStore.getPiAgentDir(), 'extensions'),
  })
  // IExtensionSettings port 的 infra 实现：经 pi-settings-store 统一读写 settings.json（D17）。
  // 构造时对齐 settings 路径到 pi agent 目录，保证 model 域与 extension 域读写同一文件。
  const extensionSettings = new PiExtensionSettings(configStore.getPiAgentDir())
  const extensionService = new ExtensionService({
    settingsDir: configStore.getPiAgentDir(),
    projectRoot: effectiveRoot,
    installer: extensionInstaller,
    resolver: extensionResolver,
    extensionSettings,
  })
  const treeService = new TreeService(pm, new SessionTreeReaderAdapter())
  const configService = new ConfigService(effectiveRoot, configStore)
  // ADR-0020 §1 一次性迁移：旧版本 skill 路径存在 settings.json.skills，
  // 首启用时提升为 discovery.json SSOT。幂等：discovery 已有数据则 no-op。
  configService.migrateSettingsSkillsToDiscovery()
  const modelService = new ModelService(modelSource)

  // ── Phase 2: create services that reference other services via closures / deps ──
  // PluginService.deps are all optional and only used at runtime (initialize / event handling),
  // so sessionService can be wired in after construction.
  const configDir = configService.getConfigDir()
  const pluginRegistry = new PluginRegistry(effectiveRoot, configDir)
  const pluginService = new PluginService(pluginRegistry, server, {
    configService,
    modelService,
    configDir,
    broadcastFn: (type, payload) => server.broadcast({ type: type as 'session.list', id: `push_${Date.now()}`, payload } as import('@xyz-agent/shared').ServerMessage),
  })

  // adapterFactory closure captures pluginService / configService / modelService by reference.
  // All three are already assigned above — no temporal coupling.
  // Note: onContextUpdate also references `sessionService` (assigned below) as a self-reference —
  // the adapter queries its owning session's data. createAdapter is only called at session
  // creation time, so sessionService is always set by then.
  const createAdapter = (sessionId: string, interceptor: INavigateInterceptor) => new EventAdapter(sessionId, interceptor.send, {
    onExtensionUIRequest: (requestId, sid, method) => {
      server.registerExtensionTimeout(sid, requestId, method)
    },
    onBridgeUIRequest: (requestId, sid, method, data) => {
      server.handleBridgeRequest(sid, requestId, method, data)
    },
    onStatusSetUpdate: (payload) => {
      server.handleStatusSetUpdate(payload)
    },
    onContextUpdate: (sid, ctxData) => {
      const providers = configService.listProviders()
      const models = modelService.aggregateModels(providers)
      const session = sessionService.getSummary(sid)
      if (!session) return
      const modelRef = session.modelId ?? ''
      const sepIdx = modelRef.indexOf('/')
      const model = sepIdx >= 0
        ? models.find(m => m.providerId === modelRef.slice(0, sepIdx) && m.id === modelRef.slice(sepIdx + 1))
        : undefined
      const contextWindow = model?.contextWindow
      const inputTokens = ctxData.inputTokens
      if (!inputTokens || inputTokens === 0) return
      const usagePercent = contextWindow
        ? Math.min(Math.round((inputTokens / contextWindow) * MAX_PERCENT), MAX_PERCENT)
        : 0
      server.broadcast({
        type: 'context.update',
        id: `ctx_${Date.now()}`,
        payload: { sessionId: sid, usagePercent, inputTokens, contextLimit: contextWindow ?? 0 },
      })
    },
    onHookExecute: (hookType, context) => pluginService.executeHooks(hookType, {
      pluginId: '',
      hookType: hookType as import('./services/plugin-service/plugin-types.js').HookType,
      data: { ...context, sessionId },
      timestamp: Date.now(),
    }),
  })

  const sessionService = new SessionService(
    pm,
    server,
    createAdapter,
    effectiveRoot,
    treeService,
    extensionService,
    configStore,
    sessionStore,
    new NavigateInterceptorFactory(),
  )

  // ── Phase 3: wire cross-service runtime deps ──
  pluginService.setSessionService(sessionService)
  // GitService：composition root 注入 infra executor（数组参数防注入）+ sessionService（取 cwd）。
  // 经 server.setServices 注入到 GitMessageHandler（git.* 路由）。
  const gitService = new GitService({ sessionService, executor: new GitExecutor() })
  // FileService：对称注入 infra FsExecutor（node:fs/promises adapter）+ sessionService（取 cwd 做越界守门）。
  // 经 server.setServices 注入到 FileMessageHandler（file.tree/expand/write.* 路由）。
  // allowedReadDirs：file.read 的 BC-3 白名单（~/.agents/skills、piAgentDir/skills、piAgentDir/npm），
  //   从 configService 算出传入（FileService 不直接依赖 configService，保持单一职责）。
  const piAgentDir = configService.getPiAgentDir()
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const fileService = new FileService({
    sessionService,
    executor: new FsExecutor(),
    allowedReadDirs: [
      resolve(homeDir, '.agents/skills'),
      resolve(piAgentDir, 'skills'),
      resolve(piAgentDir, 'npm'),
    ],
  })

  modelService.setServices(sessionService, configService, server)
  server.setServices(sessionService, configService, modelService, treeService, extensionService, pluginService, gitService, fileService)

  // Graceful shutdown on signals
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[runtime] received ${signal}, shutting down...`)
    try {
      await server.stop()
    // eslint-disable-next-line taste/no-silent-catch -- shutdown: best-effort stop, process exits regardless
    } catch (e) {
      console.error('[runtime] error during shutdown:', e)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // [HISTORICAL] unhandledRejection 兜底：防止 async 异常逃逸导致 Node.js 进程崩溃。
  // 之前 server.ts 的 ws.on('message') 回调中没有 await handleMessage()，
  // 导致 async 错误变成 unhandled rejection，Node.js 16+ 默认行为是终止进程。
  // 虽然 server.ts 已修复（加了 .catch），这里作为最后防线保留。
  process.on('unhandledRejection', (reason) => {
    console.error('[runtime] *** UNHANDLED REJECTION *** (should not happen):', reason)
  })

  await server.start()
  console.log('[runtime] ready')

  // 插件系统初始化（扫描、激活 onStartupFinished 插件）
  try {
    await pluginService.initialize()
    console.log('[runtime] plugins initialized')
  // eslint-disable-next-line taste/no-silent-catch -- init: plugin failure must not block server
  } catch (e) {
    console.error('[runtime] plugin initialization failed:', e)
  }
}

main().catch((e) => {
  console.error('[runtime] fatal:', e)
  process.exit(1)
})
