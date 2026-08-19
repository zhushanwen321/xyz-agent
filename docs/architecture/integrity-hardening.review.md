# integrity-hardening.md 对抗式审查报告

> **审查日期**：2026-08-20
> **审查文档**：`docs/architecture/integrity-hardening.md`（v1 初稿）
> **审查基调**：对抗式——默认假设方案有问题，逐项找反例与攻击面

## Summary

2 must-fix, 2 suggestions.

文档整体质量高：10 个 major 全部有源码级 file:line 证据支撑，根因归纳为两条元模式而非逐点修补，§3 每个决策点都有 2-3 方案对比 + 明确裁决理由，§4 验收 10 个场景覆盖全部 major 且均在真实环境执行（非单测/mock），§5 波次拆分有 justification 且可独立回滚。核心薄弱点集中在 D1a 锁协议的 pi 侧实现细节——方案成立的关键假设（pi 用 proper-lockfile 标准参数）与源码事实（pi 自实现 busy-wait retry、无 stale）不符，需要在设计阶段而非实施阶段明确对齐策略。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.1 D1a | P0-11 事实 | **pi 锁机制与 D1a 方案假设不符**。D1a 声称「锁参数从 pi `FileSettingsStorage.withLock` 源码镜像（retries/stale 待抄）」，隐含假设 pi 使用 proper-lockfile 的 `lock(path, { retries: {...}, stale: ... })` 异步 API。但 pi 源码实际使用自实现的 `acquireLockSyncWithRetry`（`settings-manager.ts:220-244`）：`lockfile.lockSync(path, { realpath: false })` + 手动 busy-wait 重试（固定 20ms 延迟 × maxAttempts=10），**无 stale 参数**。这意味着：(1) pi 崩溃持锁时锁文件残留，pi 侧永远阻塞（无 stale 超时恢复）；(2) xyz 侧若按 auth-storage 范本设 `stale: 30_000`，则锁行为不对称——xyz 可自行恢复死锁，pi 不能；(3) retry 语义不同（pi 是固定间隔 busy-wait，proper-lockfile 是指数退避）。D1a 的「同一把锁」协议成立条件取决于对齐策略：是 xyz 也不设 stale（对称但双方都无法自愈死锁），还是接受不对称（需论证 pi 崩溃窗口内 xyz 侧写操作能安全恢复），还是在 pi 扩展侧补 stale 能力。此决策影响锁协议的正确性，不能完全推迟到实施期。 | 设计阶段明确对齐策略并记录决策理由。两个选项：(a) xyz 侧也不设 stale + retries 用固定间隔对齐 pi 行为（对称，但死锁需外部干预）；(b) xyz 侧设 stale 接受不对称（pi 崩溃后 xyz 可自愈，需论证 pi 重启后锁文件残留不影响正确性——proper-lockfile 的 stale 判据基于 mtime，pi 重启后锁文件 mtime 不变直到超时）。无论选哪个，写进 §3.1 作为明确决策而非留给实施期。 |
| MUST_FIX | §3.1 D1b | P0-12 副作用 | **D1b `updateSettingsSync` 签名变更的调用方映射不完整**。D1b 将签名从 `updateSettingsSync(mutator)` 改为 `updateSettingsFields(scope: SettingsFieldScope, mutator)`，scope 包含 `'model' | 'extension' | 'skills' | 'full'`。文档说「现有调用方逐一映射」但只列举了域归属原则（provider/默认模型/档位 → model；extension packages → extension），**未给出具体调用方清单**。当前 `updateSettingsSync` 被 `pi-provider-store.ts`（setDefaultModel/setDefaultThinkingLevel/setEnabledModels 等）和 `extension-service`（packages 写入）调用——每个调用方都需要改造。此外 `'full'` scope 的使用场景定义为「启动迁移等无并发方窗口」，但未说明哪些代码路径属于此类，开发者可能为避险全用 `full` 绕过字段域隔离，使机制形同虚设。pi 的 `persistScopedSettings` 实际修改的字段包含 `defaultProvider`（与 `defaultModel` 一起写，见 `settings-manager.ts:360-362`），model scope 需明确覆盖 `defaultProvider` 字段。 | 补充：(1) 列出所有 `updateSettingsSync` 调用方及其 scope 映射表（可在§3.1 或附录）；(2) 明确 model scope 覆盖的字段集合（至少含 `defaultProvider`/`defaultModel`/`defaultThinkingLevel`/`enabledModels`/`skills`/`hideThinkingBlock`）；(3) 定义 `'full'` scope 的白名单使用场景（如仅限 `migrateSettings` 函数），并在代码 review checklist 中加「禁止新代码用 full scope」。 |
| SUGGESTION | §6 ⛔门 ×3 | P1-6 加机制 | **7 个⛔实施期门中 3 个是方案核心机制的可行性前提，设计阶段应至少读代码排除明显不可行路径**。(1) D3a「rpc 超时错误判别方式」——整个 pi 半死强杀路径依赖此，若 rpc-client 超时无法判别则 D3a 方案需改走「直接 destroy 不等 abort」；(2) D3a「SIGSTOP 注入实测 destroy 链时序」——D3a 对 SIGSTOP 场景的处置完全依赖 SIGKILL 分支有效，若 destroy 链对 stopped 进程有时序问题则需补 SIGKILL 前的 SIGCONT；(3) D6a「session-service 销毁回调挂法」——D6a 的 runtime 侧清理依赖 `removeSessionEntry` 能注册回调，若 session-service 无此扩展点则需改走「onSessionExit 链尾补清理」。这些不是实现细节，是「方案在什么条件下成立」的运行时断言（rubric P0-16）。文档诚实标了⛔是好的，但 3 个核心机制同时悬空使方案的可实施性有不确定性。 | 在设计定稿前对这 3 个⛔做初步代码探读（不要求完整探针，至少 grep 现有代码确认扩展点存在/不存在），将结果更新到§6：若扩展点存在则降级为实现细节；若不存在则§3 需要备选路径。 |
| SUGGESTION | §4 S1 | P1-1 例子 | **S1 三方并发写场景的交错时序缺乏可操作的执行方案**。S1 要求「A 内连续切模型+切思考档位，同时在 Settings 页连续保存 provider 修改与装/卸一个 npm 扩展，交错循环 >=20 次」。手工操作无法保证真正的并发交错（人的操作间隔远大于文件写入窗口），而并发交错正是 W1/W2 窗口的触发条件。通过标准（「字段不丢 + 重启后一致」）在非完美交错下也能验证锁的基本功能，但无法验证最危险的「两写恰好落入同一 RMW 窗口」场景。 | 补充半脚本化方案：(1) 一个 side script 循环调用 `config.setDefaultModel` WS 命令（模拟 xyz 写）；(2) 另一个 side script 循环调用 pi RPC `setModel`（模拟 pi 写）；(3) 两者并行跑 20+ 轮，结束后 `jq` 校验。或至少说明「手工操作作为冒烟验收，脚本化交错作为 W1 完成后的压力验收」。 |

## 附：P0 逐项判定

| P0 项 | 判定 | 依据 |
|--------|------|------|
| P0-1 五段骨架 | **通过** | §1 背景目标 / §2 现状问题 / §3 方案 / §4 验收 / §5 拆分，五段完整 |
| P0-2 delta 链 | **不适用** | v1 初稿，无前版 delta |
| P0-3 结论先行 | **通过** | 文档开头有一句话结论；§2 首句即结论；§3 每个 D 有终态声明 |
| P0-4 问题定义 | **通过** | §1 SCQA 从真实失败模式出发；§2.1 有 8 个使用者视角的真实失败模式（非抽象描述）；§2.3 根因分析挖到元模式层 |
| P0-5 重实现轻体验 | **通过** | §2.1 全部从使用者/开发者视角描述（「用户切模型后配置丢失」「开发者被误导」）；§3 每个 D 有「终态（使用者视角）」 |
| P0-6 抽象术语 | **通过** | §1 关键术语段定义了 6 个核心抽象词（跨进程共享文件/字段域 merge/损坏隔离/收殓/对账/机制化护栏），每个有例子或对照 |
| P0-7 方案对比 | **通过** | §3.1-§3.8 每个决策点有 2-3 方案对比表（A/B/C） |
| P0-8 长期+短期评估 | **通过** | 每个对比表含「长期架构合理性」和「短期实现成本」两列 |
| P0-9 明确推荐 | **通过** | 每个对比表有「裁决」列（✅/❌）+ 「被否若用 X」段说明否决理由 |
| P0-10 因果链 | **通过** | §1→§3 因果链完整：元模式①(无锁双写)→D1(锁+merge)+D5(注册表锁)；元模式②(注释护栏)→D2(安全守卫)+D3(自愈)+D4(收殓)+D8(CI护栏)。10 个 major 在 §2.2 有映射表，§4 验收有覆盖关系声明 |
| P0-11 关键事实 | **不通过** | 见 Finding #1（pi 锁机制细节） |
| P0-12 副作用 | **不通过** | 见 Finding #2（签名变更调用方映射） |
| P0-13 验收存在+testable | **通过** | §4 有 10 个验收场景，每个有：回溯目标列、真实流程/数据/路径描述、具体通过标准（可量化/可观测） |
| P0-14 验收=单测/mock | **通过** | §4 明确声明「单测只作为回归守护，不作为验收」；场景全部在真实 app+文件系统+进程上执行；故障注入（kill -9/SIGSTOP/truncate）是受控复现非 mock |
| P0-15 验收投入匹配 | **通过** | 大改动（跨 4 域行为变更）配 10 个验收场景，覆盖全部 10 个 major；S1 有循环次数要求；S5/S6 有进程注入 |
| P0-16 运行时断言探针 | **通过（附 SUGGESTION）** | 7 个运行时断言（⛔门）全部标记为「实施期门：编码前先跑探针」，文档未假装已验证——这是诚实的。但 3 个核心机制的可行性前提悬空（见 SUGGESTION #1） |
| P0-17 物理数据流 | **通过** | §2.4 有 settings.json 双写的物理数据流图（ASCII）；§2.5 有 runtime 崩溃孤儿链的物理数据流图 |
| P0-18 错误恢复指引 | **通过** | D1c 损坏隔离有恢复指引（「error 日志含恢复指引：文件路径 + 对比 .corrupt 副本找回配置」）；D3a 有「重发即可恢复」指引；D4a 有日志列出 reaped pid |

## 附：P1 逐项判定

| P1 项 | 判定 | 依据 |
|--------|------|------|
| P1-1 关键概念例子 | **通过** | 术语定义段每个概念有例子或对照（auth.json 范本、.corrupt 副本、PI_CODING_AGENT_DIR env） |
| P1-2 拆分 justification | **通过** | §5 表格有 justification 列，每个 wave 说明了为什么这么分（「全部低风险独立小改先拿确定性收益」「锁协议是核心机制先行独立验证」） |
| P1-3 受众背景 | **通过** | §1「系统是什么」段面向「会用 xyz-agent 但不熟内部的开发者」，解释了三进程架构和配置体系 |
| P1-4 决策 alternatives | **通过** | 每个决策有「被否若用 X」段记录了考虑过但没选的方案及否决理由 |
| P1-5 MECE | **通过** | §2.2 映射表将 10 个 major 无遗漏映射到失败模式和元模式；§4 验收覆盖声明确认无遗漏 |
| P1-6 减法原则 | **通过** | 多处否决了过度方案（B. sandbox:true 全隔离——「用大手术治感冒」；C. 透明重启+自动重放——「副作用双执行」；C. JSONL append-only——「复杂度换来了锁已解决的问题」） |
| P1-7 scope 越层 | **通过** | 文档层声明明确「当前层=问题诊断+终态架构+接口级方案，下一层=W0-W5」，不越到函数签名级 |
| P1-8 细节事实 | **通过** | 已核实的 file:line 引用全部准确（auth-storage.ts:42-74 / main.ts:231-238 / model-service.ts:85-104 / rpc-client.ts:134 / event-interpreter.ts:114/744 / worktree-registry.ts:17 / session-service.ts:724 / json-store.ts:117-122），无行号偏移 |
