
## A7 — 2026-09-04T18:44:27.155Z

| 项 | 值 |
|---|---|
| 批通知条数（预期 1） | |
| 批头（预期 3 finished, 0 failed, 0 cancelled） | |
| 批闭合前新增 turn（预期 0） | |
| 派发→批通知时延（预期 ≥50s） | |
| zcode 生效证据（record.engine / engines journal） | |
| engineFallback 标记（预期无） | |

## A1 — 2026-09-04T19:32:27.118Z

- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 批通知时延: 70.2s（派发 → 单唤醒）
- notify entry 总数: 1（预期 1）

## A1 — 2026-09-04T19:37:14.535Z

- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 批通知时延: 68.3s（派发 → 单唤醒）
- notify entry 总数: 1（预期 1）

## A8 — 2026-09-04T19:37:59.209Z

- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- notify 总数: 2（预期 2 = 1 批 + 1 单）

## A4 — 2026-09-04T19:53:30.734Z

- [①] 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100）
- [①] 全文长度: 380（截断前）／保留: 101
- [①] 取回一致: no

## A4 — 2026-09-04T19:53:44.215Z

- [②] 成员正文长度: 6 / 6 / 6 / 6 / 6 / 6 / 6（上限 200）
- [②] 总量: 42／截断指针: 0/7

## A4 — 2026-09-04T20:08:07.029Z

- [①] 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100）
- [①] 全文长度: 461（截断前）／保留: 101
- [①] 取回一致: yes（逐字节）

## A4 — 2026-09-04T20:08:18.698Z

- [②] 成员正文长度: 6 / 6 / 6 / 6 / 6 / 6 / 6（上限 200）
- [②] 总量: 42／截断指针: 0/7

## A6 — 2026-09-04T20:36:35.039Z

- 结果: **FAIL**（exit=1）——补发批通知 240s 零到达（waitForNotify timeout，seen 0 notify entries），两次独立复现
- 已过断言: pi RPC 就绪 / 派发轮 turn_end / 主 session 可定位 / 派发 2 个 collect:sync start（starts=2）/ kill -9 生效 / 重启 #1 RPC 就绪
- 未达断言: 补发单条批（批头 2 finished, 0 failed, 0 cancelled）/ 二次重启零重发（前置失败未达）
- 根因（diag-survive 实测）: 主 pi SIGKILL 后 worker 子进程随即全灭（t+5s 进程数=0，stdin 管道断裂），finalized 恒 0；成员 subagent-record 停留 running，E1 恢复钩子按「仍有 running → 等待自然完成」永久等待——「孤儿自行跑完」前提在真实 CLI 不成立，属产线前提缺口而非探针缺陷
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro

## V1 — 2026-09-05T06:33:21.826Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V1；v1 A4① 复验）——17 PASS / 0 FAIL
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100 确定性触发截断）
- 全文长度: 420（截断前）／批内保留: 101
- manifest 首见时点已落盘: yes（mtime 早于 notify entry timestamp 2ms；manifest.status 如实投影 "running"）
- sa- id 自举反查: 命中
- 取回一致: yes（逐字节）

## V2 — 2026-09-05T06:44:28.456Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V2；GV2①）——15 PASS / 0 FAIL
- 模式: primary（SIGKILL 于批等待中，2 终态成员 + 1 sleep 中）
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 补发批头: 3 finished, 0 failed, 0 cancelled
- 成功成员 result 全文: yes（覆写 merge 保留）
- 二次重启 notify: before=1 after=1

## V3 — 2026-09-05T06:45:32.695Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V3；v1 A6 FAIL 转 PASS）——11 PASS / 0 FAIL
- 模式: primary（kill -9 于批等待中）
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 补发批头: 2 finished, 0 failed, 0 cancelled（成员正文实测为空——sleep 中 kill 无 assistant 输出，gc 判 finished + 覆写 entry 无 result 可 merge，设计「result 或截断 error」二分外的第三形态：空正文）
- 二次重启 notify: before=1 after=1

## V2 — 2026-09-05T07:27:53.158Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V2；GV2①）——16 PASS / 0 FAIL
- 模式: primary（SIGKILL 于批等待中，2 终态成员 + 1 sleep 240s 中）
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 补发批头: 3 finished, 0 failed, 0 cancelled
- 成功成员 result 全文: yes（覆写 merge 保留）
- 二次重启 notify: before=1 after=1

## V1 — 2026-09-05T07:31:44.167Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V1；v1 A4① 复验）——17 PASS / 0 FAIL
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100 确定性触发截断）
- 全文长度: 417（截断前）／批内保留: 101
- manifest 首见时点已落盘: yes（mtime 晚于 notify entry timestamp 3ms；manifest.status 如实投影 "running"）
- sa- id 自举反查: 命中
- 取回一致: yes（逐字节）

## V3 — 2026-09-05T07:32:59.823Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V3；v1 A6 FAIL 转 PASS）——12 PASS / 0 FAIL
- 模式: primary（kill -9 于批等待中）
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 补发批头: 2 finished, 0 failed, 0 cancelled（成员正文实测为空——sleep 中 kill 无 assistant 输出，gc 判 finished + 覆写 entry 无 result 可 merge，设计「result 或截断 error」二分外的第三形态：空正文）
- 二次重启 notify: before=1 after=1
