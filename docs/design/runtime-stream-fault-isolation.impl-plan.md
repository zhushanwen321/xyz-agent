# Runtime 流级故障隔离 实施计划
基线: 693afd4c5 | 来源设计: docs/design/runtime-stream-fault-isolation.md | 日期: 2026-09-04

> 执行方式说明（本计划特有）：设计所述实施已存在于工作区（未提交），经 3 轮对抗式审查核实与文档一致（报告 `.review/design-review-20260904-135803-r3.md`）。因此各 Unit 的「开发」= **验证工作区实物与设计一致 + 测试真实跑绿 + 按领地精确提交**，不重写代码；subagent 不修改任何 src/tests 内容，发现不一致走阶段 3 偏差流程上报。

## 0 章节映射
| 内容 | 本文实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（设计目标表 G1-G4 + Scope） |
| 终态/机制 | §3 解决方案（3.1 终态 / 3.3 决策 D1-D4）+ §2 现状与问题分析（逃逸路径 R1/R2/R4） |
| 验收场景表 | §4 验收（S1-S4 + 负面行为反向验证） |
| 下一层拆分 | §5 下一层拆分（U1-U5 状态表） |
| 待验证检查点 | §3.4 探针清单（P1-P7） |

## 1 目标快照（逐字摘录 §1）

使用者 = 在太极桌面端同时开多个 session 干活的开发者（用户），以及给 runtime 写代码的工程师（开发者）。

| # | 目标 | 使用者可见标准 |
|---|------|--------------|
| G1 | 已知流写逃逸路径全部堵在连接级 | 用户：某条 subagent 连接异常断开时，其他 session 的任务不中断、无「runtime 重启」提示 |
| G2 | 未知流级错误不再触发整机 shutdown | 用户：即使出现新的流错误形态，runtime 不重启，仅日志多一条 contained 记录 |
| G3 | 新增裸写点在提交前被拦截 | 开发者：写出无防护的 `conn.write` / 无 error listener 的 socket 接收 / 无吞咽的 readline 时，pre-commit 红 + 恢复指引 |
| G4 | 逻辑级异常维持整机快速恢复（既有能力，不回退） | 用户：runtime 真崩溃时仍自动重启并恢复 session 列表（既有 ~16s） |

Out-of-scope：per-session runtime 进程隔离（§3.2 方案 C，评估后否决）；Electron supervisor 重启策略改进；崩溃瞬间在途 turn 的数据保全（§5 残留观察项）；extension 侧（pi- 子进程内）同类加固。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| U1 源头修复 | relay-registry：writeFrame guard+try / endConn 替换 7 处裸 end / conn error listener / rl 吞转发 / child stdin write 防护 | packages/runtime/src/infra/relay/relay-registry.ts | 无 | plain | §3.4 P1/P2 ✅（半关闭容错 / RST 容错测试绿）；G1 |
| U2 同族修复 | rpc-client rl 吞转发；usage-stats rl 吞转发 + 单文件空分片降级 | packages/runtime/src/infra/pi/rpc-client.ts · packages/runtime/src/services/usage/usage-stats-service.ts | 无 | plain | §3.4 P5 ✅（usage 回归绿）；G2 |
| U3 运行时分级 | uncaught-policy 模块（SAFE_STREAM_ERROR_CODES 五码）+ index.ts handler 接入 | packages/runtime/src/infra/system/uncaught-policy.ts · packages/runtime/src/index.ts | 无 | plain | §3.4 P3 ✅（policy 4 用例绿）；G2 |
| U4 静态护栏 | 护栏脚本 + allowlist + CI invariant 接入（pre-commit 段在 .bare/hooks，不在 git 领地） | scripts/check-unsafe-stream-writes.mjs · scripts/check-unsafe-stream-writes.allowlist.txt · .github/workflows/ci.yml | 无 | plain | §3.4 P4/P7 ✅；G3 |
| U5 回归测试 | relay-registry 2 个事故用例 + uncaught-policy 4 用例 | packages/runtime/src/__tests__/infra/relay/relay-registry.test.ts · packages/runtime/src/__tests__/infra/system/uncaught-policy.test.ts | U1, U2, U3 | plain | 用例全绿且断言非恒真（审查 R1 轮已核实）；G1/G2 |

## 3 DAG 图

```mermaid
graph TD
    U1[U1 源头修复] --> U5[U5 回归测试]
    U2[U2 同族修复] --> U5
    U3[U3 运行时分级] --> U5
    U4[U4 静态护栏]
```

## 4 测试策略（命令从项目 AGENTS.md / 实际脚本读取）

- 增量（单元验证）：`cd packages/runtime && npx vitest run src/__tests__/infra/relay/relay-registry.test.ts src/__tests__/infra/system/uncaught-policy.test.ts` + usage 受影响测试（vitest 按路径实跑）；护栏 `node scripts/check-unsafe-stream-writes.mjs`
- 类型/lint：`cd packages/runtime && npx tsc --noEmit`；根 eslint `--max-warnings 0`（按改动路径）
- 全量（收尾，项目收尾场景）：`cd packages/runtime && npx vitest run`（runtime 包全量）
- 框架：vitest（项目红线：禁 node:test / tsx --test；配置在子包 vitest.config.ts，从子包目录运行）

## 5 合理偏差登记表

| # | Unit | 偏差内容 | 与设计的差异性质 | 登记依据 |
|---|------|----------|------------------|----------|
| 1 | U5 | RST 容错用例采用单元级 emit('error') 直验而非真实 RST（resetAndDestroy 仅支持 TCP，unix socket 环回无法模拟） | 忠实执行设计 P2「单元级」措辞，机制等价（not.toThrow + destroyed 双断言），注释如实标注局限 | 一致性审查 sa-bb568f32；无需文档同步 |
| 2 | U2 | usage-stats 空分片降级返回 skippedLines:0 / cwd:null 空分片并保留原 mtime/size 键 | 与 D3 文字逐字一致，与 readdir 失败容错语义对称，未引入新状态位 | 同上；无需文档同步 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| U1 | committed | 1 | 11f2f37bf；relay-registry 25 绿（P1/P2） |
| U2 | committed | 1 | 44b09f2f0；rpc-client-exit-multicast + usage equivalence 绿（P5） |
| U3 | committed | 1 | fdcd83d57；uncaught-policy 4 绿（P3） |
| U4 | committed | 1 | 5fb5ed597（脚本+allowlist）+ 5468f5d86（ci.yml）；护栏 253 文件绿（P4/P7） |
| U5 | committed | 1 | 09e478b7c；受影响面 49 绿 |

收尾全量（阶段 5 Gate A 证据）：runtime 包 vitest 400 文件 / 4374 用例全绿（168s，2026-09-04）；`tsc --noEmit` 通过；eslint 改动源码 0 warning。

## 7 残留风险与变更历史

- 残留风险（承设计 §5）：① S1 真机验收为发版后门（⛔，降级路径 P1/P2 + dev 手工复现）；② 崩溃窗口在途 turn 丢失（观察项）；③ extension 侧同族加固不在此期。
- 变更历史：
  - 2026-09-04 计划创建。校准说明：工作区实物先于本计划存在（实施先于流水线），按「状态恢复：无 committed 证据按 pending 重算」处理；U4 部分提交。设计审查证据：`.review/design-review-20260904-135803.md`（R1）/ `-r2.md`（R2）/ `-r3.md`（R3，must_fix==0）。
  - 2026-09-04 阶段 3 一致性审查（reviewer sa-bb568f32）：unreasonable 0 / doc_errors 1（§2.3 ④ 归属文件 relay-server → relay-registry，主 agent 已修设计文档）/ reasonable 2（入登记表 #1 #2）。清零，转阶段 5。
