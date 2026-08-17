# V4 生命周期终态收敛 — 对抗式设计审查报告

**审查对象**：`extensions/subagent-workflow/docs/design/v4-lifecycle-convergence.md`
**审查类型**：技术方案设计（设计层，准则 5/6/7/11 全部 P0 适用）
**审查方式**：对抗式；所有"事实/行号"声明均经 read/grep 源码核实后才下结论。

## Summary

**3 must-fix, 5 suggestions.**

总评：本文档的**事实基座是可信的、且异乎寻常地经得起核实**——我逐一 read 了文档引用的 19 处源码行号引用（types.ts / stdin-writer.ts / lifecycle-manager.ts / session-runner.ts / subagent-service.ts / subagent-actions.ts / notifier.ts / index.ts / finalize-record.ts / record-store.ts / manifest-store.ts + dsh continuation.ts），其中 18 处内容、位置、语义**全部属实**（含 P1 的"同步捕捉 + 无异步 error listener"、P2 的"链式锁无超时且与 :894 接线矛盾"、P3 的"upgrade 只置内存字段"、P4 的 id/cancelled 字面量、P5 ①②、P6 的四个簿记源、dsh A1~A5 的 continuation.ts 行号）。五段骨架/SCQA/方案对比/验收回溯/探针标注均达标。**必须修的不是文档的"事实可信度"，而是三处"方案自证"的缺口**——全部位于 B 期状态收敛把守卫/状态删掉时，是否补上了等价保护，以及跨重启语义是否被最终态定义真正覆盖。

三大病根中的两处（认知懒惰、视角错位）本文档未犯；问题集中在**结构失序的遗漏面（P0-12 副作用/遗漏）**与**B 期设计的自洽性**。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 B-3 / §4 S5 | P0-12 副作用/遗漏 | **"锁是唯一互斥源"的前提在 EPIPE 兜底路径不成立，删 CAS 会留下无双写防护的出口。** 已核实：`subagent-service.ts` 中消息投递的**热路径 EPIPE 兜底分支（:882-884）先 `record.status="idle"` 再直接 `this.resumeRound(record,text)`，全程不 acquire acquireActivateLock**；只有冷路径（:890-899）才拿锁。当前双写防护 = resumeRound 里的 CAS 守卫 `record.status!=="idle"`（:762，第二个并发 resume 会被 throw 拦住）。B-3 明确要删掉这个 CAS，并把互斥全权交给锁——但 EPIPE 环回路径（以及 A-1 新增的异步 error-listener → 冷路径 resume 路径，A-1 未注明要拿锁）都**绕过锁**。后果：两个并发 message 在子进程将死窗口都进 EPIPE 环回 → 都调 resumeRound → 无 CAS、无锁 → 双 spawn/双写 session 文件，正是 G1 明令禁止的"双写毁文件"。S5 又断言 "acquireActivateLock 是唯一互斥接入点"，与设计自身的双冷入口自相矛盾。 | 在 B-3/A-1 中显式规定：**所有 resumeRound 的调用入口（冷路径 + EPIPE 环回 + A-1 异步 error 路径）都必须经过 acquireActivateLock**；或保留一个与"锁"同阶的 in-flight 标志作 CAS 替代。并相应修正 S5 里"唯一互斥接入点"的 grep 断言，使其覆盖 EPIPE 路径。 |
| MUST_FIX | §3.3 B-1 / §4 S3/S4 / §5.3 / §2.1 | P0-10 对抗 / P0-12 遗漏 | **派生谓词 `isChatModeIdle = chatMode && hasIdleTimer(record.id) && 进程活` 无法表达"跨重启的空闲 record"，直接违背 G2"重启后语义不变"。** 已核实：`hasIdleTimer` 是内存态（lifecycle-manager.ts:129，idleTimers Map），跨重启必空；"进程活"跨重启必 false。而当前 `reconstructAll` 分支 4（record-store.ts:403）就是把这类 record 重建为 `idle` 的（B-1 删 idol 字面量后该分支无落点）。结果：一个"崩溃前处于 idle、等续聊"的 chatMode record，重启后列表里既非 idle（谓词为 false）、又无任何定义好的"可续聊态"来承载——S4 的通过标准"timer armed ↔ 显示空闲"只测了进程内 case，S3 又断言"list 显示该 record 可续聊态"（跨重启 case），两者在 B-1 定义下不自洽。 | 为"跨重启的可续聊 chatMode record"定义一个**派生的显示态**（非 `ExecutionStatus` 字面量，如 `isChatModeResumable(record) := chatMode` 且无终态 marker），并明确 `reconstructAll` 分支 4（record-store.ts:403）映射到它；让 S3 的列表断言和 S4 一致覆盖重启语义，使 G2 真正闭环。 |
| MUST_FIX | §3.3 A-3 / §5.2 / §4 S3 | P0-12 副作用/遗漏 / P0-11 事实 | **A-3 的"manifest ∪ identity 重建判定"在 `reconstructAll` 中不存在读 manifest 的路径，且把 manifest 从"终态诊断辅助"悄悄改成正确性依赖，这两点文档未点破，直接决定 S3 会不会过.** 已核实：① `reconstructAll`（record-store.ts:312-406）**零 manifest 读取**，chatMode 只来自 session.jsonl 的 identity entry（session-reconstructor.ts:105/151），而 identity 的 chatMode 是**spawn 时**由 env 注入（index.ts:373）——one-shot 从没带 chatMode=true spawn 过，升级后也不重写 identity，故重启后该 entry 恒为 false；当前 manifest 只在 `collectRecords`（:216-225 孤儿兜底，优先级低于内存/磁盘重建）读。② manifest 现为**终态专用、best-effort**（finalize-record.ts:187"不写 manifest（idle 非终态）"、:161/:172 best-effort 仅 error+appendEntry）。A-3 要"upgrade 时落盘 manifest + 重建取并集"，等于把重建判定改为依赖一个**当前不在 reconstructAll 读取链上、且语义是 last-resort/诊断工具**的来源，否则 S3 的重启续聊（"不报 has ended"）照样失败——subagent-actions.ts:366-368 的 "has ended" 恰恰在 `!record.chatMode` 时触发。 | 显式声明：A-3 要为 `reconstructAll` **新增** manifest 读取（或把 upgrade 的 chatMode 写进 session.jsonl 的 identity——子进程在场时补写）；并记录"manifest 从终态诊断辅助升格为 upgrade 持久化正确性来源"这一策略反转（含 best-effort 失败仅跨重启失效的边界，§5.3 检查点 4 已有雏形）。S3 通过标准应加一条"断言 reconstruct 后 record.chatMode=true"。 |
| SUGGESTION | §2.2 P5③ / §3.3 A-4 / §5.2 | P1-8 事实 | **P5③ 的行号与行内容张冠李戴。** 文档称 "finalize-record.ts:221 仍提已删除的 `.idle` sidecar"。已核实：finalize-record.ts:221 的实际内容是删 `.alive` marker 的注释（"缺失时跳过但仍设内存 idle（重启后磁盘重建会落到 crashed…）"，**准确无误**）；真正的陈旧 `.idle` sidecar 注释在 **:188**（doFinalizeRoundToIdle 的 doc-block "写 .idle sidecar（含轮次计数…）"）——且已确认 `.idle` **无任何写/读的运行时代码**（全仓无 `.idle` 文件字面量），所以"陈旧 .idle 引用确实存在"为真，但定位错到 :221 会误导 A-4 的定点回写。 | 把 A-4 的目标从 "finalize-record.ts:221" 改为 ":188"，并随 B-1/B-2 一并清理仍残留 ".idle sidecar/删 .idle" 注释的消费点（subagent-service.ts:998、subagent-actions.ts:284、types.ts:669、worktree-manager.ts:133）。 |
| SUGGESTION | §1 C / §2.2 P5 / §3.3 A-4 / §4 S5 | P1-5 MECE | **P5"文档-代码漂移"处数内不一致：定义的 6 处（①-⑥）vs 反复出现的"5 处"。** §2.2 表列 6 项 ①-⑥；但 §1/C、A-4、S5 三处均写"5 处"，且 ⑥（notifier dedup）实际被 B-1 的"round 与 dedup 修订"升级为**实质裁决**而非单纯文档回写。读者无法确定 A-4 到底回写 5 处还是 6 处、⑥ 归谁。 | 明确处数口径：若 ⑥ 由 B-1 处理，A-4 只回写 ①②③④⑤，则各处把"5 处"写成"A 期 5 处（另 ⑥ 归 B-1）"，或直接统一为"N 处+分工"。 |
| SUGGESTION | §4 S1/S2 | P0-14（边界） | **S1/S2 依赖"测试后门/注入 mock"制造确定性场景，严格说是"注入点"而非"真实并发"验收。** S1 用"判活后、写 stdin 前"注入点 kill、S2 用"测试后门并发触发两条 message + 注入 spawn 异常 mock"。真实子进程/锁/session 文件都在跑（并非整体 mock），所以比"纯 mock"可信得多；但并发竞态、spawn 异常本身是被**确定性注入**而非自然发生时观察到的，P0-14 的反 mock 精神在严格意义上未完全满足。 | 接受此注入（真实的锁竞争/进程死亡难以天然编排），但在 §4 明确声明"注入只负责制造竞态窗口，被验证的代码路径是真实 pi 子进程"，并把"自然发生（非注入）的单写者/无死锁"作为一条补充观察项，避免验收被注入点局限。 |
| SUGGESTION | §2.1 / §3.1 A-1 场景行注 | P1-8 事实 | **§2.1 场景行 "onRoundSettled：status='idle' + round+=1" 所引 `session-runner.ts:670-686` 是触发点，不是写入点。** 已核实 :670-686 是 `armIdleTimer` + `ctx.onRoundSettled?.(record)` 的调用现场；`status="idle"` 与 `round+=1` 的实际写入在 `finalize-record.ts:235-236`（doFinalizeRoundToIdle）。文档行注易让实施者以为状态翻转发生在 session-runner。 | 该场景行注附加 `finalize-record.ts:235-236` 指向真实写入点。 |
| INFO | §4 / 全文 | — | **事实基座优秀，应保留。** 19 处源码引用核实下来基本全部属实；A-1 的"全仓库无 child.stdin error 监听"经 grep 确认；A-2 锁链无超时确认；P6 的"探活四源"（spawnedChildren / hasIdleTimer / .alive+isProcessAlive / acquireActivateLock）全部存在；dsh A1~A5（continuation.ts:12-13/220-225/870-873 等）抽查一致。验收 S1~S5 是真实 pi CLI 场景、逐条回溯 G1~G4、机制侧断言优先，是 P0-13/14/15 的合格样板。 | 无需修改。 |

---

## P0 / P1 判定四态（关键项）

| 检查项 | 判定 | 依据 |
|--------|------|------|
| P0-1 五段骨架 | 通过 | §1 背景目标 / §2 现状问题 / §3 方案对比 / §4 验收 / §5 拆分，五段齐全 |
| P0-4 问题定义触根因 | 通过 | §2.3 归到 R1（表达不唯一）/R2（修复与重构捆绑），§1/Q 回溯根因，非只复述症状 |
| P0-7/8/9 方案对比 | 通过 | §3.2 四方案 A/B/C/D，每行评长期/短期/风险/裁决，给明确推荐 + 被否方案后果 |
| P0-10 方案是否真正解决 | **不通过** | B-3 删 CAS 后 EPIPE 兜底无等价防护（MF1）；B-1 派生谓词不覆盖跨重启 idle 显示（MF2） |
| P0-11 关键事实 | 基本通过（3 处瑕疵） | 绝大多数引用属实；P5③ 行号/行内容、P5 处数、session-runner 写入点 3 处需校正（MF/S 均已列） |
| P0-12 副作用/遗漏 | **不通过** | MF1（EPIPE 无双写防护）、MF2（跨重启 idle 显示未定义）、MF3（manifest 读路径/语义升级） |
| P0-13/14/15 验收 | 通过 | S1~S5 真实 pi CLI，非单测非整体 mock，逐条回溯 G1~G4，具体业务例 + 明确通过标准；（S1/S2 注入点边界见 SUGGESTION） |
| P0-16 运行时断言附探针 | 通过 | A-1/A-2/A-3/B-1 均配 ⛔ 探针（P-epipe/P-lock/P-upgrade/P-idle）|
| P0-17 物理数据流图 | 通过 | §2.1 磁盘→内存→manifest/sidecar→/subagents 完整链路 |
| P0-18 错误恢复指引 | 通过 | EPIPE/锁超时/终态错误均带 `action:'close'/'message'` 恢复指引 |
| P1-1/2/3 概念例子/拆分 justify/背景 | 通过 | §2.1 真实旅程 + 概念表绑例子；§5.1 每单元 justification 齐全 |
| P1-5 MECE | **不通过** | P5 处数 6 vs 5 口径不一致（见 SUGGESTION）|
