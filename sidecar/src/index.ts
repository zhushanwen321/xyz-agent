import { SidecarServer } from './server.js'

function parseArgs(): { port: number } {
  // eslint-disable-next-line no-magic-numbers -- argv[0] is node, argv[1] is script
  const args = process.argv.slice(2)
  let port = 3210
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10)
    }
  }
  return { port }
}

async function main(): Promise<void> {
  const { port } = parseArgs()
  const server = new SidecarServer(port)

  // Graceful shutdown on signals
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[sidecar] received ${signal}, shutting down...`)
    try {
      await server.stop()
    // eslint-disable-next-line taste/no-silent-catch -- shutdown: best-effort stop, process exits regardless
    } catch (e) {
      console.error('[sidecar] error during shutdown:', e)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await server.start()
  console.log('[sidecar] ready')
}

main().catch((e) => {
  console.error('[sidecar] fatal:', e)
  process.exit(1)
})
