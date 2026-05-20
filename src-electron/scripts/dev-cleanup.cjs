// Kill stale processes on dev ports (9222=DevTools, 1420=Vite, 3210=Sidecar)
const { execSync } = require('child_process')
for (const port of ['9222', '1420', '3210']) {
  try {
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    for (const pid of out.split('\n')) {
      const n = Number(pid.trim())
      if (n > 0) {
        try { process.kill(n, 'SIGTERM'); console.log(`[dev-cleanup] killed ${n} on :${port}`) } catch {}
      }
    }
  } catch {}
}
