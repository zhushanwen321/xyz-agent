# W25 验收标准：pi 升级契约测试接线

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §6 W25 节（L747-769）是 W25 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W5（fixture 基建）、W21（reducer/entry 形态定型）。
> **最后一个实现 wave——完成后全计划收官，进 P4 gate**。

## 目标（一句话）

pi 版本升级时自动跑协议契约测试（ADR-0037 exhaustive 检查复用 + 数据治理断言项），防上游事件语义漂移悄悄制造新分叉。

## 交付物

1. `packages/runtime/src/__tests__/equivalence/pi-protocol-contract.test.ts` [新增]，契约三断言：
   - ① RPC 命令面：set_session_name / get_state / get_session_stats / get_entries / get_commands 全部可调且返回 schema 兼容（exhaustive 检查对 reply 类型 union 穷举）
   - ② 事件面：本设计依赖的事件（session_info_changed / thinking_level_changed / queue_update / message_end / entry_appended（扩展路径））真实发射（fixture 触发实测）
   - ③ entry 面：get_entries 返回的 entry 类型 union 穷举覆盖 reducer 的 case（TS 编译期 exhaustive——tsc --noEmit 通过即证）
2. **D5 探针定论固化断言**：`entry_appended` 对 message entry **不发射**是当前契约——把「N 事件 0 条 entry_appended」固化为断言（上游若补发射此断言红 → 触发 W21 预留的换源适配，而非静默分叉）
3. 接线：pi 版本 bump 时（packages/runtime/package.json 的 @earendil-works/pi-coding-agent 依赖变更）CI 或本地脚本先跑本契约测试——read .github/workflows/ 与 scripts/ 现状后接线到既有版本 bump 检查链，**不新建独立流程**
4. 参考：docs/adr/0037-pi-protocol-real-contract.md（联合类型 exhaustive 检查现状——read 参考）

## 通过命令（builder 自验 + verifier 实跑）

1. `cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/pi-protocol-contract.test.ts` 绿；三断言齐且 entry 类型 exhaustive（tsc --noEmit 通过即证）
2. 反证（抓漂移能力）：本地临时 mock 一个事件名变更（或 fixture 拦截某事件）→ 契约测试红；还原绿
3. 回归：RUNTIME_TEST 全量绿；接线点改动不破坏既有 CI workflow（yaml 语法校验 `python3 -c "import yaml; ..."` 或 actionlint 过）

## 禁改清单

- 验收权威文档；登记表；生产代码（**发现需要改生产代码 = 规格冲突上报**）；extensions；六实例
- 禁 git 写操作；禁 mock pi（契约测试用真实 fixture；反证用例的临时 mock 用后还原）

## 备注

- 完成后全部 25 wave 收官 → P4 gate（全场景回归）→ 计划完成。
