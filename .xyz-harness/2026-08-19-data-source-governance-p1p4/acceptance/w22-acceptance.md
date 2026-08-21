# W22 验收标准：等价性测试族全量化入 CI

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §6 W22 节（L676-698）是 W22 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W21（断言对象全部就位）。
> **W21 定案联动**：store 纯累积（ref 与 reducer state 的收敛对账归本 wave）——broadcast≡get_state 用例覆盖「事件风暴后实例快照 + stateSnapshot 广播 == pi 快照」；ref 收敛对账若 W21 遗留为 overlay 态，本 wave 用例断言 reducer state（权威镜像）而非 messages ref，ref 收敛的残余风险在报告如实标注。

## 目标（一句话）

`broadcast ≡ get_state` 与混沌注入用例全量化并接入常规 CI 运行路径（G3 长期回归基线）。

## 交付物

1. `packages/runtime/src/__tests__/equivalence/broadcast-getstate.test.ts` [新增]：fixture 发事件风暴（多轮对话 + 切模型 + 队列操作），断言实例快照 + stateSnapshot 广播内容 == get_state + get_session_stats + get_commands 逐字段
2. `packages/runtime/src/__tests__/equivalence/chaos.test.ts` [新增]：混沌三态（乱序——打乱非 streaming 事件顺序 / 丢失——拦截不下发 / 重放——同事件发两次）每种 ≥1 用例，全部断言收敛到权威快照
3. `packages/runtime/package.json`（修改：确认 `pnpm test` 覆盖 equivalence 目录——以 vitest.config.ts include 现状为准，已覆盖则仅加 script 别名）+ CI 接线：read `.github/workflows/` 现状后确认 runtime 测试步骤会执行 equivalence（引用行号汇报）
4. fixture 进程复用（总时长 <120s——逐用例 spawn 会超时）

## 通过命令（builder 自验 + verifier 实跑）

1. `cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` 全绿且用例总数 ≥ W21 末尾 +4；CI workflow 文件行号引用证明覆盖
2. 反证断言：临时破坏一个用例断言（比较对象加快照偏移）→ 红 → 还原绿
3. 回归：RUNTIME_TEST 全量绿；equivalence 总时长 <120s
4. pi 缺席环境 skip 语义沿用 W5 净新增约定（describe.skipIf(!PI_PATH)）

## 禁改清单

- 验收权威文档；登记表；W21 领地（生产代码——本 wave 只加测试与 CI 配置，**若发现需要改生产代码 = 规格冲突上报**）；extensions；六实例
- 禁 git 写操作；禁 mock pi；禁 any

## 备注

- 完成后 W25 解锁（契约测试同目录）。
