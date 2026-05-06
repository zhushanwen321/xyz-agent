import { startServer } from './server.js'

function parseArgs(): { port: number } {
  const args = process.argv.slice(2)
  let port = 3210
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10)
    }
  }
  return { port }
}

const { port } = parseArgs()
console.log(`[sidecar] starting on port ${port}`)
startServer(port)
