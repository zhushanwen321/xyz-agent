import { SidecarServer } from './server.js'
import { SessionService } from './services/session-service.js'
import { TreeService } from './services/tree-service.js'
import { ConfigService } from './services/config-service.js'
import { ModelService } from './services/model-service.js'
import { ProcessManager } from './process-manager.js'
import { EventAdapter } from './event-adapter.js'
import { ExtensionService } from './extension-service.js'
import type { NavigateInterceptor } from './navigate-interceptor.js'

function parseArgs(): { port: number; projectRoot?: string } {
  // eslint-disable-next-line no-magic-numbers -- argv[0] is node, argv[1] is script
  const args = process.argv.slice(2)
  let port = 3210
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
  const extensionService = new ExtensionService()
  const treeService = new TreeService(pm)
  const sessionService = new SessionService(
    pm,
    server,  // IMessageBroker
    (sessionId: string, interceptor: NavigateInterceptor) => new EventAdapter(sessionId, interceptor.send, {
      onExtensionUIRequest: (requestId, sid, method) => {
        server.registerExtensionTimeout(sid, requestId, method)
      },
    }),
    effectiveRoot,
    treeService,
    extensionService,
  )
  const configService = new ConfigService(effectiveRoot)
  const modelService = new ModelService()

  // Wire services into server
  server.setServices(sessionService, configService, modelService, treeService, extensionService)

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

  await server.start()
  console.log('[runtime] ready')
}

main().catch((e) => {
  console.error('[runtime] fatal:', e)
  process.exit(1)
})
