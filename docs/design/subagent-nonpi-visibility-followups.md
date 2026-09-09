# 非 pi 引擎 subagent 可见性收尾：终态回填 + ①级空视图降级

> **一句话结论**：drawer 空白修复（`docs/design/subagent-drawer-blank.md`，已交付）兜住了「打开时读链空」的症状，但非 pi 引擎 subagent 还有两个机制级缺口——**运行中打开的 tab 终态后永不回填**（renderer 缺一个 status watch）与 **core 读取链①级空视图不降级**（②级已有判空语义，①级缺对称判定）。本文档设计这两个缺口的修复，外加 B 修复引入的占位 assistant 对 drawer 思考行判定的连带保护（§3.3 D6），一次实现、同批验收。

- 层声明：本文档是「可实现技术方案」层，下一层产物 = 可实现的代码任务（单元拆分见 §5）。
- 来源：`docs/todo/subagent-nonpi-terminal-reload.md`（缺陷 A，2026-08-25）+ `docs/todo/subagent-core-native-empty-view-degrade.md`（缺陷 B，2026-09-08，drawer-blank §11 ⛔3）。两 todo 的修复草案经本文档整合升级，锚点已按 2026-09-09 代码现状重新核实（SubagentTab 数据编排已下沉 `useSubagentTabData` composable，todo 原文行号部分漂移，以本文档为准）。
- 行号锚点：基于设计基线 6071fa8bf；实现后 core 侧行号整体漂移约 +10（pi 早退 :488 / 降级判定 :505-516 / 占位消费 :460 / 常量 :73），按语义定位。

## 1 背景与目标

### 1.1 SCQA

- **S（情境）**：xyz-agent 的 subagent 可由多引擎执行。pi 引擎子进程 stdout 经 relay-tee 实时广播，drawer tab 有逐字实时流；zcode 等非 pi 引擎走 app-server 常驻形态，无实时流通道——设计裁决（`docs/architecture/subagent-engine-gui-visibility.md` D7）是「终态渲染 + 运行中如实提示，不伪造流」。
- **C（冲突）**：drawer-blank 修复给「打开时读链空」加了客户端兜底（outcome 投影 + task 种入），但两个机制缺口仍在：①运行中已打开的 tab，任务终态后**内容永远停在打开时刻的快照**——占位内容比空白更误导（用户以为任务只做了这么多）；②core 读取链对「读成功但零内容」的①级视图直接放行，③级 outcome-only「详情页至少有 task/结果」的恒非空设计意图在中段窗口失效。
- **Q（问题）**：如何让非 pi subagent 的 drawer 视图在其生命周期内**自动**收敛到真实内容，且读取链对已知 record 永不交出「空壳投影」？
- **A（答案）**：renderer 侧补一个「非 pi record 终态跨越 → 重拉一次」的响应式桥（缺陷 A）；core 编排层给①级补上与②级对称的「无实质内容 = 本级不可用」判定（缺陷 B）。两处都是既有机制的对称补齐，不引入新协议面。

### 1.2 目标

| # | 目标 | 回溯来源 |
|---|------|----------|
| G1 | 非 pi subagent 运行中打开 drawer tab，任务终态后 tab **自动**显示完整对话（task + assistant 含 toolCalls），无需切换或手动刷新 | todo A §4 场景 1 |
| G2 | 非 pi subagent 任意生命周期时刻，`session.getSubagentHistory` 对已知 record 返回**带实质内容或占位 assistant 的投影**，不再交出「仅 task」的空壳视图；drawer 详情与**显式非 pi 引擎的** agentcall 快照两个消费面同批受益（pi 引擎 agentcall 走 pi 自有 JSONL 直读链，`session-view-service.ts:478` 早退，本修复对其零影响） | todo B §5 验收 1-3 |
| G3 | pi 引擎行为零变化（D5 守护）：实时流照常、终态无多余 reload、读取链不走非 pi 分支 | todo A §4 场景 3 |

### 1.3 In / Out of scope

**In scope**：

- renderer：`SubagentTab.vue` 新增 status watch（终态回填桥）+ `useSubagentThinking.ts` 思考行判据排除占位 assistant（D6）+ 对应测试矩阵。
- shared：占位文案常量 `SUBAGENT_OUTCOME_PLACEHOLDER`（三端锚点，D6）。
- core：`session-view-service.ts` 编排层①级判空降级 + 读取链测试矩阵。
- runtime：既有读取链套件补 defined-empty 降级用例（契约钉子，§5.2）。

**Out of scope**（防 scope 膨胀，逐条裁决见 §3.3）：

- 不给非 pi 引擎做运行中实时流/轮询冒充流式（D7/D12 已裁决伪造流是反模式；统一实时面是阶段 3 预留，AgentEvent 为唯一实时面）。
- 不改 pi 路径任何行为（D5）。
- 不加「刷新按钮」类 UI（终态自动回填后无主动刷新需求场景）。
- 不做「已知 record 读链永不返回空」的 runtime 协议层不变量收敛（todo B §4 收敛方向：含③级合成推广到 pi `!sessionFile` 窗口 `session-records.ts:316`，与本批同主题但跨协议层，登记为后续批次）。

## 2 现状与问题分析

### 2.1 背景知识：非 pi subagent 的三窗口模型

一个 zcode subagent record 的 drawer 视图随生命周期经历三个窗口（权威描述：drawer-blank 设计 §5.1）：

| 窗口 | 触发条件 | 当前 drawer 形态 |
|------|----------|------------------|
| A | create 应答未回（record 无 engineHandle） | ③级 outcome-only 占位（task + 占位 assistant） |
| B | engineHandle 已回填、首个 assistant content 未持久化 | ①级空视图投影（**仅 task 气泡**；实时思考行由 entry 帧 E-4 兜底链投影） |
| C | 真实内容已持久化 | ①级真实内容 |

数据前提（2026-09-08 dated 修正，todo A §2.3）：zcode 已迁 app-server 常驻形态（C-ext-20），运行中 text_delta 流水进 journal、①级 native reader mid-run 即可读——窗口 B 是「send 后、首个 assistant content 持久化前」的窄窗口，非「全 running 期」。窗口 A/B 的兜底（seed/占位）已由 drawer-blank 分支交付；本批修的是「窗口 B 的空壳投影本体」与「跨窗口无自动收敛」。

### 2.2 缺陷 A：运行中打开的 tab，终态后不回填

**现状**（真实代码，2026-09-09 核实）：

- drawer tab 的数据加载是**一次性的**：`SubagentTab.vue:250-257` 的 `watch(selectedSubagentId)` 只在虚拟 id 变化时触发 `loadSubagentData`（实现在 `useSubagentTabData.ts:95-160`：一次 `fetchAndInject` 拉历史快照 + 恒订阅 `subagent.stream_delta`）。此后无任何重拉/轮询/终态回填机制。
- record 终态的下行链路**是通的**：引擎 run resolve → 宿主 finalize record（status 迁终态）→ runtime `invalidateRecordEntries` → `applyRecordEntries` publish `session.subagents` 全量帧 → renderer `route-inbound.ts` → `subagentStore.applyRecords`（`stores/subagent.ts:139`）。SubagentTab 内的 `currentRecord` computed（`SubagentTab.vue:207-214`）响应式跟随——标题状态、coarse hint 可见性都正确更新，**唯独对话流分区（chatStore 虚拟分区）不重拉**。
- 结果：coarse hint 消失了、标题状态变了、内容停在打开时刻。「终态后打开」路径正常（watch vid 触发首拉，journal 已有内容），只有「运行中打开、等终态」路径断链。

**根因**：不是渲染 bug，是 SubagentTab 缺一个「非 pi record 终态跨越 → reload」的响应式桥。两个入口（对话流 block / 侧边栏 item）代码路径完全等价（同汇 `drawerControl.setSubagentView`），与入口无关。

**已确认的复用件**（全部无需改动）：

- `loadSubagentData` 幂等可重入（`useSubagentTabData.ts:95-160`）：`loadError` 先置 null；`fetchAndInject` 全量 `setMessages` 覆盖；`subscribeStream` 内部先 `stopStream(scope)` 再挂新 handler。
- 终态 reload 时 drawer-blank 的两个空历史兜底零冲突：①outcome 投影、②task 种入共用「分区空」守卫（`useSubagentTabData.ts:102-135`），终态 reload 拉到非空历史 → 两守卫都不触发。
- `coarseHintVisible`（`SubagentTab.vue:226-230`）随 status 变化自动消失，与 reload 无时序依赖。

### 2.3 缺陷 B：①级空视图不降级（①②级判定不对称）

**现状**（`packages/subagent-core/src/execution/engine/common/session-view-service.ts`，2026-09-09 核实）：

三级降级主入口 `readSubagentHistoryMessages`（:473-500）的降级语义：

- ①级：`reader(handle, dataDir)` 返回 `undefined` = 读失败/不可达 → 降②级（:495-496）。**但读成功而零内容时返回 defined 空视图，:496 `if (native !== undefined) return sessionViewToMessages(native, record)` 直接放行——无内容检查、不降级。**
- ②级：`replayEventsToHistory` **已有判空**——「有内容 turn（text/thinking/toolCalls 任一非空）才投影；全空 → undefined 降③级」（:241-292，`hasTurnContent` :294-296；`readJournalTier` :193 注释「返回 undefined = 本级不可达 / 重放无内容」）。
- ③级：`outcomeOnlyMessages`（:433-456）恒非空（task 前置 + assistant 占位无条件 push，「详情页至少有 task/结果」:431）。

**窗口 B 的空壳链路**（证据链，todo B §2 逐点已核）：

1. zcode `collectTurns` 只收 assistant 消息（`engines/zcode/reader.ts:294`，「user 消息（任务 prompt）不进 turns」）——send 后、首个 assistant content 持久化前 turns 恒 `[]`。
2. `buildView` 对零消息 session 正常返回 `{ turns: [], source: 'native' }` 不抛错（reader.ts:307-324）。
3. 编排层 :496 defined 即返回——空 turns 投影 `sessionViewToMessages` → `turnsToMessages` 仅前置 task（:362-370），产出 `[task]` 单条。
4. mid-run record 恰好携带①级钥匙（engineHandle 运行中回填，`subagent-service.ts:2156` backfillEngineHandle）——窗口与缺陷重合。

**受影响面**：`readSubagentHistoryMessages` 是 core 导出的唯一生产读取链，runtime 侧经 `subagent-engine-history.ts:59` 薄封装，消费面有两个——drawer 详情（renderer `fetchAndInject` → `session.getSubagentHistory`，`stores/subagent.ts:261`）与 agentcall 快照（runtime `getAgentCallHistory` 复用同函数，`session-records.ts:447`）。drawer 表面的症状已被 drawer-blank 修复兜住，但「仅 task」空壳投影对所有消费方生效且③级恒非空的设计意图在此窗口失效——按消费方各自兜底不可持续（todo B 的核心论点），缺陷本体在 core 读取链。

### 2.4 物理数据流（修复涉及的两段）

```
缺陷 B 修复面（core 编排层，运行中读取）：
zcode sqlite (①native reader) ──turns:[] 空视图──┐
zcode journal (②replayJournal)                  ├→ readSubagentHistoryMessages 编排层
record 快照 (③outcomeOnly) ←── ①空→②空→③占位 ←──┘
        │
        ▼ runtime subagent-engine-history.ts:59
WS session.getSubagentHistory 回包 → renderer fetchAndInject → chatStore 虚拟分区

缺陷 A 修复面（renderer 响应式桥，终态收敛）：
引擎终态 → 宿主 finalize → runtime applyRecordEntries
  → WS session.subagents 帧 → subagentStore.applyRecords
  → currentRecord 变化 ──[新增 status watch：非 pi × running→终态]──→ loadSubagentData(vid) 重拉
  → fetchAndInject 走上图读取链（此时①级有真实内容）→ setMessages 覆盖分区 → MessageStream 重渲染
```

两缺陷在「终态后的 reload」汇合：A 的 watch 触发重拉，重拉走 B 修复后的读取链。B 先修 A 后修（或同批）都能让终态回填拿到非空视图；若只修 A 不修 B，终态任务若真实内容读取异常，A 的 reload 还会落③级占位（不白屏）——两修复叠加后兜底链完整。

## 3 解决方案

### 3.1 终态（使用者视角）

**成功路径**：用户在主 agent 派发 zcode subagent 后，从对话流 block 点开 drawer tab——看到 task 气泡与「进行中」指示（ActivityStrip 思考行随 D6 判据触发；TurnMeta「工作中」行由 forceWorking 独立驱动，两信号并存互不干扰）。任务继续跑，用户无需任何操作。任务终态后，tab **自动**变为完整对话：task、assistant 回复、toolCalls 全部就位，coarse hint 已消失，标题状态已翻转。关掉重开 session 再点开同一 subagent，内容一致（快照同源）。

**失败路径**：zcode 任务 failed → 已打开的 tab 自动回填错误态内容（错误文本随 journal/投影可见）；若读取链三级全异常，客户端 outcome 投影兜底（`subagent-outcome-summary` testid），详情页不白屏。恢复动作：无——兜底链保证至少可见 outcome；用户可点 retry 按钮重拉（既有入口，仅错误态渲染）。

**运行中窗口 B 的形态变化（B 修复引入，显式裁决见 §3.3 D4/D6）**：修复前窗口 B 的 drawer/runtime 读取返回 `[task]`；修复后返回 `[task, 占位 assistant]`（占位文案 `"(no outcome recorded)"`，③级既有实现）。该形态与窗口 A 对齐（窗口 A 无 engineHandle 直接落③级占位，是既有生产行为），③级「详情页至少有 task/结果」的意图在全窗口恢复。占位 assistant **不得熄灭** drawer-blank 已交付的思考行改进（窗口 B「末位无 assistant → 思考行触发」是其 T3 断言钉死的已交付行为）——renderer 思考行判据同步排除占位（D6）。运行中看到「无结果记录」占位语义可接受——任务在跑、结果未定，如实呈现优于空壳；终态后被 A 的 reload 用真实内容替换。

### 3.2 方案对比

#### 缺陷 A（终态不回填）

| 候选 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|----------------|--------------|------|
| **A1（推荐）：SubagentTab 组件内 status watch** | 视图收敛逻辑归视图层（谁展示谁重拉），复用幂等 `loadSubagentData`，不新增协议面；未来其他非 pi 引擎接入自动受益（判据是引擎无关的「非 pi × 终态跨越」） | 一个 watch + 守卫，约 20 行 + 测试 | watch 守卫写错会在 vid 切换时误触发加载风暴——测试矩阵覆盖（切换/已终态/pi 波动四类反例） |
| A2：subagentStore.applyRecords 内集中处理 | store 层不知道哪个 vid 正被 drawer 查看（需要反向依赖 drawer 状态），职责越界；且 agentcall 视图无 record status 概念，判定分裂 | 看似集中实则要引入查看态查询 | store 与 UI 耦合，违背 store 纯状态机定位（`stores/subagent.ts` 头注「自治，不经 store viewing 状态机」） |
| A3：runtime 新增「终态回填帧」主动推 | 新协议帧只服务一个 UI 场景，协议面膨胀；renderer 端依然要写处理逻辑，总成本更高 | 协议 + runtime + renderer 三层改动 | 违反「EventAdapter 是唯一适配点」边界内做重活；后续若统一实时面（阶段 3）该帧即废 |

若用 A2：§2.2 的「当前选中 tab 不重拉」问题移进 store，但 store 需感知「drawer 正在看谁」——引入跨域状态，subagent store 变成有 UI 副作用的状态机。若用 A3：协议面多一种帧，其语义与既有 `session.subagents` 全量帧重叠（record 已终态的事实已在帧里），缺的只是 renderer 的响应——重活全在发送侧。

#### 缺陷 B（①级空视图不降级）

| 候选 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|----------------|--------------|------|
| **B1（推荐）：编排层补①级「无实质内容 = 本级不可用」判定** | 与②级既有语义（`hasTurnContent` 全空 → undefined 降③）完全对称，一处改动覆盖全部引擎 reader（未来引擎接入自动获得判定）；降级链语义统一为「每级交不出实质内容就往下走」 | 编排层一处判定 + 测试矩阵，约 10 行 + 测试 | 判据过宽会误降级（真实内容被判空）——判据对齐②级 `hasTurnContent` 语义（text/thinking/toolCalls 任一非空），测试矩阵覆盖「非空不降级」反例 |
| B2：各 reader 自己判（zcode reader 空 turns 返回 undefined） | 「空 = 不可用」语义塞进 reader，「读成功但没内容」与「读失败」两种含义共用 undefined，信号变味；每个新 reader 重复实现，漏判风险分散 | zcode reader 一处改动 | 看似更小，实为把编排层职责下沉——②级的判空就在编排层（`replayEventsToHistory`），①级下沉产生新的不对称 |
| B3：renderer 再加一层兜底 | 客户端已有两层兜底（outcome 投影 / task seed），第三层 = 兜底叠兜底，消费方各自兜底不可持续（todo B 核心论点） | renderer 持续膨胀 | 根因留在 core，下一个消费方（agentcall 快照、未来摘要卡）继续裸奔 |

若用 B2：§2.3 的空壳链路对 zcode 关闭，但未来引擎接入时若 reader 作者漏判，空壳回归——判定权应集中在编排层（唯一降级编排点）。若用 B3：本批两个消费面被兜住，但 core 缺陷本体仍在，「runtime 读链永不交空壳」的收敛方向（todo B §4）永远差第一步。

### 3.3 关键决策

| # | 决策 | 选择 + 被否 + 证据 |
|---|------|--------------------|
| D1 | **终态判据 = status 脱离 `'running'`**，不逐枚举终态值。`SubagentStatus` 六值全集由 shared `SUBAGENT_STATUS_ALL` 元组锁死（`packages/shared/src/subagent.ts:41-63`，扩枚举编译锁）；终态 = 非 `'running'` 全集，shared 扩「进行中类」新值时 watch 判据需同步评估（该文件的扩枚举守卫注释已要求消费方同步）。**不基于 record.status 判 core 降级**（缺陷 B）：status running 不代表视图空（app-server 形态 mid-run 已有部分 turns），终态也不代表非空——降级判据必须基于数据本身（§3.2 B1 判据），与状态解耦 | 被否：逐枚举 `'done'|'failed'|...`——shared 扩值即漏判，且 todo A §3.2 已核 v4 语义 pi record 有 done→running→done 故意波动（轮终回写 running 等待续聊），枚举式判据在波动下行为脆弱 |
| D2 | **watch 四重守卫**：①vid/subId 变化 = 切换 subagent，跳过（新 vid 由既有 `watch(selectedSubagentId)` 负责）；②仅 `prev.status === 'running' && cur.status !== 'running'` 的跨越触发（打开时已终态由首拉覆盖）；③非 pi 守卫（`recordEngine(record) !== DEFAULT_ENGINE_ID`，缺省映射 pi 与 runtime `extractRecordEngine` 同语义）；④触发后调 `loadSubagentData(cur.vid)` 一次，不重试不轮询（读链三级降级 + 客户端兜底已保证不白屏，reload 失败走既有 loadError 态） | 被否：无守卫裸 watch——vid 切换时 record 短暂 undefined→defined 的中间态会误触发；pi 波动（done→running→done）会被③守卫天然拦下，双重保险 |
| D3 | **①级降级判据 = native 视图 turns 无实质内容**（对齐②级 `hasTurnContent`：text/thinking/toolCalls 任一非空；逐 turn 判定，全部为空 = 本级不可用）。判定点在**编排层**（`readSubagentHistoryMessages` 内、:496 放行前），不改任何 reader | 被否：`native.turns.length === 0` 粗判——「turns 非空但全空内容」的退化形态（截断/被杀残留）会漏判，②级同形态已按实质内容判定（`replayEventsToHistory` :258 `contentTurns`），对称照抄；被否：reader 内判（§3.2 B2） |
| D4 | **窗口 B 形态变化接受 + 思考行连带保护**：`[task]` → `[task, "(no outcome recorded)" 占位]`（§3.1 已述），占位进分区后由 D6 保证思考行不熄灭。占位文案硬编码英文是 core 双端复用约束（不 import i18n）下的既有现状（窗口 A 已如此显示），本批不改文案本身，仅常量化（D6）；客户端兜底用的 i18n 文案（`panel.sideDrawer.subagentNoOutcome`）与此并存，统一文案留收敛方向。**重审触发条件**：锚 §5.3 P1 实测——若真机实测显示窗口 B 覆盖 running 期大半程（而非「首个 assistant content 持久化前」的窄窗口），占位形态从「如实呈现」变质为「长时间误导」，回本决策重审（候选出路：mid-run 占位文案特化或③级 mid-run 投影收缩） | 被否：mid-run 特化占位文案（「运行中…」）——③级被设计为 record 字段的恒定投影，按 status 分叉判定复杂化，且 core 无 i18n；收益仅文案语义，不值 |
| D5 | **pi `!sessionFile` 空数组（`session-records.ts:316`）不在本批**：那是 pi 自有直读链的独立窗口，收敛方向（③级合成推广）已在 todo B §4 登记，属协议层不变量收敛批次 | —— |
| D6 | **renderer 思考行判据排除占位 assistant**：`useSubagentThinking.ts` 的 `subagentThinking`（现判据 `turn === null \|\| turn.assistants.length === 0`）扩展为「末位 turn 无 assistant **实质产出**」——占位 assistant（content === 占位常量）不计入产出。占位出现条件口径：③级投影 content = `record.result ?? record.error ?? 占位`（:450 三选一），**占位常量仅在 result/error 双空时出现**——failed record 的 error 文本是真实产出，判据下思考行正确熄灭；若未来③级扩展改变该口径（如 error 也走占位文案），本判据须同步重审。占位识别用 shared 新常量 `SUBAGENT_OUTCOME_PLACEHOLDER`（值 `'(no outcome recorded)'`，与 core ③级 `outcomeOnlyMessages:450` 字面量同值）：core 生产代码不 import shared（双端复用约束），本地字面量 + 锚定注释，同值漂移由 runtime 读取链套件的行为断言守护（③级投影占位 content === shared 常量，`subagent-extractor-engine.test.ts` 消费，fixture 须 result/error 双缺）。判据与 D3「实质内容」同构：core 判 turn 内容非空，renderer 判 assistant content 非占位。TurnMeta「工作中」行不受影响（`computeIsStreaming` 由 forceWorking 独立驱动，`message-turns.ts:345`） | 被否：renderer 直接字符串匹配 `'(no outcome recorded)'` 字面量——跨包文案耦合，core 改文案即静默漂移；被否：接受思考行熄灭——撤销 drawer-blank 已交付的「窗口 B 思考行触发」真实改进（其 §5.1 :113 / T3 断言钉死），方向反了；被否：占位消息加判别字段（placeholder?: true）——core 类型 + runtime 透传 + shared Message 四层改动，对「思考行指示」一个细节过重 |

## 4 验收（真实场景）

> 验收环境：真机 `pnpm dev`（Gate B）。隔离栈经验：vite 1421 / runtime 3410 / CDP 9225，独立数据目录，启动前 `env -u ELECTRON_RUN_AS_NODE`；`defaultEngine=zcode` 或派发时显式 `engine: "zcode"`。单测矩阵（§4.1）是 Gate A 支撑证据，不替代本节。

### 4.1 单测矩阵（Gate A 支撑，场景 → 用例对应）

| 用例组 | 断言核心 | 三视角落点 |
|--------|----------|------------|
| core 降级矩阵（u1） | ①级空 turns 降级 / 全空 turn 降级 / 有内容不降级 / ①空②空落③级；投影占位 content 与 shared 常量同值（runtime 套件行为断言） | 观察者形态：runtime 契约钉子用例断言 `session.getSubagentHistory` 同链输出非空壳 |
| renderer 回填矩阵（u2） | 非 pi running→终态触发第 2 次 fetchAndInject / pi 零变化 / vid 切换守卫 / 打开时已终态不二次拉 / 切回 A 首拉兜底 | 构建者白盒：watch 守卫逐条断言；使用者黑盒：每用例至少一个用户可见 DOM 断言（coarse hint 消失 + 终态内容出现在消息流），不只 mock 计数。split 多实例说明：status watch 是组件实例级、各实例各自 vid 互不冲突，`STREAM_SCOPE` 单订阅覆盖为既有语义（`useSubagentTabData.ts:50` 注释），不设专用用例 |
| 思考行占位反例（u2） | 末位 assistant 为占位 → `subagentThinking` 仍 true；真实 assistant → false；非 pi 窗口 B 末位仅 task → true（drawer-blank T3 既有断言不动） | 使用者黑盒：ActivityStrip 思考行可见性 |

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|------------------|------|----------|
| S1 | 终态自动回填（G1） | 主 agent 派 zcode subagent（任务含工具调用，耗时 >30s）→ running 中点对话流 block 打开 drawer → 等侧边栏状态翻转 | tab **自动**出现完整对话（task + assistant 含 toolCalls），全程无切换/刷新操作；coarse hint 自动消失 |
| S2 | 失败路径回填（G1） | 派一个必失败的 zcode 任务（如无效模型）→ running 中打开 drawer → 等终态 | tab 自动回填错误态内容；读链异常时 outcome 摘要兜底可见（`subagent-outcome-summary`） |
| S3 | pi 零变化（G3） | pi subagent 打开 drawer 观察实时流；终态时经 browser-automation 连 CDP 在 `fetchAndInject`（`stores/subagent.ts:261` 的 RPC 调用点）挂临时调用计数断言（验收后移除） | 实时流逐字照常；终态 reload 调用次数 = 打开时 1 次（无多余 reload） |
| S4 | 切换不误触发 + 切回补拉（G1/G3） | drawer 内 subagent A（zcode, running）→ B → A 之间切换；期间 A 终态：①终态时 tab 停留在 A 观察；②终态发生在停留 B 期间，随后切回 A 观察 | ①切换期间无重复加载风暴（vid 守卫生效）；A 终态且停留时正确回填。②切回 A 后内容为完整终态对话（vid 首拉兜底路径，非 status watch） |
| S5 | 重开一致（G1） | S1 完成后关闭重开 session，再点开同一 subagent | 内容与回填后一致（live ≡ reload，快照同源） |
| S6 | 窗口 B 非空壳 + 思考行存活（G2） | zcode subagent running 早期（首个 assistant content 持久化前）调 `session.getSubagentHistory`（dev console 或 browser-automation 执行 RPC）；drawer 同窗口观察 | 返回 ≥2 条消息：task + 占位 assistant（非「仅 task」）；drawer 显示 task + 占位**且 ActivityStrip 思考行仍触发**（D6：占位不算产出，drawer-blank §5.1 窗口 B 行为保持） |
| S7 | 真实内容无误降级（G2） | S6 同一任务终态后，同参数再调 `session.getSubagentHistory`；drawer 观察 | 返回真实内容（①级不降级，内容非占位）；**非 pi 引擎的** agentcall 快照视图（若使用场景存在）同样非空壳 |

## 5 下一层拆分

### 5.1 单元表

| Unit | 职责 | 领地（精确路径） | 依赖 | 隔离 | 验收条款 |
|------|------|------------------|------|------|----------|
| u0-placeholder-const | shared 占位常量 `SUBAGENT_OUTCOME_PLACEHOLDER`（D6 三端锚点；u-foundation 共享契约根节点） | `packages/shared/src/subagent.ts` | 无（DAG 根） | plain | shared 包 typecheck/测试绿 |
| u1-core-degrade | 编排层①级判空降级（§3.3 D3 判据）+ ③级占位字面量换本地常量（锚定注释）+ core 读取链测试矩阵 + runtime 契约钉子用例（defined-empty 降级 + 占位同值断言） | `packages/subagent-core/src/execution/engine/common/session-view-service.ts`、`packages/subagent-core/src/execution/engine/__tests__/common/session-view-service.test.ts`、`packages/runtime/test/subagent-extractor-engine.test.ts` | u0（runtime 断言消费 shared 常量） | plain | §4.1 矩阵绿 + subagent-core 全量绿 + runtime 既有 engine-route/extractor 套件绿 |
| u2-renderer-refill | SubagentTab status watch（§3.3 D2 四守卫）+ `useSubagentThinking` 判据排除占位（D6）+ renderer 测试矩阵 | `packages/renderer/src/components/panel/SubagentTab.vue`、`packages/renderer/src/__tests__/panel/subagent-tab.test.ts`、`packages/renderer/src/composables/panel/useSubagentThinking.ts`、`packages/renderer/src/__tests__/components/MessageStream-subagent-force-working.test.ts` | u0（判据消费 shared 常量） | plain | §4.1 矩阵绿 + renderer 相关套件绿（含 drawer-blank T3 既有断言保持绿） |

拆分理由：u0 是共享契约根（1 常量导出，先落地消除 u1/u2 的并发竞争点）；u1/u2 领地零交集（core+runtime 测试 / renderer 各自成组），u0 就绪后可并行；「终态 reload 走修复后读取链」的汇合点由真机验收（§4 S1-S7）覆盖，不构成 u1↔u2 依赖。**落地顺序约束**：u1 与 u2 必须同批合入（本分支同批 commit 即满足）；若 u1 先于 u2 独立落地，core 已产出占位而 renderer 判据未排除 → 窗口 A/B 思考行短暂熄灭（MF1 场景在中间态复活）——该顺序 breaking 不允许出现。`<script setup>` 行数预算：SubagentTab.vue 现 163 行，新增 watch 约 +20 行，余量充足（上限 300，pre-commit `vue_rules_checker` 强制）。

### 5.2 文件改动地图

| 文件 | 改动 |
|------|------|
| `packages/shared/src/subagent.ts` | 新增导出常量 `SUBAGENT_OUTCOME_PLACEHOLDER = '(no outcome recorded)'`（带锚定注释：core 本地同值、runtime 测试守护） |
| `packages/subagent-core/src/execution/engine/common/session-view-service.ts` | :496 放行前增①级实质内容判定——`SessionView.turns` 元素类型 `ReplayedTurn`（`execution/engine/types.ts:134-140`）逐 turn 判 `text !== '' \|\| thinking !== '' \|\| toolCalls.length > 0`（与②级 `hasTurnContent` :294-296 同语义，全部为空 = 本级不可用降②级）；:450 占位字面量换本地常量（值同 shared，锚定注释） |
| `packages/subagent-core/src/execution/engine/__tests__/common/session-view-service.test.ts` | 新增降级矩阵用例：①级空 turns 降②级、①级全空 turn（非空数组但无实质内容，`closeTurn` 对 step-finish 无条件 push :184-188 + `applyPartToTurn` :278 空 acc 创建——形态代码级可达）降级、①级有内容不降级、①空②亦空落③级（fake reader 注入，`registerNativeSessionReader` 测试口既有） |
| `packages/runtime/test/subagent-extractor-engine.test.ts` | 新增 defined-empty 契约钉子用例：tier1 defined-empty → 非空壳投影；占位 content === `SUBAGENT_OUTCOME_PLACEHOLDER`（shared import，跨包同值行为断言）。fixture 约束：record.result 与 record.error 必须双缺（:450 三选一 `result ?? error ?? 占位`，带任一则断言走不到占位分支、守护空转）——本用例是 core 占位文案漂移的唯一跨端钉子 |
| `packages/renderer/src/components/panel/SubagentTab.vue` | 新增 status watch（紧挨既有 `watch(selectedSubagentId)` :250-257；`currentRecord`/`recordEngine`/`loadSubagentData` 组件作用域均已可用） |
| `packages/renderer/src/composables/panel/useSubagentThinking.ts` | `subagentThinking` 判据扩展：`turn.assistants` 全为占位（content === `SUBAGENT_OUTCOME_PLACEHOLDER`）时视同无产出（D6） |
| `packages/renderer/src/__tests__/panel/subagent-tab.test.ts` | 新增用例：非 pi 终态回填（含 DOM 断言 coarse hint 消失 + 内容出现）、pi 零变化、vid 切换不误触发（含切回 A 首拉兜底）、打开时已终态不二次加载 |
| `packages/renderer/src/__tests__/components/MessageStream-subagent-force-working.test.ts` | 新增占位反例用例：末位 assistant 为占位 → `subagentThinking` 仍 true；真实 assistant → false（drawer-blank T3 既有断言不动、保持绿） |

### 5.3 待验证检查点

| # | 断言 | 状态 | 验证方式 |
|---|------|------|----------|
| P1 | zcode mid-run 早期 journal 无实质内容（②级在窗口 B 返回 undefined）——支撑「①空→②空→③占位」链路推演 | ✅已测（2026-09-09 Gate B） | 真机 7/7 次派发均未观测到「仅 task」或「task+占位」形态（1s 采样，最早在 record 创建后 10-20s 打开 drawer 已读到真实 mid-run 内容）——窗口 B 窄于 UI 反应时延，①②级落点未区分（验收标准对落点不敏感）；**D4 重审触发条件不满足**（占位形态覆盖 running 期 ≈0%，无需重审） |
| P2 | zcode record 终态一次到位，无 running 回写（与 pi v4 波动相反） | ✅已核 | `subagent-service.ts` assertEngineParamSupport 不支持 conversation（todo A §3.2 核）；单测矩阵再守护 |
| P3 | `SUBAGENT_STATUS_ALL` 元组与 watch 判据的同步义务 | ✅已核 | `shared/src/subagent.ts:29-63` 扩枚举守卫注释已声明消费方同步义务，u2 测试矩阵按全集元组取值 |
| P4 | 占位文案三端同值（shared 常量 = core 字面量） | ✅机制已定 | core 生产不 import shared（双端复用约束）→ 同值由 runtime 读取链套件行为断言守护（u1：③级投影占位 content === `SUBAGENT_OUTCOME_PLACEHOLDER`）；core 改文案即 runtime 用例翻红 |

## 6 关联

- 缺陷登记：`docs/todo/subagent-nonpi-terminal-reload.md`（A）、`docs/todo/subagent-core-native-empty-view-degrade.md`（B）——实现落地后回写状态。
- 前序设计：`docs/design/subagent-drawer-blank.md`（§5.1 三窗口 / §6.3 思考行 / §6.7 收敛方向 / §11 ⛔3 缺陷 B 登记）——本设计落地后需同步回写：①§5.1 窗口 B 形态（`[task]` → `[task, 占位]`，思考行行为经 D6 保持不变）；②窗口 A 思考行描述（占位被 D6 判据排除后由「TurnMeta 接管」变为「思考行 + TurnMeta 并存」）；③**T3 测试矩阵行的窗口 A 断言**（「非 pi 窗口 A/C 末位有 assistant → false」→「末位有**非占位** assistant → false」——代码断言 D6 下不翻转，文档级断言措辞须同步修订）（文档回写批次）。
- 架构依据：`docs/architecture/subagent-engine-gui-visibility.md` D5（pi 零变化）/ D7（终态渲染 + coarse）/ D12（统一实时面是阶段 3）。
- 后续收敛（不在本批）：「已知 record 读链永不返回空」runtime 协议层不变量 + ③级合成推广到 pi `!sessionFile`（todo B §4；`session-records.ts:316`）；占位文案 i18n 统一（D4 尾注）。
