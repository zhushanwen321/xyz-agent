# chatMode 轮次通知基线证据（round-base-increment-core wave1，改动前）

## 采集环境

- 时间：2026-08-15T11:25-11:26 UTC（19:25-19:26 本地）
- pi 0.84.0 RPC 模式（`pi --mode rpc --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension extensions/subagent-workflow`），PI_EXT_DEBUG=1
- extension：本 worktree（feat-subagent-continuous-chat）未改造源码，`--extension` 显式加载 `extensions/subagent-workflow`（@zhushanwen/pi-subagent-workflow 7.3.1）
- cwd：临时干净目录 `/tmp/c1t0-baseline/cwd-ZtnmkA`（无 git repo，排除无关工具干扰）
- 父 session：`--session-dir /tmp/c1t0-baseline/sessions`，文件 `2026-08-15T11-25-19-260Z_01a0052b-4e1c-75d3-93a7-c5b65d5ec326.jsonl`
- 子 session：`~/.pi/agent/subagents/--private-tmp-c1t0-baseline-cwd-ZtnmkA--/sessions/2026-08-15T11-25-25-705Z_01a0052b-6749-7b9b-a726-760a81ffad1c.jsonl`（存在，含 3 轮完整对话）
- 对话协议：父 agent 单 prompt 编排——start chatMode subagent（task：只回复 `ROUND1-<51 字符固定标记>`）→ 每收一条轮次通知立即 `action:"message"` 发下一轮（ROUND2-/ROUND3- 同长度标记）→ 第 3 条通知后 `action:"close"` → 父最终回复 "DONE"。模型全程配合，无重试
- 每轮标记长度 51 字符（`ROUNDn-K4M7-QX9Z-B2W5-T8L3-C6H1-D4F8-G2J9-E5N2-R7S4`），通知头 `Subagent "general-purpose" (sa-f5bcb6de-…) finished a round. Reply:\n` 长 94 字符

## 基线结论（现状 O(N²) 通知叠加成立）

父 session JSONL 恰 3 条 `subagent-bg-notify` custom_message entry，content 长度 145 → 198 → 251 逐条叠加（每轮 +53 = 2 分隔 + 51 标记），第 k 条 content 含前 k 轮全部标记——`record.result = getFullText(record)` 全量派生的直接实测证据。

| # | content 长度 | 含 ROUND1 | 含 ROUND2 | 含 ROUND3 | content 全文 |
|---|---|---|---|---|---|
| 1 | 145 | 是 | 否 | 否 | `Subagent "general-purpose" (sa-f5bcb6de-ead8-49eb-82e8-0a60e69a9e45) finished a round. Reply:\nROUND1-K4M7-QX9Z-B2W5-T8L3-C6H1-D4F8-G2J9-E5N2-R7S4` |
| 2 | 198 | 是 | 是 | 否 | 同上 + `\n\n` + `ROUND2-K4M7-QX9Z-B2W5-T8L3-C6H1-D4F8-G2J9-E5N2-R7S4` |
| 3 | 251 | 是 | 是 | 是 | 同上 + `\n\n` + `ROUND3-K4M7-QX9Z-B2W5-T8L3-C6H1-D4F8-G2J9-E5N2-R7S4` |

断言结果（C1TC1）：

- 恰 3 条 `subagent-bg-notify` entry：通过
- 第 2 条 content 含 ROUND1（上轮文本重发 = O(N²) 叠加证据）：通过
- 第 3 条同时含 ROUND1 与 ROUND2：通过（且含 ROUND3，全量语义下第 k 条含前 k 轮全部）
- 三条长度逐条叠加增长（145/198/251，量级 1L/2L/3L）：通过

数字分解：145 = 94（通知头）+ 51（R1）；198 = 145 + 53（`\n\n` + R2）；251 = 198 + 53（`\n\n` + R3）。N 轮下第 k 条通知体积 ∝ 94 + 53k，总体积 O(N²)。

采集产物（临时目录，不随 commit）：`/tmp/c1t0-baseline/`（pi-stdout.jsonl 事件流 / pi-stderr.log / notifies.json 三条通知原文 / event-summary.json）。

## wave2 场景 2 对照判定（增量改造 + 指针行合入后实测，2026-08-15 20:39-20:52 本地）

采集环境与基线一致（pi 0.84.0 RPC + mimo + `--extension` 本 worktree 源码，PI_EXT_DEBUG=1，临时干净 cwd）。同协议复跑（3 轮 chatMode + close + DONE），判定判据（双向）：

- 不重：第 2 条 content **不含** ROUND1 字样、第 3 条不含 ROUND1/ROUND2
- 不丢：第 k 条 content 含当轮标记 `ROUNDk_TEXT` 正断言（k=1,2,3）
- 每条末尾 `Full transcript: <path>` 指针行且文件存在
- 三条长度大致相等（G1 判据 + O(N) 量化锚点）

### 判定结果（全部通过，16/16 断言）

| # | content 长度 | 含当轮标记 | 不含前轮标记 | 指针行 + 文件存在 |
|---|---|---|---|---|
| 1 | 321 | ROUND1 是 | （首轮无前置） | 是 |
| 2 | 321 | ROUND2 是 | 是（无 ROUND1） | 是 |
| 3 | 321 | ROUND3 是 | 是（无 ROUND1/2） | 是 |

三条通知原文形态（唯一差异是当轮标记）：

```
Subagent "general-purpose" (sa-3da92d97-…) finished a round. Reply:\nROUND1-T7G2-…-F3S8\n\nFull transcript: /Users/…/subagents/--private-tmp-c2t6-run-run-s2-BAiH93-cwd--/sessions/2026-08-15T12-39-34-575Z_….jsonl
```

与基线对照：基线 145/198/251（逐条 +53 叠加，第 k 条含前 k 轮全量）→ 321/321/321（每条恰含当轮增量 + 固定指针行）。增量语义实测成立。

长度分解：321 = 94（通知头）+ 51（当轮标记）+ 2（`\n\n`）+ 17（`Full transcript: `）+ 157（子 session 绝对路径）。

总量说明（如实记录，修正预留节的 435 预期）：3 轮总量 963 > 基线 594——指针行是每条通知的固定开销（本环境 176 字符，随路径长度变化），预留节的「≈145×3=435 量级」预期未计指针行。增长阶才是判定锚点：wave2 每条 = 94+L+176 固定 → 总量 O(N)；基线第 k 条 = 94+53k → 总量 O(N²)。固定开销回本点 ≈ N=7（321N vs 94N+53·N(N+1)/2），N≥7 后 wave2 总量低于基线且差距随 N 扩大。

### 场景 4 idle close 现状语义（同一次运行判定，通过）

- 父 close action 调用后父 JSONL **无新增** `subagent-bg-notify` entry（总数仍 3，close 终态化不发自适应通知——现状机制，终态通知发送点不存在，上报 feature 层）
- 末条轮次通知指针行指向子 session 文件，cat 该文件含 3 轮全部标记（ROUND1/2/3 全文在子 session 中完整保留——增量通知丢全文风险的恢复通道实测可用）

### 场景 3 跨轮暗号（父侧判定，通过，8/8 断言）

编排：子第 1 轮回 ready → 第 2 轮自选暗号 `CODE-K7R2XN9B`（父未预知内容）→ 父第 3 轮 message 文本为 `The secret code you gave was CODE-K7R2XN9B. Repeat exactly that code and nothing else.` → 子第 3 轮重复同一暗号。

- 父第 3 轮 prompt 引用的暗号 == 第 2 轮通知 content 中的暗号（父的唯一信息源是第 2 轮通知文本——增量若丢第 2 轮文本，父无法引用）：通过
- 第 2 条通知不含第 1 轮文本 ready（增量不重发）：通过
- 第 3 条通知含同一暗号（子重复）：通过

### 场景 5 one-shot 零影响（通过，4/4 断言，结构级 + 语义级并列）

one-shot background subagent（无 conversation flag）完成通知：

- 结构级：通知 `details` 无 `sessionFile` 字段（keys = id/status/agent/model/result/startedAt/round）：通过
- 语义级：content 不含指针行；且与改造前形态**逐字节相等**——改造前 `buildLlmContent` 是纯函数，用实际 details 重建 `Subagent "<agent>" (<id>) completed. Result:\n<result>` 与实际 content 完全一致：通过

（首次 s5 跑子进程停在 thinking 无输出属模型侧偶发 hang，重跑通过；同一时段 chatMode 场景正常，与本次改动无关——改动仅在通知构造层，不触子进程推理链路。）

### ES7 合并窗口检查点（结构性论证关闭，未实测）

单 subagent 协议下每次 notify 时 `hasRunningBackground` 对 timer-armed record 返回 false（subagent-service.ts:543-552，v4 B-1 判定排除 idle 等待续聊态）→ 立即 flush，合并窗口（notifier.ts:205-208 多 pending 拼 `\n\n---\n\n`）结构性不出现。ES7 的多 subagent 并发触发场景超出本 wave 实测预算，为已知未实测项留 feature 层复盘决策。

采集产物（临时目录，不随 commit）：`/tmp/c2t6-run/`（driver.js 驱动 + judge.js 判定 + run-s2/s3/s5 三次运行的 pi-stdout.jsonl / 父子 session 副本路径）。
