let bridgeState: 'Disconnected' | 'Syncing' | 'Ready' = 'Disconnected'
let syncAttempts = 0
const MAX_SYNC_ATTEMPTS = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi extension API is loosely typed
export async function activate(api: any) {
  bridgeState = 'Disconnected'

  // 1. Sync loop
  const syncInterval = setInterval(async () => {
    syncAttempts++
    if (syncAttempts > MAX_SYNC_ATTEMPTS) {
      clearInterval(syncInterval)
      return
    }
    try {
      const response = await api.extension_ui_request({ method: 'bridge:sync' })
      if (response?.tools) {
        bridgeState = 'Syncing'
        for (const tool of response.tools) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API callbacks are loosely typed
          api.registerTool(tool.name, tool.description, tool.parameters, async (params: any, extra: any) => {
            if (bridgeState !== 'Ready') return { content: 'Plugin system initializing', isError: true }
            return api.extension_ui_request({
              method: 'bridge:tool_execute', toolName: tool.name,
              toolCallId: extra?.toolCallId, params, sessionId: extra?.sessionId,
            })
          })
        }
        for (const cmd of response.commands || []) {
          api.registerCommand(cmd.name, async () => {})
        }
        bridgeState = 'Ready'
        clearInterval(syncInterval)
      }
    } catch { /* retry */ }
  }, 2000)

  // 2. Event forwarding
  const EVENTS = ['agent_start','agent_end','tool_call','tool_result',
    'turn_end','message_end','session_start','session_compact','session_tree','before_agent_start']
  for (const evt of EVENTS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi events carry arbitrary data
    api.on(evt, async (data: any) => {
      try {
        if (evt === 'before_agent_start') {
          const resp = await api.extension_ui_request({ method: 'bridge:intercept', eventName: evt, data, sessionId: data?.sessionId })
          if (resp?.injectedMessages && api.addMessage) {
            for (const msg of resp.injectedMessages) api.addMessage({ role: msg.role, content: msg.content })
          }
        } else {
          void api.extension_ui_request({ method: 'bridge:event', eventName: evt, data, sessionId: data?.sessionId })
        }
      } catch (e) {
        console.error('[bridge] event forward error:', e)
      }
    })
  }

  // 3. append_entry response handling
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi extension response payload is JSON-typed
  api.on('extension_ui_response', async (msg: any) => {
    try {
      const payload = JSON.parse(msg?.payload || '{}')
      if (payload.method === 'bridge:append_entry' && payload.type === 'plugin-data') {
        api.appendEntry(payload.type, payload.data)
      }
    } catch (e) {
      console.error('[bridge] append_entry error:', e)
    }
  })
}
