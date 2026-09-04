
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
