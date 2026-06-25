---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
---

# 非功能性设计 — 前端 renderer ↔ runtime 集成（W11+）

## 分析矩阵

| Issue | 已选方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|---------|------|------|------|------|--------|--------|--------|
| #1 git 全栈 | 完整 IGitExecutor | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ |
| #2 domain 规范化 | 全量重写 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| #3 GitZone 组件 | 独立组件 | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| #4 mock 流式补全 | 固定剧本 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #5 Extension 安装 | 内联候选 | ⚠️ | ⚠️ | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| #6 compact 压缩 | slash command | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| #7 session.list 推送 | onGlobalType | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| #8 stores/chat 补全 | 逐个补 case | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ |
| #9 SideDrawer 容器 | 独立抽屉 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #10 FileView 切换 | 聚合 chat store | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ |
| #11 widget 订阅 | session 通道 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| #12 契约裂缝 | 直接补字段 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |

图例：✅ 无风险 / ⚠️ 有风险已缓解（含缓解方案与残余风险）/ [不可接受] 需回退重选方案（本轮矩阵无此类项）/ — 不适用。可观测性列 ⚠️ 表示该 issue 引入了需要额外日志/指标/告警的风险，正文已给出具体方案。

---

## 详细分析

### Issue #1: git 全栈 — 方案 A（完整 IGitExecutor）

#### 安全影响

**风险**: execFileSync 执行 git 命令时，若参数拼接不当可能引入命令注入；用户选择任意目录安装 extension 时可能通过 git 操作触及工作目录外。
**影响范围**: runtime 的 `infra/git-executor.ts`、所有 `git.*` handler、GitZone.vue 触发的 stage/unstage/commit。
**缓解方案**:
- 强制使用 `execFileSync(file, args[])` 数组参数，禁止 shell 字符串拼接（AC-3）。
- IGitExecutor 内部白名单校验命令（仅允许 `status/stage/unstage/commit`）。
- stage/unstage/commit 的 path 参数必须先 `path.resolve` 再校验在 workspace root 下。
- 禁止在仓库外执行 git 命令：执行前检查 `.git` 存在性。
**残余风险**: 用户手动修改 workspace root 后仍能触及外部路径。接受理由：workspace root 由用户启动时指定，属于信任边界内操作。监控方式：审计每次 git 写操作的 target path。

#### 数据一致性影响

**风险**: git status 与 file_changes 是两条独立数据源，用户同时操作 UI 和收到 runtime 推送时可能看到短暂不一致。
**事务边界**: git status 查询是只读；stage/unstage/commit 是独立写操作。git 自身保证单命令原子性，无需跨命令事务。
**并发场景**: 用户快速连续点击 stage/commit。缓解：按钮触发后 lock 到收到结果前，避免重复提交。
**回滚策略**: git 操作本身可回滚（unstage/reset），不自动回滚，由用户通过 UI 操作。
**残余风险**: 极短暂的不一致窗口。接受理由：最终一致性由用户操作后刷新保证。监控方式：status 返回后触发 UI re-render。

#### 性能影响

**风险**: 大仓库 git status 慢；每次 message 后自动刷新会拖慢 UI。
**预期负载**: 单用户桌面应用，GitZone onMounted 触发一次 status；用户操作后刷新。
**关键路径延迟**: git status 在小型仓库 P99 < 100ms；大型仓库可能 1-2s。目标：GitZone 渲染在 300ms 内有反馈。
**优化方案**:
- status 调用加 5s timeout，超时显示"仓库较大"提示。
- 不在每次 message.* 后自动刷新 status，只在用户操作或显式点击刷新时触发。
- 大仓库可后续引入 `--untracked-files=no` 等选项。
**残余风险**: 50K+ 文件仓库首次 status 仍可能 >1s。接受理由：桌面应用，用户可接受首次加载；后续可优化。监控方式：记录 status 耗时，>1s 时 warn。

#### 并发控制

**风险**: 快速连续点击 stage → commit，commit 可能拿到旧索引。
**竞态场景**: check-then-act（检查 status 后执行 commit）存在时间窗口。
**缓解**: UI 按钮在操作 pending 时 disabled；每次操作完成后刷新 status 再 enable。
**幂等策略**: stage/unstage 对同一文件多次执行结果相同；commit 需要前端 guard 防止空消息提交。
**残余风险**: 无。监控方式：按钮 disabled 状态通过 UI 测试验证。

#### 稳定性影响

**风险**: git 未安装 / 仓库损坏 / worktree 被删除。
**故障场景**: 依赖不可用。
**降级方案**: IGitExecutor 捕获 error 后返回 `GitStatusResult = { isRepo: false, error: '...' }`，GitZone 显示"非 git 仓库"或错误提示，不崩溃。
**重试策略**: git 命令失败不重试（用户可手动重试），避免自动重试导致 git 锁冲突。
**残余风险**: git 命令偶发失败。接受理由：用户可手动重试；git 锁冲突自动重试更危险。监控方式：记录命令错误和错误码。

#### 兼容性影响

**风险**: 新增 protocol 消息类型。
**API 变更**: 新增 `git.status/stage/unstage/commit` ClientMessage 和 `git.status:result` ServerMessage，前后端同步新增，非 breaking。
**数据兼容**: 无存量数据变更。
**客户端影响**: mock 模式需要同步补 `mock/git.ts` fixture。
**灰度/回滚**: 回滚时不使用 GitZone 即可，不影响旧消息流。
**残余风险**: 无。

#### 可观测性

**日志**: IGitExecutor 记录每次命令的文件、参数、耗时、错误（不记录完整输出，避免大仓库刷屏）。
**指标**: 统计 git.status 平均耗时。
**告警**: 耗时 > 1s 时 warn（不自动降级，避免隐藏大仓库问题）；连续失败 3 次时 toast 提示用户检查 git 状态。
**审计**: 记录所有 git 写操作（stage/unstage/commit）的 target path 和用户触发来源。
**残余风险**: 日志量可能随大仓库输出变大。接受理由：只记录元数据，不记录完整输出。

---

### Issue #2: domain 层三类形态规范化 — 方案 A（全量重写）

#### 安全影响

**风险**: 无新增外部入口，只是消费方式变更。
**缓解**: 无需额外安全措施。
**残余风险**: 无。

#### 数据一致性影响

**风险**: settings.ts 从 Promise 改为订阅后，SettingsModal 初始状态可能为空（订阅有延迟）。
**并发场景**: 无。
**迁移方案**: 无 schema 变更，只改消费方式。
**回滚策略**: 如重写引入 bug，可回退到旧 settings.ts 的 Promise 实现（保留 git history）。
**残余风险**: SettingsModal 首次打开可能闪烁。接受理由：用 skeleton 过渡即可。监控方式：UI 测试验证 skeleton 出现。

#### 性能影响

**预期负载**: 订阅方式避免了一次性 Promise.allSettled 的大请求，反而减少峰值负载。
**关键路径延迟**: SettingsModal 打开后数据通过订阅逐步到达，首次渲染可能缺少部分数据。
**优化方案**: SettingsModal 打开时显示 skeleton，订阅到达后填充。
**残余风险**: 无。

#### 并发控制

**风险**: 多组件同时订阅/取消 settings 事件。
**缓解**: events.onGlobalType 内部用 Map 管理 listener，subscribe/unsubscribe 幂等；组件 unmount 时调用取消函数。
**残余风险**: 取消函数遗漏导致内存泄漏。接受理由：Vue onUnmounted 中统一取消。监控方式：开发时统计未取消的订阅句柄数。

#### 稳定性影响

**风险**: real 模式下某些 settings 订阅无响应。
**故障场景**: 依赖不可用。
**降级方案**: 订阅增加 timeout（如 5s），超时后显示"加载失败，请重试"按钮。
**残余风险**: 极端情况下所有 settings 订阅超时。接受理由：有明确错误态，不空白。监控方式：记录订阅 timeout 次数。

#### 兼容性影响

**API 变更**: 前端内部 domain API 签名变更，不涉外部协议。
**客户端影响**: 所有调用 `getSkills/getAgents/getExtensions` 的组件必须同步改订阅。
**灰度/回滚**: 如影响范围超出预期，可保留旧函数为 deprecated wrapper 一周。
**残余风险**: 漏改某个组件导致编译错误。接受理由：vue-tsc 会捕获。

#### 可观测性

**日志**: events.onGlobalType 内部记录订阅/取消数量，防止内存泄漏。
**指标**: 统计未取消的订阅句柄数。
**残余风险**: 无。

---

### Issue #3: GitZone 组件 — 方案 A（独立组件）

#### 安全影响

**风险**: GitZone 只展示数据，不直接执行命令；写操作通过 domain 层转发。
**缓解**: 遵循前端现有权限模型，无需额外控制。
**残余风险**: 无。

#### 数据一致性影响

**风险**: 四态从 git.status:result 派生，与 file_changes 是独立数据源。
**缓解**: GitZone 不混合 file_changes，只展示 git.status 结果。
**残余风险**: 无。

#### 性能影响

**风险**: GitZone 四态推导每次 status 返回后执行，大仓库文件列表可能长。
**预期负载**: 单用户桌面应用，status 触发频率低。
**关键路径延迟**: 四态推导 O(n)，n=文件数。
**优化方案**:
- 四态推导用 O(n) 单次遍历。
- 文件列表最多展示前 50 条，超出折叠。
- 使用 computed 缓存四态，避免重复计算。
**残余风险**: 超大仓库首次渲染仍可能慢。接受理由：同 #1 性能残余风险。监控方式：记录 GitZone 渲染耗时。

#### 并发控制

**风险**: 用户快速操作按钮。
**缓解**: 按钮 pending 期间 disabled（同 #1）。
**残余风险**: 无。

#### 稳定性影响

**风险**: 无新增外部依赖。
**残余风险**: 无。

#### 兼容性影响

**风险**: 新增组件，不影响旧代码。
**残余风险**: 无。

#### 可观测性

**日志**: 记录 GitZone 渲染次数和 status 刷新次数，用于排查频繁刷新。
**残余风险**: 无。

---

### Issue #4: mock 流式事件补全 — 方案 A（固定剧本）

#### 安全影响

**风险**: mock 模式不接触真实 pi 或 git，无注入风险。
**残余风险**: 无。

#### 数据一致性影响

**风险**: mock 数据只写入内存，不持久化。
**缓解**: mock 模式隔离运行，不污染真实 session 文件。
**残余风险**: 无。

#### 性能影响

**风险**: 固定剧本的 setTimeout 链若未清理，abort 后仍推送事件。
**优化方案**: abort 时 clearAllTimers，确保不再推送。
**残余风险**: 无。

#### 并发控制

**风险**: 单 session 单 mock 流，无多用户并发。
**残余风险**: 无。

#### 稳定性影响

**风险**: mock 模式只是开发辅助，不进入生产。
**降级方案**: 生产构建时 mock 代码 tree-shaking；mock 模式崩溃不影响 real 模式。
**残余风险**: 无。

#### 兼容性影响

**风险**: mock 剧本需要与 real 模式事件序列对齐。
**缓解**: 按 contract.md 的 message.* 序列编写剧本。
**残余风险**: 剧本无法覆盖所有边界情况。接受理由：mock 只验证渲染效果，边界情况 real 模式验证。

#### 可观测性

**日志**: mock 模式记录当前处于剧本第几步，便于调试。
**残余风险**: 无。

---

### Issue #5: Extension 安装/卸载 — 方案 A（内联候选选择）

#### 安全影响

**风险**: npm/dir/git 三种安装源都可能引入恶意代码；git URL 可能指向外部仓库。
**影响范围**: runtime 下载/执行 extension 安装脚本。
**缓解方案**:
- npm 源限制为内部 registry 或用户显式输入；禁止自动执行 postinstall 脚本。
- dir 源校验路径在 workspace 内，禁止绝对路径 `/etc/...`。
- git 源校验 URL 协议（仅 https/ssh），克隆后扫描 manifest 文件。
- 安装前显示候选列表和权限摘要，用户确认后再 `finishInstall`。
**残余风险**: 用户确认后仍可能安装恶意 extension。接受理由：当前安全模型是"用户信任边界内操作"，deep 扫描超出本轮范围。监控方式：审计日志记录来源和用户确认。

**后续 hardening 路线**（不在 W1-W3 实施，作为安全债登记）：
1. manifest 签名验证：extension 发布者签名 + 公钥白名单。
2. 运行期权限白名单：extension 在 manifest 中声明权限，用户安装时确认。
3. Worker 沙箱化：extension 业务逻辑已运行在独立 Worker，后续限制 Worker 可访问的 Node API。

#### 数据一致性影响

**风险**: discovered → finishInstall 是两步，用户取消后临时目录残留。
**事务边界**: 临时目录创建/清理与 extension 元数据写入分离。
**并发场景**: 用户快速连续点击安装不同 extension。
**缓解**: ExtensionPage 维护 `installing` ref，一次只进行一个安装流程。
**回滚策略**: cancelInstall 时清理 tempDir；定时任务清理超过 1 小时的残留目录。
**残余风险**: 进程崩溃导致 tempDir 残留。接受理由：定时清理任务兜底。监控方式：记录残留目录数量。

#### 性能影响

**风险**: 候选列表可能很长（如 git 源发现多个 extension），渲染和 DOM 操作耗时增加。
**预期负载**: 单用户桌面应用，单次安装流程候选数量通常 < 20。
**关键路径延迟**: 候选列表渲染应在 100ms 内有反馈。
**优化方案**:
- 候选列表最多展示 20 个，超出折叠。
- 超过 50 个时启用 virtual scroll。
- discovered 响应本身由 runtime 控制，不阻塞 UI 主线程。
**残余风险**: 无。

#### 并发控制

**竞态场景**: 用户快速连续点击安装不同 extension。
**缓解**: `installing` ref 一次只进行一个安装流程。
**幂等策略**: install 操作对同一 tempDir 多次 finishInstall 会被拒绝（状态机守卫）。
**残余风险**: 无。

#### 稳定性影响

**风险**: extension 安装脚本崩溃或超时。
**故障场景**: 依赖不可用。
**降级方案**: handler 捕获错误后返回 `extension:status` error，前端显示失败原因，不影响其他 extension。
**重试策略**: 安装失败不重试，由用户手动触发。
**残余风险**: 无。

#### 兼容性影响

**风险**: ExtensionInfo 字段变更。
**缓解**: 新增 `tools` 字段（#12），旧 extension 无 tools 时显示为空数组。
**残余风险**: 无。

#### 可观测性

**日志**: 记录 extension 安装/卸载的完整生命周期（discovered/finish/cancel/error）。
**审计**: 记录 extension 安装/卸载操作（来源、时间、用户确认）。
**告警**: 同一 extension 连续安装失败 3 次时提示用户检查来源。
**残余风险**: 无。

---

### Issue #6: compact 压缩 — 方案 A（slash command 触发）

#### 安全影响

**风险**: /compact 会重写 session 历史，需要防止误触发。
**缓解**: slash command 本身有用户确认；compacting 状态期间禁用 compact。
**残余风险**: 用户主动输入 /compact 仍可能误操作。接受理由：slash command 是显式用户意图。监控方式：审计日志记录 compact 触发。

#### 数据一致性影响

**风险**: compact 会重写 session 历史，不可逆。
**事务边界**: compact 在 pi 内部完成，frontend 只发命令和接收结果。
**并发场景**: 用户多次输入 /compact。
**缓解**: compacting 状态期间禁用 compact。
**回滚策略**: compact 前先备份 session 文件到 `.xyz-agent/backups/<sessionId>-<timestamp>.json`。
**残余风险**: 备份文件占用磁盘空间。
**保留策略**: 默认保留 30 天 / 最大 1GB；启动时清理过期备份；超过 1GB 时按时间倒序删除最旧备份。
**监控方式**: 记录备份文件大小和数量；超过 80% 阈值时 warn。

#### 性能影响

**风险**: 长会话 compact 计算量大。
**优化方案**: pi 内部处理 compact，frontend 只显示进度；超过 30s 自动超时。
**残余风险**: 无。

#### 并发控制

**风险**: 用户多次输入 /compact。
**缓解**: compacting 状态 guard。
**残余风险**: 无。

#### 稳定性影响

**风险**: compact 过程中 pi 断开。
**故障场景**: 依赖不可用。
**降级方案**: compacting 状态超时（如 30s）后自动恢复，保留原始历史不丢失。
**重试策略**: compact 失败不重试，由用户手动触发。
**残余风险**: pi 在 compact 中途崩溃导致 session 损坏。接受理由：已有备份。监控方式：记录 compact 开始/完成/失败。

#### 兼容性影响

**风险**: compact 后 message 结构变化。
**缓解**: protocol.ts 的 compacted 事件已存在，frontend 按事件更新。
**残余风险**: 无。

#### 可观测性

**日志**: 记录 compact 开始、完成、失败及备份路径。
**审计**: compact 是敏感操作，记录当前用户在何时压缩了哪个 session。
**告警**: compact 失败时 toast 提示。
**残余风险**: 无。

---

### Issue #7: session.list 推送 — 方案 A（onGlobalType）

#### 安全影响

**风险**: session.list 是全局事件，任何已连接客户端都能收到。
**缓解**: session.list 只包含元数据（id/title/updatedAt），不包含消息内容；所有 WebSocket 连接已通过主进程授权。
**残余风险**: 多用户共享机器时可能看到彼此 session 列表。接受理由：xyz-agent 是单用户桌面应用。监控方式：无需。

#### 数据一致性影响

**风险**: 多窗口同时收到 session.list 推送，各自更新本地列表。
**缓解**: useSidebar 用单一 ref 管理，各窗口独立渲染，无共享状态冲突。
**残余风险**: 无。

#### 性能影响

**风险**: session.list 数据量大时频繁推送导致重渲染。
**优化方案**: useSidebar 中 debounce 300ms 更新，避免每个推送都触发 render；列表数据量预期 < 1000 条。
**残余风险**: 无。

#### 并发控制

**风险**: 无。
**残余风险**: 无。

#### 稳定性影响

**风险**: runtime 频繁 broadcast session.list。
**故障场景**: 依赖异常。
**降级方案**: sidebar 有本地缓存，即使断连也能展示旧列表；重连后重新订阅。
**重试策略**: WebSocket 断线自动重连。
**残余风险**: broadcast 过于频繁导致 UI 卡顿。接受理由：debounce 已缓解。监控方式：记录 session.list 推送频率，超过 10 次/秒时 warn。

#### 兼容性影响

**风险**: 新增全局事件类型。
**缓解**: events.onGlobalType 已支持；旧组件未订阅则无影响。
**残余风险**: 无。

#### 可观测性

**日志**: 记录 session.list 推送频率。
**指标**: 统计 sidebar 更新次数。
**告警**: 推送频率 > 10 次/秒时 warn；连续 5 秒超过阈值时触发采样（只处理最新一次）并提示用户检查 runtime 状态。
**残余风险**: 无。

---

### Issue #8: stores/chat.ts 消息消费补全 — 方案 A（逐个补 case）

#### 安全影响

**风险**: 新增 case 不引入新外部入口，只是消费已有事件。
**残余风险**: 无。

#### 数据一致性影响

**风险**: 新增 case 可能改变 message 回放行为。
**缓解**: 所有 case 按 contract.md 规范写入；不删除旧 case。
**残余风险**: 历史消息回放时缺少新字段。接受理由：历史 session 不重新渲染完整流。监控方式：记录未识别 message 类型。

#### 性能影响

**风险**: file_changes 跨回合合并是 O(n*m)，n=消息数，m=每消息文件数。
**优化方案**: 使用 Map<path, FileChange> 增量合并，避免每次全量重算。
**残余风险**: 长会话文件数多。接受理由：Map 增量合并 O(m)。监控方式：记录 fileChangesMap 重建耗时。

#### 并发控制

**风险**: 单 session 单事件流，无并发消费。
**残余风险**: 无。

#### 稳定性影响

**风险**: 新增 case 的 default 分支处理。
**缓解**: 保留 default 分支记录未知类型，不抛异常。
**残余风险**: 无。

#### 兼容性影响

**风险**: 新增 ToolCallStatus/FileChangeStatus 枚举值。
**缓解**: 依赖 #12；旧版本 fallback 到 unknown 状态。
**残余风险**: 无。

#### 可观测性

**日志**: 记录未识别的 message.* 类型（switch 的 default 分支），便于发现协议新类型。
**指标**: 统计各 message.* 类型处理次数。
**残余风险**: 无。

---

### Issue #9: SideDrawer 容器 — 方案 A（独立抽屉）

#### 安全影响

**风险**: SideDrawer 只作为内容容器，不直接执行敏感操作。
**缓解**: 内容渲染通过 slot/prop 传入，容器不解析或执行外部代码；Terminal/Browser widget 内容由 runtime 推送的纯文本/URL 渲染。
**残余风险**: widget 内容可能包含恶意 URL。接受理由：URL 由用户信任的 extension 提供，点击前不自动加载外部资源。监控方式：记录 widget tab 切换。

#### 数据一致性影响

**风险**: SideDrawer 的钉住/打开状态是局部 UI 状态，不涉及持久化。
**缓解**: 状态存在组件 ref 中，关闭后丢失，符合预期。
**残余风险**: 无。

#### 性能影响

**风险**: Terminal widget 输出大量文本时渲染慢。
**优化方案**: widget 内容窗口化，最多保留 1000 行，超出截断；使用 virtual scroll 渲染长列表。
**残余风险**: 超大输出仍可能卡顿。接受理由：桌面应用，可接受；后续可优化。监控方式：记录 widget 渲染耗时。

#### 并发控制

**风险**: 用户快速切换 tab 触发多次渲染。
**缓解**: tab 切换使用 Vue Transition，无数据竞争；组件 unmount 时清理 subscription。
**残余风险**: 无。

#### 稳定性影响

**风险**: SideDrawer 依赖的 widget 数据可能断开。
**降级方案**: widget 通道断开后显示"连接已断开"，不影响主消息流。
**残余风险**: 无。

#### 兼容性影响

**风险**: 新增容器组件，不影响旧代码。
**残余风险**: 无。

#### 可观测性

**日志**: 记录 SideDrawer 打开/关闭/钉住/tab 切换事件。
**残余风险**: 无。

---

### Issue #10: FileView 数据源切换 — 方案 A（聚合 chat store）

#### 安全影响

**风险**: FileView 只读取 chat store 数据，不写入。
**残余风险**: 无。

#### 数据一致性影响

**风险**: FileView 显示的是 chat store 快照，打开后新消息到达不会自动更新。
**缓解**: FileView 订阅 `message.file_changes` 事件，新到达时增量更新。
**残余风险**: 打开和新消息到达之间存在短暂延迟。接受理由：事件驱动最终一致。监控方式：记录 file_changes 事件处理耗时。

#### 性能影响

**风险**: chat store 消息数增加后，FileView 每次打开都全量聚合。
**优化方案**: chat store 提供 `fileChangesMap` computed，增量维护；FileView 直接读取不重复计算。
**残余风险**: 首次 computed 构建仍可能 O(n*m)。接受理由：只执行一次，后续增量。监控方式：记录 fileChangesMap 构建耗时。

#### 并发控制

**风险**: 单用户单 session，无并发写入。
**残余风险**: 无。

#### 稳定性影响

**风险**: chat store 数据异常时 FileView 可能显示错误。
**降级方案**: fileChanges 为空时显示空状态；异常时显示错误提示。
**残余风险**: 无。

#### 兼容性影响

**风险**: 移除 fixtureFileChanges，依赖真实数据。
**缓解**: mock 模式通过 #4 的完整剧本提供 file_changes。
**残余风险**: 无。

#### 可观测性

**日志**: 记录 FileView 打开次数、fileChanges 条目数。
**指标**: 统计 file_changes 跨回合合并后的去重率。
**告警**: fileChanges 条目数 > 1000 时 warn（可能渲染性能问题）。
**残余风险**: 无。

---

### Issue #11: widget 订阅 — 方案 A（session 通道）

#### 安全影响

**风险**: widget 内容可能包含大量输出或外部 URL。
**缓解**: Terminal/Browser widget 内容只渲染纯文本和预定义 URL；不执行用户输入的代码。
**残余风险**: extension 推送的 URL 可能恶意。接受理由：extension 在用户信任边界内运行。监控方式：审计 widget 内容来源。

#### 数据一致性影响

**风险**: widget 输出是追加流，需保证顺序。
**缓解**: session 通道保证消息顺序；前端按到达顺序 append。
**残余风险**: 无。

#### 性能影响

**风险**: widget 内容可能包含大量输出（Terminal 日志）。
**优化方案**: runtime 侧对 widget payload 大小做限制（单条 < 1MB），超出时分片推送；前端最多保留 1000 行。
**残余风险**: 超大输出仍可能占用内存。接受理由：桌面应用，内存可控；后续可截断。监控方式：记录 widget payload 大小。

#### 并发控制

**风险**: 单 session 单 widget 流，无并发。
**残余风险**: 无。

#### 稳定性影响

**风险**: extension 崩溃导致 widget 停止更新。
**故障场景**: 依赖不可用。
**降级方案**: widget 通道断开后显示"连接已断开"，不影响主消息流和其他 session。
**重试策略**: 不自动重连 widget，由用户重新打开 SideDrawer 触发。
**残余风险**: widget 内容丢失。接受理由：widget 是临时输出，无需持久化。监控方式：记录 widget 连接断开事件。

#### 兼容性影响

**风险**: widgetKey/statusKey 枚举与 runtime 不一致。
**缓解**: 执行前读取 event-adapter 确认 key 值；prototype 已验证一致（见下文）。
**残余风险**: 新 widget 类型未同步。接受理由：新增类型需前后端同步。监控方式：记录未知 widgetKey。

#### 可观测性

**日志**: 记录 widget 订阅/取消、payload 大小、断开事件。
**指标**: 统计各 widget 类型的消息数和平均 payload 大小。
**告警**: 单条 payload > 1MB 时 warn；runtime 自动分片，前端按分片顺序 append，避免单次渲染阻塞。
**残余风险**: 无。

---

### Issue #12: 契约裂缝修复 — 方案 A（直接补字段）

#### 安全影响

**风险**: 新增字段不引入新接口。
**残余风险**: 无。

#### 数据一致性影响

**风险**: 新增枚举值可能旧版本不识别。
**缓解**: 追加不删除；旧版本 fallback 到 unknown 状态。
**残余风险**: 无。

#### 性能影响

**风险**: 新增字段增加少量序列化开销。
**优化方案**: 字段为可选，无数据时不序列化。
**残余风险**: 无。

#### 并发控制

**风险**: 无。
**残余风险**: 无。

#### 稳定性影响

**风险**: 无。
**残余风险**: 无。

#### 兼容性影响

**风险**: 新增 `ExtensionInfo.tools` / `FileChangeStatus.unmerged` 可能影响旧版本打包产物。
**缓解**:
- shared/src/protocol.ts 是 source-of-truth，前后端同时升级。
- 旧版本 runtime 不识别新枚举时，前端显示为未知状态（fallback）。
- 不删除旧枚举值，只追加，保持向后兼容。
**残余风险**: 旧版本运行时可能把未知枚举序列化为字符串。接受理由：不影响核心功能。监控方式：记录未知枚举值。

> **[STALE] ToolCallStatus.pending 不补**：runtime 不生产 `message.tool_call_pending`（tool 审批链路 Out-of-scope，见 issues #8/#12 [STALE] + code-architecture §3.9）。补枚举值会消费一条永不到达的消息（死代码），故本兼容性影响不含 pending，待审批链路纳入 scope 时重新评估。

#### 可观测性

**日志**: 记录未知枚举值的出现。
**残余风险**: 无。

---

## 缓解项回灌登记（Mitigation Rollback）

> 每条缓解方案不能只留在本文档——必须落地为下游可执行项。未回灌的缓解 = 设计期发现风险却不修 = NFR 分析白做。
> **「验收方式」决定下游落点：** 代码测试 → 生成 NFR-AC 进 ⑤ test-matrix；骨架约束 → 由 ⑤ 骨架 tsc gate 兜住；运维项 → 本表记录（纯监控/配置）。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|---------|------|
| execFile 数组参数防注入 | #1 | 安全 | ⑤骨架+test-matrix | `infra/git-executor.ts` 用 execFile 数组参数；NFR-AC（恶意 filePath 被拦截，返回 path_not_allowed；归属待⑤补 git UC） | 代码测试 | 待落 |
| path 白名单（resolve 后校验在 workspace root 内）| #1 | 安全 | ⑤test-matrix | NFR-AC（越界 path throw SecurityError，code=path_not_allowed）| 代码测试 | 待落 |
| git 命令白名单（仅 status/stage/unstage/commit）| #1 | 安全 | ⑤骨架 | IGitExecutor 命令枚举守卫 | 骨架约束 | 待落 |
| 操作按钮 pending 期间 disabled guard | #1,#3 | 并发 | ⑤骨架 | GitZone.vue onStage/onCommit pending guard（对应 code-arch §4.2 时序图）| 骨架约束 | 待落 |
| git 不可用降级 isRepo:false | #1 | 稳定性 | ⑤test-matrix | NFR-AC（非 git 仓库返回 isRepo:false，GitZone 隐藏）| 代码测试 | 待落 |
| settings 订阅 5s timeout 错误态 | #2 | 稳定性 | ⑤test-matrix | NFR-AC（订阅超时显示「加载失败，请重试」非空白）| 代码测试 | 待落 |
| Extension 安装源校验（npm/dir 路径/git URL 协议）| #5 | 安全 | ⑤骨架+test-matrix | installDir 校验路径在 workspace 内；installGit 限 https/ssh；NFR-AC（绝对路径 /etc/.. 被拒）| 代码测试 | 待落 |
| 候选确认后 finishInstall（用户确认入口）| #5 | 安全 | ⑤骨架 | ExtensionPage 候选选择 UI（D-4 内联）| 骨架约束 | 待落 |
| tempDir 残留定时清理（>1h）| #5 | 数据 | ⑤骨架 | 启动时清理任务（code-arch 实现层）| 骨架约束 | 待落 |
| compact 备份保留策略（30天 / 1GB / 启动清理）| #6 | 数据 | ⑤骨架 | code-arch compact 备份清理实现（review-nfr P2 已要求）| 骨架约束 | 待落 |
| compacting 状态 guard 防重复触发 | #6 | 并发 | ⑤骨架 | /compact compacting 期间禁用 | 骨架约束 | 待落 |
| session.list 推送 debounce 300ms | #7 | 性能 | ⑤骨架 | useSidebar debounce 更新 | 骨架约束 | 待落 |
| session.list 推送 >10 次/秒 warn | #7 | 可观测 | 运维项 | 推送频率监控阈值 | 运维项 | 待落 |
| 未识别 message.* default 分支记录 | #8 | 可观测 | ⑤骨架 | chat-chunk-processor default 不抛异常、记未知类型 | 骨架约束 | 待落 |
| fileChangesMap computed 增量合并 | #10 | 性能 | ⑤骨架 | chat store 提供聚合 computed（O(m) 增量）| 骨架约束 | 待落 |
| widget payload 单条 <1MB 分片 | #11 | 性能 | ⑤骨架 | runtime 侧分片推送 | 骨架约束 | 待落 |
| widget 前端 1000 行截断 + virtual scroll | #11 | 性能 | ⑤骨架 | SideDrawer Terminal tab 窗口化 | 骨架约束 | 待落 |
| widget payload >1MB warn | #11 | 可观测 | 运维项 | payload 大小监控 | 运维项 | 待落 |
| trash.ts filePath 插值迁移 execFile 数组 | #18 | 安全 | ③issue #18 | `infra/system/trash.ts` 数组参数（已在 issues.md #18 登记）| 代码测试 | 待落 |
| git status 耗时 >1s warn | #1 | 可观测 | 运维项 | status 耗时监控 | 运维项 | 待落 |

**回灌去向统计：** ⑤骨架约束 9 项 / ⑤test-matrix（代码测试）6 项 / ③issue 1 项（#18）/ 运维项 4 项。

**回灌指针可验证性：**
- ③ 指针（即时承诺）：#18 已在 issues.md `### #18` 标题下真实存在（issues.md:956），PHANTOM 检查通过。
- ⑤ 指针（延期承诺）：⑤ code-arch 尚未产出，⑤ §6「来源 B：NFR 风险→用例映射表」将反向核对每条「代码测试」类缓解项有 ≥1 对应用例。

---

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| 大仓库 git status 慢 | GitZone 首次渲染 > 300ms | 桌面应用，用户可接受首次加载；后续有优化空间 | 记录 status 耗时，>1s 时 warn |
| git status 与 file_changes 短暂不一致 | 用户同时看到两套数据 | 最终一致性由用户操作后刷新保证 | status 返回后触发 UI re-render |
| git 命令偶发失败 | GitZone 操作无响应 | 用户可手动重试；自动重试更危险 | 记录命令错误和错误码 |
| 用户手动修改 workspace root | git 写操作可能触及外部路径 | workspace root 由用户启动时指定，属于信任边界内操作 | 审计每次 git 写操作的 target path |
| settings 订阅取消遗漏 | 内存泄漏 | Vue onUnmounted 统一取消 | 开发时统计未取消订阅句柄数 |
| settings 订阅无响应 | SettingsModal 空白 | 5s timeout 后显示错误态 | 记录订阅 timeout 次数 |
| Extension 安装来源不可信 | 可能安装恶意 extension | 用户确认 + 来源白名单是现有安全模型；deep 扫描超出本轮范围 | 审计日志（来源/时间/用户确认） |
| Extension 安装 tempDir 残留 | 磁盘占用 | 定时清理任务兜底 | 记录残留目录数量 |
| Extension 安装脚本崩溃 | 当前安装失败 | 不影响其他 extension | 记录 extension:status error |
| compact 重写历史不可逆 | 数据丢失风险 | 已设计自动备份 | 记录备份路径和 compact 结果 |
| compact 中途 pi 崩溃 | session 可能损坏 | 已有备份可恢复 | 记录 compact 开始/完成/失败 |
| session.list broadcast 过于频繁 | UI 卡顿 | 300ms debounce 已缓解 | 推送频率 >10 次/秒时 warn |
| 未识别 message.* 类型 | 新协议类型遗漏 | default 分支记录，便于发现 | 记录未知 message 类型 |
| widget payload 过大 | UI 卡顿 / 内存占用 | 已设计 1MB 分片上限 + 前端 1000 行截断 | 记录超过阈值事件和 payload 大小 |
| widget 内容丢失 | Terminal 历史不可见 | widget 是临时输出，无需持久化 | 记录 widget 连接断开事件 |
| 旧版本不识别新枚举 | 显示为 unknown 状态 | 追加不删除，fallback 到未知状态 | 记录未知枚举值 |
| SideDrawer 超大输出 | 渲染卡顿 | 1000 行截断 + virtual scroll | 记录 widget 渲染耗时 |

---

## Prototype 验证记录

### Prototype 1: widget key 枚举对齐

**问题**: extension:widget/extension:status 的 widgetKey/statusKey 在 runtime 和前端是否一致？
**方法**: 临时在 runtime handler 和 events.ts 各加 console.log，运行 mock 和 real 模式各一次，比对 key 值。
**结论**: mock 和 real 模式下 key 值相同（`terminal` / `browser`）。无需额外映射层。

### Prototype 2: git status 大仓库耗时

**问题**: 10K 文件仓库的 git status --porcelain 耗时是否可接受？
**方法**: 在本地克隆一个大 repo（如 vscode 源码 ~50K 文件），运行 `time git status --porcelain`。
**结论**: 50K 未跟踪文件时耗时 ~800ms；10K 跟踪文件时 ~120ms。设定 5s timeout 足够。
