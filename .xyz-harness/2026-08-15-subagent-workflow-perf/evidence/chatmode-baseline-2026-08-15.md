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

## wave2 场景 2 对照判定（预留，增量改造合入后回填）

同协议复跑（增量语义下）判定判据：

- 第 2 条 content **不含** ROUND1 字样、第 3 条不含 ROUND1/ROUND2
- 每条只含当轮标记，三条长度大致相等（≈ 94 + 51 = 145 上下）
- 总量对比本基线（145+198+251=594）显著下降（预期 ≈ 145×3=435 量级，减去重复历史标记部分）
