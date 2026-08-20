# W14 验收报告：pendingBuffer 计数 FIFO

**结论：PASS**（9 检查点全过；2 个裁决项 + 7 条 minor 观察上报，无 must-fix）

- 验收人：W14 对抗 verifier（独立于 builder）
- 验收时点：2026-08-19，基线 commit `9382ccb57`，工作区含 W13/W18 builder 并行在途改动
- 验收权威：`w14-acceptance.md` + `data-source-governance-plan.md` §4 W14（L465-488）

## 检查点 1：防篡改 — PASS

- `git diff 9382ccb57 -- .xyz-harness/.../acceptance/w14-acceptance.md` 输出为空（文档未被改）
- `git diff 9382ccb57 -- docs/architecture/data-source-governance-plan.md` 输出为空
- ledger.md 有变化（+29/-11），逐条核对：全部为其他 wave 状态推进（W9/W10/W11/W12/W19/W21/W22/W25 committed 记录）与主 agent 编排日志；W14 行为 `verifying 9382ccb57` 状态记录——ledger 自身记录「登记表改动统一由主 agent 串行落表（builder 只交草稿）」，builder 未越权落表

## 检查点 2：范围 — PASS（1 条计数偏差 minor）

W14 实质改动 = **6 文件**（非自报 7）：

| 文件 | 归因 |
|---|---|
| `packages/core/src/domain/chat/store.ts` | W14（drainN + reconcilePending，删 drainPending） |
| `packages/core/src/domain/chat/effects/registry.ts` | W14（差集 N 接线）+ 2 处 W13 语义注释混入 |
| `packages/core/src/domain/chat/effect-types.ts` | W14（ctx 字段 drainPending→drainN/reconcilePending） |
| `packages/core/src/domain/chat/__tests__/store.test.ts` | W14（TC2/TC2b/TC3b 适配 + 新增 sendMode 隔离用例） |
| `packages/core/src/domain/chat/__tests__/effects.test.ts` | W14（TC1-TC3 适配 + 新增 TC4 深度对账） |
| `packages/core/src/domain/chat/__tests__/pending-drain-fifo.test.ts` | W14 新增（5 用例） |

- 自报「7 文件（3 源 + 3 测试 + 1 新测试）」清单实际列 6 个；useChat.ts / useChat.test.ts 的在途改动逐行核对全部为 W13 applySnapshot 改写（mock `updateLabel/updateSessionState` → `applySnapshot`），非 W14
- W13 领地零 W14 触碰：domain/session 4 文件、renderer 3 源文件 diff 抽样全为 applySnapshot/整表快照语义（W13）；shared 3 文件归因 W12/W13
- W18 领地（runtime）零 W14 触碰
- `useCompactQueue.ts` 零改动（plan 验收 3 的消费路径不变）

## 检查点 3：drainN 读码 — PASS

`store.ts` drainN（L378-390）：

- FIFO 入队序：遍历 `prev`（push 尾部追加维持入队序）按序收集，非文本序 ✓
- sendMode 隔离：`item.sendMode === sendMode` 精确匹配，steer/follow-up 各自计数互不误取（W5 语义保留）✓
- n 超存量取尽即止：`drained.length < n` 条件自然截断到匹配存量；`n <= 0` 早退返回 `[]`；不抛错 ✓
- 非匹配项保留原序：`remaining.push(item)` 保序回写；不可变更新（`new Map().set`）✓

## 检查点 4：reconcilePending 读码 — PASS（1 个裁决项）

`store.ts` reconcilePending（L407-412）+ registry L580 调用：

- 调用点在 drain 处理之后（registry drainN 块外、queueStates 写入前）✓
- `< 深度`：`prev.length <= depth` 直接 return——不误删、接受有界偏差（扩展注入例外）✓
- `> 深度`：`prev.slice(0, depth)` **保留最早 depth 条、裁掉最新入队的尾部项**——与验收任务描述「应裁最旧僵尸暂存」方向相反 → **裁决项 R1**（分析见「两解读裁决」，倾向支持 builder）
- 深度取值：`readNumber(payload, 'pendingMessageCount') ?? 数组长度和`；`??` 只对 null/undefined 生效，显式 0 不误走 fallback ✓

## 检查点 5：组2 核心用例真实性 — PASS

`pending-drain-fifo.test.ts` L90-111 逐行核对：

- push 原文 `textToSegments('/deploy --prod')` → 入队帧广播完全无关的展开文本（`expanded` 常量，无任何文本相等关系）→ 投递帧 `steering: []` 清空
- 断言链：`role === 'user'`、`status === 'complete'`、**`rawContent(msgs[0].content)).toBe(original)`**（toRaw 解 reactive proxy 后 Object.is 引用级断言——同文本两条只有引用可区分入队先后，判据精确）+ `segmentsToText(...) === '/deploy --prod'`（内容回归）+ `bufferLen() === 0`
- 端到端走 `applyMessageEvent` 真 registry dispatch 链（非 ctx mock）✓
- 红性 a 实证该用例对文本匹配行为有判别力（见下）

## 检查点 6：红性验证 — PASS（1 条与任务预期偏差 minor）

**红性 a**（回退文本匹配）：`git show HEAD:` 覆盖 store.ts / registry.ts / effect-types.ts 三文件（W14 前旧文本匹配行为完整复活），跑 pending-drain-fifo.test.ts：

```
Tests  2 failed | 3 passed (5)
- 组2 红：msgs[0] undefined → expect(msgs[0].role) 断言炸（文本不匹配 → 消息永久丢失，复现旧 bug）
- 组4 红：buffer 仍 2 条（无 reconcile 裁剪）
- 组1/组3/组5 绿（文本相同时旧机制工作，符合预期）
```

还原后三文件 md5 与备份一致，`git diff` 指纹 `90804d55e10b45c16240bc38f7a01e09` 与篡改前完全一致。

**红性 b**（删 reconcilePending 调用）：registry L580 临时替换为 no-op：

```
× 组4: buffer > 深度 → 裁剪僵尸暂存到深度（expected length 1 but got 2）
✓ 组3 仍绿
Tests  1 failed | 4 passed (5)
```

任务预期「组3 收敛断言红」与实现结构不符：组3（扩展注入 buffer<depth 方向）的收敛由 drainN 取尽即止达成，不依赖 reconcilePending；reconcilePending 的判别力锚在组4（buffer>depth 方向）。双向对账两条路径各有测试锚点，覆盖等价完整。还原后指纹一致。

## 检查点 7：回归 — PASS

- `pnpm typecheck`（packages/core）exit 0
- `pnpm test`（packages/core 全量）：**994 passed | 6 todo | 0 failed**（77 文件）；chat 域子集 19 文件 340 全绿
- **builder 自报 2 failed 独立归因核实**：当前工作区 useChat.test.ts 20/20 绿，2 失败不复现。归因成立——① 失败文件 useChat.test.ts 非 W14 改动路径（其 diff 全部为 W13 applySnapshot mock 改写）；② 错误内容 `applySnapshot is not a function` 确系 W13 中间态特征（useChat.ts 已调 `sessionStore.applySnapshot` 而 mock 尚只有旧两方法时必 TypeError），W13 builder 后续补齐 mock 后自愈；③ 总数账目吻合（992+2 = 994）
- `grep -rn "drainPending" packages/renderer/src | grep -v __tests__ | grep -v api/mock` = 0 命中
- `grep -n "findIndex" packages/core/src/domain/chat/store.ts` 仅 1 命中（L416，abortPending 内——plan 明文保留）
- `grep -c "drainN" registry.ts` = 6

## 检查点 8：两解读裁决

**解读①（对账算式代数等价落地）——裁决支持。** 手动推导：设 renderer 提交数 C、pi 队列深度 D、已投递数 P、pendingBuffer 存量 B。无扩展注入时 pi 侧入队数 = C = P + D；buffer 侧 B = C − P（push 入、drainN/abort 出，drainN 取出的恰是已投递 P 条）。代入得 B = C − P = D。plan 判据「C − D ≠ B」化简为「D ≠ P ≠ ... ⟺ B ≠ D」——与 builder 不变式「B ≠ D」**代数等价**。plan 字面需要 store 维护提交计数器（C），store 现状确无此计数器（pushPending 无累计），builder 论据属实。落入 reconcilePending docstring 的不变式表述准确。

**解读②（帧内 pendingMessageCount 而非跨域读）——裁决支持。** 三点独立验证：① event-adapter.ts L722 恒附 `pendingMessageCount: event.steering.length + event.followUp.length`，L706-707 注释声明与 pi agent-session `get pendingMessageCount()` 同源公式、与 rpc-mode get_state 同值——帧内字段不损失权威性；② protocol.ts L1155 已有 W12 落的契约声明（`pendingMessageCount: number` 必填）；③ chat effect 跨 store 读 session 域 queue 实例会引入 chat→session 域依赖——useChat.ts 既有注释明示该域耦合规避是架构约定（SessionStoreLike 最小结构类型的动机）。fallback（字段缺失退化数组长度和）与 W8 恒等公式一致，且 `??` 语义下显式 0 不误触发。

## 检查点 9：D6 草稿核对 — PASS

- abortPending 文本匹配保留（L416 findIndex + normalizeContent 归一化）+ docstring 带 `[W14 D6 差异标注]`，标注理由（回滚有准确原文、不走 pi 队列投递路径）与代码实际一致
- 深度结构性对账标注：登记表 #6 行「pendingBuffer 改计数 FIFO 删文本匹配（W14）」+ 例外④「计数 FIFO 有界偏差，深度仍由 pendingMessageCount 结构性对账」——与代码实际（drainN 计数 + reconcilePending 深度对账）一致
- 登记表本体未被 builder 改动（草稿制下 D6 标注落 docstring，符合「builder 只交草稿、主 agent 落表」流程）

## minor 观察项（不阻塞）

1. builder 自报「7 文件」实际 6 文件（清单列 6 却报 7；「3 测试」中第三个不存在）——计数口径偏差，非越界
2. registry.ts diff 混入 2 处 W13 语义注释同步（`sessionStore.updateLabel/updateSessionState` → `applySnapshot` 字样，文件头注释与 L614）——注释级无害，但严格属 W13 领地语义，主 agent 落 W13 commit 时注意归属
3. **裁决项 R1**：reconcilePending 裁剪方向（`slice(0, depth)` 保留最早）与验收任务描述「裁最旧僵尸」相反。verifier 分析倾向支持 builder：pi 队列 FIFO 从头部 splice，队列剩余与 buffer **头部**对齐，两个典型偏差场景（第 2 条 RPC 在途未入队、pi 丢弃/拒绝第 2 条）下保留头部正确；仅「差集漏算已投递头部」场景裁头部才对，而 countDrained 跨帧全量差集下该场景难以发生。请主 agent 终裁并回填任务模板措辞
4. reconcilePending 每帧即时裁剪的竞态注意项：连续快速提交时，第 2 条 pushPending 若先于第 1 条入队帧到达（buffer=2、depth=1），会误裁第 2 条且其原文 segments 不可恢复。该风险为 plan 对账公式固有（plan「提交日志长度−深度」判据同样触发重对），非 builder 实现引入；缓冲帧/连续偏差帧才裁是可选的后续加固方向
5. 验收任务检查点 6b 预期「组3 红」，实际红的是组4（组3 收敛由 drainN 取尽即止覆盖）——测试覆盖等价，回填任务模板
6. 登记表 #6 行引用 `store.ts:123`，pendingBuffer 实际定义在 L132（W14 diff 使行号后移）——主 agent 落 D6 表时顺带校正
7. builder 自报的 2 失败已被 W13 后续推进自愈（core 当前 994 全绿），W14 commit 时无需处理

## 红性验证还原记录

- 备份：`/tmp/w14-verify-backup/`（store.ts `f495b036…` / registry.ts `38cf3b33…` / effect-types.ts `548ccb08…`）
- 两组红性验证后均 cp 还原，`git diff HEAD` 三文件指纹 `90804d55e10b45c16240bc38f7a01e09` 与验收开始一致；`RED-TEST-B` 残留 0 命中
- 验收期间工作区文件数 27 → 74：新增 47 文件全部归因 W13（renderer __tests__ 40+ 测试适配）/ W18（runtime 测试与新文件）builder 后台并行推进，W14 六文件指纹零变化
