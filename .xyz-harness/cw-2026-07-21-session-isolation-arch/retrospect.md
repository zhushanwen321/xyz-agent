# Retrospect · session-isolation-arch

## 第 1 段：derived 异常归因

derived：gateFailCount=5、devRetryCount=1、firstTryPassRate=0.83、testRetryCount=0、redLightConfirmed=true。

### gateFailCount=5 归因

| gate | fail 原因 | 归因 |
|------|---------|------|
| plan（首次）| schema 错：dev-plan.json 首次提交漏 `format:"lite"` | 凭记忆构造 schema。**改进**：首次调 cw action 前用 minimal payload 触发 mustFix 报错拿真实 schema（与 watchdog topic 同类教训，仍犯） |
| tdd_plan（首次）| stdin 空，invalid test.json | 探查 guidance 时用空 stdin。**改进**：传故意错误的 payload 触发 schema 报错（同上根因） |
| spec_review | spec_review 报 5 个 must-fix（禁读重建有效暴露真问题）| 这类 fail 是**审查机制正常工作**，非流程问题。spec_review 的禁读重建法值得保留 |
| tdd_plan（二次）| AC schema 字段错（用了 verification 枚举值不被接受）| schema 探查不彻底。**改进**：specSections 的子结构 schema 也要探查，不只主 clarifyJson |
| review | dimension 字段用旧版枚举值（correctness/maintainability）| CW 版本升级，dimension 枚举换了（新版 6 值：type-safety/error-handling/edge-case/test-coverage/plan-completeness/design-consistency）。**改进**：跨 topic 间隔较久时，cw 命令的 schema 可能变，需重新探查 |

### devRetryCount=1 归因

W1 dev 重试 1 次：首次派 worker 实现，worker 在测试 bug 处卡住（useSessionScopedState.test.ts 一条用例注释声称访问 current 但代码没访问）。worker 按"不碰测试"纪律等授权，我取消后自己修测试 + 完成实现。**根因**：tdd_plan 阶段写的测试有 bug（见下），dev 阶段才暴露。

### firstTryPassRate=0.83 归因

主要来自 5 次 gate fail（plan/tdd_plan×2/spec_review/review 各一次重试）。dev/test 本身质量稳定（testRetryCount=0，7/7 一次通过）。

## 第 2 段：可泛化流程模式（processIssues）

**pattern 1（最重要）**：TDD 红灯阶段必须验证"红是因为实现缺失，而非测试本身有 bug"。本次 tdd_plan 写了两个测试 bug（W3 AC-5 指针恢复用例多调了 ↑、W4 emitRaw 模拟不存在的竞态），红灯时我假设"红=实现没写"，没核断言逻辑。到 dev 阶段 worker 实现正确却挂测试，深查才发现是测试编码错误。**正确做法**：tdd_plan 红灯确认时，对每条红灯用例手动推演"如果实现按契约写，这条断言会绿吗"——如果不会，测试本身有 bug，当场修。这条跨 topic 通用，应进 tdd_plan skill。

**pattern 2**：跨 topic 间隔较久时，cw 命令的 schema 可能升级。本次 review 阶段 dimension 枚举换了（旧版 correctness/maintainability/observability/dead-code → 新版 type-safety/error-handling/edge-case/test-coverage/plan-completeness/design-consistency），我用旧值连续 3 次报错才摸清。**正确做法**：每个 cw topic 开始前（create 后第一次调各 action 前），重新探查 schema，不依赖上个 topic 的记忆。 CW guidance 里其实写了合法值，我没读完整 guidance 就开干。

**pattern 3（正面）**：spec_review 的禁读重建法有效。reviewer subagent 不读 spec 初稿、只从 objective + clarifyRecords 重建，暴露了 5 个 must-fix（useSessionEvents 不该迁移、cleanup 调用点、ESLint 规则放弃、现状厘清、useComposerHistory 特殊性）——全是真问题，全部修订。**这说明禁读重建值得在每个 topic 的 spec_review 坚持**，不跳过。

**pattern 4（正面）**：主 agent 独立验证 reviewer/subagent 的关键判断。W4 worker 报告"测试 mock 与真实 useSessionEvents 有架构矛盾"，我独立读 useSessionEvents 源码 + events.ts（验证 events.off 同步）后确认：worker 核心分析对一半（registrations 跨 sid 复用），但结论需修正（竞态窗口不存在于 events 层，而是 watch flush:pre）。最终修测试而非改实现。**主 agent 不能盲信 subagent 的架构判断，必须基于源码独立验证**。

**pattern 5（正面）**：W2 worker 发现的"init 必须返回 reactive 容器"契约没在 W1 文档化，W3/W4 worker 各自独立踩坑后又独立发现。这是 W1 实现时未充分文档化的隐含契约。**改进**：通用工厂/composable 的响应式契约（init 返回什么、mutate 如何触发下游）应在工厂文件头注释明确，不靠使用方各自摸索。

**oneOff**：plan 首次提交漏 format 字段、tdd_plan AC schema 字段错——都是 schema 不熟导致，非系统性问题。

## 第 3 段：设计级风险（knownRisks）

### 设计级

1. **[设计级，unverified=true] M1 切 sid 的 WS 消息写入竞态**。useExtensionUI/SideDrawer 的 WS handler 读 `sid.value` 实时值决定写入分区，但 session 切换的退订是异步的（watch flush:pre）。极小窗口内旧 sid 消息可能写入新 sid 分区。**重构前就存在**（watch 清理派同样异步），本次没引入新 bug，把确定性触发变成偶发竞态。**待后续 topic 修**：handler 闭包捕获订阅时 sid + 工厂加 updateFor(sid, updater) 显式分区方法。

2. **[设计级] M2 SideDrawer 测试假绿**。测试 mock 用 sidRef.value 匹配，掩盖了 flush:pre 异步时序。与 M1 捆绑，M1 修复后测试 mock 需对应改为按注册时 sid 快照匹配。

3. **[设计级] sessionCleanupRegistry 模块级 Set 无自动清理边界**。当前靠 useSidebar.deleteSession 统一编排 triggerSessionCleanups。但若有其他 session 销毁路径（如未来加 session.close RPC）没经过 deleteSession，Map 分区会泄漏。**缓解**：explorer 已确认 deleteSession 是当前唯一编排点；AGENTS.md 7.6 章节记录了此约束。

### 代码级

4. **[代码级] W5 集成测试 U5 的 sentinel cleanup**。registerSessionCleanup 注册的 sentinel 在 try/finally 里反注册，但模块级 Set 在测试间共享。已加 `__clearSessionCleanupRegistryForTest()` beforeEach 清理（m2 修复），防 flaky。

5. **[代码级] useExtensionUI 测试不包 effectScope**。onScopeDispose 在测试环境无 scope 不触发反注册，cleanup 累积。靠 `__clearSessionCleanupRegistryForTest()` 缓解。根本修是测试包 effectScope，但工作量大，当前可接受。

## 第 4 段：未闭环评估

review 阶段报告 4 个问题（0 critical + 2 major + 2 minor）：
- **m1 + m2 已修**（commit bd47ffd1）
- **M1 + M2 不修**（重构前已存在 + 修复属架构性改动 + 触发极罕见），作为 knownRisks 1+2 记录，留后续 topic

非静默跳过——review.md 明确记录不修理由和修复方向。

## 总结

**做对的**：
- 核心方案正确（rethink 后统一到 Map 分区派 + 通用工厂）
- spec_review 禁读重建暴露 5 个真问题，全部修订
- 主 agent 独立验证 subagent 架构判断（W4 竞态分析）
- 测试覆盖 AC-1~AC-8，7/7 passed
- 防复发机制到位（工厂结构隔离 + 测试 + ADR + AGENTS.md 7.6 章节）

**做错的**：
- tdd_plan 阶段写了两个测试 bug，红灯没核断言逻辑（pattern 1）
- cw schema 跨版本变化没重新探查（pattern 2）
- W1 工厂的 reactive 容器契约未文档化，W3/W4 重复踩坑（pattern 5）

**对 CW 工具的观察**：
- dimension 枚举跨版本不兼容（旧 correctness 等被替换），升级时无迁移提示。建议 CW 在 mustFix 报错时列出合法值（现在只说"无效"）
- spec_review 的禁读重建是 CW 流程的高价值环节，值得在 skill 文档强调不可跳过
