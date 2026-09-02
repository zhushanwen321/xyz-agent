# subagent-dual-track-convergence 实施计划

基线: 3d62ae367（设计文档 r3 收敛版 commit） | 来源设计: [docs/design/subagent-dual-track-convergence.md](subagent-dual-track-convergence.md) | 日期: 2026-09-02

> 审查证据链：r1（4 must-fix）→ r2（2 must-fix + 2 suggestion）→ r3（0 must-fix + 4 suggestion，当轮全修）。报告在 `.review/design-review-dual-track-convergence-r{1,2,3}.md`（gitignore，不入库）。

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（SCQA / 系统是什么 / 设计目标 5 条 / in-out scope） |
| 终态/机制 | §3 解决方案（§3.1 终态五条 / §3.2 方案对比 / §3.3 D1-D8 决策 / §3.4 错误规格 / §3.5 物理数据流） |
| 验收场景表 | §4 验收（V1-V6 场景表） |
| 下一层拆分 | §5 下一层拆分（3 组 8 单元 + 文件改动地图） |
| 待验证检查点 | §5 末尾「待验证检查点」①-⑥ |

## 1 目标快照（逐字摘录）

**一句话结论**：前两轮重构（引擎抽象、core 抽包）都停在「新轨可用」而没有「旧轨收敛」，体系内现在有 10 对双轨/双实现，其中 4 对已开始行为漂移（有实证）；本设计按依赖关系分 3 组收敛它们——**每个概念一个实现点**，机制要么接线要么删除，不留「假兑现」中间态。

**设计目标（从使用者体验倒推，受益者排序 ③ 开发者 > ② xyz-agent 用户 > ① 模型）**：

1. **GUI 历史详情读在有测试守护的实现上**。生产读取通路从「零测试的手写副本」切换到「conformance C5 守护的 core 实现」——收益是守护对称与 engine-generic 正确性。
2. **每个概念一个实现点**。开发者改杀链 grace 窗口、journal 格式、资源清单注入逻辑、TUI 时间格式化，都只有一个写点。
3. **pi 与 zcode 同形**。理解任意引擎的执行，入口都是 `engines/<id>/` 的四件套。
4. **缺省路径不付多引擎税**。一个 workflow 内派 pi 子代理，任务形状只映射一次。
5. **机制无假兑现**。代码里存在的每个机制要么在生产链路被调用，要么被删除且设计文档同步修订。

**out of scope**：①core barrel 与壳侧 63 个深路径 import 收口；②新引擎接入；③notifier 的 ledger/delivery-kernel 双路径；④zcode 仓 zsw 壳迁移；⑤subagent pause/resume；⑥resource-discovery 的 sync/async 双轨；⑦journal compaction 事件的 GUI 可见性。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|---------------------|------|------|---------|
| u-1a | D1 journal 读取链收敛：core 新增 session-view-service（降级链编排 + 投影 + reader registry），runtime 薄调用，删手写 reducer 与引擎 id 硬编码 | 新增 `packages/subagent-core/src/execution/engine/common/session-view-service.ts`（及同目录窄接口文件）；改 `packages/runtime/src/services/session/subagent-engine-history.ts`（删 `applyJournalEvent` 等 ~150 行 + 去 `ZCODE_ENGINE_ID` 硬编码 :130）、`packages/runtime/src/services/session/subagent-extractor.ts`（`projectEngineHandle` 双守卫收敛）；runtime tsup `noExternal` 已含 `@zhushanwen/subagent-core`（tsup.config.ts:47，核对项非改动项） | 无 | plain | V1①②③④；`cd packages/runtime && pnpm test` 全绿；core `pnpm test` 全绿；D1 实施期门①（投影依赖闭包复核无 pi 包，失败则投影留 runtime 收窄删除范围）+ ②（message_end error golden 样本可得性） |
| u-1b | D7 壳内合并：format 双轨并入、injector 工厂化、删 `formatSubagentStatusSnapshot` 死代码、engine-awareness 接线统一 | `extensions/universal/subagent-workflow/src/interface/format.ts`、`interface/views/format.ts`（删）、`interface/views/` 下消费 views/format 的 import 点、`injectors/subagent-list-injector.ts` + `injectors/workflow-list-injector.ts`（合并为工厂）及其 `__tests__`、`src/index.ts`（删 :127 死代码 + 接线统一）、`interface/__tests__/format*.test.ts` | 无 | plain | V2①②；`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 全绿；`rg formatSubagentStatusSnapshot` 零命中；`views/format.ts` 文件不存在 |
| u-1c | D8 pool-manager 接线：refs.json 落盘、preparer acquire、record GC release（chat 域 taskId=record.id 先行；workflow 域过实施期门②后定） | `packages/subagent-core/src/execution/engine/common/pool-manager.ts`、`packages/subagent-core/src/execution/engine/engines/zcode/preparer.ts`、GC 触发点文件（实施期门①盘点定：disposeAllRecords（subagent-service.ts）/ session-start-reaper（壳 index.ts 装配）/ 用户删除 record） | u-1b（壳 index.ts 共改）、u-2a（subagent-service.ts 共改：GC 接线在旧轨删除后的稳定形态上做） | plain | V3；core `pnpm test` 全绿；实施期门①（GC 触发点全量盘点，≥3 处且语义各异 → 降级评估方向 B）+ ②（taskId↔record id 打通影响面：改 createRecordForMode 签名 / hook record store 即判深 → workflow 域维持 TTL 并登记设计文档） |
| u-2a | D2 pi 执行轨物理下沉：九件 rename 至 `engines/pi/`、PiEngine 持四件套 + 原生 interact、Service 删 `kickOffBackground` 旧轨、chat 域统一走 `executeViaEngine`；单 commit 机械迁移不留 shim | `packages/subagent-core/src/execution/` 根九件（session-runner / pi-invocation / stdin-writer / spawn-event-adapter / get-state-handshake / output-collector / temp-prompt / argv-mirror / turn-limiter）→ `execution/engine/engines/pi/`；`execution/engine/engines/pi/pi-engine.ts`（持四件套 + interact）；`execution/subagent-service.ts`（删旧轨）；全仓 import 更新（实施期 rg 全量提取，多形态：ESM import / vi.mock / 相对路径；计划期宽口径 rg = 18 文件：core 8 + 壳 10，设计走查口径 40+ 待复核）；`engines/pi/reader.ts` 一并裁决（删除或标注保留理由） | 无 | plain | V4①②③（基线快照 diff 白名单 / 四视图一致 / `pnpm run build` + `bash scripts/validate-runtime-bundle.sh` exit 0）；core `pnpm test` 全绿（含 conformance）；`rg kickOffBackground` 零命中 |
| u-2b | D3 五对归一：杀链合一（grace 参数化 pi=30s/zcode=5s）、routing 单实现两调用点、journal 接线 host helper、预检 capabilities 化（maxTurns 扩位 pi=true/zcode=false + worktree 补进 SAR + chat 域同步段钉死）、嵌套防护合一 | `packages/subagent-core/src/execution/engine/common/kill-chain.ts`、`engine/common/routing.ts`（新/扩）、`engine/common/nesting-guard.ts`、`engine/types.ts`（EngineCapabilities +maxTurns 位）、`execution/subagent-service.ts`（删 `assertEngineParamSupport` :1641 / `killChildWithEscalation` 调用点 / 通知簇外的归一接线）、`execution/engine/engines/zcode/zcode-engine.ts`（删 `rejectUnsupportedTaskShapes` 硬编码）、`execution/subprocess-agent-runner.ts`（pi 短路 + registry 注入并入 routing + SAR 预检调用点）、journal helper 新文件（common/） | u-2a（归一落点在迁移后的 engines/pi/）、u-1c（subagent-service.ts 共改串行） | plain | V4④⑤（worktree 双域拦截 + 无孤儿 record + 同步观察特征 + zcode+maxTurns 正向 / pi+maxTurns 反向）；core `pnpm test` 全绿；`rg assertEngineParamSupport\|killChildWithEscalation` 零命中；D3 实施期门（pi SIGTERM 优雅退出时序实测，确认 pi 传 30s 语义与现状一致） |
| u-2c | D4 SubagentService 按变化轴拆分：剥离通知簇 / onRoundSettled 闭包 / 冷路径 resurrect 四件 / UI 队列接线；Service 收窄至编排核（~10 public 方法） | `packages/subagent-core/src/execution/subagent-service.ts`（拆分）+ 新增三 module（notifier 面 / 轮次结算 / record-store 邻接，文件名实施期定，均在 execution/ 内）+ 壳侧装配点（若 UI 队列接线外提） | u-2b（拆分面在归一后稳定） | plain | V4 回归复跑（快照 diff 白名单口径不变）；core `pnpm test` 全绿；Service public 方法数 ≤12（rg 口径，目标 ~10） |
| u-3a | D5 收尾单点 + failureKind：error-recovery 更名拆分 worker-message-pump、8 处 coda 收敛 `finalizeRun` 单写点、`AgentResult` + `failureKind` 字段（unknown=可重试守恒）、删 execute-agent-call 子串分诊表 | `packages/subagent-core/src/orchestration/error-recovery.ts`（更名拆分）、`orchestration/lifecycle.ts`、`orchestration/execute-agent-call.ts`、`orchestration/models/types.ts`（AgentResult 扩字段）、`execution/engine/engines/pi/output-collector.ts`（2a 迁移后位置；failureKind 产出 + 词表保留） | u-2a（output-collector.ts 物理位置由 2a 决定） | plain | V5①②③④（终态四步恰好一次 / stale_context 分诊 / unknown 退避重试）；core `pnpm test` 全绿；`rg DETERMINISTIC_SCHEMA_FAILURE_PREFIX` 仅产出侧命中（消费侧零命中） |
| u-3b | D6 任务形状合流：AgentCallOpts 与 AgentTaskSpec 合流、orchestration 直产 TaskSpec、删两个 mapper 与往返保真测试、pi 边界一次直出映射 | `packages/subagent-core/src/orchestration/models/types.ts`（合流）、`execution/execute-options-mapper.ts`（删）、`execution/engine/engines/pi/task-spec-mapper.ts`（删，2a 迁移后位置）、`execution/subprocess-agent-runner.ts`（直产 TaskSpec）、`engines/pi/pi-engine.ts`（spawn 参数直出）及各自 `__tests__` | u-3a（同目录串行）、u-2b（SAR 共改串行） | plain | V6（pi 子代理行为一致 + 字段完整性对照表逐项核对——对照表从现有 mapper 测试提取，实施期门⑤产物）；core `pnpm test` 全绿；两个 mapper 文件不存在 |

**u-foundation 缺席说明**：本设计为收敛型重构，无跨单元共享的新契约模块——各单元的类型改动（maxTurns 位 → u-2b、failureKind 字段 → u-3a、session-view-service 接口 → u-1a）均在各自领地内单一消费，故不设共享契约根节点。

**领地互斥核查**：任意两单元领地交集为空（潜在交叠已用串行边化解：壳 index.ts → 1b→1c；subagent-service.ts → 2a→1c→2b→2c 链；SAR → 2b→3b；output-collector → 2a→3a）。

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U1A["u-1a journal 读取链收敛<br/>领地: core common/+runtime session"]
    U1B["u-1b 壳内合并<br/>领地: 壳 interface/+injectors/+index"]
    U2A["u-2a pi 执行轨下沉<br/>领地: execution 根九件+engines/pi+service"]
  end
  subgraph W2[Wave2]
    U1C["u-1c pool-manager 接线<br/>领地: common/pool+preparer+GC 点"]
    U3A["u-3a 收尾单点+failureKind<br/>领地: orchestration/+pi/output-collector"]
  end
  subgraph W3[Wave3]
    U2B["u-2b 五对归一<br/>领地: common+types+service+SAR+zcode-engine"]
  end
  subgraph W4[Wave4]
    U2C["u-2c Service 按轴拆分<br/>领地: service+三个新 module"]
    U3B["u-3b 任务形状合流<br/>领地: orchestration types+删 mapper+SAR"]
  end
  U1B -->|"壳 index.ts 共改（1b 稳定后接 reaper）"| U1C
  U2A -->|"subagent-service.ts 共改（旧轨删除后接 GC）"| U1C
  U2A -->|"归一落点在迁移后的 engines/pi/"| U2B
  U1C -->|"subagent-service.ts 共改串行"| U2B
  U2A -->|"output-collector.ts 位置由 2a 定"| U3A
  U2B -->|"拆分面在归一后稳定"| U2C
  U2B -->|"SAR 共改（D3-② 与 D6）"| U3B
  U3A -->|"同目录串行（设计 §5）"| U3B
```

波次：W1(1a, 1b, 2a) → W2(1c, 3a) → W3(2b) → W4(2c, 3b)。每波并发 ≤3（≤5 上限内），整波绿才开下一波。

## 4 测试策略

**增量（单元开发期内，从对应子包目录运行）**：

| 单元 | 命令 |
|------|------|
| u-1a | `cd packages/subagent-core && pnpm test`；`cd packages/runtime && pnpm test` |
| u-1b | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` |
| u-1c / u-2a / u-2b / u-2c / u-3a / u-3b | `cd packages/subagent-core && pnpm test` |
| u-2a 另加 | `pnpm run build` + `bash scripts/validate-runtime-bundle.sh`（staged 打包零影响探针） |

**全量（阶段 5 收尾）**：extensions 三连 + subagent-core vitest + runtime vitest + `pnpm run build` + `validate-runtime-bundle.sh` + `pnpm run lint`。

**真实环境验收（Gate B，阶段 5）**：V1-V6 按 §4 场景表逐行执行（`pnpm dev` + 真实 pi/zcode CLI + 真实模型调用），由主 agent 编排、视觉断言派视觉 subagent。

**测试框架红线**：vitest（禁 node:test / tsx --test），timer 测试用 fake timers，从子包目录运行。

## 5 合理偏差登记表

| 日期 | 单元 | 偏差 | 合理性论证 | 处置 |
|------|------|------|-----------|------|
| 2026-09-02 | u-1a | 投影输出类型为 core 自有结构兼容类型 HistoryMessage（非 import @xyz-agent/shared 的 Message） | shared 是 workspace private 包、subagent-core 是 npm 发布包，import 会拖 private 依赖进发布闭包；投影逻辑仍全量上移 core（未触发设计降级路径），结构兼容由 runtime 签名类型检查 + 两侧测试守护 | 已固化（deviations 详录） |
| 2026-09-02 | u-1a | session-view-service 的 DEFAULT_ENGINE_ID='pi' 本地锚定（非 import registry） | import registry 会连带 port→stream-sink 的 .ts 后缀值 import 链进 runtime tsc 图；对齐 engines/pi/reader.ts 的 PI_ENGINE_ID 先例，锚定一致性有守护测试 | 已固化 |
| 2026-09-02 | u-1a | runtime 删除量 ~430 行 > 设计估计 ~150 行 | 设计只计 reducer switch 本体，实际同文件投影/降级读取/白名单函数随迁 core 一并消灭——超额是收敛更彻底，非范围蔓延 | 已固化 |
| 2026-09-02 | u-1b | views 版 formatEventLine 改名 formatTraceEventLine 迁入（同名不同实现的真差异，设计 D7-① 未显式裁决） | 两版语义不同（subagent 对话流风格 vs workflow trace 风格），同文件无法双同名导出；唯一消费点 detail-content.ts:235 同步改名 | 已固化 |
| 2026-09-02 | u-1b | 「~150 行同构消失」实际净 -70（三文件口径） | 逐字同构骨架一份副本（~115-130 行）整体消除，但工厂新增 ~30 行参数化接口 + 两份重复机制文档合并保留一份；含 index.ts 接线 -26 行后整单元 diff +186/-426 | 已固化 |

## 6 状态表

| Unit | 状态(pending/in-progress/committed/blocked) | 轮次 | 证据指针 |
|------|--------------------------------------------|------|---------|
| u-1a | committed | 1 | core 2346 passed（干净 TMPDIR）/ runtime 4095 passed / runtime typecheck exit 0（tsconfig +allowImportingTsExtensions 一行，授权项）/ tsup build success / V1④ 代码断言：runtime 手写 reducer 符号 rg 零命中、ZCODE_ENGINE_ID 硬编码删除；实施期门①闭包复核过（7 文件零 pi 包）、门② golden 样本补录 3 个（JournalWriter 真实落盘） |
| u-1b | committed | 1 | extensions 三连全绿（typecheck/lint EXIT=0 + subagent-workflow 69 files/902 tests）；rg formatSubagentStatusSnapshot 零命中；views/format.ts 不存在；injector 骨架符号仅存工厂文件；model-list-injector 零 diff；两段派发（全局文件数约束），偏差登记表 2 条 |
| u-1c | pending | 0 | — |
| u-2a | pending | 0 | — |
| u-2b | pending | 0 | — |
| u-2c | pending | 0 | — |
| u-3a | pending | 0 | — |
| u-3b | pending | 0 | — |

## 7 残留风险与变更历史

**残留风险**：

1. u-1c 的 GC 触发点是移动靶（实施期门①盘点前领地不完整）——盘点结果若判深（≥3 处语义各异 / taskId 打通需改签名），触发降级评估（方向 B：删 pool-manager + 修订设计文档 §3.3.9 语义）。
2. D2 的「40+ 测试 import」为设计走查口径，计划期宽口径 rg 仅 18 文件——import 更新面以实施期 rg 全量提取为准（含 vi.mock / 相对路径形态），不影响单元边界。
3. 走查计数类断言（Service 27 public 方法 / 整类 mock ×7 / coda 8 处）均为实施期复核项（设计待验证检查点⑥）。
4. u-2a 为最高风险单元（物理迁移 + 删旧轨 + 全量 import）——V4 基线快照 diff 是其行为零回归的唯一机器证据，采集必须在迁移前完成。
5. **V4 基线采集记录（2026-09-02，u-2a 派发前）**：chat 域基线已采（`/tmp/v4-baseline/before-u2a/chat/`：真实 pi CLI + subagent-workflow 源码 extension + 真实模型，5 工具调用、record store 8 文件含 sa-*.json / 子代理 session / sessions-index / engines.json + 事件流）。宿主形态从 xyz-agent GUI 调整为 pi CLI 直测（合理偏差：同一宿主形态前后对照等价隔离 core 执行链变化 + AGENTS.md 钦定实测路径；GUI 四视图对照留阶段 5）。**workflow 域基线采集受阻降级**：pi CLI 隔离环境（PI_CODING_AGENT_DIR + /tmp cwd）下 project workflow 发现返回 (none)（independent node 探针用同一 workspaceRoot 能发现 `/…/.agents/workflows/v4-baseline-workflow.js`，pi 进程内 registry.loadAll() 为空——根因未定位，疑似 AGENT_DIR 隔离/cwd 推导在 pi 进程内的组合行为）——workflow 域行为对照降级为 conformance 套件 + core 全量测试 + 阶段 5 桌面形态 V4 全场景；发现链问题登记待独立排查（若桌面形态同样 (none) 则为产品缺陷）。u-2a 段 2 后在等价环境重采 chat 域对照快照做 diff。
6. **基线采集环境坑**：session 目录不可放在家目录子树下（findWorkspaceRoot 向上找到家目录 marker → project 源错位），须放 /tmp 直下；core 测试 resource-discovery 用例对 TMPDIR 父链 marker 敏感（/tmp 干净目录下 40/40 过）；runtime 全量测试须默认 TMPDIR（自定义 TMPDIR 会击穿 migrate-skills-discovery 的路径断言）；并行跑多套测试会引发 relay-registry socket 冲突——一律串行。

**变更历史**：

| 日期 | 事件 |
|------|------|
| 2026-09-02 | 计划创建（基线 3d62ae367；设计经 r1/r2/r3 三轮对抗式审查收敛至 0 must-fix） |
