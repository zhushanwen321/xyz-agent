import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'

let client: WebSocket | null = null

export function startServer(port: number): void {
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws) => {
    if (client) {
      ws.close(4000, 'Only one client allowed')
      return
    }
    client = ws
    console.log('[sidecar] client connected')

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        handleMessage(msg, ws)
      } catch (e) {
        sendError(ws, 'parse_error', 'Invalid JSON')
      }
    })

    ws.on('close', () => {
      client = null
      console.log('[sidecar] client disconnected')
    })

    ws.on('error', (err) => {
      console.error('[sidecar] ws error:', err)
    })
  })

  console.log(`[sidecar] WS server listening on port ${port}`)
}

function handleMessage(msg: ClientMessage, ws: WebSocket): void {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', payload: {} }))
      break
    default:
      // TODO: route to appropriate handler in Task E.2/E.4
      break
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  const resp: ServerMessage = { type: 'error', payload: { code, message } }
  ws.send(JSON.stringify(resp))
}
