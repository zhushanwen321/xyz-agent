---
phase: step3-tracing
round: 1
source: system-architecture.md
mode: independent-rebuild
converged: false
---

# 上游覆盖核验 — 独立重建（Round 1）

> 独立 subagent 重建，**禁读 issues.md** 前提下按 fog-of-war.md 4 轴 + 兜底从 ② 逐条枚举。
> 重建完成后读 issues.md「上游覆盖核验」章节做 diff，产出 MISSING / PHANTOM / MISMATCH。

## T_recon — 独立重建覆盖表

### 状态轴（§5 NewTaskFlowState + Session 生命周期）

| # | 上游元素 | 轴 | 该对应什么 issue |
|---|---------|----|-----------------|
| 1 | idle→landing（触发新建/重选空 session） | 状态 | #3 状态机 + newSession 触发点编排 |
| 2 | landing→dir_popover / branch_popover（点 chip） | 状态 | #3 状态机 |
| 3 | landing→completed（发送首条消息成功） | 状态 | #3 状态机（唯一终态） |
| 4 | landing→landing（发送失败，composer 子态显错） | 状态·异常 | 标 #3，但 composer 显错 UI 落点存疑（应涉 #2 landing） |
| 5 | landing→cancelled（切别 session） | 状态 | #3 状态机 |
| 6 | cancelled→landing（重选空 session 复活，建模G-4） | 状态 | #3 状态机 |
| 7 | dir_popover→landing / dir_dialog | 状态 | #3 状态机 + #5 |
| 8 | branch_popover→landing / branch_modal | 状态 | #3 状态机 + #6/#7 |
| 9 | dir_dialog→landing（OS 选中回灌）/ →dir_popover（取消） | 状态·异常 | #5 |
| 10 | branch_modal→landing（创建成功）/ →branch_popover（取消·创建失败） | 状态·异常 | #7（失败转移目标需核②§5） |
| 11 | 非 git 目录约束 UC-7（chip 隐藏 + popover/modal 不可达） | 状态·约束 | chip 隐藏→#2；状态机不可达守卫→#3 |
| 12 | unborn HEAD 空态引导首次 commit（F8/AC-4.3） | 状态·异常 | #6 |
| 13 | dirty 分支 inline 二次确认条（G2 不可逆） | 状态·不可逆 | #6 |
| 14 | overlay 互斥不变式（至多 1 active） | 状态·守卫 | #3 |
| 15 | 深模态来源约束（dialog 只从 popover 进） | 状态·守卫 | #3 状态机 |
| 16 | landing 唯一无 overlay 可交互态 | 状态·守卫 | #3 |
| 17 | Session create 里程碑（绑定 cwd） | 状态 | #1 + #3 |
| 18 | 首条消息里程碑（empty→chatting，status→active） | 状态 | #3 + runtime 既有（N/A） |
| 19 | 落地空态判据 messageCount 派生（D-3） | 状态 | #2 |

### 模块轴（§7）

| # | 上游元素 | 轴 | 该对应什么 issue |
|---|---------|----|-----------------|
| 20 | useNewTaskFlow composable（状态机+overlay+Esc+cwd 调度） | 模块 | #3 |
| 21 | landing 组件（Landing*.vue） | 模块 | #2 |
| 22 | directory popover（DirSelect.vue） | 模块 | #5 |
| 23 | branch popover（BranchSelect.vue） | 模块 | #6 |
| 24 | create-branch modal（CreateBranchModal.vue） | 模块 | #7 |
| 25 | recentWorkspaces 派生函数 | 模块 | #4 |
| 26 | resolveDefaultCwd 纯函数 | 模块 | #4 |
| 27 | sessionApi 扩展（T1） | 模块 | #1 |
| 28 | useSidebar.newSession 扩展（BC-8） | 模块 | #3 |
| 29 | SessionService（已有） | 模块 | N/A（契约稳定） |
| 30 | GitService.createBranch 扩展（UC-6，扩 port） | 模块 | #7 |
| 31 | GitService.getStatus 接入 dirty | 模块 | #6 |
| 32 | git-info（分层债） | 模块 | N/A（T2 打回，分层债移交⑤） |

### 边界轴（§8）

| # | 上游元素 | 轴 | 该对应什么 issue |
|---|---------|----|-----------------|
| 33 | OS 目录选择器（客户-供应商） | 边界 | #5（BC-7 IPC 接入） |
| 34 | pi 引擎（客户-供应商） | 边界 | N/A（契约稳定，cwd 透传在 #1） |
| 35 | 本地 git（客户-供应商） | 边界 | #6（读）+ #7（写） |

### 挑战轴（§10）

| # | 上游元素 | 轴 | 该对应什么 issue |
|---|---------|----|-----------------|
| 36 | D-1 三层不套四层 | 挑战 | N/A（架构决策已定，不产代码） |
| 37 | D-2 RecentWorkspace DTO（Q1=A） | 挑战 | #4 |
| 38 | D-3 messageCount 派生 | 挑战 | #2 |
| 39 | D-4 显式转换表（Q3=A） | 挑战 | #3 |
| 40 | D-5 git 服务维持分离（T2 打回） | 挑战 | N/A（红队终裁打回） |
| 41 | D-6 缓存降派生函数（T3 打回） | 挑战 | #4 |

### 兜底（§9 swimlane / §11 AC / §12 BC / §6 Port）

| # | 上游元素 | 轴 | 该对应什么 issue |
|---|---------|----|-----------------|
| 42 | §9 主流程泳道（触发→landing→发送） | 兜底 | #3 |
| 43 | §9 选目录子流程（OS 选中 / 取消） | 兜底 | #5 |
| 44 | §11 AC-1~AC-6（grep 验收清单） | 兜底 | 分散到各 issue 验收（#1/#2/#3） |
| 45 | §12 BC-1~BC-6（runtime 既有行为） | 兜底 | N/A（保持） |
| 46 | §12 BC-7 pick-directory IPC 接入 | 兜底 | #5 |
| 47 | §12 BC-8 newSession 触发点统一 | 兜底 | #3 |
| 48 | §12 BC-9 recentWorkspaces 新增 | 兜底 | #4 |
| 49 | §12 BC-10 landing 新增 | 兜底 | #2 |
| 50 | §12 BC-11 forkSession 波及 | 兜底 | #8（独立 ticket） |
| 51 | §12 BC-12 UC-7 非 git 既有行为 | 兜底 | #2 |
| 52 | §6 OS DirectoryPicker port | 兜底 | #5（既有 IPC） |
| 53 | §6 pi RpcClient port | 兜底 | N/A（既有） |
| 54 | §6 git CLI port（能力缺口：无 branch/checkout） | 兜底 | #7（扩 port） |
| 55 | §6 WS Transport port | 兜底 | N/A（既有） |

T_recon 共 **55** 条上游元素（去重后），均显式处理（对应 issue 或 N/A + 理由）。

---

## Diff 结果（T_recon vs 主 agent「上游覆盖核验」表）

### MISSING（②有可拆元素，issues.md 无对应 issue）

**0 条**。4 轴 + 兜底扫描后，② 所有可拆元素在 issues.md 均有对应 issue 或合理 N/A。

### PHANTOM（issues.md 有 issue，②查不到根）

**1 条**

| ID | issue | 类型 | 描述 |
|----|-------|------|------|
| P1 | #9 / #10 / #12（P3 延后项） | D（agent 自决） | 三条 P3 延后项根在 ①spec.md §6 而非 ②system-architecture.md：#9 popover 锚定 fallback、#10 dirty 自动 stash、#12 Git 图谱——② 全文无对应可拆元素。严格「②查不到根」成立。但属主 agent 显式延后（标注来源 spec §6），非真覆盖漏洞。建议主 agent 在覆盖表或 issue 正文补注「根来源=①spec §6」以闭合「②覆盖」声明；#11 远程连接 ②§7 DirSelect.vue 有弱根（「远程连接」动作项），不列。 |

### MISMATCH（标了对应但内容没真解决）

**5 条**

| ID | 上游元素 | 类型 | 描述 |
|----|---------|------|------|
| M1 | §5 branch_modal→branch_popover（创建失败转移） | K（问用户/以②为准） | **状态转移目标矛盾**：②§5 状态图明定「branch_modal --> branch_popover: 取消 / 创建失败」（失败落回 branch_popover）；而 #7 AC-7.3 写「createBranch 同步执行失败→**留 modal** 显错」。③的 AC 与②状态机定义冲突，需以②为准修正 #7 AC-7.3，或回流②澄清。 |
| M2 | §5 非 git 目录约束 UC-7（popover/modal 不可达） | D（agent 自决） | 主 agent 将 UC-7 整体标 #2（chip 隐藏），但②§5 明确「branch-popover/branch-modal **不可达**」是状态机层守卫（「非 git 目录下状态机只走 idle↔landing↔dir-popover↔dir-dialog 子集」），属 #3 状态机职责。#2 仅验 chip 隐藏（AC-2.2），#3/#6/#7 均无「非 git 目录下 popover/modal 不可达」AC。状态机守卫层保障漏验收。 |
| M3 | §5 landing→landing（发送失败 composer 子态显错） | D（agent 自决） | 主 agent 标 #3，但②§5「折叠为 landing 的 **composer 子态**」——composer 显错 UI 渲染属 landing 组件（#2）职责，#3 composable 只保证 flow 状态不变。#3 AC-3.4 说「留 landing，composer 子态显错」但 composable 不管 UI；#2 的 AC 无任何发送失败显错验收。分工断层，发送失败 UI 无 issue 真兜底。 |
| M4 | §5/§7 Esc 优先级（spec §4，D-4 核心动机） | D（agent 自决） | Esc 优先级是 D-4 选择「显式状态机而非松散 ref」的**核心动机**（②§10 D-4 理由：「popover+modal 嵌套时易出 Esc 优先级 bug」）。#3 描述提及 Esc，但 AC-3.1~3.6 **无任何 Esc 优先级验收**。决策动机与其验收脱钩——状态机做对了但 Esc 行为不被验证。 |
| M5 | §5 深模态来源约束（dir-dialog 只从 dir-popover 进 / branch-modal 只从 branch-popover 进） | D（agent 自决） | ②§5 显式不变式。#3 状态机吞并，但 AC-3.2 仅验「overlay 互斥（至多 1 active）」，未验「深模态来源约束」（非法来源进深模态应抛错）。互斥≠来源约束，是两个正交守卫，后者无 AC。 |

---

## 汇总

- T_recon 行数：**55**
- gap 总数：**6**（MISSING 0 / PHANTOM 1 / MISMATCH 5）
- 类型分布：K×1（M1，需用户/回流②裁决）+ D×5（P1/M2/M3/M4/M5，agent 自决可补 AC/补注）
- 收敛判断：**未收敛**。核心模块/状态/边界/挑战轴覆盖完整（无 MISSING），但 5 条 MISMATCH 集中在「状态机异常分支与守卫的 AC 验收缺口」+ 1 条状态转移定义矛盾（M1 需裁决）。建议主 agent 补 #2/#3/#7 的异常分支与守卫 AC，并裁决 M1 的转移目标。
