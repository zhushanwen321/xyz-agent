import { RuntimeServer } from './transport/server.js'
import { SessionService } from './services/session/session-service.js'
import { ConfigService } from './services/config-service.js'
import { ModelService } from './services/model-service.js'

import { BASE_PORT, MAX_PORT } from '@xyz-agent/shared'

import { ProcessManager } from './infra/pi/process-manager.js'
import { migrateToPiSubdir } from './infra/pi/pi-provider-store.js'
import { PiConfigStore } from './infra/pi/pi-config-store.js'
import { PiSessionStore } from './infra/pi/session-store.js'
import { ModelApiDiscoverer } from './infra/model-api-discoverer.js'
import { NpmGitInstaller } from './infra/installers/npm-git-installer.js'
import { ExtensionResolver } from './infra/installers/extension-resolver.js'
import { PiExtensionSettings } from './infra/pi/pi-extension-settings.js'
import { EventAdapter } from './infra/pi/event-adapter.js'
import { FileChangeDiffAdapter } from './infra/pi/file-change-diff-adapter.js'
import { EventInterpreter } from './services/session/event-interpreter.js'
import { join, resolve } from 'node:path'
import { ExtensionService } from './services/extension-service.js'
import { PluginRegistry } from './services/plugin-service/plugin-registry.js'
import { PluginService } from './services/plugin-service/plugin-service.js'
import { GitService } from './services/git-service.js'
import { GitExecutor } from './infra/git-executor.js'
import { GitInfoReader } from './infra/system/git-info-reader.js'
import { FileService } from './services/file-service.js'
import { getAppVersion } from './services/plugin-service/plugin-version-checker.js'
import { FsExecutor } from './infra/fs-executor.js'
import { RecentWorkspacesStore } from './services/workspace/recent-workspaces-store.js'
import { WorkspaceService } from './services/workspace/workspace-service.js'

function parseArgs(): { port: number; projectRoot?: string } {
  // eslint-disable-next-line no-magic-numbers -- argv[0] is node, argv[1] is script
  const args = process.argv.slice(2)
  const portOffset = Math.max(0, Math.min(parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10) || 0, MAX_PORT - BASE_PORT))
  let port = BASE_PORT + portOffset
  let projectRoot: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10)
      if (isNaN(parsed)) {
        console.error(`[runtime] invalid --port value: ${args[i + 1]}`)
        process.exit(1)
      }
      port = parsed
    } else if (args[i].startsWith('--port=')) {
      const parsed = parseInt(args[i].split('=')[1], 10)
      if (isNaN(parsed)) {
        console.error(`[runtime] invalid --port value: ${args[i].split('=')[1]}`)
        process.exit(1)
      }
      port = parsed
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
  const effectiveRoot = projectRoot ?? process.cwd()

  // Infrastructure
  const pm = new ProcessManager(effectiveRoot)

  // Transport layer
  const server = new RuntimeServer(port, projectRoot)

  // ── Phase 1: create all service instances (no cross-service deps at construction time) ──

  // 一次性迁移：将旧路径下的配置/session/agent 文件移到新的 xyz-pi 目录结构。
  // 原为 pi-config-bridge 的 import 副作用，现改为组合根显式调用（启动时序显式化）。
  // 必须在首次配置读取（readModels/readSettings/migrateSettingsSkillsToDiscovery）前完成。
  // 幂等：新路径已存在文件则跳过。
  migrateToPiSubdir()

  const configStore = new PiConfigStore()
  const sessionStore = new PiSessionStore()
  const modelSource = new ModelApiDiscoverer()
  const extensionInstaller = new NpmGitInstaller()
  const extensionResolver = new ExtensionResolver({
    settingsDir: configStore.getPiAgentDir(),
    thirdPartyDir: join(configStore.getPiAgentDir(), 'extensions'),
  })
  // IExtensionSettings port 的 infra 实现：经 pi-settings-store 统一读写 settings.json（D17）。
  // 构造时对齐 settings 路径到 pi agent 目录，保证 model 域与 extension 域读写同一文件。
  const extensionSettings = new PiExtensionSettings(configStore.getPiAgentDir())
  const extensionService = new ExtensionService({
    settingsDir: configStore.getPiAgentDir(),
    projectRoot: effectiveRoot,
    installer: extensionInstaller,
    resolver: extensionResolver,
    extensionSettings,
  })
  const configService = new ConfigService(effectiveRoot, configStore)
  // ADR-0020 §1 一次性迁移：旧版本 skill 路径存在 settings.json.skills，
  // 首启用时提升为 discovery.json SSOT。幂等：discovery 已有数据则 no-op。
  configService.migrateSettingsSkillsToDiscovery()
  const modelService = new ModelService(modelSource)

  // ── Phase 2: create services that reference other services via closures / deps ──
  // PluginService.deps are all optional and only used at runtime (initialize / event handling),
  // so sessionService can be wired in after construction.
  const configDir = configService.getConfigDir()
  // RecentWorkspacesStore：最近工作区持久化（WriteBackCache 固定 partition 'global'）。
  // configDir 由 configService 动态推导，无硬编码路径（INV-5）。
  const recentWorkspacesStore = new RecentWorkspacesStore(configDir)
  const workspaceService = new WorkspaceService(recentWorkspacesStore)
  // 启动定期 flush 计时器（全量周期，补充 per-write debounce 500ms）
  recentWorkspacesStore.startFlushTimer()
  const pluginRegistry = new PluginRegistry(effectiveRoot, configDir)
  const pluginService = new PluginService(pluginRegistry, server, {
    configService,
    modelService,
    configDir,
    broadcastFn: (type, payload) => server.broadcast({ type: type as 'session.list', id: `push_${Date.now()}`, payload } as import('@xyz-agent/shared').ServerMessage),
  })

  // ── R1 重构：EventAdapter（infra 纯翻译）+ EventInterpreter（service 编排）──
  // adapterFactory closure captures pluginService / sessionService / server by reference.
  // All are already assigned above — no temporal coupling.
  // Note: onContextUpdate also references `sessionService` (assigned below) as a self-reference —
  // the interpreter queries its owning session's data. createAdapter is only called at session
  // creation time, so sessionService is always set by then.
  //
  // fileChangeDiff：infra 纯函数的 port 实现（无状态，全局单例复用）。
  const fileChangeDiff = new FileChangeDiffAdapter()
  const createAdapter = (sessionId: string, send: (msg: import('@xyz-agent/shared').ServerMessage) => void, cwd?: string) => {
    // EventInterpreter 持有业务态（currentMessageId/statusBaseline/writeContents）+ 业务回调，
    // 消费 EventAdapter 翻译出的 PiTranslatedEvent[]，执行 hook / diff / 回写 / 路由副作用。
    const interpreter = new EventInterpreter(sessionId, {
      // #8 G1 cwd：注入 session cwd（write 工具 added/modified 判定 + agent_end git 对账用）。
      // SessionService.initializeManagedSession 调用时传入（该处已有 cwd 参数）。
      cwd,
      send,
      fileChangeDiff,
      onExtensionUIRequest: (requestId, sid, method) => {
        server.registerExtensionTimeout(sid, requestId, method)
      },
      onBridgeUIRequest: (requestId, sid, method, data) => {
        server.handleBridgeRequest(sid, requestId, method, data)
      },
      onStatusSetUpdate: (payload) => {
        server.handleStatusSetUpdate(payload)
      },
      onContextUpdate: (sid, ctxData) => {
        // session 级状态单一 owner：inputTokens 回写 + usagePercent 计算 + context.update 广播
        // 全部由 SessionService.applyContextUpdate 负责（contextWindow 经注入的 resolver 解析）。
        // context.update 与 switchModel 的竞态保护（inputTokens 回写打通数据源）也收敛在该方法内。
        sessionService.applyContextUpdate(sid, ctxData.inputTokens)
      },
      onThinkingLevelChanged: (sid, level) => {
        // pi 切模型 / 用户手切档位后推 thinking_level_changed 事件。
        // 回写 session 缓存，使后续 broadcastSessionState 读到真值（而非 undefined）。
        sessionService.setThinkingLevelCache(sid, level)
      },
      executeHooks: (hookType, context) => pluginService.executeHooks(hookType, {
        pluginId: '',
        hookType: hookType as import('./services/plugin-service/plugin-types.js').HookType,
        data: { ...context, sessionId },
        timestamp: Date.now(),
      }),
    })
    // EventAdapter：纯翻译器，把翻译结果喂给 interpreter 编排。
    return new EventAdapter(sessionId, (events) => interpreter.interpret(events))
  }

  const sessionService = new SessionService(
    pm,
    server,
    createAdapter,
    effectiveRoot,
    extensionService,
    configStore,
    sessionStore,
    // IGitInfoReader：infra 实现（rev-parse 查询 + .git 文件判 worktree + 缓存），注入 session 摘要链。
    // 与 GitExecutor 同为 git 域 infra，但语义不同（窄查询 vs 通用 exec）——故独立 port（services/ports/git-info.ts）。
    new GitInfoReader(),
    workspaceService,
  )

  // ── Phase 3: wire cross-service runtime deps ──
  pluginService.setSessionService(sessionService)
  // GitService：composition root 注入 infra executor（数组参数防注入）+ sessionService（取 cwd）。
  // 经 server.setServices 注入到 GitMessageHandler（git.* 路由）。
  const gitService = new GitService({ sessionService, executor: new GitExecutor() })
  // FileService：对称注入 infra FsExecutor（node:fs/promises adapter）+ sessionService（取 cwd 做越界守门）。
  // 经 server.setServices 注入到 FileMessageHandler（file.tree/expand/write.* 路由）。
  // allowedReadDirs：file.read 的 BC-3 白名单（~/.agents/skills、piAgentDir/skills、piAgentDir/npm），
  //   从 configService 算出传入（FileService 不直接依赖 configService，保持单一职责）。
  const piAgentDir = configService.getPiAgentDir()
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const fileService = new FileService({
    sessionService,
    executor: new FsExecutor(),
    allowedReadDirs: [
      resolve(homeDir, '.agents/skills'),
      resolve(piAgentDir, 'skills'),
      resolve(piAgentDir, 'npm'),
    ],
  })

  modelService.setServices(sessionService, configService, server)

  // SessionService 是 session 级状态（modelId/thinkingLevel/inputTokens/usagePercent）单一 owner，
  // 需读 model contextWindow 才能 switchModel / applyContextUpdate 时算 usagePercent。
  // 直接注入 modelService/configService 会形成依赖环（modelService 反过来依赖 sessionService），
  // 故注入窄 resolver（纯数据查询，等价 configService.listProviders + modelService.aggregateModels）。
  sessionService.setModelContextWindowResolver((provider, modelId) => {
    const providers = configService.listProviders()
    const models = modelService.aggregateModels(providers)
    const model = models.find(m => m.providerId === provider && m.id === modelId)
    return model?.contextWindow ?? 0
  })

  // 探测 pi 版本（启动时一次，失败不阻塞 —— fallback 'unknown'）
  const piVersion = await pm.getPiVersion()
  const appInfo = { appVersion: getAppVersion(), piVersion }

  server.setServices(sessionService, configService, modelService, extensionService, pluginService, gitService, fileService, workspaceService, appInfo)

  // Graceful shutdown on signals
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[runtime] received ${signal}, shutting down...`)
    try {
      recentWorkspacesStore.flushAll()
      recentWorkspacesStore.stopFlushTimer()
      await server.stop()
    // eslint-disable-next-line taste/no-silent-catch -- shutdown: best-effort stop, process exits regardless
    } catch (e) {
      console.error('[runtime] error during shutdown:', e)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // [HISTORICAL] unhandledRejection 兜底：防止 async 异常逃逸导致 Node.js 进程崩溃。
  // 之前 server.ts 的 ws.on('message') 回调中没有 await handleMessage()，
  // 导致 async 错误变成 unhandled rejection，Node.js 16+ 默认行为是终止进程。
  // 虽然 server.ts 已修复（加了 .catch），这里作为最后防线保留。
  process.on('unhandledRejection', (reason) => {
    console.error('[runtime] *** UNHANDLED REJECTION *** (should not happen):', reason)
  })

  await server.start()
  console.log('[runtime] ready')

  // 插件系统初始化（扫描、激活 onStartupFinished 插件）
  try {
    await pluginService.initialize()
    console.log('[runtime] plugins initialized')
  // eslint-disable-next-line taste/no-silent-catch -- init: plugin failure must not block server
  } catch (e) {
    console.error('[runtime] plugin initialization failed:', e)
  }
}

main().catch((e) => {
  console.error('[runtime] fatal:', e)
  process.exit(1)
})
