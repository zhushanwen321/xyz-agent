import { RuntimeServer } from './transport/server.js'
import { createTokenManager } from './transport/token.js'
import { createFileEndpoint } from './transport/file-endpoint.js'
import { SessionService } from './services/session/session-service.js'
import { ConfigService } from './services/config-service.js'
import { ModelService } from './services/model-service.js'

import { BASE_PORT, MAX_PORT } from '@xyz-agent/shared'
import { getDataDir } from '@xyz-agent/shared/paths'
import { initLogger, closeLogger } from './infra/logger.js'

import { ProcessManager } from './infra/pi/process-manager.js'
import { migrateToPiSubdir } from './infra/pi/pi-provider-store.js'
import { getExtensionsDir, getNpmDir, getTmpDir } from './infra/pi/pi-paths.js'
import { PiConfigStore } from './infra/pi/pi-config-store.js'
import { PiSessionStore } from './infra/pi/session-store.js'
import { ModelApiDiscoverer } from './infra/model-api-discoverer.js'
import { NpmGitInstaller } from './infra/installers/npm-git-installer.js'
import { NpmPluginInstaller } from './infra/installers/plugin-installer-adapter.js'
import { ExtensionResolver } from './infra/installers/extension-resolver.js'
import { PiExtensionSettings } from './infra/pi/pi-extension-settings.js'
import { EventAdapter } from './infra/pi/event-adapter.js'
import { FileChangeDiffAdapter } from './infra/pi/file-change-diff-adapter.js'
import { EventInterpreter } from './services/session/event-interpreter.js'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { ExtensionService } from './services/extension-service.js'
import { SkillRegistry } from './services/skill-registry.js'
import { ReloadOrchestrator } from './services/session/reload-orchestrator.js'
import { PluginRegistry } from './services/plugin-service/plugin-registry.js'
import { PluginService } from './services/plugin-service/plugin-service.js'
import { GitService } from './services/git-service.js'
import { GitExecutor } from './infra/git-executor.js'
import { GitInfoReader } from './infra/system/git-info-reader.js'
import { ShellRunner } from './infra/shell-runner.js'
import { WorktreeService } from './services/worktree/worktree-service.js'
import { TerminalService } from './services/terminal/terminal-service.js'
import { FileService } from './services/file-service.js'
import { getAppVersion } from './services/plugin-service/plugin-version-checker.js'
import { FsExecutor } from './infra/fs-executor.js'
import { RecentWorkspacesStore } from './services/workspace/recent-workspaces-store.js'
import { WorkspaceService } from './services/workspace/workspace-service.js'
import { WorkspaceDetector } from './services/worktree/workspace-detector.js'

function parseArgs(): { port: number; projectRoot?: string; host: string; tokenFile?: string } {
  // eslint-disable-next-line no-magic-numbers -- argv[0] is node, argv[1] is script
  const args = process.argv.slice(2)
  const portOffset = Math.max(0, Math.min(parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10) || 0, MAX_PORT - BASE_PORT))
  let port = BASE_PORT + portOffset
  let projectRoot: string | undefined
  // wave1 远程化：host 默认 127.0.0.1（Electron 零回归），远程部署经 --host/env 传 0.0.0.0。
  let host = process.env.XYZ_AGENT_HOST ?? '127.0.0.1'
  let tokenFile: string | undefined = process.env.XYZ_AGENT_TOKEN_FILE
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
    } else if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1]
    } else if (args[i].startsWith('--host=')) {
      host = args[i].split('=')[1]
    } else if (args[i] === '--token-file' && i + 1 < args.length) {
      tokenFile = args[i + 1]
    } else if (args[i].startsWith('--token-file=')) {
      tokenFile = args[i].split('=')[1]
    }
  }
  return { port, projectRoot, host, tokenFile }
}

export async function main(opts?: { host?: string; port?: number; tokenFile?: string; serveWeb?: string }): Promise<void> {
  const parsed = parseArgs()
  // opts（外部编程式调用）优先于 parseArgs（CLI/env），无参时完全走 parseArgs 默认（Electron 零回归）。
  const port = opts?.port ?? parsed.port
  const host = opts?.host ?? parsed.host
  const tokenFile = opts?.tokenFile ?? parsed.tokenFile
  const serveWeb = opts?.serveWeb
  const { projectRoot } = parsed
  const effectiveRoot = projectRoot ?? process.cwd()
  const tokenManager = createTokenManager({ tokenFile })

  // 日志持久化（架构约定 #4）：组合根最早期初始化 + monkey-patch console。
  // 必须在所有 service 创建前（runtime 内 ~140 处裸 console.log 经 patch 自动落盘）。
  // [HISTORICAL] handoff 2026-07-04 P1「pi 静默卡死」——之前日志只在终端，关掉即丢，
  // 无法事后诊断 pi 发了什么事件。initLogger 后所有 console.* 自动 tee 到
  // <dataDir>/logs/runtime-YYYY-MM-DD.log。
  initLogger(getDataDir())

  // Infrastructure
  const pm = new ProcessManager(effectiveRoot)

  // Transport layer
  // wave1 远程化：host/tokenManager 注入 ConnectionManager。serverVersion 用 appVersion
  // （auth.ok 回复携带），在 appInfo 探测前先用 getAppVersion()，后续无更新需求（版本不变）。
  const server = new RuntimeServer(port, projectRoot, { host, tokenManager, serverVersion: getAppVersion() })

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
    thirdPartyDir: getExtensionsDir(),
    npmDir: getNpmDir(),
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
    configStore,
    extensionsDir: getExtensionsDir(),
    npmDir: getNpmDir(),
    tmpDir: getTmpDir(),
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
  const workspaceService = new WorkspaceService(recentWorkspacesStore, new WorkspaceDetector(fs))
  // 启动定期 flush 计时器（全量周期，补充 per-write debounce 500ms）
  recentWorkspacesStore.startFlushTimer()
  const pluginRegistry = new PluginRegistry(effectiveRoot, configDir)
  const pluginInstaller = new NpmPluginInstaller(join(configDir, 'plugins'))
  const pluginService = new PluginService(pluginRegistry, server, {
    configService,
    modelService,
    configDir,
    pluginInstaller,
    broadcastFn: (type, payload) => server.broadcast({ type: type as 'config.sessions', id: `push_${Date.now()}`, payload } as import('@xyz-agent/shared').ServerMessage),
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
      onExtensionUIRequest: (requestId, sid, method, payload) => {
        server.registerExtensionTimeout(sid, requestId, method, payload)
      },
      onBridgeUIRequest: (requestId, sid, method, data) => {
        server.handleBridgeRequest(sid, requestId, method, data)
      },
      onStatusSetUpdate: (payload) => {
        server.handleStatusSetUpdate(payload)
      },
      onContextUpdate: (sid, ctxData) => {
        // session 级状态单一 owner：inputTokens 回写 + tokenCount 写入 + usagePercent 计算 + context.update 广播
        // 全部由 SessionService.applyContextUpdate 负责（contextWindow 经注入的 resolver 解析）。
        // context.update 与 switchModel 的竞态保护（inputTokens 回写打通数据源）也收敛在该方法内。
        // W3：totalTokens 写入 session.tokenCount（原 attachUsageListener 的 tokenCount 回写迁移至此）。
        sessionService.applyContextUpdate(sid, ctxData.inputTokens, ctxData.totalTokens)
      },
      // W3：turn_end 单 turn 副作用——tryPersistLabel 主路径（首 turn 即持久化）。
      // 原 attachUsageListener turn_end 分支迁移至此，经中间事件链路触发。
      onTurnUsage: (sid) => sessionService.handleTurnUsageSideEffects(sid),
      // W3：agent_end 副作用——isGenerating 复位 + tryPersistLabel 兜底。
      // 原 attachUsageListener agent_end 分支迁移至此。不迁移则 session 永远 busy（下条消息被拒）。
      // W4：转发 stopReason 用于 session_end 终态判定（'error'→error，其余→done）。
      onTurnFinalize: (sid, stopReason) => sessionService.handleTurnEndSideEffects(sid, stopReason),
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
      // [ADR-0035] ping 探测连续 3 次失败（180s）判定 pi 进程真死，触发 abort。
      // 复用 sessionService.abort → message-dispatcher.abort 完整路径（client.abort 成功/失败
      // 均有兜底广播 + 复位 isGenerating）。.catch 兜底防 unhandledRejection
      // （abort 内部已 try/catch 广播终态，此处只防极端异常逃逸）。
      onSilentAbort: ({ sessionId: sid }) => {
        sessionService.abort(sid).catch(() => {})
      },
      // [ADR-0035] ping get_state 进程健康探测（替代事件静默检测）。
      // 延迟解析 client：interpreter 在 session 创建时构造，那时 client 可能尚未 spawn。
      // pm（ProcessManager）在本闭包外已创建，getClient 返回 undefined 时计为一次失败
      // （AC-9），但不抛错——client 偶发未就绪不应让 interpret 批次崩溃。
      pingPi: async () => {
        const client = pm.getClient(sessionId)
        if (!client) return undefined
        return client.getState()
      },
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
  // wave2 远程化：FileEndpoint（HTTP /file + signUrl HMAC）。依赖 sessionService（取活跃 cwd 作白名单前缀）
  // + tokenManager（与 WS 认证同源签名），故在此 Phase 创建（sessionService 刚 new 完）。
  // server 构造时 sessionService 尚未存在，故 fileEndpoint 经 setFileEndpoint 延迟绑定：
  //   - HTTP 路由侧：conn.setFileEndpoint（start 监听前生效，回调读 this.fileEndpoint 非构造期捕获）
  //   - RPC 侧：setServices 时读 this.fileEndpoint 注入 FileMessageHandler（file.signUrl）
  const fileEndpoint = createFileEndpoint({ tokenManager, sessionService, bindHost: host })
  server.setFileEndpoint(fileEndpoint)
  // wave4 远程化：server CLI --serve-web <dist> 模式注入静态 Web handler（SPA 资源 + 客户端路由 fallback）。
  // 与 setFileEndpoint 同模式：start() 前注入即生效；serveWeb 缺省（Electron 默认）时不注入，零回归。
  if (serveWeb) {
    const { createStaticWebHandler } = await import('./server/static-web.js')
    server.setStaticHandler(createStaticWebHandler(serveWeb))
  }
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

  // 注入 ConfigService 供 getReplaceSystemPrompt 委托（spawn pi 时透传替换系统提示词）。
  // 与 setModelContextWindowResolver 同模式：避免构造参数破坏 SessionService 的测试调用点。
  sessionService.setConfigService(configService)

  // ── SkillRegistry（W1）：全局 + 项目级 skill 缓存 + chokidar 文件监听 ──
  // 构造在 sessionService 之后（依赖其 getActiveSessionIds/getSessionCwd 窄接口）。
  // initGlobal() 在 server.start 后调（下文），启动期扫描全局 skill 目录挂 watcher。
  const skillRegistry = new SkillRegistry({
    configStore: {
      getSkillPaths: () => configService.getSkillDirs(),
      getPiAgentDir: () => configService.getPiAgentDir(),
    },
    configDir,
    sessionService,
  })

  // TerminalService：drawer 集成终端的 PTY 生命周期管理（node-pty spawn + per-session 映射）。
  // 声明在生命周期挂钩之前（session 销毁回调引用它，TDZ 要求先声明）。
  // 依赖：broker.broadcast（PTY 输出/退出/就绪广播）+ broker.nextPushId（广播消息 id）。
  // Phase 6 接入 configService 读 shell 配置（当前用 $SHELL fallback）。
  const terminalService = new TerminalService({
    broadcast: (msg) => server.broadcast(msg),
    configService,
  })

  // ── W5 ReloadOrchestrator：skill 变动 → 受影响 session pi reload（重扫 skill）────
  // 依赖 sessionService 窄接口（isSessionIdle/promptReload/hasSession），故在 skillRegistry 之后构造。
  // 绑定两条链路：
  //   1. skillRegistry.onChange → onSkillChange（skill 变动触发）
  //   2. sessionService message.complete 广播 → onMessageComplete（running session 生成完成消费 pending 队）
  const reloadOrchestrator = new ReloadOrchestrator({ sessionService })
  skillRegistry.onChange((affectedSessionIds) => {
    void reloadOrchestrator.onSkillChange(affectedSessionIds)
  })
  sessionService.setOnMessageComplete((sid) => {
    void reloadOrchestrator.onMessageComplete(sid)
  })
  // R3：session 删除（主动 delete / 进程异常退出）清 pendingReload 残留。
  // Terminal：同步销毁该 session 绑定的 PTY（kill 进程 + 清 ptyMap）。
  sessionService.setOnSessionDelete((sid) => {
    reloadOrchestrator.clearPending(sid)
    terminalService.destroyPty(sid)
  })

  // 探测 pi 版本（启动时一次，失败不阻塞 —— fallback 'unknown'）
  const piVersion = await pm.getPiVersion()
  const appInfo = { appVersion: getAppVersion(), piVersion }

  // WorktreeService：编排 worktree 创建（bare-workspace / plain-repo 两种模式）。
  // 依赖全注入：GitExecutor（git 子命令）/ ShellRunner（setup 脚本，用 child_process.spawn）/
  // GitInfoReader（当前分支查询）/ ConfigService（worktreeRootDir 配置）/ fs（existsSync，检测 .bare 与目录冲突）。
  // 经 server.setServices 注入到 WorktreeMessageHandler（worktree.create 路由）。
  const worktreeService = new WorktreeService({
    gitExecutor: new GitExecutor(),
    shellRunner: new ShellRunner({ spawn }),
    gitInfoReader: new GitInfoReader(),
    configService,
    fs,
  })

  server.setServices(sessionService, configService, modelService, extensionService, pluginService, gitService, fileService, workspaceService, appInfo, skillRegistry, worktreeService, terminalService)

  // Graceful shutdown on signals
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[runtime] received ${signal}, shutting down...`)
    try {
      recentWorkspacesStore.flushAll()
      recentWorkspacesStore.stopFlushTimer()
      // R1：关闭 SkillRegistry 的 chokidar watcher（global + project），防句柄泄漏阻塞退出。
      skillRegistry.dispose()
      await server.stop()
    // eslint-disable-next-line taste/no-silent-catch -- shutdown: best-effort stop, process exits regardless
    } catch (e) {
      console.error('[runtime] error during shutdown:', e)
    }
    closeLogger()
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

  // SkillRegistry 全局扫描：启动期扫描全局 skill 目录（piAgentDir/skills、configDir/skills、
  // discovery.skillDirs）并挂 chokidar watcher。变动时 300ms debounce 重扫缓存 + 经 onChange
  // 通知上游。必须在 server.start 后调（确保异常不阻塞服务启动）。失败不阻塞（skill 降级空缓存）。
  try {
    await skillRegistry.initGlobal()
    console.log(`[runtime] skill registry initialized (${skillRegistry.getGlobalSkills().length} global skills)`)
  // eslint-disable-next-line taste/no-silent-catch -- skill 扫描失败不阻塞 runtime，UI 降级空列表
  } catch (e) {
    console.error('[runtime] skill registry initialization failed:', e)
  }

  // 自动升级：对开启 autoUpgrade 的 user-installed 扩展批量检查 npm latest 版本，
  // semver.lt 判定后静默升级。失败不阻塞启动（每个扩展独立 try-catch）。
  try {
    const upgradeResults = await extensionService.checkAndAutoUpgrade()
    const upgraded = upgradeResults.filter(r => r.upgraded)
    if (upgraded.length > 0) {
      console.log(`[runtime] auto-upgraded ${upgraded.length} extension(s):`,
        upgraded.map(r => `${r.name} ${r.from ?? '?'}→${r.to ?? '?'}`).join(', '))
    }
  } catch (e) {
    // checkAndAutoUpgrade 内部已 catch 每个扩展，此处是意外错误兜底
    console.warn('[runtime] extension auto-upgrade encountered an error:', e)
  }

  // 插件系统初始化（扫描、激活 onStartupFinished 插件）
  try {
    await pluginService.initialize()
    console.log('[runtime] plugins initialized')
  // eslint-disable-next-line taste/no-silent-catch -- init: plugin failure must not block server
  } catch (e) {
    console.error('[runtime] plugin initialization failed:', e)
  }
}

/**
 * 判定当前进程是否应以「runtime 主入口」身份自动执行 main()。
 *
 * 背景（Bug 1, CRITICAL）：原正则 `/index(\.cjs|\.js|\.ts)?$/` 匹配任何以 index 结尾的
 * 路径，导致 dev 模式跑 `tsx src/server/index.ts`（server CLI 入口）时，server/index.ts
 * import 本模块（`../index.js`），被 import 的本模块因 argv[1]='.../src/server/index.ts'
 * 匹配正则，顶层 main() 误触发，与 server/index.ts 自身的 main() 重复启动 → EADDRINUSE。
 *
 * 修复：正则严格锚定「真正的 runtime 入口」路径片段：
 *  - packaged：`<sep>index.cjs`（dist/runtime/index.cjs，Electron spawn 或 CLI 直跑）
 *  - dev：`<sep>src<sep>index.ts`（tsx src/index.ts，严格匹配 src/index.ts）
 * 用 `<sep>src<sep>index` 锚定（路径分隔符 + src + 分隔符 + index），不会匹配
 * `src/server/index.ts`（CLI bin，会显式调 main()）。
 *
 * 导出纯函数（前缀 _ 表示内部 API）：便于单测，避免动态 import + 模块缓存副作用复杂度。
 *
 * @param scriptPath process.argv[1]（脚本入口路径），可能为 undefined/''
 */
export function _isRuntimeMainEntry(scriptPath: string): boolean {
  if (!scriptPath) return false
  // packaged runtime 入口：.../index.cjs（跨平台分隔符 [\\/]）
  if (/[\\/]index\.cjs$/.test(scriptPath)) return true
  // dev runtime 入口：.../src/index.ts（严格锚定 src/index.ts，排除 src/server/index.ts）
  if (/[\\/]src[\\/]index\.ts$/.test(scriptPath)) return true
  return false
}

// 自动执行入口：仅当本模块被 Electron supervisor / CLI 直接作为 runtime 入口运行时触发。
// 被 server/index.ts（dev）或 server.cjs（packaged）import 时，argv[1] 是 server 入口，
// _isRuntimeMainEntry 返回 false → 跳过顶层 main()，仅暴露 export（server 侧显式调 main）。
const __isRuntimeMainEntry = _isRuntimeMainEntry(process.argv[1] ?? '')

if (__isRuntimeMainEntry) {
  main().catch((e) => {
    console.error('[runtime] fatal:', e)
    process.exit(1)
  })
}
