// 场景 5 RPC 对照：经页面已有 3310 WS（已 auth）调用 session.getSubagents
const [, , wsUrl, sessionId] = process.argv
function cdp(ws, method, params = {}) {
  const id = ++cdpId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout ' + method)), 20000)
    const handler = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === id) {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
let cdpId = 0
const ws = new WebSocket(wsUrl)
ws.addEventListener('open', async () => {
  try {
    await cdp(ws, 'Runtime.enable')
    const proto = await cdp(ws, 'Runtime.evaluate', { expression: 'WebSocket.prototype' })
    const q = await cdp(ws, 'Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId })
    const r = await cdp(ws, 'Runtime.callFunctionOn', {
      objectId: q.result.objects.objectId,
      functionDeclaration: `function () {
        return new Promise((resolve) => {
          const target = Array.from(this).find(w => String(w.url||'').includes(':3310') && w.readyState === 1);
          if (!target) { resolve(JSON.stringify({error: 'no open 3310 ws'})); return; }
          const rpcId = Math.floor(Math.random()*1e6);
          const replies = [];
          const collect = (ev) => {
            try {
              const m = JSON.parse(ev.data);
              if (m.id === rpcId) { replies.push(m); }
            } catch {}
          };
          target.addEventListener('message', collect);
          target.send(JSON.stringify({ type: 'session.getSubagents', id: rpcId, payload: { sessionId: ${JSON.stringify(sessionId)} } }));
          setTimeout(() => { target.removeEventListener('message', collect); resolve(JSON.stringify(replies).slice(0, 3000)); }, 3000);
        });
      }`,
      awaitPromise: true,
      returnByValue: true,
    })
    console.log('getSubagents reply:', r.result?.result?.value)
    process.exit(0)
  } catch (e) {
    console.error('error:', e.message)
    process.exit(1)
  }
})
