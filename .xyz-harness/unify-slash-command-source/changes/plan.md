{
  "format": "lite",
  "objective": "统一 slash command 计算入口：移除 publicSession，引入 skillRegistry（全局+项目分级缓存+fs.watch），CommandPopover 单入口参数化，CommandDocPanel 改用 sourceInfo.path 读 SKILL.md，builtin extension /__xyz_reload__ + reload-orchestrator 编排运行中 session reload",
  "waves": [
    {
      "id": "W1",
      "priority": "P0",
      "dependsOn": [],
      "changes": [
        {
          "file": "packages/runtime/package.json",
          "action": "modify",
          "description": "新增 chokidar 依赖（跨平台 fs.watch，封装 Linux inotify/macOS FSEvents/Windows ReadDirectoryChanges 差异）。同步 tsup.config.ts noExternal 加 chokidar（架构约定 #12，否则打包后 Cannot find module）"
        },
        {
          "file": "packages/runtime/tsup.config.ts",
          "action": "modify",
          "description": "noExternal 数组追加 'chokidar'（W1 新依赖必须同步，runtime dependencies 一致性检查）"
        },
        {
          "file": "packages/runtime/src/services/skill-registry.ts",
          "action": "create",
          "description": "新增 skillRegistry（runtime 单例）：globalCache（Map<projectRoot, SkillInfo[]>，AppShell 启动同步扫 + 同步挂 chokidar watcher）+ projectCache（Map<cwd, SkillInfo[]>，首次该 cwd 查询时扫 + 同步挂 watcher，cwd-scoped 非 session-scoped，多 session 同 cwd 共享，不主动清理靠 fs.watch 失效）。复用 config-service.loadSkills 扫描逻辑（orderedDirs 顺序：piAgentDir/skills > FORCED_PROJECT_SKILL_DIR > forcedGlobalSkillDir > discovery skillDirs，按 projectRoot resolve 相对路径 + expandHome）。chokidar watcher：每顶层目录 1 个 watcher（recursive），debounce 300ms 后重扫对应 cache 分区，watcher error 事件记日志降级不崩，目录删自动失效（chokidar 处理）。暴露：getGlobalSkills() / getProjectSkills(cwd) / invalidate(cwd?) / dispose()。fs.watch 完整行为见 spec FR-6 章节"
        },
        {
          "file": "packages/runtime/src/index.ts",
          "action": "modify",
          "description": "组合根（约 configService 构造后 :109，server.setServices 前 :263）构造 skillRegistry 单例，注入 configStore + configDir。启动扫描 globalCache（D4 启动即扫）+ 挂 global watcher。位置在 ensurePublicSession 删除点（:321）附近，作为启动收尾的新动作替代 publicSession 创建"
        },
        {
          "file": "packages/runtime/test/skill-registry.test.ts",
          "action": "create",
          "description": "skillRegistry 单测：globalCache 启动扫 + getGlobalSkills 返回；projectCache 懒加载 + getProjectSkills(cwd) 首次扫二次命中缓存；多次同 cwd 不重复扫；fs.watch 触发（mock chokidar emit 'add'/'change'）后 cache 刷新；expandHome 展开 ~/ 路径；相对路径按 cwd resolve；dispose 关闭所有 watcher。vitest fakeTimers 测 debounce"
        }
      ]
    },
    {
      "id": "W2",
      "priority": "P0",
      "dependsOn": [
        "W1"
      ],
      "changes": [
        {
          "file": "packages/shared/src/protocol.ts",
          "action": "modify",
          "description": "session.commands payload（:383）commands 数组项加可选 sourceInfo 字段：{ path: string; source: string; scope?: string }。session.getCommands reply（:615）同步。保持向后兼容（sourceInfo 可选，旧消费方不崩）"
        },
        {
          "file": "packages/runtime/src/infra/pi/rpc-client.ts",
          "action": "modify",
          "description": "getCommands（:464）返回类型从 Array<{name;description?;source}> 改为含 sourceInfo?: {path;source;scope?}。pi get_commands 已返回 sourceInfo（rpc-types.ts:79-86 + source-info.ts:6-14，含 path/scope/origin），透传即可。写 verify 脚本（tools/verify-get-commands-sourcerinfo.cjs）实测 pi 0.80.3 返回结构（AGENTS.md 规则 #4）"
        },
        {
          "file": "packages/runtime/src/services/session/session-service.ts",
          "action": "modify",
          "description": "getCommands（:876）透传 sourceInfo（pi 返回的 command.sourceInfo 原样传出，不丢弃）。session.commands 广播（event-adapter/message-dispatcher 路径）同步透传 sourceInfo"
        },
        {
          "file": "packages/renderer/src/stores/command.ts",
          "action": "modify",
          "description": "SessionCommand 接口（:27）加 sourceInfo?: { path: string; source: string; scope?: string }。applyCommands（:158-165）映射时透传 sourceInfo"
        },
        {
          "file": "packages/renderer/src/components/panel/CommandDocPanel.vue",
          "action": "modify",
          "description": "skill computed（:95-110）改源：不再读 settings.skills find。改为从 command.sourceInfo.path 拿 SKILL.md 绝对路径，调 file.read RPC（无 sessionId 走 readFileFromWhitelist 白名单，白名单已含 ~/.agents/skills + piAgentDir/skills，index.ts:235）读 content。skill sourcePath/description 从 command.sourceInfo 派生。删除 useSettingsStore import + settings.skills 两处 find（:100,107）。project 级 .xyz-agent/skills 的 SKILL.md 若不在白名单，用 command 关联 session 的 sessionId 走 file.read cwd 守门路径（sessionId 从 SideDrawer props 传）"
        },
        {
          "file": "packages/renderer/src/__tests__/command-doc-panel.test.ts",
          "action": "modify",
          "description": "改测试：mock commandStore 返回的 SessionCommand 带 sourceInfo.path，mock file.read RPC 返回 SKILL.md content。断言 CommandDocPanel 用 sourceInfo.path 读文件渲染（不再依赖 settings.skills）。删 settings.skills 相关 fixture"
        },
        {
          "file": "tools/verify-get-commands-sourceinfo.cjs",
          "action": "create",
          "description": "独立验证脚本：启动 pi 子进程（pi --mode rpc），发 get_commands RPC，打印返回结构确认 sourceInfo.path/scope/origin 字段存在。验证后再改 rpc-client.ts 透传（AGENTS.md 规则 #4 外部系统对接先验证）"
        }
      ]
    },
    {
      "id": "W3",
      "priority": "P0",
      "dependsOn": [
        "W1"
      ],
      "changes": [
        {
          "file": "packages/runtime/src/services/session/session-service.ts",
          "action": "modify",
          "description": "删除 publicSession 全部代码：字段 publicSessionId/publicSessionRebuildTimer/publicSessionRebuildCount（:178-180）；常量 PUBLIC_REBUILD_MAX/PUBLIC_REBUILD_DELAY_MS/PUBLIC_LABEL（:182-186）；回调字段 onPublicSessionReady（:105）；getter getPublicSessionId（:188-190）；ensurePublicSession（:196-208）；schedulePublicSessionRebuild（:215-226）；setOnPublicSessionReady（:248-250）；onSessionExit 内崩溃检测块（:133-138）；注释（:102-103）。改 onSessionExit 的 isPublic 判断（:134）为直接处理（无 publicSession 特例）"
        },
        {
          "file": "packages/runtime/src/interfaces.ts",
          "action": "modify",
          "description": "ISessionService（:82-85）删 getPublicSessionId() + ensurePublicSession() 方法声明"
        },
        {
          "file": "packages/runtime/src/transport/message-broker.ts",
          "action": "modify",
          "description": "BrokerServices（:45）删 getPublicSessionId 可选 getter 字段；buildAppInfoMsg（:141）删 payload.publicSessionId 行；broadcastAppInfo（:189-198）整个方法删（专为补发 publicSessionId 存在）"
        },
        {
          "file": "packages/runtime/src/transport/server.ts",
          "action": "modify",
          "description": "getter 注入（:97-99）删 getPublicSessionId；broadcastAppInfo 代理方法（:200-201）删"
        },
        {
          "file": "packages/runtime/src/index.ts",
          "action": "modify",
          "description": "删 setOnPublicSessionReady 回调注入（:268）+ ensurePublicSession 调用（:321）+ 相关注释（:265-267,318-320）。确保 server.start 后无 publicSession 创建动作（W1 的 skillRegistry 启动扫描替代该位置）"
        },
        {
          "file": "packages/renderer/src/stores/session.ts",
          "action": "modify",
          "description": "删 publicSessionId ref（:41）+ return 链中的 publicSessionId（:120）"
        },
        {
          "file": "packages/renderer/src/composables/features/useSidebar.ts",
          "action": "modify",
          "description": "bindAppInfoBroadcast（:67-106）：app.info 订阅块内删 session.publicSessionId 赋值（:86,89）+ sessionApi.getCommands(sid) 拉 publicSession 命令块（:90-95，landing 命令源改走 skillRegistry）。app.info 订阅保留（piVersion 等其他字段仍需）。模块级 appInfoSubCount/appInfoUnsub（:62-63）+ onScopeDispose 保留（订阅本身不删）"
        },
        {
          "file": "packages/renderer/src/components/new-task/Landing.vue",
          "action": "modify",
          "description": "composerSid（:70）删末尾 ?? sessionStore.publicSessionId：composerSid = flow.currentSessionId ?? props.sessionId（landing 真态 null）。注释（:65-69）更新：landing 命令源改走 skillRegistry，不再依赖 publicSession"
        },
        {
          "file": "packages/renderer/src/composables/panel/useComposerInjection.ts",
          "action": "modify",
          "description": "注释（:11-13）更新：移除 publicSessionId 坑点引用（逻辑用 variant 判定不依赖该字段，仅改注释）"
        },
        {
          "file": "packages/runtime/test/session-service.test.ts",
          "action": "modify",
          "description": "删 publicSession 重建/降级用例组（:1192-1244）。删所有 ensurePublicSession/schedulePublicSessionRebuild/setOnPublicSessionReady 相关测试"
        }
      ]
    },
    {
      "id": "W4",
      "priority": "P0",
      "dependsOn": [
        "W1",
        "W2",
        "W3"
      ],
      "changes": [
        {
          "file": "packages/renderer/src/composables/features/useProjectSkills.ts",
          "action": "modify",
          "description": "重构：从 scanSessionSkills RPC（config-service.loadSkills）改为读 skillRegistry.projectCache。但 skillRegistry 在 runtime，前端经新 RPC config.getProjectSkills(cwd) 拉取（W1 skillRegistry 暴露 + settings-message-handler 加 config.getProjectSkills RPC handler）。保留按 cwd 缓存 + in-flight 去重逻辑，改数据源为 getProjectSkills RPC。或直接删此 composable，CommandPopover landing 分支改读全局 settingsStore（若 skillRegistry globalCache 含项目 skill 则够）——取决于 landing 是否需项目级预览（spec FR-3 要求 projectCache 预览，保留 composable 改源）"
        },
        {
          "file": "packages/runtime/src/transport/settings-message-handler.ts",
          "action": "modify",
          "description": "新增 config.getProjectSkills RPC handler（case 'config.getProjectSkills'）：调 skillRegistry.getProjectSkills(cwd) 返回项目级 SkillInfo[]。保留 config.scanSessionSkills（向后兼容）或替换。config.sessionSkills reply 类型同步 protocol.ts"
        },
        {
          "file": "packages/renderer/src/api/domains/config.ts",
          "action": "modify",
          "description": "新增 getProjectSkills(cwd) 方法（或 rename scanSessionSkills → getProjectSkills）。调 config.getProjectSkills RPC"
        },
        {
          "file": "packages/renderer/src/components/panel/CommandPopover.vue",
          "action": "modify",
          "description": "重构 slashCommands computed（:119-161）：去 variant==='landing' 硬分支，改单入口参数化。逻辑：sessionId 非空（panel）→ compact + commandStore.getCommands(sessionId)（pi 真源，含 sourceInfo）。sessionId null（landing）→ skillRegistry globalCache（经 settingsStore 或新 store）+ projectSkills（props 透传）。过滤 __ 前缀命令（/__xyz_reload__ 不可见，spec SR4）。去 settingsStore.skills 作为 slash 源（FR-5）。props 调整：保留 variant 仅用于 compact 注入判定（panel 才有 compact），不分支命令源"
        },
        {
          "file": "packages/renderer/src/components/panel/Composer.vue",
          "action": "modify",
          "description": "CommandPopover 调用（:17-25）：variant 仍传（compact 判定用），project-skills 仍传（landing 项目预览）。sessionId 传 composerSid（landing 真态 null，panel 真态 sid）。landingProjectSkills（:136）来源不变（useProjectSkills 改源后）"
        },
        {
          "file": "packages/renderer/src/__tests__/panel/command-popover-landing.test.ts",
          "action": "modify",
          "description": "重构测试：去 publicSessionId 兜底测试（:9,72-74）。新增：landing（sessionId=null）slash 来自 skillRegistry globalCache + projectSkills；panel（sessionId 非空）slash 来自 commandStore + compact；/__ 前缀命令不显示；slash 结果不随 settingsStore.skills 变化（AC-8 反向断言）"
        },
        {
          "file": "packages/renderer/src/__tests__/composables/use-project-skills.test.ts",
          "action": "modify",
          "description": "改测试：mock getProjectSkills RPC（替代 scanSessionSkills）。断言 cwd 切换触发 getProjectSkills + 缓存命中 + in-flight 去重"
        }
      ]
    },
    {
      "id": "W5",
      "priority": "P0",
      "dependsOn": [
        "W1",
        "W3"
      ],
      "changes": [
        {
          "file": "xyz-agent-extension.js",
          "action": "modify",
          "description": "新增 /__xyz_reload__ slash command 注册：pi.registerCommand('__xyz_reload__', { description: 'Internal: reload skills', handler: async (args, ctx) => { await ctx.reload() } })。双下划线前缀约定内部命令（前端过滤）。handler 调 ctx.reload()（pi AgentSession.reload()，重扫 skill + 重建 runtime）。复用现有 xyz-agent-extension.js 文件（已在 --extension 注入链，extension-service.ts:258-260）。参考 xyz-navigate 注册范式（同文件现有）"
        },
        {
          "file": "packages/runtime/src/services/session/reload-orchestrator.ts",
          "action": "create",
          "description": "新增 reload-orchestrator（runtime 单例）：订阅 message.complete 事件（event-adapter agent_end → message.complete，event-adapter.ts:176,204）判断 session idle。pendingReload Set<sessionId> 去重。构造时注入 skillRegistry + sessionService，主动注册 skillRegistry.onChange(affectedSessions => this.onSkillChange(affectedSessions))（skillRegistry W1 create 时暴露 onChange 注册方法）。onSkillChange：遍历受影响 session（全局目录变动→所有活跃 session；项目目录变动→该 cwd 活跃 session，从 sessionService.getActiveSessionIds + 查 cwd），idle（sessionService.isSessionIdle）立即发 /__xyz_reload__（复用 workflowAction 模式 session-service.ts:551 直接 client.prompt，绕过 dispatcher busy 预检），running 设 pendingReload flag。onMessageComplete(sessionId)：检查 pendingReload 有则发 reload 清 flag。降级：ctx.reload 抛错/prompt 超时清 flag 记 error 日志不重试；排队期 session 删除检测 sessions Map 无此 id 清 flag 跳过"
        },
        {
          "file": "packages/runtime/src/services/session/session-service.ts",
          "action": "modify",
          "description": "暴露 isSessionIdle(sessionId): boolean（!isGenerating && sessions.has(id)）供 reload-orchestrator 查询。或暴露 getActiveSessionIds(): string[]。message.complete 事件路由到 reload-orchestrator.onMessageComplete（event-interpreter onTurnFinalize 回调点 :359 附近，或 event-adapter emit 点）"
        },
        {
          "file": "packages/runtime/src/index.ts",
          "action": "modify",
          "description": "组合根构造 reload-orchestrator（skillRegistry 之后），注入 sessionService（查 idle）+ event 订阅 + pi client 获取（pm.getClient）。skillRegistry.setOnSkillChange(orchestrator.onSkillChange) 绑定"
        },
        {
          "file": "packages/runtime/test/reload-orchestrator.test.ts",
          "action": "create",
          "description": "单测：idle session skill 变更立即发 /__xyz_reload__（mock client.prompt 断言被调）；running session skill 变更设 pendingReload flag 不立即发；message.complete 到达有 flag 则发 reload 清 flag；ctx.reload 抛错清 flag 记日志不重试；排队期 session 删除清 flag 跳过；多 session 并发 reload 各自独立。vitest fakeTimers + mock"
        }
      ]
    }
  ]
}