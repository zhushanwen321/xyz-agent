---
topic: recent-workspaces
deliverable: nfr
verdict: pass
stage: mid-detail-plan
complexity_tier: L2
upstream: issues.md
downstream: code-architecture.md
backfed_from: []
---

# 非功能性设计 — recent-workspaces（最近工作区独立持久化）

> mid-detail-plan ④NFR 产出。对 issues.md 每个 issue 的**已决策方案**沿 7 维度副作用树分析 + 缓解 + 验收方式。
> 决策不重复（引用 D-NNN）；issue 编号 + AC 溯源（[from: issues #N AC-N.M]）。
> 长期约束对照项目根 `NFR.md`（7 维度工程级不变式）+ `AGENTS.md` 测试规范段。

## 分析矩阵

> 图例：✅ 无风险（一行理由见详细分析） / ⚠️ 有风险已缓解（按 4 字段模板展开）。本功能所有 issue 方案均 confirmed，无可接受性否决项。

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 持久化 Store + LRU | a/b 待 code-arch | ⚠️ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| #2 WorkspaceService 编排 | A（service 守卫） | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ |
| #3 RPC + handler | A（独立 handler） | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| #4 前端 store + INV-6 时序 | A（显式 load） | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| #5 删派生函数 | 单一（D-002 落地） | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #6 cwd 失效降级 | A（不过滤+选中降级） | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |

**并发维度全 ✅ 的统一理由**（防偷懒跳过的集中说明，不逐 issue 重复）：本功能运行期并发面**恒定为空**——runtime 是单进程内单 WS 连接服务（SessionService 持有单一 sessions Map，组合 lifecycle/dispatcher/scanner 经 Facade 访问，NFR.md §4「session 单写者」），前端是单线程 JS。`WorkspaceService.record` 的两个触发点（SessionLifecycle.create / MessageDispatcher.sendPrompt）虽可能被不同 session 的消息交错调用，但均在**同进程同事件循环**内串行执行（无 worker、无多实例、无跨进程），Node 单线程语义保证 `record → store.upsert → trim` 的 check-then-act 无竞态窗口。D-004 pull-only RPC 单消费点（前端 workspaceStore.load）亦无并发拉取。故全 6 issue 并发维度风险均低，详细分析不再展开。

---

## 详细分析

### Issue #1: 持久化 Store + LRU 淘汰算法（方案 a/b 待 code-arch 骨架验证）

#### ⚠️ 安全

- **风险**: cwd 路径字符串（用户工作目录绝对路径）落盘到 `recent-workspaces.json`；路径硬编码风险（INV-5）。
- **影响范围**: `RecentWorkspacesStore` 持久化路径推导 + record 入参（cwd 来自 session.cwd，间接来自用户选择）。
- **缓解方案**: ①路径用 `join(getConfigDir(), 'recent-workspaces.json')` 动态推导（INV-5），pre-commit `check_path_whitelist.py` 守护（NFR.md §1）；②无目录穿越面——本功能**仅记录 cwd 字符串不执行**（不像 file/git 服务把 cwd 作为 fs 操作根去 isUnderOrEqual 守门，record 的 cwd 不进入任何 `readFile/execFileSync` 路径），字符串落地无代码执行语义；③无敏感数据泄漏面——本地单机单用户，无多租户、无远程上报，路径数据不出本机。
- **残余风险**: 无。记录的 cwd 本就是用户自己机器上的目录，不构成新暴露面。

#### ⚠️ 数据

- **事务边界**: 单文件 `recent-workspaces.json` 的「读-改-upsert-trim-写」是 store 内逻辑序列，无跨文件事务需求。
- **并发场景**: 见统一理由（单进程单线程，无并发）。
- **迁移方案**: **无迁移**（D-001 冷启动纯空开始，首屏空态随用随积累）。存量 session 派生数据不导入——这是 requirements §7 已确认边界。
- **回滚策略**: 落盘一致性靠 `atomicWrite`（temp file + rename，NFR.md §2「PluginStorage 原子写」同模式）——半写崩溃时 rename 原子性保证要么旧文件要么新文件，不会出现损坏的中间态。文件已损坏（外部因素、磁盘错误）时 `loadPartition`/`deserialize` try/catch 降级空数组（INV-4，AC-1.5/1.6）。

#### ⚠️ 稳定性

- **故障场景**: WriteBackCache 的 write-back 语义（dirty + 定时 flush）存在崩溃丢数据窗口——`record` 后内存已更新但未 flush，进程崩溃则该次 record 丢失。flush 周期 = `DEFAULT_FLUSH_MS=500`（per-write debounce）+ `FLUSH_INTERVAL_MS=5000`（全量周期兜底，见 cheatsheet §A session-data-store 范例）。
- **降级方案**: 进程重启后从磁盘 reload，丢失的 record 在下次该目录被「新建/重活」时重记（S4 两写入时机覆盖）。pull（listRecent）读 WriteBackCache **内存视图**非直接读盘（system-arch §6，红队 nit-2），故 flush 时机不影响 pull 正确性（pull 总拿最新值）。
- **熔断/限流**: 不适用（无下游服务依赖）。
- **重试策略**: 不适用（record 是幂等 upsert，无失败重试需求；load 失败降级空数组）。
- **SLA 影响**: 无 SLA 承诺。残余：崩溃窗口内（≤500ms debounce 或 ≤5s 周期）未 flush 的 record 丢失——**接受**（单条 record 业务价值低，目录被再次使用即重记，不构成数据完整性损害）。**需⑤骨架验证**：flush 周期行为 + pull 读内存语义（见末节登记）。

#### ⚠️ 可观测性

- **日志**: 候选——record 写入 / LRU 淘汰 / 损坏降级三类事件的结构化日志（未硬约束，归⑤决定是否落 console.debug 或 logger）。
- **指标**: 无业务指标需求（top10 量级，无吞吐/延迟指标价值）。
- **追踪**: 无跨服务调用链（单进程内调用）。
- **告警**: 无需告警（本地功能，无运维面）。
- **审计**: 无敏感操作审计需求（路径记录是用户自身数据）。

#### ✅ 性能 / 兼容性（一行理由）

- **性能 ✅**: top10 记录 ~2KB（10 × ~200B cwd+timestamp+label），整体读写（非按行查），WriteBackCache 500ms debounce 合并高频写，无性能瓶颈（C3 已排除 SQLite）。
- **兼容性 ✅**: 冷启动空开始（D-001），文件不存在/首次启动 → loadPartition 返回空 Map（WriteBackCache ENOENT 语义，cheatsheet §A），无向后兼容负担。

---

### Issue #2: WorkspaceService（写入时机编排 + trim，方案 A service 层守卫）

#### ⚠️ 性能

- **预期负载**: 写入时机 B（MessageDispatcher.sendPrompt）触发频率 = 用户发消息频率，高频（每条消息一次 record）。写入时机 A（SessionLifecycle.create）低频。
- **关键路径延迟**: record 非用户阻塞路径（session 创建/发消息的副作用，不回传用户）。单次 record = Map upsert O(1) + trim（≤10 条 sort/slice，O(1) 量级）+ WriteBackCache.set 标 dirty，μs 级。
- **扩展性瓶颈**: 无（数据量固定 ≤10）。
- **优化方案**: debounce 归位 WriteBackCache（system-arch §7，AC-2.4 grep 确认 service 无 setTimeout/setInterval）——高频 record 在内存累积，WriteBackCache 500ms debounce 合并落盘。**service 层不额外 debounce**（避免双层 debounce 语义混淆，D-005）。

#### ⚠️ 兼容性

- **API 变更**: 新增 `WorkspaceService.record(cwd)` 内部 API（非跨进程）。INV-1 双层守卫（service 统一守卫 + store 防御性守卫，issues #2 取舍决策）。
- **数据兼容**: 不涉及（service 无持久化职责）。
- **客户端影响**: 调用方变更——`SessionLifecycle.create` 和 `MessageDispatcher.sendPrompt` 新增 record 调用（cheatsheet §D 精确行号：session-lifecycle.ts:39 create + message-dispatcher.ts:58 sendPrompt）。注入链路：index.ts 组合根实例化 → SessionService 构造注入 lifecycle/dispatcher（cheatsheet §C，与 SessionService 平级非嵌套）。
- **灰度/回滚**: D-007 写入时机 A 只挂 create（不扩展到 selectDirectory）——语义清晰「真正开始的任务才算记录」，若回滚需同步移除两处 record 调用 + 注入。

#### ✅ 安全 / 数据 / 并发 / 稳定性 / 可观测性（一行理由）

- **安全 ✅**: service 只编排不接触路径安全面（路径安全在 store/infra 层）。
- **数据 ✅**: service 不持有数据，INV-1 守卫后委托 store 落盘（AC-2.3 record('')/undefined 静默跳过）。
- **并发 ✅**: 见统一理由（单进程单线程）。
- **稳定性 ✅**: service 无崩溃放大路径（异常由 store loadPartition try/catch 处理，不冒泡到 session 创建/发消息主流程——见 #1 数据降级）。
- **可观测性 ✅**: 编排层日志归 store（写入/淘汰）+ handler（RPC），service 自身无独立观测点。

---

### Issue #3: RPC 契约 + transport handler（方案 A 独立 WorkspaceMessageHandler）

#### ⚠️ 稳定性

- **故障场景**: RPC reply 失败路径——前端 `workspaceApi.listRecent` 的 pending promise 可能因 WS 断连、runtime 异常、超时而 reject（pending.ts 无 clear/flush，NFR.md §5「WS 源超时 race S-7」类风险）。
- **降级方案**: 前端 `workspaceStore.load()` catch reject → records 置空数组，不抛错（AC-4.5）。降级后首屏默认 cwd = undefined（上层 fallback 不变，UC-6.2）。**不走 `markSessionError`**（架构不变式 #6 管的是 session 级错误入口；本功能 reply 数据性质全局非 session 级，走 pending.reject 即可，system-arch §6 已澄清不与不变式 #2/#6 冲突）。
- **熔断/限流**: 不适用（pull 单次，无重试风暴面）。
- **重试策略**: 不自动重试（load 失败已降级，下次进入新建任务流程再 load）。
- **SLA 影响**: 无。残余：WS 断连期间首屏默认 cwd 拿空——**接受**（上层 homedir fallback 不变，用户体验退化为「无最近目录提示」，非阻塞）。

#### ✅ 安全 / 数据 / 性能 / 并发 / 兼容性 / 可观测性（一行理由）

- **安全 ✅**: handler 零业务（只 ctx.reply，AC-3.2），不接触用户输入处理面。
- **数据 ✅**: reply payload 是 records 数组快照，无持久化操作（读内存视图，system-arch §6）。
- **性能 ✅**: pull 读 WriteBackCache 内存（非读盘），≤10 条 ~2KB，WS round-trip ms 级，initApp 多一个 await 用户无感。
- **并发 ✅**: D-004 pull-only 单消费点（前端 workspaceStore.load），无并发拉取。
- **兼容性 ✅**: protocol.ts append-only 新增 `workspace.listRecent` / `workspace.recentList`（cheatsheet §G），不破坏现有协议类型 union。
- **可观测性 ✅**: handler 纯路由层，业务观测归 service/store。

---

### Issue #4: 前端 workspaceStore + INV-6 时序守护（方案 A workspaceStore + initApp 显式 load）

#### ⚠️ 数据

- **事务边界**: workspaceStore.records 的填充（load）与消费（presetCwd 推断默认 cwd）存在**时序依赖**（INV-6，架构审查 MISSING-1）——load 必须在 presetCwd 之前完成。
- **并发场景**: 前端单线程，但有时序竞争（startFlow 同步进 landing vs load 异步）。
- **迁移方案**: 不涉及（前端状态，无持久化迁移）。
- **回滚策略**: initApp 时序显式 await：`startFlow() → await loadSessions() → await workspaceStore.load() → presetCwd(records[0]?.cwd)`（cheatsheet §F）。AC-4.3 grep 守护 load 在 presetCwd 之前。

#### ⚠️ 稳定性

- **故障场景**: `workspaceStore.load()` RPC reject（同 #3 稳定性，前端侧降级）。
- **降级方案**: AC-4.5 catch → records 置空 + 不阻断 presetCwd（用 undefined 兜底，UC-6.2 fallback 链不变）。
- **熔断/限流**: 不适用。
- **重试策略**: 不自动重试（避免 initApp 阻塞）。
- **SLA 影响**: 无。残余：load 失败首屏无最近目录——**接受**（与 #3 同源，用户体验退化为空态）。

#### ⚠️ 兼容性

- **API 变更**: `DirSelectPopover.vue` 数据源 `recentWorkspaces(session.list)` → `workspaceStore.records`（cheatsheet §F line 48）；`useNewTaskFlow.ts` `resolveDefaultCwd(session.list)` → `workspaceStore.records[0]?.cwd`（line 151）。
- **数据兼容**: 前端状态源切换，无数据格式变更。
- **客户端影响**: 与 #5 联动（删派生函数）。改接后 vue-tsc / eslint 须通过（AC-5.2，无悬空 import）。
- **灰度/回滚**: 改接是原子提交（#4 + #5 同 Wave），无新旧版本共存期。

#### ✅ 安全 / 性能 / 并发 / 可观测性（一行理由）

- **安全 ✅**: 前端纯展示 + 状态持有，无安全面。
- **性能 ✅**: initApp 多一个 WS round-trip await（ms 级），用户无感；records ≤10 无渲染压力。
- **并发 ✅**: 前端单线程。
- **可观测性 ✅**: load 失败降级静默（不打断首屏），可选 toast 归⑤决定。

---

### Issue #5: 删除派生函数（单一方案，D-002 落地）

#### ⚠️ 兼容性

- **API 变更**: 删除 `renderer/lib/utils.ts` 的 `recentWorkspaces()` / `resolveDefaultCwd()` / `MAX_RECENT_WORKSPACES` / `RecentWorkspace` type（若仅此处用）。
- **数据兼容**: 不涉及（数据源已由 #4 迁移到 workspaceStore）。
- **客户端影响**: 调用方在 #4 已改接，本 issue 是清理 dead code。AC-5.1 `rg "recentWorkspaces|resolveDefaultCwd|MAX_RECENT_WORKSPACES" src-electron/renderer` 零命中验证。
- **灰度/回滚**: 与 #4 同提交，无独立回滚面。

#### ✅ 安全 / 数据 / 性能 / 并发 / 稳定性 / 可观测性（一行理由）

- **安全 ✅** / **数据 ✅** / **性能 ✅** / **并发 ✅**: 删除代码无新增风险面，数据源已迁移，性能不减，无并发面。
- **稳定性 ✅**: 删除双数据源漂移源（D-002 SSOT），稳定性提升。
- **可观测性 ✅**: 无。

---

### Issue #6: cwd 失效降级（方案 A 不过滤 + 选中时 existsSync 检查 + homedir fallback，UX = D-008 toast）

#### ⚠️ 安全

- **风险**: existsSync 检查路径，cwd 是用户选中记录（非用户直接输入，但仍是外部可影响路径字符串）。
- **影响范围**: 选择失效 cwd 时的降级路径（DirSelectPopover 选中 → existsSync → fallback）。
- **缓解方案**: existsSync **只判存在不执行**（不作为 fs 操作根、不进入 exec/readFile 路径），无目录穿越面。复用 `session-lifecycle.restoreSession` 的 existsSync + homedir fallback 成熟模式（INV-7，AC-6.3），不另起逻辑。
- **残余风险**: 无。

#### ⚠️ 稳定性

- **故障场景**: 用户选中已不存在的 cwd（worktree 清理、目录手动删等，INV-7 二阶风险）——若无降级，session 创建会用失效 cwd，后续 fs 操作报错。
- **降级方案**: D-008 已决策——选中失效 cwd → toast 提示「目录 X 已不存在，已切换到主目录」（X 为该失效 cwd 路径）+ 静默 fallback homedir（AC-6.2）。toast 让用户知道发生了什么（不困惑「目录为何变了」），不打断流程（继续选分支/发消息）。
- **熔断/限流**: 不适用。
- **重试策略**: 不适用（单次选择降级）。
- **SLA 影响**: 无。残余：无（降级路径确定）。

#### ⚠️ 可观测性

- **日志**: 候选——失效降级事件日志（existsSync false 命中时 console.debug），辅助排查「为何我的目录变 homedir 了」。
- **指标/追踪/告警/审计**: 均无需求（本地边缘场景）。
- **降级方案的可见性**: toast 提示本身即用户可见反馈（AC-6.2），核心可观测点已由 D-008 确定。

#### ✅ 数据 / 性能 / 并发 / 兼容性（一行理由）

- **数据 ✅**: listRecent 不过滤失效（AC-6.1，保留历史可见），降级在选择时，数据完整性不变。
- **性能 ✅**: existsSync 单次 IO（选中时触发），轻量（≤10 次 fs.stat 量级，且仅在用户主动选择时）。
- **并发 ✅**: 用户单点选择操作，无并发。
- **兼容性 ✅**: 复用 session-lifecycle.restoreSession 成熟模式（AC-6.3），无新逻辑引入兼容负担。

---

## 缓解项回灌登记（Mitigation Rollback）— MANDATORY

> 每条缓解标「验收方式」（代码测试 / 骨架约束 / 性能混沌 / 运维项）。「验收方式=代码测试」的条目由⑤code-arch §6「来源 B：NFR 风险→用例映射表」反向核对每条有 ≥1 对应用例。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|---------|------|
| getConfigDir 动态化（INV-5，禁硬编码 ~/.xyz-agent） | #1 | 安全 | ⑤test-matrix | NFR-AC：grep store 路径推导含 getConfigDir()，无字面量 ~/.xyz-agent | 代码测试 | 待落 |
| 文件损坏/不存在降级空数组（INV-4） | #1 | 数据 | ⑤test-matrix | NFR-AC：写损坏 JSON + 删文件两个用例，load 返回 [] 不抛（trace AC-1.5/1.6） | 代码测试 | 待落 |
| atomicWrite 落盘一致性（temp+rename） | #1 | 数据 | ⑤契约 | 复用现有 infra atomicWrite（json-store.ts 已有），骨架签名级 | 骨架约束 | 待落 |
| WriteBackCache flush 周期行为（vi.useFakeTimers） | #1 | 稳定性 | ⑤test-matrix | NFR-AC：advanceTimersByTime 触发 flush 后文件落盘 + pull 读内存拿最新值（advanceTimers 前 pull 已含新 record） | 代码测试 | 待落 |
| record 写入/淘汰/损坏降级日志（候选） | #1 | 可观测 | 运维项 | 候选日志项，⑤决定是否落（未硬约束） | 运维项 | 待落 |
| service 无额外 debounce（debounce 归 WriteBackCache，AC-2.4） | #2 | 性能 | ⑤test-matrix | NFR-AC：grep workspace-service.ts 无 setTimeout/setInterval + 单测验证高频 record 被 WriteBackCache 500ms 合并 | 代码测试 | 待落 |
| INV-1 双层守卫（service 统一 + store 防御） | #2 | 兼容 | ⑤test-matrix | NFR-AC：record('') / record(undefined) 静默跳过不调 store（trace AC-2.3）+ grep record 调用点 | 代码测试 | 待落 |
| RPC reject 降级（不走 markSessionError，走 pending.reject） | #3 | 稳定性 | ⑤test-matrix | NFR-AC：mock listRecent reject → workspaceStore.load() catch 置空数组不抛（trace AC-4.5） | 代码测试 | 待落 |
| INV-6 时序（load 在 presetCwd 之前） | #4 | 数据 | ⑤test-matrix | NFR-AC：grep initApp 时序 + 集成测试 mount Panel 验首屏默认 cwd = records[0]?.cwd（trace AC-4.3） | 代码测试 | 待落 |
| 调用方改接无悬空 import（AC-5.2） | #4 | 兼容 | ⑤test-matrix | NFR-AC：vue-tsc / eslint EXIT 0（改接后编译通过） | 代码测试 | 待落 |
| 派生函数 grep 零残留（D-002，AC-5.1） | #5 | 兼容 | ⑤test-matrix | NFR-AC：rg "recentWorkspaces\|resolveDefaultCwd\|MAX_RECENT_WORKSPACES" src-electron/renderer 零命中 | 代码测试 | 待落 |
| existsSync 无穿越（只判存在不执行） | #6 | 安全 | ⑤契约 | 复用 session-lifecycle.restoreSession 模式（AC-6.3），existsSync 签名级无 fs 操作根 | 骨架约束 | 待落 |
| cwd 失效 toast + homedir fallback（D-008，AC-6.2） | #6 | 稳定性 | ⑤test-matrix | NFR-AC：mock existsSync false → 断言 toast 文案「目录 X 已不存在，已切换到主目录」渲染 + cwd fallback homedir | 代码测试 | 待落 |
| 失效降级事件日志（候选） | #6 | 可观测 | 运维项 | 候选日志项，⑤决定是否落（toast 已是可见反馈） | 运维项 | 待落 |

**回灌去向统计**: ⑤test-matrix（代码测试）9 条 / ⑤契约（骨架约束）2 条 / 运维项 3 条。无 ③issue 回灌（本功能 6 issue 已覆盖全部缓解，无需新建 P3+ issue；P3 延后项 #7/#8 在 issues.md 已记录，非 NFR 缓解回灌）。无性能混沌项（本功能无 SLA 目标，top10 量级无需压测）。

---

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| WriteBackCache flush 窗口内崩溃丢 record（≤500ms debounce / ≤5s 周期） | 崩溃前最后一次 record 可能未落盘，重启后该目录不在列表 | 单条 record 业务价值低（目录被再次使用即重记，S4 两写入时机覆盖）；不构成数据完整性损害；atomicWrite 保证已落盘部分不损坏 | 无主动监控（本地功能）；用户重启后若发现某目录消失，重新使用即恢复 |
| WS 断连期间 listRecent reject → 首屏默认 cwd 空 | 用户体验退化为「无最近目录提示」（上层 homedir fallback） | load 失败已降级非阻塞；WS 重连后下次进入新建任务流程再 load 恢复 | 无主动监控；与现有 session.list RPC 断连行为一致（非本功能引入） |
| 回灌表无 ③issue 项 | 无 | 本功能 6 issue 已覆盖全部缓解，无遗漏需独立开发工作的风险项（P3 延后项 #7/#8 已在 issues.md 记录） | — |

---

## 需⑤骨架验证的副作用（标记登记）

> 不确定性高的副作用，标记为需⑤code-arch 骨架验证。相关 stub 进⑤骨架，结论回写本节。

### V-1: WriteBackCache flush 时机对 record 语义的影响（来源 #1 稳定性）

- **验证什么**: ①WriteBackCache 在 `record` 后未 flush 时，`listRecent`（pull）是否总拿最新内存值（D-004 + 红队 nit-2 要求实现确认读内存非读盘）；②`vi.useFakeTimers` + `advanceTimersByTime(500)` 后是否触发 flush 落盘（AC-7.1 跨进程生命周期一致性）；③进程崩溃窗口内 dirty 数据丢失范围（≤500ms debounce 内的 record）。
- **预期结论方向**: pull 读内存视图总拿最新（system-arch §6 已论证 WriteBackCache 读语义）；flush 周期行为可单测验证；崩溃丢 record 窗口接受（见残余风险表）。
- **stub 进⑤骨架**: `RecentWorkspacesStore.list()`（读内存视图实现）+ WriteBackCache 构造（DEFAULT_FLUSH_MS / FLUSH_INTERVAL_MS 配置）。

### V-2: D-005 形态适配对 debounce 行为的影响（来源 #1，issues #1 待 code-arch 选定）

- **验证什么**: 方案 a（WriteBackCache 固定 partition）vs 方案 b（JsonStore + service/store 自管 debounce）的 debounce 行为差异——方案 a 复用 WriteBackCache 内置 write-back（500ms debounce + 5s 周期兜底），方案 b 需手写 debounce timer（与 WriteBackCache 重复造轮子风险）。
- **预期结论方向**: 两方案都满足 D-005（write-back 意图 + atomicWrite）；红队 nit-1 倾向 b（访问模式整体读写非按行查，JsonStore 形态更匹配），但 a 保持与 session-data-store 一致。骨架对照后由⑤code-arch 选定。
- **stub 进⑤骨架**: 两方案各产可编译骨架（WriteBackCache 构造 vs JsonStore 构造），⑤对照后定一。

### V-3: INV-6 时序在 initApp 真实调用链的确定性（来源 #4 数据）

- **验证什么**: `startFlow() → await loadSessions() → await workspaceStore.load() → presetCwd(records[0]?.cwd)` 时序在 initApp 真实代码路径（cheatsheet §F）是否确定——尤其 `startFlow` 同步进 landing 与 `load` 异步的交错是否导致首屏默认 cwd 拿空（架构审查 MISSING-1）。
- **预期结论方向**: 显式 await 时序确定（AC-4.3 grep 守护）；集成测试 mount Panel 验首屏默认 cwd 即 records[0]?.cwd 可证。
- **stub 进⑤骨架**: initApp 调用链 + workspaceStore.load() async 签名。
