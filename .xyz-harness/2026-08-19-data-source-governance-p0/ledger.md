# data-source-governance P0 状态账本

> 协调机制：cw-orchestrator（验收基线先行 + builder/verifier 三方制衡，主 agent 只协调不执行编码）。
> 规格 SSOT = `docs/architecture/data-source-governance-plan.md` §2（W1-W5 节，行号以基线 commit 为准）；父文档 = `docs/architecture/data-source-governance.md`。
> 本账本只覆盖 P0（W1-W5 + P0 gate）；P1+ 波次不在本账本范围。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected（附失败报告，打回原 builder 修复后走针对性复审）。
> S1 语义层（review-data-governance agent）已在 pr-cr-fix 8 维上线（plan §0 备注），无 wave，不在此表。

## P0 wave 表

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W1 | 活跃 session label 直写全量切 set_session_name RPC（含 tryPersistLabel 扩围删除） | building | 337a7c79d | 唯一已证实 bug，第一个 wave |
| W2 | 数据登记表初版（12 条 + 空值语义 + legacy 例外） | pending | — | 依赖 W1（legacy 例外以 W1 后现状为准） |
| W3 | R1：pi 文件直写 pre-commit 检查 | pending | — | 依赖 W2；与 W4/W5 可并行 |
| W4 | R2 骨架 + R3：taste-lint 两条规则 | pending | — | 依赖 W2 |
| W5 | 等价性测试骨架（pi fixture + live≡reload 雏形） | building | 337a7c79d | 无依赖，与 W1 并行派发 |

## P0 gate

| gate | 内容 | 状态 |
|------|------|------|
| P0 gate | 父文档场景 1 前半（真实环境手动命名不被覆盖）+ 场景 4（预防拦截三违规） | pending |

## 事件

- 2026-08-19 协调启动（定时任务触发）：read 治理文档三件（父文档/plan/review r2-r6 已核）+ plan §2 P0 详规；核实 W1-W5 产物均不存在（registry / check_pi_direct_write.py / taste-lint 两规则 / equivalence 目录 / rpc-client set_session_name 均无）→ 全量待执行，无既有 wave 进度可接续。首波 W1 + W5 并行（领地不相交：W1 = runtime services/infra + test/，W5 = runtime src/__tests__/equivalence/）。账本 + W1/W5 验收基线入 git。
- 2026-08-19 首波派发：W1 builder（worker）+ W5 builder（worker）后台并行。流水线重叠：W2 acceptance 预写 + 基线先行 commit（W2 派发仍等 W1 committed 解锁）。
