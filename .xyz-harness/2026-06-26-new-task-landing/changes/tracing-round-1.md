---
phase: execution
round: 1
converged: false
tracer: fresh-context subagent (independent)
upstream_truth: code-architecture.md (⑤), issues.md (③)
target: execution-plan.md (⑥初稿)
---

# 追踪报告 Round 1 — 执行计划（⑥execution-plan.md）

> 独立 fresh-context 追踪，按 SKILL.md Step 2 的 4 视角 + wave-template.md 测试闭环 14 项检查清单。
> 卡住的地方就是 gap，每个 gap 标 F/K/D 分类。

## 4 视角追踪结果

### 视角 1：切片独立性（每 Wave 可独立验证？非水平切片？切穿所有层？）

**结论：Wave 1/3 通过；Wave 2 不通过（runtime 层缺失，端到端断裂）。**

| Wave | 切穿层级 | 可独立验证 | 判定 |
|------|---------|-----------|------|
| 1 | api(session.ts)→composable(useNewTaskFlow)→component(Landing/Panel)→lib(utils)→测试 | ✅ ⌘N→resolveDefaultCwd→create(cwd)→landing 端到端窄路径，⑤§4.1 完整链路 | ✅ 垂直切片 |
| 2 | composable 扩展→component(DirSelect/BranchSelectPopover)→api(git.ts.checkout)→**runtime 缺失** | ❌ T4.1/T4.2「选干净/dirty 分支→gitApi.checkout→chip 回灌」需 runtime `GitService.checkout` + `GitCommand 'checkout'` 白名单 + handler `git.checkout` case + protocol `git.checkout`，但 Wave 2 文件影响只写前端 git.ts，runtime 全推到 Wave 3 | ❌ **水平切片（前端层只切一半）** |
| 3 | runtime(git-service/git-executor/handler/protocol)→api(git.ts.createBranch)→composable 扩展→component(CreateBranchModal) | ✅ 跨前后端完整链路 | ✅ 垂直切片 |
| 4 | 验收（非功能） | ✅ 读清单全量→跑测试 | ✅ |

**Wave 2 不是垂直切片**：它声称是「垂直切片（2 条并列窄路径）」，但 #6 的 git checkout 写路径需要 runtime port 扩展（与 #7 createBranch 同模式，⑤§3.5/§3.6/§3.7/§1.2 明确），Wave 2 文件影响完全没列 runtime 侧。这违反 vertical-slice.md「每 Wave 切穿所有层」——Wave 2 实质只切了 #6 的**前端层**，runtime checkout 层被推到 Wave 3。

DAG `W2 → W3` 串行意味着 Wave 2 完成时 runtime checkout 不可用，T4.1/T4.2 无法端到端跑通（WS `git.checkout` 发出，runtime 无 handler case → 失败）。Wave 2 完成定义不成立。

### 视角 2：依赖闭合（Wave 依赖从⑤§4 时序图完整推导？）

**结论：大部分闭合；#6 runtime checkout 依赖未闭合（同视角 1 根因）。**

从⑤§4 时序图推导的调用链 → Wave 依赖：

| 调用链（⑤§4） | 被调用方实现所在 Wave | 依赖是否闭合 |
|--------------|---------------------|------------|
| §4.1 startFlow → resolveDefaultCwd(#4) → sessionApi.create(#1) | #4/#1 均在 Wave 1 | ✅ 闭合（#4 挪入 Wave 1 合理，见关键验证点 5） |
| §4.2 selectWorkspace/openDirDialog → sessionApi.create(#1) | #1 在 Wave 1，Wave 2 blocked_by Wave 1 | ✅ 闭合 |
| §4.3 selectBranch/confirmDirtySwitch → **gitApi.checkout(#6)** → runtime GitService.checkout → IGitExecutor.exec('checkout') | 前端 gitApi.checkout 在 Wave 2；**runtime GitService.checkout / GitCommand 'checkout' / handler case / protocol 漏归属（Wave 2 没列，Wave 3 才列 GitCommand 白名单 + protocol git.checkout）** | ❌ **未闭合** |
| §4.4 submitCreateBranch → gitApi.createBranch(#7) → runtime GitService.createBranch | 全在 Wave 3 | ✅ 闭合 |
| §4.5 UC-7 守卫（gitInfo==null）→ 复用 git-info 既有缓存 | Wave 1（landing 守卫随 #2） | ✅ 闭合 |

**未闭合点**：⑤§4.3 时序图 `Git2[gitApi.checkout #6 新增]` → runtime `GitService.getStatus`（已有）+ `GitService.checkout`（#6 新增，⑤§3.5 标 #6）+ `IGitExecutor.exec('checkout')`（GitCommand 白名单加 'checkout'，⑤§3.6 标 #6+#7 共用）+ handler `case 'git.checkout'`（⑤§3.7 标 #6）。这些 runtime 工作按⑤§3 明确属 #6，应在 Wave 2，但⑥Wave 2 文件影响零 runtime 条目，Wave 3 把它们全揽走（Wave 3 文件影响写「GitCommand 加 checkout / protocol 加 git.checkout」）。

### 视角 3：并行安全（同并行组真不改同一文件？useNewTaskFlow.ts 渐进扩展真串行？）

**结论：无并行冲突；但文档标注不完整。**

| 共享文件 | 改它的 Wave | 串行/并行 | 安全 |
|---------|-----------|----------|------|
| `useNewTaskFlow.ts` | Wave 1（主干）→ Wave 2（select*/confirm*）→ Wave 3（openBranchModal/submitCreateBranch） | DAG W1→W2→W3 串行链 | ✅ 安全，文档已显式标注「渐进扩展但串行」 |
| `api/domains/git.ts` | Wave 2（checkout）→ Wave 3（createBranch） | W2→W3 串行 | ✅ 安全，但**文档「并行约束」章节只标 useNewTaskFlow，遗漏 git.ts 同样被 W2/W3 串行改** |
| runtime `git-service.ts` / `git-executor.ts` / `handler` / `protocol` | Wave 3 声称全包（但 #6 checkout 应在 Wave 2） | — | ⚠ 与视角 1/2 同根因 |

**并行组列语义混淆**：调度表「并行组」列 Wave 1=—、Wave 2=B(组件层)、Wave 3=C。但 DAG 是纯串行链（W1→W2→W3），**无任何两个 Wave 间并行**。B/C 实际标注的是 Wave **内部** #5/#6 组件文件并行，非 Wave 间并行组。容易误读为「Wave 2 与 Wave 3 可并行」。非硬错误，但标注语义不清。

### 视角 4：测试闭环 + 实现闭环

**结论：用例 ID 集合层面完全闭合；但 Wave 2 的用例其 runtime 依赖未在 Wave 2 落地（与视角 1 同根因）。**

**4a. 用例 ID 并集核对（grep -oE 实证）**

| 来源 | 用例数 | 集合 |
|------|-------|------|
| ⑤§6 test-matrix 全量 | 39 | T1.1-T1.9, T3.1-T3.5, T4.1-T4.9, T6.1-T6.8, T7.1-T7.2, T8.1-T8.6 |
| ⑥测试验收清单 | 39 | **完全相等**（diff 为空） |
| Wave 1 覆盖 | 16 | T1.1-T1.8, T7.1, T7.2, T8.1-T8.6 |
| Wave 2 覆盖 | 14 | T3.1-T3.5, T4.1-T4.9 |
| Wave 3 覆盖 | 8 | T6.1-T6.8 |
| 独立 ticket #8 | 1 | T1.9 |
| Wave 4（验收） | 0 | （验收 Wave 不覆盖用例，只核验）|
| **并集** | **39** | **= 全量，无遗漏无多余无重复归属** ✅ |

**4b. 时序图 alt/else 异常分支覆盖**

⑤异常分支 E1-E11 全部映射到用例且归属 Wave：

| 异常分支 | 用例 | 归属 Wave |
|---------|------|----------|
| E1 双击并发 | T1.3 | Wave 1 ✅ |
| E2 非法 cwd | T1.4 | Wave 1 ✅ |
| E3 spawn 失败 | T1.5 | Wave 1 ✅ |
| E4 空列表 | T3.2 | Wave 2 ✅ |
| E5 IPC 抛错 | T3.5 | Wave 2 ✅ |
| E6 非 git | T4.4 | Wave 2 ✅ |
| E7 unborn HEAD | T4.3 | Wave 2 ✅ |
| E8 checkout 冲突 | T4.5 | Wave 2 ✅ |
| E9 非法来源 | T6.5 | Wave 3 ✅ |
| E10 已存在 | T6.3 | Wave 3 ✅ |
| E11 超时 | T6.4 | Wave 3 ✅ |

11/11 异常分支全覆盖 ✅。状态机转换（§4.6）由 T8.1-T8.6 + T7.1 覆盖 ✅。

**4c. NFR 来源 B 用例覆盖**

T1.8（#2 稳定性）、T1.9（#8 兼容）、T4.7（#6 性能）、T6.8（#7 安全）—— 4 个 NFR 独有用例全归属 Wave（T1.8→W1, T4.7→W2, T6.8→W3, T1.9→独立#8）✅。

**4d. 实现闭环（验收 Wave 强制）**

- 「测试验收清单」章节存在，用例 ID 集合 = ⑤全量 ✅
- 末尾验收 Wave 标题「Wave 4: 验收 Wave（Acceptance Gate）」含「验收」+「Acceptance」关键字 ✅（check_execution 硬性要求）
- Wave 4 `Blocked by: Wave 1, Wave 2, Wave 3（所有功能 Wave）` ✅
- 独立 ticket #8（T1.9）不阻塞主验收，Wave 4 不 blocked_by 它（D-4 决策，清单含 T1.9 满足集合相等，实现验收分主流程 38 + 独立 1）✅
- 交接措辞为硬契约（DoD = 清单全绿）✅

**4e. 骨架叶子作用域 → Wave 映射**

| 骨架文件 | 归属 Wave | 核验 |
|---------|----------|------|
| Landing.vue | Wave 1（#2） | ✅ |
| useNewTaskFlow.ts | Wave 1/2/3 串行扩展 | ✅ |
| lib/utils.ts | Wave 1（#4 resolveDefaultCwd+recentWorkspaces） | ✅ |
| session.ts（create） | Wave 1（#1） | ✅ |
| DirSelectPopover.vue | Wave 2（#5） | ✅ |
| BranchSelectPopover.vue | Wave 2（#6 前端） | ✅ |
| git.ts（checkout） | Wave 2（#6 前端） | ✅ |
| **runtime git-service.ts checkout** | **应 Wave 2（#6），文档漏** | ❌ 见 gap |
| **runtime git-executor.ts GitCommand 'checkout'** | **⑤标 #6+#7 共用，Wave 2 先用，文档归 Wave 3** | ❌ 见 gap |
| **runtime git-message-handler.ts case git.checkout** | **应 Wave 2（#6），文档归 Wave 3** | ❌ 见 gap |
| **shared/protocol.ts git.checkout** | **应 Wave 2（#6），文档归 Wave 3** | ❌ 见 gap |
| CreateBranchModal.vue | Wave 3（#7 前端） | ✅ |
| git.ts（createBranch） | Wave 3（#7 前端） | ✅ |
| runtime git-service.ts createBranch | Wave 3（#7 runtime） | ✅ |
| runtime git-message-handler case git.createBranch | Wave 3（#7 runtime） | ✅ |
| shared/protocol.ts git.createBranch | Wave 3（#7 runtime） | ✅ |

## Gap 列表（F/K/D 分类）

### Gap-1 [F] Wave 2 缺 #6 runtime checkout port 扩展（切片独立性 + 依赖闭合 + 测试闭环三重断裂）

**现象**：Wave 2 文件影响只列前端（useNewTaskFlow 扩展、git.ts.checkout、DirSelect/BranchSelectPopover），零 runtime 条目。但 #6 的 git checkout 写路径需 runtime：`GitService.checkout`（⑤§3.5 标 #6）+ `GitCommand` 白名单加 `'checkout'`（⑤§3.6 标 #6+#7 共用，#6 先用 `checkout <name>`）+ handler `case 'git.checkout'`（⑤§3.7 标 #6）+ protocol `git.checkout` 消息（⑤§1.2 含 #6）。

**影响**：
- Wave 2 完成时 runtime 无 checkout handler，T4.1（选干净分支 checkout）、T4.2（dirty 确认切走）、T4.5（E8 checkout 冲突）端到端跑不通（WS git.checkout 发出→runtime 无 case→失败）。Wave 2「完成定义」不成立。
- Wave 2 不是垂直切片（只切前端层），违反 vertical-slice.md。

**根因（F 需二次确认）**：⑤§1.2 小节标题「runtime（后端）扩展（**仅 #7 port 扩展**）」与表格内容（含 #6 的 `git.checkout` / `GitService.checkout` / handler case / GitCommand 'checkout'）**自相矛盾**。⑥可能被标题误导，把 checkout runtime 全归 Wave 3（#7）。但⑤§3.5/§3.6/§3.7 内容层清楚标注 #6 用 checkout。需确认：#6 checkout 的 runtime port 扩展是否应随 #6 进 Wave 2。

**建议修复（Step 3 决策）**：把 runtime checkout port 扩展从 Wave 3 挪到 Wave 2：
- Wave 2 文件影响增列 runtime：`git-service.ts`（checkout）、`git-executor.ts`（GitCommand 加 'checkout'）、`git-message-handler.ts`（case git.checkout）、`protocol.ts`（git.checkout 消息）
- Wave 3 文件影响保留：`git-service.ts`（createBranch）、`handler`（case git.createBranch）、`protocol`（git.createBranch 消息）；GitCommand 白名单 'checkout' 改标「Wave 2 已扩，Wave 3 复用」
- Wave 2 执行流增 runtime 扩展步骤（参考 Wave 3 runtime 扩展步骤模式）

### Gap-2 [D] git.ts 被 Wave 2/3 串行扩展未显式标注

**现象**：文档「并行约束」章节只标注 `useNewTaskFlow.ts` 被 Wave 1/2/3 渐进扩展（串行），遗漏 `api/domains/git.ts` 同样被 Wave 2（checkout）→ Wave 3（createBranch）串行改。

**影响**：非冲突（W2→W3 串行，DAG 已锁），但文档完整度。subagent 配置读取时可能误以为 git.ts 只归一个 Wave。

**建议**：并行约束章节补注「git.ts 被 Wave 2(checkout)/Wave 3(createBranch) 串行扩展，非并行」。

### Gap-3 [D] 调度表「并行组」列语义混淆

**现象**：调度表「并行组」列 Wave 1=—、Wave 2=B(组件层)、Wave 3=C。但 DAG `W1→W2→W3` 是纯串行链，**无 Wave 间并行**。B/C 实标 Wave 内部 #5/#6 组件文件并行。

**影响**：易误读为「Wave 2 与 Wave 3 可并行调度」，与 DAG 串行边冲突。

**建议**：列名改「内部并行」或加注「B/C 指 Wave 内组件文件并行，非 Wave 间并行；Wave 间严格 W1→W2→W3 串行」。

### Gap-4 [F] ⑤§1.2 标题「仅 #7 port 扩展」与内容矛盾（Gap-1 根因，需反哺⑤）

**现象**：⑤code-architecture.md §1.2 小节标题「runtime（后端）扩展（仅 #7 port 扩展）」，但表格 4 行中 3 行（GitCommand 'checkout'、GitService.checkout、handler git.checkout、protocol git.checkout）属 #6，仅 createBranch 专属部分属 #7。

**影响**：误导⑥把 checkout runtime 全归 Wave 3（Gap-1 根因）。属⑤上游文档不一致。

**建议**：Step 6b 反哺⑤，标题改为「runtime（后端）扩展（#6 checkout + #7 createBranch port 扩展）」，或在表格内逐行标注 #6/#7 归属（⑤§3.5-3.7 已标，§1.2 对齐即可）。

## 关键验证点核对

| # | 验证点 | 结果 | 证据 |
|---|-------|------|------|
| 1 | ⑤§6 test-matrix 全量(39) = ⑥测试验收清单集合 | ✅ **完全相等** | `grep -oE 'T[0-9]+\.[0-9]+'` 两边各 39 个，sort -V uniq 后 diff 为空 |
| 2 | 末尾验收 Wave 标题含「验收/Acceptance」 | ✅ | 「Wave 4: 验收 Wave（Acceptance Gate）」 |
| 3 | 验收 Wave blocked_by 所有功能 Wave | ✅ | 「Blocked by: Wave 1, Wave 2, Wave 3（所有功能 Wave）」 |
| 4 | 每功能 Wave 覆盖用例并集 = 清单全量 | ✅ | W1(16)+W2(14)+W3(8)+独立#8(1)=39，无遗漏无多余无重复 |
| 5 | Wave 1 把 #4 从⑤§8 W3 挪到 W1 是否合理 | ✅ **合理** | ⑤T1.2 断言「sessions=[]→cwd=undefined→chip 空态+发送 disabled（延迟 create）」；⑤§4.1 时序图 L250 `F->>Utl: resolveDefaultCwd(sessions)` → cwd=undefined 分支 → 不调 create → landing 空态。T1.2 完整链路**必须** resolveDefaultCwd 就绪才能验证「首次启动 cwd=undefined」边界。⑤§8 把 #4 放 W3（随 #5/#6）会导致 Wave 1 主流程无法验证 T1.2。⑥挪入 Wave 1 正确（D-1 决策理由成立） |
| 6 | useNewTaskFlow.ts 被 W1/2/3 渐进扩展是否真串行 | ✅ 串行 | DAG `W1→W2→W3`，Wave 2 blocked_by W1，Wave 3 blocked_by W1+W2。非并行，无冲突 |
| 7 | 时序图每个 alt/else 异常分支落在某 Wave | ✅ | E1-E11 全映射（见视角 4b） |
| 8 | 每功能 Wave 覆盖用例都在清单出现（双向一致） | ✅ | Wave 覆盖集 ⊆ 清单集，清单归属列与 Wave 覆盖一致 |
| 9 | 骨架每个叶子作用域映射到 Wave | ❌ | runtime checkout 相关 4 文件归属错位（Gap-1）：骨架 git-service.ts:211 checkout / git-executor.ts:22 GitCommand / handler / protocol git.checkout 应归 Wave 2，文档归 Wave 3 |

## 收敛建议（供 Step 3 分流）

- **Gap-1 + Gap-4 联动处理**（最高优先级）：Gap-4 是⑤上游标题矛盾（F），反哺⑤修标题；Gap-1 是⑥据此调整 Wave 2 文件影响（增 runtime checkout 4 文件）+ Wave 3 去掉重复。修后 Wave 2 成为真垂直切片，T4.1/T4.2/T4.5 端到端闭合。
- **Gap-2 / Gap-3**：D 类文档完善度，Step 3 自决补注，不影响交付正确性。
- 其余 8 项关键验证点全过，用例 ID 集合层面测试闭环 + 实现闭环完全闭合。

**本轮 converged: false**——Gap-1 是切片独立性 + 依赖闭合 + 测试闭环三重硬伤（Wave 2 无法独立端到端验证），必须 Step 3 修复后进入 Round 2 复核。
