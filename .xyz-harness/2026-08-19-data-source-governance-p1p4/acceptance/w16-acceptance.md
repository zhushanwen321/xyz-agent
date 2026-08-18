# W16 验收标准：subagent 扩展自描述 appendEntry 上报

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §5 W16 节（L517-541）是 W16 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W2（登记表 #8）、W5（已 committed）。可与 P1/P2 并行（不同包）。

## 目标（一句话）

subagent-workflow 扩展在 subagent record 状态变更时经 `pi.appendEntry` 写自描述完整记录（字段即 SubagentRecord + v:1 版本），pi 文件成为扩展数据持久化权威（D4）；内存 record-store 保持运行时权威，entry 是重建源。

## 交付物

1. `extensions/subagent-workflow/src/execution/record-entry.ts` [新增]（或 record-store.ts 内类型定义处——builder 定案二选一汇报）：customType 常量（`subagent-record`，命名对齐现有 `subagent:manifest-invalid-status` 风格）+ 自描述 entry 的 data schema
2. `extensions/subagent-workflow/src/execution/record-store.ts`（修改：状态迁移点追加 `this.pi?.appendEntry?.("subagent-record", record)`——复用 L175/L223 既有注入通道）
3. `extensions/subagent-workflow/src/execution/__tests__/`（修改/新增用例）
4. 登记表 #8 条目备注补探针数字（见下）——**注意：这是本 wave 唯一允许碰登记表的改动，仅 #8 备注**

## 核心规格锁定（plan W16 步骤 1-4）

1. data = 完整 SubagentRecord 快照（id/status/result 摘要/时间戳等全部 GUI 侧需要的字段）+ `v: 1`；不依赖读取方逆向解析 toolCall/toolResult（自描述原则）。
2. 状态迁移点（running → 终态等，`grep -n "status" record-store.ts` 定位状态机写点）逐点追加 appendEntry。
3. 探针（D4 开放项收口）：本地 pi 实测记录单个 entry 字节数与一次完整 subagent 生命周期的 append 次数 → 写登记表 #8 备注；超阈值（单 entry >100KB 或生命周期 >50 次）按父文档预案分流（trace 增量 + 状态全量两种 customType）——触发预案属方案内既定分支，执行并记录即可。
4. 本地 pi CLI 实测（workspace AGENTS.md 强制流程）：`pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <extensions/subagent-workflow 路径>` 跑一个后台 subagent 完成，tail session JSONL 确认自描述 entry 落盘。

## 通过命令（builder 自验 + verifier 实跑）

1. `grep -n "subagent-record" extensions/subagent-workflow/src/execution/record-store.ts` ≥2 命中（常量 + append）；`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连通过。
2. 行为级：本地 pi 实测中 session JSONL 出现 `type:"custom"` 且 `customType:"subagent-record"` entry，data 含完整 record 字段（jq/python3 解析核对字段清单）。
3. 回归：subagent 现有功能（spawn/查询/完成注入）不受影响——既有测试全绿；entry 不进 LLM context（custom entry pi 侧保证——实测对话轮数不因 entry 增加而变化）。
4. 探针落表：登记表 #8 条目备注含单 entry 体积与 append 频率实测数字。

## 禁改清单（越界 = 验收失败）

- 两个验收权威文档；登记表除 #8 备注（探针数字）外任何内容
- **并行领地**：W6（packages/runtime/）、W20（packages/core/ + runtime message-converter）一律不碰
- extensions/ 下其他包（只动 subagent-workflow）；extensions/shared/ 不动（若发现需要动共享库 = 规格冲突上报）
- 禁 git 写操作；禁 any（extensions/ 由 taste/no-unsafe-cast 强制断言 guard）

## 备注

- [MANDATORY] 扩展改动优先在本地 pi CLI 实测（不是 xyz-agent 桌面）——派发词含完整实测命令。
- 完成后解锁 W17（同包顺序改造）。
