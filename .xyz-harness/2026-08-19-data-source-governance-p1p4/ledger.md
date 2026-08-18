# data-source-governance P1-P4 状态账本

> 协调机制：cw-orchestrator（同 P0 账本 `../2026-08-19-data-source-governance-p0/ledger.md`，P0 已完成封存：W1-W5 + gate PASS）。
> 规格 SSOT = `docs/architecture/data-source-governance-plan.md` §3-§6（W6-W25 节）；父文档 = `docs/architecture/data-source-governance.md`；登记表 = `docs/architecture/data-source-registry.md`。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected（打回原 builder 修复后针对性复审）。
> 并发上限 3；subagent 一律禁 git 写；每 wave 完成即 commit（主 agent 唯一 commit 出口，精确路径 add）。

## 依赖图（执行顺序依据）

- 主链：W6 → W7 → W8 → W9 → W10 → W11 → W12 → {W13 ∥ W14} → W15
- 旁链 extensions：W16 → W17（可与 P1/P2 并行，不同包）；W18 = W12 + W16 + W17 汇合
- 旁链 chat 域：W20 → W21（可与 W16-W18 并行，禁与 W13/W14 并行——同碰 core domain/chat）
- 尾部：W19（W2+W11）、W22（W21）、W23（W11+W13+W18）、W24（W2+W13）、W25（W5+W21）
- 共享文件警戒：登记表（W16/W8/W19/W23 都会改）——同波次禁止两个 wave 同时改登记表

## P1 wave 表（W6-W12）

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W6 | ReplicatedState<T> 原语 | pending | — | 依赖 W3/W4（已满足） |
| W7 | label/thinkingLevel/modelId 三实例 + 失效接线 | pending | — | 依赖 W6 |
| W8 | usage/queue/commands 三实例 + 频率量化 | pending | — | 依赖 W6，W7 后串行（共享 session-service） |
| W9 | 删除 sessionMetaCache | pending | — | 依赖 W7 |
| W10 | applyContextUpdate 收编 + switchModel 入 owner | pending | — | 依赖 W8 |
| W11 | 非活跃 rename 短命 pi + 直写全删 + R1 allowlist 清空 | pending | — | 依赖 W1/W3/W6 |
| W12 | 5 个 state 话题切实例快照发布 | pending | — | 依赖 W7/W8；5 话题各独立 commit |

## P2 wave 表（W13-W15）

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W13 | session store applySnapshot 单入口 + DTO | pending | — | 依赖 W12 |
| W14 | pendingBuffer 计数 FIFO | pending | — | 依赖 W8/W12；与 W13 可并行 |
| W15 | scannedToSummary 空值守卫 | pending | — | 依赖 W13 |

## P3 wave 表（W16-W21）

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W16 | subagent 扩展自描述 appendEntry | pending | — | 依赖 W2/W5（已满足），可与 P1 并行 |
| W17 | workflow 自描述收敛 | pending | — | 依赖 W16 |
| W18 | runtime 消费管线（entry_appended + get_entries） | pending | — | 依赖 W12/W16/W17 |
| W19 | session_end sidecar 登记收口 | pending | — | 依赖 W2/W11；小 wave |
| W20 | applyEntry reducer + 文件重放喂入 | pending | — | 依赖 W5（已满足）；禁与 W13/W14 并行 |
| W21 | 实时 feed 喂入 + 等价性断言升级 | pending | — | 依赖 W20 |

## P4 wave 表（W22-W25）

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W22 | 等价性测试族全量化入 CI | pending | — | 依赖 W21 |
| W23 | ADR-0062 + ADR-0042 修订 + checklist | pending | — | 依赖 W11/W13/W18 |
| W24 | R2 调用图收紧 | pending | — | 依赖 W2/W13 |
| W25 | pi 升级契约测试 | pending | — | 依赖 W5/W21 |

## 里程碑 gate

| gate | 内容 | 状态 |
|------|------|------|
| P1 gate | 场景 1 后半（非活跃改名 + R1 归零）+ 场景 2 前半（断连自愈） | pending |
| P2 gate | 场景 2 后半（renderer 一致性） | pending |
| P3 gate | 场景 3（重开一致性）+ 场景 5（subagent 单源 + 混沌） | pending |
| P4 gate | 全场景回归 + 预防机制终态 | pending |

## 事件

- 2026-08-19 P1-P4 协调启动（用户指示「启动后续全部开发，仍然使用 cw-orchestrator 流程」）：读 plan 全 25 wave 详规 + 附录 A 路径核实；P0 已完成（五 wave + gate PASS，账本封存）。首波 W6 + W16 + W20 三并行（领地：runtime services/session/ 新增 vs extensions/subagent-workflow vs core domain/chat + runtime message-converter，互不相交）。账本 + 三份验收基线入 git。
