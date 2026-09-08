# subagent-drawer-blank 一致性审查 R2（HEAD 终态全量对照）

> 行号锚点说明：本报告全部 file:line 为审查时点（HEAD = 1d6d5e755 之后、本报告提交前）快照，后续 commit 可能使其漂移，以实读源文件为准。

> 审查基线：HEAD = 1d6d5e755（终态全量对照，非 diff 区间）。审查对象：设计 v6（subagent-drawer-blank.md）/ impl-plan v3 / docs/todo/subagent-nonpi-terminal-reload.md（2026-08-25 登记 + 2026-09-08 排期更新）/ docs/todo/subagent-core-native-empty-view-degrade.md。
> 方法：四份文档全文精读 + 五关系逐章比对 + 反引号标识符/行号锚点逐一 grep 核实 + 相关测试套件实跑（renderer 全包 4082 passed | core chat 641 passed | 五个 drawer-blank 相关文件 64/64）。
> 结论速览：**must-fix 0；suggestion 2（F1/F2）；info 6（F3-F8）**。机制层（设计 §7 三处改动）与追踪链双向闭环全部成立，遗留问题全部是文档侧锚点/簿记卫生。

## 1. 五关系逐条结论

### 关系 a：代码 ↔ 设计 v6 —— 机制层未发现；2 条 info 行号漂移（F3/F4）

- **§7 三处机制完整实现**：
  1. `packages/renderer/src/stores/subagent.ts:255-266` fetchAndInject 签名返回 `Promise<Message[]>`、`history.length > 0` 才 setMessages（空不擦）、W2/M5 fail-fast throw 保留；调用方唯一（`useSubagentTabData.ts:101`，非测试代码 grep 全仓唯一）——与 §7.1「调用方仅 drawer 编排层一处」吻合。
  2. `packages/renderer/src/composables/panel/useSubagentTabData.ts:103-131` 判定顺序即优先级：①outcome 先行（:110-116，非 pi && 分区空 && result/error 有值）②task 种入随后（:118-128，分区空 && task 非空，id `task-u-<subagentId>`、role user、status complete、timestamp `record.startedAt ?? Date.now()`），①命中或 E-4 已投影靠分区空守卫自然跳过——与 §7.2 逐字对应。
  3. `useSubagentThinking.ts`（forceWorking 窄口径 + 末位 turn 无 assistant）→ `MessageStream.vue`（useSubagentThinking 调用 + prop 传递）→ `ActivityStrip.vue`（thinking 行条件 `!compacting && !executingBash && (turn==='dispatching' || subagentThinking)`）——与 §7.3 一致；i18n 复用 `panel.message.dispatching`（zh `思考中…` / en `Thinking…`，`packages/renderer/src/i18n/locales/zh-CN/panel.ts:81` 与 en-US 同位）零新增。
- **§5.1/§5.2 终态不回填声明**：与代码现实一致——`SubagentTab.vue:250-256` watch(selectedSubagentId) 一次性加载、无 status watch；`subagentEntriesAppended`/`subagent.stream_delta` 两帧唯一发出点 `packages/runtime/src/infra/relay/relay-tee.ts`（:121/:172/:190，pi stdout relay 专用），非 pi 确无实时腿。
- **§6.7 四层兜底**：四层全部实存——runtime ①级 task 前置（`packages/subagent-core/src/execution/engine/common/session-view-service.ts:362-369`）/ runtime ③级 outcome-only（同文件 :433，:431 注释「永不返回空数组」）/ renderer outcome 投影（useSubagentTabData.ts:70-85）/ renderer seed（:118-128）。
- **§2 Out-of-scope（agentcall ⛔4）与代码一致**：`useSubagentTabData.ts:134-138` agentcall 分支无条件 `setMessages(vid, history)`、无任何兜底——同症状不同源缺口如实登记。
- F3/F4：§5.1/变更历史两处行号锚点 ±1 漂移（见 findings）。

### 关系 b：现实 ↔ impl-plan v3 —— 状态表/偏差/测试数字全部吻合；2 条簿记级（F1/F7）

- 状态表 5 个 hash 全实存且内容吻合：d74bdeabc（设计 v5+impl-plan 基线）/ 3bfe6069a（u1+u3，含 useSubagentThinking 提取 + ActivityStrip.test.ts 新建）/ 4000fe668（u2）/ 35df7b5f4（u4 翻转）/ 39380202d（u5-gateb electron 两处）。header 引用的 6d5d75870（首提后 amend）亦实存。
- 状态表测试数字**实测复现**：T1 `subagent.test.ts` 35/35 绿；T2 `useSubagentTabData.test.ts` 7/7 绿；T3/T4 9/9（force-working 6 + ActivityStrip 3）；u4「:447 0→1 turn」与「:431 outcome 同屏保持绿」两个行号锚点与测试文件实际 it() 行**精确吻合**；renderer 全包 4082 passed、core chat 641 passed 均实跑复现。
- 偏差登记 4 条与实际 diff 一一吻合：#1 ActivityStrip.test.ts 新建（3bfe6069a）/ #2 useSubagentThinking.ts 新建（3bfe6069a；MessageStream script setup 现 297 行，「提取后 297 行」精确）/ #3 seed 守卫含 `history.length === 0`（useSubagentTabData.ts:118-120，被 u1 蕴含等价性成立）/ #4 XYZ_VITE_DEV_URL 覆盖（window-factory.ts:26）+ main.ts userData 从 XYZ_AGENT_DATA_DIR 派生（main.ts:126-132，M3 修复后注释锚「§8.2」正确）。
- 变更历史 v1/v2/v3 完整，与 commit 链（3bfe6069a→4000fe668→35df7b5f4→39380202d→d42702710→271bf246d→1d6d5e755）对得上。
- F1（单元表缺 u5-gateb 行）/ F7（header 来源设计仍标 v5）见 findings。

### 关系 c：impl-plan 内部 —— 除 F1 外未发现

§0 章节映射 ↔ §7 残留风险 ↔ 偏差表三处 ⛔3/⛔4 表述一致；u4 验收条款行号锚（:447/:431）与测试文件吻合；偏差 #3 与设计 §7.2 的守卫差异按偏差机制正确登记。未发现其他自相矛盾。

### 关系 d：注释口径 —— 除 F6 外全部一致

- `useSubagentThinking.ts` 头注：窄口径判据、§6.3 occupancy SSOT 裁决、lastRenderTurn 形参注入——与实现一致。
- `useSubagentTabData.ts` 头注：u1 契约 / E-4 R3 消解恒订阅 / U4 A8 判定先行 / u2 seed 判定顺序 / agentcall D4 快照只读 + MUST_FIX 1 清理映射——逐条与实现一致。
- `ActivityStrip.vue` 头注 + 行内注释：thinking 行扩展条件及 §6.3 出处——与实现一致。
- `subagent.ts` fetchAndInject docstring：返回 history、空不擦（§6.2 引用）、fail-fast——一致。
- `window-factory.ts:22-26` / `main.ts:129-132`：注释与实现一致（含 M3 修复后的「设计 §8.2 验收场景」锚）。
- 设计引文核对：chat store `setMessages` 注释「直接覆盖…不受 hydrated 守卫」（`packages/core/src/domain/chat/store.ts:609`）、E-4「帧先于 drawer 打开到达时也写分区」（`useMessageEffects.ts:92`）、TurnMeta「v-if 收窄 assistants.length > 0 + 思考中指示迁 ActivityStrip」（`packages/ui/src/features/chat/TurnMeta.vue:8/:89`）、STATE_TYPE_KEY_MAP 含 `session.subagents`（`message-bus.ts:153`）、applySubagentStreamDelta 无 streaming 实体 push 新实体（`streaming-state-machine.ts:166-175`）——全部实存且引义准确。
- F6：`SubagentTab.vue:9-10` 头注「fetchAndInject 拉历史注入虚拟分区」未反映 u1 条件注入语义（info）。

### 关系 e：追踪物互链 —— 双向闭环全部成立；过时锚点 F2/F5/F8

- 设计 §5.1 变体末「终态不回填」↔ nonpi todo 排期更新（2026-09-08「紧随 fix-subagent-drawer-blank 分支合并后实施」）：双向引用实存、状态一致（todo 引「§5.1 变体末 v6 互链」；设计引 todo「2026-08-25 已登记 + 排期紧迫性上升」）；impl-plan v3「后续排期建议：优先落地 subagent-nonpi-terminal-reload.md」与之同向。修复草案描述（record status 跨越 watch 终态 reload、机制零冲突）两侧表述一致。
- 设计 §11 ⛔3 ↔ core todo：双向互链实存（todo §6 引「设计 §11 ⛔3 + review.md Round 2 反例」，实核 review.md:120/:121 反例本体在案）；「独立排期、不阻塞合并」两侧一致。
- core todo §7 排期评估 ↔ nonpi todo 排期更新 ↔ impl-plan v3：同批/紧随口径一致。
- F2（nonpi todo §2.3 zcode 形态叙事过时 + 悬空路径）、F5（core todo §4 行锚不精确）、F8（review.md 快照锚点无声明）见 findings。

## 2. Findings

### F1
- **id**: F1
- **location**: docs/design/subagent-drawer-blank.impl-plan.md §2 单元列表（对照 §5 偏差 #4 :64、§6 状态表 :74、§7 变更历史 v2 :82）
- **gap**: 单元表无 u5-gateb 行。sync-review.md（M2 修复计划，:102）明确要求「单元表+状态表增补 u5-gateb 行」且验收判据「表内三处一致」；现状仅偏差表与状态表两处有 u5-gateb，单元表缺失。而 impl-plan v2 声称「M1-M4 即其修复（全修）」——M2 未完整落地，声明与现状不符。
- **direction**: doc-right
- **severity**: suggestion
- **rationale**: u5-gateb 是 committed unit（有独立 commit 39380202d 与 Gate B 验收证据），单元表是领地 SSOT；缺行使 u5 的领地/验收条款无处落表，后来者按单元表导航会漏掉该 unit 的验收锚。实测确认状态表与偏差表均在、唯单元表缺。
- **fix-hint**: 单元表增补 u5-gateb 行（领地 = apps/electron/main/main.ts + window-factory.ts，验收 = 设计 §8.2 S1-S5 真机）；或若刻意不把 Gate B 增补算作 unit，则在状态表该行加注「不入单元表」理由，并回改 sync-review M2 的「三处一致」表述。

### F2
- **id**: F2
- **location**: docs/todo/subagent-nonpi-terminal-reload.md §2.1（extensions/.../subagent-service.ts:1415）、§2.3（launcher.ts / zcode-engine.ts:233,335 / 三级读链全返回空 / journal 终态才写入）、§3.2（assertEngineParamSupport :1495-1502）
- **gap**: 根因叙事的 zcode 形态描述与 HEAD 已脱节：①`extensions/universal/subagent-workflow/src/execution/` 目录已删除（执行层物理迁 packages/subagent-core，commit 48ae09ba4），:1415 为悬空路径——record id 生成现于 `packages/subagent-core/src/execution/subagent-service.ts:1942`；②「spawn 形态 node zcode.cjs --json one-shot（launcher.ts）」已删——现为 app-server 常驻形态（`.../zcode/appserver-launcher.ts`，C-ext-20 单一 app-server 形态）；③「运行期间无事件流可 tee / journal 终态才写入」过时——zcode app-server 推送流实时流出 text_delta（zcode-engine.ts:179）且 journal 运行中记真实流水（:339）；④「三级读链全返回空」与本 HEAD 的设计 §5.1 窗口 B / core todo §2 相矛盾（①级 defined-but-empty → turnsToMessages 返回 [task] 非空）；⑤锚点 zcode-engine.ts:233,335 漂移（:233 现 probeVersionCheck）；⑥assertEngineParamSupport 已删（能力拒绝上提宿主预检 + capabilities.conversation='unsupported'，zcode-engine.ts:176——**结论本身仍真**：zcode 仍不支持 conversation，record 终态一次到位）。
- **direction**: doc-right
- **severity**: suggestion
- **rationale**: todo 的修复方案（status watch 终态 reload）与验收主链路形态无关、仍成立；但 §2.3 是「写用例前核对」的事实基座（§3.2 自我声明），按当前叙事实施会核对到已删代码与已被本分支设计推翻的「读链恒空」断言，误导实施者；2026-09-08 排期更新触碰了本文件却未刷新叙事，且更新句声称「修复草案现成」易被读作「全文仍新鲜」。
- **fix-hint**: 排期更新时（或实施前）刷新 §2.3：one-shot → app-server 常驻形态、journal 运行中流水/终态合成两段式、「三级读链」改对齐设计 §5.1 三窗口模型；§2.1/:1495 锚点改指 packages/subagent-core 现址。

### F3
- **id**: F3
- **location**: docs/design/subagent-drawer-blank.md:113（§5.1 窗口 B）、:245（变更历史 v4）——「subagent-service.ts:2157」
- **gap**: 行号漂移 +1：backfillEngineHandle 定义实于 `packages/subagent-core/src/execution/subagent-service.ts:2156`（同包 core todo §2 已正确写 :2156）。且 d74bdeabc..HEAD 未触碰 packages/subagent-core（git log 空），即该锚点在本分支任一时点都不精确——是登记时误差而非事后代码漂移。
- **direction**: doc-right
- **severity**: info
- **rationale**: 与 d42702710 已修的「:298 / reader.ts:289-293」同类（该轮 commit message 自证此类漂移在修），此为残留漏网实例；2157 已从 review.md Round 2（:120/:175）传播进设计正文。
- **fix-hint**: :113 与 :245 的 2157 → 2156。

### F4
- **id**: F4
- **location**: docs/design/subagent-drawer-blank.md:113（§5.1「session-view-service.ts:364 先 push record.task」）、:245（「先 push record.task（:364）」）
- **gap**: 行号漂移 +1：`messages.push({` 实于 session-view-service.ts:363（if 判定在 :362），:364 是 push 块内 `id: randomUUID()` 行；core todo §2 用「:362-369」正确覆盖。
- **direction**: doc-right
- **severity**: info
- **rationale**: 同 F3，同类漂移残留；不影响窗口 B 结论本体（[task 气泡] 恒非空已实核）。
- **fix-hint**: 两处 :364 → :363（或改 :362-369 区间对齐 core todo）。

### F5
- **id**: F5
- **location**: docs/todo/subagent-core-native-empty-view-degrade.md §4——「pi `!sessionFile` 窗口（packages/runtime/src/services/session/session-records.ts:312）」
- **gap**: 行锚不精确：`if (!record.sessionFile) return []` 实于 session-records.ts:316；:312 是引擎路由分支行（`if (engine !== DEFAULT_SUBAGENT_ENGINE)`）。区域正确、行不精确。
- **direction**: doc-right
- **severity**: info
- **rationale**: 收敛方向（③级合成推广到 pi !sessionFile 窗口）所指代码点可按 :312 附近找到，但精确落点是 :316 的 pi 直读链空返回；与同文件其他锚点（:298/:306 经 grep 精确）精度不一致。
- **fix-hint**: :312 → :316。

### F6
- **id**: F6
- **location**: packages/renderer/src/components/panel/SubagentTab.vue:9-10（头注 subagent 分支描述）
- **gap**: 头注「fetchAndInject 拉历史注入虚拟分区 + 恒订阅 stream_delta」——u1 后拉历史仅在**非空时**注入分区（空历史不写分区是 §7.1 契约核心），条件语义未反映。
- **direction**: doc-right
- **severity**: info
- **rationale**: 精确契约已由 useSubagentTabData.ts 头注承载（d42702710 注释精度修复轮更新了后者、漏了前者）；SubagentTab 头注是 drawer 链路入口注释，半句之差会让新读者错过「空不擦」这一行为变更点。
- **fix-hint**: 头注补「（空历史不写分区，u1）」半句或注明契约见 useSubagentTabData。

### F7
- **id**: F7
- **location**: docs/design/subagent-drawer-blank.impl-plan.md header——「来源设计: docs/design/subagent-drawer-blank.md (v5)」
- **gap**: header 来源设计版本未随 v3 更新；§7 变更历史 v3 明确「文档侧对应设计 v6」，header 与变更历史不一致。
- **direction**: doc-right
- **severity**: info
- **rationale**: header 是文档导航第一落点；v3 变更历史可解码出对应关系，但首行信息滞后一个版本。
- **fix-hint**: header 改 (v6) 或标「v5 起草 / 现对应 v6」。

### F8
- **id**: F8
- **location**: docs/design/subagent-drawer-blank.review.md:120（session-records.ts:295 / :426）、:175（reader.ts:296 / subagent-service.ts:2157）
- **gap**: 历史审计记录携带 review 时点锚点，部分与 HEAD 漂移（:295→现 :298、:296→现 :293-294、2157→现 2156），其中 2157 已传播进设计正文（见 F3）；项目对 review 文件是「历史快照」还是「跟随 HEAD」无任何声明（d42702710 先例只修 design 侧 :298、未回改 review 侧）。
- **direction**: doc-right（二选一：声明快照语义，或修正锚点）
- **severity**: info
- **rationale**: 审计记录改写有损溯源性，但无声明的混合状态（设计侧修、审计侧不修）使两文档锚点口径分叉，读者无法判断哪个是权威。
- **fix-hint**: review.md 头注加一句「本文行号锚点为各 Round 审查时点快照，不跟随 HEAD 演进；现行锚点以设计文档为准」。

## 3. 机械验证清单（全部通过项）

- 标识符实存：`useSubagentThinking` / `subagentThinking` / `task-u-`（useSubagentTabData.ts:121）/ `XYZ_VITE_DEV_URL`（window-factory.ts:26）/ `XYZ_AGENT_DATA_DIR`（main.ts:126-132）/ `activity-strip-row-thinking`（ActivityStrip.test.ts:55,61 + MessageStream 接线测试）/ `drawer-subagent-tab`（SubagentTab.vue template）/ `panel.message.dispatching`（zh/en panel.ts:81）/ `outcome-u-`·`outcome-a-`。
- 行号精确吻合：session-view-service.ts:431（永不返回空注释）/ :496（native !== undefined）/ :362-369 / :433；zcode reader.ts:289 / :293 / :307；subagent-core subagent-service.ts:2156 / record-store.ts:557；session-records.ts:298 / :306；control.ts:106（setSubagentView）；subagent-tab.test.ts:431 / :447；MessageStream script setup 297 行。
- 测试实跑：renderer 全包 383 files / **4082 passed**（3 skipped）——与 impl-plan「4082 tests 全绿」精确一致；core chat **641 passed**——与 impl-plan「641 tests」精确一致；五个 drawer-blank 相关文件 64/64 绿。
- commit 链：d74bdeabc / 3bfe6069a / 4000fe668 / 35df7b5f4 / 39380202d / 6d5d75870（amend 前身）全部实存且与状态表叙述吻合。

## 4. 整体 verdict

**approve**（无 must-fix）。设计 v6 的三处机制、非 pi 三窗口模型、四层兜底归层、⛔3/⛔4 与两份 todo 的双向闭环在 HEAD 全部成立且经测试实跑背书；2 条 suggestion 均为文档簿记（impl-plan 单元表缺行、nonpi todo zcode 形态叙事过时），6 条 info 为行号锚点卫生。建议合并前顺手处理 F1/F2（都是纯文档改动），info 项可随后续文档触碰顺带清账。
