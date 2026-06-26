---
verdict: CONSISTENT
phase: execution
step: 6c
role: 独立一致性终检 subagent（上下文隔离）
upstream: [requirements, system-architecture, issues, non-functional-design, code-architecture, execution-plan]
---

# 跨文档一致性终检（Step 6c 总闸门）

> 编码前对①-⑥全部 .md + ⑤骨架代码做一次性总闸门审计。与每阶段 Step 6b（增量反哺）互补：6c 扫跨多阶段累积矛盾。

## Step 0 机器检查复核（硬阻断）

依次跑 6 阶段 check 脚本（编码前总复核）：

| 阶段 | 脚本 | 结果 |
|------|------|------|
| ① clarity | check_clarity.py | ✅ 7/7 PASS |
| ② architecture | check_architecture.py | ✅ 8/8 PASS |
| ③ issues | check_issues.py | ✅ 9/9 PASS |
| ④ nfr | check_nfr.py | ✅ 8/8 PASS |
| ⑤ code_arch | check_code_arch.py | ✅ 14/14 PASS |
| ⑥ execution | check_execution.py | ⚠️ 7/8 PASS，唯一 FAIL = consistency-final 不存在（本文件即是其产物，生成后复核） |

**结论**：5 个上游阶段全 PASS；⑥唯一 FAIL 是本终检产物缺失（预期，本文件生成后即消除）。进入 6 维审计。

---

## 维度 1：术语一致性

**检查项**：①统一语言（CONTEXT.md）术语在②-⑥用词一致；状态机 Status/Reason 枚举在②⑤骨架一致。

### 术语对齐

| 术语 | ① | ② | ③ | ④ | ⑤ | 骨架 |
|------|---|---|---|---|---|------|
| Session / Task（1:1） | ✅ | ✅ | ✅ | ✅ | ✅ | shared/session.ts SessionSummary |
| NewTaskFlow | — | ✅ §3 引入 | ✅ | ✅ | ✅ §3.3 | useNewTaskFlow.ts |
| NewTaskFlowState | — | ✅ §5 8态 | ✅ | — | ✅ §3.3 type | useNewTaskFlow.ts ALLOWED 表 |
| 落地空态 (Landing) | ✅ | ✅ §3 | ✅ | ✅ | ✅ §3.3 | Landing.vue |
| RecentWorkspace (DTO) | ✅ 派生 | ✅ §4 DTO | ✅ #4 | — | ✅ §3.4 | lib/utils.ts RecentWorkspace |
| directory/branch chip | ✅ | ✅ §3 | ✅ | — | ✅ | Landing.vue chip-dir/chip-branch |
| resolveDefaultCwd | — | ✅ §4 | ✅ #4 | — | ✅ §3.4 | lib/utils.ts |
| GitInfo | — | ✅ §4（runtime 读模块 git-info） | — | — | ✅ §3.3（frontend 派生类型） | types.ts GitInfo |

### 状态机枚举一致性

②§5 Status 枚举：`idle | landing | dir-popover | branch-popover | dir-dialog | branch-modal | completed | cancelled`（8 态）
⑤§3.3 NewTaskFlowState type：同 8 态 ✅
骨架 `useNewTaskFlow.ts` NewTaskFlowState type + ALLOWED 转换表：同 8 态 ✅

②§5 明确「不引入 Reason 字段」（唯一终态 completed，无多失败原因正交）→ ⑤骨架无 Reason 字段 ✅

②§5 SessionStatus（active/idle，由 isGenerating 派生）不变（D-3）→ 骨架 `shared/src/session.ts` SessionStatus = `'active' | 'idle'` ✅

> **命名澄清（非矛盾）**：②§4 的「GitInfo（代码名 git-info）」指 runtime 读模块（services/git-info.ts，分层债）；⑤types.ts 的 `GitInfo` 指 frontend chip 可见性派生类型。两者同名但分层不同、结构不同（runtime 模块 vs `{branch,isRepo}` 类型），⑤引入时已明确为 frontend 派生类型，未与②runtime 模块冲突。可接受。

**维度 1 verdict**：✅ CONSISTENT

---

## 维度 2：用例可追溯（全链不断）

**检查项**：①每个 UC → ③对应 issue → ⑤对应时序图 → ⑥对应 Wave；无孤立 UC、无幽灵 Wave。

| ① UC | ③ issue | ⑤ 时序图 | ⑥ Wave |
|------|---------|---------|--------|
| UC-1 新建任务主流程 | #2 landing + #3 composable | §4.1 UC-1+UC-2 | Wave 1 |
| UC-2 直接发送消息 | #1 cwd透传 + #2 landing | §4.1 UC-1+UC-2 | Wave 1 |
| UC-3 更换工作目录 | #5 dir popover | §4.2 UC-3+UC-5 | Wave 2 |
| UC-4 切换分支 | #6 branch popover | §4.3 UC-4 | Wave 2 |
| UC-5 打开外部文件夹 | #5 OS dialog | §4.2 UC-3+UC-5 | Wave 2 |
| UC-6 创建并检出新分支 | #7 createBranch modal | §4.4 UC-6 | Wave 3 |
| UC-7 非git目录新建任务 | #2 landing 守卫 | §4.5 UC-7 | Wave 1（随 #2） |

**反向核验（无幽灵 Wave）**：
- ⑥ Wave 1 (#1+#2+#3+#4) → #1=UC-2 tech path, #2=UC-1/UC-7, #3=UC-1 编排, #4=UC-3/UC-2 数据基座 ✅
- ⑥ Wave 2 (#5+#6) → UC-3/UC-5, UC-4 ✅
- ⑥ Wave 3 (#7) → UC-6 ✅
- ⑥ 独立 #8 → BC-11 forkSession 波及（非 UC，但③显式登记）✅
- ⑥ Wave 4 → 验收 Wave（非功能）✅

全 7 UC 有下游落点；全 Wave 有上游来源。无孤立 UC、无幽灵 Wave。

**维度 2 verdict**：✅ CONSISTENT

---

## 维度 3：AC 覆盖闭环

**检查项**：①UC AC → ③issue AC → ⑤test-matrix → ⑥Wave 验收，全覆盖；⑥Wave 覆盖 test-matrix ID 并集 = ⑤全量。

### ① UC AC → ⑤ test-matrix 覆盖

| ① UC AC | ⑤ test-matrix ID |
|---------|-----------------|
| UC-1 AC-1.1（⌘N→落地→发送） | T1.1, T1.6 |
| UC-1 AC-1.2（原生dialog取消→落回） | T3.4 |
| UC-1 AC-1.3（首次启动空态+disabled） | T1.2 |
| UC-2 AC-2.1（非首次沿用cwd） | T1.1 |
| UC-2 AC-2.2（首次disabled） | T1.2 |
| UC-3 AC-3.1（选workspace→chip更新） | T3.1 |
| UC-3 AC-3.2（空列表空态） | T3.2 |
| UC-4 AC-4.1（干净分支切换） | T4.1 |
| UC-4 AC-4.2（dirty二次确认） | T4.2 |
| UC-4 AC-4.3（unborn HEAD空态） | T4.3 |
| UC-5 AC-5.1（dialog选中→chip） | T3.3 |
| UC-5 AC-5.2（取消→落回） | T3.4 |
| UC-6 AC-6.1（合法名创建切换） | T6.1 |
| UC-6 AC-6.2（已存在红字） | T6.3 |
| UC-6 AC-6.3（空名disabled） | T6.2（非法名含空名） |
| UC-6 AC-6.4（git写失败modal显错） | T6.3, T6.4 |
| UC-7 AC-7.1（非git隐藏branch） | T7.1, T4.4 |
| UC-7 AC-7.2（变git恢复显示） | T7.2 |

全 ① UC AC 在 ⑤ test-matrix 有落点 ✅

### ⑤ test-matrix 全量 → ⑥ Wave 并集（集合相等校验）

⑤ test-matrix 用例 ID（39 个 = 来源 A 功能 35 + 来源 B NFR 4）：
- 来源 A：T1.1-T1.7（7）+ T3.1-T3.5（5）+ T4.1-T4.6/T4.8/T4.9（8）+ T6.1-T6.7（7）+ T7.1/T7.2（2）+ T8.1-T8.6（6）= 35
- 来源 B 新增：T1.8, T4.7, T6.8, T1.9 = 4

⑥ 测试验收清单归属 Wave 并集：
- Wave 1：T1.1-T1.8（8）+ T7.1/T7.2（2）+ T8.1-T8.6（6）= 16
- Wave 2：T3.1-T3.5（5）+ T4.1-T4.9（9，含 T4.7 条件性）= 14
- Wave 3：T6.1-T6.8（8）= 8
- 独立 ticket #8：T1.9（1）

并集 = 16 + 14 + 8 + 1 = **39** = ⑤全量 ✅（无遗漏无多余）

**维度 3 verdict**：✅ CONSISTENT

---

## 维度 4：决策一致性（未被静默推翻）

**检查项**：②③ D-不可逆决策在④⑤⑥未被静默偏离；偏离有 Step 6b 反哺记录。

### D-不可逆决策保持核验

| 决策 | 来源 | ⑤骨架/⑥保持？ | 备注 |
|------|------|---------------|------|
| D-1 三层不套四层（核心=技术编排） | ② | ✅ ⑤§2 三层 | 无四层空壳 |
| D-2 RecentWorkspace=派生 DTO | ② | ✅ ⑤§3.4 + lib/utils.ts 派生函数 | 非独立缓存 |
| D-3 落地空态用 messageCount 派生 | ② | ✅ SessionStatus='active'\|'idle' 不变 | 未引入 empty |
| D-4 显式转换表 | ② | ✅ 骨架 ALLOWED 表 + 非法转换抛错回 idle | 完整落地 |
| D-5 git 服务分离（T2 打回） | ② | ✅ ⑤§7 git-info.ts keep | 不合并 |
| D-6 派生函数（T3 打回） | ② | ✅ recentWorkspaces 派生 | 无 RecentItemsStore 泛型 |
| D-7 createBranch 失败留 modal | ③ | ✅ ⑤§4.4 E10 + 骨架 submitCreateBranch 失败不 transition | ②§5 mermaid 已反哺拆分 |
| D-A3 首次启动强制选目录 | ③ | ✅ ⑤§4.1 AC-1.7 + 骨架 startFlow 延迟 create | BF1 裁决落地 |
| Q1 components/new-task/ 聚合 | ②→⑤ | ✅ ⑤§1.1 目录结构 | — |
| Q2 全局单实例 | ②→⑤ | ✅ ⑤§1 Q2=A + 骨架模块级单实例 | Obs-B 裁决落地 |
| Q3 严格包边界 | ②→⑤ | ✅ ⑤§2 import 规则 | 骨架 import 全合规 |

### 偏离项核验（均有反哺/裁决记录）

| 偏离 | 性质 | 反哺/裁决记录 |
|------|------|--------------|
| ⑥ D-1 Wave 划分偏离⑤§8 提示（W1 合并 #1+#2+#3+#4） | ⑥职责范围调整（⑤§8 是「提示」非「结论」，不构成⑤证伪） | ⑥决策记录 D-1 显式论证，不反哺⑤ ✅ |
| ⑥ D-5 #6 runtime checkout 归 Wave 2 非 Wave 3 | ⑤§1.2 标题「仅#7」与表格内容矛盾（Gap-1） | ⑤§1.2 标题已反哺改「#6 checkout + #7 createBranch」+ BACKFED 注释 ✅ |
| ⑥ D-6 / T4.7 条件性验收 | ④NFR 允许 v1 不加缓存，⑤T4.7 原未显式标条件性 | ⑤T4.7 已反哺改「边界（条件性）」+ BACKFED 说明块 ✅ |

⑤ frontmatter `backfed_from: [execution]` 记录 Gap-4/D-6 反哺 ✅。无静默推翻。

**维度 4 verdict**：✅ CONSISTENT

---

## 维度 5：NFR 回灌闭环

**检查项**：④每条缓解项去向落地；④「验收方式=代码测试」缓解项 → ⑤§6 来源 B 对应用例 → 该用例落⑥某 Wave。

### ④代码测试缓解项 → ⑤§6 来源 B → ⑥ Wave 闭环

| ④缓解项（代码测试） | 来源# | ⑤§6 来源 B 用例 ID | ⑥ Wave |
|---------------------|-------|-------------------|--------|
| 新建触发点幂等保护（in-flight） | #1 | T1.3 | Wave 1 ✅ |
| runtime cwd 路径校验 | #1,#5 | T1.4 | Wave 1 ✅ |
| getHistory 失败 landing 有重试出口 | #2 | T1.8 | Wave 1 ✅ |
| 状态机非法转换回 idle + Vue 错误边界 | #3 | T8.6 | Wave 1 ✅ |
| overlay 打开切 session cancelled 转移 | #3 | T8.3 | Wave 1 ✅ |
| getStatus 新建 per-cwd 缓存（条件性） | #6 | T4.7 | Wave 2 ✅（条件性） |
| dirty 切走 inline 二次确认条 | #6 | T4.2 | Wave 2 ✅ |
| pick-directory IPC 招错 popover 显错 | #5 | T3.5 | Wave 2 ✅ |
| createBranch 分支名双重校验 | #7 | T6.2 + T6.8 | Wave 3 ✅ |
| createBranch 提交按钮 disabled 防重复 | #7 | T6.6 | Wave 3 ✅ |
| createBranch 失败留 modal（D-7） | #7 | T6.3 | Wave 3 ✅ |
| forkSession 源 cwd 透传 | #8 | T1.9 | 独立 ticket ✅ |

全 12 条代码测试缓解项有 ⑤用例 + ⑥Wave 落点 ✅

### ④骨架约束缓解项 → ⑤§3.8 落点核验

| ④骨架约束项 | ⑤§3.8 落点 | 骨架/时序图标位 |
|------------|-----------|----------------|
| session.create 失败回滚 | runtime session-lifecycle | ⑤§4.1 时序图 E3 分支已标 ✅ |
| session.create 结构化日志（cwd） | runtime session-lifecycle logger | 骨架注释接线点 ✅ |
| landing 渲染条件（hydrate 前不渲染完整） | Landing.vue | 骨架 Landing.vue 注释 ✅ |
| 状态转换 debug 日志 + 非法转换计数 | useNewTaskFlow.ts | 骨架 illegalTransitionCount ✅ |
| getStatus P99 耗时埋点 | GitService.getStatus | 骨架注释「NFR④ 性能埋点」✅ |
| createBranch 经 port 继承 8000ms 超时 | GitService.createBranch → IGitExecutor | 骨架经 execSafe→port ✅ |
| GitCommand 白名单显式枚举 | ports/git-executor.ts | 骨架 GitCommand 含 'checkout' ✅ |
| createBranch 结构化日志 | GitService.createBranch logger | 骨架注释 ✅ |

运维项（getStatus P99>200ms 告警）→ 部署期配置，不进代码层 ✅

**维度 5 verdict**：✅ CONSISTENT

---

## 维度 6：骨架↔文档一致

**检查项**：⑤骨架类/方法签名与⑤签名表一致；⑤骨架 import 与⑤包依赖图一致；⑤骨架每个叶子作用域映射到⑥一个 Wave。

### 签名表 ↔ 骨架一致性（逐方法）

| ⑤§3 签名 | 骨架定义 | 一致 |
|---------|---------|------|
| sessionApi.create(cwd?, label?) | session.ts `create(cwd?: string, label?: string)` | ✅ |
| gitApi.checkout(sessionId, name) | git.ts `checkout(sessionId: string, name: string)` | ✅ |
| gitApi.createBranch(sessionId, name) | git.ts `createBranch(sessionId: string, name: string)` | ✅ |
| useNewTaskFlow 15 成员（state/currentSessionId/gitInfo + 12 动作） | useNewTaskFlow.ts 全 15 成员 | ✅ |
| resolveDefaultCwd(sessions) → string\|undefined | utils.ts 同签名 + 脏数据跳过 | ✅ |
| recentWorkspaces(sessions) → RecentWorkspace[] top10 | utils.ts 同签名 + distinct 去重 | ✅ |
| GitService.createBranch → execSafe(checkout,[-b,name]) | git-service.ts `checkout -b` | ✅ |
| GitService.checkout → execSafe(checkout,[name]) | git-service.ts `checkout <name>` | ✅ |
| GitCommand 加 'checkout' | git-executor.ts GitCommand 含 'checkout' | ✅ |
| GitMessageHandler case git.checkout/createBranch | git-message-handler.ts:76,85 两 case | ✅ |
| protocol git.checkout/createBranch | protocol.ts ClientMessageType/Map/union 三处 | ✅ |

⑤§9 骨架覆盖核验表 16/16 全 ✅ 接线完整，无 ❌ 未定义。vue-tsc --noEmit EXIT 0（见 skeleton-verification.md）。

### 包依赖图 ↔ 骨架 import 一致性

- useNewTaskFlow.ts import：vue + @/api（session/git）+ @/lib/utils + @/lib/ipc + @/stores/session + @/types → 合规⑤§2「composables 依赖 api/domains + lib + stores，不直 import transport」✅
- api/domains/{session,git}.ts import：transport + pending + @xyz-agent/shared → 合规 ✅
- lib/utils.ts import：仅 @xyz-agent/shared → 合规⑤§2「纯函数零内部依赖」✅
- runtime git-service.ts import：经 ports/git-executor interface +（既有）infra/git-status-parser（⑤§5.1 纯函数豁免）→ 合规 ✅
- runtime git-message-handler.ts import：→ git-service → ports，单向无循环 ✅

无循环依赖；分层方向全合规。

### 骨架叶子作用域 → ⑥ Wave 映射

| 骨架文件 | ⑥ Wave |
|---------|--------|
| useNewTaskFlow.ts（主干 state/startFlow/landing 转换） | Wave 1 |
| useNewTaskFlow.ts（select*/confirm*/openDir*） | Wave 2 |
| useNewTaskFlow.ts（openBranchModal/submitCreateBranch） | Wave 3 |
| Landing.vue | Wave 1 |
| lib/utils.ts | Wave 1 |
| api/domains/session.ts | Wave 1 |
| stores/session.ts（桩） | Wave 1（读依赖） |
| types.ts（GitInfo） | Wave 1 |
| DirSelectPopover.vue / BranchSelectPopover.vue | Wave 2 |
| api/domains/git.ts（checkout） | Wave 2 |
| runtime git-service.ts（checkout）/ git-executor.ts（GitCommand）/ git-message-handler.ts（git.checkout）/ protocol.ts（git.checkout） | Wave 2 |
| CreateBranchModal.vue | Wave 3 |
| api/domains/git.ts（createBranch） | Wave 3 |
| runtime git-service.ts（createBranch）/ git-message-handler.ts（git.createBranch）/ protocol.ts（git.createBranch） | Wave 3 |
| lib/ipc.ts / preload/index.d.ts（pick-directory） | Wave 2 |
| 其他既有文件（transport/pending/message-context/infra 等） | 既有基座，无 new-task 改动 |

全骨架文件映射到 Wave，无孤儿骨架代码。

**维度 6 verdict**：✅ CONSISTENT

---

## 矛盾列表

**无阻断矛盾。**

### 非阻断观察（不阻塞编码，记录供编码期注意）

**观察 1（文档清单完备性，非一致性矛盾）**：④#1 安全「runtime cwd 路径校验」+ ④#1 稳定性「session.create 失败回滚」标 `验收方式=代码测试/骨架约束`，落点为 runtime `session-lifecycle.ts`（既有文件，非 new-task 修改范围，故不在⑤骨架内）。⑥ Wave 1「文件影响」清单目前只显式列 renderer 侧文件，未列 runtime session-lifecycle.ts 的校验/回滚改动。

- **为何非阻断**：④自身已显式标此为「⑤待落项 / 残余风险」（④#1 安全原文：「校验⑤落地前为残余风险；落地后归零」）；⑤§3.8 已登记为骨架约束 + §4.1 时序图标 E2/E3 分支；⑥ Wave 1 测试 T1.4（非法 cwd reject）/T1.5（spawn 失败回滚）已在清单。TDD 流程（Wave 1 先写 T1.4/T1.5 失败测试 → 驱动 runtime session-lifecycle.ts 加校验/回滚 → 测试转 PASS）会自然在编码期闭环。
- **建议**：编码期 Wave 1 启动时，在「文件影响」补列 runtime `session-lifecycle.ts`（cwd 校验 + 失败回滚），避免 subagent 漏改。属实施清单完备性优化，非设计矛盾。

**观察 2（命名相似，非冲突）**：②§4「GitInfo（代码名 git-info）」是 runtime 读模块（分层债）；⑤types.ts「GitInfo」是 frontend chip 可见性派生类型。同名异层异构，⑤引入时已明确为 frontend 类型，未与②runtime 模块语义冲突。可接受，建议编码期注释澄清。

---

## Verdict

### **CONSISTENT**

**总闸门通过，可交接编码。**

6 维审计结论：
- 维度 1 术语一致性：✅ 状态机 8 态枚举在②⑤骨架完全一致，无 Reason 字段一致，SessionStatus 不变一致
- 维度 2 用例可追溯：✅ 全 7 UC → issue → 时序图 → Wave 全链不断，无孤立 UC/幽灵 Wave
- 维度 3 AC 覆盖闭环：✅ ①UC AC 全覆盖，⑤test-matrix 39 用例 = ⑥Wave 并集 39（集合相等）
- 维度 4 决策一致性：✅ 全 D-不可逆决策保持，偏离项（Wave 划分/#6 checkout 归属/T4.7 条件性）均有 6b 反哺或⑥职责内论证
- 维度 5 NFR 回灌闭环：✅ 12 条代码测试缓解项全有 ⑤用例+⑥Wave 落点，8 条骨架约束全有骨架/时序图标位
- 维度 6 骨架↔文档一致：✅ 签名表 16/16 与骨架一致，包依赖图 import 合规，骨架叶子作用域全映射 Wave

矛盾列表无阻断项；2 条非阻断观察已记录（编码期补 runtime 文件影响清单 + GitInfo 命名注释），不阻塞交接。

**编码期 Definition of Done**：⑥测试验收清单 39 用例全 PASS（T1.9 独立 ticket #8 不阻塞主交付 38 用例）。
