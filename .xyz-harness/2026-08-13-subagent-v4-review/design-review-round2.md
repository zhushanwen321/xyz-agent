# V4 生命周期终态收敛 — 对抗式设计审查报告（第二轮复审）

**审查对象**：`extensions/subagent-workflow/docs/design/v4-lifecycle-convergence.md`（主 agent 已按第一轮 3 MUST_FIX + 5 SUGGESTION 修复后）
**审查方式**：对抗式复扫；三个 M 项逐一 read 源码验证闭环，再对修改后全文跑 P0 项。所有"事实/行号"声明均经 read/grep 源码核实。

## Summary

**2 must-fix, 3 suggestions.**

结论：第一轮的 **MF1（锁下沉进 resumeRound）闭环且此前提出的 5 个 SUGGESTION 全部落地**；但**MF2、MF3 两个修复各自的"机制"陈述经 read 源码核实与真实行为不符**——MF2 新加的派生谓词 `isChatModeResumable` 对**所有**跨重启重建 record 恒为 false（跨重启可续聊态落点仍未形成，第一轮 MUST_FIX 的根治面未达），MF3 的"幂等 re-upgrade"功能性成立但**归因到了错误的代码行**（真正承重的是 `getRecordForAction` 强制 `chatMode:true`，而非文档声称的 `:355-358` upgrade 分支），并直接污染 S3 断言与 §5.3 checkpoint 4 的安全守卫。

---

## 第一轮修复逐项验证

### MF1（B-3 锁下沉 resumeRound）——**闭环，1 处口径遗留**（SUGGESTION）

- **三个调用方覆盖面**：read 源码核实 `subagent-service.ts` 中 `resumeRound(` 精确 3 处：`:884` EPIPE 环回（无外层锁）、`:896` 冷路径（当前包 `acquireActivateLock`，:894-899）、`:1512` `redeliverPendingMessages`（无外层锁）。文档 B-3 把三个调用方全部点名（:896/:884/:1512）并规定"全部删掉自己的锁包装"、锁下沉进 resumeRound 内部。**覆盖完整**。
- **EPIPE 环回当前无锁、双写防护依赖 CAS 的陈述属实**（:883 设 `status=idle` → :884 直调 resumeRound，全程无 `acquireActivateLock`）；锁下沉 + 锁内重检进程死活（已活→热路径 prompt / 仍死→spawn）使该出口在终态消失，逻辑自洽。
- **新死角核查**：任务提示的"resumeRound 锁内热路径 prompt 与 deliverMessage 热路径重复 disarm"——read 核实 `disarmIdleTimer`（lifecycle-manager.ts:117-124）无 armed timer 时 no-op，**重复 disarm 无害，此疑虑排除**。
- **遗留（SUGGESTION）**：B-3 只列"三个调用方"，未计入 **A-1 新增的第 4 个 resumeRound 调用方**（异步 error listener → 冷路径重放）。A-1 在 B-3 **之前**独立先合（§5.1 A 期可并行），故 A-1→B-3 之间存在一个无锁 resumeRound 调用方的过渡窗口（虽然 B-3 锁下沉终态安全）。S5 的 grep 断言也写死"resumeRound 的三个调用方"，A-1 落地后口径过期。修复方向见 Findings S1。

### MF2（isChatModeResumable + 分支 4 改 running）——**未闭环（MUST_FIX）**

第一轮要求"为跨重启可续聊 record 定义派生态，让分支 4 映射到它，S3/S4 断言一致"。主 agent 加 `isChatModeResumable = chatMode && L1=running && 无活进程句柄` 并分支 4 → running。**但 read 源码发现该谓词对跨重启 record 恒为 false**：

- `reconstructAll`（record-store.ts:312-413）构造的 `SubagentRecord`（:342-370）**从不填充 chatMode**（record-store.ts 全文件无 chatMode 赋值；grep 确认）。chatMode 只在内存路径 `createRecord`/`execution-record.ts:179` 从 create 参数填充。
- 故**任何**跨重启重建的 record（无论 conversation:true 还是 one-shot）chatMode 均为 undefined → `isChatModeResumable` = `undefined && ...` = **false**。
- 结果：B-1 声称"跨重启可续聊态落点明确、G2 闭环"，但该派生谓词对重建 record 永不成立——跨重启的 chatMode record 列表显示为 running，**isChatModeIdle / isChatModeResumable 同时为 false**，"可续聊态"仍无真实落点，第一轮 MUST_FIX 的根治面未达成。
- S3（行 274）"list 显示该 record 为 active/**resumable**"与谓词定义**不可同时满足**——重建 record chatMode 缺省，resumable 恒 false。

### MF3（幂等 re-upgrade 定案）——**功能性成立，机制归因错误（MUST_FIX）**

对抗核查的三问：

1. **重启后 record 经分支 4 重建为何状态**：分支 4 当前写 `idle`（record-store.ts:403），按 B-1 改为 `running`。无 `.cancelled`/`.finalized` marker、pid 死 → 分支 4。**重建为 running（文档所述）属实**。无"崩溃窗口重建为 closed"的反例（one-shot 完成走 `!chatMode && closed && success` → 保持 active 不 wrote `.finalized`，subagent-service.ts:1354-1357；main 崩溃→子进程 F10 自杀→pid 死→落分支 4 非 2）。**idempotency 功能性成立：无重建为 closed 反例**。
2. **chatMode 为何值**：**文档陈述"重建为 active（chatMode=false）"错误**——reconstructAll 重建 record 的 chatMode 是 **undefined（不填充）**，且真正进入 messageHandler 的 record 不是 reconstructAll 产物，而是 `getRecordForAction`（subagent-service.ts:921-951）的磁盘重建，后者**无条件 `chatMode: true`（:943）**。
3. **upgrade 分支（:355）是否真命中**：**不命中**。`messageHandler` 一律经 `getRecordForAction`（:348），其磁盘重建已把 chatMode 强制为 true → 到 :355 时 `!record.chatMode` 为 false → **upgrade 分支跳过**，直接走 `if (record.chatMode) → deliverMessage`（:363-364）。幂等恢复真正靠的是 `getRecordForAction:943`，不是文档声称的 `:355-358`。

**"收敛后（分支 4 改 running）幂等性是否仍成立"**：成立但机制仍非 :355——B-1 后 `getRecordForAction` 的重建谓词 `r.status === "idle"`（:930）须改 `=== "running"`，chatMode 仍强制 true。恢复路径不变（getRecordForAction:943）。**无 has-ended 回归反例**。

**影响评估（为何 MUST_FIX）**：文档 A-3 / 场景 C / S3 / §5.3 checkpoint 4 全部把 ":355-358 upgrade 分支是许可位恢复的唯一机制"当因果与安全锚。read 核实该分支在**跨重启路径不参与**——真正承重的 `getRecordForAction:943`（一屏之隔的 :946 被文档引用，:943 却未提）。§5.3 checkpoint 4 让实施者"只守护 :355-358"是**对准了错误的代码行**；若未来改动 getRecordForAction 的 chatMode:true（比如改为从 identity 读），跨重启恢复会在毫无设计级守护下静默失效。S3 断言 "record.chatMode=false→true（首次 message 触发）"因重建即 true 而**不可观测**。属影响决策/架构的事实错误。

---

## 复扫（P0 项）

| 项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | 五段齐全（修复未破坏结构） |
| P0-2 delta 链 | 通过 | 无 vN/变更摘要引用 |
| P0-10 因果自证 | **不通过** | MF2（resumable 谓词无法表达跨重启）、MF3（恢复机制归因到 :355-358 而非 :943）两处因果链断裂 |
| P0-11 关键事实 | 通过（残留 2 处） | 绝大多数字号属实；MF3 的"chatMode=false→upgrade 分支重触发"、MF2 的"跨重启 resumable 可见"与源码不符 |
| P0-12 副作用/遗漏 | **不通过** | A-1 第 4 个 resumeRound 调用方未纳入 B-3/S5 计数；getRecordForAction 的 :930/:946 idle 字面量不在 B-1 消费点清单 |
| P0-13/14/15 验收 | 通过 | S1~S5 真实 pi CLI + 逐条回溯 + 注入点/自然观察声明齐全（round-1 SUG#3 已落地）；但 S3 断言基于错误的 :355 机制（见 MUST_FIX#2） |
| P0-16 运行时探针 | 通过 | A-1/A-2/A-3/B-1 均配 ⛔ 探针 |
| P0-17 物理数据流 | 通过 | §2.1 链路完整 |
| P0-18 错误恢复指引 | 通过 | EPIPE/锁超时/终态均带恢复指引 |
| P5 处数口径 | **通过（已修复）** | §2.2 定义 6 处 ①-⑥，A-4/S5 均写"6 处，⑥ 归 B-1"（行 3/21/100/210-211/283），round-1 的"5 处 vs 6 处"不一致已消除 |
| P5③ 行号 | **通过（已修复）** | finalize-record.ts:188 指向正确（read 核实 :188 确含陈旧 `.idle` sidecar 注释）；round-1 的 :221→:188 已改 |
| session-runner 写入点 | **通过（已修复）** | :71 已补 finalize-record.ts:235 (read 核实 :207 doFinalizeRoundToIdle) |
| S1/S2 注入点声明 | **通过（已修复）** | §4 首段 + S1 步④ / S2 步④ 自然观察（round-1 SUG#3 落地） |
| A-3 manifest 残留 | **通过** | A-3 明确"不落盘、不加 manifest 读路径"，§3 已删对 manifest 重建的依赖断言，S2/S3 不再依赖 manifest 读路径 |

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 A-3 / §3.1 场景C / §4 S3 / §5.3-4 | P0-11 事实 / P0-10 因果 | **幂等 re-upgrade 归因到错误的代码。** read 核实：跨重启恢复的承重机制是 `getRecordForAction`（subagent-service.ts:921-951，:943 无条件 `chatMode:true`），而非文档声称的 `:355-358` upgrade 分支（`messageHandler` 一律先经 getRecordForAction，到 :355 时 `!record.chatMode` 恒 false，分支跳过）。`reconstructAll` 重建 chatMode 亦为 undefined 非 "false"。功能性幂等仍成立（无重建为 closed 反例），但 A-3/S3 因果叙述把恢复归到 never-fires 的 :355-358，§5.3 checkpoint 4 的"唯一机制安全守护"对准错行——若未来改 getRecordForAction 的 chatMode 逻辑，跨重启恢复将无守护静默失效。 | A-3 重述恢复机制为 getRecordForAction:943 的 chatMode:true 强制重建；S3 断言从 "chatMode=false→true" 改为 "重建后 record.chatMode 恒 true（getRecordForAction:943）";§5.3 checkpoint 4 改为守护 getRecordForAction:943（而非 :355-358）。 |
| MUST_FIX | §3.3 B-1 / §4 S3 / §2.1 | P0-10 对抗 / P0-12 遗漏 | **`isChatModeResumable` 对跨重启重建 record 恒为 false，跨重启可续聊态落点未形成（第一轮 MUST_FIX 未根治）。** read 核实 reconstructAll（record-store.ts:342-370）重建的 SubagentRecord **从不填充 chatMode**（record-store.ts 无 chatMode 赋值），而谓词 `= chatMode && running && 无句柄` 依赖 chatMode → 任何真实跨重启 record（含 conversation:true）chatMode=undefined → resumable=false。S3 "list 显示 active/resumable" 与谓词定义不可同时满足。 | 三选一：① reconstructAll 填充 chatMode（从 session.jsonl identity 读——identity 已在读取链上，与 A-3"不加 manifest 读路径"不冲突，但属 A-3 边界，需在文档点破）；② isChatModeResumable 不依赖 chatMode（改为 `running 且无终态 marker 且无活句柄`）；③ S3 断言降级为 "active/running"。须保证谓词真值表与 S3/S4 断言一致。 |
| SUGGESTION | §3.3 B-3 / §3.3 A-1 / §4 S5 | P0-12 / P1-5 | **第 4 个 resumeRound 调用方（A-1 异步 error listener）未纳入 B-3/S5 计数。** A-1 先于 B-3 独立合入，期间存在无锁 error→resumeRound 调用方；S5 grep 写死"三个调用方"在 A-1 落地后过期。 | A-1 明确"error 路径也经 resumeRound，过渡期临时拿锁或与 B-3 同批合入"；S5 grep 改"所有 resumeRound 调用方（含 A-1 error 路径）均无独立锁 / 无直接 spawn"。 |
| SUGGESTION | §3.3 B-1 / §5.2 | P1-8 事实 | **`getRecordForAction` 硬编码 idle 字面量不在 B-1 消费点清单：** :930 `r.status === "idle"` 谓词 + :946 `record.status = "idle"`。B-1 删 idle 后须改 `=== "running"`（且 B-1 后分支 4→running，此谓词恰好需作为 message 重建时的"可续聊"入筛）。虽被 "tsc 强制全覆盖" 兜底，但与 MF2/MF3 强耦合，应显式纳入清单。 | B-1 消费点清单补 `subagent-service.ts:921-951`（:930/:946）。 |
| SUGGESTION | §3.3 B-3 | P1-3 表达 | 任务提示的"重复 disarm"疑虑已排除（disarmIdleTimer no-op，read 核实）。但 B-3 新增"resumeRound 锁内热路径 prompt"复用 sendPromptCommand+streamingBehavior，其与 deliverMessage:851 顶层 disarm 的交叠语义文档未细述，易致实施者重复守卫。 | B-3 补一句注释级约定："热路径 prompt 前无需额外 disarm（deliverMessage 顶层已 disarm，disarm 幂等）"。 |

---

## P0 / P1 判定四态（关键项）

| 检查项 | 判定 | 依据 |
|--------|------|------|
| P0-10 方案是否解决根因 | **不通过** | MF2 跨重启可续聊落点谓词不可满足；MF3 恢复机制归因错行。功能性幂等成立（无 closed 反例），但文档自证链断裂 |
| P0-11 关键事实 | 通过（2 处机制性错误在 MUST_FIX 内） | 98% 行号属实；MF3"chatMode=false→:355 重触发"、MF2"跨重启 resumable 可见"两处与源码不符 |
| P0-12 副作用/遗漏 | **不通过** | A-1 第 4 个 resumeRound 调用方计数遗漏；getRecordForAction idle 字面量不在 B-1 清单 |
| P0-13/14/15 验收 | 通过 | 真实 pi CLI、逐条回溯、注入点+自然观察声明齐全；仅 S3 断言基于错误机制（随 MUST_FIX#1 一并修） |
| P0-18 错误恢复指引 | 通过 | 各失败场景均带恢复动作 |

*注明*：本轮 2 个 MUST_FIX 均为"文档陈述的机制/谓词与 read 源码不符，且直接影响验收断言与安全守护落点"——非纯行号偏移（那类降级为 SUGGESTION），故保持阻塞级。
