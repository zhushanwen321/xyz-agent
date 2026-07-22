# Code Review: unify-slash-command-source

**审查对象**: 5 个 wave commit（W1-W5，4f0e801a..e5edb4c0）
**审查方法**: 代码质量审查（文件最终状态 + 跨 wave 一致性）

## 审查结论

5 wave 整体架构清晰（SkillRegistry 缓存+监听、sourceInfo 透传、ReloadOrchestrator 编排遵循窄接口注入 + Map 分区范式）。3 must-fix + 6 should-fix + 1 nit。

主 agent 补充核实（用于 review_fix 决策）：
- **R2 不成立（reviewer 推测错误）**：reviewer 怀疑 promptReload 污染对话历史。核实 pi 源码 agent-session.ts:1176-1200 `_tryExecuteExtensionCommand`：pi prompt() 对 `/` 开头 + 匹配 registerCommand 的输入，走 _tryExecuteExtensionCommand 直接执行 command.handler(args, ctx) 并 return true，**不写任何 session entry**。prompt() 收到 handled=true 立即 return（agent-session.ts:1040）。`/__xyz_reload__` 不进对话历史。xyz-agent-extension.js 顶部注释"intentionally do NOT call pi.sendMessage()"是指 **handler 内部**不该调 sendMessage（会进历史），但 **host 经 client.prompt 触发命令**是 pi 设计的命令执行入口，不写 entry。
- **R1/R3 真实 must-fix**：dispose 未在 shutdown 调用（watcher 句柄泄漏）、pendingReload 在 session 删除时不清（残留）。

| ID | Severity | Dimension | Ref | Description | 状态 |
|----|----------|-----------|-----|-------------|------|
| R1 | must-fix | edge-case | index.ts shutdown() | skillRegistry.dispose() 从未被调用。chokidar persistent watcher（globalWatcher + 每 cwd projectWatcher）持有 FS 句柄，runtime 子进程 spawn/kill 时泄漏；vitest 同进程多测例更严重（watcher 残留导致跨测例污染）。dispose() 已实现但无人调用 | 待 review_fix |
| R2 | ~~must-fix~~ 不成立 | architecture | session-service promptReload | reviewer 怀疑 promptReload 污染对话历史。核实 pi _tryExecuteExtensionCommand（agent-session.ts:1176-1200）直接执行 handler return true，不写 entry。prompt() 收到 handled 立即 return。/__xyz_reload__ 不进历史。reviewer 推测错误（缺 pi 源码访问） | 不成立（证据：pi-mono agent-session.ts:1176-1200, 1040） |
| R3 | must-fix | edge-case | reload-orchestrator pendingReload | pendingReload Set 只在 onMessageComplete（消费）+ doReload catch（失败）删除，session 主动删除（deleteSession）路径不清。session A running 入队 → deleteSession(A) → 永不发 message.complete → A 永久残留。hasSession 守卫只在下次 skill 变动清 | 待 review_fix |
| R4 | should-fix | error-handling | skill-registry watcher | chokidar watcher 只挂 on('all')，未挂 on('error')。watcher error（权限拒绝/目录删/EMFILE）无人监听，chokidar 内部 process.emit('error') 可能未捕获异常 | 待 review_fix |
| R5 | should-fix | design-consistency | CommandDocPanel skillPath | /skill:xxx 兜底从 settings.skills 查 sourcePath，与 FR-5（全局不走 settingsStore.skills）矛盾。两套数据源并存（landing popover 用 globalSkills，doc panel 兜底 settings.skills），reload 后可能不一致 | 待 review_fix |
| R6 | should-fix | edge-case | session-service promptReload | promptReload 未重置 isGenerating。虽然 pi slash command 不走完整 agent turn，但若 reload 触发异步重建期间发 agent_start，前端 session 状态可能不一致。应显式说明不触碰 isGenerating 的前提 | 待 review_fix |
| R7 | should-fix | performance | skill-registry defaultScanFn | 每次 scan 都 new PiConfigStore() + new ConfigService()，重读磁盘配置。watcher 高频变动时（debounce 300ms 后）重复创建对象。应用单例 ConfigService 或 _scanFn 注入 | 待 review_fix |
| R8 | should-fix | edge-case | CommandPopover landing extCmds | landing 分支 extCmds = sessionId ? getCommands : []。选了目录后 composerSid 非 null → extCmds 非空 → 混入 pi extension 命令。注释说"landing 无 pi 命令源"但实际选目录后有。注释与行为不符 | 待 review_fix |
| R9 | should-fix | test-coverage | skill-registry + reload-orchestrator | chokidar 生命周期/watcher error/debounce 清理/pendingReload 竞态的配套单测覆盖率存疑 | 待 review_fix |
| R10 | nit | type-safety | CommandPopover slashCommands | landing mapSkillInfo 产生的命令不带 sourceInfo（SessionCommand 有 sourceInfo 字段但内联对象没），点击后 CommandDocPanel 走 settings.skills 兜底（R5）。建议 mapSkillInfo 填充 sourceInfo | 待 review_fix |

review_fix 后复查进 test。

---

## review_fix 闭环（turn 2 复查）

R1/R3（must-fix）+ R4/R8（should-fix）已在 commit 0e69039b 修复：
- R1: shutdown() 调 skillRegistry.dispose()
- R3: clearPending + setOnSessionDelete，两条删除路径汇聚 removeSessionEntry
- R4: watcher on('error') 记日志
- R8: landing extCmds 注释修正

R2 不成立（reviewer 推测错误，pi _tryExecuteExtensionCommand 不写 entry）。
R5/R7/R10 留 retrospect knownRisk（改动面大或增强性质）。
R6/R9 不改逻辑（前提正确/测试已存在）。

review turn 2 复查：空 issues，进 test。
