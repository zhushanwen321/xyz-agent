import { SidecarServer } from './server.js'
import { SessionService } from './services/session-service.js'
import { TreeService } from './services/tree-service.js'
import { ConfigService } from './services/config-service.js'
import { ModelService } from './services/model-service.js'

import { BASE_PORT, MAX_PORT } from '@xyz-agent/shared'

const MAX_PERCENT = 100
import { ProcessManager } from './process-manager.js'
import { EventAdapter } from './event-adapter.js'
import { ExtensionService } from './extension-service.js'
import { PluginRegistry } from './services/plugin-service/plugin-registry.js'
import { PluginService } from './services/plugin-service/plugin-service.js'
import type { NavigateInterceptor } from './navigate-interceptor.js'

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
  const server = new SidecarServer(port, projectRoot)

  // Service layer (DI)
  const extensionService = new ExtensionService({ projectRoot: effectiveRoot })
  const treeService = new TreeService(pm)

  // pluginService/configService/modelService: declared before sessionService but assigned after.
  // The adapter factory closures read them at session creation time (deferred),
  // by which point all services are already initialized (runtime is single-threaded).
  // eslint-disable-next-line prefer-const
  let pluginService: PluginService | undefined

  const sessionService = new SessionService(
    pm,
    server,  // IMessageBroker
    (sessionId: string, interceptor: NavigateInterceptor) => new EventAdapter(sessionId, interceptor.send, {
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
        // Look up current model's contextWindow from session model info
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
      onHookExecute: pluginService!
        ? (hookType, context) => pluginService!.executeHooks(hookType, {
          pluginId: '',
          hookType: hookType as import('./services/plugin-service/plugin-types.js').HookType,
          data: { ...context, sessionId },
          timestamp: Date.now(),
        })
        : undefined,
    }),
    effectiveRoot,
    treeService,
    extensionService,
  )
  const configService = new ConfigService(effectiveRoot)
  const modelService = new ModelService()

  // Wire services into server
  const pluginRegistry = new PluginRegistry(effectiveRoot)
  pluginService = new PluginService(pluginRegistry, server, {
    sessionService,
    configService,
    broadcastFn: (type, payload) => server.broadcast({ type: type as 'session.list', id: `push_${Date.now()}`, payload } as import('@xyz-agent/shared').ServerMessage),
  })
  server.setServices(sessionService, configService, modelService, treeService, extensionService, pluginService)

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
