# cw 递归编排方案 v4(主 agent 发起 + steer 事件驱动 + 独立审查 + chain 合并)

> 状态:定稿(替代 v0.3)
> 日期:2026-08-06
> 依据:pi 源码(explorer sa-4bf20c0a / sa-60edc8ef)+ cw 源码(explorer sa-ca0f0a92)
> 适用:cw 引擎 v2(本项目假设 cw 现状,不依赖 E1-E6)+ recursive-split 重写

---

## 0. 方案演进与边界

三次关键简化(每次都有源码依据):

1. **v0.3 → v4a**:workflow worker 当宿主要轮询(因为 worker 不能 steer);改 **session 宿主 + steer 事件驱动**(派发者和 agent 都是有 session 的 pi agent,子完成 pi 自动唤醒父,无需轮询)。
2. **v4a → v4b**:既然 agent 自递归,workflow 脚本多余——**主 agent 直接发起**(调 cw create + 派第一个 epic subagent),recursive-split 从 workflow 脚本变成 skill + agent 模板。
3. **v4b → v4(本版)**:审查不能自审、wave 合并是独立步骤——**design-review/exec-review 派独立 review subagent**;**wave 全完后派 chain workflow 合并分支 + 清理 worktree**。

**边界**:本项目改的是 recursive-split 重写(删 `.pi/workflows/recursive-split.js`,新增 skill + agent 模板)。终态用 cw E1 合并后的 `design` action(需求澄清+方案合一,design→design-review 命名对称);cw 现状(1.3.0)仍 clarify/plan 分开,本项目落地时若 cw 还没合并,agent 连续调 `cw clarify`+`cw plan`(当一个 design 阶段)。

---

## 1. 核心机制(五条,全源码确证)

1. **派发=后台,父空闲**:`subagent` 工具 start 后台立即返回(`subagent-service.ts:468-474`),父结束 turn 进空闲态(session 保活)。
2. **完成=steer 自动唤醒父**:子完成注入 `subagent-bg-notify`+`triggerTurn:true`(`notifier.ts:195-206`),pi 给空闲父**开新 turn**(`agent-session.js:1087`)。回溯自底向上链式,事件驱动,**无轮询**。
3. **cw 是 CLI 工具,裸用无身份绑定**:`cw design-review/exec-review` 无 caller/owner/session 校验(`dispatch.js:41` 只 loadWorkUnit+guard),任何能跑 cw 的进程都能调。裸 cw 下"不自审"只靠 prompt。
4. **cw-tool 包装(堵 bash 洞 + 硬保证独立 review)**:cw 命令包成 pi 自定义工具(cw-tool),**按 role 限制可调 action**——planning/wave 层主的 cw-tool 不含 `design-review/exec-review`(只能 design/execute/retrospect/closeout/replan/status/handoff)→ **物理上调不了审查命令,必须派 review-agent**(独立 review 从软变硬);review 的 cw-tool 只含审查命令;dev 的含 execute/test。层主工具只给 `cw-tool + subagent`(无 bash/read/write/edit)→ 堵 bash 万能洞。dev/merge 需 bash(git),合理。
5. **cw guidance 是流程权威**:cw 每 action 返回的 guidance 不只"下一步命令+input schema",还含**派发指导**(这步派谁、子 task 模板)、**恢复指导**(gate fail 的 L0-L3)、**续 turn 指导**(被唤醒做什么)。agent 不记流程,每 turn 调 cw 拿 guidance 照做——流程从 agent 记忆(软)迁到 cw(权威)。详见 §7。

---

## 2. 架构(主 agent 发起,无 workflow 宿主)

```
主 agent(你对话那个)
  │ bash: cw create epic  →  subagent 工具派 epic-agent(后台)
  └─ 空闲,等 epic 完成 steer 唤醒 → 报告
        ↓
  epic-agent(planning 模板)自递归:
    cw design → 派 review-agent 审 → execute 派 feature-agent → ...
        ↓ (层层同构,直到 wave)
  wave 层主(wave 模板):design→派 design-review审→派 dev→(dev: execute写码+test+派exec-review审)→retrospect
        ↓ 完成 steer 唤醒 slice
  slice-agent:cw status 查 wave 全完 → 派 chain workflow(merge-agent 合并+清理) → retrospect → closeout
        ↑ steer 层层回溯到 epic → 主 agent
```

**workflow 的定位**:recursive-split 整体编排**不用 workflow 脚本**(删 recursive-split.js)。但 agent 会**调用 pi builtin workflow 当工具**:`review-fix-loop`(多维审查)、`chain`(串行合并)。workflow 不当宿主,是被调用的能力。

---

## 3. 角色与模板(6 种)

| 模板 | 谁用 | 工具 | 职责 | 派子? |
|---|---|---|---|---|
| **planning-agent** | epic/feature/slice 层主 | `cw-tool` `subagent`(无 bash/read/write/edit) | design 本层方案 → 派 review 审 → execute 派下层 → (被唤醒)派 chain 合并 → retrospect/closeout | 是 |
| **wave-agent**(层主) | wave 层 | `cw-tool` `subagent` | design + replan + 派 design-review + 派 dev + retrospect。**不亲自 execute** | 是 |
| **dev-agent** | wave 内 dev | `bash`(git) `read` `write` `edit` `cw-tool`(execute/test) `subagent` | execute 写码 + test + 派 exec-review | 是 |
| **review-agent** | 审 design/exec 结果 | `cw-tool`(design-review/exec-review) `read`(无 bash/write/edit) | **主观审** + 调 cw 提交 judgment。不改被审物 | 否 |
| **merge-agent** | chain 内 | `bash`(git) `read` | git merge + 测试 + worktree prune。冲突上报 | 否 |
| 主 agent | 发起者 | 原有 + `cw-tool` | cw create epic + 派 epic-agent + 等唤醒 + 报告 | 派第一个 |

> **cw-tool 按 role 限可调 action**:planning/wave 的 cw-tool 不含 design-review/exec-review(层主物理上调不了审查→**必须派 review-agent**,独立 review 硬保证);review 的只含审查;dev 的含 execute/test。这把"独立 review"从 prompt 软约束变成工具白名单硬约束。

---

## 4. 关键认知:cw gate vs 主观审查(两层职责)

| 层 | 干什么 | 谁做 | pass 含义 |
|---|---|---|---|
| **cw gate(机器)** | 结构校验:字段填没填、格式合不合法、split DAG 有无环 | cw 引擎跑确定性规则 | **只=必填字段填全了**,≠ 方案对 |
| **主观审查(AI)** | 判方案对不对:有没有遗漏、权衡合不合理、风险可控吗 | 独立 review-agent(可走 review-fix-loop 多维) | = review-agent 认可方案 |

**衔接**:review-agent 先主观审;**主观通过后**才调 cw design-review 提交 judgment 过结构 gate。所以 design-review 被调起本身 = review-agent 主观放行;cw gate 是最后结构闸门。

**designReviewJudgment 无 problems/verdict 字段**(cw 源码确证),review-agent 表达"审不通过"靠**行为**:不提交 design-review,而是把问题 steer 回报层主,层主改 design 后重派 review-agent。审通过才提交(填 sufficiency.meceNote 说无 gap、risks 都有 mitigation 等)。

exec-review 略不同:有 `overallVerdict`(pass/needs-followup)+ `followupActions`,review-agent 可用 verdict 表达"有问题但可跟进"(不阻塞 closeout,followupActions 记技术债)。

---

## 5. planning-agent 生命周期(以 slice 为例,三层同构)

```
被父 feature-agent 用 subagent 工具派发(后台启动)
turn 1:
  cw handoff --unitId slice-1a              (拿上下文+guidance)
  cw design --unitId slice-1a --input ...   (需求澄清+方案+拆分)
  ── 派 review-agent 审 slice-1a 的 design ──
        review-agent:
          读 design(cw status 查 / .cw 产物)
          主观审(可用 review-fix-loop 多维并行)
            ├ must-fix 问题 → steer 唤醒 slice 带问题 → [见 L0 回路]
            └ 审通过 → 调 cw design-review --unitId slice-1a --input {designReviewJudgment...}
                ├ gate fail(结构) → review-agent 修 judgment 重交
                └ gate pass → review-agent 完成 → steer 唤醒 slice
  cw execute --unitId slice-1a              (cw 自动建 wave 子单元)
  对每个 wave:派 wave-agent(worktree:true,后台) → turn 1 结束,空闲
  ... wave-agent 在各自 worktree 跑 ...
turn 2(被某 wave 完成 steer 唤醒):
  cw status --unitId slice-1a 查:所有子 wave 都 closed?
    ├ 没全完 → turn 结束,继续空闲等下一个 wave 唤醒
    └ 全完 → 派 chain workflow:
          每个 merge-agent 顺序:git merge <wave分支> + per-merge 测试 + git worktree prune
            ├ 冲突 → 上报(merge-agent 自身不解决,升级回 slice → L2/L3)
            └ 合并成功 → 清理该 wave 的 worktree 残留
        chain 完成 → cw retrospect + cw closeout → slice-1a 完成 → steer 唤醒 feature
```

**worktree 信息流**:wave 用 `worktree:true` 派出,pi 建独立 worktree。wave `cw execute --commitHash` 把 commit 记进 cw。wave 完成 pi reap 工作目录(分支保留)。slice 从 `cw status` 查各 wave 的 commitHash,据此让 merge-agent 合并。worktree 路径/分支名:pi reap 后工作目录已删,但 git worktree 记录需 `git worktree prune` 清理(merge-agent 做)。**分支名规则待查 pi subagent-service 的 worktree 命名**(实施时确认)。

---

## 6. wave 内部三层(层主 / dev / exec-review)

wave 不是单 agent 串行,而是三层嵌套(保证上下文清晰):

```
wave 层主 agent [W] (worktree:true 派出,在专属 worktree)
  cw handoff
  cw design(testCases/files)
  派 design-review subagent [R] 审 design (同 §5 主观/gate 区分)
    ├ 主观不通过 → [W] replan design → 重派 design-review
    └ 通过 → [W] 派 dev subagent [DEV]
        dev subagent [DEV]:
          cw execute --commitHash (写码)
          cw test
            ├ 代码问题 → [DEV] 改码 (重 execute/test)
            └ plan 问题 → 报回 [W] → [W] replan design → 重走 design-review → 重派 dev
          派 exec-review subagent [R] 审执行结果
            ├ 严重 → [DEV] 改码
            └ 通过/可跟进 → [DEV] 完成 → steer 唤醒 [W]
  [W] cw retrospect + cw closeout → wave 完成 → pi reap worktree → steer 唤醒 slice
```

**为什么三层**:[W] 层主保持轻上下文(只管 design/replan/调度/retrospect),不亲自 execute;[DEV] 扛完整开发上下文(execute+test 同 subagent,因 test 验证 execute 产物);[R] 独立审(dev 派,独立视角,不自审)。

**cw test 失败分叉**:代码问题→dev 改码(回 execute);plan 问题→报回 wave 层主 replan design(重走 design-review 再重派 dev)。exec-review 有 `overallVerdict`(pass/needs-followup),needs-followup 可跟进不阻塞,严重才改码。

---

## 7. 可执行性:如何保证 agent 按流程

LLM agent 不是状态机,无法 100% 保证按流程。靠**硬约束挡大头 + cw guidance 权威化 + 偏离可恢复**。

### 硬约束(确定性)

| 约束 | 保证 | 实现 |
|---|---|---|
| **cw 状态机** | 不能跳步骤(没 design-review 就 execute → illegal_transition 挡) | cw action 的 from 状态约束 |
| **cw-tool 工具白名单** | 层主只能调 cw + 派子(无 bash/write/edit)→ 写不了码,必须派 dev | pi tools 字段 |
| **cw-tool 按 role 限 action** | 层主的 cw-tool 不含 design-review/exec-review → **调不了审查命令,必须派 review-agent**(独立 review 硬保证!) | cw-tool 包装层 action 白名单 |

**cw-tool 是核心**:既堵 bash 洞(层主无 bash),又按 role 限 action(层主调不了审查)。dev/merge 需 bash(git),但其职责就是 git,合理。

### cw guidance 权威化(流程从 agent 记忆迁到 cw)

cw 每 action 返回的 guidance 含四段:
1. **位置**:unit/状态/树路径
2. **下一步 + 派发指导**:不只"调 cw xxx",还告诉**这步派谁、子 task 模板**。例:wave 层主 execute 阶段 guidance="派 dev subagent(task:execute+test+派exec-review)";design-review 阶段="派 review subagent(task:审 design 并调 cw design-review 提交)"
3. **恢复指导**:gate fail 给 L0-L3(读 mustFix 重做 / cw replan / 上报父)
4. **续 turn 指导**:被 steer 唤醒="查 cw status,子全完则派 chain/retrospect,没完则等"

agent 不记流程,每 turn 调 cw 拿 guidance 照做。cw guidance 是流程唯一权威,接收 guidance 的 agent 按其中的**派发指导**分情况派子(execute 派 dev/review,续 turn 派 chain 等)。

### 软约束(靠纪律)

- **verify-by-state**:父调 cw status 核实子(不信自报),子乱来父查 cw 露馅
- **maxTurns/预算**:防失控

### 设计哲学

**不追求 100% 按流程,追求"偏离可发现 + 状态不丢 + 可恢复"**:cw 是真相铁轨(持久),agent 跑偏状态还在,从 frontier 重派接着走。最坏某 unit 卡住,不波及整棵树(cw 状态隔离 + 父核实)。

---

## 8. 失败恢复 L0-L3(替代旧版 abort)

**旧问题**:gate fail → 脚本 `cw abort` 销毁 unit 重建。**新版**:agent turn 内处理,unit 不销毁。abort 只剩 L3(人决定)。

| 级 | 触发 | 谁处理 | 动作 |
|---|---|---|---|
| **L0** | cw gate fail 或 review-agent 审出 must-fix | 当前层主 agent(turn 内) | 读 mustFix/审查问题 → 改 design(或 wave 改码)→ 重派 review-agent 重审。**unit 不动** |
| **L1** | L0 重试 ≤2 次不行(方案缺陷) | 当前层主 agent | `cw replan --unitId <自己>` 就地改方案(标记废弃条目,不销毁)→ 重审 |
| **L2** | 根源在上游(父拆错)或 L1 超限 | **父 agent**(被 blockedUpstream steer 唤醒) | 父 `cw replan --unitId <父>` → cw 级联标子 unit abandoned → 父对受影响未完成的子**重派**;父核对 abandoned 清单 |
| **L3** | 反复失败/超预算/波及已合并代码 | 人 | 停下上报。唯一真正 abort 场景 |

**replan 谁调**:L1=出问题 agent 自己;L2=父 agent。**replan 后派发**:父 replan 后 cw 级联标 abandoned,父续 turn 对受影响未完成子重调 subagent 派新 agent,已 closed 的不动(除非 L3)。

---

## 9. 与 v0.3 差异

| 项 | v0.3 | v4 |
|---|---|---|
| 编排宿主 | workflow worker(轮询) | 主 agent session(steer 事件驱动) |
| 事件泵 | 必需(60s 轮询) | **删除** |
| stateless parent | 父用完即弃 | 父保持 session,steer 续 turn |
| design-review/exec-review | 层主 agent 自审提交 | **派独立 review-agent 审+提交** |
| wave 合并 | 壳执行 | **slice 派 chain workflow(merge-agent)** |
| recursive-split.js | 重写为壳 | **删除**(改 skill + agent 模板) |
| cw gate / 主观审查 | 混为一谈 | **两层职责分离**(cw=结构,review-agent=主观) |
| cw 状态机/gate/worktree 隔离/L0-L3 | 保留 | 保留(不变) |

---

## 10. 待验证风险

1. **长 session compaction 漂移**:epic agent 跨多天被反复 steer 唤醒,compaction 后是否忘协议?——v0.3 引入 stateless 的原始顾虑,未论证。验证:跑 3-5 层 mini-epic 看 epic 是否守 prompt。
2. **subagent 空闲保活**:派子后空闲 session 能活多久?pi 有无 idle 超时自动 close?close 了 steer 送不到。需查 pi session 保活。
3. **worktree reap 与 merge 时序**:pi reap 后工作目录删,但分支/git worktree 记录状态?merge-agent 用 commitHash merge + prune 是否够?分支名规则待查 pi。
4. **review-agent 与层主的往返**:review 审出 must-fix → steer 层主 → 层主改 design → 重派 review。这个往返次数/maxTurns 要控(层主被反复唤醒,maxTurns 累积)。
5. **dispose 连坐**:`session_shutdown` 会 `killAllSpawnedChildren`(`subagent-service.ts:335`)。编排期间所有 agent session 不能被外部关。主 agent session 是宿主,关了整棵树丢。

---

## 11. 本项目改动清单

- **删除** `.pi/workflows/recursive-split.js` + `recursive-split-utils.cjs` + 3 个测试文件(编排宿主脚本层蒸发)
- **新增** skill `pi-cw`(教主 agent:cw create epic + 派 epic-agent + 等唤醒)
- **新增** 6 个 agent 模板:planning-agent / wave-agent(层主) / dev-agent / review-agent / merge-agent(+ 主 agent 用现有)
- **新增** cw-tool(pi 自定义工具,registerTool):包装 cw 命令,**按 role 限制可调 action**(层主不含审查命令),堵 bash 洞 + 硬保证独立 review。分配给 planning-agent / wave-agent(层主) / dev-agent(execute/test) / review-agent(审查) / 主 agent
- **cw guidance 增强**:每 action 返回四段(位置/下一步+派发指导/恢复指导/续turn指导),让接收 guidance 的 agent 按派发指导分情况派子(详见 §7)
- **cw.config.json**:可能加 perLayer.model(planning 强模型/wave 便宜模型)——但消费者是 agent prompt/派发参数,本项目自定义即可,不依赖 cw 引擎
- **不依赖 cw 引擎 E1-E6**(本项目用 cw 现状 action 名;cw-tool 包装层可屏蔽未来 E1 合并差异)
