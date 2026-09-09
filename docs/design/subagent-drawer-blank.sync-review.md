# subagent-drawer-blank 终态一致性审查（sync-review）

> 审查者：对抗式一致性审查 agent（只报不改）· 基线 = HEAD `39380202d`（全量终态对照，非 diff 区间）
> 对照物：设计 `docs/design/subagent-drawer-blank.md`（v5）· 实施计划 `docs/design/subagent-drawer-blank.impl-plan.md`
> 方法：设计/计划全文 read → 逐文件 read 实现（store / composable / MessageStream / ActivityStrip / electron 两文件 / 5 个测试文件）→ 标识符逐一 grep → 关键事实核到行级（含 subagent-core / runtime 侧被引文件）→ 目标套件实跑（64/64 绿）。
> 机械验证结果：`useSubagentThinking` ✅、`subagentThinking` ✅、`task-u-` 前缀 ✅（useSubagentTabData.ts:126 + 测试断言）、`XYZ_VITE_DEV_URL` ✅（window-factory.ts:23）、testid `activity-strip-row-thinking` ✅（ActivityStrip.vue 动态拼 `activity-strip-row-${kind}` + ActivityStrip.test.ts:54 / MessageStream 测试 DOM 断言）、`panel.message.dispatching` ✅（zh-CN/panel.ts:81「思考中…」/ en-US/panel.ts:81「Thinking…」）。无悬空标识符。

## 结论先行

**代码 ↔ 设计文档（关系 a）：未发现**。§7 三处改动逐条与实现吻合（见下「关系 a 核验明细」）；§5.1 三窗口模型与 §6.3-6.6 决策的被引源码事实全部行级复核成立。全部 finding 集中在文档簿记层（关系 b/c/d）：8 条（Minor 4 + Suggestion 4），无 Critical / Major。**Verdict：approve**。

## 关系 a 核验明细（代码 ↔ 设计，零 finding）

- §7.1 fetchAndInject：签名 `Promise<Message[]>`、`history.length > 0` 才 setMessages、空返回 `[]`（subagent.ts:255-263）；调用方全仓 grep 仅 useSubagentTabData.ts:98 一处，「仅 drawer 编排层一处」成立；W2/M5 fail-fast 语义不变（无 try/catch 吞错）。
- §7.2 loadSubagentData：判定顺序即优先级——①outcome 先行（非 pi && 分区空 && result/error 有值，既有分支零改动，diff 上下文核实）②task 种入随后（分区空 && task 非空 → `task-u-<subagentId>` / user / complete / `startedAt ?? Date.now()`，useSubagentTabData.ts:113-131），与设计逐字段一致；守卫多出的 `history.length === 0` 即偏差 #3，已登记且论证成立（非空 history ⇒ setMessages ⇒ 分区非空，严格等价）。
- §7.3：`useSubagentThinking`（forceWorking && (无 turn || 末位 turn.assistants.length===0)，useSubagentThinking.ts:42-44）→ MessageStream prop（MessageStream.vue:167 传 `:subagent-thinking`）→ ActivityStrip 条件 `(!compacting && !executingBash && (turn==='dispatching' || subagentThinking))`（ActivityStrip.vue:113-115），与设计公式逐字一致；提取 composable 即偏差 #2，已登记（MessageStream script 实测 297 行 ≤300）。
- 机制层：E-4 先到不擦（chat store setMessages「不受 hydrated 守卫」注释 store.ts:609 在场，§6.2 证据成立）；§6.4 两证据成立（streaming-state-machine.ts:154 push 分支 / :187-191 finalize 幂等 no-op）；§6.6 证据成立（STATE_TYPE_KEY_MAP 含 `session.subagents` message-bus.ts:153；SubagentList.vue:213 与 isStreamingSubagent 同判据）。
- §5.1 三窗口被引源码：session-view-service.ts:431「永不返回空数组」注释、:496 `native !== undefined` 即返回、:362-368 task push 先于 turn 循环、zcode/reader.ts:294 user 排除、runtime session-records.ts:298/:306 `!target`/`!record` 返回 []——行为结论全部成立（两处行号有 2-3 行漂移，见 S1）。
- 实跑佐证：目标 5 套件 64/64 绿（subagent.test 35 = T1「35/35」✓；useSubagentTabData.test 7 = T2「7/7」✓；MessageStream 6 + ActivityStrip 3 = T3/T4「9/9」✓；subagent-tab.test 13 含 :431 outcome 同屏 + :447 翻转断言 ✓）。

## Findings

### Minor

**M1 u4 状态表证据指针缺 commit hash（自指占位未兑现）**
- location: docs/design/subagent-drawer-blank.impl-plan.md:73
- gap: u4-regression 行写「（提交随本表更新 commit）」，该行由 commit `35df7b5f4` 提交（其 commit message 自称 "all 4 units committed, status + evidence recorded"），但哈希从未回填。
- direction: 状态表承诺的自我闭环未完成，证据指针不可解析——审查者无法从表直达 u4 提交（须靠 git log 反查）。
- severity: Minor
- rationale: 直接观察：表内 u1/u2/u3 均有哈希，唯 u4 留占位；`git log` 证实 35df7b5f4 即 u4 提交。
- fix-hint: 将占位替换为 `commit 35df7b5f4`。

**M2 偏差 #4 登记于不存在的 unit「Gate B」，证据源悬空**
- location: docs/design/subagent-drawer-blank.impl-plan.md:64
- gap: 偏差 #4 的证据源（「Gate B 实测发现」）与登记 unit（「Gate B」）在本设计/impl-plan 体系内均无定义：设计文档全文无「Gate」字样，impl-plan §4 质量门未命名 Gate A/B，状态表无 Gate B 行——「Gate B」是从其他 impl-plan（如 subagent-core-package-extraction）借用的术语，在本文件内不可解析；electron 提交 39380202d 由此不被任何 unit 行追踪。
- direction: 偏差与 diff 本身吻合（两处改动描述与实际 diff 一致），但验收证据链断裂：无法核证「实测发现」的出处与过程。
- severity: Minor
- rationale: `grep -rn "Gate B" docs/design/subagent-drawer-blank.*` 仅命中 impl-plan:64 一处。
- fix-hint: unit 改挂真实归属（如新增 u5-electron 行或标注「计划外插入」），证据源补写实际验收载体（S5/Gate B 探针记录文件或会话证据路径）。

**M3 main.ts 注释指向设计中不存在的「§验收 Gate B」**
- location: apps/electron/main/main.ts:132
- gap: 注释称「subagent-drawer-blank 设计 §验收 Gate B 实测发现」，设计 §8.2 验收场景为 S1-S5，无 Gate B 章节——代码注释与被引文档对不上。
- direction: 悬空引用，后来者按注释回设计文档找不到出处（与 M2 同根）。
- severity: Minor
- rationale: 直接观察（grep + 设计 §8.2 全文 read）。
- fix-hint: 注释改为指向实际来源（如「impl-plan 偏差 #4」）或补设计侧 Gate B 定义后保持现引。

**M4 impl-plan 变更历史止于 v1，实施阶段零登记**
- location: docs/design/subagent-drawer-blank.impl-plan.md:78-79
- gap: 变更历史仅 v1（初版）；其后 6 个 commit（d92574714 基线哈希修正 / a0b6f4fcc 偏差 #1 / 3bfe6069a u1+u3 / 4000fe668 u2 / 35df7b5f4 u4 / 39380202d 偏差 #4+electron）无一登记。
- direction: 进度只散落在状态表，变更历史失去审计线索功能；与仓内其他 impl-plan（实施期逐轮回写变更历史）的惯例不一致。
- severity: Minor
- rationale: 直接观察（git log -- impl-plan 共 5 commit 触及本文件，历史节零命中）。
- fix-hint: 补 v2 条目：4 unit 提交哈希 + 偏差 #1/#4 登记轮次 + u4 全量回归证据（4082+641 tests）。

### Suggestions

**S1 设计 v5 两处行号引用与 HEAD 实际偏移 2-3 行**
- location: docs/design/subagent-drawer-blank.md:115（session-records.ts:295 → 实际 :298，runtime/src/services/session/session-records.ts）、:227（zcode/reader.ts:296 → 实际 :294）
- gap: 行号漂移；review.md Round 3 已裁决「不影响决策」但设计 v5 本体未顺手修正。
- direction: 事实精确性（决策不受影响，纯精度问题）。
- severity: Suggestion
- rationale: 本轮 HEAD 行级复核确认（sed 取行）。
- fix-hint: 设计文档 :115/:227 行号改 :298/:294（或改用函数名锚定避免行号腐化）。

**S2 偏差 #4「均为 dev-only 路径」对 VITE_DEV_URL 不完全成立**
- location: apps/electron/main/window/window-factory.ts:23、:153（对照 impl-plan:64）
- gap: `VITE_DEV_URL` 的 loadURL/waitForVite 消费确在 `!isE2E && deps.isDev` 守卫内（:73-76）✓，但同一常量还**无条件**喂给 will-navigate 导航放行集 `devOrigin`（:153，prod/E2E 同样注册）——env 覆盖的 reach 不止 dev。
- direction: 若打包应用在带 `XYZ_VITE_DEV_URL` 的环境中启动，导航白名单的放行 origin 随之扩大（推测影响：需本机 env 控制权，威胁模型弱，但与完整性加固 D2b 的白名单语义相悖）。
- severity: Suggestion
- rationale: 直接观察（read :55-90 与 :140-160，守卫结构核实）。
- fix-hint: `devOrigin` 仅在 isDev 分支取 `VITE_DEV_URL`（prod 传 undefined），或注释/偏差登记如实标注该常量的 prod 消费点。

**S3 设计 T2「全组合」措辞强于实现覆盖（5 钉死 + 2 补充 = 7 用例）**
- location: docs/design/subagent-drawer-blank.md:218（对照 useSubagentTabData.test.ts 全文 7 it）
- gap: T2 写「…× pi/非 pi × outcome 有/无 全组合」（字面 32 格），实现按 impl-plan u2 验收条款的操作化口径落 7 用例（显式钉死 5 条 + 空 task + reload 幂等）。未测格（如 pi+outcome 有值）经守卫结构论证与已测格行为等价（outcome 引擎守卫先行跳过），无实际缺口，但设计字面与实现不符。
- direction: 文档口径收敛即可，测试无需加行。
- severity: Suggestion
- rationale: 逐格比对测试文件与设计矩阵。
- fix-hint: T2 措辞改为「显式钉死清单 + 未测格退化等价论证」。

**S4 useSubagentTabData.ts 文件头职责清单未同步 task 种入**
- location: packages/renderer/src/composables/panel/useSubagentTabData.ts:9-11
- gap: 文件头「职责」列举 fetchAndInject / 恒订阅 / outcome-only 兜底（U4 A8），未列 u2 新增的 task 种入——职责面已变，头注未跟上（行为契约本身在 loadSubagentData docstring :88-91 已如实更新，无误导性错误，仅头注不全）。
- direction: 头注与实现职责清单不一致（轻微）。
- severity: Suggestion
- rationale: 直接观察（头注 read + diff 核实头注在本分支未被触碰）。
- fix-hint: 职责首条补「空历史兜底（outcome 投影 / task 种入，判定顺序即优先级）」。

## Verdict

**approve** —— 关系 a（代码 ↔ 设计）全量吻合零 finding；must-fix 0；8 条簿记级建议（M1-M4 状态表/偏差/变更历史的证据链缺口 + S1-S4 措辞精度），均不阻塞合并。关系 b/c/d 有发现如上；关系 a 未发现。

---

## 修复记录（主 agent，当轮全修 8/8）

| id | 修复 | 验证 |
|----|------|------|
| M1 | impl-plan u4 状态行回填 commit 35df7b5f4 | grep 确认占位文案消失 |
| M2 | 偏差 #4 unit 归属改 u5-gateb；单元表+状态表增补 u5-gateb 行（commit 39380202d + Gate B S1-S5 证据） | 表内三处一致 |
| M3 | main.ts:132 注释「设计 §验收 Gate B」→「设计 §8.2 验收场景」 | grep 确认 |
| M4 | impl-plan 变更历史补 v2 条目（4 个实现 commit + Gate B + sync-review 结论） | 见变更历史 |
| S1 | 设计行号修正：session-records :295→:298（实读 :298 `if (!target)`）；zcode/reader.ts:296→:289-293（实读 collectTurns:289 + user 不进 turns 注释:293） | 实读源文件核对 |
| S2 | window-factory 注释补准确性：VITE_DEV_URL 同时是 will-navigate devOrigin（覆盖同步生效，行为正确）；prod 仅 loadFile 无生效面 | read :153 消费点 |
| S3 | 设计 T2「全组合」→「组合矩阵（5 组钉死 + 2 补充；未测格退化由分区空守卫蕴含）」 | 与 7 用例实际覆盖对齐 |
| S4 | useSubagentTabData 文件头职责清单补 seed 条目（判定顺序即优先级引用 §7.2） | read 头注 |

修复后验证：useSubagentTabData.test + subagent-tab.test 20/20 绿（注释级改动零行为影响）。
