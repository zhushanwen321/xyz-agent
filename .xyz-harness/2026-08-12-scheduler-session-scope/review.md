# 对抗式审查报告：pi-scheduler 修复设计（once 回显 + session 归属）

审查对象：`.xyz-harness/2026-08-12-scheduler-session-scope/design.md`
审查方式：逐条对照 `extensions/scheduler/src/` 源码 + pi SDK 类型实测核实（非文档自洽放行）

## Verdict

**方案方向成立，但当前设计不可直接实施。** 两个根因诊断（once 回显无条件 5 次、store 按 cwd 共享 + 每 session 独立调度）经源码逐条核实**全部属实**；owner 归属 + loadTasks 过滤的骨架是正确归位。但存在 **1 个致命副作用**：方案只改 loadTasks 过滤、不改 `runtime.persist()` 的全量覆盖写，会导致同 cwd 多 session 场景下**任务从磁盘互相删除**（直接破坏设计自己的 G3/G4）；另有 1 处风险后果低估（D3 迁移窗口对 recurring 任务不是"双触发一次"而是**双 session 存活期内每次到期都双触发**）和 1 处验收缺口（验收场景无法暴露上述缺陷）。修复后方案成立。

## Summary

**3 must-fix, 4 suggestions.**

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D2 + §5 文件改动地图 | P0-12 副作用 | **persist 全量覆盖导致跨 session 任务从磁盘丢失**。方案只在 loadTasks 过滤（runtime 内存态 = 本 session 任务），但 `runtime.persist()`（runtime.ts:249-262）写 `Array.from(this.tasks.values())` 全量覆盖共享 store 文件，且 tickScheduler 每 30s 无条件 persist（runtime.ts:166）+ shutdown persistSync。两 session 同 cwd 并存时，A 的每次 persist 把 B 的任务从磁盘删掉（反之亦然）——文件在 {A 的任务} 和 {B 的任务} 间振荡。B 一旦关闭，A 的任务已不在磁盘（G3 破坏）；迁移接管的任务同样被删（G4 破坏）。D2 声称"widget.ts / runtime.ts 零改动"不成立。 | persist 改为**读-合并-写**（读盘 → 按 id 替换自己的任务 → 写回，保留他人任务）；或改为**使用点过滤**（内存持全部任务，list/dispatch/CRUD 按 owner 过滤，persist 不动）。前者是方案最小增量，后者无合并竞态。 |
| MUST_FIX | §3.3 D3 + §3.2 A 行 | P0-11 事实 / P0-10 对抗 | **迁移窗口风险后果低估**：D3 说"双触发一次，触发窗口 = 该任务下次到期"，只对 once 成立。对 **recurring** 任务，两 session 各持内存副本、各自 dispatch 后各自重算 nextRunAt 并 persist（磁盘 owner 交替覆盖），**双 session 存活期内每次到期都双触发、每次注入两个 session**（F3/F4 持续复发），无运行时收敛机制。§3.2 A 行"低频且**自愈**"与 D3 自相矛盾（无任何自愈路径）。且建议的缓解"写回后立即从内存移除"不成立——刚接管的任务本就归属本 session，移除后任务消失。 | dispatch 前做磁盘 owner 复核（读 store 校验 `ownerSessionFile === 本 sessionFile`，不符则从内存移除并跳过），把重复上界收敛到 ≤1；或如实接受并文档化"recurring 持续双触发"，同时把 §3.2 A 行"自愈"改为"不收敛"。 |
| MUST_FIX | §4 验收 | P0-13 验收 | **验收无法暴露 M1/M2 缺陷**：S3/S4 单轮运行内 persist-loss 不可见（不检查磁盘状态）；S6 是单 session，测不到并发接管；D3 并发窗口只在 V1 留"实施期可验证"而无验收场景。按此验收实施，两个致命缺陷都会全绿通过。 | 增加场景：① A、B 同 cwd 各创建任务并各自 tick ≥1 轮后，检查 store 文件**仍含双方任务**；A 关闭后 resume，A 的 list 仍显示其任务（回归 G3/G4）。② 预置无 owner store + 两进程并发启动，记录接管归属与触发次数（观察并文档化 D3 行为）。 |

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §3.3 D3 / §2.5 | P1-6 遗漏 | **subagent 会话未纳入模型**。subagent 进程镜像主进程 `--extension` 加载扩展（AGENTS.md 明文），同 cwd 的 subagent 同样触发 session_start → loadTasks → 30s tick → persist。后果：① 迁移窗口内 subagent 可接管无主任务并注入到 subagent 会话（F4 变体），或随 subagent 会话文件清理变孤儿；② 在 M1 修复前 subagent 的 persist 同样会清掉主会话任务（M1 修复后此点消失）。 | 明确"非交互会话是否参与接管"的语义（建议排除或实测确认）；验收补一个"主会话 + 后台 subagent 并存"场景。 |
| SUGGESTION | §1 / §3.1 | P1-5 | **once 任务忽略 expires 参数**（runtime.ts:44-49 只对 recurring 计算 expiresAt）。叠加 D4 不 GC：owner 会话删除后，无到期的 once 任务在磁盘**永久残留**（设计例 4 的孤儿恢复指引依赖人工清理）。 | 对 once 也应用 expires（或至少文档化"once 无过期"语义），并纳入 README 行为描述更新范围。 |
| SUGGESTION | §3.3 D3（接管写回） | P1-6 | **并发写同一 JSON 文件非原子**：两进程 `writeFileSync`（store.ts writeSync）交错截断/写入可致文件损坏 → load catch 降级空 store → **全部任务丢失**（store.ts:60-70）。现状每 30s 双 session 已存在此风险，方案新增的接管写回增加写频次。 | store 写盘改 tmp 文件 + rename 原子替换。 |
| SUGGESTION | §3.3 D5 | P1-3 | **fallback 路径（getSessionFile() 为 undefined → 加载全部）使 F2/F3/F4 静默回归**，且无任何告警，排障时无法发现走的是降级路径。 | 该路径加 `console.warn` 显式告警，文档标注"降级模式"判定方法。 |

## 关键事实核查结果（design.md 声明 vs 源码实测）

| design.md 声明 | 实测结果 |
|---|---|
| §2.3：create() 无条件 `computeNextRuns(..., 5)` 不看 kind（service.ts:70） | ✅ 属实（service.ts:70 `computeNextRuns(task.schedule, Date.now(), 5)`，§2.1 回显样例与 formatRelativeTime 输出格式一致） |
| §2.3：once dispatch 一次即删除（runtime.ts dispatchTask） | ✅ 属实（runtime.ts:214 `if (task.kind === 'once') this.tasks.delete(task.id)`） |
| §2.3：store 按 cwd 共享（store.ts getStorePath） | ✅ 属实（store.ts:14-25 `~/.pi/agent/scheduler/<root>/<segments>/scheduler.json`） |
| §2.3：每 session session_start 无条件 loadTasks + startScheduler（index.ts） | ✅ 属实（index.ts:44-45） |
| §2.4：30s tick；到期经 `pi.sendMessage(..., {deliverAs:'followUp', triggerTurn:true})` | ✅ 属实（runtime.ts:10 TICK_INTERVAL_MS=30_000；runtime.ts:131-133） |
| §2.4：widget 渲染 service.list()（内存态） | ✅ 属实（index.ts refreshWidget → service.list() → widget.ts） |
| §3.3 D1：SDK `ReadonlySessionManager` 含 getSessionFile/getSessionDir/getSessionId（dist/core/session-manager.d.ts:140） | ✅ 属实（d.ts:140 三方法齐全；getSessionFile 实现返回 `this.sessionFile`） |
| §3.3 D1：sessionFile 跨 resume 稳定 | ✅ 属实（session-manager.js `_setSessionFile` 保留显式路径；switchSession 复用同一文件） |
| §3.3 D4：pi session 文件延迟写入（AGENTS.md 规则 6） | ✅ 属实（_persist 首次 assistant 前不 flush，见 session-manager.js） |
| §3.3 D6：tool.ts scheduleGuidelines "next 5 run times" 文案 | ✅ 属实（tool.ts:24） |
| §5：store.ts load 迁移需要显式补 ownerSessionFile 字段 | ✅ 属实且关键：store.ts load() 显式白名单重建对象（store.ts:36-52），**漏加字段会在 roundtrip 时被静默剥离**——文档已列入改动地图，正确 |
| §3.2 方案 C 被否理由（README 承诺"关闭重开仍触发"） | ✅ 属实（README.md:31,144） |
| §2.1 例 2 widget 格式 `[scheduler] 1 scheduled · git pull origin m... in 59m` | ✅ 属实（widget.ts 格式一致） |

**未核实的运行时断言（D3 风险）**：§3.3 D3 的"双触发一次 / 迁移窗口自愈"经推演不成立（recurring 持续双触发，见 MUST_FIX 2）——文档自己标注了 ⚠️ 诚实，但结论仍低估。

## Rubric 逐项判定

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | §1-§5 齐全 |
| P0-2 delta 链 | 通过 | 无 vN/Rxx 引用，自包含 |
| P0-3 结论先行 | 通过 | 一句话结论 + SCQA |
| P0-4 根因 | 通过 | §2.3 双根因均源码证实 |
| P0-5 重实现轻体验 | 通过 | §2.1 使用者视角实测例子 |
| P0-6 术语定义 | 通过 | §2.5 owner/孤儿任务 |
| P0-7/8/9 方案对比 | 通过 | §3.2 两组各 3 方案、双维评估、明确裁决 |
| P0-10 方案解决目标 | **不通过** | persist 全量覆盖破坏 G3/G4（MUST_FIX 1）；D3 窗口 F3/F4 复发（MUST_FIX 2） |
| P0-11 关键事实 | **不通过** | 代码行为描述全部属实，但 D3"双触发一次/自愈"运行时断言错误（MUST_FIX 2） |
| P0-12 副作用/遗漏 | **不通过** | persist 路径遗漏（MUST_FIX 1）；subagent 遗漏、once-expires 未提（SUGGESTION） |
| P0-13 验收 testable | 通过（有缺口） | S1-S7 真实环境、步骤/通过标准/回溯目标齐全；但场景覆盖缺并发持久化与迁移窗口（MUST_FIX 3） |
| P0-14 验收=单测/mock | 通过 | 全部真实环境；单测仅作补充且明确"不替代" |
| P0-15 验收投入匹配 | 通过 | 7 场景 + 4 项单测补充，与改动规模匹配 |
| P0-16 运行时断言有探针 | 通过 | D2 ⛔探针、V1-V3 检查点、⚠️诚实标注 |
| P0-17 物理数据流 | 通过 | §2.4 |
| P0-18 错误恢复指引 | 通过 | §3.1 例 4 |
| P1-1..P1-7 | 通过（P1-5 部分） | D3 与 §3.2 A 行表述矛盾并入 MUST_FIX 2 |

## 结论

文档的根因分析、方案骨架、验收写作质量（真实场景、探针、诚实标注）均属上乘，是本仓库设计文档的高水位。但"loadTasks 过滤 + persist 不动"的组合在**本方案要修复的主场景（同 cwd 多 session）下必然丢任务**——这是实施后会在真实环境复现 G3/G4 破坏的缺陷，必须修。修复方向（合并写或使用点过滤 + dispatch 前 owner 复核）均为小改动，不改变方案骨架。
