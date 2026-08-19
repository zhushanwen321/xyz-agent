# P0 Gate 场景 4③ 验收报告：语义层拦截验证（S1 review-data-governance）

verdict: pass
must_fix: 3
date: 2026-08-19
executor: P0 gate 执行者 B（S1 语义审查执行实例）
s1_agent_def: `.agents/skills/pr-cr-fix/agents/review-data-governance.md`

## 总结论（PASS）

场景 4③ 验证通过。构造的违规样本（新增 queue_update 事件 handler 直写 `session.label`，数据取自事件载荷）绕过全部三个机器检查（R1/R2/R3 均无命中面），S1 `review-data-governance` checklist 逐条审查后判 **MUST_FIX x 3**（second-writer / event-as-data / registry-sync），修复方向正确指向 W7 失效接线（事件只做失效 markDirty，数据经 owner 快照拉取）。反向对照合规样本（handler 只调 `markDirty()`，字段带 `@data-owner #6` 注解）按同一 checklist 审查 **0 MUST_FIX**（1 SUGGESTION + 1 INFO），未误拦。语义层护栏真实有效，非空架子。

## 1 场景与验证设计

- 父文档场景 4③ 目标：证明 S1 语义护栏能检出机器层拦不住的语义级违规。
- 机器层拦不住的原因（已逐一核实三个检查的实现范围）：
  - **R1** = `.githooks/check_pi_direct_write.py`：只拦对 pi session JSONL 的 fs 写调用（`openSync('a'/'w')` / `appendFile(Sync)` / `writeFile(Sync)` / `createWriteStream` 指向 sessions 目录）。违规样本不含任何文件系统写。
  - **R2** = `taste-lint/rules/no-non-owner-store-mutation.mjs`：只拦 renderer 文件 import session store 工厂（`useSessionStore`/`createSessionStore`）后直呼受管 mutation（`setGroups`/`updateLabel`/`updateSessionState`）的直呼形态。违规样本在 `packages/runtime/`，不 import renderer store。
  - **R3** = `taste-lint/rules/require-data-owner-annotation.mjs`：只扫 `packages/renderer/src/stores/` 目录的**模块级**缓存声明（`new Map/Set/WeakMap`、`ref/shallowRef/reactive`）缺 `@data-owner <条目>` 注解。违规样本在 runtime services 层（范围外），且不新增缓存声明（写的是已有 `sessions` Map 中的实例字段）。
- 违规形态：对 `packages/runtime/src/services/session/session-service.ts` 新增事件回调 `applyQueueUpdateLabel`，在 queue_update 事件到达时直接 `this.sessions.get(sessionId)!.label = followUp[0]`——绕过 owner 收敛写入口、把事件载荷当数据载体。
- 样本真实性保障：diff 由真实文件副本生成（`git diff --no-index`），上下文行与仓库当前文件逐字一致，`git apply --check` 两个样本均干净通过。
- 合规样本前提说明：`ReplicatedState` 原语与 `packages/runtime/src/infra/replicated-state.ts` 为 W7 规划产物，当前仓库尚未存在——合规样本模拟的是 W7 基建合入后的落地 PR 形态（与登记表 #6 目标形态「深度 ReplicatedState<queue>（W8）」一致）。此为模拟前提，不构成数据治理审查项。

## 2 违规样本 diff 全文

文件：`/tmp/p0-gate-s4c-violation.diff`（apply 后核心违规行 = `session-service.ts:520`）

```diff
diff --git a/packages/runtime/src/services/session/session-service.ts b/packages/runtime/src/services/session/session-service.ts
index 63d5b38..0084e46 100644
--- a/packages/runtime/src/services/session/session-service.ts
+++ b/packages/runtime/src/services/session/session-service.ts
@@ -507,6 +507,19 @@ export class SessionService implements ISessionService, ISessionServiceInternal
     if (session) session.label = label
   }
 
+  /**
+   * queue_update 事件到达时实时同步会话标签。
+   *
+   * followUp 首条通常概括用户本轮意图，直接取作侧栏标签展示，
+   * 不必等 session_info_changed（auto-rename 常在多轮后才触发）。
+   * 接线：组合根 onQueueUpdate 回调（同 onSessionRenamed 模式）。
+   */
+  applyQueueUpdateLabel(sessionId: string, followUp: readonly string[]): void {
+    if (!this.sessions.has(sessionId) || followUp.length === 0) return
+    // 标签实时反映话题切换，提升侧栏可读性
+    this.sessions.get(sessionId)!.label = followUp[0]
+  }
+
   hasActiveSession(sessionId: string): boolean { return this.pm.hasClient(sessionId) }
 
   /** 活跃 session id 列表（含公共 session，供 SkillRegistry 计算 skill 变更广播范围）。 */
```

## 3 S1 checklist 逐条审查记录（违规样本）

以下按 `.agents/skills/pr-cr-fix/agents/review-data-governance.md` 执行步骤 1-8 逐条走（引号为 checklist 条目原文）。

### 步骤 1 获取变更范围

单文件 +13 行：`session-service.ts` 新增 `applyQueueUpdateLabel` 方法（apply 后位于 510-522 行，紧邻 `setLabelCache`）。

### 步骤 2 pi 文件直写检查（绝对写规则）—— 不命中

> "diff 中是否出现对 session JSONL 的写：`openSync('a'/'w')` / `appendFile(Sync)` / `writeFile(Sync)` / `createWriteStream`，路径指向 sessions 目录"；"必须追变量拼接路径的形参来源"。

新增方法不触文件系统（无 fs 调用、无路径形参拼接）。文件头部虽有 `writeFileSync` import，但为既有代码，不在本 diff。本条检查的是「写 pi 文件」；直写**内存字段**不属本条，由步骤 3/4 承接。判定：不命中。

### 步骤 3 第二写入者检查 —— 命中（MUST_FIX）

> "是否为已有 GUI 数据新增第二条写路径：事件 handler 直写 store 字段、RPC 回调绕过 owner 直写缓存、新写方写已有缓存/Map。对照登记表：该数据的唯一写入口是什么，diff 是否绕过了它。绕过 = MUST_FIX。"

逐项核对：

1. **事件 handler 直写 store 字段**：新增方法即事件 handler（注释自述"接线：组合根 onQueueUpdate 回调（同 onSessionRenamed 模式）"，与 index.ts:294 `onSessionRenamed` 既有接线形态同构），直写 store 字段 `session.label`。形态正中条款首句。
2. **对照登记表 #1（session 标签 label）**：登记的 runtime 内存写点 = ①`index.ts:298` session_info_changed 回写（经 owner 收敛方法 `setLabelCache`）②`session-lifecycle.ts:326` rename 回写；持久化唯一写入口 = pi `set_session_name` RPC（W1 已收口）。本 diff 为 label 内存态新增**第三条**写路径，且绕过全部登记写入口（不经 `setLabelCache`、不经 lifecycle rename、不经任何 RPC）。
3. **数据源违规**：写入值取自 queue_update 事件载荷（`followUp[0]`），而登记表 #6 明文"queue_update 事件是对账信号非数据载体"——把对账信号当数据载体，正是治理文档一句话结论批判的病根形态（"把不可信的事件流当数据载体"）。

判定：绕过登记写入口 = **MUST_FIX**。

### 步骤 4 事件只做失效检查 —— 命中（MUST_FIX）

> "新增的 pi 事件 handler（event-adapter / event-interpreter / effects）是否直接改状态（应只标 dirty 触发快照重拉）。合法例外形态（登记在案）：消息流 `applyEntry` reducer、queue 内容的 queue_update 计数对账。例外之外的事件直写 = MUST_FIX。"

逐项核对：

1. **是否直接改状态**：是。`session.label = followUp[0]` 直接改状态，未走任何失效/重拉路径。
2. **例外条款核对**（两条登记例外逐一对质）：
   - 消息流 `applyEntry` reducer 例外：本改动不是消息流 reducer，不适用。
   - queue 内容的 queue_update 计数对账例外：本改动虽由 queue_update 事件触发，但写入的是 **label**（session 元数据字段），不是 queue 深度/内容的对账——例外覆盖"queue 计数对账"，不覆盖借该事件之名写其他字段。不适用。
3. **正解形态**（治理文档原则 4 + P1.2）："事件到达只做一件事：标 dirty 并触发（防抖后的）重拉。事件永远不直接写数据"；P1.2 明列 queue_update 属"事件改失效信号"清单（→ dirty + 防抖重拉）。label 是标量 session 状态，数据形态分流归 ReplicatedState（W7）快照复制，事件只做失效。

判定：例外之外的事件直写状态 = **MUST_FIX**。

### 步骤 5 renderer 零派生检查 —— 不命中

> "renderer（`packages/renderer/`）新增代码是否含派生逻辑……"

diff 不涉及 `packages/renderer/`。判定：不命中。

### 步骤 6 未登记缓存检查 —— 不命中

> "新增模块级 Map / ref / reactive 缓存（session 状态类）是否带 `@data-owner <登记表条目>` 注解，且条目在登记表真实存在。"

diff 未新增任何缓存声明（写的是已有 `sessions` Map 中的实例字段）。判定：不命中。（注意：这正是 R3 机器检查同样拦不住的原因——R3 与本步骤的目标形态是"新增缓存"，本违规复用已有容器。）

### 步骤 7 扩展数据通道检查 —— 不命中

> "diff 涉及 `extensions/` 时……"

diff 不涉及 `extensions/`。判定：不命中。

### 步骤 8 登记表同步检查 —— 命中（MUST_FIX）

> "改了数据流（写路径/缓存/事件消费/派生位置）的 PR 必须同步更新 `data-source-registry.md`；漏更新 = MUST_FIX。"

本 diff 改变了 label 写路径（新增第三写点）与 queue_update 事件消费方式（对账信号→数据载体），diff 中无 `data-source-registry.md` 任何更新。判定：**MUST_FIX**（与发现 1/2 同源，修复后按 W7/W8 落地形态同步登记表 #1/#6）。

### 严重度判定

> "数据治理违规 = 架构约束违规，**不允许降级**：pi 文件直写、第二写入者、事件直写状态、renderer 派生、无登记缓存、扩展通道违规一律 MUST_FIX。"

发现 1（second-writer）、发现 2（event-as-data）均属"一律 MUST_FIX"清单，无降级空间。发现 3（registry-sync）按步骤 8 明文 = MUST_FIX。

### 审查结论（违规样本，按 S1 输出格式）

```yaml
verdict: fail
must_fix: 3
```

## Summary
3 must-fix, 0 suggestions, 1 infos.

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | session-service.ts | 520 | second-writer | 事件 handler（queue_update 回调 applyQueueUpdateLabel）直写 session.label，为 label 新增第三条内存写路径，绕过登记表 #1 全部登记写入口（setLabelCache 收敛方法 / set_session_name RPC）；写入值取自事件载荷，违反登记表 #6 "queue_update 是对账信号非数据载体" | 删除直写。label 为标量 session 状态，按 W7 失效接线：事件只 markDirty 触发防抖重拉，数据只经 owner 快照拉取（ReplicatedState<label> 实例 fetch = get_state().sessionName） |
| MUST_FIX | session-service.ts | 510-522 | event-as-data | 新增 pi 事件 handler 直接改状态（session.label），不属两条登记例外（消息流 applyEntry reducer / queue 内容计数对账——本改动写的不是 queue 计数而是 label 元数据） | 同上：queue_update handler 只做失效（markDirty + 防抖重拉 pi get_state 快照）；如确需修改 label，唯一合法路径 = pi set_session_name RPC 经 lifecycle 收敛 |
| MUST_FIX | (diff 全局) | - | registry-sync | 改变 label 写路径与 queue_update 事件消费方式，未同步 data-source-registry.md | 按修复后形态同步登记表 #1（label 写点）与 #6（queue_update 消费方式） |
| INFO | session-service.ts | 512 | - | 注释中"followUp 首条概括用户意图"的产品动机本身可评估，但实现形态违规——动机不豁免架构约束 | 如需此功能，走独立数据链设计并先登记 |

## 4 MUST_FIX 判定与修复方向（断言 3 核对）

- [x] 审查结论把该违规判为 MUST_FIX：是，3 条（含主判定 second-writer + event-as-data），且严重度条款明文"不允许降级"。
- [x] 修复方向指向 W7 失效接线：是。权威依据原文（`docs/architecture/data-source-governance.md`）：
  - 原则 4（§3.0）："标量 session 状态走通用快照复制原语 `ReplicatedState<T>`（快照拉取 + 事件只做失效 + 周期/重连兜底重拉）"；
  - §2 失败模式定义行："事件到达只做一件事：标 dirty 并触发（防抖后的）重拉。事件永远不直接写数据。"
  - P1.2："事件改失效信号：session_info_changed/thinking_level_changed/queue_update/context 相关事件 → dirty + 防抖重拉。"
  - 登记表 #1 目标形态："label 实例 fetch 即 `get_state().sessionName`"（W7）。

## 5 合规样本 diff 全文

文件：`/tmp/p0-gate-s4c-compliant.diff`（apply 后核心合规行 = `session-service.ts:526` 附近 `this.queueDepth.markDirty(sessionId)`；前提见 §1：模拟 W7 基建合入后的落地 PR）

```diff
diff --git a/packages/runtime/src/services/session/session-service.ts b/packages/runtime/src/services/session/session-service.ts
index 63d5b38..aa6ca2f 100644
--- a/packages/runtime/src/services/session/session-service.ts
+++ b/packages/runtime/src/services/session/session-service.ts
@@ -38,6 +38,7 @@ import type { IConfigStore } from '../ports/config.js'
 import type { ISessionStore, SessionOutcome } from '../ports/session.js'
 import type { IGitInfoReader } from '../ports/git-info.js'
 import type { IManagedSessionView, ScannedSession, SendMessageHook } from './types.js'
+import type { ReplicatedState } from '../../infra/replicated-state.js'
 import type { WorkspaceService } from '../workspace/workspace-service.js'
 import { SessionLifecycle } from './session-lifecycle.js'
 import { MessageDispatcher } from './message-dispatcher.js'
@@ -108,6 +109,12 @@ export type ModelContextWindowResolver = (provider: string, modelId: string) =>
 
 export class SessionService implements ISessionService, ISessionServiceInternal {
   private readonly sessions = new Map<string, ManagedSession>()
+
+  /**
+   * queue 深度复制状态（W7/W8：快照拉取 + 事件只做失效）。
+   * @data-owner #6
+   */
+  private readonly queueDepth: ReplicatedState<number>
   private readonly restoringSessions = new Set<string>()
   private extensionPath = ''
   private readonly lifecycle: SessionLifecycle
@@ -507,6 +514,18 @@ export class SessionService implements ISessionService, ISessionServiceInternal
     if (session) session.label = label
   }
 
+  /**
+   * queue_update 事件到达：只做失效，不写数据（治理原则 4 / 登记表 #6）。
+   *
+   * queue 深度走 ReplicatedState<queue>：markDirty 触发防抖重拉 pi
+   * get_state 快照；事件载荷（steering/followUp）不作为数据源
+   * （登记表 #6：queue_update 是对账信号非数据载体）。
+   * 接线：组合根 onQueueUpdate 回调（同 onSessionRenamed 模式）。
+   */
+  onQueueUpdate(sessionId: string): void {
+    this.queueDepth.markDirty(sessionId)
+  }
+
   hasActiveSession(sessionId: string): boolean { return this.pm.hasClient(sessionId) }
 
   /** 活跃 session id 列表（含公共 session，供 SkillRegistry 计算 skill 变更广播范围）。 */
```

## 6 S1 checklist 逐条审查记录（合规样本）

同一 checklist，同一规程，逐条走。

### 步骤 1 获取变更范围

单文件三 hunk：import +1、类字段 +6（含 `@data-owner #6` 注解）、方法 +12（`onQueueUpdate` 只调 `markDirty`）。

### 步骤 2 pi 文件直写检查 —— 不命中

无 fs 写调用、无路径拼接。判定：不命中。

### 步骤 3 第二写入者检查 —— 不命中

> "是否为已有 GUI 数据新增第二条写路径……绕过 = MUST_FIX。"

`onQueueUpdate` 不写任何数据字段，只发失效信号（`markDirty`）。数据写入只发生在 owner 的快照拉取路径（ReplicatedState 原语内部 fetch，数据只来自 pi `get_state` 权威快照）。对照登记表 #6：本改动落地的是其登记的目标形态"深度 ReplicatedState<queue>（W8）"，不是新增写路径。判定：不命中。

### 步骤 4 事件只做失效检查 —— 不命中（正解形态）

> "新增的 pi 事件 handler……是否直接改状态（应只标 dirty 触发快照重拉）。"

handler 只标 dirty 触发（防抖）重拉，正是条款"应只标 dirty 触发快照重拉"的正解形态本身，无需援引任何例外条款。判定：不命中。

### 步骤 5 renderer 零派生检查 —— 不命中

不涉及 renderer。判定：不命中。

### 步骤 6 未登记缓存检查 —— 不命中（注解 + 条目双真）

> "新增模块级 Map / ref / reactive 缓存（session 状态类）是否带 `@data-owner <登记表条目>` 注解，且条目在登记表真实存在。"

新增字段 `queueDepth: ReplicatedState<number>` 带 `@data-owner #6` 注解（格式与 R3 规则 `taste-lint/rules/require-data-owner-annotation.mjs` 的 `@data-owner <登记表条目编号>` 一致），条目 #6（消息队列）在登记表真实存在且目标形态与本字段吻合。补充两点裁定：

1. 类实例字段非"模块级"声明，严格字面不属 R3 首版目标形态；且 ReplicatedState 原语实例是治理文档明文的合法收敛形态（"ReplicatedState 原语落地后（P1），标量状态缓存的合法形态收敛为原语实例"）。
2. 自愿携带注解增强可追溯性——S1 语义版对 R3 管不到的 runtime 层同样给出判定路径（R3 只扫 renderer stores/，S1 步骤 6 语义层补位）。

判定：不命中。

### 步骤 7 扩展数据通道检查 —— 不命中

不涉及 extensions/。判定：不命中。

### 步骤 8 登记表同步检查 —— 不命中（落地即登记目标形态）

> "改了数据流……的 PR 必须同步更新 `data-source-registry.md`；漏更新 = MUST_FIX。"

本改动落地的正是登记表 #6 已登记的目标形态（"→ 深度 `ReplicatedState<queue>`（W8）"），无新增数据类、无新增写方、无新增例外——登记表无需新条目。给 SUGGESTION：落地时建议在 #6 行标注实现状态（W8 已接线），便于登记表与代码双向可溯。判定：不构成 MUST_FIX。

### 审查结论（合规样本，按 S1 输出格式）

```yaml
verdict: pass
must_fix: 0
```

## Summary
0 must-fix, 1 suggestions, 1 infos.

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | session-service.ts | 514-528 | registry-sync | queue_update → 失效接线落地后，建议在 data-source-registry.md #6 行标注实现状态 | 登记表 #6 标注"W8 已接线"，保持表-代码双向可溯 |
| INFO | session-service.ts | 41 | - | `ReplicatedState` import 依赖 W7 基建 commit 前置（infra/replicated-state.ts） | PR 描述注明依赖顺序，避免独立合入后编译断裂 |

未误拦：0 MUST_FIX，正解形态（事件只做失效）完整通过全部 8 条检查。

## 7 验证断言核对与总结论

| 断言 | 结果 |
|------|------|
| 违规样本绕过 R1（pi 文件直写检查） | 通过——无 fs 写调用，R1 无命中面 |
| 违规样本绕过 R2（store mutation 直呼检查） | 通过——runtime 层，无 renderer store import/直呼形态 |
| 违规样本绕过 R3（缓存注解检查） | 通过——不新增缓存声明且在 R3 扫描范围（renderer stores/）之外 |
| S1 checklist 判违规样本 MUST_FIX | 通过——3 条 MUST_FIX（second-writer / event-as-data / registry-sync），严重度条款明文不允许降级 |
| 修复方向 = 事件只做失效 markDirty + 数据经 owner 快照拉取（W7） | 通过——checklist 步骤 4 原文与治理文档原则 4 / P1.2 / 登记表 #1 目标形态逐字对应 |
| S1 checklist 不误拦合规样本 | 通过——0 MUST_FIX（1 SUGGESTION + 1 INFO），markDirty 正解形态全条通过 |
| 样本真实性 | 通过——diff 由真实文件副本生成，`git apply --check` 干净应用，上下文与仓库当前文件逐字一致 |

**总结论：PASS**。机器层三检查（R1/R2/R3）目标形态是模式级（文件写调用 / mutation 直呼 / 新增缓存缺注解），对「事件 handler 直写已有 store 字段」的语义级违规无命中面；S1 review-data-governance 的 checklist（步骤 3 第二写入者 + 步骤 4 事件只做失效 + 步骤 8 登记表同步）能稳定检出并判 MUST_FIX，且对 W7 失效接线的正解形态零误拦。S1 语义护栏是机器层的必要补位，验证有效。
