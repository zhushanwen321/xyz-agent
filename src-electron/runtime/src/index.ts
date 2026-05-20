import { SidecarServer } from './server.js'

function parseArgs(): { port: number; projectRoot?: string } {
  // eslint-disable-next-line no-magic-numbers -- argv[0] is node, argv[1] is script
  const args = process.argv.slice(2)
  let port = 3210
  let projectRoot: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10)
    } else if (args[i].startsWith('--port=')) {
      port = parseInt(args[i].split('=')[1], 10)
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
  const server = new SidecarServer(port, projectRoot)

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
