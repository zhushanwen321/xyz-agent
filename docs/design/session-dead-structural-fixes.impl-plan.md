# session-dead-structural-fixes 实施计划

基线: <待 commit 后回填> | 来源设计: docs/design/session-dead-structural-fixes.md | 日期: 2026-09-11

## 0 章节映射

| 内容 | 本文实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（1.3 设计目标 G1-G5；1.4 in/out scope） |
| 终态/机制 | §3 解决方案（3.1 终态 / 3.2 方案对比 / 3.3 决策 D1-D8 / 3.4 错误规格 / 3.5 探针清单） |
| 验收场景表 | §4 验收（4.2 场景表 V1-V8） |
| 下一层拆分 | §5 下一层拆分（PR 单元表 + 文件改动地图 + 待验证检查点） |
| 待验证检查点（无则记「无」） | §5 末段①-⑤（P-1 双场景实测 / P-2 复核 / 挂点 grep 复核 / 草稿合并细节 / L2 wire 形状——⑤ 属冻结的 u6，本轮不实施） |

## 1 目标快照（逐字摘录自设计文档 §1.3 / §1.4）

**设计目标**：
- **G1 状态不撒谎**：pi 在跑（无论是谁发起的）时，发送门、排队门、侧栏处处显示忙碌；pi 空闲时处处可发。同一件事任何两处显示不得相反。
- **G2 停止即停止**：forceQuit 后，任何机制（前端队列、extension 通知、定时任务、子代理回流）都不得让**被杀的旧执行**自动复活；排队未投的消息不丢失，交还用户处置。边界：子代理回流等**新信息送达**触发的处理 turn 不属于「旧执行复活」（L5 裁定）。
- **G3 恢复即干净**：重开 dead session 看到完整历史，不自动续跑旧 turn，可立即发新消息（同进程生命周期内；app 重启例外见 D4 被否栏，收敛环残余链例外见 D4 代价登记）。
- **G4 进展可见**：长 turn 进行中用户能看到「在做什么、多久了、产出了多少」，并可选择中止；等待用户输入（ask_user）时不被误报为停滞。
- **G5 零回归**：正常发消息 / bash / compact / handoff / subagent 投递（session_manager send / completion-backflow）行为不变；live≡reload 等价性测试套件保持全绿。

**Out of scope**：A 组三项止血（已落地 commit 5637e0088）；pi 本体修改与 provider 稳定性（C2）；subagent 域 record 模型与 chat 域统一（fix-subagent-no-notification 分支领地，仅 D8 对齐点）；任何形式的 turn 自动中止；C1 方案二（u6，被 P-3 实测阻塞，本轮冻结）。

**对抗式审查证据**：`.review/design-review-session-dead-r3.md`（must_fix=0）+ `.review/design-review-session-dead-r3-impact.md`（must_fix=0）；收敛轨迹 R1(2+3 MF) → R2(1+0 MF) → R3(0+0 MF)。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| u1a | D3：forceQuit 清 defer 队列回 Composer 草稿 + 提示（V1①② 前端部分） | `packages/core/src/domain/chat/useChat.ts`、`packages/renderer/src/composables/features/sidebar/useSidebarSessionActions.ts`、`packages/renderer/src/composables/panel/useCompactQueue.ts`、`packages/renderer/src/i18n/locales/zh-CN.ts`、`packages/renderer/src/i18n/locales/en-US.ts` | 无 | plain | ① core+renderer vitest 增量绿 + typecheck 绿；② 新增单测覆盖「forceQuit → 队列清空 + 草稿回收 + Composer 已有内容时追加」三行为；③ 设计 §4 V1② 的 DOM 断言（草稿可见 + 提示文案）落在组件/核心层测试 |
| u1b | D5①：kill 路径全量 warn 日志（K1/K2/K3/K5/K6/K7/K8 各源，含调用源与信号链） | `packages/runtime/src/services/session/message-dispatcher.ts`、`packages/runtime/src/services/session/session-lifecycle.ts`、`packages/runtime/src/infra/pi/process-manager.ts`、`packages/runtime/src/services/reap-orphan-pi.ts` | 无 | plain | ① runtime vitest 增量绿 + typecheck 绿；② 新增单测断言每条 kill 路径触发时 logger.warn 被调用且含 source 字段（7 路径各一断言）；③ grep 确认无残留未打日志的 forceQuitSession/destroy 调用点 |
| u2 | D4+D5②+D1/D2 基座：userStopped 标记（独立 Map 宿主）+ source 参数置位分型（K1/K2）+ restoreSession 返回前 abort + 收敛环（agent_start 拦截 + settled 静默窗）+ session.restore 短路复用 + `applySessionOccupancyTransition` 原语与封闭转移表（含 announce-idle 收编，走 state-topic 通路）+ registerSession 宣告帧改调 | `packages/runtime/src/services/session/message-dispatcher.ts`、`packages/runtime/src/services/session/session-lifecycle.ts`、`packages/runtime/src/services/session/session-service.ts`、`packages/runtime/src/services/session/event-interpreter.ts`、`packages/runtime/src/services/session/types.ts` | u1b | plain | ① runtime vitest 增量绿 + typecheck 绿；② 原语单测：转移表每行至少一断言（合并/派生/去重/announce-idle 强制广播）；③ 收敛环单测：abort→settled→补发→再 abort→静默窗→清标记序列 + 「settled 未到窗满不清」边界；④ 短路单测：client 活跃时 session.restore 不清场重开；⑤ 宣告帧回归：occupancy-runtime 测试 Part D 保持绿（重订阅回放必达） |
| u3b | B1 挂点迁移：14+ 挂点改调原语（interpreter #2-#6、dispatcher #1/#7-#9/#11、deliverText 置位、agent_end 副作用、onSessionExit 全复位、A1 拒绝反转→reject-processing）+ settling 预检裁决（计忙，拒绝入队） | `packages/runtime/src/services/session/event-interpreter.ts`、`packages/runtime/src/services/session/message-dispatcher.ts`、`packages/runtime/src/services/session/session-delivery-registry.ts`、`packages/runtime/src/services/session/session-state-projection.ts`、`packages/runtime/src/services/session/session-service.ts` | u2 | plain | ① runtime vitest 增量绿 + typecheck 绿；② grep 全量复核：`updateSessionOccupancy(` 直调点清零（全部经原语）+ 三布尔直写点清零（实施期检查点③销账）；③ settling 预检单测：settling 态发送被拒转 send.rejected{busy}；④ apply-entry-equivalence 等价性套件绿 |
| u3c | readonly 收紧 + 约束登记 + 文档回写收口 | `packages/runtime/src/services/session/types.ts`、`docs/constraints.json`、`docs/constraints.md`（`node scripts/render-constraints.mjs` 重渲染）、`docs/design/session-occupancy-send-closure.md`（C-proc-10 回写） | u3b | plain | ① runtime typecheck 绿（readonly 后直写在编译期红）；② constraints.json 新增「session 忙闲状态单写原语」条目 + render 脚本重渲染 diff 一致；③ 全量等价性套件 + runtime/core/renderer/shared 四包 vitest 全绿（Gate A 预演） |
| u4 | C1 方案一：前端 turn 计时条（turn 时长/当前工具时长/已产字符）+ 阈值警示 + 中性操作项 + ask_user 豁免文案（「在等待你的输入」） | `packages/core/src/domain/chat/`（新增计时派生 composable，ADR-0049 分区范式）、`packages/renderer/src/components/panel/Composer.vue`、`packages/renderer/src/i18n/locales/zh-CN.ts`、`packages/renderer/src/i18n/locales/en-US.ts` | u1a | plain | ① core+renderer vitest 增量绿 + typecheck 绿；② 计时派生单测：事件边界驱动（delta 不计时）、ask_user pending 期豁免计时；③ 文案断言：无「卡死/无响应/异常」判断词（i18n 断言）；④ 中止操作走既有 abort 链路（接线点单测） |
| u6 | C1 方案二 L2 停滞提示帧（设计 PR-5） | — | **blocked**：P-3 实测阻塞（设计文档 §3.5 显式判定「数据不足时方案二不落地」），本轮冻结不实施；验收范围 V5② / P-3 相应排除 | — | 无（冻结） |

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U1A["u1a D3 前端清队回草稿<br/>领地: core/chat useChat + renderer sidebar/compactQueue + i18n"]
    U1B["u1b D5① kill 全量日志<br/>领地: runtime message-dispatcher/session-lifecycle/process-manager/reap-orphan-pi"]
  end
  subgraph W2[Wave2]
    U2["u2 D4收敛环+D5②短路+转移原语基座<br/>领地: runtime message-dispatcher/session-lifecycle/session-service/event-interpreter/types"]
    U4["u4 C1方案一 前端计时条<br/>领地: core 计时composable + Composer.vue + i18n"]
  end
  subgraph W3[Wave3]
    U3B["u3b 挂点迁移+settling裁决<br/>领地: runtime event-interpreter/message-dispatcher/delivery-registry/state-projection/session-service"]
  end
  subgraph W4[Wave4]
    U3C["u3c readonly收紧+约束登记+文档收口<br/>领地: runtime types.ts + docs/constraints* + closure设计文档"]
  end
  U1A -->|"i18n locale 同文件共改"| U4
  U1B -->|"message-dispatcher/session-lifecycle 同文件共改 + D5①日志先落(语义: kill可观测先行)"| U2
  U2 -->|"消费其产出的转移原语 + 同文件共改"| U3B
  U3B -->|"readonly 须在挂点全迁后收紧 + 等价性收口"| U3C
```

u6（冻结）不入图。

## 4 测试策略

**增量（单元开发期）**：
- runtime：`cd packages/runtime && pnpm test`（vitest run）+ `pnpm typecheck`
- core：`cd packages/core && pnpm test` + `pnpm typecheck`
- renderer：`cd packages/renderer && pnpm test` + `pnpm typecheck`
- 测试文件落位跟随各包既有 `__tests__`/`*.test.ts` 惯例；vitest 配置已带 junit reporter（`test-results/`）

**全量（收尾，Gate A）**：runtime + core + renderer + shared 四包 `pnpm test` 全量 + `apply-entry-equivalence` 等价性套件 + `pnpm run lint`（根）。extensions 三连不涉及（本设计无 extension 改动）。

**Gate B（真实场景验收）**：设计 §4 V1-V8 在 dev 环境（`pnpm dev`，真实 pi + 真实 provider / 故障注入代理）执行；P-1 探针双场景（单通知 abort 时序 + ≥2 条通知收敛环）随 V1/V4 标定，由主 agent 执行并记录。

## 5 合理偏差登记表

（初始为空，阶段 3 填写）

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| u1a | pending | 0 | — |
| u1b | pending | 0 | — |
| u2 | pending | 0 | — |
| u3b | pending | 0 | — |
| u3c | pending | 0 | — |
| u4 | pending | 0 | — |
| u6 | blocked（P-3 实测阻塞，设计显式判定） | — | 设计 §3.5 P-3 / §5 PR-5 行 |

## 7 残留风险与变更历史

**残留风险**：
1. P-1 探针双场景实测（单通知 abort 时序 + ≥2 条通知收敛环 + 收敛窗 3s 初值校准）需真实 pi 环境，随阶段 5 Gate B 的 V1/V4 执行；若实测触发 §3.5 降级档，按设计降级路径回改 u2 并重跑受影响验收。
2. u2 单元为关键路径最大单元（5 文件、原语+收敛环+短路三块新逻辑），dev 轮次预算按 2 轮预置，超 2 轮未绿按 SKILL 阈值冻结升级用户。
3. V8 场景（≥3 轮 forceQuit/restore 循环 + 重启）依赖 pnpm dev 稳定长跑，阶段 5 执行时注意多实例端口坑（AGENTS.md：3210/9222/3310 归属确认）。

**变更历史**：
- 2026-09-11：初版计划。单元切分对设计 §5 的 PR 表做了两处映射说明：① 设计 PR-3 拆为 u2 基座（原语+转移表+宣告帧收编，因 event-interpreter/session-lifecycle 与 PR-2 同文件共改，合并以压关键路径至 4 层）+ u3b（挂点迁移）+ u3c（readonly+文档收口）；② 设计 PR-5 → u6 冻结（P-3 阻塞为设计文档显式判定，非本计划新增裁决）。
