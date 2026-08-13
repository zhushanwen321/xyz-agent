# V4 生命周期终态收敛 — 对抗式设计审查报告（第三轮复审·递归补丁）

**审查对象**：`extensions/subagent-workflow/docs/design/v4-lifecycle-convergence.md`（本轮新增「递归多轮支持」补丁：P7 问题 / R3 根因 / 场景 E / A-5 决策 / S6 验收 / §5.1 A-5 单元）
**审查方式**：对抗式；本轮重点 = 逐项 read 源码验证 P7 危害与 A-5 守卫，+ 全文复扫（含补丁引入的口径一致性）。所有"事实/行号/机制"声明均经 read/grep 源码核实。

## Summary

**0 must-fix, 6 suggestions.**

总评：补丁的**事实基座与因果自证链未发现决断级错误**。P7 危害的真实性经源码三问（a/b/c）全部核实为"成立"；A-5 守卫的 by-construction 正确性逐一验过（根/子/三层递归、跨重启、fork）。本轮没有在递归补丁里找到 MUST_FIX（无事实错误、无机制在递归层断裂、无验收不可测、无决策级口径错乱）——与前两轮"3→2 个 MUST_FIX"的收口节奏一致，P7/A-5 是补得扎实的一块。但补丁在**已有正文的计数口径上留下 4 处未同步**（A 期"4 项"残留 2 处、问题"6 项/6 个/两个根因"残留），以及对 A-5 两个非 message 操作（close/cancel 跨重启、递归清理）的行为影响**只字未提**，均列为 SUGGESTION。

---

## 一、P7 危害逐项核实（P0-11 事实）

> 任务要求：若 (a)(b)(c) 任一不成立 → MUST_FIX。逐一 read 后三者**全部成立**。

**（a）`getRecordForAction` 只校验 rootSessionId、不校验 parentRecordId —— 成立（✓）**
- read `subagent-service.ts:921-959`：归属校验唯一一处 `record.rootSessionId !== this.sessionRootId`（:952），**无任何 parentRecordId 校验**。
- 磁盘重建路径（:927-951）`createRecord(...{rootSessionId: found.rootSessionId, parentRecordId: found.parentRecordId, ...})` 把 parentRecordId 带进 record，但只作元数据、不参与守卫。
- 结论：主进程能拿到底层 record（rootSessionId=ROOT 匹配），文档 P7 的"message 权限按 root 级授予"陈述属实。

**（b）所有子进程的 sessionRootId 都是真 ROOT（env 贯穿）—— 成立（✓）**
- read `session-runner.ts:818-824`：每层 spawn 都注入 `PI_SUBAGENT_ROOT_SESSION_ID = ctx.sessionRootId`、`PI_SUBAGENT_SELF_RECORD_ID = record.id`（:819）。`ctx.sessionRootId` 就是真 ROOT，非自身。
- read `subagent-service.ts:360-361`：`sessionRootId = envRoot ?? init.sessionId` —— 子进程从 env 读到真 ROOT，主进程无 env 时用自身 sessionId（自己即 ROOT）。
- 结论：主进程能对孙级 record 通过归属校验（孙级 rootSessionId === 主 ROOT）。P7 的前提成立。

**（c）主进程 message 孙级时 `getChildByRecord` 必然 miss → 冷路径 → 与中间进程活着的孙进程双写 —— 成立（✓）**
- read `session-runner.ts:207/256-257`：`spawnedChildren` 是**模块级 Map**（每个进程各自一份），`getChildByRecord` 只读本进程的 Map。B 的句柄在 A 进程，主进程的 Map 查不到 → 返回 undefined。
- read `subagent-service.ts:852-899` `deliverMessage`：`getChildByRecord` miss → 走 else 冷路径分支（:890-899）`resumeRound` 重新 spawn。
- `acquireActivateLock`（:894）是**进程内**锁，跨进程各自独立救不了 —— read 确认锁由 module-level 排队 + finally 实现，无跨进程语义。
- 结论：主进程 message 活着的孙级 B → 主进程再 spawn 一个 B 进程，而 A 进程里 B 还活着 → **双进程交错写同一 session 文件**。P7 双写者危害**真实成立**，文档推演与源码逐点吻合。

## 二、A-5 守卫设计核实（P0-10/12）

**（a）`execCtxBaseline?.recordId ?? undefined` 语义 —— 成立（✓）**
- read `subagent-service.ts:245`（默认 `null`）、`:362-368`（有 env `PI_SUBAGENT_SELF_RECORD_ID` 时置 `{recordId:envSelf, depth}`）：
  - 根进程：无 env → baseline=null → `?? undefined` → 只能操作 `parentRecordId === undefined` 的顶层 record。
  - 子进程：baseline=自身 recordId → 只能操作 `parentRecordId === 自身 id` 的直接子 record。
- 结合 `createRecordForMode`（:1188）`parentRecordId = parentCtx?.recordId`：主进程 spawn A → A.parentRecordId=undefined；A 进程 spawn B → B.parentRecordId=A.id。与守卫公式严格对偶。

**（b）by-construction "每 record 仅一进程可 message" —— 成立（✓，三层递归逐层过）**
- 对任意 record R，其 parentRecordId=P（或其缺失→根）。能使守卫通过的进程，其 `execCtxBaseline.recordId` 必须 === P。UUID 唯一 + 每个 record 只有一个 spawn 进程拥有它（该进程 baseline=record.id），故**恰好一个进程**（R 的直接父的进程）能操作 R。主进程 baseline=undefined 唯一 → 只操作根层；A 进程 baseline=A.id → 只操作 B 层；C（B 的孩子）仅 B 进程可操作。
- fork 子 agent：read `createRecordForMode` 的 parentRecordId 仍取自 execCtxBaseline —— 主进程 fork → parentRecordId=undefined（主进程可 message）；A 进程内 fork → parentRecordId=A.id（仅 A 进程可）。与普通 subagent 同构。✓
- 跨重启：`getRecordForAction` 磁盘重建把 `found.parentRecordId` 带进 record（:941），而 `reconstructAll` 从 identity entry 恢复 parentRecordId（`record-store.ts:350`）→ 重启后守卫仍按直接父成立。✓

**（c）边界：parentRecordId 缺失的旧 record —— 可接受，但应显式声明（SUGGESTION）**
- 旧 record（无 identity parentRecordId）重建后 parentRecordId=undefined → 判定为"根层"，仅主进程可操作。若该 record 实为某活着的子进程所 spawn，则技术上是 P7 的窄口径残留。现状（当前版本 spawn 必写 parentRecordId）下无此 record，但文档未点破"缺省=根层"这一回退语义 → SUGGESTION。

**（d）A-5 是否误伤现有合法流 —— 逐一过调用方，未发现 MUST_FIX**
- `getRecordForAction` 的 3 个真实调用方（read `subagent-actions.ts`）：`messageHandler:348`、`closeHandler:410`、`cancelHandler:287`（仅 chatMode 分支）。
- close（message/close 走 getRecordForAction）：顶层 record 的 close 不受影响（parentRecordId=undefined 匹配根基线）。直接父的 close 不受影响。仅"非直接父进程 close 孙级"被拒 —— 这正是 A-5 的本意，且与 message 同语义。**合法流不受损。**
- one-shot upgrade 路径（`subagent-actions.ts:355-358`）在 messageHandler 内、getRecordForAction **返回之后**，先过守卫再 upgrade；直接父对 one-shot 孩子 upgrade 不回归。跨层 upgrade 被拒 = 双写者消除的必然代价。✓
- cancel 的 chatMode 分支：read `cancelHandler`（:263-278）**先** `findRecord`（只查本进程内存），跨进程 record 在 :269-275 已被 `"owned by another process in the tree"` 拒绝 —— A-5 只作为第二道防线，不改变既有 cancel 语义。✓
- **close 路径跨重启的缺口**（见 SUGGESTION #5）：重启后主进程无法直接 close/cancel 已成为 idle 的孙级 record（被 A-5 拒），文档恢复指引只给了 message 通道，未给 close 通道。

**（e）"主进程已可见全树，不构成信息泄露" —— 自洽（✓）**
- read `record-store.ts:204-214`/`:312`：`collectRecords`/`reconstructAll` 扫**共享 sessionsDir** 按 rootSessionId 过滤 → 主进程（ROOT）天然能列出整棵树的 record id + parentRecordId。拒绝文案 "owned by its direct parent (parent=<A>)" 泄露的都是主进程已能从 `/subagents` 看到的树结构，无新增信息量。与 S5/S6 grep 断言不冲突（S6 是 A-5 的验证场景，S5 是 B-3 互斥）。

## 三、递归多轮现有机制逐点核实（P0-12，找递归层断裂）

> 任务要求：任一机制在递归层断裂 → MUST_FIX。逐点核实后**均未断裂**（notifier / triggerTurn / SP-3 快照 / idle timer / close-cascade 全部按进程实例自然成立）。

- **notifier 是否 per-process / 对子进程 session 生效（✓）**：`BgNotifier` 是 `SubagentService` 实例字段（`subagent-service.ts:262`），每个 pi 进程一个 Service（`--extension` 起子进程各自 initSession，`notifier.revive` :379）。A 进程里 B 的完成 → A 进程的 notifier 调 `host.sendMessage({triggerTurn:true,deliverAs:"steer"})`（`notifier.ts:213-224`）到 **A 的 pi session** → 唤醒 A。B→A 接力成立。
- **A 完成时 notifier 唤醒主进程（接力）**：A 是主进程 spawn 的 background subagent；A 完成在**主进程**的 Service 域触发 notifier → 唤醒主 agent（`notifier.ts` 单层机制，不依赖递归、递归层只是同一机制跑两次）。场景 E:183-184 的"B 的 notifier 运行在 A 进程 / A 的 notifier 运行在主进程"陈述正确。✓
- **SP-3 before_agent_start 快照在 A 进程注入 A 的 children（✓）**：`recentlyCascaded` 是实例字段（`subagent-service.ts:216`），`disposeAllRecords` 在**本进程**内收集并注入（:404-435）→ A 进程只注入 A 的直接孩子（B/C），B 进程注入 B 的孩子。逐进程正确，递归层不穿层篡改。✓
- **idle timer 在 A 进程对 B 生效（✓）**：`armIdleTimer` 按 Service 实例的 `idleTimers` Map（key=record.id），B 的 timer 在 A 进程 armed/触发 → SIGTERM B 的子进程。✓
- **close/cascade 沿进程树传播（✓）**：`killAllSpawnedChildren` + EOF/pipe 关闭使父进程死 → 子进程退（F10）。A 的 dispose 只 close A 的直接孩子，B 的孩子由 B 进程（A 死→B 的 EOF）自收敛。天然沿进程树透传。✓

**递归层潜在缺口（归纳为 SUGGESTION，非 MUST_FIX）**：递归下 cascade/close 沿"进程树"传播靠 EOF/自杀机制，而 A-5 新加的"按 parentRecordId 守卫"沿"record 树"判定，两者在**跨重启清理**场景碰撞 —— 主进程重启后整棵 record 树只有主进程的内存视图（子进程全死），主进程无法对孙级 record 发 close/cancel（A-5 拒），需经父链回弹。S6 步骤 ⑤ 只测了 message 冷恢复，未测 close/cancel 清理路径。

## 四、S6 可测性（P0-13/14）

- **testable（✓）**：S6 步骤①②③⑤均有具体机制侧断言（spawn 次数=1 / parentId 链 / notify 接力到达 / 双写者零残留 ps 断言 / 冷恢复上下文连续），负例④有明确拒绝信息 + 恢复指引断言。回溯 G1/G2 正确（:316 "S6→G1/G2"）。
- 符合"改动规模：大"标准（真实 pi CLI、注入点+自然观察声明齐全）。
- 小缺口：S6 ④"主进程直接 message B"——需确认主进程能获得 B 的 id 才能发起该负例。主进程 `collectRecords`（按 ROOT 过滤）确实列得出 B，故可获得；未在 S6 写明"先 /subagents 拿到 B 的 id"这一前提，属流程细节（SUGGESTION，非阻塞）。

## 五、全文复扫：补丁引入的口径不一致（P1-5 MECE / P1-8 细节）

| 位置 | 现在的表述 | 应然 | 类型 |
|---|---|---|---|
| §1 A-答案（:21） | "A 期可靠性收口（**4 项**独立小改…" | **5 项**（A-1..A-5） | 计数残留 |
| §2.2 表头（:93） | "问题清单（**6 项**…" | **7 项**（P1..P7） | 计数残留 |
| §2.3 正文（:107） | "**6 个问题**归到**两个根因**"（R1/R2/R3 实为三） | **7 个问题**归到**三个根因** | 计数残留 |
| §4 验收环境（:284） | "改动规模：大（**A 期 4 项**…" | **A 期 5 项** | 计数残留 |
| §2 章首结论（:61） | "可靠性（P1/P2/**P7**）、表达唯一性（P3/P4/P6）与权限一致性（**P7**）" | P7 同时计入"可靠性"与"权限一致性"两个维度 | MECE 重叠（一处即可） |

其余经核对**自洽**：§1/§3.1/§3.2/§5.1 多处 "A 期 5 项/5 单元" 正确；§3.4 映射表（P7→A-5→S6，:276）正确；A-4 文档回写"6 处、⑥ 归 B-1"沿用前两轮已修正的 6 vs 6 口径，未再倒退；§2.3 章首 "三个缺失" 正确（仅正文"两个根因/6 个问题"漏改）。补丁本身的 A-5/S6/P7/R3 引用与行号（:952/:818-824/:941/record-store:350）全部属实。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §1 :21 / §4 :284 | P1-8 计数 | **A 期计数残留"4 项"**：§1 A-答案 "A 期可靠性收口（4 项独立小改…）"与 §4 验收环境 "A 期 4 项"仍为补丁前口径，而 §3.1/§3.2/§5.1/§2 In-scope 均已改"5 项/5 单元"（A-1..A-5）。同文档内 A 期项数自相矛盾。 | 两处 "4 项" 改 "5 项"，与 §3.2/§5.1 一致。 |
| SUGGESTION | §2.2 :93 / §2.3 :107 | P1-5 MECE / P1-8 | **问题/根因计数残留**：§2.2 表头 "问题清单（6 项…）"实列 P1..P7（7 行）；§2.3 正文 "6 个问题归到两个根因"实为 7 问题、3 根因（R1/R2/R3，章首 "三个缺失" 已改）。补丁新增 P7/R3 后未同步这两处。 | "6 项"→"7 项"；"6 个问题归到两个根因"→"7 个问题归到三个根因"。 |
| SUGGESTION | §2 :61 | P1-5 MECE | **P7 在两个维度重复计入**：章首结论 "可靠性（P1/P2/P7）、表达唯一性（P3/P4/P6）与权限一致性（P7）"。P7 的危害面是可靠性（双写者），根因面是权限（R3），但作为"三个维度"的罗列同时出现两次，破坏 MECE。 | 明确 P7 归哪个维度（建议归权限一致性，因 R3 是其根因），可靠性只列 P1/P2。 |
| SUGGESTION | §3.3 A-5 :234 / §4 S6 | P0-12 遗漏 | **A-5 守卫对 close/cancel 的跨重启清理路径未声明**：重启后主进程无法对已成为 idle 的孙级 record 直接 close/cancel（A-5 以 parentRecordId=A.id 拒绝），只能经父链（message A→A resume→A 内 close B）回弹。文档恢复指引只给了 message 通道（"message it through that parent"），未说明 close/cancel 亦被同守约束、且清理成本表现为"必须恢复整条父链"；S6 步骤 ⑤ 只测 message 冷恢复，未测 close/cancel 清理。 | 在 A-5 决策 + S6 补一句：close/cancel 同样受直接父守卫约束，跨重启清理经父链回弹；可在 S6 ⑤ 后加一个 close/cancel 清理断言。 |
| SUGGESTION | §3.3 A-5 / §5.2 | P0-12 边界 | **parentRecordId 缺省=undefined 的回退语义未点破**：旧/异常 record（identity 无 parentRecordId）重建后 parentRecordId=undefined → 被守卫判为根层、仅主进程可操作。若该 record 实为某活着子进程所 spawn，则技术上是 P7 的窄口径残留（当前版本 spawn 必写身份，无此现实 record，故不阻塞）。 | A-5 依据补一句："身份缺省的旧 record 视作根层，若需严格归属应重 spawn"。 |
| SUGGESTION | §4 S6 步骤④ | P1-8 表达 | S6 负例④"主进程直接 message B"未写明主进程如何获得 B 的 id。主进程 collectRecords（按 ROOT 过滤共享 sessionsDir）确实能列出 B，但步骤缺"/subagents 先取得 B 的 id"这一可执行前提，实施者可能困惑。 | S6 ④ 前补"先 /subagents 列出（含父/子见 B 的 parent=<A>）"再发起主进程 message B。 |

---

## P0 / P1 判定四态（关键项）

| 检查项 | 判定 | 依据 |
|--------|------|------|
| P0-10 方案是否解决根因 | **通过** | A-5 直接父守卫使"每 record 仅直接父进程可 message/close" by-construction 成立（§二(b)），R3（权限与所有权脱节）根治；P7 双写者窗口闭合。 |
| P0-11 关键事实 | **通过** | P7 三问（a/b/c）、A-5 公式语义、以及补丁引用的全部行号（:952/:818-824/:941/~record-store:350/parentCtx :1188）read 核实属实。无决断级事实错误。 |
| P0-12 副作用/遗漏 | **通过（4 处 SUGGESTION）** | 调用方逐一过未发现合法流误伤；递归机制逐点验证未断裂。仅 close/cancel 跨重启清理路径、parentRecordId 缺省回退、P7 维度重叠、A 期计数残留属未显式声明之遗漏（均 SUGGESTION）。 |
| P0-13/14/15 验收 | **通过** | S6 真实 pi CLI + 机制侧断言 + 负例 + 双写者 ps 断言，回溯 G1/G2；改动规模"大"已与"5 项 A 单元"匹配（仅 :284 "4 项"漏改，见 SUGGESTION）。 |
| P1-5 MECE（口径） | **不通过（4 处细节）** | A 期"4 项"×2、问题"6 项"、根因"两个根因/6 个问题"——补丁未同步既有正文计数，均为 P1-8/P1-5 级，不阻塞。 |
| P0-16/17/18 | **通过** | A-5 配 ⛔ P-parent-guard 探针（S6）；权限/句柄物理位置清晰（spawnedChildren 进程内 Map）；跨层拒绝带恢复指引（"message it through that parent"）。 |

*注明*：本轮 0 MUST_FIX。补丁的 P7 危害真实性与 A-5 守卫正确性经逐点源码核实为扎实，未发现决断级错误；6 个 SUGGESTION 集中在"补丁未同步既有正文计数 + 未声明 close/cancel 的递归清理行为"两处。
