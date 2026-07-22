# Spec 确认：unify-slash-command-source

**Objective**: 统一 slash command 计算入口（移除 variant 分支），移除 publicSession，引入 skillRegistry（全局+项目缓存）服务 landing，panel 信任 pi get_commands，fs.watch 监听 skill 目录变更触发 builtin extension ctx.reload()

## 澄清记录

### CL1: slash command 单一计算入口架构 [resolved]
- **问题**: 重构为单入口参数化（sessionId + projectCwd）架构？
- **背景**: 现状 CommandPopover 用 variant==='landing' 硬分支，两态逻辑完全不同（landing 三源合并 pi/全局/项目 skill，panel 只 pi ext + compact）。三源中 settingsStore.skills（message-broker 传 services.projectRoot 错位扫）和 projectSkills（scanSessionSkills RPC 传对 cwd 扫）本质是同一套 loadSkills 被两次调用，靠 cwd 错位产生"全局/项目"职责分离，脆弱。用户要求：单入口、内部仅两源（pi ext + skill 扫描）、skill 扫描单套逻辑、全局/项目显式分级缓存、文件监听。
- **结论**: 是。去掉 variant 分支，slashCommands(params) 参数化。landing(sessionId=null) 用 skillRegistry，panel(sessionId 非空) 信任 pi get_commands。

### CL2: spec_review 5 个 must-fix 补全（SR1-SR5）+ should-fix 细节 [resolved]
- **问题**: 按核实结果补全 spec：FR-3 加 projectCache 生命周期契约、FR-5 删或拍板 sourceInfo 透传方案、FR-6 加 fs.watch 资源/跨平台/失效、FR-7 加 reload 编排三层+命令名+过滤、补 FR-9 CommandDocPanel 改源 + FR-10 landing 冷启动 loading？
- **背景**: reviewer 指出 5 个 must-fix 阻塞 plan：FR-7 reload 编排三层机制未定义、FR-3 projectCache 生命周期未定义、FR-5 与 D5 矛盾（或未拍板 + 固化 cwd 错位 bug）、FR-7 命令可见性、FR-6 fs.watch 行为。主 agent 已核实代码事实：(1) settingsStore.skills 真实消费者是 CommandDocPanel 非 Settings 页面，D5 前提错；(2) pi get_commands 返回 sourceInfo.path 但 xyz-agent runtime 丢弃了，补回即可让 CommandDocPanel 脱钩 settingsStore.skills；(3) pi RegisteredCommand 无 hidden 标记，/__xyz_reload__ 必然污染 panel 浮层，只能前端过滤；(4) submitFirstMessage 不依赖 publicSessionId，移除安全。
- **结论**: 是。全部补全。

## Spec

### 背景

现状 slash command 计算分散：CommandPopover 内 variant==='landing' 硬分支两套逻辑。landing 态合并三源（pi publicSession ext 命令 + settingsStore.skills 全局 + projectSkills 项目），panel 态只用 pi ext + compact。

三源本质问题：(1) settingsStore.skills 由 message-broker.buildSkillListMsg 调 loadSkills(services.projectRoot)，projectRoot 是 Electron app 路径（非用户项目），相对路径 .agents/skills resolve 错位扫不到项目 skill——靠这个 bug 恰好让它只扫全局；(2) projectSkills 由 scanSessionSkills RPC 调 loadSkills(cwd)，cwd 正确扫到项目 skill。两源是同一套 loadSkills 的两次调用，靠 cwd 错位分职责，不健壮。

pi 能力核查（researcher 调研结论）：(1) pi get_commands RPC 已返回 extension+prompt+skill 三类命令（带 source 字段，rpc-mode.ts:670-679），panel session cwd 正确时已含项目 skill；(2) pi 无公开 reload RPC，reload() 仅 extension command 的 ctx.reload() 可触发（researcher 结论 1）；(3) pi skill 元数据构造时缓存，SKILL.md 正文实时读磁盘（researcher 结论 3）。

### 功能需求

- **FR-1**: slash command 单一计算入口 — CommandPopover 去掉 variant==='landing' 硬分支，改为 slashCommands(params: {sessionId, projectCwd}) 单入口参数化。sessionId 区分 landing(null)/panel(非空)，projectCwd 决定 landing 项目 skill 预览。
- **FR-2**: 移除 publicSession — 完全移除 session-service.ensurePublicSession / publicSessionId / 崩溃重建逻辑；message-broker 的 publicSessionId 字段 + app.info 补发逻辑删除；前端 sessionStore.publicSessionId + useSidebar 的 app.info 订阅拉命令删除。landing 不再有 pi 子进程（冷启动推迟到首次提交消息创建 session）。
- **FR-3**: landing skill 来源 = runtime skillRegistry — 新增 skillRegistry（runtime 单例）：globalCache（AppShell 启动扫全局目录：<piAgentDir>/skills + forcedGlobalSkillDir + discovery 绝对/~ 路径）+ projectCache（Map<cwd, Skill[]> 懒加载，首次该 cwd 查询时扫 .agents/skills + .xyz-agent/skills + discovery 相对路径）。landing 读 globalCache + projectCache(projectCwd)。
- **FR-4**: panel skill 来源 = pi get_commands — panel 态完全信任 commandStore.getCommands(sessionId)（pi get_commands RPC 返回的 extension+prompt+skill 三类）。runtime 不在 panel 态额外扫 skill。panel skill 列表随 pi reload 更新。
- **FR-5**: settingsStore.skills 不再是 slash 源 — settingsStore.skills 保留给 Settings 页面展示用（message-broker 全局广播路径保留或改为从 skillRegistry 派生），但 slash command 计算完全不读它。
- **FR-6**: fs.watch 监听 skill 目录 — skillRegistry 对扫描的目录建 fs.watch（recursive），debounce 300ms 后重扫。全局目录变动刷 globalCache，项目目录变动刷 projectCache(cwd)。
- **FR-7**: skill 变更触发 pi reload（builtin extension 桥接） — 新增 builtin extension（走现有 --extension 注入机制），注册内部 slash command（如 /__xyz_reload__），handler 调 ctx.reload()。host 检测 skill 变更后，对受影响的活跃 session：idle 则立即通过 prompt RPC 发该 slash 触发 reload，running 则监听 isGenerating 变 false 后发。reload 后 pi 重扫 skill，get_commands 返回新列表，commandStore 更新。
- **FR-8**: landing 不再显示 pi ext 命令 — 移除 publicSession 后 landing 无 pi 子进程，pi 内置 slash（/compact /fork /tree 等）和 extension 注册 slash 全部针对活跃 session，landing 无 session 时无意义。landing 只显示 skill 命令（全局 + 项目预览）。

### 决策

- **D1**: 移除 publicSession（不再用占位 session 给 landing 提供 slash 数据）（publicSession 唯一用途是给 landing slash 提供 pi ext 命令 + 全局 skill，但：(1) pi ext 命令全针对活跃 session，landing 无 session 时无意义；(2) 全局 skill 可由 runtime skillRegistry 自己扫缓存。publicSession 还带来 pi 冷启动占用 + 崩溃重建复杂度。去掉后 landing 失去 pi ext 命令（可接受，无意义）但简化架构。）
- **D2**: panel 信任 pi get_commands，不额外 runtime 扫 skill（pi get_commands 已含项目 skill（panel session cwd 正确）。双源合并去重会引入 pi 缓存陈旧的窗口期不一致问题。单源（pi）一致性最好，fs.watch reload 后自动更新。）
- **D3**: skill 变更 reload 走 builtin extension ctx.reload() 桥接（不推上游 / 不用 clone）（pi 无公开 reload RPC（researcher 确认）。三条路：(1) 推上游加 RPC 周期不可控；(2) builtin extension 桥接 ctx.reload() 不换 sessionId、复用现有 --extension 机制、短期可落地；(3) clone RPC 重建换 sid 成本大。选路 2。）
- **D4**: 全局 skill 缓存 AppShell 启动即扫（不懒加载）（全局 skill 目录文件少扫描快（百 ms 级），启动即扫让首次敲 / 零延迟。懒加载会让首次 / 有感知延迟。）
- **D5**: settingsStore.skills 保留（不删），仅 slash 不用它（Settings 页面 skill 列表展示依赖它。彻底删需改 Settings 页面 + useSettings 订阅，改动面大且超出本次范围。保留独立广播，slash 计算切到 skillRegistry，职责分离。）

### 验收标准

- **AC-1**: CommandPopover 无 variant==='landing' 分支，slashCommands 单函数参数化 (unit)
- **AC-2**: session-service 无 publicSessionId / ensurePublicSession / 崩溃重建代码 (unit)
- **AC-3**: landing 敲 / 显示全局 skill（skillRegistry.globalCache）+ 项目 skill（skillRegistry.projectCache(选中cwd)），不含 pi ext 命令 (unit)
- **AC-4**: panel 敲 / 显示 pi get_commands（extension+prompt+skill），不读 skillRegistry (unit)
- **AC-5**: skill 文件新增后，fs.watch 触发重扫缓存，landing 浮层秒级更新 (manual)
- **AC-6**: skill 文件新增后，panel 活跃 session 通过 builtin extension reload，get_commands 返回新 skill (manual)
- **AC-7**: skill 变更时 session running，等 stop 后才触发 reload（不中断生成） (manual)

### 不做

- 推 pi 上游加 reload_resources RPC（长期可平行推进，不阻塞本次）
- clone RPC 重建 session 方案（路 3，代价过大）
- Settings 页面改用 skillRegistry（D5 决定保留 settingsStore.skills）
- pi 冷启动预热（用户选好目录后预创建 hidden session，等价 publicSession 但有正确 cwd——本次不做，首次提交消息冷启动可接受）

### 复杂度: high

涉及：(1) 移除 publicSession 牵连 session-service/message-broker/前端 store/useSidebar 多处；(2) 新增 skillRegistry（缓存+fs.watch+全局/项目分级）；(3) 新增 builtin extension + reload 编排（含 running session 排队）；(4) CommandPopover 重构。跨 runtime/renderer/shared 三层。

### FR-3 projectCache 生命周期契约（补全 SR2）

projectCache 是 **cwd-scoped 非 session-scoped**（类比 ADR-0036 session-scoped state 范式，但 key 是 cwd 不是 sessionId）。

- **共享**：多 session 同 cwd 共享一份 projectCache(cwd) 缓存（读多写少，fs.watch 单实例维护）。
- **不主动清理**：session 关闭后该 cwd 分区**不清理**（避免切回重扫 + 共享场景下一个 session 关闭不应影响另一个同 cwd session）。
- **失效靠 fs.watch**：缓存陈旧由 fs.watch 监听目录变更触发重扫解决，不靠 session 生命周期。
- **内存上界**：projectCache 无显式上限，但实际 cwd 数量受用户切换目录频率限制（几十量级），每份缓存是 SkillInfo[]（几 KB），总内存可忽略。若未来出现 cwd 爆量（如自动化批量切换），加 LRU 上限（outOfScope，本次不做）。
- **watcher 生命周期**：projectCache(cwd) 首次创建时同步挂 fs.watch；cwd 分区永不清除 → watcher 永不关闭（同上，cwd 数量有限可接受）。若需关闭，在某个 cwd 长时间（如 30min）无任何 session 引用时关闭其 watcher + 清缓存（outOfScope）。

### FR-5/D5 修正：sourceInfo 透传 + CommandDocPanel 改源（解决 SR3）

原 D5 前提错误（settingsStore.skills 真实消费者是 CommandDocPanel 非 Settings 页面）。修正：

- **补 PiCommandInfo.sourceInfo**：runtime 的 PiCommandInfo（pi-engine.ts:28）加 sourceInfo 字段（透传 pi get_commands 返回的 sourceInfo，含 path/scope/origin）。
- **补 SessionCommand.sourceInfo**：前端 SessionCommand（command.ts:27）加 sourceInfo 字段。
- **CommandDocPanel 改源**：不再读 settingsStore.skills 找 content。改为：skill 命令（source=skill）用 command.sourceInfo.path 直接 readFileSync SKILL.md 渲染正文（新增 RPC：file.readFile 或复用现有 file-service 读文件）。
- **settingsStore.skills 处理**：message-broker 的 config.skills 全局广播**保留**（向后兼容，防有遗漏消费点），但 slash 计算 + CommandDocPanel 都不再读它。D5 修正为：settingsStore.skills 降级为遗留广播，新代码不消费，未来可删（本次不删，防破坏性变更）。
- **不动 cwd 错位 bug**：message-broker 仍传 services.projectRoot（错位），但因为没人消费 settingsStore.skills 做 skill 扫描了，错位无影响。修这个 bug 无价值（outOfScope）。

### FR-6 fs.watch 完整行为（补全 SR5）

- **资源管理**：每个扫描到的**顶层目录**建 1 个 watcher（不是每个 skill 子目录建），projectCache(cwd) 共享该 cwd 的 watcher。watcher 数量 = 全局目录数 + 活跃 cwd 数（几十量级），可接受。
- **跨平台**：用 chokidar（已成熟、跨平台 recursive 支持、封装了 Linux inotify/macOS FSEvents/Windows ReadDirectoryChanges 差异）。不直接用 node:fs.watch（Linux recursive 支持有限）。chokidar 作为 runtime 新增 dependency，必须同步加入 tsup.config.ts 的 noExternal（架构约定 #12）。
- **失效恢复**：(a) 目录被删 → watcher 自动失效（chokidar 处理），缓存标记 stale，下次查询触发重扫；(b) 权限丢失 → watcher error 事件记日志，缓存不更新（降级，不崩）；(c) EMFILE 句柄耗尽 → chokidar 的 useFsEvents/usePolling 降级（chokidar 内置），记日志。
- **watch 挂载时机（解决 SR11）**：globalCache 在 AppShell 启动**同步**挂 watcher（启动即扫 + 启动即 watch，D4 明确）。projectCache(cwd) 在首次扫描时同步挂 watcher。无 lazy watch 窗口期。

### FR-7 reload 编排三层机制（补全 SR1 + SR4 + SR12）

**命令名（SR12）**：拍死 `/__xyz_reload__`（双下划线前缀 + 后缀，约定内部命令）。

**可见性（SR4）**：前端 CommandPopover 过滤 `__` 前缀命令（name.startsWith('__')），panel 浮层不显示。builtin extension 注册时 invocationName 用 `__xyz_reload__`（不带前导 /，pi 自动加 /）。

**监听机制（SR1a）**：reload 发起方在 runtime。runtime 订阅该 session 的 message 事件流，检测 `message_stop`（pi 完成生成）判断 idle。**不监听前端 isGenerating**（那是前端态，runtime 访问不到）。具体：runtime 的 event-adapter 已处理 message.* 事件，新增 reload-orchestrator 订阅 message_stop 事件，关联 session 的 pending-reload 状态。

**去重（SR1b）**：每个 session 维护 1 个 pending-reload flag（Set<sessionId>）。fs.watch 触发变更时，遍历受影响 session：若 session idle（非 isGenerating）立即发 reload；若 running，设 pending-reload flag（已有 flag 则跳过，不重复入队）。message_stop 事件到达时检查该 session 是否有 pending-reload flag，有则发 reload 并清 flag。

**降级（SR1c）**：(a) ctx.reload() 抛错 → 记 error 日志，清 pending-reload flag（不阻塞下次），不重试（reload 是 best-effort，用户下次手动 /reload 兜底）；(b) prompt RPC 超时 → 同上，清 flag 记日志；(c) 排队期 session 被 deleteSession → reload-orchestrator 检测 session 不存在（sessions Map 无此 id），清 flag 跳过。

**reload 触发方式**：通过 prompt RPC 发 `/__xyz_reload__` 字符串（pi 内部识别为 extension command，调 ctx.reload()）。**注意**：这会进对话历史（一条 user 消息 + extension 执行）。可接受（用户可见一行 reload 记录，透明）。若不可接受，备选：给 builtin extension 加一个 tool，host 通过 tool_call RPC 触发（但 pi RPC 模式是否支持 host 主动 invoke tool 需另调研，本次用 prompt 方案）。

### FR-2 连带影响 grep 声明（补全 SR6）

已 grep 核实 publicSessionId 前端消费点：
1. sessionStore.publicSessionId（session.ts:41）— 删除
2. useSidebar.ts:82 app.info 订阅拉命令 — 删除整个订阅块
3. Landing.vue:70 composerSid fallback（flow.currentSessionId ?? props.sessionId ?? publicSessionId）— 改为不读 publicSessionId（composerSid = flow.currentSessionId ?? props.sessionId，landing 真态 null）
4. useComposerInjection.ts:11-12 / CommandPopover.vue 注释 — 更新注释
5. message-broker.ts publicSessionId 字段 + app.info 补发 — 删除
6. session-service.ts ensurePublicSession / publicSessionId / 崩溃重建 — 删除

**landing 提交不受影响**：submitFirstMessage（useNewTaskFlow.ts:154）自己 sessionApi.create，不读 composerSid 的 publicSessionId fallback。核实确认移除安全。

### FR-10 landing 冷启动 loading 态（补全 SR9）

移除 publicSession 后，首次提交消息到 session 就绪期间（pi 冷启动 + skill 加载，典型 1-3s）：
- **UI loading 态**：Composer 提交按钮进入 loading（现有 createInFlight 机制已实现，useNewTaskFlow.ts:110），输入区禁用。
- **消息时序**：用户提交后，submitFirstMessage 等 sessionApi.create 返回后再发消息（现有逻辑，不变）。
- **无额外缓解**：不做预创建 hidden session（outOfScope）。首次冷启动延迟可接受（仅首次，后续 session 创建快）。
- **延迟量级**：pi 启动 + skill 扫描典型 1-3s（依赖 skill 数量），与现状 publicSession 启动时间一致（只是推迟到首次提交）。

---
确认无误后，请告知 agent 继续。如需修改，告诉 agent 要改什么。