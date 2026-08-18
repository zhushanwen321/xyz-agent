# GUI 数据多源治理：实现计划（wave 级执行规格）

> **层声明**：本文档是 [data-source-governance.md](data-source-governance.md)（技术方案）的**子文档**，当前层 = 实施计划。上一层的「为什么 / 方案对比 / 决策论证」以父文档为准，本文档不重复论证，只做拆分与执行规格；引用父文档决策时使用编号 D1-D8（§3.3）、原则 1-5（§3.0）、场景 1-5（§4）。本文档中「登记表」指 `docs/architecture/data-source-registry.md`，「等价性测试」指 `packages/runtime/src/__tests__/equivalence/` 下测试族。

---

## §0 单元 → wave 映射

父文档 §5 的 19 个单元全部映射到 wave（P0 5 + P1 5 + P2 3 + P3 3 + P4 3；P0.5 无实施 wave，理由见表内备注）：

| 父文档单元 | wave | 备注 |
|---|---|---|
| P0.1 活跃 session label 直写全量切 RPC（含 tryPersistLabel 扩围） | W1 | 唯一已证实 bug，最先执行；turn_end/agent_end 兜底直写与手动 rename 直写同源同性质，同 wave 处置（r2 审查 MUST_FIX 1 扩围） |
| P0.2 数据登记表初版 | W2 | |
| P0.3 R1/R2/R3 机器检查 | W3（R1）+ W4（R2 骨架 + R3） | S1 语义层已上线（pr-cr-fix 8 维，含 review-data-governance），无 wave |
| P0.4 等价性测试骨架 | W5 | |
| P0.5 探针 | 无实施 wave | ① pi 冷启动探针**已完成**（中位数 ~500ms，逐次冷起定型，结论直接用于 W11）；② RPC 快照频率量化并入 W8 验收 |
| P1.1 ReplicatedState 原语 + 六实例 | W6（原语）+ W7 + W8（各三实例） | |
| P1.2 事件改失效信号 | 并入 W7 / W8 | 失效接线与实例落地同 wave 交付（同文件改动，拆开必然冲突） |
| P1.3 删 sessionMetaCache + context 收编 | W9（删 metaCache）+ W10（applyContextUpdate 收编 + switchModel 入 owner） | 拆两个 wave 控制单 wave 文件数 |
| P1.4 非活跃 rename 短命 pi | W11 | |
| P1.5 state 话题数据源切换 | W12 | 逐话题独立 commit（commit 粒度非 wave 粒度） |
| P2.1 applySnapshot 单入口 | W13 | |
| P2.2 pendingBuffer 计数 FIFO | W14 | |
| P2.3 scannedToSummary 空值守卫 | W15 | |
| P3.1 subagent/workflow 自描述单源 | W16（subagent 扩展侧）+ W17（workflow 扩展侧）+ W18（runtime 消费管线） | |
| P3.2 session_end sidecar 登记 | W19 | D3 裁决选项 a，小 wave |
| P3.3 消息流单一 reducer | W20（reducer + 文件重放喂入）+ W21（实时 feed 喂入 + 等价性断言） | |
| P4.1 等价性测试族全量化 | W22 | |
| P4.2 ADR + checklist + R2 收紧 | W23（ADR + checklist）+ W24（R2 调用图收紧） | 文档与代码分 wave |
| P4.3 pi 升级契约测试接线 | W25 | |

## §1 总览与执行纪律

### 1.1 phase × wave 总表

| wave | 名称 | 依赖 wave | 预估规模 | 父文档依据 |
|---|---|---|---|---|
| **P0 止血 + 护栏先行** | | | | |
| W1 | 活跃 session label 直写全量切 `set_session_name` RPC（rename + tryPersistLabel 扩围，止血） | 无 | M | P0.1 / D2 |
| W2 | 数据登记表初版（12 条 + 空值语义 + legacy 例外） | W1 | S | P0.2 / §3.6 第 4 层 / D1b |
| W3 | R1：pi 文件直写 pre-commit 检查 | W2 | M | P0.3 / D2 / §3.6 第 2 层 |
| W4 | R2 骨架 + R3：taste-lint 两条规则 | W2 | M | P0.3 / §3.6 第 2 层 |
| W5 | 等价性测试骨架（真实 pi fixture + live≡reload 雏形） | 无 | M | P0.4 / §3.6 第 3 层 |
| **P1 runtime owner 收敛** | | | | |
| W6 | `ReplicatedState<T>` 原语 | W3、W4 | M | P1.1 / D7 / D1b |
| W7 | label / thinkingLevel / modelId 三实例 + 失效接线 | W6 | M | P1.1 + P1.2 / D7 |
| W8 | usage / queue 深度 / commands 三实例 + 失效接线 + RPC 频率量化 | W6（建议在 W7 后串行） | M | P1.1 + P1.2 / D7 / P0.5② |
| W9 | 删除 sessionMetaCache | W7 | M | P1.3 / D1 |
| W10 | applyContextUpdate 收编 + switchModel 重算入 owner | W8 | M | P1.3 / D1 |
| W11 | 非活跃 rename 切短命 pi + 直写全删（含 handoff 迁 sidecar / patchCwd 迁 tmp，r3 补漏两链路）+ R1 allowlist 清空 | W1、W3、W6 | L | P1.4 / D2 / D3b |
| W12 | 5 个 state 话题数据源切换为 ReplicatedState 发布 | W7、W8 | M | P1.5 / D7 |
| **P2 renderer 零派生收敛** | | | | |
| W13 | session store 单一 `applySnapshot` 入口 + view-ready DTO | W12 | L | P2.1 / D7 / D1b |
| W14 | pendingBuffer 计数 FIFO（删文本匹配） | W8、W12 | S | P2.2 / D1 / D6 |
| W15 | scannedToSummary 空值守卫 | W13 | S | P2.3 / D1b |
| **P3 扩展数据单源 + 消息流** | | | | |
| W16 | subagent 扩展自描述 appendEntry 上报 | W2、W5 | M | P3.1 / D4 |
| W17 | workflow 自描述记录收敛（link entry → 全量记录） | W16 | M | P3.1 / D4 |
| W18 | runtime 消费管线：entry_appended + get_entries 增量 + extractor 降级 | W12、W16、W17 | L | P3.1 / D4 |
| W19 | session_end sidecar 登记收口 | W2、W11 | S | P3.2 / D3 |
| W20 | `applyEntry` reducer 本体 + 文件重放喂入 | W5 | L | P3.3 / D5 |
| W21 | 实时 feed 喂入（message_end 重构 entry）+ 等价性断言 | W20 | L | P3.3 / D5 |
| **P4 预防固化** | | | | |
| W22 | 等价性测试族全量化（broadcast≡get_state + 混沌注入）入 CI | W21 | M | P4.1 / §3.6 第 3 层 |
| W23 | ADR-0062 落档 + ADR-0042 修订 + review checklist | W11、W13、W18 | S | P4.2 / §3.6 第 5 层 / D3 |
| W24 | R2 从直呼形态收紧到调用图 | W2、W13 | M | P4.2 / §3.6 第 2 层 R2 |
| W25 | pi 升级契约测试接线 | W5、W21 | S | P4.3 / ADR-0037 |

规模：S ≤100 行核心改动，M 100-300 行，L 300-500 行。单 wave 上限 = 5 文件 / 核心改动 ≤500 行（全局 subagent 约束）。

### 1.2 执行纪律

1. **顺序约束**：P0 全部（W1-W5）先于 P1+；W1 必须是第一个 wave（唯一已证实 bug）。P1 内 W6 → W7 → W8 → {W9, W10} → W11 → W12 为主链。依赖见表，禁止前向依赖（被依赖 wave 先完成）。
2. **并行可能性**：三组可并行——① W3 ∥ W4 ∥ W5（P0 内互不共享文件）；② W16-W17（extensions/subagent-workflow）可与 P1/P2 的 wave 并行（不同包，无共享文件）；③ W20-W21（core 包 chat 域）可与 W16-W18 并行，但**不得**与 W13/W14 并行（同碰 `packages/core/src/domain/chat/`）。W7 与 W8 理论可并行但共享 `session-service.ts` / `event-interpreter.ts`，默认串行。
3. **每 wave 完成即 commit**：一个 wave 一个 commit 序列（commit 英文 conventional 风格，`fix:`/`refactor:`/`test:`/`docs:`/`chore:` 前缀）；W12 内 5 个话题每话题独立 commit（父文档 P1.5 要求）。回滚 = revert 该 wave 全部 commit（父文档 §5 回滚通则）。
4. **禁止事项**：wave 执行中不做方案级决策——遇到父文档未覆盖的情况，停止并上报（引用本文档对应 wave 编号），不得自行「重新评估」。pre-commit 检出问题全部正面修复，禁 `--no-verify` / `SKIP_*`。
5. **项目约束速查**（影响全部 wave）：vitest（禁 `node:test`；从子包目录运行，如 `cd packages/runtime && pnpm test`）；extensions/ 改动跑 `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连；runtime 新增依赖同步 `packages/runtime/tsup.config.ts` 的 `noExternal`（本计划预计零新增 npm 依赖，若 wave 引入则属偏离须上报）；per-session 状态用 `packages/core/src/foundation/use-session-scoped-state.ts`（ADR-0049）；WS handler 用 `updateFor(capturedSid)`。
6. **验收命令基准**（全文通用缩写）：`RUNTIME_TEST` = `cd packages/runtime && pnpm typecheck && pnpm test`；`CORE_TEST` = `cd packages/core && pnpm typecheck && pnpm test`；`RENDERER_TEST` = `cd packages/renderer && pnpm typecheck && pnpm test`；`EXT_TEST` = `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`。真实环境操作 = `pnpm dev` 起 app（Playwright 连 9222 调试，见 workspace AGENTS.md 前端调试节）；扩展日志 = `XYZ_AGENT_DEBUG=1` 后看 `~/.pi/agent/logs/`。

---

## §2 P0 止血 + 护栏先行（W1-W5）

### W1 活跃 session label 直写全量切 pi RPC（rename + tryPersistLabel 扩围，P0.1，止血）

**目标**：活跃 session **label 链路**的全部 xyz 直写 pi JSONL 路径切换为经 pi（手动 rename 切 `set_session_name` RPC + `tryPersistLabel` turn_end/agent_end 兜底直写整体删除）——label 持久化责任整体移交 pi：显式初始 label 改在 create/fork 时经 RPC 写入，未命名 session 的派生初始 label 退役为显示派生（不再持久化）。W1 后活跃 session 不存在任何 **label 链路的** xyz 直写 pi session 文件代码路径，auto-rename 覆盖手动命名的 bug 消失。非活跃 rename 直写保留为登记的 legacy 例外（W2 登记、W11 移除）。范围澄清（r3 审查补全）：活跃 session 的另两条直写链路——`persistHandedOff`（handoff_marker，源 pi 在场）与 `patchSessionCwd`（restore 时 pi 未起）——不属 label 链路，统一在 W11 处置（父文档 D2/D3b 裁决）；fork 创建型零代码改动（登记，见 W2 步骤 3）。

**前置依赖**：无（第一个 wave）。pi `set_session_name` RPC 存在性与行为已由父文档 D2 探针核实（rpc-mode.ts:632，内部 `sessionManager.appendSessionInfo` 落盘 + 广播 `session_info_changed`）。create 期即调 RPC 的安全性也已核实：pre-flush 期 `appendSessionInfo` → `_appendEntry` → `_persist` 只进 pi 内存缓冲（首条 assistant 消息前不落盘），随首次 `openSync("wx")` flush 一并写出（session-manager.ts `_persist`）——EEXIST 场景（规则 #6）只发生在「pi 之外的代码提前建文件」，RPC 路径文件只会由 pi 创建，无此风险。

**涉及文件**（均已核实存在）：

- `packages/runtime/src/infra/pi/rpc-client.ts`（修改：新增 `setSessionName` 方法；现状已有 `get_state`/`get_entries`/`get_commands`/`get_session_stats`，无 `set_session_name`）
- `packages/runtime/src/services/ports/pi-engine.ts`（修改：`IPiEngine` 接口声明 `setSessionName`——`getRpcClient(sessionId)` 返回类型是 `IPiEngine`（pi-engine.ts:131 附近，已核实现状无该方法），不补接口声明则步骤 2 的调用 typecheck 必失败；与 RpcPiEngine 实现同步）
- `packages/runtime/src/services/session/session-lifecycle.ts`（修改：`renameSession`（L284）活跃分支；create（L234）/ forkSession（L633）的显式 label 经 RPC 持久化；删除 L294 `labelPersisted` 重置）
- `packages/runtime/src/services/session/session-service.ts`（修改：删除 `tryPersistLabel`（L1282-1286）及其在 `handleTurnUsageSideEffects`（L878）/ `handleTurnEndSideEffects`（L902）的调用、`labelPersisted` 初始化（L1191））
- `packages/runtime/src/services/session/types.ts`（修改：删除 `labelPersisted` 字段声明（L110）——1 行机械删除）
- `packages/runtime/test/rpc-client.test.ts`（修改：已核实真实位置——runtime 测试双目录布局，rpc-client 用例在 `test/` 而非 `src/__tests__/`；补 `setSessionName` 用例）
- `packages/runtime/test/session-service.test.ts` + `test/session-service-w3.test.ts`（修改：rename 活跃分支直写断言（:716 附近）改 RPC 断言；tryPersistLabel 用例（:248-313 附近）删除或改写为「显式 label 经 RPC 持久化」用例）

文件数 7-8 个超单 wave 5 文件基准，但其中 pi-engine.ts 为接口 1 行声明 + 实现委托、types.ts 为 1 行删除、两个测试文件为断言机械适配，核心生产改动集中在 rpc-client / pi-engine / session-lifecycle / session-service 四文件，总量 <300 行，符合「一个 subagent 一次会话」粒度。

注意：父文档文件地图中 `rpc-client.ts` 未带目录，真实路径在 `packages/runtime/src/infra/pi/`（见附录 A）。

**任务步骤**：

1. `rpc-client.ts` 新增方法 `setSessionName(name: string)`：`sendCommand('set_session_name', { name })`，返回 `success` 检查遵循该文件既有 `sendCommand` 约定（规则：`sendCommand` 必须检查 `success`）。对齐现有 `getState`（L590 附近）的方法风格与 JSDoc。同步在 `services/ports/pi-engine.ts` 的 `IPiEngine` 接口声明该方法（RpcPiEngine 委托实现）——`getRpcClient` 返回类型是 `IPiEngine`，缺接口声明则步骤 2 typecheck 失败。
2. `session-lifecycle.ts` `renameSession` 活跃分支（`if (session)` 内）：保留 `session.label = newName` 与 `sessionMetaCache.setLabel(...)` 内存更新（P0 阶段 metaCache 未删，W9 再删）；把 `this.sessionStore.persistSessionName(...)`（L296）替换为显式 guard + RPC 调用——`const client = this.svc.getRpcClient(sessionId)`（`getRpcClient` 已存在于 session-service.ts:522），**client 为 null（pi 崩溃窗口）即 throw**（走既有失败路径 toast，保留旧名可重试，与「RPC 失败时抛错给上层 toast」自洽；禁止可选链静默 no-op——那会造成 UI 显示新名、零持久化、无提示的静默丢写）；RPC 调用失败（`success` false / 超时）同样抛错给上层 toast（父文档 §3.1 失败路径）。L290-294 的 `labelPersisted` 重置及其注释随机制删除。
3. 删除 `tryPersistLabel` 机制（扩围核心）：session-service.ts 的 `tryPersistLabel` 方法（L1282-1286，含 docstring）、两处调用（`handleTurnUsageSideEffects` L878 / `handleTurnEndSideEffects` L902——删 tryPersistLabel 行并同步改写两 handler 的 docstring，移除其中「承载 tryPersistLabel 主路径/兜底」段落（L866-873 / L890），方法本身保留承载其余副作用）、L1191 `labelPersisted: false` 初始化、types.ts:110 字段声明（含其 docstring），全链删除。
4. 显式初始 label 改经 RPC（替代原 tryPersistLabel 的持久化职责）：create（session-lifecycle.ts:234 `label ?? basename(sessionCwd)`）与 forkSession（L633）在 RpcClient 就绪后（create 流程内 `client.getState()` 成功即证 RPC 可用，L207）对**显式传入**的 label 调 `client.setSessionName(label)`（现有调用方已核实：renderer create payload（session-message-handler.ts:62）、handoff-service.ts:279、forkSession label 参数）。无显式 label 的派生值（basename(cwd)）**不再持久化**——显示由内存 `session.label` 与既有 scanner fallback（extractSessionName 返回 null → basename(cwd)）承担，重启后显示值不变；pi 内存 sessionName 保持空，auto-rename 守卫照常通过，行为与现状等价（现状直写也不进 pi 内存）。RPC 失败不阻断 create/fork（label 留内存显示，console.error 上报），恢复动作 = 手动 rename（本 wave RPC 路径）重试。
5. 非活跃分支（`else`）**保持不动**（仍走 `persistSessionName`，登记为 legacy 例外，W2 登记、W11 删除）。
6. 测试：rpc-client 用例覆盖 `set_session_name` 命令名与参数；session-lifecycle 相关测试（若无专门测试文件则新增 `packages/runtime/test/session-lifecycle-rename.test.ts` [新增]，与 rpc-client.test.ts 同目录）断言活跃分支走 RPC、create/fork 显式 label 走 RPC、派生 label 不触发 RPC、非活跃分支不变；session-service-w3.test.ts 的 tryPersistLabel 直写断言删除。

**验收标准**：

1. 代码级：`grep -n "set_session_name" packages/runtime/src/infra/pi/rpc-client.ts` ≥1 命中；`sed -n '284,312p' packages/runtime/src/services/session/session-lifecycle.ts` 输出中，`if (session)` 分支内无 `persistSessionName` 调用且 `else` 分支仍有（W11 前非活跃是登记在案的 legacy 例外）；`grep -rn "tryPersistLabel\|labelPersisted" packages/runtime/src packages/runtime/test --include="*.ts"` 命中数 = 0（机制含其自述注释整体退场——与 persistSessionName 历史注释保留惯例不同，此处注释是已删机制的 docstring，随机制删除）；`grep -n "setSessionName" packages/runtime/src/services/session/session-lifecycle.ts` ≥2 命中（活跃 rename + create/fork 显式 label）。
2. 行为级（父文档场景 1 前半）：`pnpm dev` → 新建 session 发首条消息 → 等自动命名出现（`~/.pi/agent/logs/` 中 rename-session 扩展日志出现 `renamed to`）→ 侧栏右键手动改名「重构计划」→ 继续对话 3 轮 → 侧栏名仍为「重构计划」，扩展日志出现 `skip: name exists`，session JSONL 尾部无新增 auto 标题的 `session_info` entry（`tail -5 <sessionFile> | grep session_info` 仅见手动改名那一条）。
3. 回归：`RUNTIME_TEST` 通过；对**非活跃** session（重开 app 后未打开的）右键改名，名字持久（legacy 直写路径行为不变）；新建 session **不带名** → 首 turn 后 auto-rename 正常出现（派生初始值不再持久化不阻碍 auto-rename——pi 内存名保持空、守卫照常通过）；新建 session **带显式名**（handoff 场景或 renderer 传 label）→ **发送至少一条消息等 turn 完成后**（前提：pi `_persist` 首次 flush 前 session 文件不存在——session-manager.ts:934-946，pre-flush 窗口下重启则 session 整体不在磁盘、名字无从保留，与现状等价非回归；handoff 场景天然满足——创建后立即注入 doc 跑 turn）重启 app，名字保留（session_info 由 pi 经 RPC 写入）且不被 auto-rename 覆盖（RPC 已更新 pi 内存，守卫 skip）；未命名且 auto-rename 未发生的 session 重启后显示 basename(cwd)（scanner fallback 既有路径）。
4. 行为级补充：活跃 session 手动改名后（RPC 生效）用 `get_state`（`pi --mode rpc` 附着该 session）确认 `sessionName` 返回「重构计划」。

### W2 数据登记表初版（P0.2）

**目标**：12 类 GUI 数据的 owner / 权威源 / 唯一写入口 / 字段空值语义 / 已知例外有一张可查的 SSOT 表，成为后续全部 wave 与护栏（S1/R2/R3）的依据。

**前置依赖**：W1（legacy 例外登记以 W1 之后的现状为准——活跃 rename 直写与 tryPersistLabel 兜底直写均已删；非活跃直写、persistHandedOff、patchSessionCwd 三条仍在，均带 W11 期限登记）。

**涉及文件**：

- `docs/architecture/data-source-registry.md` [新增]（目录 `docs/architecture/` 存在）

**任务步骤**：

1. 按父文档 §2.2 的 12 类清单逐条建表，每条字段：`编号 / GUI 数据 / 权威源 / owner（目标模块，P0 标注「现状 → 目标（W 编号）」）/ 唯一写入口 / 字段空值语义 / 已知例外`。
2. 字段空值语义按父文档 D1b 落字：`sessionName` 空 = 合法态（未命名，必须整字段覆盖）——`label` 是 sessionName 在 xyz 侧的同一数据链投影（W7 label 实例 fetch 即 `get_state().sessionName`），**不单独登记**「label 空 = 未设置（可守卫）」语义（空值语义必须唯一，曾双登记致矛盾，r2 审查修正）；`thinkingLevel` 无空值语义（永不 guard）；`modelId`/`tokenCount` 磁盘扫描占位值 `''`/`0` 不覆盖已知真值（对齐 `session-scanner.ts` L81-82 现状）。
3. 已知例外登记四条（r3 审查补全写方全集）：① 非活跃 rename 直写（`persistSessionName` 非活跃分支 `session-lifecycle.ts:302`，移除期限 = W11）；② `persistHandedOff` handoff_marker 直写（`session-file-utils.ts:464` `openSync('a')`，活跃交接时源 pi 在场；移除期限 = W11，迁移形态 = sidecar，父文档 D3b 裁决）；③ `patchSessionCwd` 整文件重写（`session-file-utils.ts:518`，`atomicWrite` :540；竞态边界 = 仅 restoreSession 在 pi spawn 前调用、目标文件无并发写方；移除期限 = W11，迁移形态 = restore tmp 读改写管线，D3b）；④ 队列内容唯一提交方 = renderer（D6，扩展 `deliverAs` 注入禁用，S1 checklist 拦截）。另登记两类**合法边界形态**（非例外，父文档原则 1/D3b）：⑤ sidecar 家族（`.meta.json` `persistSessionEnd` / `.preset.json` `persistPresetBinding` / `.project.json` `persistProjectBinding` / `.handoff.json`（W11 迁入 `persistHandedOff` 后启用，登记先行——家族全集四后缀对齐父文档 D3b），xyz 自有文件，W19 收口确认）；⑥ fork 文件创建型（`createForkedSessionFile` session-fork.ts:175，唯一创建入口，目标写前不存在、写后即移交 pi）；⑦ 非写点注记（r4 补，防后续审查误问）：session 删除链（`pm.destroySession` 先行 + `session-store.trash` → system/trash OS 垃圾桶移动 + sidecar unlink，无并发持有）与 pi-maintenance.ts（infra/pi/）一次性目录布局迁移 `renameSync` 属**非内容写**，不在「写点」定义与 R1 检查范围。再在 #1 label 条目登记「已知写点处置」：**xyz 指向 pi JSONL 的写点全集 6 处全部有着落**——活跃 rename 直写（`session-lifecycle.ts:296`）与 turn_end/agent_end 兜底直写（`session-service.ts:1284` tryPersistLabel）已于 W1 移除（切 RPC / 退役为显示派生）；非活跃 rename 直写（`:302`）与 `persistHandedOff`（:464）、`patchSessionCwd`（:540）带 W11 期限登记；`createForkedSessionFile`（session-fork.ts:175）登记创建型合法形态保留——写点集合与源码真实状态一致，防后续 review 误判「另有未登记写方」（r1/r2/r3 连续三轮审查均在此处扫出遗漏，本轮以全量 grep 自查收口：`grep -rn "openSync\|appendFile\|writeFile\|atomicWrite" packages/runtime/src --include="*.ts" | grep -iv test` 逐条核对指向 sessions 目录的写点）。
4. 登记 plugin sessionData 为「已 owner 化声明」条目（权威 = runtime `SessionDataStore`，`packages/runtime/src/services/plugin-service/session-data-store.ts`，非多源病灶，见父文档 §2.2 覆盖范围说明）。
5. 表头声明：本表 P1 起演进为可执行配置（ReplicatedState 配置即登记条目，W6-W8 执行时同步维护）。

**验收标准**：

1. 文件存在且 `grep -c "^| " docs/architecture/data-source-registry.md` 覆盖 12 条数据行 + 1 条 plugin sessionData 声明 + 4 条例外 + 2 条合法形态登记 + 1 条非写点注记（人工计数核对）。
2. 内容级：表内含「移除期限 = W11」字样（legacy 例外带期限，D2 要求）；含 sessionName（label 同链、不另设可守卫语义）/ thinkingLevel 无空值语义 / 磁盘扫描占位值守卫三类的区分表述（D1b）；#1 label 条目含 6 处写点的处置去向（两处已移除 + 三处带 W11 期限 + 一处创建型登记保留）；handoff/patchCwd 例外条目含竞态边界表述（活跃 pi 在场 / restore 时 pi 未起）。
3. 一致性：登记表中对非活跃 rename 的现状描述与代码一致——`grep -n "persistSessionName" packages/runtime/src/services/session/session-lifecycle.ts` 的**代码命中**（排除注释行）仅剩非活跃分支 1 处（`:302`），注释命中（`:291-292`/`:306`，随 W1 扩围已改写或删除的除外）逐条核对为历史机制说明；`grep -n "persistHandedOff\|patchSessionCwd" packages/runtime/src/infra/pi/session-file-utils.ts` 命中确认两条 W11 例外登记的实现本体在位（W1 不动它们——非 label 链路）。

### W3 R1：pi 文件直写 pre-commit 检查（P0.3 第一件）

**目标**：`git commit` 时机器拦截「runtime/scripts 代码对 session JSONL 的写操作」，报错指向登记表条目。

**前置依赖**：W2（allowlist 内容以登记表 legacy 例外为据）。

**涉及文件**：

- `.githooks/check_pi_direct_write.py` [新增]（`.githooks/` 目录存在，已有 `check_path_whitelist.py` 等 13 个 .py checker 同体系——`ls .githooks/*.py | wc -l` 实测）
- `.githooks/install-hooks.sh`（修改：heredoc 生成的 pre-commit 里追加 R1 段）

接入机制（已核实）：pre-commit 本体**不在 git 跟踪**，由 `install-hooks.sh` 的 heredoc 生成到 `$(git rev-parse --git-common-dir)/hooks/pre-commit`（commondir，842 行）；checker 以 `PATH_WHITELIST_CHECKER=".githooks/check_path_whitelist.py"` 形式调用。改完 `install-hooks.sh` 必须重跑 `cd .githooks && ./install-hooks.sh` 再生成。

**任务步骤**：

1. 新增 `check_pi_direct_write.py`，模式（对齐父文档 R1 定义）：扫描 `packages/runtime/src/` 与仓库根 `scripts/` 中指向 sessions 目录 **pi JSONL 本体**的写操作——`openSync('a')` / `openSync('w')` / `appendFile` / `appendFileSync` / `writeFile` / `writeFileSync`，**以及 `atomicWrite`**（已知 util 形态——`patchSessionCwd` 经 `utils/fs-utils.ts` 的 atomicWrite 整文件重写 JSONL，r3 补漏：不含它则该写点穿透）。**匹配粒度（r4 补定义：「邻近上下文」落字为文件级邻近）**：写调用所在文件内含 sessions 路径推导（`getSessionsDir` 的 import/调用或 `sessions` 字面量）即视为指向 sessions 目录——该粒度覆盖目标路径为形参、函数体内无路径字面量的间接形态（session-file-utils 三条 legacy 写点即此形态：目标 filePath 形参 + 文件级 `getSessionsDir` import（:12）/ 调用（:735），文件级命中；若取函数级粒度则这些写点全部漏拦，allowlist 与 sidecar 豁免形同虚设，W11 验收 1 的「归零」空转）；调用参数或所在函数体直接含路径推导当然也命中。**内置豁免（非 allowlist）**：目标为 sidecar 家族后缀（`.meta.json` / `.preset.json` / `.project.json` / `.handoff.json`——四后缀全集对齐父文档 D3b；`.handoff.json` 的写点 W11 迁移才出现，此处先预留，保证豁免清单与登记表 sidecar 家族条目始终一一对应，W11 步骤 7 迁入后核对；xyz 自有文件）不报错。**检出边界（docstring 写明）**：目标路径经形参间接且**整个文件**无任何 sessions 路径推导的写点不命中（跨文件数据流静态不可判定）——`session-fork.ts:175` 即此形态（调用点传 `getSessionsDir()`，fork 文件内无 sessions 字面量），R1 不命中——fork 的守卫 = 登记表「创建型唯一写入口」声明 + S1 语义层（父文档 D3b 诚实声明，粒度与覆盖差以该声明为准）。实现风格对齐 `check_path_whitelist.py`（读其开头 docstring 与 main 结构复刻）。
2. allowlist 机制：脚本内置 `ALLOWLIST` 数组，初始条目**枚举执行时三条 legacy 直写链路的全部真实写点**（W1 扩围后、W11 迁移前的存活全集）：① `persistSessionName` 实现本体（`packages/runtime/src/infra/pi/session-file-utils.ts:415`，写点 `openSync('a')` :427）+ 唯一剩余调用点非活跃 rename（`session-lifecycle.ts:302`；活跃 `:296` 与 tryPersistLabel 兜底（`session-service.ts:1284`）已随 W1 删除）；② `persistHandedOff` 实现本体（`session-file-utils.ts:452`，写点 :464）；③ `patchSessionCwd` 实现本体（`session-file-utils.ts:518`，写点 atomicWrite :540）。执行时以 `grep -rn "persistSessionName\|persistHandedOff\|patchSessionCwd" packages/runtime/src --include="*.ts"` 排除注释行与测试 mock 的命中为准逐一登记，allowlist 与真实写点集必须严格相等（若发现 tryPersistLabel 路径仍存活 = W1 未按扩围执行完毕，停止并上报，**禁止登记放行**）。每条 allowlist 项必须带 `# 移除期限: W11` 注释——注意这是本脚本**新引入**的约定：`.githooks/check_sidecar_session.py` 只有通用例外注释先例（:42 附近 `SENDERROR_NO_SID_WHITELIST`，无期限式注释形态），该新约定须写进 R1 脚本 docstring 说明。
3. `install-hooks.sh` heredoc 内追加 R1 段（对齐 `PATH_WHITELIST_CHECKER` 段的结构：print_section → python3 调用 → 非 0 退出报错文案指向 `docs/architecture/data-source-registry.md`）；重跑 `./install-hooks.sh`。
4. 报错文案遵守「错误信息必须可操作」：输出违规文件:行号 + 恢复动作（「改经 pi RPC 或扩展 appendEntry；若为登记例外，先在 data-source-registry.md 补条目 + 本脚本 allowlist 登记」）。

**验收标准**：

1. 代码级：临时在 `packages/runtime/src/services/session/` 新建含 `appendFileSync(join(getSessionsDir(), 'x.jsonl'), '')` 的文件 → `python3 .githooks/check_pi_direct_write.py` exit 非 0 且输出含该文件路径与 registry 指引；删除临时文件后 exit 0。
2. 行为级（父文档场景 4② 的 R1 部分）：在测试分支新增直写 JSONL 的 `appendFileSync` 并 `git add` → `git commit` 被 pre-commit 拦截（输出含 check_pi_direct_write 段报错）；revert 后 commit 通过。
3. 回归：`install-hooks.sh` 重跑后 `grep -c "CHECKER=" "$(git rev-parse --git-common-dir)/hooks/pre-commit"` 比改前多 1（生成体现有 16 行 `CHECKER=`——带缩进，无锚点 grep 实测；heredoc 与生成体一致——逐一仍可执行：`bash -n` 通过）。
4. allowlist 验证：当前 HEAD 下 `python3 .githooks/check_pi_direct_write.py` exit 0，且 allowlist 条目与 `grep -rn "persistSessionName\|persistHandedOff\|patchSessionCwd" packages/runtime/src --include="*.ts"` 排除注释后的代码命中一一对应（W1 扩围后预期 = persistSessionName 实现本体 + 非活跃调用点 + persistHandedOff 本体 + patchSessionCwd 本体，共 4 条链路写点；多登 = 掩盖未登记写方，漏登 = R1 误报，两者都算验收失败）。

### W4 R2 骨架 + R3：taste-lint 两条规则（P0.3 第二、三件）

**目标**：新增模块级缓存必须带 `@data-owner` 注解且条目真实（R3）；store mutation 只能被 owner 文件直呼（R2 首版拦直呼形态）。

**前置依赖**：W2（R3 校验注解引用的登记表条目编号；R2 许可表来自登记表）。

**涉及文件**（taste-lint 已核实为仓库根目录，规则在 `taste-lint/rules/*.mjs`，已有 `no-native-html-elements.mjs` 等 13 条）：

- `taste-lint/rules/require-data-owner-annotation.mjs` [新增]（R3）
- `taste-lint/rules/no-non-owner-store-mutation.mjs` [新增]（R2 骨架）
- `taste-lint/base.mjs`（修改：注册两条规则，对齐现有规则注册方式）
- `packages/renderer/src/stores/` 下任一现存带模块级缓存的文件（修改：补注解使存量合规——执行时以 grep 找出全部命中文件逐一补齐，预估 ≤3 个）

**任务步骤**：

1. R3 `require-data-owner-annotation.mjs`：检测模块级 `new Map(` / `ref(` 缓存声明；无 `@data-owner <登记表条目编号>` 注释则报错，报错文案指向 `docs/architecture/data-source-registry.md` 对应条目。豁免：测试文件、`useSessionScopedState` 内部实现（原语本体豁免，登记为规则内注释）。
2. R2 骨架 `no-non-owner-store-mutation.mjs`：首版拦直呼形态——import 某 store 后在其 owner 文件之外直调 mutation 方法（`setGroups` / `updateLabel` / `updateSessionState` 等首版许可清单 = 空之外的登记表条目）。实现路线按父文档 R2：先 import 边直呼检测（复用现有规则的 AST 遍历模式），调用图分析留 W24。
3. 两条规则在 `base.mjs` 注册；存量违规（R3 首扫命中）全部正面修复——给现存缓存补 `@data-owner` 注解（条目编号引用 W2 登记表，plugin sessionData 等已 owner 化条目直接引用）。
4. 误报豁免闭环：规则支持行内豁免注释 + 要求同步在登记表补条目（对齐 check-domain-boundaries allowlist 先例，写在规则 docstring）。

**验收标准**：

1. 代码级：在 `packages/renderer/src/stores/` 临时文件写 `const cache = new Map()` 无注解 → 触发 lint 报错（`pnpm run lint` 或 taste-lint 直跑，错误文案含 data-source-registry 指引）；补 `@data-owner` 注解后通过；删除临时文件。
2. 代码级：临时文件 import session store 并直调 `updateLabel` → R2 报错；删除后通过。
3. 回归：`pnpm run lint` 全仓通过（存量命中已全部补注解，无新增违规）；`RENDERER_TEST` 通过。
4. 规则自检：`node --test` 或 taste-lint 既有规则测试方式（read `taste-lint/rules/` 现有规则是否带测试文件，按同一方式为两条新规则补最小用例）全部通过。

### W5 等价性测试骨架（P0.4）

**目标**：`packages/runtime/src/__tests__/equivalence/` 目录就绪——真实 pi 子进程 fixture 可复用，`live ≡ reload` 断言雏形可运行，后续 wave 的等价性断言都在此挂载。

**前置依赖**：无（可与 W3/W4 并行）。**先例诚实声明（r2 审查修正）**：仓库内**不存在**任何真实 pi spawn 测试先例，也无「pi binary 缺席时 skip」的既有惯例——`packages/runtime/src/__tests__/rpc-client-bash.test.ts` 是 `vi.mock('node:child_process')` 的全 mock 测试（其 docstring 自述「投递伪造 pi response」，仅 mock 层面覆盖 stdin JSONL 命令结构），不提供可复用的 spawn/环境检测写法。本 wave 的等价性 fixture 是**净新增基建**，spawn 命令形态按 workspace AGENTS.md 的 pi CLI 实测流程自行定义：`pi --mode rpc --session-dir <tmp> --model <model> --approve` + stdin JSONL 发命令、stdout 逐行收 RPC reply/event。

**涉及文件**：

- `packages/runtime/src/__tests__/equivalence/pi-fixture.ts` [新增]（目录 `equivalence/` 随本 wave 创建；spawn 真实 `pi --mode rpc` 子进程——净新增基建，无既有先例；临时 `--session-dir`、stdin JSONL 发命令、收 RPC reply）
- `packages/runtime/src/__tests__/equivalence/live-reload.test.ts` [新增]（断言雏形；W22/W25 的 chaos / broadcast-getstate / pi-protocol-contract 同目录后续追加）

规模复核（r2 要求）：净新增基建无先例可抄、需含冷启动就绪等待与临时目录清理，按 M 档上限预估（~250-300 行）执行；若实现中发现需要多 pi 版本矩阵等超出单 wave 预算的形态，上报调级而非压缩清理逻辑。

**任务步骤**：

1. `pi-fixture.ts`：导出 `spawnPiFixture()`——临时目录 session-dir、spawn pi（可执行文件定位为 fixture 自有逻辑：`execSync('which pi')`（macOS/Linux）/ `where pi`（Windows）探测 PATH，命令形态与生产代码 `process-manager.ts:52` 完全一致（`isWindows ? 'where pi' : 'which pi'`；r3 修正：原稿 `command -v pi` 与生产形态不一致——`command -v` 是 shell 内建、`which` 是外部命令，探测语义等价但形态不同，统一为 which 消除差异）、探测失败返回 null 并进入步骤 3 的 skip 语义）、`sendCommand` 封装（stdin 写 JSONL 行）、`collectEvents()`（订阅 `session.subscribe` 收事件流）、`dispose()`（kill + 清理临时目录）。fixture 必须处理 pi 冷启动就绪等待（探针结论：冷启动中位数 ~500ms，等待上限取 5s）。
2. `live-reload.test.ts` 雏形：跑最小操作序列（发一条 prompt 等 turn 完成）→ 断言「实时累积的 entry/消息快照 == `get_entries` 全量重放快照」。此阶段断言对象为原始 entry 序列（W20-W21 后升级为 store 级快照），vite/vitest 配置沿用 `packages/runtime/vitest.config.ts`。
3. skip-if-no-pi 语义（本 wave 净新增约定，非既有惯例——全仓 `skipIf` 仅 `packages/runtime/test/e1-e3-real-verify.test.ts:71` 一处且用于 provider 环境检测，不覆盖 pi binary）：fixture 模块顶层 `const PI_PATH = detectPi()`；测试文件用 `describe.skipIf(!PI_PATH)` / `it.skipIf(!PI_PATH)` 包裹真实 spawn 用例——pi 缺席时用例 skip（skip 计数 >0）而非 fail；该约定写进 fixture 文件头注释，作为 W22/W25 及后续 equivalence 用例的唯一引用点。
4. 验收工具性：此测试成为 W7-W12、W20-W22 各 wave 验收的运行基线（各 wave 在此文件族新增用例，不另起炉灶）。

**验收标准**：

1. 命令级：`cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` 通过（环境有 pi binary 时真实跑；无 pi 时 skip 且 skip 计数 >0，fail 数 = 0）。
2. 行为级：手动注入断言失败的对照（临时把断言改为 `expect(a).toBe(b+1)` 之类）→ 测试确实红（证明断言非空转）；还原后绿。
3. 回归：`RUNTIME_TEST` 全量通过（fixture 的临时目录清理断言：测试结束后临时 session-dir 不存在——在 dispose 后 `existsSync` 断言 false）。

---

## §3 P1 runtime owner 收敛（W6-W12）

### W6 `ReplicatedState<T>` 原语（P1.1 第一件）

**目标**：runtime 有了通用快照复制原语——配置三元组 `(快照 RPC, 失效触发源, 合并策略含字段空值语义)` 驱动「快照拉取 + 事件只做失效 + 退避重拉」，六类标量状态不再各写各的缓存（D7 原则 4）。

**前置依赖**：W3、W4（护栏先行——P1 重构必须发生在 R1/R2/R3 机器检查与 S1 语义层生效之后；父文档 §3.5「先立守护再动大刀」）。

**涉及文件**：

- `packages/runtime/src/services/session/replicated-state.ts` [新增]（目录存在）
- `packages/runtime/src/__tests__/replicated-state.test.ts` [新增]

**任务步骤**：

1. 实现 `ReplicatedState<T>`（TypeScript class，无外部依赖——不新增 npm 依赖，避免 tsup `noExternal` 变更）：
   - 构造配置：`{ fetchSnapshot(): Promise<T>, debounceMs, backoffSchedule: [1000, 5000, 15000], pollIntervalMs?: number, merge(snapshot: T, current: T): T, fieldsNullSemantics }`——`pollIntervalMs` 为周期兜底重拉间隔（可选，默认关闭 = 不启动周期定时器；父文档原则 4 / D7「周期/重连兜底重拉」的原语能力面，W7 thinkingLevel 实例依赖它：pi 同档位切换不发射事件，纯事件失效覆盖不住）；
   - `markDirty()`：置 dirty + 防抖触发重拉（事件只做失效，永不直接写数据——原则 4）；
   - `get()`：读当前快照值；dirty 时返回上次快照（父文档 §3.1 失败路径：快照失败保留 dirty 不清除，UI 显示上次值）；
   - `refetch()`：重连兜底全量重拉（退避 1s/5s/15s，父文档 §3.1）；
   - 合并规则内建 D1b 两条：owner 快照合并 = 权威源整字段覆盖含显式空值；wire 层空值归一（JSON 序列化丢 undefined key → 按 `fieldsNullSemantics` 判定「key 缺失」的空值语义，禁止当「字段不动」）。
2. 测试（fake timers，项目规范）：失效不直接写值（markDirty 后防抖窗口内 get() 返回旧值）；快照失败退避重试且 dirty 不清除；空值覆盖语义（sessionName undefined 覆盖旧名）；wire 归一（key 缺失按登记语义处理）；`pollIntervalMs` 周期兜底（配置后到点触发重拉、未配置不启动定时器）。
3. 不在本 wave 接线任何实例（W7/W8 做）；登记表加「原语就位」标注。

**验收标准**：

1. 代码级：`grep -n "markDirty\|refetch\|fieldsNullSemantics\|pollIntervalMs" packages/runtime/src/services/session/replicated-state.ts` 全部命中；`RUNTIME_TEST` 通过（含新测试文件，用例 ≥7 条覆盖上述行为）。
2. 设计约束断言：测试中存在「事件到达后立即读值为旧快照」的用例（防退化为事件直写），存在「快照含显式空值覆盖非空旧值」的用例（D1b 反例回归）。
3. 回归：`grep -rn "replicated-state" packages/runtime/src --include="*.ts" | grep -v __tests__` 此刻仅定义无调用（接线在 W7/W8，本 wave 零行为变化）；全量 `RUNTIME_TEST` 无既有用例变红。

### W7 label / thinkingLevel / modelId 三实例 + 失效接线（P1.1 + P1.2 第一批）

**目标**：label、thinkingLevel、modelId 三类标量状态由三个 `ReplicatedState` 配置实例持有，pi 事件（`session_info_changed` / `thinking_level_changed`）与 switchModel RPC 响应只做失效，快照来自 `get_state`。

**前置依赖**：W6。事件名已核实存在于 `event-adapter.ts` DISPATCHER（L737-738）；modelId 无 RPC 层事件（父文档 D7 精确核实），失效源 = switchModel RPC 响应后主动拉快照。

**涉及文件**：

- `packages/runtime/src/services/session/replicated-state.ts`（修改：文件尾或同目录新增 `packages/runtime/src/services/session/replicated-states.config.ts` [新增] 放六实例配置，本 wave 建 3 个）
- `packages/runtime/src/services/session/session-service.ts`（修改：实例注册、switchModel 响应后 markDirty、`get_state` 快照拉取接线）
- `packages/runtime/src/services/session/event-interpreter.ts`（修改：`session_info_changed` / `thinking_level_changed` 处理改为实例 markDirty；现状两事件在 L87 附近回写 sessionMetaCache——回写点本 wave 保留、W9 删）
- `packages/runtime/src/index.ts`（修改：组合根装配——现状 L298 有 `sessionMetaCache.setLabel` 直写点，改读实例）

**任务步骤**：

1. `replicated-states.config.ts` 建 3 个配置条目（每条 = 登记表条目的代码化，条目编号与 W2 登记表一一对应）：
   - label：fetch = `get_state().sessionName`；失效源 = `session_info_changed`；空值语义 = `sessionName 缺失 = 未命名 = 覆盖`（label 与 sessionName 是同一数据链，无独立「可守卫」空值语义——D1b 归一，登记表不双登记）；
   - thinkingLevel：fetch = `get_state().thinkingLevel`；失效源 = `thinking_level_changed`（pi 同档位切换不发射事件——session-service.ts:450 已记录——配置登记周期兜底重拉 `pollIntervalMs: 30_000`，即 W6 原语的周期兜底字段，间隔取 30s）；
   - modelId：fetch = `get_state().modelId`；失效源 = `switchModel` RPC 响应（RPC 响应驱动是「事件只做失效」的补充合法形态，D7 登记）。
2. `event-interpreter.ts`：两事件的 handler 改为调实例 `markDirty()`；翻译输出（`session.renamed` / `session.thinkingLevelSet` 广播）改为在实例快照更新后由实例发布（广播形态本 wave 维持现状 type 名，W12 统一切 state 话题）。
3. `session-service.ts`：switchModel 成功响应后对 modelId 实例 `markDirty()`；`getState` 快照拉取函数供实例 fetch 用（复用 rpc-client `getState` L590）。
4. 本 wave 是「双写过渡」：实例与旧缓存（sessionMetaCache / session.inputTokens 等）并存，读方逐步切实例；旧缓存删除在 W9。等价性断言：W5 骨架加用例——发 `session_info_changed` 后实例值最终与 `get_state` 一致。

**验收标准**：

1. 代码级：`grep -n "markDirty" packages/runtime/src/services/session/event-interpreter.ts` ≥2 命中（两事件改失效）；`grep -n "sessionMetaCache.setLabel\|sessionMetaCache.setThinkingLevel" packages/runtime/src/services/session/event-interpreter.ts` 命中数为 0（interpreter 不再直写缓存）。
2. 行为级：`pnpm dev` → 对话中切模型 → 模型名 1s 内更新且与 `get_state().modelId` 一致；手动改名（W1 已切 RPC）→ label 更新；杀 WS 连接 30s 重连 → 三字段与 `get_state` 逐字段一致（父文档场景 2 的前半子集）。
3. 回归：`RUNTIME_TEST` 通过；`cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` 通过（W5 骨架 + 本 wave 新增用例）。
4. 频率与延迟量化记录（P0.5② 首次采样）：测试中记录一次典型操作序列（3 轮对话 + 1 次切模型）触发的 `get_state` RPC 次数与 p95 延迟，数字写入登记表对应条目备注（后续 W8 汇总判定是否触发父文档 P0.5 失败预案——本 wave 只记录不决策）。

### W8 usage / queue 深度 / commands 三实例 + 失效接线 + RPC 频率量化（P1.1 + P1.2 第二批）

**目标**：usage、queue 深度、commands 三类状态也由实例持有；六实例齐备；RPC 快照频率的量化结论落表（P0.5② 收口）。

**前置依赖**：W6；建议在 W7 后串行（共享 `session-service.ts` / `event-interpreter.ts`，避免并行冲突）。

**涉及文件**：

- `packages/runtime/src/services/session/replicated-states.config.ts`（修改：补 3 个配置条目）
- `packages/runtime/src/services/session/session-service.ts`（修改：context 相关事件（turn_end / agent_end）与 compaction 的 usage 失效接线；`get_session_stats` 快照；commands 的 `get_commands` 快照与失效；queue 深度接线）
- `packages/runtime/src/infra/pi/event-adapter.ts`（修改：`queue_update` 翻译（L612/L736）输出附深度信息——`pendingMessageCount` 以 `get_state` 快照为准，queue_update 只做深度失效信号，D6）
- `docs/architecture/data-source-registry.md`（修改：补量化数据）

**任务步骤**：

1. 配置条目 3 个：usage（fetch = `get_session_stats().contextUsage`；失效 = context 相关事件 turn_end / agent_end / compaction；空值 = 无空值语义）；queue 深度（fetch = `get_state().pendingMessageCount`；失效 = `queue_update`；深度权威 = pi，D6）；commands（fetch = `get_commands`；失效 = commands 相关广播事件，对齐 session-service.ts:1323 现有发布路径的事件源）。
2. `session-service.ts` 现有 5 写点（父文档 #3 清单：turn_end / agent_end / compaction 估算 / switchModel 重算 / restore 拉取）中，事件路径写点全部改为实例 markDirty（估算类写点在本 wave 保留过渡，W10 收编时删除）。
3. RPC 频率量化收口（P0.5②）：基于 W7/W8 两 wave 记录的采样，按父文档 P0.5 判定——若超阈值（UI 可感知卡顿 / RPC 队列堆积）触发失败预案（防抖窗口拉长 / 批量快照 / 仅活跃 session 拉取，按序评估选定后**上报主 agent 记录决策**，不得静默选择）；未超阈值则登记表写「已量化：无感知，无需降级」。
4. 等价性用例：事件风暴（模拟丢 context.update）后实例值收敛到 `get_session_stats` 快照值。

**验收标准**：

1. 代码级：`grep -c "markDirty" packages/runtime/src/services/session/session-service.ts` ≥4（usage 三失效源 + queue/commands）；`grep -n "get_session_stats\|get_commands\|pendingMessageCount" packages/runtime/src/services/session/replicated-states.config.ts` 全命中。
2. 行为级（父文档场景 2 前半）：对话中（已切模型、有用量、队列压一条 followUp）→ 杀 WS 30s（期间 pi 完成一轮回复、followUp 被消费）→ 重连 → 5s 内用量百分比 / 队列深度与 `get_state.pendingMessageCount` + `get_session_stats` 逐字段一致（被消费的 followUp 从队列深度消失）。
3. 量化收口：登记表 usage/queue/commands 条目备注含 RPC 次数与 p95 延迟数字，且含「未触发降级」或「已按预案 X 降级（决策记录链接）」之一（禁止空白）。
4. 回归：`RUNTIME_TEST` + equivalence 目录测试通过；`grep -n "inputTokens" packages/runtime/src/services/session/session-service.ts` 命中数较改前不增（事件路径不再新增直写）。

### W9 删除 sessionMetaCache（P1.3 第一件）

**目标**：label/thinkingLevel 影子状态库 `sessionMetaCache` 退场，读写全部走 W7 的实例。

**前置依赖**：W7（label/thinkingLevel 实例就位并已承接读方）。

**涉及文件**：

- `packages/runtime/src/services/session/session-meta-cache.ts`（删除）
- `packages/runtime/src/services/session/session-meta-cache.test.ts`（删除）
- `packages/runtime/src/services/session/session-lifecycle.ts`（修改：`renameSession` L289 的 `sessionMetaCache.setLabel` 删除，label 内存态读实例）
- `packages/runtime/src/index.ts`（修改：L298 `sessionMetaCache.setLabel` 直写点删除，改经实例/markDirty）
- `packages/runtime/src/services/session/session-service.ts`（修改：getThinkingLevel 等读点改读实例；写点删除）

**关键澄清（防误删，附录 A 详述）**：存在**两个同名** `sessionMetaCache`——本 wave 删的是 `services/session/session-meta-cache.ts`（sessionId 键，label/thinkingLevel 影子缓存）；`packages/runtime/src/infra/pi/session-file-utils.ts` 内模块级 `const sessionMetaCache = new Map<string, CachedSessionMeta>()`（filePath 键，(mtimeMs,size) 文件头解析**纯派生**缓存，D1 表「保留」类）**不动**。

**任务步骤**：

1. 全量找引用：`grep -rn "from.*session-meta-cache" packages/runtime/src --include="*.ts"`，逐文件把读点改 `ReplicatedState` 实例、写点删除（写点清单已核实：session-lifecycle.ts:289、index.ts:298、event-interpreter.ts 注入点（W7 已改为 markDirty，此处删注入））。
2. 删除 `session-meta-cache.ts` 与其测试文件；`broadcastSessionList` 类读 label 的路径改为「实例快照 + 磁盘扫描合并」（扫描侧仍走 session-scanner，占位值守卫 W15 补）。
3. 删除性变更回滚保障：独立 commit（父文档 P1 回滚要求——revert 该 commit 即从 git 历史完整恢复 cache 与全部写方）。

**验收标准**：

1. 代码级：`test ! -f packages/runtime/src/services/session/session-meta-cache.ts && echo DELETED`；`grep -rn "session-meta-cache" packages/runtime/src --include="*.ts"` 命中数 = 0；`grep -rn "sessionMetaCache" packages/runtime/src/services/session/ --include="*.ts"` 命中数 = 0（services/session 下彻底退场）。
2. 保留性断言（防误删）：`grep -n "const sessionMetaCache" packages/runtime/src/infra/pi/session-file-utils.ts` 仍命中（文件头纯派生缓存完好，`RUNTIME_TEST` 中 session-scanner 相关测试通过证明扫描路径不受影响）。
3. 行为级：`pnpm dev` → 手动改名后侧栏显示新名；auto-rename 场景（新 session 首 turn）自动命名出现——两条路径均不依赖已删缓存；重开 app session 列表 label 正常（磁盘扫描 + 实例合并）。
4. 回归：`RUNTIME_TEST` 全量通过（原 session-meta-cache.test.ts 删除后无悬挂 import）。

### W10 applyContextUpdate 收编 + switchModel 重算入 owner（P1.3 第二件）

**目标**：usage 的「applyContextUpdate 五写点」收编为 owner 单入口；switchModel 重算改在 owner 内部读自己的快照，inputTokens 竞态从「注释约定」变「结构不可能」（D1 表第 3 行）。

**前置依赖**：W8（usage 实例就位）。

**涉及文件**：

- `packages/runtime/src/services/session/session-service.ts`（修改：`applyContextUpdate`（L842）与 switchModel 重算（L467）两块；`setInputTokens`（L824）删除）
- `packages/runtime/src/__tests__/`（修改/新增：context-owner 收编用例）

**任务步骤**：

1. 写点清单（已核实）：turn_end / agent_end / compaction 估算 / switchModel 重算 / restore 拉取五写点（session-service.ts:461-464 注释记录竞态史）。逐个处置：turn_end / agent_end / compaction / restore 四点 = 全部改 usage 实例 `markDirty()`（W8 已接的事件失效保持）；switchModel 重算 = 移入 usage 实例的 merge/fetch 配置内部（owner 内读自己的 `contextWindow` + 最新快照，外部不得再传 inputTokens 进来）。
2. 删除 `setInputTokens`（L826）与 `session.inputTokens` 字段的直接外部写（`getInputTokens` L822 读点改读实例快照；`sessions` Map 内的 inputTokens/tokenCount 字段迁移为实例持有的派生值）。
3. 竞态回归用例：测试模拟「switchModel 与 context.update 乱序到达」（fake timers 控制防抖窗口），断言最终 usagePercent 与 `get_session_stats` 快照一致（结构自愈，不依赖写入顺序）。

**验收标准**：

1. 代码级：`grep -n "setInputTokens\|s.inputTokens =" packages/runtime/src/services/session/session-service.ts` 命中数 = 0；`grep -n "inputTokens" packages/runtime/src/services/session/session-service.ts` 仅剩实例配置内部与注释（人工核对每处命中归属）。
2. 行为级：对话 3 轮后切模型 → 用量百分比立即按新 contextWindow 重算且与 `get_session_stats().contextUsage` 一致；快速连切 3 个模型无闪烁错值。
3. 回归：`RUNTIME_TEST` 通过；等价性测试新增的乱序用例通过；`grep -n "缓存写入先于" packages/runtime/src/services/session/session-service.ts` 命中的时序约定注释已改写为 owner 结构说明（注释与结构同步，不留过时纪律注释）。

### W11 非活跃 rename 切短命 pi + 直写全删（含 handoff 迁 sidecar / patchCwd 迁 tmp）+ R1 allowlist 清空（P1.4）

**目标**：绝对写规则全线生效——xyz runtime 对 pi session JSONL 的**直接写入代码归零**（r3 补全全集后 = persistSessionName + persistHandedOff + patchSessionCwd 三条链路全部消灭/迁移），R1 变为无条件检查（sidecar 内置豁免与 fork 创建型登记除外）。

**前置依赖**：W1（活跃 rename 与 tryPersistLabel 兜底均已切）、W3（allowlist 存在才有清空动作）、W6（短命 pi 的 RPC 调用复用原语时代的 rpc-client）。探针结论直接采用：冷启动中位数 ~500ms（附着 session 534ms，瓶颈在 Node 冷启动，`set_session_name` RPC 本身 <1ms），形态定为**逐次冷起**，不引入 warm pi（父文档 D2 已裁决，禁止重开）。

**涉及文件**：

- `packages/runtime/src/services/session/session-lifecycle.ts`（修改：`renameSession` 非活跃分支改短命 pi；restoreSession 的 cwd 降级分支迁 tmp 读改写——patch 目标从源文件改为 tmp 拷贝）
- `packages/runtime/src/infra/pi/process-manager.ts`（修改：新增短命 spawn 附着指定 session 文件的入口——复用现有 spawn 机制，不新建子系统；已核实为 IProcessManager 实现）
- `packages/runtime/src/infra/pi/session-file-utils.ts`（修改：删除 `persistSessionName`（L415）与 `patchSessionCwd`（L518）；`persistHandedOff`（L452）改写 sidecar、`extractHandedOff`（L490）优先读 sidecar + fallback 尾读旧 JSONL marker）
- `packages/runtime/src/infra/pi/session-store.ts`（修改：删除 persistSessionName / patchSessionCwd 的转发与 import）
- `packages/runtime/src/services/ports/session.ts`（修改：删除两条端口声明（persistSessionName L106 附近 / patchSessionCwd））
- `.githooks/check_pi_direct_write.py`（修改：ALLOWLIST 置空，规则无条件化）
- `packages/runtime/src/services/session/session-fork.ts`（**零代码改动**——fork 文件创建型登记核对项，不占实现文件位）

文件数 6 个（+1 零改动核对项）略超单 wave 5 文件基准，但其中 session-store / ports 是删 ≤5 行的机械删除，核心改动集中在 session-lifecycle + process-manager + session-file-utils，总量 <400 行（patchCwd/handoff 迁移各 ~50-80 行），符合「一个 subagent 一次会话」粒度；若执行中发现超预算，优先上报拆分（handoff sidecar 迁移可独立成先行 commit），不得压缩兼容读取逻辑。

**任务步骤**：

1. process-manager 新增 `withEphemeralPi(sessionFile, fn)`（或对齐现有命名风格的等价入口）：spawn `pi --mode rpc` 附着该 session 文件（探针场景 B 形态）→ 等就绪（上限 5s）→ 执行 fn(rpcClient) → kill 进程。端到端预算 ~600ms（探针数据）。
2. `renameSession` 非活跃分支：`findScannedSession` 后改调 `withEphemeralPi(target.filePath, (c) => c.setSessionName(newName))`；失败（spawn 失败 / RPC 失败）按父文档 §3.1 失败路径报错保留旧名可重试。
3. 删除 `persistSessionName` 全链路：session-file-utils.ts 实现、session-store.ts 转发、ports/session.ts 端口声明、相关测试与 mock（代码引用按验收 1 两段式清零；注释按 [HISTORICAL] 惯例保留，逐条核对归属）。
4. **`persistHandedOff` 迁 sidecar（D3b 裁决，r3 补漏链路①）**：`persistHandedOff` 从 `openSync('a')` 直写 `handoff_marker` entry 改为写 xyz 自有 sidecar（与 `.meta.json`/`.preset.json`/`.project.json` 同目录同风格，如 `<sessionFile>.handoff.json`，命名对齐 sidecar 家族）；`extractHandedOff` 改为优先读 sidecar、未命中 fallback 尾读旧 JSONL `handoff_marker`（存量 session 兼容——旧 marker 永在尾部窗口，现有仅尾读实现保留为 fallback 分支）；`scanSessionMeta` 消费不变（仍经 extractHandedOff）；`markHandedOff`（session-service.ts:1074，体内 :1080 调用 persistHandedOff——r4 锚核正：:1080 是调用行非方法签名行）内存态写与调用链（handoff-service.ts:286）不动。sidecar 写沿用规则 #6 守卫（JSONL 不存在时跳过）+ 写后失效 sessionMetaCache（对齐 persistSessionEnd :152）。
5. **`patchSessionCwd` 迁 restore tmp 读改写管线（D3b 裁决，r3 补漏链路②）**：`restoreSession`（session-lifecycle.ts:405 附近）的 cwd 降级分支不再 patch 源文件；在既有「读源文件 → `stripSessionEndEntries` → 写 tmpdir → pi `switchSession(tmp)`」管线中，对 tmp 内容的首行 session header 应用 cwd fallback（读改写同处完成，源文件零写）。**扫描侧消费差异边界（r4 补全）**：迁 tmp 后源文件 header 永久保持旧 cwd（死路径——pi append 不重写 header），而 header cwd 的消费方不止 restore fallback——① scanner label fallback（session-scanner.ts:73 `label: s.name ?? basename(s.cwd)`，未命名 session 的显示名）与侧栏 cwd 分组读扫描出的 header cwd；② `deleteByCwd`（session-lifecycle.ts:365-372，folder 删除按扫描条目 `s.cwd === cwd` 匹配）。迁 tmp 后这两个消费方按死路径值工作，与现状（patch 把 header 改写为 home）的差异：未命名 session 重启后扫描 label 显示 basename(死路径) 而非 basename(home)；`deleteByCwd(home)` 不再命中该 session、`deleteByCwd(死路径)` 命中（arguably 更正确——死路径是 header 的真实历史值，home 是旧方案的修补值，按真实值分组/删除符合直觉）。**接受该行为差异**，理由：差异仅出现在「cwd 已被删除」的异常场景 session 上，且发生在 restore 后未产生新 turn 即重启的窗口；活路径 session 的两消费方行为不变。验收覆盖见验收 4 扫描侧断言。随后删除 session-file-utils.patchSessionCwd 及其 session-store 转发、端口声明；`restoreSession` 内现传给 `patchSessionCwd` 的防御性 mtime 检查随之退役。
6. **fork 创建型登记核对（零代码改动，r3 补漏链路③）**：核对登记表（W2 步骤 3 登记⑥）的「fork 文件唯一创建入口 = `createForkedSessionFile`（session-fork.ts:175）」条目在位且未被演进为「重写既有 session 文件」形态；失败分支 `unlink(forkedFilePath)` 清理孤儿文件的语义在条目边界说明中登记（创建者清理，非删 pi 文件）。
7. R1 allowlist 清空：`ALLOWLIST = []`，删除「移除期限: W11」注释；**R1 sidecar 内置豁免清单同步核对含 `.handoff.json`**（r4 补——W3 建立时已按 D3b 四后缀全集预留；本 wave 该后缀写点落地，豁免若缺失则验收 1 的 exit 0 不成立、与验收 3 的「允许命中」矛盾；核对豁免与登记表 sidecar 家族条目一一对应，实现偏差在此同步修正）；登记表 legacy 例外条目①②③状态改「已移除（W11）」；fork 创建型与 sidecar 家族条目保留（合法形态，非例外；家族子行补 `.handoff.json`（`persistHandedOff` 迁入））。
8. 行为验收照父文档场景 1 后半执行。

**验收标准**：

1. 代码级（两段式，防注释误伤——r2 修框架、r3 修过滤器）：① **代码引用清零**：`grep -rn "persistSessionName\|persistHandedOff\|patchSessionCwd" packages/ --include="*.ts" | grep -vE ':[[:space:]]*(//|\*)' | grep -v "\.test\.ts"` 输出为空（排除注释行与测试文件。过滤器匹配 `grep -rn` 输出的**路径前缀后**注释形态 `path:line: //...` / `path:line: *...`——r3 实测：旧写法 `grep -v "^\s*//"` 对带路径前缀的输出永不匹配、注释行穿透（jsonl.ts:60 块注释续行实测漏过），新写法经同一样例实测正确滤除且代码命中全保留；被测代码删除后测试内 mock 引用一并清零，最终以无过滤全量 grep 复核：命中仅剩注释）；② **注释命中逐条人工核对归属**：注释**不删**（[HISTORICAL] 注释保留惯例——解释设计缘由），逐条确认其描述的是历史机制而非现存调用。现存注释位置（写本文档时已核实，W1/W11 前序删除会自然缩减该集合，执行时以 grep 实测为准）：`packages/runtime/src/utils/jsonl.ts:60`、`services/session/session-service.ts:1279`（属 tryPersistLabel docstring，W1 已随机制删除）、`infra/pi/session-file-utils.ts:96`、`infra/pi/session-file-utils.ts:443`、`services/session/types.ts:104`（同属 W1 删除范围）、`infra/pi/session-store.ts:5`、`services/session/session-lifecycle.ts:291-292/306`（部分随 W1 改写）。另：`python3 .githooks/check_pi_direct_write.py` 在 ALLOWLIST 空的情况下 exit 0（fork 写点路径经形参间接且文件内零路径推导，本就不命中 R1；sidecar 四后缀内置豁免——含本 wave 迁入的 `.handoff.json`，与验收 3 的允许命中清单一致，r4 修正后两条验收不再矛盾；「归零」的机器语义 = 豁免清单外命中为 0——sidecar 四后缀内置豁免之外、全仓无文件级邻近粒度命中的写点，即无可拦模式残留）；`grep -n "ALLOWLIST" .githooks/check_pi_direct_write.py` 显示空数组。
2. 行为级（父文档场景 1 后半）：`pnpm dev` → 对非活跃 session（重开 app 后未打开的）右键改名 → 侧栏更新，session JSONL 尾部出现改名 `session_info` entry（由短命 pi 写入：`tail -3 <sessionFile>` 核对）；改名词耗时 <1.5s（探针 ~600ms + 余量，超时即 fail）。
3. 行为级（父文档场景 1 代码断言，r3 修正后与真实全集一致）：`git grep -nE "openSync\('(a|w)'|appendFile|writeFile|atomicWrite" packages/runtime/src/` 的命中逐条核对——**指向 pi JSONL 本体的写路径为零**；允许命中：sidecar 家族（session-file-utils 的 `.meta.json`/`.preset.json`/`.project.json`/`.handoff.json` atomicWrite——xyz 自有文件，D3/D3b）、`session-fork.ts:175`（文件创建型，登记在案，D3b）、session-lifecycle 的 tmpdir 写（restore/fork 的 tmp 拷贝，非 sessions 目录）、各配置/日志/附件目录写（非 sessions 目录）。
4. 回归：`RUNTIME_TEST` 通过；活跃 rename（W1 路径）与非活跃 rename（本 wave 路径）行为级各验一次；handoff 全流程（发起 → 源 session 标记 handedOffTo → 新 session 承接）+ 重开 app 后源 session 的交接标记/跳转正常（sidecar 读取路径）；restore 一个 cwd 已不存在的 session 正常复活（tmp patch 路径）且复活后继续对话的持久化落在 pi 认知的 session 文件（现状行为不回归）；删除的端口无悬挂引用（typecheck 通过即证）；存量旧 session（JSONL 内含 handoff_marker）重开后交接标记仍可读（fallback 兼容路径）。**扫描侧断言（r4 补，步骤 5 声明的消费差异验收覆盖）**：迁 tmp 后 scanner 的 label fallback（session-scanner.ts:73）与 `deleteByCwd`（session-lifecycle.ts:365）行为不回归——构造 header cwd 为死路径的未命名 session（cwd 目录删除后 restore、不产生新 turn 即重启），断言扫描 label = basename(该死路径)（一致派生，非空非 undefined）、`deleteByCwd(该死路径)` 正常命中删除；活路径 session 的 label fallback 与 deleteByCwd 行为与迁移前一致；basename(死路径) vs basename(home) 的显示差异属步骤 5 已声明并接受的行为差异，不计为回归失败。

### W12 5 个 state 话题数据源切换为 ReplicatedState 发布（P1.5）

**目标**：renderer 重连时 stateSnapshot 回放的 last-value 从影子缓存快照变为 owner 快照——「投影一次」不被现有 subscribe/ring 通道架空（D7 补漏裁决：通道复用不重写）。

**前置依赖**：W7、W8（六实例就位）。

**涉及文件**：

- `packages/runtime/src/services/message-bus/message-bus.ts`（修改：state 话题 publish 数据源接线说明与可能的 publish API 适配；TOPIC_TABLE（L55）/ STATE_TYPE_KEY_MAP（L131）结构不动——分类与 typeKey 映射是传输层语义，本 wave 不改）
- `packages/runtime/src/services/session/session-service.ts`（修改：`session.commands`（L1323）/ `context.update`（L1378）/ `session.state_changed`（L1254）三个 publish 点的数据源切换为对应实例快照）
- `packages/runtime/src/services/session/event-interpreter.ts`（修改：`session.subagents` / `session.workflowUpdate` 两话题 publish 点切换——位置以 `grep -rn "session.subagents\|session.workflowUpdate" packages/runtime/src --include="*.ts" | grep -v __tests__` 执行时定位，为这两个话题新建两个包装实例：写入口 = 现有事件流经单入口写入，P3（W18）再换底层源为 entry 扫描）
- `packages/runtime/src/transport/session-message-handler.ts`（修改：stateSnapshot 组装处（L314-352）确认读的是实例快照）

**任务步骤**：

1. 逐话题切换（父文档 P1.5 迁移顺序），每话题独立 commit：
   - commit 1 `session.commands` → commands 实例快照发布；
   - commit 2 `context.update` → usage 实例快照发布；
   - commit 3 `session.state_changed` → modelId/thinkingLevel 等 state_changed 载荷字段全部来自实例快照；
   - commit 4 `session.subagents` → 新建包装实例（现有事件流为写入口）后发布；
   - commit 5 `session.workflowUpdate` → 同上。
   （commit 4/5 过渡态加注：W12→W18 窗口这两个条目的写入口**仍是事件流**——事件直写数据，非「事件只做失效」，属已知过渡结构。commit 4/5 执行时同步在登记表为这两个条目登记过渡态例外：「W12-W18 过渡：写入口 = 事件流（已登记例外），W18 起源 = entry 扫描」，防止 S1 review 在窗口期误报；W18 执行时更新登记表撤销该例外。）
2. 每个 commit 附等价性断言：切换前后同场景 stateSnapshot 内容一致（对比 fastify：切换前录制 stateSnapshot JSON → 切换后同操作序列重放对比——W5 fixture 跑）。
3. 全部切完后删除 state 话题旧直写路径（事件直写 runtime 缓存再转发的中间层）；stream 类话题（message.* / queue_update 等）**维持 ring 语义不动**（D7：改动面仅 5 个 state 话题，越界即偏离）。

**验收标准**：

1. 代码级：每个话题 commit 后 `git show --stat HEAD` 为单话题改动；5 个 commit 完成后 `grep -n "session.commands\|session.state_changed" packages/runtime/src/services/session/session-service.ts` 的 publish 调用全部以实例快照为数据源（人工核对 diff）。
2. 行为级（父文档场景 2 前半收口）：对话中断 WS 30s 重连 → renderer 恢复的 commands / 用量 / 模型 / thinkingLevel / subagents / workflow 状态与 pi 快照一致（`get_state` + `get_commands` 人工对照）。
3. 回归：`RUNTIME_TEST` 全量 + `packages/core` 的 message-bus 相关测试（`packages/core/src/coordination/subscription-state.test.ts` 与 runtime 侧 message-bus.test.ts）通过；重连后消息流 ring 补发行为不变（session-message-handler 既有测试绿）。
4. 边界断言：`git diff <P1 起点>..HEAD -- packages/runtime/src/services/message-bus/message-bus.ts` 中 TOPIC_TABLE 与 STATE_TYPE_KEY_MAP 无改动（传输层分类不动，越界即 fail）。

---

## §4 P2 renderer 零派生收敛（W13-W15）

### W13 session store 单一 `applySnapshot` 入口 + view-ready DTO（P2.1）

**目标**：renderer/core 的 session store 写入口收敛为单一 `applySnapshot`，WS 推送的 session 级数据是 view-ready DTO，renderer 零派生（D7）。

**前置依赖**：W12（runtime 侧 owner 快照发布就位——DTO 上游成形）。

**涉及文件**：

- `packages/core/src/domain/session/store.ts`（修改：三写入口 `updateLabel`（L56）/ `updateSessionState`（L73）/ `setGroups`（L109）收敛为 `applySnapshot`；合并规则 = D1b——owner 快照整字段覆盖含显式空值 + 磁盘占位值守卫（守卫实现留 W15，本 wave 合并策略里留挂点））
- `packages/shared/src/protocol.ts`（修改：session 快照 DTO 类型——view-ready 字段定义；shared 包为类型 SSOT，目录已核实存在）
- `packages/renderer/src/composables/features/sidebar/` 或 `useSidebar` 所在文件（修改：消费方从三写入口改 `applySnapshot`；执行时以 `grep -rn "updateLabel\|updateSessionState\|setGroups" packages/renderer/src packages/core/src --include="*.ts" --include="*.vue" | grep -v __tests__` 定位全部调用点逐一改写）
- `packages/core/src/domain/session/store.ts` 对应测试（修改）

**任务步骤**：

1. core store 新增 `applySnapshot(id, snapshot: SessionViewSnapshot)`：内部按 D1b 合并（整字段覆盖含显式空值）；`updateLabel` / `updateSessionState` / `setGroups` 三个公开 mutation 删除，全部调用点（updateLabel 现状调用点含乐观更新路径）改走 `applySnapshot` 或经 runtime 广播回流。乐观更新（用户改名先显示）保留为 applySnapshot 的本地入参形态，权威确认仍经广播（父文档 §3.1 样例 1）。
2. `protocol.ts` 定义 `SessionViewSnapshot` DTO：字段 = label / status / modelId / thinkingLevel / usagePercent / pendingMessageCount / commands 等 view-ready 字段（runtime 在 W12 的实例快照直接映射，renderer 不再自行 merge/normalize/推导）。
3. 派生逻辑上移：store 内现存的 merge/normalize 类私有函数逐个迁移到 core 包唯一实现或 runtime 投影（本 wave 范围 = session 域；chat 域派生在 W20-W21 处理，不越界）。
4. renderer `stores/session.ts` 是 ADR-0059 薄壳（已核实，defineStore 包 createSessionStore），无需改动——改动全在 core factory 与消费 composables。

**验收标准**：

1. 代码级：`grep -n "updateLabel\|updateSessionState\|setGroups" packages/core/src/domain/session/store.ts` 命中数 = 0（三入口删除）；`grep -rn "applySnapshot" packages/core/src/domain/session/store.ts` ≥1 命中；`CORE_TEST` + `RENDERER_TEST` 通过。
2. 行为级（父文档场景 2 后半）：断连重连后侧栏 session 列表（标签/模型/状态/用量）5s 内与重连前实时视图一致且与 pi 快照一致；切 session / 创建 session 后侧栏即时刷新。
3. 回归：session 列表加载、双 pane（split mode）下两 pane 各自 session 状态正确（ADR-0049 分区范式不被破坏——`useSessionScopedState` 使用处不因本 wave 改为实例级状态）。
4. R2 规则联动：W4 的 R2 骨架首版许可表更新——`applySnapshot` 成为唯一合法 mutation，`pnpm run lint` 通过（无直呼旧入口残留）。

### W14 pendingBuffer 计数 FIFO（P2.2）

**目标**：queue 内容的投递定位从「文本相等匹配」改为「计数 FIFO」——queue_update 差集算出被投递条数，按条数顺序取 segments（D1 表末行 + D6）。

**前置依赖**：W8（queue 深度实例 = 对账权威就位）、W12（state 话题供数成形）。与 W13 可并行（不同文件）。

**涉及文件**（现状已核实，父文档称「renderer pendingBuffer」，实际在 core 包 chat store，renderer 是薄壳——见附录 A）：

- `packages/core/src/domain/chat/store.ts`（修改：`pendingBuffer`（L123）/ `drainPending`（L335）/ `abortPending`（L351）——`drainPending` 的 findIndex 文本匹配删除，改按条数 FIFO 取）
- `packages/core/src/domain/chat/effects/registry.ts`（修改：`message.queue_update` effect（L508）——现已有 `countDrained` 计数差集（L65-84，[B1] 注释），改造 = 用差集条数 N 调 `drainN(sessionId, sendMode, N)` 按入队顺序取 N 个，不再按文本找）
- `packages/core/src/domain/chat/__tests__/`（修改/新增用例）

**任务步骤**：

1. `store.ts` 新增 `drainN(sessionId, sendMode, n): Segment[][]`：按 pendingBuffer 入队顺序取前 n 条（FIFO，与 pi splice 顺序一致——registry.ts L132 现注释已记录该顺序保证）；删除 `drainPending` 的 `normalizeContent(text).trim() === target` 匹配逻辑。`abortPending` 保留文本匹配（RPC 失败回滚场景有准确原文，且是 renderer 自己的提交，非 pi 队列对接——在登记表 D6 条目标注此差异）。
2. `registry.ts` queue_update effect：`countDrained(prev, next)` 返回被 drain 的文本数组（现状保留），取 `arr.length` 为 N 调 `drainN`；深度对账 = `pendingMessageCount`（W8 实例广播），若「提交日志长度 − 深度 ≠ pendingBuffer 长度」则全量重对（登记 D6：深度结构性对账，内容有界偏差由下一次 queue_update 全量数组收敛）。
3. 测试（fake timers 不需要，纯数据层）：相同文本多次提交（`['A','A']` drain 1 条）取最早一条（现状 countDrained 注释中的 TC）；展开后文本 ≠ 提交原文（skill 展开——pi 入队存展开后文本，父文档 D6 核实）时仍能按条数取出（文本匹配在此场景必挂，计数 FIFO 必过——这是本 wave 的核心回归用例）。

**验收标准**：

1. 代码级：`grep -n "findIndex" packages/core/src/domain/chat/store.ts` 在 drainPending 相关函数（若保留则不得含 normalizeContent 匹配）命中数 = 0 或函数已删除；`grep -n "drainN" packages/core/src/domain/chat/effects/registry.ts` ≥1 命中；`CORE_TEST` 通过。
2. 行为级：`pnpm dev` → 对话中 steer 一条含 skill 命令的消息（提交原文 `/xxx`，pi 队列存展开文本）→ 该消息被投递进对话流（旧文本匹配在此场景丢失消息——父文档 #6 失联即丢；本 wave 后不丢）；连续 steer 两条相同文本 → 两条都按序投递。
3. 回归：`cd packages/core && pnpm exec vitest run` 中 chat 域全部既有用例通过；队列深度显示（QueueBubble / useCompactQueue）行为不变（`packages/renderer/src/composables/panel/useCompactQueue.ts` 消费路径无改动——`grep -rn "drainPending" packages/renderer/src | grep -v __tests__ | grep -v api/mock` 命中数 = 0 证 renderer 生产代码无直接依赖；r3 实测：无过滤 grep 命中 6 处，全在 `__tests__/` 注释/mock 与 `api/mock/index.ts` 注释，生产目录 0 命中，故验收命令必须带此过滤）。
4. 深度对账断言：新增用例——人为让 pendingBuffer 与 `pendingMessageCount` 偏差 1（模拟扩展注入的已知例外），断言下一次 queue_update 到达后偏差收敛（D6 残余风险边界的行为规格）。

### W15 scannedToSummary 空值守卫（P2.3）

**目标**：磁盘扫描占位值（`modelId: ''` / `tokenCount: 0`）永不覆盖已知真值——#2 空串覆盖的最后防线（D1b：空值守卫仅用于磁盘扫描占位值路径）。

**前置依赖**：W13（守卫挂 `applySnapshot` 的合并策略——全量路径唯一入口成形后守卫才有唯一位置）。

**涉及文件**：

- `packages/runtime/src/services/session/session-scanner.ts`（修改：`scannedToSummary` L81-82 的 `modelId: ''` / `tokenCount: 0` 产出处——占位值语义显式化，扫描输出标记「占位」而非真值）
- `packages/core/src/domain/session/store.ts`（修改：`applySnapshot` 合并策略挂守卫——扫描来源的字段为空占位时不覆盖实例/广播来的真值）

**任务步骤**：

1. 扫描侧：`scannedToSummary` 输出的 DTO 给占位字段加显式标记（`modelSource: 'scan-placeholder'` 之类，字段名以 protocol.ts DTO 定义为准）或维持空值 + 在合并侧按「来源 = 扫描」判定（二选一以 W13 定义的 DTO 结构为准，倾向显式标记——判定不依赖魔法值）。
2. 合并侧：`applySnapshot` 合并规则增加一条（仅扫描来源生效）：`modelId === '' 且来源=扫描` → 保留当前非空值；`tokenCount === 0 且来源=扫描` → 同。**不与 owner 快照空值语义混用**（D1b 两条规则不可混用：sessionName 的 undefined 是权威空值必须覆盖；扫描的 `''` 是占位符必须守卫——两者并存于同一合并函数但按来源分流，测试双向断言）。
3. 历史回归引用：`packages/core/src/domain/session/store.ts:70` 注释记录的「setGroups 全量覆盖曾把真值抹成空串」踩坑——保留注释并更新指向本守卫。

**验收标准**：

1. 代码级：`CORE_TEST` 通过，新增用例 ≥4 条：扫描占位 modelId 不覆盖真值 / 扫描占位 tokenCount 不覆盖真值 / owner 快照 sessionName=undefined **必须**覆盖旧名（防守卫扩大化）/ owner 快照 modelId 真值正常覆盖。
2. 行为级：`pnpm dev` → 活跃 session 切模型（真值入列表）→ 重启 app（列表来自磁盘扫描，`modelId:''`）→ 该 session 在侧栏模型列显示重开前真值或按产品语义显示，**不得**出现空串回退闪烁后丢失（对照 `get_state` 或重开 session 后实际模型）。
3. 回归：`RUNTIME_TEST`（session-scanner 相关）通过；重开 app 后 session 列表条目数与 `~/.xyz-agent` sessions 目录文件数一致（扫描全量路径不丢条目）。

---

## §5 P3 扩展数据单源 + 消息流（W16-W21）

### W16 subagent 扩展自描述 appendEntry 上报（P3.1 扩展侧）

**目标**：subagent-workflow 扩展在 subagent record 状态变更时经 `pi.appendEntry` 写自描述完整记录（字段即 SubagentRecord），pi 文件成为扩展数据持久化权威（D4）。

**前置依赖**：W2（登记表 #8 条目）、W5（等价性骨架——扩展侧改造的可验工具；可与 P1/P2 并行，不同包）。

**涉及文件**（extensions 包，改动后跑 EXT_TEST 三连）：

- `extensions/subagent-workflow/src/execution/record-store.ts`（修改：状态变更点追加自描述 appendEntry；现状已有 `pi.appendEntry` 注入通道（L175/L223，用于 manifest-invalid 上报）——本 wave 把注入通道用于 record 全量上报）
- `extensions/subagent-workflow/src/execution/record-store.ts` 类型定义处或相邻新文件 `extensions/subagent-workflow/src/execution/record-entry.ts` [新增]（customType 常量 + 自描述 entry 的 data schema：字段即 SubagentRecord，版本字段 v1）
- `extensions/subagent-workflow/src/execution/__tests__/`（修改：新增用例）

**任务步骤**：

1. 定义 customType（如 `subagent-record`，命名对齐现有 `subagent:manifest-invalid-status`（record-store.ts:350）的风格）：data = 完整 SubagentRecord 快照（id/status/result 摘要/时间戳等全部 GUI 侧需要的字段）+ `v: 1` 版本字段。不依赖读取方逆向解析 toolCall/toolResult（D4 自描述原则）。
2. record-store 状态迁移点（running → 终态等，执行时以 `grep -n "status" extensions/subagent-workflow/src/execution/record-store.ts` 定位状态机写点）逐点追加 `this.pi?.appendEntry?.("subagent-record", record)`；内存 record-store 保持运行时权威（D4：扩展内存权威 + entry 持久化权威，两者不冲突——entry 是重建源）。
3. 上报频率与体积（父文档 D4 开放探针：自描述 entry 大小/append 频率）——本 wave 在本地 pi 实测记录单个 entry 字节数与一次完整 subagent 生命周期的 append 次数，写入登记表备注；若超阈值（单 entry >100KB 或单生命周期 >50 次）按父文档预案分流（trace 增量 + 状态全量两种 customType）——触发预案属方案内既定分支，执行并在登记表记录即可。
4. 本地 pi CLI 实测（workspace AGENTS.md 强制流程）：`pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <extensions/subagent-workflow 路径>` 跑一个后台 subagent 完成，`tail` session JSONL 确认自描述 entry 落盘。

**验收标准**：

1. 代码级：`grep -n "subagent-record" extensions/subagent-workflow/src/execution/record-store.ts` ≥2 命中（常量定义 + append 调用）；`EXT_TEST` 三连通过。
2. 行为级：上述本地 pi 实测中 session JSONL 出现 `type:"custom"` 且 `customType:"subagent-record"` 的 entry，data 含完整 record 字段（`python3 -c` 或 jq 解析核对字段清单）。
3. 回归：subagent 现有功能（spawn/查询/完成注入）不受影响——`extensions/subagent-workflow` 既有测试全绿；entry 不进 LLM context（自描述 entry 是 custom entry，pi 侧保证——本地实测对话轮数不因 entry 增加而变化）。
4. 探针落表：登记表 #8 条目备注含单 entry 体积与 append 频率实测数字。

### W17 workflow 自描述记录收敛（P3.1 扩展侧续）

**目标**：workflow 的持久化形态从「state 文件 + workflow-state-link 指针 entry」收敛为自描述完整记录（统一 #8/#9 同一形态，D4）。

**前置依赖**：W16（同包顺序改造，避免同文件冲突；customType 命名与版本约定沿用 W16 模式）。

**涉及文件**：

- `extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts`（修改：现状 L455 已有 `pi.appendEntry("workflow-state-link", {...})` 指针条目——本 wave 改为 append 自描述完整 WorkflowRunRecord（customType 如 `workflow-record`），link 指针形态退役；state 文件按 D4 降级为纯性能缓存（可从 entry 完整重建才允许存在——保留但读取顺序 = entry 优先））
- `extensions/subagent-workflow/src/orchestration/__tests__/jsonl-run-store-session-file.test.ts`（修改：重建路径用例改从自描述 entry 重建）

**任务步骤**：

1. 新 customType `workflow-record`：data = 完整 WorkflowRunRecord（runId/status/steps/结果摘要），v1 版本字段；在 run 状态迁移点 append（对齐 W16 的迁移点定位法）。
2. 重建路径（`loadAll` / 从 JSONL 重建，L539 现状扫描 `workflow-state-link`）改为优先扫描 `workflow-record`；旧 link entry 兼容读取一个过渡期（存量 session 仍有 link entry——旧格式 run 不静默丢失是父文档 #9 踩坑，兼容读两者，link 优先级低）；版本 guard（现状 D-5 snapshotVersion 不匹配跳过）保持对 state 文件生效，entry 重建路径自带 v1 版本检查。
3. state 文件降级：写路径保留（性能缓存），读路径 = entry > state 文件 > 空；登记表 #9 条目更新形态描述。
4. 本地 pi CLI 实测一个 workflow run 生命周期，核对 JSONL 中 `workflow-record` entry 序列。

**验收标准**：

1. 代码级：`grep -n "workflow-record" extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts` ≥2 命中；`EXT_TEST` 三连通过。
2. 行为级：本地 pi 实测跑一个 workflow → JSONL 出现 `workflow-record` 自描述 entry（含终态）；用旧版扩展创建的存量 session（含 `workflow-state-link` entry + state 文件）在新代码下 workflow 列表正常重建（兼容读用例）。
3. 回归：`extensions/subagent-workflow/src/orchestration/__tests__/jsonl-run-store-session-file.test.ts` 全绿（含新增 entry 重建用例与旧 link 兼容用例各 ≥1）。

### W18 runtime 消费管线：entry_appended + get_entries 增量 + extractor 降级（P3.1 runtime 侧）

**目标**：runtime 侧 subagent/workflow 数据消费切换为「`entry_appended` 失效 → `get_entries(since)` 增量重拉 → 纯派生缓存」，实时与重开走同一份扫描代码（模式 2 双管线消亡，D4）。

**前置依赖**：W12（`session.subagents` / `session.workflowUpdate` 话题的包装实例就位）、W16、W17（扩展侧自描述 entry 就绪）。

**涉及文件**：

- `packages/runtime/src/infra/pi/event-adapter.ts`（修改：NULL_EVENTS（L712-716，Set 字面量；r4 核正行号）移除 `entry_appended`，新增翻译 handler——输出失效事件；已核实现状 `entry_appended` 在 NULL_EVENTS 且注释说明移出需接消费方）
- `packages/runtime/src/services/session/event-interpreter.ts`（修改：`subagentRecords` Map 改纯派生缓存——唯一写方 = entry 扫描（get_entries 重拉结果）；`entry_appended` 到达 → 对应实例 markDirty → 防抖增量拉取）
- `packages/runtime/src/services/session/session-service.ts`（修改：新增 `getEntries(since)` 增量拉取编排——rpc-client.getEntries（L528）已存在；游标失效（since 指向 entry 不存在返回错误）退化为全量重拉（父文档 §3.1 失败路径））
- `packages/runtime/src/services/session/subagent-extractor.ts`（修改：标注 legacy——降级为冷启动旧 session（无自描述 entry）兜底）
- `packages/runtime/src/services/session/workflow-extractor.ts`（修改：同上）

**任务步骤**：

1. event-adapter：`entry_appended` 移出 NULL_EVENTS，翻译为 runtime 内部失效信号（携带 customType 过滤——只对 `subagent-record` / `workflow-record` 触发失效，其他 custom type no-op，避免无关 entry 触发拉取）。
2. session-service：增量消费编排——per-session cursor（最后已拉 entryId）；markDirty 防抖后 `getEntries(since=cursor)`；返回错误（游标失效）→ 全量重拉自愈；扫描结果喂「entry → SubagentRecord/WorkflowRunRecord」的解析函数。
3. 解析函数放哪：与重开路径共用一份——`subagent-extractor.ts` / `workflow-extractor.ts` 重构为「entry 扫描器」对外导出 `scanSubagentEntries(entries)` / `scanWorkflowEntries(entries)`，实时增量与冷启动全量都调它（同一份派生代码，D4「实时与重开走同一份扫描代码」）；旧的双管线解析路径（实时 event-interpreter 内联解析 vs 磁盘 extractor 独立解析）删除实时侧内联份。
4. 冷启动兜底：无自描述 entry 的旧 session（父文档开放检查点：非 xyz 创建历史 session 降级表现）走 extractor legacy 路径——`scanXxxEntries` 先扫自描述 customType，无命中再走旧解析；降级表现 = 数据滞后但可用，登记表标注。

**验收标准**：

1. 代码级：`grep -n "entry_appended" packages/runtime/src/infra/pi/event-adapter.ts` 不再出现在 NULL_EVENTS 集合字面量内（grep -A3 "NULL_EVENTS = " 输出无 entry_appended）；`grep -n "scanSubagentEntries\|scanWorkflowEntries" packages/runtime/src/services/session/subagent-extractor.ts packages/runtime/src/services/session/workflow-extractor.ts` 各 ≥1 命中（导出共享扫描函数）。
2. 行为级（父文档场景 5）：后台 subagent 完成 → 侧栏 SubagentList 状态 / 主对话注入的完成 turn / `session.getSubagents` RPC 三者一致（closed + 相同 result 摘要）；重开 session 后第四处（entry 扫描路径）一致；session JSONL 存在自描述 custom entry。
3. 混沌断言（父文档场景 5 收尾）：等价性测试注入「丢失 entry_appended 广播」（fixture 拦截不下发）→ 防抖/兜底重拉后状态收敛到正确值（用例挂在 equivalence 目录）。
4. 回归：`RUNTIME_TEST` + equivalence 全绿；旧 session（W16 改造前创建、无自描述 entry）重开 subagent/workflow 列表仍可显示（legacy 兜底路径用例）；`grep -rn "getSubagents" packages/runtime/src --include="*.ts"` 手动刷新 RPC 路径仍可用（父文档 §3.1 恢复动作）。

### W19 session_end sidecar 登记收口（P3.2）

**目标**：session_end 维持 sidecar 单写方（D3 裁决选项 a）——读写收口确认 + 登记表按 **sidecar 家族**登记为 xyz 自有合法形态（D3b：`.meta.json` / `.preset.json` / `.project.json` / `.handoff.json` 四后缀全集，第 4 后缀 W11 迁入）；不做 appendEntry 改造（选项 b 仅在真实需求出现时启动，本 wave 禁止实施）。

**前置依赖**：W2（登记表存在）、W11（直写清零后，「sessions 目录内 xyz 写入仅剩 sidecar 家族与 fork 创建型两类登记形态」的语境成立——fork 创建型是 pi 体系内文件、与 sidecar 分属两类，见 D3b）。

**涉及文件**：

- `docs/architecture/data-source-registry.md`（修改：登记 sidecar 家族条目——`.meta.json`（owner = `persistSessionEnd` 唯一写入口，session-file-utils.ts:137，已核实）、`.preset.json`（`persistPresetBinding` :271/:281）、`.project.json`（`persistProjectBinding` :196/:223）、`.handoff.json`（`persistHandedOff`，W11 迁入），形态 = xyz 自有 sidecar，非 pi 文件，绝对写规则管不到（规则管 pi 的 JSONL 本体）；R1 对 sidecar 后缀的内置豁免与登记条目一一对应——家族四后缀与 R1 豁免清单四后缀同源同集）
- `packages/runtime/src/infra/pi/session-file-utils.ts`（修改：仅当 read 核实发现多处读写未收口时收口——现状按 D3「读写收口到登记表声明的单一 util（现状已是）」预期为零改动或纯注释补登；若发现收口外的读写点，收口进该文件并加 `@data-owner` 注解）

**任务步骤**：

1. 全量核查 sidecar 家族读写点：`grep -rn "persistSessionEnd\|persistPresetBinding\|persistProjectBinding\|persistHandedOff\|\.meta\.json\|\.preset\.json\|\.project\.json\|\.handoff\.json" packages/runtime/src --include="*.ts" | grep -v __tests__`——确认读方都经 session-file-utils 的函数（`check_sidecar_session.py` pre-commit 已有相关守卫，输出对齐）。
2. 登记表按家族登记（一条家族条目 + 各文件子行）：session 终态（status/outcome）/ launch preset / project 归属 / handoff 标记——权威 = 各 sidecar 文件；owner = session-file-utils；唯一写入口 = 对应 persist 函数；例外 = 无。W2 已登记的家族初版条目（步骤 3 ⑤）在此收口核对。
3. 本 wave 预期是小 wave：以核查 + 登记为主，代码零到微量改动；任何「顺手把 sidecar 改 appendEntry」的冲动 = 违反 D3 裁决，禁止。

**验收标准**：

1. 内容级：登记表含 sidecar 家族条目且写入口指向 `persistSessionEnd` / `persistPresetBinding` / `persistProjectBinding` / `persistHandedOff`（`grep -n "persistSessionEnd\|persistPresetBinding\|persistProjectBinding\|persistHandedOff" docs/architecture/data-source-registry.md` 各 ≥1 命中）。
2. 代码级核查留痕：wave 汇报中列出全部 sidecar 读写点 grep 结果与「已收口 / 需收口（已收口 N 处）」结论；`python3 .githooks/check_sidecar_session.py` exit 0。
3. 回归：session 结束（正常/中断退出）后重开 app，session 状态（done/error/stopped）正确显示——`RUNTIME_TEST` 中 session 终态相关用例全绿；本 wave 无行为变化（`git diff --stat` 改动行数 ≤30，超出即越界）。

### W20 `applyEntry` reducer 本体 + 文件重放喂入（P3.3 第一件）

**目标**：core 包内单一 `applyEntry(state, entry)` reducer 就位，文件重放路径（getHistory → hydrate）改喂这个 reducer——消息列表 = entry 日志纯函数的第一半（D5）。

**前置依赖**：W5（等价性骨架）。可与 W16-W18 并行（chat 域 vs extensions/session 服务域不同文件；但不得与 W13/W14 并行——同碰 `packages/core/src/domain/chat/`）。

**涉及文件**：

- `packages/core/src/domain/chat/apply-entry.ts` [新增]（reducer：`applyEntry(state: ChatViewState, entry: PiEntry): ChatViewState`——输入 pi entry（message/custom/toolCall 等全部 entry 类型），输出视图态；转换规则 = 现 `message-converter.ts` 重放路径的规则迁移/收敛）
- `packages/runtime/src/infra/pi/message-converter.ts`（修改：历史路径的 entry → messages 转换改为调 core 的 reducer（或经 core 导出函数）——现状 L44 附近注释自认「两条路径实现不同」的实时/历史分叉，本 wave 收历史侧）
- `packages/core/src/domain/chat/useChat.ts`（修改：hydrate（L611 `getHistory`）路径接 reducer 产物）
- `packages/core/src/domain/chat/__tests__/`（新增 reducer 用例）

**任务步骤**：

1. reducer 设计（D5）：state = `{ messages, queueDepth, subagents, ... }` 的 chat 视图态切片；entry 逐条 apply；**纯函数**（无副作用、无时序依赖——同 entry 序列必得同 state，「live ≡ reload」从构造上成立）。
2. 规则迁移源：`message-converter.ts` 现有 entry 树 → messages 转换逻辑（bash/write/edit 的历史静态解析、toolCall 归属等）迁为 reducer 的 entry case；runtime 侧 message-converter 保留 wire 层职责（RPC reply → entry 列表），派生规则全部进 core reducer（投影一次——派生在 core 唯一实现，D7）。
3. 重放路径接线：`useChat.ts` hydrate 消费 getHistory 返回的 entry 序列 → 逐条 `applyEntry` 重建（替代现转换路径）；`getHistory` RPC 链不变（session-service.ts:551 增量 getEntries 现状保留）。
4. 等价性断言（本 wave 只断言重放侧）：同 entry 序列两次喂入 reducer，state 全等（确定性）；全 entry 类型覆盖（父文档规则 #9：converter 不丢弃任何 pi entry 类型——每类型一条用例）。

**验收标准**：

1. 代码级：`test -f packages/core/src/domain/chat/apply-entry.ts`；`grep -cn "case '" packages/core/src/domain/chat/apply-entry.ts` ≥ pi entry 类型数（message/toolCall/toolResult/custom/compaction 等以 pi 协议类型清单为准，逐类型有用例）；`CORE_TEST` + `RUNTIME_TEST` 通过。
2. 行为级：重开一个含 bash 命令 / 文件改动 / subagent turn 的历史 session → 消息流与重开前一致（父文档场景 3 的重开半段；截图对照）。
3. 回归：`message-converter` 既有测试（`message-converter-bash.test.ts` / `message-converter-order.test.ts`）迁移后全绿或等价断言迁移到 reducer 用例（不允许测试覆盖缩水——用例数不减少）。

### W21 实时 feed 喂入（message_end 重构 entry）+ 等价性断言（P3.3 第二件）

**目标**：实时路径与文件重放喂**同一个** reducer——实时 feed 由 `message_end` 等事件重构 entry（探针定论：message entry 不发射 `entry_appended`），扩展 entry 直接走 `entry_appended`（W18 已接）；`live ≡ reload` 断言升级为 store 级同构。

**前置依赖**：W20（reducer 就位）。探针结论直接采用（父文档 D5：pi 源码唯一发射点 agent-session.ts:2269 仅扩展路径 + 实测 25 事件 0 条 entry_appended——**禁止重开「直接订阅 entry_appended 拿 message entry」的方案**）。

**涉及文件**：

- `packages/runtime/src/infra/pi/event-adapter.ts`（修改：`message_end` / tool_execution_end 等事件翻译时**重构出 entry 形态**（字段对齐 pi entry schema：messageId/contentIndex/turnId 等）作为实时 feed 载体，替代现直译 message.* 中间形态——本 wave 是替换不是并存；**同时把 `message_end` 移出 NULL_EVENTS**（Set 字面量 :712-716 现含 `'turn_start', 'message_end', …`——r3 补漏、r4 核正行号：只加 handler 不移出集合，事件被 short-circuit、实时 feed 静默为空；对齐 W18 对 `entry_appended` 的处置写法）。
- `packages/core/src/domain/chat/effects/registry.ts`（修改：effect handler 的输入从「事件 payload」改为「重构 entry 经 applyEntry 后的 state 增量」——effects 退化为 reducer 的薄封装（副作用类如 toast 保留 effect，状态类全走 reducer）；改动量大时允许分两 commit：先 message_end 路径后 tool 路径）。
- `packages/core/src/domain/chat/store.ts`（修改：`applyMessageEvent`（store.ts 现状入口）内部改喂 reducer）。
- `packages/runtime/src/__tests__/equivalence/live-reload.test.ts`（修改：断言升级——实时累积 state == 文件重放 state（store 级，非 entry 级））。

**任务步骤**：

1. 事件 → entry 重构映射表：`message_end` → message entry（含 turnId 分组字段——分组语义本身归 fix-chat-flow-order，本 wave 只保证字段在 entry 里稳定存在）；`tool_execution_start/end` → toolCall/toolResult entry；`message_update` 的 partial content 不进 reducer（临时 UI overlay，entry 提交时丢弃，D5）。
2. 实时链路改造：先 `message_end` 移出 NULL_EVENTS（:712-716，事件不再被 short-circuit）；event-adapter 重构 entry → message-bus（stream 话题 wire 形态不变，payload 换 entry 形态——**协议变更须同步** `packages/shared/src/protocol.ts` 类型）→ chat store `applyMessageEvent` → `applyEntry`。streaming 期间的 delta 渲染走 overlay（现状 transient 类话题不动，TOPIC_TABLE 不改）。
3. 扩展 entry：`entry_appended`（W18）→ 直接构 entry 喂 reducer（D5：扩展 entry 直接走该通道）。
4. 等价性断言升级：W5 fixture 跑操作序列（steer + bash + 后台 subagent 完成），断言实时 store 快照 == `get_entries` 重放喂 reducer 快照（同构断言——断言不变量而非两个实现的等价，D5）。
5. 若 pi 上游未来补发射 entry_appended（父文档预留）：只换喂入源头 reducer 不动——本 wave 在 event-adapter 留一行注释锚点即可，不写任何投机代码。

**验收标准**：

1. 代码级：`grep -n "applyEntry" packages/core/src/domain/chat/store.ts` ≥1 命中（实时入口喂 reducer）；`grep -A3 "NULL_EVENTS = " packages/runtime/src/infra/pi/event-adapter.ts` 输出无 `message_end`（已移出集合，对齐 W18 验收 1 对 `entry_appended` 的断言写法）；`packages/shared/src/protocol.ts` 中 message.* payload 类型与 entry 形态一致（typecheck 过 = 类型对齐）；`CORE_TEST` + `RUNTIME_TEST` + `RENDERER_TEST` 全绿。
2. 行为级（父文档场景 3 全量）：session 内依次 steer 一次、`!` bash 一次、启动后台 subagent 等完成注入 → 重启 app 重开该 session → 消息分组 / subagent 侧栏 / 用量与重开前一致（截图对照）。
3. 等价性（CI 可执行）：`cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` 中 live≡reload 用例断言对象为 store 级快照且通过；混沌注入（乱序/丢失/重放 message_end）→ state 收敛到与重放一致（reducer 确定性 + 快照对账）。
4. 回归：streaming 渲染（text_delta overlay）不回归——对话中打字流式显示正常（行为级：发一条长回复 prompt 观察流式）；`message-dispatcher` 既有测试全绿（命令副作用编排不受影响，规则 #9）。

---

## §6 P4 预防固化（W22-W25）

### W22 等价性测试族全量化入 CI（P4.1）

**目标**：`broadcast ≡ get_state` 与混沌注入用例全量化并接入常规 CI 运行路径（G3 长期回归基线）。

**前置依赖**：W21（断言对象全部就位：六实例 + reducer + entry 消费）。

**涉及文件**：

- `packages/runtime/src/__tests__/equivalence/broadcast-getstate.test.ts` [新增]（事件风暴后 renderer 侧状态 == pi 快照，逐字段）
- `packages/runtime/src/__tests__/equivalence/chaos.test.ts` [新增]（事件乱序 / 丢失 / 重放 → owner 状态收敛到权威快照）
- `packages/runtime/package.json`（修改：test script 或新增 `test:equivalence`，确保 `pnpm test` 含 equivalence 目录——以 vitest.config.ts include 通配符现状为准，若已覆盖则仅加 script 别名）

**任务步骤**：

1. broadcast≡get_state：fixture 发事件风暴（多轮对话 + 切模型 + 队列操作），断言实例快照 + stateSnapshot 广播内容 == `get_state` + `get_session_stats` + `get_commands` 逐字段。
2. 混沌三态：乱序（打乱非 streaming 事件顺序）/ 丢失（拦截不下发）/ 重放（同事件发两次）——每种 ≥1 用例，全部断言收敛到权威快照（拉取自愈的结构性验证，父文档 §3.6 第 3 层）。
3. CI 接线：确认 `pnpm test`（root CI 调用路径以 `.github/workflows/` 现状为准——read 后接线，禁止假设）覆盖 equivalence；pi binary 缺席环境的 skip 语义沿用 W5 步骤 3 定义的净新增约定（`describe.skipIf(!PI_PATH)`，fixture 文件头注释为唯一权威表述——非仓库既有惯例，勿在别处另起写法）。

**验收标准**：

1. 命令级：`cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` 全绿且用例总数 ≥ W21 末尾 +4（两个新文件各 ≥2）；`.github/workflows/` 中跑 runtime 测试的步骤会执行到 equivalence（read workflow 文件核对命令链，汇报中引用行号）。
2. 反证断言：临时破坏一个用例的断言（如比较对象改为快照 + 固定偏移）→ 测试红；还原后绿（防空转，同 W5 手法）。
3. 回归：`RUNTIME_TEST` 全量绿；equivalence 用例单次运行总时长 <120s（真实 pi spawn 数控制——fixture 复用进程，逐用例 spawn 会超时，复用 W5 的 fixture 生命周期设计）。

### W23 ADR-0062 落档 + ADR-0042 修订 + review checklist（P4.2 第一件）

**目标**：架构决策落档：新 ADR-0062「单一数据 owner + 绝对写规则」；修订 ADR-0042 正文与 ADR-0042 前案 W1 sidecar 实现的矛盾（「前案 W1」= ADR-0042 历史 effort 的 W1 sidecar 修订，**非本计划 wave W1**——本计划 W1 是活跃 label 直写切 RPC，与 sidecar 无关，r4 撞名消歧）；review checklist 对齐 ADR-0049 先例。

**前置依赖**：W11（绝对写规则全线生效的事实）、W13（renderer 收敛事实）、W18（扩展单源事实）——ADR 记录已发生的裁决。

**涉及文件**：

- `docs/adr/0062-single-data-owner-absolute-write-rule.md` [新增]（编号顺延已核实：当前最高 0061）
- `docs/adr/0042-runtime-session-end-entry.md`（修改：已核实真实文件名；正文「append JSONL」原决策更新为「runtime 单写 sidecar」（ADR-0042 前案 W1 的历史修订，非本计划 wave W1），显式标注修订记录——对齐项目「推翻/修订 ADR 需显式落档」惯例）
- `.agents/skills/pr-cr-fix/agents/review-data-governance.md`（修改：checklist 从「以本文档 §2.2 清单为准绳」切换为「以登记表为准绳」（登记表 W2 起已是 SSOT）+ 附 ADR-0062 引用）

**任务步骤**：

1. ADR-0062 内容（父文档 §3.6 第 5 层）：判据（缓存第二写入者判定表 D1）/ 事件只做失效 / pi JSONL 唯一写方 = pi 进程（含扩展经 pi API）/ sidecar 是登记在案的 xyz 自有合法形态（D3）/ 队列按字段分权威（D6）/ ReplicatedState 配置即登记条目。
2. ADR-0042 修订：只改与实现矛盾处 + 顶部修订记录块（date + ADR-0042 前案 W1 引用——历史 effort 的 W1，非本计划 wave W1，防修订归因错误），不动其他历史内容。
3. review-data-governance.md checklist 更新准绳引用；pr-cr-fix SKILL.md 维度表不动（8 维已含 data-governance，已核实）。

**验收标准**：

1. 内容级：`grep -n "绝对写规则\|单一数据 owner" docs/adr/0062-*.md` 命中；ADR-0042 含修订记录块（`grep -n "修订" docs/adr/0042-*.md` 命中且含 sidecar 与 ADR-0042 前案 W1 引用字样——前案 W1 指 ADR-0042 历史 effort 的 W1，非本计划 wave W1）。
2. 一致性：ADR-0062 中 sidecar/队列分工表述与登记表（W2/W19）一致——三处交叉核对无矛盾（汇报中列出核对结论）。
3. 回归：`git diff` 仅涉 3 个文件（新增 ADR + 修订 ADR + review agent checklist），无代码改动（`git diff --stat` 改动行数 ≤120）。

### W24 R2 从直呼形态收紧到调用图（P4.2 第二件）

**目标**：R2 store 写入口检查从「拦直呼形态」升级为「跨文件调用图分析」——每个 store mutation 只能被其 owner 文件调用，许可表来自登记表（父文档 R2 实现路线收口）。

**前置依赖**：W2（许可表 SSOT）、W13（renderer 写入口收敛完成——许可表稳定）。

**涉及文件**：

- `taste-lint/rules/no-non-owner-store-mutation.mjs`（修改：从 import 直呼检测升级为 import 边调用图分析——复用 `scripts/check-domain-boundaries-node.mjs`（已核实存在）的 import 边分析思路，父文档 R2 指定路线）
- `scripts/check-domain-boundaries-node.mjs`（read 参考：import 边扫描器既有实现模式（由 `scripts/check-domain-boundaries.sh` 调用）——若 taste-lint 的 mjs 规则体系不适合做调用图分析，允许把 R2 升级实现落在 scripts/ 的 node 扫描器体系并同步废弃 mjs 骨架，二选一在 wave 内定案并汇报理由；allowlist 先例对齐该脚本现状）

**任务步骤**：

1. 调用图分析：从 store 定义文件出发建 mutation 方法 → 合法 caller 集合（登记表 owner 列）；检测文件 import store 后经任意中间函数转发调用 mutation（一层转发起步；深层的数据流静态不可判定处维持 S1 语义层兜底——机器拦模式，语义归 review，父文档 §3.6 现状诚实声明）。
2. 许可表驱动：登记表条目变更 → 许可表同步（脚本从登记表 markdown 表格解析 owner 列，或登记表届时已演进为配置（W6-W8）直接读配置——以届时形态为准，两形态都实现了「许可表来自登记表」即合规）。
3. 误报豁免闭环沿用 W4 约定（豁免须登记表同步）。

**验收标准**：

1. 代码级：构造三层转发违规（文件 A import store → 函数 f 转 → f 内调 mutation）→ 新版 R2 报错、旧版（W4 直呼版）不报错（证明收紧生效）；`pnpm run lint` 全仓绿（存量无违规——W13 已收敛）。
2. 行为级（父文档场景 4①③ 的机器层部分）：测试分支在 owner 文件外经转发调用 mutation → `git commit` 被 lint/pre-commit 拦截（R2 报错文案指向登记表条目）；纯语义违规（③形态）机器层不拦 = 预期行为（S1 拦，非本 wave 失败）。
3. 回归：`pnpm run lint` + `RENDERER_TEST` + `CORE_TEST` 绿；W4 的直呼检测用例保留且通过（收紧是超集，不是替换）。

### W25 pi 升级契约测试接线（P4.3）

**目标**：pi 版本升级时自动跑协议契约测试（ADR-0037 exhaustive 检查复用 + 数据治理断言项），防上游事件语义漂移悄悄制造新分叉。

**前置依赖**：W5（fixture 基建）、W21（reducer/entry 形态定型——契约面稳定）。

**涉及文件**：

- `docs/adr/0037-pi-protocol-real-contract.md`（read 参考：已核实真实文件名；联合类型 exhaustive 检查现状）
- `packages/runtime/src/__tests__/equivalence/pi-protocol-contract.test.ts` [新增]（契约断言：事件名清单 / entry schema / RPC 命令面三方面）
- `package.json` 或 `scripts/`（修改：pi 版本 bump 时的检查入口——以现状 `scripts/` 里版本相关脚本组织方式为准接线，read 后落点）

**任务步骤**：

1. 契约测试三断言：① RPC 命令面——`set_session_name` / `get_state` / `get_session_stats` / `get_entries` / `get_commands` 全部可调且返回 schema 兼容（exhaustive 检查对 reply 类型 union 穷举）；② 事件面——本设计依赖的事件（`session_info_changed` / `thinking_level_changed` / `queue_update` / `message_end` / `entry_appended`（扩展路径））真实发射（fixture 触发实测）；③ entry 面——`get_entries` 返回的 entry 类型 union 穷举覆盖 reducer 的 case（漏类型 = 编译期 exhaustive 报错，ADR-0037 手法）。
2. 接线到升级流程：pi 版本号变更（`packages/runtime/package.json` 的 `@earendil-works/pi-coding-agent` 依赖）时 CI 或本地脚本先跑本契约测试（read `.github/workflows/` 与 `scripts/` 现状后接线到既有版本 bump 检查链，不新建独立流程）。
3. 明确断言边界：`entry_appended` 对 message entry **不发射**是当前契约（D5 探针定论）——契约测试把「25 事件 0 条 entry_appended」固化为断言（上游若补发射，此断言红 → 触发 W21 预留的「换喂入源头」适配，而非静默分叉）。

**验收标准**：

1. 命令级：`cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/pi-protocol-contract.test.ts` 绿；断言含上述三方面且 entry 类型 exhaustive（TS 编译期保证——`tsc --noEmit` 通过即证穷举无漏）。
2. 行为级：本地临时把 fixture 的 pi 版本指到另一个已安装版本（或 mock 一个事件名变更）→ 契约测试红（证明能抓漂移）；还原后绿。
3. 回归：`RUNTIME_TEST` 全量绿；接线点改动不破坏既有 CI workflow（`.github/workflows/` 的 yaml 语法 `python3 -c "import yaml; yaml.safe_load(open(...))"` 校验过或 actionlint 通过）。

---

## 附录 A：路径核实备注（与父文档文件地图的差异澄清）

写本文档时已逐一核实（`ls` / `grep` / `read`），以下差异须在执行时注意：

1. **`rpc-client.ts` / `session-file-utils.ts` 真实路径**：父文档文件地图只写文件名；实际在 `packages/runtime/src/infra/pi/` 下（不在 `services/session/`）。
2. **两个同名 `sessionMetaCache`**：`packages/runtime/src/services/session/session-meta-cache.ts`（sessionId 键，label/thinkingLevel 影子缓存，W9 删除对象）与 `packages/runtime/src/infra/pi/session-file-utils.ts` 内模块级 `const sessionMetaCache`（filePath 键，(mtimeMs,size) 文件头纯派生缓存，D1「保留」类，**任何 wave 不得动它**）。W9 已在步骤中写明防误删。
3. **`pendingBuffer` 位置**：父文档 D1 表称「renderer pendingBuffer」；实际在 `packages/core/src/domain/chat/store.ts:123`（core 包，renderer 经 ADR-0059 薄壳消费）。W14 按真实路径执行。
4. **`countDrained` 已存在**：`packages/core/src/domain/chat/effects/registry.ts:65-84` 已实现计数差集（[B1] 注释）；W14 的实际改动面 = `drainPending`（store.ts:335）的文本匹配删除 + 按条数取，比父文档描述的改动面小。
5. **taste-lint 位置**：仓库根 `taste-lint/rules/*.mjs`（不在 packages 内）；R2/R3 规则落这里（W4/W24）。
6. **pre-commit 本体不在 git 跟踪**：由 `.githooks/install-hooks.sh` heredoc 生成到 `$(git rev-parse --git-common-dir)/hooks/pre-commit`（commondir）；改 checker 接入必须改 install-hooks.sh 并重跑（W3）。
7. **`workflow-state-link` 指针 entry 已存在**：`extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts:455` 已有 `pi.appendEntry("workflow-state-link", ...)`——W17 是形态收敛（指针 → 自描述全量），不是从零接 appendEntry。
8. **record-store 已有 appendEntry 注入通道**：`extensions/subagent-workflow/src/execution/record-store.ts:175/223`（现为 manifest-invalid 上报用）——W16 复用该通道扩展为 record 全量上报。
9. **S1 已上线**：`.agents/skills/pr-cr-fix/agents/review-data-governance.md` 已存在且已入 SKILL.md 8 维 batch2（已核实）——P0 无 S1 接入 wave，与父文档 P0.3 一致。
10. **`get_messages` 已标 DEAD**：`rpc-client.ts:511` 标注 `[DEAD]`，getHistory 实际走 `getEntries` entry 树重建——W20 重放路径以此为准。
11. **xyz 指向 pi JSONL 的写点全集（r3 审查补漏后收口，写本文档时全量 grep 实测）**：`persistSessionName`（session-file-utils.ts:415，写点 openSync('a') :427；调用 = 活跃 rename session-lifecycle.ts:296 / 非活跃 :302 / tryPersistLabel session-service.ts:1284）、`persistHandedOff`（:452，写点 :464；调用链 handoff-service.ts:286 → session-service.ts:1074 markHandedOff（体内 :1080 调用 persistHandedOff），活跃交接 pi 在场）、`patchSessionCwd`（:518，写点 atomicWrite :540；调用 = session-lifecycle.ts:405 restoreSession，pi spawn 前）、`createForkedSessionFile`（`services/session/session-fork.ts:175` writeFile，创建型——调用点 session-lifecycle.ts:532 传 `getSessionsDir()`，失败分支 unlink 清理孤儿）。sidecar 家族（非 pi JSONL，同目录 xyz 自有）：`.meta.json` :146 / `.preset.json` :281 / `.project.json` :223 / `.handoff.json`（W11 迁入后新增，写本文档时无代码——家族全集四后缀对齐父文档 D3b）。自查命令：`grep -rn "openSync\|appendFile\|writeFile\|atomicWrite" packages/runtime/src --include="*.ts" | grep -iv test`（注意：session-fork 在 `packages/runtime/src/services/session/`，不存在独立的 `packages/session/`）。W1/W11/W19 的处置对象以此清单为准，发现新增写点即停止上报。

## 附录 B：父文档验收场景 × wave 对照

| 父文档场景 | 验收 wave | 说明 |
|---|---|---|
| 场景 1 前半（手动命名不被覆盖） | W1 | P0 可先行验收 |
| 场景 1 后半（非活跃改名 + R1 代码断言） | W11 | P1 |
| 场景 2 前半（断连自愈 state 类） | W7、W8、W12 | 分三步累积验收，W12 收口 |
| 场景 2 后半（renderer 一致性） | W13 | P2 |
| 场景 3（重开一致性） | W20、W21 | P3，W21 全量验收 |
| 场景 4（预防拦截三层） | W3、W4（机器层 ①②）、S1 常驻（③语义层，pr-cr-fix 既有能力） | P0；③ 的验证 = 跑一次 pr-cr-fix review 流程 |
| 场景 5（subagent 单源一致 + 混沌） | W16、W18 | P3 |
