/**
 * index.ts（runtime 组合根）改接点骨架（code-wiring-cheatsheet §C）。
 *
 * 真实文件 src-electron/runtime/src/index.ts 改动：
 * 1. Phase 1：const workspaceStore = new RecentWorkspacesStore(configService.getConfigDir())
 * 2. Phase 1：const workspaceService = new WorkspaceService(workspaceStore)
 * 3. Phase 2：SessionService 构造加 workspaceService 末尾参数（注入 lifecycle + dispatcher）
 * 4. Phase 3：server.setServices(..., workspaceService)
 * 5. shutdown：workspaceStore.flushAll()（graceful flush 落盘）
 * 6. 启动后：workspaceStore.startFlushTimer()（全量周期 flush 兜底）
 *
 * architecture §2：WorkspaceService 与 SessionService 平级非嵌套（同处组合根创建）。
 * architecture §6 / §9 INV-5：configService.getConfigDir() 动态路径（pre-commit 守护）。
 */
import { RecentWorkspacesStore } from '../services/workspace/recent-workspaces-store.js'
import { WorkspaceService } from '../services/workspace/workspace-service.js'
import { WorkspaceMessageHandler } from '../transport/workspace-message-handler.js'
import { getConfigDir } from '../../_deps.js'

/** 组合根接线 stub（验证创建 + 注入链路签名，不展开 server/sessionService 既有构造）。 */
export function wireWorkspaceDomain(): {
  store: RecentWorkspacesStore
  service: WorkspaceService
  handler: WorkspaceMessageHandler
} {
  // Phase 1：创建 store（configDir 动态路径，INV-5）+ service
  const store = new RecentWorkspacesStore(getConfigDir())
  const service = new WorkspaceService(store)

  // Phase 3：handler 装配（setServices 注入，ctx 由 server.ts 提供 messaging + workspaceService）
  const handler = new WorkspaceMessageHandler({
    send: () => { throw new Error('server.broker.send stub') },
    sendError: () => { throw new Error('server.broker.sendError stub') },
    reply: () => { throw new Error('server.broker.reply stub') },
    workspaceService: service,
  })

  // 真实 index.ts：server.setServices(..., service)
  // 真实 index.ts：sessionService 构造传 workspaceService
  // 真实 index.ts：workspaceStore.startFlushTimer()（启动后）
  // 真实 shutdown：workspaceStore.flushAll()（graceful flush）
  return { store, service, handler }
}
