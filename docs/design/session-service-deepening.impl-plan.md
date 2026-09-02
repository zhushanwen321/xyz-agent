# SessionService 深化重构 实施计划

基线: 4589d0262 | 来源设计: docs/design/session-service-deepening.md | 日期: 2026-09-02

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（1.3 设计目标 G1-G4 / 1.4 In scope · Out of scope） |
| 终态/机制 | §3 解决方案（3.1 终态模块地图 / 3.2 方案对比 / 3.3 关键决策 D1-D6 / 3.4 错误与恢复 / 3.5 探针清单 P1-P5） |
| 验收场景表 | §4 验收（4.1 Slice 级等价性验收 / 4.2 整体收口验收场景 A/B/C / 4.3 投入说明） |
| 下一层拆分 | §5 下一层拆分（S1-S6 slice 表 + 文件改动地图） |
| 待验证检查点 | §5 末「待验证检查点」（P2 耦合面 / sessions Map 读写点清单 / S6 残余域归属） |

高频引用的补充坐标（计划期实测）：

- 调用点矩阵（lifecycle 13 / dispatcher 6 / scanner 2 / interpreter 3 / handoff 1 / 共享 4）与销毁 9 步时序契约：§3.3 D2①/D2③。
- eslint max-lines override 块：`eslint.config.mjs:74-83`，files 列表含 event-adapter.ts / extension-service.ts / session-service.ts 三项——u-s6 只删第三项（D5：event-adapter 归 C2 候选收尾）。
- ISessionService（56 方法对外接口）：`packages/runtime/src/interfaces.ts:128`。
- ISessionServiceInternal 的 stub 消费面（u-s2 领地依据，grep 实测 16 文件）：定义 `services/session/session-internal.ts`；源侧 `session-service.ts` / `session-lifecycle.ts` / `message-dispatcher.ts` / `session-scanner.ts`（另 `types.ts:10` 仅注释提及）；测试侧 10 文件 = `src/__tests__/{message-dispatcher-bash-race, message-dispatcher-bash, message-dispatcher-compact, message-dispatcher-force-quit, session-lifecycle-options, session-scanner-source}.test.ts` + `services/session/__tests__/{session-lifecycle-create-label, session-lifecycle-rename-inactive, session-lifecycle-thinking}.test.ts` + `services/session/session-lifecycle-gate.test.ts`。
- P2 探针（计划期已完成）：`writeSegmentsMetadata` 方法体（session-service.ts:2381-2427）实测只用 getAttachmentsDir / node:fs / quarantineCorruptFile，零 `this.sessions` / `this.messageBus` / 子模块引用——**通过**，u-s1 三方法全迁。
- 设计引用行号抽查全部吻合（getTraceEntries:1206 / applyContextUpdate:1584 / initializeManagedSession:1916 / registerReplicatedStates:1993 / writeImage:2292 / writeSegmentsMetadata:2381；session-service.ts 现仍 2603 行，零偏移）。
- 设计第 4 轮审查（review.md）两条 SUGGESTION 经逐字核对已在提交版 4572778b9 落文（§3.1 地图行「销毁无 lifecycle 事件——编排 wrapper 在 session-service.ts」；D2③ 与 P4「订阅扇出不设异常隔离、异常直接传播（异常传播路径一致）」），无需实施期补做。

## 1 目标快照（逐字摘录自设计 §1.3 / §1.4）

- **G1 自然家**：新增一个 session 域功能时，存在明显的归属模块，不需要、也不被允许「顺手挂到 SessionService」。
- **G2 测试面收窄**：测 session 域任一概念，stub 面降到个位数方法；单域测试不再需要构造 Facade 全家桶。
- **G3 行为等价**：这是纯重构——renderer、pi、插件系统观察到的行为逐字节不变。
- **G4 不再复发**：拆解完成后有机器守卫阻止 Facade 重新膨胀。

**In scope**：`services/session/` 内 SessionService 与其子模块（lifecycle / dispatcher / scanner / interpreter / extractor 系）的边界归正与逐域迁出；`ISessionServiceInternal` 的 ISP 化；session-service.ts 的行数守卫恢复。

**Out of scope**：① 架构审查报告的其他候选（C2 EventAdapter 协议路由、C3 port 旁路、C4 JsonStore 收编、C5 transport handler 表驱动与胖接口拆分等）各自独立成文，本文只在决策衔接处标注交接点；② renderer 侧任何改动；③ IoC 容器（ADR-0001 明确禁止，不作为候选）。

## 2 单元列表

6 单元与设计 §5 的 6 slice 一对一映射；全链串行（所有 slice 共改 session-service.ts，无并行波次）。每单元一个独立 commit（设计 D6：独立交付、独立回滚）。

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|---|---|---|---|---|---|
| u-s1 | S1 附件存储迁出：writeImage / migrateImage / writeSegmentsMetadata 迁出为 attachment-store.ts，Facade 保留一行委托，测试随迁 | 新增 `packages/runtime/src/services/session/attachment-store.ts`；新增 `packages/runtime/src/services/session/__tests__/attachment-store.test.ts`；修改 `packages/runtime/src/services/session/session-service.ts` | — | plain | ① P2 已过（见 §0），三方法全迁，方法体内 eslint-disable 注释原样随迁 ② `cd packages/runtime && pnpm vitest run` 全绿（行为断言零修改 = P3）③ `pnpm typecheck` 绿 ④ attachment-store.test.ts 含边界用例：20MB 上限拒绝、路径穿越拒绝；其 import 不含 session-service ⑤ session-service.ts 行数 2603 → 约 2250（三方法约 350 行净迁出） |
| u-s2 | S2 接口 ISP 化：session-internal.ts 21 方法拆 lifecycle 13 / dispatcher 6 / scanner 2 三窄接口（跨消费者共享 4 方法重复声明、单一实现）；markHandedOff 迁 ISessionService（迁移非新增）；三子模块构造器收窄；stub 测试面收窄、`as unknown as` 强转消失；ISessionServiceInternal 删除 | 修改 `services/session/session-internal.ts`、`session-service.ts`、`session-lifecycle.ts`、`message-dispatcher.ts`、`session-scanner.ts`、`types.ts`（注释随迁）、`packages/runtime/src/interfaces.ts`（markHandedOff +1 行）；stub 测试 = src/__tests__ 6 文件 + services/session/ 4 文件（gate + create-label/rename-inactive/thinking）+ **test/ 目录 14 文件（偏差 #3 补全）** | u-s1 | plain | ① 三窄接口方法计数 13/6/2（接口体 grep 可验；共享 4 = detachSession / getSession / removeSessionEntry / getActiveSummaries）② `grep -r ISessionServiceInternal packages/` 为空（含注释与 re-export）③ `grep -r "as unknown as ISessionServiceInternal" packages/` 为空 ④ vitest 全绿 + typecheck 绿，行为断言零修改 ⑤ scanner 构造器类型可见面 = 2 方法 ⑥ handoff-service 零改动（绑具体类，设计 D2① 实证） |
| u-s3 | S3 写点归位：initializeManagedSession 迁 lifecycle（registerSession：session 对象构造 + sessions.set + onSessionRegistered 同步直发，订阅者组装根接线——S3 期 = Facade 按现状体内顺序 registerReplicatedStates → ensureRecordEntriesCache → reconciler）；sessions Map 所有权随迁 lifecycle；removeSessionEntry 编排权留 Facade wrapper（9 步时序契约，第 ② 步委托 lifecycle 纯删条目）；Facade 残余 ~30 处 `this.sessions` 读点改道 lifecycle 的 ISessionRegistry（Map 只读、元素视图可变语义） | 修改 `services/session/session-lifecycle.ts`、`session-service.ts`、`session-internal.ts`（+ISessionRegistry）；lifecycle 测试随迁/新建：`services/session/__tests__/session-lifecycle-*.test.ts`、`services/session/session-lifecycle-gate.test.ts`、`src/__tests__/session-lifecycle-options.test.ts` | u-s2 | plain | ① P4 探针：create/restore/fork 三路的 Map 注册、onSessionRegistered 扇出、notifySessionCreated 时序逐一一致且同步直发（异常传播路径一致：订阅扇出不设异常隔离）；销毁侧 9 步逐段比对（② 纯删条目；⑥ clearSession 垫底，:350 约束 session.exited publish 先于 clearSession）；destroyAll 不触发 dispose ② `grep -nE "sessions\.(set|delete|clear)" session-service.ts` 为空（写点全在 lifecycle）③ ISessionRegistry 无 set/delete/clear 声明 ④ vitest 全绿 + typecheck 绿，行为断言零修改 ⑤ registerSession 有 lifecycle 直接测试（gate 测试 stub 面 ≤13） |
| u-s4 | S4 trace 合并：Facade 编排半截（1206-1432）+ session-trace.ts 纯函数合并为 trace-sync.ts；补编排层直接测试（当前零覆盖） | 新增 `services/session/trace-sync.ts`、`services/session/__tests__/trace-sync.test.ts`；删除 `services/session/session-trace.ts`、`services/session/__tests__/session-trace.test.ts`（并入 trace-sync.test.ts）；修改 `services/session/__tests__/trace-parity.test.ts`、`services/session/__tests__/fetch-current-prompt.test.ts`（仅当其 import session-trace 需随迁）、`session-service.ts` | u-s3 | plain | ① session-trace.ts 消失，纯函数与编排半截同居 trace-sync.ts ② 编排层有直接测试覆盖（现状零覆盖，新增即达标）③ vitest 全绿 + typecheck 绿，行为断言零修改（trace-parity / trace 等价测试是现成行为守卫）④ session-service.ts 无 trace 编排残留（syncTraceEntries / pollOnceForPromptEntry / ensurePromptBaseline 等方法签名落位 trace-sync.ts） |
| u-s5 | S5 状态投影迁出：replicated states 快照族（1993-2197）+ context/usage 副作用域（applyContextUpdate:1584 / handleTurnEndSideEffects:1620 / fetchAndBroadcastContext:2271）迁 session-state-projection.ts；onSessionRegistered 订阅者从 Facade 换为 projection 模块自身；interpreter 消费的 3 方法（applyContextUpdate / handleTurnUsageSideEffects / handleTurnEndSideEffects）组合根接线随迁 | 新增 `services/session/session-state-projection.ts`、`services/session/__tests__/session-state-projection.test.ts`；修改 `services/session/session-service.ts`、`services/session/session-lifecycle.ts`（订阅接线换人）；组合根接线点以实施首步核验为准（设计 D2① 标注为 Facade 组合根接线面——event-interpreter.ts 本体预期不动，动到则上报）；`replicated-state.ts` / `replicated-states.config.ts` 仅当 import 需要随迁 | u-s3, u-s4 | plain | ① 快照投影族 + 副作用 3 方法实现落位 projection 模块，Facade 一行委托 ② onSessionRegistered 订阅者换为 projection 模块（S3 seam 的设计兑现，订阅体内顺序保持现状等价）③ vitest 全绿 + typecheck 绿，行为断言零修改 ④ projection 模块有直接测试 |
| u-s6 | S6 收尾：残余域（history 缓存族 / record 缓存族 / launch 参数组装 / 模型切换）逐域评估归属或留 Facade 并写明理由；移除 max-lines override 的 session-service.ts 项 | 修改 `packages/runtime/src/services/session/session-service.ts`、`eslint.config.mjs` | u-s4, u-s5 | plain | ① P5 探针：`wc -l session-service.ts` ≤ 500 ② `eslint.config.mjs` override（74-83 行块）files 列表删 session-service.ts 项、保留 event-adapter / extension-service 两项 ③ 根 `pnpm run lint` 绿 ④ vitest 全绿 + typecheck 绿 ⑤ 残余域评估结论逐域落档本计划 §7（迁出 or 留下 + 理由，依据设计检查点 3 不预判） |

执行注记：u-s2 领地 17 文件超出单次 subtask ≤5 文件约束，派发时拆连续 sub-dispatch（源侧收窄 6 文件 → stub 迁移 10 文件分两批），全部完成后按单元整体一个 commit。其余单元单次派发可覆盖。

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U1["u-s1 附件存储迁出<br/>领地: attachment-store.ts(新) + test(新) + session-service.ts"]
  end
  subgraph W2[Wave2]
    U2["u-s2 接口 ISP 化<br/>领地: session-internal.ts + 3 子模块 + interfaces.ts + 10 stub 测试"]
  end
  subgraph W3[Wave3]
    U3["u-s3 写点归位<br/>领地: session-lifecycle.ts + session-service.ts + session-internal.ts + lifecycle 测试"]
  end
  subgraph W4[Wave4]
    U4["u-s4 trace 合并<br/>领地: trace-sync.ts(新) + session-trace.ts(删) + session-service.ts + trace 测试"]
  end
  subgraph W5[Wave5]
    U5["u-s5 状态投影迁出<br/>领地: session-state-projection.ts(新) + session-service.ts + 订阅接线"]
  end
  subgraph W6[Wave6]
    U6["u-s6 收尾守卫<br/>领地: session-service.ts + eslint.config.mjs"]
  end
  U1 -->|"同文件共改 session-service.ts"| U2
  U2 -->|"写点归位依赖窄接口已立 + markHandedOff 已迁"| U3
  U3 -->|"同文件共改 + trace 域读点先经 Registry 归位再合并"| U4
  U3 -->|"订阅者换人依赖 S3 的 onSessionRegistered seam"| U5
  U4 -->|"同文件共改 session-service.ts"| U5
  U4 -->|"收尾需全部迁出完成"| U6
  U5 -->|"收尾需全部迁出完成"| U6
```

- **全链串行**：6 slice 全部共改 session-service.ts（设计 D6 本就按独立交付排序），无并行波次。
- **u-foundation 缺席说明**：共享契约（session-internal.ts）的整形发生在 u-s2（链上第 2 节点、先于全部消费者单元），不存在需要先于一切单元建立的独立类型模块，故不单设。
- **worktree 决策**：全部 plain。判据（references/dag-authoring.md 决策表）：本分支 refactor-runtime-architecture 为本次重构专用分支、单元全串行无写冲突面、无实验性整体废弃风险（每 slice 独立 commit 回滚即等价物）。

## 4 测试策略

命令实读自 `packages/runtime/package.json` scripts 与项目 AGENTS.md：

- **增量**（单元开发期，dev subagent 自跑）：`cd packages/runtime && pnpm vitest run <受影响测试路径>`；类型改动伴跑 `pnpm typecheck`。
- **单元门**（每 slice commit 前，主 agent 核验重跑）：`cd packages/runtime && pnpm vitest run`（runtime 全量 = P3 探针「行为断言不修改而通过」）+ `pnpm typecheck`。
- **收尾门**（u-s6 与阶段 5 Gate A）：`cd packages/runtime && pnpm vitest run` + `pnpm typecheck` + 根 `pnpm run lint`（max-lines 守卫在根 eslint 配置）。
- **真实场景验收**（阶段 5 Gate B，剧本 = 设计 §4.1 + §4.2 场景 A/B/C + 待验证检查点回填）：`pnpm dev` 真实 app 双分支行为比对（新建 → 发消息 → 发图 → fork → 关闭重开 → 删除；S1 含图片落盘与 landing 降级专项）；场景 C 负向守卫验证（50 行无关注释被 pre-commit 拦截）。
- 框架红线：vitest（禁 `node:test` / `tsx --test`）；timer 测试用 fake timers；行为断言零修改是 P3 的定义——stub 类型引用与 stub 成员面允许随接口拆分随迁（设计 P3 措辞）。

## 5 合理偏差登记表

| # | 偏差 | 理由 | 登记时间 |
|---|---|---|---|
| 1 | 设计 §4.1 要求「每 slice 真实 app 双分支比对」；本计划落为每 slice P3 机器门（runtime 全量 vitest + typecheck）+ 阶段 5 Gate B 统一执行 §4.1/§4.2 全部真实场景（含 S1 附件 landing 降级专项） | 每 slice 一次 Electron 双分支比对 = 12 次全量 app 实跑；slice 均独立 commit，Gate B 场景 fail 可 revert 精确定位到 slice，回滚粒度不变。风险：slice 间交互引入的偏移到 Gate B 才暴露——由全量套件 + 独立 commit 兜底（用户已确认接受） | 计划期 |
| 2 | 设计 §2.1/D1 预估附件域「约 310 行 / 12%」、计划验收条款 ⑤ 据此写「2603 → 约 2250」；u-s1 实测三方法合计约 148 行 + formatTimestamp 辅助 8 行，2603 → 2467（净 -136，含委托/接线 +18） | 原预估系 2292→EOF 区域口径，含 history 域读侧 readSegmentsMetadataFile（被 :982/:1017 消费，不属附件域不可迁）与尾部辅助代码。三方法全迁事实成立（方法体逐字随迁、一行委托、契约不变），S6 ≤500 行目标不受影响。设计文档 §2.1/D1 已同步修正（doc_error 处理） | u-s1 交付 |
| 3 | u-s2 领地最初只枚举 src/ 下 10 个 stub 文件；批 2 后全量 grep 发现 packages/runtime/test/ 目录另有 14 个 stub 文件（contract-hardening / dispatcher-bus / fork-orphan-cleanup / message-dispatcher-precheck / message-dispatcher-silent-abort-destroy / runtime-wiring / session-lifecycle-attach / session-lifecycle-deletebycwd / session-lifecycle-preset / session-lifecycle-rename / session-lifecycle-w11 / session-lifecycle-w5 / session-lifecycle / session-scanner-preset） | 计划期 grep 范围漏扫 test/ 目录（枚举错误，非范围变更）——验收条款②「grep -r ISessionServiceInternal packages/ 为空」本就隐含要求这批文件清零；dev 按领地锁定上报后由主 agent 扩充领地。u-s2 领地已同步补全 | u-s2 批 2 后 |
| 4 | u-s3 波及 4 个领地外文件最小改动（13-25 行/文件）：test/contract-hardening（stub 删 initializeManagedSession + 构造第 6 参）、test/fork-orphan-cleanup（同前 + initFails 注入点迁 adapterFactory throw）、test/workspace-message-handler（2 处构造第 6 参）、__tests__/fetch-current-prompt（busy 注入原戳私有 sessions Map 强转路径，改真注册 + isGenerating 置位） | SessionLifecycle 构造器加 registerDeps 参 + ILifecycleSessionOps 移除 initializeManagedSession 的语言级波及，编译期必然；fetch-current-prompt 的「测试戳私有字段」路径不在计划期 grep（this.sessions 源码读点清单）覆盖面内——领地枚举缺口非范围变更。dev 上报 blockers 后主 agent 裁决批准，diff 逐文件核验为最小 | u-s3 交付 |
| 5 | u-s4 波及 1 个领地外文件 1 行：src/interfaces.ts:39 SessionTraceSnapshot type import 路径 session-trace → trace-sync | 删除 session-trace.ts 后该 type-only import 编译期必然断裂，不改动则 typecheck 必红，与验收 1/4 冲突；与偏差 #4 同类（编译期必然波及）。主 agent 复核 diff 仅一行路径替换后批准 | u-s4 交付 |
| 6 | u-s4 域内共享 helper isEntryNotFoundError 迁 trace-sync.ts 并 export（Facade history/record 域仍消费，经 import） | 该 helper 为 pi get_entries(since) 错误判定，非 trace 域独占；单一定义放 trace-sync + Facade import 优于 Facade 留副本（禁重复实现）；Facade→trace-sync 依赖方向已存在，无新增环 | u-s4 交付 |
| 7 | u-s4 未承接原 session-trace.test.ts 的 3 个 Facade 级集成用例（getTraceEntries WS reply 路由 ×2、switchModel/setThinkingLevel RPC 补拉 ×2——构造完整 Facade，与 G2「测试 import 不含 session-service」冲突） | 行为等价守护替代：实现逐字随迁（P3）+ trace-parity 现成守卫 + 新增 25 个编排层直测覆盖同一实现路径 + fetch-current-prompt.test.ts 零改动经 Facade 委托链路仍绿（fetchCurrentSystemPrompt 的 WS 链路守卫） | u-s4 交付 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|---|---|---|---|
| u-s1 | committed | 1 | 全量 vitest 383 files / 4103 tests passed exit 0（/tmp/u-s1-vitest-r2.log）+ typecheck 0；条款④实测通过（测试 import 无 session-service）；首次全量跑 pi-settings-store「busy-waits real subprocess」用例 1 次 fail，单跑 3/3 绿 + 文件零改动，判定环境 flake 非回归 |
| u-s2 | committed | 1 | 六批交付：源侧收窄（调用点矩阵实测 13/6/2 + 共享 4 对账 = 21）→ stub 迁移 24 测试文件（src/__tests__ 6 + test/ 14 + session 域 4）→ 宽接口删除 + markHandedOff 迁 ISessionService。单元门：全量 vitest 383/4103 绿 exit 0 + typecheck 0；条款②③ grep 全库归零（主 agent 独立复核）；gate 测试 stub 面 = 13 强转消失；handoff-service 零改动。消强转暴露并修复 6 处被掩盖的 stub 形状缺陷（均无行为断言消费） |
| u-s3 | committed | 1 | registerSession 迁入 lifecycle（含 sessions Map 所有权 3 写点 + onSessionRegistered 同步直发）+ ISessionRegistry 4 只读方法（get/has/keys/values）+ Facade 30 读点全改道（映射表落档，4 形态全覆盖无缺口）+ removeSessionEntry 9 步 wrapper（第②步委托 lifecycle 纯删）+ destroyAll 不引入 dispose。单元门：全量 384/4113 绿 exit 0 + typecheck 0；registerSession 直接测试 10 用例（含扇出异常传播/clear 无 dispose）；P4 自验全过、§3.4 降级未触发；偏差 #4（4 波及文件）批准 |
| u-s4 | committed | 1 | trace 域全族（8 方法 + traceLeafCache/traceSyncChains）+ session-trace.ts 纯函数合并 trace-sync.ts（461 行，<500 无需 override）；编排层直接测试 0→25 用例；Facade 三委托 + removeSessionEntry 第⑤步直调 onSessionDisposed；session-service.ts 2454→2217（-237）。单元门：384/4119 绿 + typecheck 0；trace-parity 断言零修改；trace-sync.test import 无 session-service（G2）。偏差 #5/#6/#7 登记（interfaces.ts 单行波及 / isEntryNotFoundError 共享 / 3 个 Facade 级集成用例以替代守卫不承接） |
| u-s5 | pending | 0 | — |
| u-s6 | pending | 0 | — |

## 7 残留风险与变更历史

- 2026-09-02 计划建立（预检：设计结构四节齐全；对抗式审查第 4 轮 0 must-fix，报告 `docs/design/session-service-deepening.review.md`；两条 suggestion 经核对已在提交版落文）。用户评审确认：切分/隔离/验收条款 + 偏差 #1。
- 2026-09-02 u-s1 committed：附件三方法 + formatTimestamp 迁 attachment-store.ts（187 行）+ 新测试 13 用例（含大小上限/路径穿越边界）；Facade 一行委托；2603 → 2467。偏差 #2 登记，设计 §2.1/D1 行数口径同步修正。
- 2026-09-02 u-s2 committed（六批）：ISessionServiceInternal 21 方法拆 ILifecycleSessionOps 13 / IDispatcherSessionOps 6 / IScannerSessionOps 2（共享 4 重复声明单一实现；fetchAndBroadcastContext 按调用点实测归 lifecycle，与设计被否谱系预言一致）；markHandedOff 迁 ISessionService（迁移非新增）；24 个 stub 测试文件迁移、`as unknown as ISessionServiceInternal` 全库清零、gate 测试强转消失（stub 面 13）。偏差 #3（test/ 目录领地缺口）批 2 后补登。消强转连带暴露 6 处 stub 形状缺陷（async 签名/必填字段），typecheck 修复、无行为断言消费。
- 2026-09-02 u-s3 committed：写点归位落地（设计 §3.4 半深化降级未触发）。registerSession 自 Facade 逐字迁入 lifecycle + sessions Map 所有权（3 写点）；onSessionRegistered 同步直发（Facade 订阅接线，体内顺序与现状逐一等价，扇出不设异常隔离）；ISessionRegistry 只读 4 方法，Facade 30 读点全改道（检查点 2 回填：get 20 / has 6 / keys 1 / values 3，无缺口）；removeSessionEntry 9 步 wrapper 保持（第②步委托 lifecycle 纯删，clearSession 垫底）；destroyAll 不引入 dispose。ILifecycleSessionOps 13→12（initializeManagedSession 迁入后 lifecycle 内部直调）；Facade 保留 initializeManagedSession 一行委托（D3 形态，10+ 测试调用点零修改）。registerSession 直接测试新建 10 用例；4 处断言观察点随迁（语义等价，dev 逐条登记）。偏差 #4：4 个波及文件批准扩领地。session-service.ts 2467→2454。
- 2026-09-02 u-s4 committed：trace 域全族（getTraceEntries / syncTraceEntries / pollOnceForPromptEntry / ensurePromptBaseline / fetchCurrentSystemPrompt 等 8 方法 + traceLeafCache / traceSyncChains + onSessionDisposed 钩子）与 session-trace.ts 纯函数合并为 trace-sync.ts（461 行）；编排层直接测试 0→25 用例（G2：import 无 session-service）；trace-parity 仅 import 随迁、断言零修改；fetch-current-prompt 零改动经委托链路仍绿。session-service.ts 2454→2217。偏差 #5（interfaces.ts 单行 type import 波及）/#6（isEntryNotFoundError 单一定义放 trace-sync 供 Facade 消费）/#7（3 个 Facade 级集成用例以替代守卫不承接）登记。
- 残留风险追加：pi-settings-store.test.ts「busy-waits and acquires after a cross-process holder releases (real subprocess)」在全量并发下偶发 flake（u-s1 验收期观测 1 次；单跑 3/3 稳定绿、文件零改动、域无关）——后续单元门遇到同名失败按 flake 判定流程处理（单跑复验 + 文件零改动核对），不阻塞但计数。
- 风险预登记：
  - **u-s3 是设计认定风险最高一刀**（写点迁移 + 汇聚拆分 + 读点改道三位一体）。失败降级 = 设计 §3.4 末行半深化降级（写点留 Facade、窄接口成果保留）；若触发，u-s5 形态按设计 §3.4 降级分支调整并在此登记。
  - **u-s5 组合根接线点位置**实施首步核验（预期 Facade 内接线，event-interpreter 本体不动；动到即上报偏差）。
  - **S6 残余域归属**不预判（设计检查点 3），以 S1-S5 完成后实际行数构成决定。
  - **测试红 30 分钟定位不到** → 整体 revert 该 slice 回绿基线（设计 §3.4）；同单元 dev→fix 超 2 轮未绿 → 冻结升级用户（dev-flow 关键约束）。
