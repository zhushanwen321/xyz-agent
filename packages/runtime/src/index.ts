import { RuntimeServer } from './transport/server.js'
import { SessionService } from './services/session/session-service.js'
import { ConfigService } from './services/config-service.js'
import { AuthService } from './services/auth/auth-service.js'
import { AuthStorage } from './services/auth/auth-storage.js'
import { PresetService } from './services/preset-service.js'
import { ModelService } from './services/model-service.js'

import { BASE_PORT, MAX_PORT } from '@xyz-agent/shared'
import { getDataDir } from '@xyz-agent/shared/paths'
import { initLogger, closeLogger } from './infra/logger.js'

import { ProcessManager } from './infra/pi/process-manager.js'
import { migrateToPiSubdir, getProviderConfig, upsertProvider, cleanLeakedPackages, sanitizeInvalidProviders } from './infra/pi/pi-provider-store.js'
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
import { sessionMetaCache } from './services/session/session-meta-cache.js'
import { join, resolve, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { ExtensionService } from './services/extension-service.js'
import { SkillRegistry } from './services/skill-registry.js'
import { ReloadOrchestrator } from './services/session/reload-orchestrator.js'
import { PluginRegistry } from './services/plugin-service/plugin-registry.js'
import { PluginService } from './services/plugin-service/plugin-service.js'
import { GitService } from './services/git-service.js'
import { GitExecutor } from './infra/git-executor.js'
import { GitStateService } from './services/git/git-state-service.js'
import { createContextWindowResolver } from './services/model-context-cache.js'
import { GitInfoReader } from './infra/system/git-info-reader.js'
import { ShellRunner } from './infra/shell-runner.js'
import { WorktreeService } from './services/worktree/worktree-service.js'
import { TerminalService } from './services/terminal/terminal-service.js'
import { QuotaService } from './services/quota-service.js'
import { FileService } from './services/file-service.js'
import { getSkillDirs } from './infra/pi/discovery-store.js'
import { expandHome } from './utils/path-utils.js'
import { HandoffService } from './services/handoff-service.js'
// MessageBus（wave:bus-core 产物）：per-session 消息广播核心。
// wave:runtime-wiring 在组合根创建单例并注入到 SessionService（session 级消息单通道走
// bus.publish——wave:perf-w09 D1-2 删双写后唯一通道）+
// RuntimeServer（subscribe/unsubscribe RPC handler + ConnectionManager.onClose → unsubscribeAll）。
// 保留 re-export 供外部消费（renderer-subscribe wave 等可能 import 类型）。
import { MessageBus } from './services/message-bus/message-bus.js'
export { MessageBus } from './services/message-bus/message-bus.js'
export type { BusClient, SessionBusState } from './services/message-bus/types.js'
import { getAppVersion } from './services/plugin-service/plugin-version-checker.js'
import { FsExecutor } from './infra/fs-executor.js'
import { RecentWorkspacesStore } from './services/workspace/recent-workspaces-store.js'
import { ProjectStore } from './services/project/project-store.js'
import { WorkspaceService } from './services/workspace/workspace-service.js'
import { WorkspaceDetector } from './services/worktree/workspace-detector.js'
// D8-1（perf W29）：后台初始化序列（listen 后执行）——独立模块承载使「migrateBuiltin →
// autoUpgrade 顺序」可 spy 断言（06 §5 门禁），组合根只负责构造与注入。
import { runStartupBackgroundInit } from './services/startup-background-init.js'

function parseArgs(): { port: number; projectRoot?: string; builtinPluginsDir?: string } {
  // eslint-disable-next-line no-magic-numbers -- argv[0] is node, argv[1] is script
  const args = process.argv.slice(2)
  const portOffset = Math.max(0, Math.min(parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10) || 0, MAX_PORT - BASE_PORT))
  let port = BASE_PORT + portOffset
  let projectRoot: string | undefined
  let builtinPluginsDir: string | undefined
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
    } else if (args[i] === '--builtin-plugins-dir' && i + 1 < args.length) {
      builtinPluginsDir = args[i + 1]
    } else if (args[i].startsWith('--builtin-plugins-dir=')) {
      builtinPluginsDir = args[i].split('=')[1]
    }
  }
  return { port, projectRoot, builtinPluginsDir }
}

/**
 * 解析 WS auth token（S1-W1，spec §3.3 D4）：优先 env XYZ_RUNTIME_TOKEN（Electron 主进程
 * spawn 时注入），缺失时 fallback 读 <dataDir>/runtime-token 文件（CLI / 脚本消费的通道）。
 * 两者都缺失 → 返回 null（fail-closed：ConnectionManager 拒绝全部 WS 连接）。
 *
 * 独立函数而非内联：解析链与 fail-closed 语义是传输安全的关键路径，后续 D4 校验期
 * 单测可直接 import 此函数探针（env 注入 / 文件注入 / 双缺失三态）。
 */
function resolveRuntimeToken(): string | null {
  const envToken = process.env.XYZ_RUNTIME_TOKEN
  if (envToken && envToken.trim().length > 0) return envToken.trim()
  try {
    const fileToken = fs.readFileSync(join(getDataDir(), 'runtime-token'), 'utf-8').trim()
    if (fileToken.length > 0) return fileToken
  } catch {
    // token 文件不存在/不可读 → 落到下方 fail-closed warning（正常 dev 直跑场景，
    // scripts/verify-*.sh 会显式注入 env 或写 token 文件）
  }
  console.warn('[runtime] WS auth token unavailable (XYZ_RUNTIME_TOKEN env / <dataDir>/runtime-token both missing) — fail-closed: ALL WebSocket connections will be rejected')
  return null
}

async function main(): Promise<void> {
  const { port, projectRoot, builtinPluginsDir } = parseArgs()
  const effectiveRoot = projectRoot ?? process.cwd()
  // perf W29（D8-1）启动耗时分解探针（06 §5 m-7）：listen 前各段打点，
  // 输出进日志文件供 D8 价值评估（基线实测：getPiVersion 1.1-1.3s 主导 listen 延迟）。
  const tStart = performance.now()

  // 日志持久化（架构约定 #4）：组合根最早期初始化 + monkey-patch console。
  // 必须在所有 service 创建前（runtime 内 ~140 处裸 console.log 经 patch 自动落盘）。
  // [HISTORICAL] handoff 2026-07-04 P1「pi 静默卡死」——之前日志只在终端，关掉即丢，
  // 无法事后诊断 pi 发了什么事件。initLogger 后所有 console.* 自动 tee 到
  // <dataDir>/logs/runtime-YYYY-MM-DD.log。
  initLogger(getDataDir())

  // S1-W1：token 解析在 initLogger 之后（fail-closed warning 落盘）、server 构造之前。
  const runtimeToken = resolveRuntimeToken()

  // Infrastructure
  const pm = new ProcessManager(effectiveRoot)

  // Transport layer
  const server = new RuntimeServer(port, projectRoot, runtimeToken)

  // MessageBus 单例（wave:runtime-wiring）：per-session 消息广播核心。
  // 在 server 构造后、setServices 前创建并注入——server 的 ConnectionManager.onDisconnect
  // 回调经 setMessageBus 拿到引用，setServices 装配 sessionHandler 时读 server.messageBus。
  // 默认 ring 容量 1000（bus-core DEFAULT_RING_CAPACITY，D4 决策）。
  const messageBus = new MessageBus()
  server.setMessageBus(messageBus)

  // ── Phase 1: create all service instances (no cross-service deps at construction time) ──

  // 一次性迁移：将旧路径下的配置/session/agent 文件移到新的 xyz-pi 目录结构。
  // 原为 pi-config-bridge 的 import 副作用，现改为组合根显式调用（启动时序显式化）。
  // 必须在首次配置读取（readModels/readSettings/migrateSettingsSkillsToDiscovery）前完成。
  // 幂等：新路径已存在文件则跳过。
  // D8-1（perf W29）：三个同步迁移保持 listen 前——「首次配置读取前」硬约束（06 §3.3 证据）。
  const tSyncMigrations = performance.now()
  migrateToPiSubdir()
  // 清理 settings.json.packages 中泄漏到 pi 全局目录的相对路径项（架构约定 #1 隔离保障）
  cleanLeakedPackages()
  // 剔除 models.json 里的空壳 provider（五字段全缺）：空壳导致 bundled pi 0.80.3 严格校验时
  // 整个 models.json 加载失败（Model not found）。系统 pi 0.83 容错但 bundled 不容错，
  // 重装后必现。sanitize 让 xyz-agent 自愈这种脏数据（如外部脚本写入的测试 fixture）。
  sanitizeInvalidProviders()

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
  // AuthStorage（OAuth 路径 B）：auth.json 在 pi agent 目录（与 models.json 同路径，与 pi 读取侧一致）。
  // ConfigService 用它做 I9 清理①（setProvider 保存 apiKey 时清 auth.json oauth）+ I8（deleteProvider 清 auth.json）。
  const authStorage = new AuthStorage(join(configStore.getPiAgentDir(), 'auth.json'))
  const configService = new ConfigService(effectiveRoot, configStore, authStorage)
  // ADR-0021 §1 一次性迁移：旧版本 skill 路径存在 settings.json.skills，
  // 首启用时提升为 discovery.json SSOT。幂等：discovery 已有数据则 no-op。
  // D8-1 位置判断（perf W29，06 §5 m-7 结论）：保持 listen 前同步执行——
  // fileService 构造时 allowedReadDirs 读 getSkillDirs()（discovery.json），
  // 迁移后置会让首次升级启动的 skill 容器漏出 file.read 白名单（认知回归）。
  // 成本：幂等 no-op 仅两次 JSON 读，实测 <1ms，非 listen 延迟主导项。
  configService.migrateSettingsSkillsToDiscovery()
  // PresetService（pi-launch-presets 设计 §8.1）：独立 service，与 ConfigService 对称。
  // 依赖 configStore（pi-presets.json 路径推导）+ extensionService（resolve 用 builtin/scanExtensions）。
  // 组合根构造，经 setPresetService 注入 SessionService（与 setConfigService 同模式）。
  const presetService = new PresetService(configStore, extensionService)
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
  // ProjectStore：project 列表持久化（D14，2026-08-04 迁 runtime projects.json，
  // 与 recent-workspaces 同模式；前端 localStorage 仅首启迁移源）。
  const projectStore = new ProjectStore(configDir)
  // S1-W4（D3）：built-in 插件目录显式注入（主进程 spawn 时传 --builtin-plugins-dir）。
  // 提供时 registry 只扫该目录、不做 cwd 探测（防用户 repo 预置目录冒充 built-in）；
  // 缺失（dev 直跑/测试）时 registry 回退探测链并落 warning。
  const pluginRegistry = new PluginRegistry(effectiveRoot, configDir, builtinPluginsDir)
  const pluginInstaller = new NpmPluginInstaller(join(configDir, 'plugins'))
  const pluginService = new PluginService(pluginRegistry, server, {
    configService,
    modelService,
    configDir,
    pluginInstaller,
    broadcastFn: (type, payload) => server.broadcast({ type: type as 'config.sessions', id: `push_${Date.now()}`, payload } as import('@xyz-agent/shared').ServerMessage),
  })
  // wave:perf-w09（接口收敛 wire 归位）：plugin 的 session 级广播点（plugin:viewUpdate /
  // plugin:uiRequest）接 bus 定向发布。原在 server.setServices 内 wire（wave:perf-w08 的
  // 过渡位置），services 间依赖注入统一归组合根——与下方 sessionService.setMessageBus 同模式。
  pluginService.setMessageBus(messageBus)

  // ── R1 重构：EventAdapter（infra 纯翻译）+ EventInterpreter（service 编排）──
  // adapterFactory closure captures pluginService / sessionService / server by reference.
  // All are already assigned above — no temporal coupling.
  // Note: onContextUpdate also references `sessionService` (assigned below) as a self-reference —
  // the interpreter queries its owning session's data. createAdapter is only called at session
  // creation time, so sessionService is always set by then.
  //

  // GitExecutor + GitStateService：git 状态统一读取基础设施（perf W16，03 D4-1）。
  // 在 fileChangeDiff 之前创建——W18 起 FileChangeDiffAdapter 的采集（snapshotStatus/numstat）
  // 委托 GitStateService；GitService（下方，依赖 sessionService）与 GitMessageHandler 的
  // 写操作失效共享同一实例（in-flight 单飞 + sessionId+cwd TTL 缓存 + 非仓库负缓存）。
  const gitExecutor = new GitExecutor()
  const gitStateService = new GitStateService({ executor: gitExecutor })

  const fileChangeDiff = new FileChangeDiffAdapter(gitStateService)
  const createAdapter = (sessionId: string, send: (msg: import('@xyz-agent/shared').ServerMessage) => void, cwd?: string) => {
    // EventInterpreter 持有业务态（currentMessageId/writeContents/diffChain 帧序三件套）+ 业务回调，
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
      onTurnFinalize: (sid, stopReason) => {
        sessionService.handleTurnEndSideEffects(sid, stopReason)
      },
      onThinkingLevelChanged: (sid, level) => {
        // pi 切模型 / 用户手切档位后推 thinking_level_changed 事件。
        // 回写 session 缓存，使后续 broadcastSessionState 读到真值（而非 undefined）。
        sessionService.setThinkingLevelCache(sid, level)
      },
      onSessionRenamed: (sid, name) => {
        // pi extension auto-rename (session_info_changed) 事件到达时。
        // 同步更新内存态 session.label（唯一数据源）+ 缓存（扫描路径兜底）。
        sessionService.setLabelCache(sid, name ?? '')
        sessionMetaCache.setLabel(sid, name ?? '')
      },
      executeHooks: (hookType, context) => pluginService.executeHooks(hookType, {
        pluginId: '',
        hookType: hookType as import('./services/plugin-service/plugin-types.js').HookType,
        data: { ...context, sessionId },
        timestamp: Date.now(),
      }),
      // [ADR-0047] ping 探测连续 3 次失败（180s）判定 pi 进程真死，触发 abort。
      // 复用 sessionService.abort → message-dispatcher.abort 完整路径（client.abort 成功/失败
      // 均有兜底广播 + 复位 isGenerating）。.catch 兜底防 unhandledRejection
      // （abort 内部已 try/catch 广播终态，此处只防极端异常逃逸）。
      onSilentAbort: ({ sessionId: sid }) => {
        sessionService.abort(sid).catch(() => {})
      },
      // M4 compaction 事件驱动：interpreter 从 compaction_start/end 唯一置位/复位
      // runtime active.isCompacting（sendPrompt/sendBash 预检互斥依据）。与原 dispatcher
      // 手动路径置位对称——事件驱动后 dispatcher 不再置位，复位责任转移到 interpreter（三路对称）。
      // getSession 返回 IManagedSessionView，isCompacting 为可写字段（types.ts 注释明言子模块可读写）。
      onCompactingStateChange: (sid, v) => {
        const s = sessionService.getSession(sid)
        if (s) s.isCompacting = v
      },
      // [ADR-0047] ping get_state 进程健康探测（替代事件静默检测）。
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
    // messageBus：注入 dispatcher 的 session 级事件通道（wave:perf-w09 D1-2 后单通道——
    // dispatcher 只依赖 publish 抽象，bus.publish 是唯一出口，broker 依赖已随接口收敛删除）。
    messageBus,
  )

  // HandoffService：fast-handoff 编排层。依赖 sessionService（create/sendMessage/abort/getHistory/getSession）
  // + server（IMessageBroker 广播）+ pm（getClient 取源 session pi 句柄）。与 GitService/FileService 同模式
  // （经 server.setServices 注入到 handler），但额外经 onTurnFinalize opt 接到 EventInterpreter（见上方闭包）。
  //
  // BLOCKER 2 / WARNING nextPushId：注入 broadcastSessionList + nextPushId（来自 broker），
  // 与 session-message-handler 的 create/fork/delete/rename 一致。
  // handoffService 经 server.setServices 注入到 handler（session-message-handler.ts）。
  const handoffService = new HandoffService({
    sessionService,
    broker: server,
    broadcastSessionList: () => server.broadcastSessionList(),
    nextPushId: () => server.nextPushId(),
  })

  // ── Phase 3: wire cross-service runtime deps ──
  pluginService.setSessionService(sessionService)
  // GitService：composition root 注入 infra executor（数组参数防注入）+ sessionService（取 cwd）。
  // 经 server.setServices 注入到 GitMessageHandler（git.* 路由）。
  // perf W17（03 D4-4 U2）：gitService.getStatus 收编走 GitStateService（上方已创建，
  // 与 FileChangeDiffAdapter 共享同一实例——file_changes 采集与面板状态读取共享单飞/负缓存）。
  const gitService = new GitService({ sessionService, executor: gitExecutor, stateService: gitStateService })
  // FileService：对称注入 infra FsExecutor（node:fs/promises adapter）+ sessionService（取 cwd 做越界守门）。
  // 经 server.setServices 注入到 FileMessageHandler（file.tree/expand/write.* 路由）。
  // allowedReadDirs：file.read 的 BC-3 白名单（~/.agents/skills、piAgentDir/skills、piAgentDir/npm），
  //   从 configService 算出传入（FileService 不直接依赖 configService，保持单一职责）。
  const piAgentDir = configService.getPiAgentDir()
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''

  // AuthService（OAuth 路径 B）：编排 device/callback flow 拿 token 写 auth.json。
  // 依赖 authStorage + builtin oauthConfig（configService.listBuiltinProviders）+ broadcast/nextPushId
  // （server/broker）+ clearApiKey（I9 清理②：OAuth 成功清 models.json apiKey，防 both provider 凭据冲突）。
  // 经 server.setServices 注入到 handler（settings-message-handler 的 config.oauthLogin/oauthCancel）。
  const authService = new AuthService({
    authStorage,
    getOAuthConfig: (providerId) => configService.listBuiltinProviders().find(p => p.id === providerId)?.oauthConfig,
    broadcast: (msg) => server.broadcast(msg),
    nextPushId: () => server.nextPushId(),
    clearApiKey: (providerId) => {
      const existing = getProviderConfig(providerId)
      if (!existing || !('apiKey' in existing)) return
      const { apiKey: _removed, ...rest } = existing
      upsertProvider(providerId, rest)
    },
  })
  const fileService = new FileService({
    sessionService,
    executor: new FsExecutor(),
    // allowedReadDirs：file.read 白名单。除三个固定目录外，动态合并用户在 discovery.json
    // 配置的 skill 目录（globalPaths，如 ~/.claude/skills）——否则这些 skill 的 SKILL.md
    // 既不在 cwd 内（cwd 守门拒）也不在固定白名单内（白名单拒），两路 file.read 都失败，
    // drawer 误显示「该 skill 无文档正文」。projectPaths（相对 cwd）走 cwd 守门，不需进白名单。
    // expandHome 处理 globalPaths 里 ~/ 开头路径；filter(isAbsolute) 丢弃相对路径（白名单需绝对路径）。
    allowedReadDirs: [
      resolve(homeDir, '.agents/skills'),
      resolve(piAgentDir, 'skills'),
      resolve(piAgentDir, 'npm'),
      ...getSkillDirs()
        .map((d) => expandHome(d))
        .filter((d) => isAbsolute(d))
        .map((d) => resolve(d)),
    ],
  })

  modelService.setServices(sessionService, configService, server)

  // SessionService 是 session 级状态（modelId/thinkingLevel/inputTokens/usagePercent）单一 owner，
  // 需读 model contextWindow 才能 switchModel / applyContextUpdate 时算 usagePercent。
  // 直接注入 modelService/configService 会形成依赖环（modelService 反过来依赖 sessionService），
  // 故注入窄 resolver（纯数据查询，等价 configService.listProviders + modelService.aggregateModels）。
  // 微项 5（perf W17）：resolver 经 createContextWindowResolver 加 TTL 缓存——原实现每次
  // context.update / switchModel 都全量重算 listProviders + aggregateModels（streaming 期高频），
  // 缓存后聚合每 5s 至多一次，查询热点只剩 find。
  sessionService.setModelContextWindowResolver(
    createContextWindowResolver({
      listProviders: () => configService.listProviders(),
      aggregateModels: (providers) => modelService.aggregateModels(providers),
    }),
  )

  // 注入 ConfigService 供 getReplaceSystemPrompt 委托（spawn pi 时透传替换系统提示词）。
  // 与 setModelContextWindowResolver 同模式：避免构造参数破坏 SessionService 的测试调用点。
  sessionService.setConfigService(configService)
  // 注入 PresetService 供 getLaunchPresetOptions 委托（spawn pi 时按 launch preset 构建 args）。
  // 与 setConfigService 同模式（pi-launch-presets 设计 §8.1 + §4.3）。
  sessionService.setPresetService(presetService)
  // 注入 MessageBus（wave:runtime-wiring）：session 级消息（带 sessionId payload）单通道走
  // bus.publish（wave:perf-w09 D1-2 删双写后唯一通道；bus 负责 per-session seq 分配 + ring
  // buffer + 订阅者广播），session 销毁时 removeSessionEntry 调 bus.clearSession。
  // 与 setConfigService 同模式（setter 注入，避免破坏 SessionService 测试调用点）。
  // bus 两条注入通道（构造参数 + 本 setter）组合根都走：构造参数经 SessionService 构造器
  // 传导给 dispatcher；setter 内部同步回填 dispatcher（仅走 setter 路径时保证 dispatcher
  // 不持 undefined bus，见 session-service.setMessageBus）。
  sessionService.setMessageBus(messageBus)

  // ── SkillRegistry（W1）：全局 + 项目级 skill 缓存 + chokidar 文件监听 ──
  // 构造在 sessionService 之后（依赖其 getActiveSessionIds/getSessionCwd 窄接口）。
  // initGlobal() 在 server.start 后调（下文），启动期扫描全局 skill 目录挂 watcher。
  const skillRegistry = new SkillRegistry({
    configStore: {
      getSkillPathScopes: () => configService.getSkillPathScopes(),
      getPiAgentDir: () => configService.getPiAgentDir(),
    },
    configDir,
    sessionService,
  })

  // TerminalService：drawer 集成终端的 PTY 生命周期管理（node-pty spawn + per-session 映射）。
  // 声明在生命周期挂钩之前（session 销毁回调引用它，TDZ 要求先声明）。
  // wave:perf-w07（D1-1 / R-05）：发布通道从 broker.broadcast 改为 MessageBus——terminal 三类
  // 消息按 topicOf 分类（data=transient 直传、alive/exit=stream 入 ring）定向推给订阅该 sid 的 ws。
  // publish-only 不叠加 broadcast：terminal.data 无 seq，叠加盲广播会被已订阅 renderer 双 dispatch
  // （终端输出重复渲染），见 TerminalServiceDeps.publish 注释。W09（D1-2）删双写已落地——
  // bus.publish 是 session 级消息唯一通道，publish-only 即终态语义（非过渡态）。
  // Phase 6 接入 configService 读 shell 配置（当前用 $SHELL fallback）。
  const terminalService = new TerminalService({
    publish: (sid, msg) => messageBus.publish(sid, msg),
    configService,
  })

  // ── W5 ReloadOrchestrator：skill 变动 → 受影响 session pi reload（重扫 skill）────
  // 依赖 sessionService 窄接口（isSessionIdle/promptReload/hasSession），故在 skillRegistry 之后构造。
  // 绑定两条链路：
  //   1. skillRegistry.onChange → onSkillChange（skill 变动触发）
  //   2. sessionService message.complete 广播 → onMessageComplete（running session 生成完成消费 pending 队）
  const reloadOrchestrator = new ReloadOrchestrator({ sessionService })
  skillRegistry.onChange((event) => {
    // 既有链路：pi reload（只用 affectedSessionIds 字段）
    void reloadOrchestrator.onSkillChange(event.affectedSessionIds)
    // 新增链路：广播 config.skillCacheInvalidated 让 landing 缓存失效重拉
    server.broadcastSkillCacheInvalidated(event.scope, event.cwd)
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

  // D8-2（perf W29）：appInfo 惰性——piVersion 先 'unknown'（同步 getAppVersion），
  // getPiVersion 探测完成后 mutate 同对象 + 补发 app.info（下方后台初始化块）。
  // setServices 注入同一对象引用，broker 的 buildAppInfoMsg spread 读到 mutate 后的新值。
  const appInfo: { appVersion: string; piVersion: string } = { appVersion: getAppVersion(), piVersion: 'unknown' }

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

  // QuotaService：Coding Plan 额度查询（hover 触发 + 缓存 + log）。
  // 经 server.setServices 注入到 QuotaMessageHandler（quota.fetch/getCached/refresh/configure 路由）。
  // getProviderInfo：从 providerId 解析 ProviderInfo（baseUrl/name/quota.fetcher），
  // quota.fetcher 优先于 matchQuotaPreset（设计文档 §8.2 + 手动选择 fetcher 需求）。
  const quotaService = new QuotaService({
    getProviderInfo: (providerId) => {
      const cfg = getProviderConfig(providerId)
      if (!cfg) return undefined
      return { baseUrl: cfg.baseUrl, name: cfg.name, quota: cfg.quota }
    },
  })

  const tServicesReady = performance.now()
  server.setServices(sessionService, configService, modelService, extensionService, pluginService, gitService, fileService, workspaceService, appInfo, skillRegistry, worktreeService, terminalService, quotaService, handoffService, presetService, authService, projectStore)

  // Graceful shutdown on signals
  let shuttingDown = false
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[runtime] received ${signal}, shutting down...`)
    try {
      recentWorkspacesStore.flushAll()
      recentWorkspacesStore.stopFlushTimer()
      projectStore.flushAll()
      // R1：关闭 SkillRegistry 的 chokidar watcher（global + project），防句柄泄漏阻塞退出。
      skillRegistry.dispose()
      await server.stop()
    // eslint-disable-next-line taste/no-silent-catch -- shutdown: best-effort stop, process exits regardless
    } catch (e) {
      console.error('[runtime] error during shutdown:', e)
    }
    // D10-1（perf W30）：退出 flush——closeLogger 现在需要 await（end 主日志 + 全部 pi
    // session 写流并等待落盘）。process.exit 立即终止进程不等待异步 IO，必须在 flush
    // 完成后才退出，否则缓冲窗口内尾部日志丢失（pi 卡死诊断证据，见 logger.ts 头部）。
    await closeLogger()
    process.exit(exitCode)
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

  // [HISTORICAL] uncaughtException 兜底（D6 入口防御）：进程级最后防线。
  // 与上方 unhandledRejection handler 的分工：unhandledRejection 捕获「未被 await
  // 的 async 异常」（Promise 断头链），记录后进程继续运行（有明确的后续处理边界，
  // 单条 rejection 不破坏运行时一致性）；uncaughtException 捕获「同步回调链的异常
  // 逃逸」（WS/Worker/IPC 消息回调 throw 等），Node 默认行为是进程立即退出——
  // runtime 一崩全部 session 的 pi 子进程失去管理。宿主层（plugin-host* 的
  // safeDispatchHostMessage）已挡第一道；这里兜住所有其他来源：记日志 + 走优雅
  // shutdown（flush 日志与 session 数据），退出码 1 让 supervisor 感知异常退出。
  // 不尝试带伤继续服务：uncaught 后运行时一致性无法保证，可观测 + 有序退出是
  // 本防线的目标。
  process.on('uncaughtException', (err) => {
    console.error('[runtime] *** UNCAUGHT EXCEPTION *** (attempting graceful shutdown):', err)
    void shutdown('uncaughtException', 1)
  })

  // D8-1（perf W29）：先 listen（端口即就绪）——迁移/探测等无 listen 前依赖的后置项
  // 全部移入下方后台初始化块（06 §3.3 D8-1）。listen 前仅剩：同步迁移 + 服务构造 + setServices。
  const tListen = performance.now()
  try {
    await server.start()
  } catch (err) {
    // 与 ConnectionManager.start reject 的分工：传输层对 listen 失败（EADDRINUSE 等）只
    // reject（对齐 callback-server.ts 先例，可被测试捕获/换端口重试，不杀进程）；
    // 进程退出决策归组合根——生产语义不变：端口被占即快速失败 exit(1)，但打可操作
    // 排查指引（指向恢复动作：查占用 → 关实例 → 重启），而非静默退出。
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'EADDRINUSE') {
      console.error(`[runtime] fatal: 端口 ${port} 被占用（EADDRINUSE）——可能已有另一个 xyz-agent 实例在运行。`)
      console.error(`  排查: lsof -i :${port} 查看占用进程；关闭其他实例后重启。原始错误: ${err instanceof Error ? err.message : String(err)}`)
    } else {
      console.error('[runtime] fatal: WS listen failed:', err)
    }
    process.exit(1)
  }
  console.log('[runtime] ready')
  // 启动耗时分解探针（06 §5 m-7）：listen-ready 各段耗时（baseline 对比见汇报——
  // 改造前 getPiVersion 占 listen 延迟 1.1-1.3s，重排后该段归零）。
  console.log(`[runtime] startup breakdown: syncMigrations=${(tSyncMigrations - tStart).toFixed(1)}ms construction=${(tServicesReady - tSyncMigrations).toFixed(1)}ms listen=${(performance.now() - tListen).toFixed(1)}ms total=${(performance.now() - tStart).toFixed(1)}ms`)

  // ── 后台初始化块（D8-1）：listen 后执行，不阻塞端口就绪 ──────────────
  // 序列与顺序约束见 startup-background-init.ts 文件头注释（migrateProviderConfig →
  // migrateBuiltinExtensions → checkAndAutoUpgrade → getPiVersion → skill → plugins）。
  // fire-and-forget：每步自带 catch，无 rejection 逃逸；失败不阻塞其余步骤。
  void runStartupBackgroundInit({
    configStore,
    authStorage,
    extensionService,
    pm,
    appInfo,
    broadcastAppInfo: () => server.broadcastAppInfo(),
    skillRegistry,
    pluginService,
  })
}

main().catch((e) => {
  console.error('[runtime] fatal:', e)
  process.exit(1)
})
