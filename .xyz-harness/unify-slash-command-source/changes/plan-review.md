# Plan Review: unify-slash-command-source

**审查对象**: dev-plan.json（5 waves: W1-W5）
**审查方法**: 行号抽查 + 跨 wave 接口契约核对 + 可行性验证

## 审查结论

plan 结构清晰（W1 基础 → W2/W3 并行 → W4 汇聚 → W5 收尾，无循环依赖），SR1-SR12 补全基本落到 change。3 个必须修复：(1) W5 `ctx.reload()` 未实证（与 W2 自定的规则 #4 双标）；(2) W1 skill-registry 未声明 onChange 但 W5 强依赖（跨 wave 接口契约缺口）；(3) W5 接入点 `event-interpreter.ts:359` 文件不存在（死路径）。5 个建议修复 + 3 个次要问题。

主 agent 补充核实的关键事实（用于 plan_review_fix）：
- **PR1 ctx.reload() 已有证据**：pi-mono types.ts:373 `ExtensionCommandContext.reload(): Promise<void>` 存在（主 agent 已核实）。rpc-mode.ts:340-342 的 `reload: async () => { await session.reload() }` 是 commandContextActions 的实现（挂到 extension ctx）。AgentSession.reload()（agent-session.ts:2150）调 `_resourceLoader.reload()` 重扫 skill。**证据充分，但补 verify 脚本实证更稳**（与 W2 sourceInfo 同标准）。
- **PR3 event-interpreter 不存在核实**：reviewer 正确，实际文件是 `packages/runtime/src/services/session/event-interpreter.ts`（不是 infra/pi/）。但主 agent 核实该文件存在且 onTurnFinalize 在 :359。reviewer 找的是 infra/pi/event-interpreter.ts（错路径），services/session/event-interpreter.ts 是真实文件。
- **W3 useSidebar bindAppInfoBroadcast**（主 agent 发现，reviewer 未提）：整个函数纯为 publicSession 服务，piVersion 在 Sidebar.vue:349 独立订阅。移除 publicSession 后整个 bindAppInfoBroadcast/unbindAppInfoBroadcast + :159-160 调用可删。

| ID | Severity | Dimension | Ref | Description | 状态 |
|----|----------|-----------|-----|-------------|------|
| PR1 | must-fix | feasibility | W5 / xyz-agent-extension.js | handler 调 ctx.reload() 假设 pi RegisteredCommand ctx 暴露 reload()，未实证。W2 为 sourceInfo 造 verify 脚本（规则 #4），W5 对更核心的 ctx.reload 反而没验证。主 agent 已核实 pi-mono types.ts:373 ExtensionCommandContext.reload() 存在 + rpc-mode.ts:340 实现 + agent-session.ts:2150 AgentSession.reload() 调 _resourceLoader.reload()。证据充分但补 verify 脚本与 W2 同标准 | 待 plan_review_fix |
| PR2 | must-fix | completeness | W1 / skill-registry.ts create | W5 reload-orchestrator 依赖 skillRegistry.onChange(affectedSessions)，但 W1 create 描述只列 getGlobalSkills/getProjectSkills/invalidate/dispose，无 onChange。跨 wave 接口契约缺口。必须在 W1 补 onChange 注册方法 + affectedSessions 判定逻辑（全局目录变动→所有活跃 sessionId；项目目录变动→该 cwd 活跃 sessionId，需 sessionService 反查 cwd→sessionIds） | 待 plan_review_fix |
| PR3 | must-fix | feasibility | W5 / reload-orchestrator.ts | 接入点写 event-interpreter onTurnFinalize :359 或 event-adapter emit 点。reviewer 说 event-interpreter.ts 不存在——实际在 services/session/event-interpreter.ts（reviewer 找错路径），onTurnFinalize 确在 :359。但 plan 应钉死唯一接入点。最干净：reload-orchestrator 订阅 broker message.complete 广播（与前端 useSessionEvents 同源），不侵入 event-adapter/event-interpreter | 待 plan_review_fix |
| PR4 | should-fix | completeness | W5 / session-service.ts | 暴露 isSessionIdle/getActiveSessionIds 用"或"模糊描述。钉死：isSessionIdle(sessionId)=!isGenerating && sessions.has(id)（进程存活且非生成态）；getActiveSessionIds()=sessions Map 的 keys（runtime 内活跃 session） | 待 plan_review_fix |
| PR5 | should-fix | consistency | W2 / CommandDocPanel + index.ts:235 | project 级 .xyz-agent/skills 不在 allowedReadDirs 白名单。plan W2 提到走 sessionId + cwd 守门，但未显式标注前置依赖。CommandDocPanel 在 SideDrawer（panel 专用），:session-id 已透传（SideDrawer.vue:70），cwd 守门覆盖 .xyz-agent/skills（在 session.cwd 下）。补显式标注 | 待 plan_review_fix |
| PR6 | should-fix | consistency | W5 / session-service.ts:551 | workflowAction 是 user-action 语义，reload 是 internal-action，复用同名语义混淆。新增 sessionService.promptReload(sessionId) 内部调 client.prompt('/__xyz_reload__')，专用于 reload-orchestrator | 待 plan_review_fix |
| PR7 | should-fix | consistency | W3 / session-service.ts 行号 | W3 引用行号系统性偏移 2-10 行（:178-180 实际 ~180-182 等）。描述逻辑准确，行号实现时对齐或改用方法名锚点 | 待 plan_review_fix |
| PR8 | should-fix | consistency | W4 / CommandPopover.vue:119-161 | slashCommands computed 实际 :163-204（偏差 ~40 行）。描述准确，行号修正 | 待 plan_review_fix |
| PR9 | nit | completeness | W1 / package.json | chokidar 加 tsup.config.ts noExternal 正确。补 validate-runtime-bundle.sh 自动校验提醒 | 待 plan_review_fix |
| PR10 | nit | completeness | W4 / useProjectSkills.ts | 描述给两方案（改源或删）+ settingsStore 又冒出（与 FR-5 冲突）。钉死：landing 全局 skill 走 skillRegistry globalCache（经新 RPC config.getGlobalSkills 拉，不走 settingsStore.skills），项目 skill 走 getProjectSkills(cwd) | 待 plan_review_fix |
| PR11 | nit | coverage | W2 / rpc-client + session-service | rpc-client/session-service 透传 sourceInfo 无对应单测。补：rpc-client getCommands 透传 sourceInfo 单测 + session-service getCommands 透传单测 | 待 plan_review_fix |

plan_review turn 2 复查：待修复后进。

---

## plan_review_fix 闭环（turn 2 复查）

PR1-PR11 已全部修复（见 cw plan_review_fix 记录）：
- PR1: ctx.reload() 证据确认（types.ts:373 + rpc-mode.ts:340 + agent-session.ts:2150），补 verify 脚本
- PR2: W1 skill-registry 补 onChange 注册方法 + affectedSessions 判定
- PR3: 接入点钉死为 broker message.complete 广播订阅（不侵入 event-adapter）
- PR4: isSessionIdle/getActiveSessionIds 语义钉死
- PR5: CommandDocPanel project skill 走 sessionId+cwd 守门（显式标注）
- PR6: 新增 sessionService.promptReload 独立方法（不复用 workflowAction）
- PR7: W3 改用方法名锚点（不依赖精确行号）
- PR8: CommandPopover 行号修正（:163-204）
- PR9: 补 validate-runtime-bundle.sh 自动校验提醒
- PR10: landing 全局 skill 走新 RPC config.getGlobalSkills（不走 settingsStore.skills）
- PR11: 补 rpc-client/session-service sourceInfo 透传单测

主 agent 补充发现：W3 useSidebar bindAppInfoBroadcast 整个函数删（piVersion 在 Sidebar.vue:349 独立订阅）。

plan_review turn 2 复查：空 issues，进 tdd_plan。
