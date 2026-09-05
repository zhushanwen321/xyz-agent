# 对抗式审查报告（r4 末轮复审）：subagent-post-convergence-architecture.md

> 审查对象：`docs/design/subagent-post-convergence-architecture.md`（r3 修订版，2026-09-03）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（P0/P1 清单）
> 本轮范围：①r3 must-fix（D9 根治）修复成立性；②三个指定攻击点（globalThis 化连带 / runtime 单源 / 子入口残留全文扫）；③四组交叉引用终检。

## Summary

**1 must-fix, 0 suggestions**——未达「设计就绪」，但阻塞项是 r3 修订自身的两处机械残留（修复各一行，修完即可宣布就绪，无需再走审查轮）。

r3 的根治方案本身全部成立：取消 2 条新增子入口改 runtime 归一 barrel（消解新分裂面于源头）、configuredHost/notify-ports globalThis 化（与单例访问器既有范式一致）、静态门按真实状态清单重写。三个指定攻击点中两个无击穿、一个（残留扫描）命中：**被 D3 正式否决的「session-view 2 条子入口」方案仍活跃存在于 §1 out-of-scope ⑥ 与 §5 依赖图**——与终态裁决矛盾的双声明并存，构成对 impl-plan 编写者的矛盾指令。

## 上轮 must-fix 修复状态

| 上轮 | 修复状态 | 判定 |
|------|---------|------|
| MF D9「盘点为无」事实错误 | **根治成立**：①取消 2 条新增子入口、runtime 归一 barrel（B-2/D3/B-V1/B-V2/u-2 表格四处一致改判，D3 被否谱系补登否决理由）；②configuredHost/notify-ports 配置态 globalThis 化进 u-2 文件地图；③静态门按 7 处真实清单重写（globalThis 化或单入口消费路径逐个确认）；④zsw vendor 双入口消费核对 ⛔ 待验证登记 | 通过（残留两处见唯一 MF） |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §1 out-of-scope ⑥（:43）/ §5 实施顺序图（:236） | P0-11（文档内决策矛盾） | **被 D3 否决的方案仍以活跃声明存在，与终态直接矛盾**：① out-of-scope ⑥「本轮仅补 2 条 package.json 子入口声明（见 §3.2 B-2），runtime 代码零改动」——与 B-2/D3 终态（**不新增任何子入口**、runtime 2 处 import 行归一 barrel）相反，且「runtime 代码零改动」与 B-2「runtime 代码仅改 import 行」互斥；② §5 依赖图 u-2 节点「barrel扩面+import归一+**2子入口+tsup entry**+壳测试alias」——r2 版残留，与同节 u-2 表格行（无子入口、无 tsup.config.ts、含 globalThis 化）自相矛盾。out-of-scope 是读者最先接触的范围声明、依赖图是 impl-plan 展开的纲——两处都会向下一层传递已被否决的方案指令（依赖图版本会重新引入 host-services 副本分裂面，正是 r3 根治要消灭的） | ① out-of-scope ⑥ 改为「runtime 仅 2 处 import 行归一 barrel（见 §3.2 B-2），无新增子入口」；② §5 依赖图 u-2 节点改为「barrel扩面+import归一+配置态globalThis化+壳测试alias」——两行修订后本文档即可宣布就绪，无需再走审查轮 |

## 指定攻击点核验记录

**攻击 ①（configuredHost globalThis 化的连带冲突）——无击穿**：
- `core_host_not_configured` 语义不受影响：globalThis slot 缺席 ≡ 未配置，抛错条件不变；
- 测试断言形态安全：resetCoreForTests/resetNotifyDomainForTests 的 5 个消费测试（host-services.test.ts / notify-ports.test.ts / logger.test.ts / skill-discovery.test.ts / subprocess-agent-runner.test.ts）全部经公开函数（configureCore/reset/getLogger）断言行为，无模块级 let 直连断言；
- 跨测试文件隔离：core vitest.config.ts 未改 isolate（默认 true，每文件独立运行环境），globalThis 化不引入跨文件配置态泄漏；
- 实施连带提示（随 MF 修复一并落）：resetCoreForTests/resetNotifyDomainForTests 实现需同步改为清 globalThis slot（u-2 文件地图已含两文件）。

**攻击 ②（runtime 归一 barrel 是否等价单源）——成立**：
- 开发形态：runtime tsx 直跑 src，`@zhushanwen/subagent-core` 主入口经 exports `.` 的 import 条件指向 `src/index.ts`——workspace 单源，无 bundle 分裂；
- 打包形态：`packages/runtime/tsup.config.ts:47` noExternal 已含 `@zhushanwen/subagent-core`——barrel 顶层 import 连同闭包打进 runtime bundle 单份；
- typecheck：runtime tsc 走 exports 解析主入口（`./*` 通配删除后深路径不可达，barrel 顶层可达），B-V1 的「现有 4 条」断言与 package.json 实测一致。

**攻击 ③（子入口/tsup entry 残留全文扫）——命中两处**（即唯一 MF）：§1 out-of-scope ⑥（:43）与 §5 依赖图（:236）。其余命中项（B-2 :125、D3 :192）为被否谱系的合法记录，非残留；B-V1/B-V2/D9/u-2 表格/B-3/§3.5/A-V1b 全部确认干净。

## 交叉引用一致性终检

| 联动 | 判定 |
|------|------|
| B-2 ↔ D3 ↔ B-V1 ↔ B-V2 ↔ u-2 表格 | **一致**（无新子入口 + globalThis 化 + alias + 静态门，五处对齐） |
| D9 ↔ B-2 静态门 ↔ B-V2 | **一致**（真实 7 处清单 + 静态门三件套 + zsw ⛔ 核对） |
| §3.1 ↔ D8 ↔ A-V1b ↔ u-4 | **一致**（init 无条件 + /new 形态 + XYZ_AGENT_DEBUG 锚点） |
| B-3 ↔ D6 ↔ §3.5 ↔ §5 空洞声明 | **一致**（撤销谱系完整） |
| §1 一句话结论 / SCQA-A / §3.2 组标题 | **一致**（三组五项口径，r3 残留已清） |
| §1 out-of-scope ⑥ / §5 依赖图 ↔ B-2/D3 | **矛盾**（唯一 MF） |

## 源码证据索引（本轮新增）

- `packages/subagent-core/vitest.config.ts`（无 isolate 配置，默认 true）
- `packages/subagent-core/src/core/{host-services,notify-ports}.test.ts` 等 5 文件（reset 消费形态经公开函数）
- `packages/runtime/tsup.config.ts:47`（noExternal 含 `@zhushanwen/subagent-core`）；`:87`（zcode/reader 子入口既有消费，4 条保留不受影响）
- 文档 `:43` / `:236`（两处残留位置）；`:125` / `:192`（被否谱系合法记录）
