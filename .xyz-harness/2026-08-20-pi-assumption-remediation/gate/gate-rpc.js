// gate 探针 B：经页面已 auth 的 3310 WS 发任意 RPC，收集 3s 内 reply + 期间广播帧摘要。
// 用法: node gate-rpc.js <cdpWsUrl> '<json RPC 消息>'
const [, , wsUrl, rpcJson] = process.argv
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
          const target = window.__gateWs || Array.from(this).find(w => String(w.url||'').includes(':3310') && w.readyState === 1);
          if (!target) { resolve(JSON.stringify({error: 'no open 3310 ws'})); return; }
          const rpc = ${rpcJson};
          const rpcId = rpc.id || Math.floor(Math.random()*1e6);
          const replies = [];
          const broadcasts = [];
          const collect = (ev) => {
            try {
              const m = JSON.parse(ev.data);
              if (m.id === rpcId) replies.push(m);
              else if (rpc.__watchTypes && rpc.__watchTypes.includes(m.type)) broadcasts.push({type: m.type, payload: m.payload});
            } catch {}
          };
          target.addEventListener('message', collect);
          const { __watchTypes, ...sendMsg } = rpc;
          sendMsg.id = rpcId;
          target.send(JSON.stringify(sendMsg));
          setTimeout(() => {
            target.removeEventListener('message', collect);
            resolve(JSON.stringify({replies, broadcasts}).slice(0, 6000));
          }, 3000);
        });
      }`,
      awaitPromise: true,
      returnByValue: true,
    })
    console.log(r.result?.result?.value)
    process.exit(0)
  } catch (e) {
    console.error('error:', e.message)
    process.exit(1)
  }
})
