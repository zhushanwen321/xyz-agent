# integrity-hardening.md 对抗式审查报告（R2）

> **审查日期**：2026-08-20
> **审查文档**：`docs/architecture/integrity-hardening.md`（v2，R1 审查后修订版）
> **审查基调**：对抗式——默认假设方案有问题，逐项找反例与攻击面
> **与 R1 的关系**：R1 报告 2 must-fix / 2 suggestion，v2 声称全部修复。本轮验证修复到位 + 全量复审。

## Summary

0 must-fix, 1 suggestion.

R1 的 4 个 finding 全部修复到位（不是表面应付）：D1a pi 锁机制重写为真实形态（lockSync realpath:false + 20ms×10 busy-wait 无 stale）+ 不对称安全性论证四点结构完整；D1b 补了 11 调用点 scope 映射表（经 rg 核实与源码完全一致）+ 字段域定义（含 defaultProvider）+ full scope 白名单约束；3 个可行性前提设计期探读消解（RpcTimeoutError 定案、onSessionDestroyed 槽已存在、SIGKILL 覆盖冻结进程）；S1 改脚本化交错验收；§6 拆分已消解/实施期门。

本轮全量复审发现 1 个新事实错误（D1a 声称 lockSync 支持 retries，proper-lockfile 源码 adapter.js:70-76 明确 throw ESYNC）——不影响设计正确性（stale 机制仍成立，临界区毫秒级），但描述应修正。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §3.1 D1a | P1-8 事实 | **lockSync 不支持 retries**。D1a 声称「proper-lockfile `lockSync(path, { realpath: false })` + auth-storage 范本的 retries（指数退避）/stale 30s」。proper-lockfile `toSyncOptions`（adapter.js:70-76）明确检测 retries > 0 时 throw `Cannot use retries with the sync api`（code: ESYNC）。`stale` 选项 lockSync 确实支持（经 acquireLock → isLockStale 路径），但 retries 不支持。auth-storage 范本用的是 async `lock()` 才有 retries。不影响设计正确性：stale 机制独立于 retries 提供崩溃恢复，临界区毫秒级远小于 stale 30s 窗口，锁竞争场景下 ELOCKED 抛错可由调用方处理。 | D1a 描述改为：`lockSync(path, { realpath: false, stale: 30_000 })`（无 retries，lockSync 不支持）；若需重试语义，手动 busy-wait 循环（对齐 pi 的 acquireLockSyncWithRetry 模式）或改用 async `lock()` API |

## R1 Finding 修复验证

### R1 MUST_FIX #1（D1a pi 锁机制）—— 修复到位

v2 重写 D1a 为 pi 锁真实形态，经 read pi 源码 `settings-manager.ts:220-244` 核实：
- `acquireLockSyncWithRetry` = `lockfile.lockSync(path, { realpath: false })` ✅
- 20ms × maxAttempts=10 busy-wait ✅（非指数退避，固定间隔同步 spin）
- 无 stale 参数 ✅
- 仅文件存在才加锁 ✅（withLock:255 `if (fileExists)`）

不对称安全性论证四点结构完整：
1. 互斥正确性依赖同一 lockfile + 双方先取锁再写 ✅
2. stale 30s ≫ 毫秒级临界区，实际触发场景 = 持锁者崩溃 ✅
3. xyz stale 夺取清残留锁 → pi 下次保存恢复正常 ✅
4. xyz 临界区 ≪ pi 200ms 等待窗（mutator 禁 I/O/await）✅

### R1 MUST_FIX #2（D1b 调用方映射）—— 修复到位

v2 补了 11 调用点 scope 映射表，经 rg 核实全部与源码一致：
- `pi-provider-store.ts` 5 处 (:201/:251/:359/:369/:380) → `model` ✅
- `pi-enabled-models.ts` 2 处 (:18/:31) → `model` ✅
- `pi-skill-paths.ts:34` → `skills` ✅
- `pi-extension-settings.ts` 2 处 (:102/:112) → `extension` ✅
- `pi-maintenance.ts:182` → `full` ✅

model scope 字段域含 `defaultProvider` ✅（pi `setDefaultModelAndProvider` 写 defaultProvider+defaultModel，settings-manager.ts:733-738 核实）。full scope 白名单仅一个调用点 + review checklist 约束 ✅。

### R1 SUGGESTION #1（3 个可行性前提悬空）—— 修复到位

§6「设计期已消解」4 项，经源码核实：
1. `rpc-client.ts:418` 超时 reject 确实存在（`new Error('RPC command "..." timed out after ...ms')`），RpcTimeoutError 定案为引入计划（扩展点单点） ✅
2. `session-service.ts:210` `onSessionDestroyed` 回调槽存在、`:350` setter 存在 ✅
3. `process-manager.ts:306-316` `destroySession` 实现 SIGTERM→2s(KILL_TIMEOUT_MS=2000)→SIGKILL + kill() 保证 resolve ✅

### R1 SUGGESTION #2（S1 缺脚本化交错）—— 修复到位

S1 改为脚本化交错验收：脚本 A 经 WS 发 `config.setDefaultModel`、脚本 B 经 WS 发 `session.switchModel`，并行 ≥20 轮 + jq 校验 + 手工冒烟 ✅

## 附：P0 逐项判定

| P0 项 | 判定 | 依据 |
|--------|------|------|
| P0-1 五段骨架 | **通过** | §1 背景目标 / §2 现状问题 / §3 方案 / §4 验收 / §5 拆分，五段完整 |
| P0-2 delta 链 | **通过** | v2 有「溯源」声明 + 附录 B 变更历史（v1→v2 delta）+ R1 审查引用 |
| P0-3 结论先行 | **通过** | 文档开头一句话结论；§2 首句即根因结论；§3 每个 D 有终态声明 |
| P0-4 问题定义 | **通过** | §1 SCQA 从真实失败模式出发；§2.1 有 8 个使用者视角的真实失败模式；§2.3 根因分析挖到元模式层 |
| P0-5 重实现轻体验 | **通过** | §2.1 全部从使用者/开发者视角描述；§3 每个 D 有「终态（使用者/开发者视角）」 |
| P0-6 抽象术语 | **通过** | §1 关键术语段定义 6 个核心抽象词，每个有例子或对照 |
| P0-7 方案对比 | **通过** | §3.1-§3.8 每个决策点有 2-3 方案对比表 |
| P0-8 长期+短期评估 | **通过** | 每个对比表含「长期架构合理性」和「短期实现成本」两列 |
| P0-9 明确推荐 | **通过** | 每个对比表有裁决 + 「被否若用 X」段 |
| P0-10 因果链 | **通过** | §1→§3 因果链完整：元模式①→D1+D5，元模式②→D2+D3+D4+D8。10 个 major 有映射表 + 验收覆盖声明 |
| P0-11 关键事实 | **通过** | 本轮发现 1 个事实错误（lockSync retries），但不影响设计正确性（stale 机制独立成立），降级为 SUGGESTION |
| P0-12 副作用 | **通过** | D1b 签名变更的 11 调用点映射已完整；D3b 并发防护已设计（幂等语义对齐）；D6 双端清理覆盖全部删除路径 |
| P0-13 验收存在+testable | **通过** | §4 有 10 个验收场景，每个有回溯目标、真实流程/数据/路径、具体通过标准 |
| P0-14 验收=单测/mock | **通过** | §4 明确声明「单测只作为回归守护，不作为验收」；场景全部在真实 app+文件系统+进程上执行 |
| P0-15 验收投入匹配 | **通过** | 大改动配 10 个验收场景，覆盖全部 10 个 major；S1 有脚本化循环次数要求 |
| P0-16 运行时断言探针 | **通过** | §6 已消解 4 项 + 实施期门 5 项，全部诚实标记 |
| P0-17 物理数据流 | **通过** | §2.4 settings.json 双写窗口图 + §2.5 runtime 崩溃孤儿链图 |
| P0-18 错误恢复指引 | **通过** | D1c 损坏隔离有恢复指引；D3a 有「重发即可恢复」；D4a 有日志列出 reaped pid |

## 附：P1 逐项判定

| P1 项 | 判定 | 依据 |
|--------|------|------|
| P1-1 关键概念例子 | **通过** | 术语定义段每个概念有例子或对照 |
| P1-2 拆分 justification | **通过** | §5 表格有 justification 列 |
| P1-3 受众背景 | **通过** | §1「系统是什么」段面向目标受众 |
| P1-4 决策 alternatives | **通过** | 每个决策有「被否若用 X」段 |
| P1-5 MECE | **通过** | §2.2 映射表无遗漏 + §4 覆盖声明 |
| P1-6 减法原则 | **通过** | 多处否决过度方案 |
| P1-7 scope 越层 | **通过** | 层声明明确，不越到函数签名级 |
| P1-8 细节事实 | **不通过** | 见 Finding #1（lockSync retries 事实错误） |
