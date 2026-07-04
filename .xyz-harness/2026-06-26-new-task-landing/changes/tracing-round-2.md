---
phase: execution
round: 2
converged: true
tracer: fresh-context subagent (independent, Round 2 收敛复核)
upstream_truth: code-architecture.md (⑤), 骨架 code-skeleton/
target: execution-plan.md (⑥ Round 1 修订稿)
round1_report: tracing-round-1.md
---

# 追踪报告 Round 2 — 执行计划收敛复核（⑥execution-plan.md）

> 独立 fresh-context 收敛复核。重点验证 Round 1 报告的 4 个 gap 是否真正闭合，并按 4 视角重新追踪是否有新 gap。
> 证据源：⑥execution-plan.md（Round 1 修订稿）+ ⑤code-architecture.md + 骨架 code-skeleton/ runtime 4 文件实证。

**CONVERGED** — Round 1 的 4 个 gap 全部闭合，4 视角复核无新 gap。

## Round 1 gap 闭合核对

### Gap-1 [F] Wave 2 缺 #6 runtime checkout port 扩展 → ✅ **闭合**

**Round 1 问题**：Wave 2 文件影响零 runtime 条目，#6 checkout 写路径的 runtime port 扩展（GitService.checkout / GitCommand 'checkout' / handler git.checkout / protocol git.checkout）全被推到 Wave 3，导致 Wave 2 不是垂直切片，T4.1/T4.2/T4.5 无法端到端跑通。

**修订后实证（⑥execution-plan.md）**：

1. **Wave 2 文件影响已增列 runtime 4 文件**（「修改（runtime，#6 checkout 写路径，与 #7 createBranch 同模式）」小节）：
   - `services/git-service.ts`（新增 `checkout(sessionId, name)`，用 `checkout <name>`，dirty 冲突转 GitError）✅
   - `services/ports/git-executor.ts`（GitCommand 白名单加 `'checkout'`，明标「#6+#7 共用，#6 先用 `checkout <name>`，#7 用 `checkout -b`」）✅
   - `transport/git-message-handler.ts`（handles + switch case 加 `'git.checkout'`，路由→gitService.checkout→reply `message.status {status:'switched'}`）✅
   - `shared/src/protocol.ts`（type union/ClientMessageMap/client message union 加 `git.checkout`）✅

2. **Wave 2 执行流第 1 步已增 runtime 扩展**：「general-purpose → runtime #6 checkout port 扩展（GitCommand 白名单 + GitService.checkout + handler case + protocol git.checkout）」，排在最前置（前端 gitApi.checkout 之前）✅

3. **Wave 3 文件影响已去掉 checkout 重复，只留 createBranch 专属**：
   - 修改（runtime，#7 createBranch 专属）：`git-service.ts` createBranch、`git-message-handler.ts` case git.createBranch、`protocol.ts` git.createBranch ✅
   - 复用（runtime，Wave 2 已就绪）：`git-executor.ts` GitCommand `'checkout'` 白名单「Wave 2 已扩展，#7 的 `checkout -b` 复用同白名单，无需再改」✅
   - Wave 3 执行流第 1 步：「GitCommand `'checkout'` 白名单复用 Wave 2 已扩」✅

4. **决策记录 D-5 显式记录此修正**：「#6 runtime checkout port 扩展归 Wave 2 非 Wave 3（F 类核对后修（Gap-1））」，含根因分析（⑤§1.2 标题误导）+ 证据（⑤§9 骨架接线表 git-service.ts:211 checkout 标 #6）✅

**骨架实证**（code-skeleton/ runtime 4 文件）：
- `git-service.ts:211` `checkout` 方法存在（`execSafe(cwd, 'checkout', [name])`）✅
- `git-executor.ts:22` GitCommand 联合类型含 `'checkout'`，注释「#6+#7 共用：#6 `checkout <name>` 切换、#7 `checkout -b <name>` 创建」✅
- `git-message-handler.ts` handles 数组含 `'git.checkout'`，switch case `'git.checkout'` 路由→gitService.checkout→reply `message.status {status:'switched'}` ✅
- `protocol.ts` ClientMessageType / ClientMessageMap / ClientMessage union 三处均含 `git.checkout`（payload `{sessionId, name}`）✅

**判定**：Wave 2 现为真垂直切片（前端 + runtime 同 Wave 切穿），T4.1/T4.2/T4.5 端到端闭合。Gap-1 闭合。

---

### Gap-2 [D] git.ts 被 Wave 2/3 串行扩展未显式标注 → ✅ **闭合**

**Round 1 问题**：「并行约束」章节只标 `useNewTaskFlow.ts` 串行，遗漏 `api/domains/git.ts` 同样被 Wave 2（checkout）→ Wave 3（createBranch）串行改。

**修订后实证（⑥execution-plan.md「并行约束」章节）**：

```
- 同一文件不允许多 Wave 同时修改（冲突）—— 以下文件被多 Wave 渐进扩展，但都串行依赖（非并行），允许：
  - `useNewTaskFlow.ts`：Wave 1（主干）→ Wave 2（select*/confirm*）→ Wave 3（openBranchModal/submitCreateBranch）
  - `api/domains/git.ts`：Wave 2（checkout）→ Wave 3（createBranch）
  - runtime `git-service.ts`：Wave 2（checkout）→ Wave 3（createBranch）
```

不仅补注了 `git.ts`，还**额外补注了 runtime `git-service.ts`** 同样被 Wave 2/3 串行扩展（这是 Round 1 未明确点出但同模式的文件，修订者主动覆盖）。完整度优于 Round 1 建议。

**判定**：Gap-2 闭合（且超额覆盖 git-service.ts）。

---

### Gap-3 [D] 调度表「并行组」列语义混淆 → ✅ **闭合**

**Round 1 问题**：调度表「并行组」列 Wave 2=B、Wave 3=C，但 DAG 是纯串行链，B/C 实标 Wave 内部组件文件并行，易误读为「Wave 间可并行」。

**修订后实证（⑥execution-plan.md）**：

1. **调度表「并行组」列已改标语义**：
   - Wave 1：`—`
   - Wave 2：`B（Wave 内组件并行）` ← 明确标注「Wave 内组件并行」
   - Wave 3：`C`

2. **并行约束章节首行已加总纲说明**：
   ```
   - Wave 间严格串行（DAG W1→W2→W3→W4），无 Wave 间并行。
     调度表「并行组」列指 Wave 内部 组件文件并行（如 Wave 2 的 #5/#6 两组件文件独立），非 Wave 间并行
   ```

**判定**：Gap-3 闭合。调度表列名虽仍叫「并行组」，但每行值带「Wave 内组件并行」后缀 + 约束章节首行总纲，语义不再混淆。

---

### Gap-4 [F] ⑤§1.2 标题「仅 #7 port 扩展」与内容矛盾 → ✅ **已记录（待 Step 6b 反哺⑤）**

**Round 1 问题**：⑤code-architecture.md §1.2 小节标题「runtime（后端）扩展（仅 #7 port 扩展）」与表格内容矛盾（表格 4 行中 3 行属 #6 的 checkout），误导⑥把 checkout runtime 全归 Wave 3（Gap-1 根因）。属⑤上游文档不一致。

**修订后实证（⑥execution-plan.md「待确认」章节）**：

```
## 待确认

- [Step 6b 待反哺⑤] Gap-4：⑤code-architecture.md §1.2 小节标题
  「runtime（后端）扩展（仅 #7 port 扩展）」与表格内容矛盾（表格含 #6 的
  GitService.checkout/GitCommand 'checkout'/handler git.checkout/protocol git.checkout，
  明标 #6+#7 共用）。Step 6b 反哺⑤标题改为「runtime（后端）扩展
  （#6 checkout + #7 createBranch port 扩展）」。属事实性矛盾（标题与自家内容不一致），
  非 D-不可逆决策，不需 ask_user。
```

**判定**：Gap-4 符合任务要求「这个是⑤的问题，不要求本期修，但要有记录」。⑥已在「待确认/Step 6b 反哺项」完整登记（含矛盾描述 + 反哺建议标题 + 不需 ask_user 的理由）。⑤本身未改（标题仍「仅 #7 port 扩展」），但这是预期的——⑤修订属 Step 6b 反哺环节，不在本期⑥执行计划职责内。

---

## 4 视角复核

### 视角 1：切片独立性（每 Wave 可独立验证？垂直切片？）

**结论：4 Wave 全部通过。**

| Wave | 切穿层级 | 可独立验证 | 判定 |
|------|---------|-----------|------|
| 1 | api(session.ts)→composable(useNewTaskFlow)→component(Landing/Panel)→lib(utils)→测试 | ✅ ⌘N→resolveDefaultCwd→create(cwd)→landing 端到端窄路径 | ✅ 垂直切片 |
| 2 | composable 扩展→component(DirSelect/BranchSelectPopover)→api(git.ts.checkout)→**runtime(git-service checkout / git-executor GitCommand / handler git.checkout / protocol git.checkout)** | ✅ 含 runtime 4 文件，T4.1/T4.2/T4.5 端到端可跑通（Gap-1 修复） | ✅ **垂直切片** |
| 3 | runtime(git-service createBranch / handler git.createBranch / protocol git.createBranch)→api(git.ts.createBranch)→composable→component(CreateBranchModal) | ✅ 跨前后端完整链路，GitCommand 'checkout' 复用 Wave 2 | ✅ 垂直切片 |
| 4 | 验收（非功能） | ✅ 读清单全量→跑测试 | ✅ |

**无新 gap。** Wave 2 已从「水平切片（前端层只切一半）」修复为真垂直切片。

### 视角 2：依赖闭合（Wave 依赖从⑤§4 时序图完整推导？）

**结论：全部闭合。**

| 调用链（⑤§4） | 被调用方实现所在 Wave | 依赖闭合 |
|--------------|---------------------|---------|
| §4.1 startFlow → resolveDefaultCwd(#4) → sessionApi.create(#1) | #4/#1 均在 Wave 1 | ✅ |
| §4.2 selectWorkspace/openDirDialog → sessionApi.create(#1) | #1 在 Wave 1 | ✅ |
| §4.3 selectBranch/confirmDirtySwitch → gitApi.checkout(#6) → **runtime GitService.checkout / GitCommand 'checkout' / handler git.checkout / protocol git.checkout** | **全部在 Wave 2（前端 + runtime 4 文件）** | ✅ **闭合（Gap-1 修复）** |
| §4.4 submitCreateBranch → gitApi.createBranch(#7) → runtime GitService.createBranch / GitCommand 'checkout' 复用 / handler git.createBranch / protocol git.createBranch | 全在 Wave 3（GitCommand 复用 Wave 2） | ✅ |
| §4.5 UC-7 守卫（gitInfo==null） | Wave 1（landing 守卫随 #2） | ✅ |

**无新 gap。** §4.3 时序图的 runtime 依赖链（前端 gitApi.checkout → WS git.checkout → handler → GitService.checkout → IGitExecutor.exec('checkout')）全部落在 Wave 2，端到端闭合。

### 视角 3：并行安全（同并行组真不改同一文件？渐进扩展真串行？）

**结论：无并行冲突；文档标注完整（Gap-2/Gap-3 修复后）。**

| 共享文件 | 改它的 Wave | 串行/并行 | 安全 | 文档标注 |
|---------|-----------|----------|------|---------|
| `useNewTaskFlow.ts` | Wave 1/2/3 | DAG W1→W2→W3 串行链 | ✅ | ✅ 已标注 |
| `api/domains/git.ts` | Wave 2(checkout)/Wave 3(createBranch) | W2→W3 串行 | ✅ | ✅ **已补注（Gap-2）** |
| runtime `git-service.ts` | Wave 2(checkout)/Wave 3(createBranch) | W2→W3 串行 | ✅ | ✅ **已补注（Gap-2 超额）** |
| runtime `git-executor.ts` | Wave 2 扩展 GitCommand 'checkout' / Wave 3 复用 | W2 扩展后 W3 复用，零冲突 | ✅ | ✅ Wave 3 明标「复用 Wave 2 已扩，无需再改」 |
| runtime `git-message-handler.ts` | Wave 2(case git.checkout)/Wave 3(case git.createBranch) | W2→W3 串行 | ✅ | ✅ 串行依赖链明确 |
| `shared/protocol.ts` | Wave 2(git.checkout)/Wave 3(git.createBranch) | W2→W3 串行 | ✅ | ✅ 串行依赖链明确 |

并行组语义：调度表「并行组」列改标「B（Wave 内组件并行）」，约束章节首行总纲「Wave 间严格串行...非 Wave 间并行」。**无语义混淆（Gap-3 修复）**。

**无新 gap。** 所有跨 Wave 共享文件均走 DAG 串行链，无并行冲突。

### 视角 4：测试闭环 + 实现闭环

**结论：Round 1 已全过的 4a-4e 本轮维持，无回退；Wave 2 runtime 就绪使 T4.1/T4.2/T4.5 实现+测试双闭环。**

**4a. 用例 ID 并集**（Round 1 已实证 39=39，本轮无变化）：W1(16)+W2(14)+W3(8)+独立#8(1)=39=⑤全量 ✅

**4b. 异常分支 E1-E11 映射**（Round 1 已实证 11/11，本轮无变化）✅

**4c. NFR 来源 B 用例**（T1.8/T1.9/T4.7/T6.8 全归属）✅

**4d. 实现闭环**：
- 「测试验收清单」章节存在，用例集合 = ⑤全量 ✅
- Wave 4 标题「验收 Wave（Acceptance Gate）」含关键字 ✅
- Wave 4 blocked_by Wave 1/2/3 ✅
- 独立 ticket #8（T1.9）不阻塞主验收 ✅

**4e. 骨架叶子作用域 → Wave 映射**（本轮重点重核 runtime 4 文件）：

| 骨架文件 | 归属 Wave | 核验 |
|---------|----------|------|
| `git-service.ts:211` checkout | Wave 2（#6） | ✅ **已修正（Gap-1）** |
| `git-service.ts:226` createBranch | Wave 3（#7） | ✅ |
| `git-executor.ts:22` GitCommand 'checkout' | Wave 2（#6 先用，#7 复用） | ✅ **已修正（Gap-1）** |
| `git-message-handler.ts` case git.checkout | Wave 2（#6） | ✅ **已修正（Gap-1）** |
| `git-message-handler.ts` case git.createBranch | Wave 3（#7） | ✅ |
| `protocol.ts` git.checkout（type/map/union 三处） | Wave 2（#6） | ✅ **已修正（Gap-1）** |
| `protocol.ts` git.createBranch | Wave 3（#7） | ✅ |
| 其余前端骨架（Landing/useNewTaskFlow/utils/session.ts/DirSelect/BranchSelect/CreateBranchModal/git.ts） | Wave 1/2/3 按 issue 归属 | ✅（Round 1 已核） |

骨架实证（本轮直接读取 code-skeleton/ runtime 4 文件确认）：
- `git-service.ts` checkout(L211) + createBranch(L226) 双方法都在，注释明确 #6/#7 区分 ✅
- `git-executor.ts` GitCommand 联合类型末项 `'checkout'`，注释「#6+#7 共用」✅
- `git-message-handler.ts` handles 数组含 `'git.checkout', 'git.createBranch'`，switch 双 case 路由→reply `message.status {status:'switched'|'branch_created'}` ✅
- `protocol.ts` ClientMessageType / ClientMessageMap / ClientMessage union 三处含 `git.checkout` + `git.createBranch`，payload `{sessionId, name}` 一致 ✅

**无新 gap。** 骨架接线与执行计划 Wave 归属完全一致，vue-tsc 可编译（⑤§9 已实证 EXIT 0）。

## 收敛判定

**CONVERGED ✅**

### 已追踪的视角（4/4 全过）

| 视角 | 结果 | 备注 |
|------|------|------|
| 1. 切片独立性 | ✅ 4 Wave 全垂直切片 | Wave 2 已修复为含 runtime 的真垂直切片 |
| 2. 依赖闭合 | ✅ 全部闭合 | §4.3 runtime 依赖链全落 Wave 2 |
| 3. 并行安全 | ✅ 无冲突 + 标注完整 | git.ts/git-service.ts 串行已补注，并行组语义已澄清 |
| 4. 测试闭环+实现闭环 | ✅ 用例集合闭合 + 骨架映射正确 | runtime 4 文件 Wave 归属与骨架一致 |

### 已闭合的 Round 1 gap（4/4 全闭合）

| Gap | 分类 | 闭合状态 | 证据 |
|-----|------|---------|------|
| Gap-1 Wave 2 缺 runtime checkout | [F] | ✅ **闭合** | Wave 2 文件影响增 runtime 4 文件 + 执行流增 runtime 步骤；Wave 3 去重复只留 createBranch；骨架实证 4 文件接线完整 |
| Gap-2 git.ts 串行标注 | [D] | ✅ **闭合（超额）** | 并行约束章节补注 git.ts + 额外补注 git-service.ts 串行 |
| Gap-3 并行组语义 | [D] | ✅ **闭合** | 调度表列值改标「Wave 内组件并行」+ 约束章节首行总纲 |
| Gap-4 ⑤上游标题矛盾 | [F] | ✅ **已记录** | 「待确认/Step 6b 反哺项」完整登记，符合「⑤问题不要求本期修但要有记录」 |

### 新发现的 gap

**无。** 4 视角复核未发现新 gap。Round 1 的 8 项关键验证点（用例集合相等 / 验收 Wave 关键字 / blocked_by / 用例并集 / #4 挪 Wave 1 合理性 / useNewTaskFlow 串行 / E1-E11 映射 / 骨架映射）本轮全部维持通过，无回退。

**⑥execution-plan.md 可进入下一环节（执行交接 / 接入 coding-workflow 或手动 Wave 执行）。** 唯一遗留项是 Gap-4 的⑤反哺（Step 6b），不阻塞⑥本身交付。
