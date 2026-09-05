# 会话占用状态统一（occupancy）与消息发送闭环 实施计划

基线: (待填) | 来源设计: docs/design/session-occupancy-send-closure.md | 日期: 2026-09-05

## 0 章节映射

| 内容 | 本文实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（G1-G4 + in/out-of-scope） |
| 终态/机制 | §3 解决方案（§3.1 终态五场景 / §3.3 D1-D7 决策与状态机转移表 / §3.4 协议与数据模型 / §3.5 错误规格表 / §3.6 探针） |
| 验收场景表 | §4 验收（V1-V8，真 Electron + 真 pi，禁 mock） |
| 下一层拆分 | §5（P1-P4 四阶段表 + 待验证检查点 + 迁移期双轨收口） |
| 待验证检查点 | §5「待验证检查点」清单（P-1/P-2/fork notice/100ms 档/V4a 构造/转移 #10 衔接/removeQueuedTextFromSnapshot 幂等性） |

对抗式审查证据：本会话内 tech-design-review agent 5 轮审查收敛（must-fix 轨迹 6→2→1→1→0），末轮 0 must-fix / 0 suggestions，设计就绪（DoR 通过）。审查报告未落盘，证据为会话内审查结论（收敛轨迹与被否谱系均已写入设计文档 §3.3 各决策的「被否」栏）。

## 1 目标快照（逐字摘录设计文档 §1）

**设计目标**（从使用者体验倒推）：
- **G1 忙时发送永不失败**：任何占用状态下按 Enter，消息都有确定去向（直发 / 追加当前回合 steer / 进 defer 队列），永不出现「忙」类报错。
- **G2 排队消息可见、可撤销、投递必达**：入队即出现 pending 气泡；可撤销；投递后气泡转正常态且重开 session 后一致（live ≡ reload）。
- **G3 进行中状态单一展示位**：对话流尾部统一活动条（压缩 / 命令 / 思考），消灭「提示在处理但界面无任何状态」。
- **G4 占用状态可恢复**：断连重连、切走再切回 session 后，占用状态与队列从快照恢复，不依赖广播时序。

**in-scope**：runtime 拒绝转译与 occupancy 状态机；`session.occupancy` state topic 协议；renderer 统一发送分发器与 defer 队列；pending 气泡；ActivityStrip 展示统一；Composer 发送位四态。
**out-of-scope**：pi 侧任何改动（AGENTS.md 红线）；steer / followUp 的 QueueBubble 短延迟展示语义（维持现状）；bash 的停止入口（现状独立按钮不动）；subagent 定向消息、fork / handoff 流程；compact 队列的跨重启持久化。

**实施路径**（§5）：四阶段串行交付，每阶段独立可验收/可回滚。P1+P2 消除用户痛点（不依赖协议），P3 兑现长期架构，P4 展示收口。迁移期双轨收口：P3 落地前 renderer 仍消费 session.compacting/compacted；P3 落地时 isCompacting 切 occupancy 派生、setCompacting 通路废弃；P4 清理 TurnMeta 占位与 CompactQueueBadge。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|---|---|---|---|---|---|
| u1-foundation | shared 协议一次性扩展：`send.rejected` reason 联合类型（`'busy'\|'compacting'\|'processing'`）+ 可选 `clientUuid`；`message.send` RPC 透传 `clientUuid`；`session.occupancy` 消息类型（P3 消费，先行定义避免共享契约并行共改） | `packages/shared/src/protocol.ts`；`packages/shared/src/__tests__/`（协议测试如涉及） | — | plain | vitest 绿：类型编译通过 + 现有 shared 测试不回归；`send.rejected` payload 类型含三 reason 与 clientUuid 字段 |
| u2-p1-runtime | runtime 拒绝转译：sendPrompt catch 识别 pi 双字符串（"Cannot submit a prompt while compaction is in progress" → compacting；"Agent is already processing" → processing）；预检分型（命中 isCompacting → 'compacting'，其余维持 'busy'）；clientUuid 原样回带；busy 类拒绝不进 message.error 错误气泡链路 | `packages/runtime/src/services/session/message-dispatcher.ts`；`packages/runtime/src/services/session/__tests__/`（dispatcher 相关测试） | u1 | plain | vitest 绿：单测断言三种 reason 分型正确 + clientUuid 回带 + 非 busy 类 pi 错误仍走 message.error；runtime 全量不回归 |
| u3-p1-renderer | P1 renderer 侧：send 透传 clientUuid（api-port 接口 + renderer 实现）；send.rejected handler 改造——`compacting` 兜底入队（复用现有 compactQueue，useCompactQueue 的 send.rejected 订阅扩展）、乐观气泡回滚（移除未确认 appendUser 气泡）、inflight 回滚（decrement）、clientUuid 命中队列已有条目则跳过（flush 来源消歧）；`busy`/`processing` 维持 toast-only（呈现变化：不再有英文错误气泡，P3 起才静默入队） | `packages/core/src/domain/chat/api-port.ts`；`packages/core/src/domain/chat/useChat.ts`；`packages/renderer/src/composables/panel/useCompactQueue.ts`；renderer chatApi 实现文件（`packages/renderer/src/api/` 或 `lib/ws-client.ts` 内 send 实现）；各包对应测试 | u1 | plain | vitest 绿：① compacting 拒绝 → 气泡回滚 + inflight 回滚 + 入队一次（不双条目）；② busy/processing 拒绝 → 无对话流错误气泡；③ flush 来源的拒绝（clientUuid 命中）不重入队；core+renderer 全量不回归 |
| u4a-p2-core | message_end(user) 处理序三分支（D5.3 单一入口）：① defer 分区 FIFO 文本匹配（新增，命中 → 转态 + 出队 + 剔一个快照实例 + 仅 send 条目 decrementInflight + 帧消费终止）；② inflight>0 纯计数 decrement（现有零改动）；③ 腿 2 快照 includes（现有零改动）；占位三态闭环（挂/收/回滚） | `packages/core/src/domain/chat/effects/registry.ts`；`packages/core/src/domain/chat/useChat.ts`（如三分支需配合改动）；`packages/core/src/`（registry/useChat 对应测试） | u3 | plain | vitest 绿：① defer 命中转态 + send 条目计数回收；② steer 条目命中不动计数；③ 未命中 defer → 落入现有链（②③ 行为与现状逐字节等价——现有测试零改动通过）；④ 同文本碰撞数量守恒；⑤ `removeQueuedTextFromSnapshot` 幂等性（设计 §5 待验证点核实结论回填设计文档） |
| u4b-p2-ui | defer 队列 + pending 气泡：useCompactQueue 重构改名（deferQueue，符号清扫按 C-proc-10 批量同步 docs 与测试引用）；flush 重写为投递确认驱动 + per-entry 记账（D5.1-D5.2：首条 send 等价编排挂 inflight、后续 steer 不 pushPending；S1 窗口提交判定；RPC reject/未投递 → 留队 + 占位回滚）；pending 气泡组件（半透明 + Clock + hover 标注）+ 未提交态撤销（×）/已提交禁用；E2 整队保留语义退役（部分失败只重发未投递条目） | `packages/renderer/src/composables/panel/useCompactQueue.ts`；`packages/renderer/src/components/panel/message-stream/`（pending 气泡组件落点）；`packages/renderer/src/components/panel/QueueBubble.vue`（如涉及）；`packages/renderer/src/i18n/`（新 key）；`packages/core/src/domain/chat/useChat.ts`（如 flush 编排需 core 暴露等价入口）；被改名符号的 docs/测试引用（C-proc-10 清扫）；各包对应测试 | u4a | plain | vitest 绿：① 入队即 pending 气泡（用户可见 DOM 断言）；② flush 逐条提交、确认驱动出队；③ 第 2 条 steer RPC 失败 → 第 1 条已转态不重发、第 2/3 保留；④ 滞留场景（提交后无确认帧）气泡保持 pending 不误转态；⑤ 未提交 × 撤销生效、已提交 × 禁用；i18n key 完整 |
| u5a-p3-runtime | runtime occupancy 状态机 + state topic（D3 十一挂点幂等写）：#1 sendPrompt 预检通过 / #8 catch 非 busy 错（dispatcher）；#2 turn-start / #3 turn-end→settling / #4 agent-settled→idle / #5 compaction-start / #6 compaction-end 三路复位（interpreter）；#7 sendBash/bashResult（dispatcher bash 管理点）；#9 abort 全兜底复位路径；#10 session.exited/forceQuit/respawn 全复位（session-lifecycle 收敛链）；#11 abortBash/bash RPC 失败；message-bus：TOPIC_TABLE `session.occupancy`='state' + STATE_TYPE_KEY_MAP='occupancy'；每个挂点写 flag + 广播 occupancy（与现有 flag 同源同点） | `packages/runtime/src/services/session/event-interpreter.ts`；`packages/runtime/src/services/session/message-dispatcher.ts`；`packages/runtime/src/services/session/session-lifecycle.ts`；`packages/runtime/src/services/message-bus/message-bus.ts`；`packages/runtime/src/services/session/__tests__/`（interpreter/dispatcher/lifecycle 测试） | u1, u2 | plain | vitest 绿：① 11 挂点各自单测断言 occupancy 转移（含失败路径 #8/#9/#10/#11——pi 死亡时 agent_settled 不到达仍复位）；② 幂等性（乱序/重复事件不产生错误状态）；③ state topic 快照写入（message-bus 测试：重连回放含 occupancy）；④ session.compacting/compacted 事件保留不回归 |
| u5b-p3-renderer | renderer sessionPhase 投影 + 发送分发器：chat store 订阅 `session.occupancy`（state topic 快照恢复）→ sessionPhase；D6 路由表落地（Composer onSend/Enter/Alt+Enter 汇入单一分发器：turn∈{dispatching,generating}→steer；settling/compacting/bash→defer；否则直发；`/`、`!` 前缀 defer 态拒绝 toast 保留）；flush 触发从 session.compacted 切 occupancy 全 idle 且队列非空；D2 兜底扩全 reason（busy/processing 也静默入队）；isCompacting 判定切 occupancy 派生、setCompacting 通路废弃（双轨收口） | `packages/renderer/src/stores/chat.ts`；`packages/core/src/domain/chat/useChat.ts`；`packages/renderer/src/composables/panel/useCompactQueue.ts`；`packages/renderer/src/components/panel/Composer.vue`；`packages/renderer/src/composables/panel/`（发送分发器落点，如独立 composable）；setCompacting 通路废弃的关联引用清扫；各包对应测试 | u5a, u4b | plain | vitest 绿：① occupancy 帧驱动 sessionPhase（含快照恢复场景）；② D6 路由表六行逐一断言（含 threshold 形态 3 行 steer、settling 行 defer）；③ flush 触发 = occupancy idle；④ busy/processing 拒绝静默入队（P3 起全 reason）；⑤ setCompacting 通路无残留引用；core+renderer 全量不回归 |
| u6a-p4-strip | ActivityStrip 展示统一（D7）：新组件 ActivityStrip（数据源 sessionPhase，纵向堆叠优先级 compacting > bash > generating > thinking，system-notice 形态）；TurnMeta dispatching「思考中…」占位迁入；compacting/executing bash 行迁入；fork notice 定位基线实测核对（`useNoticeStack.forkNoticeBaseTop` + `COMPACTING_NOTICE_HEIGHT` 常量同步 + dev 断言） | `packages/renderer/src/components/panel/`（ActivityStrip.vue 新增）；`packages/renderer/src/components/panel/MessageStream.vue`；`packages/renderer/src/components/panel/message-stream/`（TurnMeta 占位迁移）；`packages/renderer/src/composables/panel/useMessageStreamNotices.ts`；`packages/renderer/src/composables/panel/useNoticeStack.ts`；`packages/renderer/src/i18n/`；对应测试 | u5b | plain | vitest 绿（三视角 DOM 断言）：① 单一活动条按优先级堆叠渲染四类状态；② TurnMeta 旧占位不再渲染、迁移后 fork notice 定位断言通过；③ V1-④ 阶段归属（压缩指示 = ActivityStrip）截图比对留档 |
| u6b-p4-composer | 发送位四态 + CompactQueueBadge 移除：发送位按 D6 表四态渲染（↑ send / ↑ queue 带时钟角标 / ■ stop / settling 分档）；CompactQueueBadge.vue 移除 + i18n key 与测试同批清扫（符号删除清扫纪律 C-proc-10，`node scripts/check-doc-symbol-drift.mjs` 通过） | `packages/renderer/src/components/panel/Composer.vue`；`packages/renderer/src/components/panel/CompactQueueBadge.vue`（删除）；`packages/renderer/src/i18n/`；CompactQueueBadge 引用点（Panel.vue / MessageStream.vue 等引用清扫——实施时以 grep 实际引用为准，若越出本列领地按领地锁定规则停下上报）；对应测试 | u5b, u6a | plain | vitest 绿：① 四态发送位 DOM 断言（idle→↑、steer 态→■ stop、defer 态→↑ queue 角标）；② CompactQueueBadge 组件与 i18n key 零残留；③ check-doc-symbol-drift 通过；①② 与 u6a 的活动条同屏共存截图（V4/V5 视觉断言留档） |

**单元划分依据**：设计 §5 P1-P4 是阶段级拆分，按 dev-flow 单元判据（≤5 文件/领地可枚举）细化。P1 → u1-u3；P2 → u4a（core 确认机制）+ u4b（renderer 队列与气泡）；P3 → u5a（runtime 状态机）+ u5b（renderer 投影与分发器）；P4 → u6a（活动条）+ u6b（发送位）。同文件依赖边：useChat.ts（u3→u4a→u4b→u5b 串行）、message-dispatcher.ts（u2→u5a）、useCompactQueue.ts（u3→u4b→u5b）、Composer.vue（u5b→u6b）、message-stream 目录（u4b→u6a）。

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U1["u1-foundation 协议扩展<br/>领地: shared/src/protocol.ts"]
  end
  subgraph W2[Wave2]
    U2["u2-p1-runtime 拒绝转译<br/>领地: runtime message-dispatcher.ts"]
    U3["u3-p1-renderer 兜底入队+回滚<br/>领地: core api-port/useChat + renderer useCompactQueue"]
  end
  subgraph W3[Wave3]
    U4A["u4a-p2-core message_end 三分支<br/>领地: core effects/registry.ts + useChat.ts"]
    U5A["u5a-p3-runtime occupancy 状态机<br/>领地: runtime interpreter/dispatcher/lifecycle + message-bus"]
  end
  subgraph W4[Wave4]
    U4B["u4b-p2-ui defer 队列+pending 气泡<br/>领地: renderer useCompactQueue + message-stream/ + i18n"]
  end
  subgraph W5[Wave5]
    U5B["u5b-p3-renderer sessionPhase+分发器<br/>领地: renderer stores/chat + useChat + Composer.vue"]
  end
  subgraph W6[Wave6]
    U6A["u6a-p4-strip ActivityStrip<br/>领地: MessageStream + notices + ActivityStrip 新组件"]
    U6B["u6b-p4-composer 发送位四态<br/>领地: Composer.vue + CompactQueueBadge 删除"]
  end
  U1 -->|"reason/clientUuid/occupancy 类型定义"| U2
  U1 -->|"send 透传 clientUuid 接口"| U3
  U3 -->|"同文件 useChat.ts + 入队入口被消费"| U4A
  U2 -->|"同文件 message-dispatcher.ts 挂点叠加"| U5A
  U1 -->|"session.occupancy 类型"| U5A
  U4A -->|"确认机制供 flush 记账消费"| U4B
  U3 -->|"同文件 useCompactQueue.ts 重构"| U4B
  U5A -->|"消费 session.occupancy 帧"| U5B
  U4B -->|"flush 触发切换基于 deferQueue"| U5B
  U5B -->|"sessionPhase 单一数据源"| U6A
  U5B -->|"Composer 发送位数据源"| U6B
  U6A -->|"message-stream 目录 TurnMeta 迁移完成"| U6B
```

worktree 决策：全部 plain——无热点公共文件并行共改（唯一共享契约 protocol.ts 由 u1 独占先行）；改动非实验性（设计经 5 轮审查）。

## 4 测试策略

**红线**（AGENTS.md）：vitest（禁 node:test / tsx --test）；配置在子包 vitest.config.ts，**从子包目录运行**；timer 测试用 fake timers；测试禁触真实数据目录（写删目标必须 `mkdtempSync(join(tmpdir(),...))` 自建自删）；三视角缺一不可（每条用例至少一个用户可见 DOM 断言——renderer/core 侧适用）。

**增量**（单元开发期内）：

```bash
cd packages/shared && pnpm vitest run <相关>
cd packages/runtime && pnpm vitest run <相关>
cd packages/core && pnpm vitest run <相关>
cd packages/renderer && pnpm vitest run <相关>
```

**一致性审查/修复循环后**：受影响子包全量（`cd packages/<pkg> && pnpm vitest run`）。

**收尾全量**（阶段 5 Gate A）：根 `pnpm test`（已带 --no-bail）；另跑 `pnpm extensions:typecheck && pnpm extensions:lint`（确认未误伤 extensions/）与 `node scripts/check-doc-symbol-drift.mjs`（u4b/u6b 符号清扫后）。

**Gate B 真实验收**（设计 §4，真 Electron + 真 pi 禁 mock，`pnpm dev` + Playwright 连 9222，真实长会话 ≥50 turn）：V1（u4b 后可跑）/ V2（u3 后可跑）/ V3 + 两回归（u4b 后）/ V4a/V4b（u5b 后，V4a 构造难则降级机制审查并登记）/ V5（u5b 后）/ V6a（u3 起，u5b 后完整）/ V6b（u5a 后）/ V7（u4b 后）/ V8 探针（u5a 后，P-1 采集）。V1-④/V4-①② 的视觉断言在 u6a/u6b 后以 ActivityStrip 形态复核截图。

## 5 合理偏差登记表

| # | 单元 | 偏差内容 | 合理理由 | 登记 date |
|---|---|---|---|---|

（初始为空）

## 6 状态表

| Unit | 状态(pending/in-progress/committed/blocked) | 轮次 | 证据指针 |
|---|---|---|---|
| u1-foundation | pending | 0 | — |
| u2-p1-runtime | pending | 0 | — |
| u3-p1-renderer | pending | 0 | — |
| u4a-p2-core | pending | 0 | — |
| u4b-p2-ui | pending | 0 | — |
| u5a-p3-runtime | pending | 0 | — |
| u5b-p3-renderer | pending | 0 | — |
| u6a-p4-strip | pending | 0 | — |
| u6b-p4-composer | pending | 0 | — |

## 7 残留风险与变更历史

**残留风险**（来自设计 §5 待验证检查点，实施期对应单元处理）：
- P-1 settling 时长分布（V8，u5a 后采集）——超 P95>2s 则按设计回改展示形态。
- P-2 转译双字符串探针写入 `check-pi-semantics.mjs` 语义探针族（u2 期内完成，版本 bump 门禁保护）。
- V4a threshold 形态构造（u5b 期）：实测难构造则降级「机制审查 + 源码时序断言」并登记偏差表。
- V2 ~100ms 档 pi 行为边界（D2 已登记）：实施期真实会话记录一次作佐证，不进验收判据。
- 转移 #10 respawn 后 occupancy 初值：u5a 实施确认（预期 idle 起步，无反例即按此）。
- `removeQueuedTextFromSnapshot` 幂等性：u4a 逐行确认，结论回填设计文档 §5。
- fork notice 定位基线迁移：u6a 实测核对。

**变更历史**：
- 2026-09-05：计划创建。用户评审说明：单元切分为设计文档 §5 P1-P4 的机械细化（粒度/验收条款直接来自用户已审的 §4/§5），用户已显式指令「开始开发」——评审门以此记录通过，破土。
