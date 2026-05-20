// Kill stale processes on dev ports (9222=DevTools, 1420=Vite, 3210=Sidecar)
import { execSync } from 'child_process'

const KILL_WAIT_MS = 500
const SIGTERM = 'SIGTERM'
const SIGKILL = 'SIGKILL'

for (const port of ['9222', '1420', '3210']) {
  let pids
  try {
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    pids = out.split('\n').map(s => Number(s.trim())).filter(n => n > 0)
  } catch {
    continue
  }

  for (const pid of pids) {
    try {
      process.kill(pid, SIGTERM)
      console.log(`[dev-cleanup] SIGTERM ${pid} on :${port}`)
    } catch (e) {
      console.error(`[dev-cleanup] SIGTERM ${pid} failed: ${(e as Error).message}`)
      continue
    }

    // 等待进程终止，超时时强制 SIGKILL
    const start = Date.now()
    let alive = true
    while (Date.now() - start < KILL_WAIT_MS) {
      try {
        process.kill(pid, 0)
        // 进程仍在运行
      } catch {
        alive = false
        break
      }
    }
    if (alive) {
      try {
        process.kill(pid, SIGKILL)
        console.log(`[dev-cleanup] SIGKILL ${pid} on :${port}`)
      } catch (e) {
        console.error(`[dev-cleanup] SIGKILL ${pid} failed: ${(e as Error).message}`)
      }
    }
  }
}
