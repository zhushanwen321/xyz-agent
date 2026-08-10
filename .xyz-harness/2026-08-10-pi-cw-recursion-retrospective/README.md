# pi-cw 递归编排实践复盘：fbf874 session 分析

> 复盘日期：2026-08-10
> 分析对象：pi session `fbf874.jsonl`（`019fe56b-54d7-74ad-acdc-24b16ffbf874`）
> 源 worktree：`xyz-agent-workspace/feat-optimize-ui`
> 复盘目的：判断该 session 是否按 pi-cw 设计完成递归式 subagent 开发；若偏离，定位根因并给出改进建议。

## 背景与对象

**pi-cw** 是 `@zhushanwen/pi-cw-tool` 提供的递归编排能力：主 agent 用 `cw` 建一棵 `epic → feature → slice → wave` 的任务树，派**第一个** `planning-agent` 自递归展开整棵树，主 agent 空闲等 steer 唵醒，全树完成后报告用户。核心约束：主 agent 只派第一个 planning-agent，不自己 descend 到子层；子 agent 完成时 pi 自动 steer 唵醒父 agent（事件驱动，无轮询）。

**fbf874.jsonl** 是一次实际开发的主 agent session（178 行 / 821K），发生在 `feat-optimize-ui` worktree，目标是执行 6 个已规格化的 renderer 动画优化 plan（位于 `.xyz-harness/2026-08-09-animation-audit/`）。session 分三段，只有第三段涉及 pi-cw：

1. **[1-59]** emil-animate-designer 全库动画审计（与 pi-cw 无关，常规并行 subagent 编排）
2. **[60-113]** 写 6 个 plan + 提交到 `.xyz-harness/`
3. **[114-178]** pi-cw 递归编排 ← 本文分析对象

---

## 结论先行

该 session **发起了一次 pi-cw 递归式 subagent 编排，但过程严重偏离设计，靠主 agent 三次重派 + 手动救场才推进下去；最终结果"大部分完成但未收尾"——8 个 wave 里 7 个 closed/tested，1 个卡在 exec-review，整棵 epic 树仍未 closed。这不是一次成功的端到端递归编排，而是一次"设计被现实反复打脸、靠经验硬掰回来"的案例。**

关键事实（均有铁证）：

| 维度 | 状态 |
|------|------|
| 是否启动递归编排 | 是——建了 epic 树、派了 planning-agent、fork、事件驱动等待 |
| 是否"只派第一个 planning-agent" | 否——派了 **3 次**（sa-68b7e2f2 / sa-bf74a034 / sa-24cd2c19） |
| 主 agent 是否"不 descend 到下层" | 否——自己查 cw-runner.ts 源码、定位 bug、验证修复（本该是 planning-agent 的 L0-L3 职责） |
| 递归链是否自洽 | 否——sa-bf74a034 嵌套重派的 sa-7625aed5 **未注册**，链断了 |
| cw 树最终结局 | 2/3 slice closed、1/3 slice 卡在 wave.exec-review，epic 仍 executing/blocked |

---

## 一、pi-cw 阶段时间线（session [114-178]）

| 步 | 主 agent 行为 | 结果 |
|----|---------------|------|
| [119] | `cw create epic` 建根 | `epic:animation-optimization` |
| [122] | 派 sa-68b7e2f2（fork=true） | 97 行就结束，报告 cw 工具链 bug（bare-repo workspace 推导错路径） |
| [125-139] | **主 agent 自己 descend**：查 `cw-runner.ts:96-106`、定位 `detectRepoWorkspace` bug、验证 patch 可行性 | 向用户汇报征询决策 |
| [144] | 用户介入："我改好了 cw/pi-cw/cw-tool，abort 旧 topic，重新发一个" | — |
| [154] | 建新 epic，派 sa-bf74a034（fork=true） | 3952 行 / 1.9M，**花 52 分钟自我诊断**；实际建好了树；嵌套重派 sa-7625aed5 未注册 |
| [161-175] | 主 agent 发现树建好但无人驱动，递归链断 | 重派决策 |
| [178] | 派 sa-24cd2c19（**fork=false**，slug 改 `animation-driver`，task 加 fallback） | session 在此结束，但 subagent 后台继续 |

---

## 二、cw 树最终状态（铁证，`cw tree --unit-id epic:animation-optimization` 实查）

```
epic:animation-optimization [executing, blocked]
└─ feature:renderer-animations [executing, blocked]
   ├─ slice:enter-exit-transitions [closed] ✅
   │  ├─ wave:overlay-transition [closed]
   │  ├─ wave:button-press-feedback [closed]
   │  └─ wave:toast-transition [closed]
   ├─ slice:status-decoration-cleanup [closed] ✅
   │  ├─ wave:remove-persistent-decorations [closed]
   │  └─ wave:fix-pending-dead-class [closed]
   └─ slice:reduced-motion-a11y [executing, blocked] ⚠️
      └─ wave:reduced-motion-guard [tested, next=exec-review] ⚠️ 卡审查
```

**解读**：第三次重派（fork=false）在主 agent session 结束后**后台基本跑通了**——7/8 wave 到终态或 tested，只差最后一个 wave 的 exec-review → closeout。说明 fork=false + 强 task + fallback 这套"修正用法"是有效的，但主 agent 没等到它收尾就停了。

---

## 三、偏离 pi-cw 设计的点（逐条对照 skill）

| pi-cw 设计要求 | 本 session 实际 | 性质 |
|----------------|-----------------|------|
| 主 agent 只派**第一个** planning-agent | 派了 3 次 | 用法偏离（前两次属异常恢复） |
| 主 agent **不 descend** 到子层 | 自己查源码、定位 bug、验证修复 | 用法偏离（planning-agent 的 L0-L3 没兜住） |
| 派发用 `fork=true`（skill 第 2 步明文） | 照做，但 **fork=true 正是混乱主因** | **设计缺陷** |
| 子 agent 完成自动 steer 唵醒父 agent | 机制生效（5 次 subagent-bg-notify 都到了） | 正常 |
| 靠 cw 查进度，不信自报 | 主 agent 严格执行（不盲信 subagent） | 正常 |
| planning-agent 自递归展开整棵树 | sa-bf74a034 建了树但没驱动执行就结束 | **衔接断裂** |

---

## 四、根因分析（5 个，按重要性排序）

### 根因 1：fork=true 上下文污染（核心，设计缺陷）

pi-cw skill 第 2 步明文写 `fork=true`，但 fork=true 让 planning-agent 继承主 agent 的**完整会话历史**——其中包含"我（主 agent）刚派了 planning-agent"这条记录。子 agent fork 后看到这条记录，**误判"planning-agent 没启动"，把自己当主 agent 诊断了 52 分钟**（sa-bf74a034 的 3952 行 session 即证据）。

这是 skill 设计与 pi 的 fork 语义的直接冲突：fork 本意是"传递背景上下文"，但主 agent 的上下文里天然带有"调度记录"，子 agent 无法区分"这是给我的背景"和"这是主 agent 在调度我"。

**反证**：第三次重派改用 fork=false + 自包含 task，**成功了**（cw 树证明它驱动了完整执行）。说明 fork=true 不是必需的。

### 根因 2：嵌套 subagent 派发不可靠

sa-bf74a034（自身是 fork=true 子 agent）再用 subagent 工具派 sa-7625aed5，**未注册到全局 list**，递归链断。递归编排强依赖"子 agent 能再派子 agent"这条嵌套链，链一断，树就成孤儿（建好无人驱动）。

本次的救场是主 agent 发现后重派 fork=false 接管——但这恰恰是 pi-cw 说的"主 agent 不该做的事"。

### 根因 3：planning-agent "建树—执行"衔接断裂

设计预期：planning-agent design + execute 建树后，**继续驱动子层直到 closed**。实际：sa-bf74a034 建完树（design 拆 3 slice、其中 1 slice execute 拆 2 wave）就结束了，没有任何 execute 被执行。

skill 和 agent 模板没有显式约束"建树后必须闭环驱动执行"，planning-agent 把"建树"当成了终点。

### 根因 4：工具链 bug（bare-repo workspace 推导，基础设施）

`pi-cw-tool/src/cw-runner.ts:96-106 detectRepoWorkspace` 在 bare-repo 下返回容器路径（`.bare` 的 dirname），导致写 action 读到空 store。bare repo + worktree 是 xyz-agent 的**标准工作模式**，pi-cw-tool 对它支持不足。**用户已手动修复**，非编排设计问题，但暴露了测试矩阵缺 bare-repo 场景。

### 根因 5：主 agent 异常恢复边界模糊

pi-cw skill 第 4 步只覆盖"长时间无唵醒→重派"，没覆盖实际遇到的三种异常：① planning-agent 异常完成（建树没执行）；② 嵌套派发失败；③ 工具链 bug。主 agent 全靠自行判断救场（查源码、改 fork 策略、加 fallback task），救得对，但不在 skill 指导范围内。

---

## 五、改进建议

按"改设计 / 改实现 / 改用法"三层，每条标优先级。

### A. pi-cw skill 设计层（最重要）

**A1. 默认 fork=false + task 自包含【高优先】**
现状 skill 明文 `fork=true`，是本次混乱主因。cw 状态持久（树在 store 里），planning-agent 用 `cw handoff --unitId` 即可拿全上下文，无需继承对话历史。第三次重派 fork=false 成功已是实证。若保留 fork=true 选项，必须注明风险并提供"去污染 task 模板"。

**A2. task 模板增加"闭环职责"约束【高优先】**
显式写明：design + execute 建树后，**必须继续派子层 agent 并确认派发成功**，直到 `cw status` 全 closed 才能结束。禁止"建完树就 return"。

**A3. task 内置嵌套派发失败 fallback【中优先】**
嵌套 subagent 派发失败时，planning-agent 应降级为"自己用 cw_planning/cw_wave/cw_dev/cw_review 工具串行直驱"，而非放弃。本次第三次 task 加了这个 fallback 才跑通。

**A4. 补充主 agent 异常恢复清单【中优先】**
第 4 步补充异常模式 → 恢复动作映射，至少覆盖：planning-agent 完成但 frontier 有未终态节点（→ 重派 fork=false + task 强调"接管已建好的树，勿重建"）、嵌套派发失败、工具链报错。

### B. pi-cw-tool 实现层

**B1. bare-repo workspace 纳入测试矩阵【高优先】**
用户已修 `detectRepoWorkspace`，但需防回归。bare repo + worktree 是 pi-cw 的核心使用场景，测试不能只覆盖普通 repo。

**B2. 嵌套 subagent 派发的可靠性诊断【中优先】**
sa-7625aed5 为何未注册（fork 链 bug？配置问题？）需要定位。若 pi 的嵌套派发本身不稳定，递归编排的根基就不稳，应在工具层加重试 / 显式报错而非静默失败。

### C. 用法层（针对本次任务特点）

**C1. "plan 已规格化"场景慎用建多层树【高优先】**
本任务输入是 6 个**已写死到 verbatim 代码级**的 plan，cw 的 design/review gate 价值有限。主 agent 自己在 session 里也点出了这点。pi-cw skill 的"何时用"应补充：若任务已规格化到 plan 级，优先用 `cw-cli` 单层 wave 串行执行或派 worker 直驱，避免建 epic → feature → slice → wave 四层树的 overhead。

**C2. 主 agent 介入要留痕并设上限【低优先】**
本次主 agent 介入（查源码、定位 bug）实际是**对的**（不盲信 subagent），但耗时巨大（[125-139] 一整段）。建议：介入前先评估"是工具链问题还是编排问题"，工具链问题直接上报用户（本次 [139] 做对了），编排问题才在 agent 体系内恢复。

---

## 六、证据索引

| 证据 | 位置 | 说明 |
|------|------|------|
| 主 session | `~/.pi/agent/sessions/--...feat-optimize-ui--/2026-08-09T07-27-24...fbf874.jsonl`（178 行） | 3 次重派全过程 |
| sa-68b7e2f2（第 1 次，fork=true） | `~/.pi/agent/subagents/--...feat-optimize-ui--/2026-08-09T09-37-05...019fe5e2...jsonl`（97 行） | 短促结束，报工具链 bug |
| sa-bf74a034（第 2 次，fork=true） | `~/.pi/agent/subagents/--...feat-optimize-ui--/2026-08-09T14-21-48...019fe6e6...jsonl`（3952 行 / 1.9M） | fork 污染实证，52 分钟自我诊断 |
| cw 树终态 | `cw tree --unit-id epic:animation-optimization`（在 `feat-optimize-ui` worktree 执行） | 7/8 wave closed/tested，1 卡 exec-review |
| 工具链 bug 位置 | `pi-cw-tool/src/cw-runner.ts:96-106`（`detectRepoWorkspace`） | bare-repo workspace 推导（用户已修） |

---

## 一句话总结

这次实践暴露了 pi-cw 的两个真问题——**fork=true 的上下文污染**（设计缺陷，建议改默认 fork=false）和**递归链的脆弱性**（嵌套派发失败无 fallback）。主 agent 凭"不盲信 subagent"的意识自己救了场，且第三次 fork=false 重派证明修正方向是对的——这些修正应该回写进 skill，而不是停留在某次 session 的经验里。
