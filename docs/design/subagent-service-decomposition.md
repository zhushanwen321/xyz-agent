# SubagentService 上帝类拆分

> **层声明**：结构设计层（重构方案）——当前层 = 聚合边界与迁移策略，下一层 = 可实施的抽取 PR 单元（§5）。零行为变化是本设计的硬约束。
> **前置依赖**：H1（chat 域统一）+ H2（workflow record 归位）先行落地后再拆——chat 域 16 方法族消亡、workflow record 进 store 后，类的职责形状才稳定，拆分只做一次不返工。
>
> **一句话结论**：3255 行 / 103 个类成员 / 19 个职责域的 `SubagentService` 按 4 个聚合拆分（SessionBaselines / SyncCollectDomain / RecordLifecycle / RunOrchestration），原类退化为装配壳（目标 ≤ 500 行）；strangler 式逐聚合抽取，每步全绿、对外 API（`SubagentQueries` / `SubagentChatActions` 聚合面）不变。

---

## 1. 背景目标

### 1.1 SCQA

- **S**：`packages/subagent-core/src/execution/subagent-service.ts` 是 subagent 子系统的编排核——3255 行、103 个类成员，单类同时承担 19 个职责域（§2.1 全表）。
- **C**：约 30 个可变实例字段互相咬合（notifyHost / collectCoordinator / coldResurrectDeps / roundSupervisor / manifestStore / recordsDir…），改任何一个域都要面对整个类的字段面；AI 导航与人工审查 alike 的理解成本都随域数超线性增长；「改 chat 域必须通读引擎编排」是日常。
- **Q**：如何在零行为变化前提下把它拆成可独立理解/测试/演进的单元？
- **A**：按职责域自然分组拆 4 聚合 + 装配壳，strangler 式迁移。

### 1.2 系统是什么（受众认知铺垫）

SubagentService 跑在宿主 pi 主进程内（extension 加载），是 subagent 工具六个 action（start/list/cancel/message/close/fork-from）与 workflow AgentRunner 的统一编排层：创建/管理 ExecutionRecord（record 注册表）、派发引擎任务、维护会话身份基线（哪个主会话、fork 深度）、回收资源、装配通知。它对外已有两个窄接口投影（`SubagentQueries` :134 / `SubagentChatActions` :151）——**拆分的对外形状已经存在**，缺的是内部边界。

### 1.3 设计目标

- **G1 尺寸与聚焦**：单文件 ≤ 600 行；每聚合单一职责域族；改一个域不再通读其余。
- **G2 依赖单向显式**：壳组合聚合；聚合间禁止互调私有方法（需要协作的经壳编排或显式接口）；字段所有权单一（单写者）。
- **G3 测试随聚合迁移**：每聚合自持测试面；God-class 级测试拆散归属。
- **G4 零行为变化**：纯结构重构；58k 行既有测试全绿是每步合并门槛。

### 1.4 in / out scope

**in**：subagent-service.ts 的内部拆分；关联测试文件迁移；导出面（index.ts barrel）保持不变。
**out**：任何行为/语义变化（含日志文案）；跨模块的搬迁（record-store / notifier 等已是独立模块不动）；H1/H2/H4 的改动内容。

---

## 2. 现状与问题分析

### 2.1 十九职责域全表（行号为 2026-09-10 L 批次后基线，区间有 ±23 漂移）

| # | 域 | 代表方法 | 行区间 |
|---|-----|---------|--------|
| 0 | 对外面声明 | SubagentQueries / SubagentChatActions | 131–158 |
| 1 | 依赖装配 | constructor + ~30 字段 | 306–573 |
| 2 | session 注入 + ALS/嵌套身份基线 | initSession / initForkDepthBaseline / initExecContextBaseline | 574–691 |
| 3 | 孤儿/manifest 恢复 | recoverOrphansIfRootProcess / recoverOrphanRecords / recoverManifestTmpFiles | 692–757 |
| 4 | 回收面（fork/new/dispose/GC timer） | disposeAllRecords / onParentFork / onParentNew / startGcTimer / dispose | 758–846, 1096–1197 |
| 5 | sync 批（E9/E1） | getCollectSyncBudget / markMembersBatchFinalized / recoverSyncCollectBatch / armSettledRescan ×9 | 847–1095 |
| 6 | model 解析 | resolveModel | ~1200 |
| 7 | run 域执行入口 | execute | ~1215 |
| 8 | 查询面 | findRecord / lookupRecordAnyState / onChange / collectRecords / getFullRecord ×7 | 1282–1344, 1919–1968 |
| 9 | chat 域投递/冷续/看门狗 | deliverChatMessage / resumeColdRound / onHotPathSettledWatchdogTimeout | **H1 后消亡** |
| 10 | action 网关 | getRecordForAction | 1616–1673 |
| 11 | close 三路 | closeSubagent / closeChatIdle / closeAfterRoundSettled | 1674–1814（chat 分路 H1 后消亡） |
| 12 | await 入口 | executeAndAwait | 1815–1918 |
| 13 | 身份解析/record 创建 | resolveIdentity ×2 / createRecordForMode / buildEarlyFailedHandle | 1969–2119 |
| 14 | 引擎编排（run 域） | executeViaEngine / kickOffEngineRun / runEngineTask / adoptResumable / finalizeEngineOutcome / runAndFinalize ×10 | 2120–2560 |
| 15 | pool/worktree 资源 | acquirePoolOrFinalize / resolveWorktreeHandle / releaseRoundResources | 2561–2595 |
| 16 | chat spawn/轮次生命周期 ×13 | kickOffChatRound / handleChatRoundPhase / armChatIdleTimer ×13 | **H1 后消亡**（H1 保留其派发主干并归入 Continuation） |
| 17 | 取消 | cancelBackground | ~3030 |
| 18 | finalize 簇 | finalizeRecord / finalizeFailed / finalizeAborted | 3081–3172 |

H1 落地后 #9/#16 整族与 #11 的 chat 分路消亡（净缩约 600-800 行）；H2 落地后 #14 增 `executeWorkflowAgent` 入口、#8 查询面增 origin 过滤——**拆分在 H1/H2 之后做，剩余约 14 个域**。

### 2.2 痛点（实例）

1. 字段咬合：sync 批恢复（#5）依赖 dispose 状态（#4）与 store 写入（#3）；chat 投递（#9）依赖身份解析（#13）与引擎编排（#14）——改任一处需通读全部。
2. 测试定位难：God-class 级测试文件按场景而非域组织，回归定位要跨文件。
3. AI 导航差：103 成员无分区导航，模型每次理解成本高（本仓 AI 开发为主 workflow，这是真实生产力成本）。

### 2.3 根因

历次功能按「往 God class 加一个方法」的局部最优累积（每单次都合理），从未做过结构性回收。对外窄接口（#0）先于内部边界存在——投影有了、本体没分。

---

## 3. 解决方案

### 3.1 终态结构

```
SubagentService（装配壳，目标 ≤ 500 行）
  ├─ 职责：组合根装配 / initSession·dispose 生命周期时序 / 断言 / 对外聚合面保持
  ├─ SessionBaselines     —— 域 #2：sessionId/sessionRootId/fork 深度 ALS/UI handler/
  │                          dialog 队列/isIdle（纯会话基线，无 record 知识）
  ├─ SyncCollectDomain    —— 域 #5：collectCoordinator 装配 + E9 转账 + E1 批恢复
  │                          （自闭合批语义）
  ├─ RecordLifecycle      —— 域 #3/#8/#10/#11/#13/#17/#18：注册/查询/action 网关/
  │                          close 分流/finalize 簇/孤儿恢复/GC/cancel/身份解析
  │                          （record 状态机的唯一所有者；与 H4 的写入口收口同轴）
  ├─ RunOrchestration     —— 域 #6/#7/#12/#14/#15：model 解析/execute/await/
  │                          引擎 kick-off/adopt/finalizeEngineOutcome/pool/worktree
  └─（H1 已立的 ConversationContinuation 与 H2 的 executeWorkflowAgent 归
     RunOrchestration 协作面）
```

### 3.2 多方案对比

| 方案 | 长期合理性 | 短期成本 | 风险 | 判定 |
|------|-----------|---------|------|------|
| **A. 四聚合 strangler 渐进抽取** | 高：边界沿既有域缝，对外形状不变；每步可回滚 | 中：4-5 个 PR 分批 | 低：每步全绿门槛 | **选定** |
| B. 一次性大爆炸重写到新文件再切换 | 中：边界同 A | 低（单 PR）但审查不可行 | 高：3000+ 行 diff 不可审，行为漂移不可见 | 否——违反「打包子系统改动逐个 commit 逐个验证」的项目教训 |
| C. 不拆，仅加分区注释与导航标记 | 低：字段咬合与测试组织问题原样 | 极低 | 无行为风险但零结构收益 | 否——治标，三个月后仍想拆 |

### 3.3 关键决策

- **D1 聚合边界按「字段所有权」切**：每个可变字段归唯一聚合（首个系统性写它的域所属）；跨聚合读经显式 getter。**被否**：按用例切（use-case 分解会产生大量传参与共享状态复制）。
- **D2 抽取顺序按依赖最少先**：SessionBaselines（几乎零依赖）→ SyncCollectDomain（依赖 store 注入）→ RecordLifecycle（依赖 store/notify）→ RunOrchestration（依赖前三者）。每聚合一个 PR，抽取后原类委托转发（对外方法签名不变），最后一步删转发。
- **D3 对外 API 冻结**：`SubagentQueries`/`SubagentChatActions` 与 barrel 导出签名不变；extension/runtime 消费方零改动。
- **D4 协作规则**：聚合间禁止互调私有方法；需要跨聚合编排的场景（如 close = cancel + finalize）留在壳层编排或经显式接口。
- **D5 H4 同轴预告**：RecordLifecycle 聚合的接口面即 H4「意图级写操作」的落点——本设计只搬不改，H4 在其上收口持久化。

### 3.4 风险与守门

1. 行为漂移：每 PR 全量测试 + diff 逐行审查（搬运不得夹带改写；确需微调的单独标注）。
2. 字段撕扯：归属争议字段暂留壳层并标注 `// owner: pending R?`，最终 PR 清零。
3. 循环依赖：聚合间 import 必须无环（lint 守卫已有同款 services 循环依赖检查可参照）。

---

## 4. 验收（真实场景 + 硬指标；回溯目标）

| # | 场景/指标 | 步骤 | 通过标准 | 回溯 |
|---|----------|------|---------|------|
| S1 | 全功能回归（真实 GUI + 真实 LLM） | 派 one-shot subagent / chat 续聊两轮（H1 后形态）/ 跑一个 workflow / close 在途 / 重启宿主 | 五条链路行为与拆分前逐项一致（通知/结果/恢复/列表投影） | G4 |
| S2 | 尺寸硬指标 | `wc -l` 各文件 | 壳 ≤ 500 行；每聚合 ≤ 600 行；单类成员数 ≤ 40 | G1 |
| S3 | 依赖单向 | 聚合 import 图 | 无环；聚合间无私有方法互调（grep 守卫可机械检查） | G2 |
| S4 | 测试随迁 | 测试文件清单 | 每聚合至少一个同名域测试文件；God-class 级场景测试归壳层集成测试 | G3 |
| S5 | 全量测试 | 四包 + extension 三连 | 全绿（行为零变化的机器证据） | G4 |

---

## 5. 下一层拆分（PR 单元）

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| R0 | 壳内分区整理：按 §2.1 域重排成员 + 分区注释（纯移动零抽取） | 给后续抽取建立物理锚点，diff 可机械核对 | 全量测试绿 |
| R1 | 抽取 SessionBaselines | 依赖最少先行，模式打样 | S2/S5 |
| R2 | 抽取 SyncCollectDomain | 自闭合批语义，注入面窄 | S2/S5 + sync 批恢复用例 |
| R3 | 抽取 RecordLifecycle | record 状态机最大聚合；与既有 record-store/finalize-record 协作面理顺 | S2/S5 + S1 的 close/重启链路 |
| R4 | 抽取 RunOrchestration + 删壳内转发 | 依赖前三者最后抽；转发清理收尾 | S2/S3/S5 |
| R5 | 测试归位 + 守卫（循环依赖/私有互调 grep 门） | G2/G3 的机械守门 | S3/S4 |

**文件改动地图**：`execution/subagent-service.ts`（缩为壳）；新增 `execution/service/{session-baselines,sync-collect-domain,record-lifecycle,run-orchestration}.ts`（命名建议新增，实施可调）；`execution/__tests__/` 对应迁移；barrel 与消费方零改动。

**待验证检查点**：① #5 域与 collect-coordinator 的注入闭包拆分点（flushBatch 依赖 service 闭包——抽取时改为显式依赖注入）；② #1 域 ~30 字段的逐个归属表（R0 时产出，作为 R1-R4 的实施依据）；③ dispose 时序在壳层的最终形态（四个聚合的 dispose 编排顺序与现状等价性）。

---

## 附：决策溯源

复杂度审查（2026-09-10）将上帝类列为最高可读性收益候选（A3）；用户裁定「H3 你来处理」，执行序定于 H1/H2 之后（chat 聚合消亡后再拆、范围更小）。拆分边界（四聚合）为建议新增命名，实施期可微调但须保持 §3.3 D1-D5 规则。
