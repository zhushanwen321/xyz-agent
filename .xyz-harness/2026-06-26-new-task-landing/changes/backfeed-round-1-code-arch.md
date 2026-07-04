---
entries: 2
---

# 反哺检查 — code-arch

> 独立 subagent 逐上游核对 code-architecture.md（⑤）是否引入与上游已拍板事实/决策矛盾。
> 严格核对范围：①requirements / ②system-architecture / ③issues / ④non-functional-design + 项目根 CONTEXT.md。

## 逐上游核对

### ① requirements.md

**覆盖核对**：UC-1~UC-7 均在 ⑤ §4 时序图 + §6 test-matrix 覆盖；AC-1.1~AC-8.x 大多映射到用例 T1.x~T8.x；数据流转（cwd/分支/dirty/最近 workspace/消息）与 ⑤ §3 签名表一致；约束（task=session 1:1、非首次沿用最近 cwd、非 git 隐藏分支入口、切走 dirty 留工作区、创建分支仅 HEAD、最近 workspace top10）⑤ 均遵守。

**发现矛盾（→BF1）**：① G8「session 创建时点：触发即创建空 session（D-可逆，对齐代码现状 useSidebar.newSession）」与 ③ AC-1.7（源自 ① AC-1.3/Q2-b）在「首次启动」场景存在张力——首次启动无历史 session，resolveDefaultCwd=undefined，若「触发即创建」则 cwd=undefined 必然触发 runtime 回退 process.cwd()（违反 AC-1.7「不回退」）。⑤ §4.1 时序图（L256-264）实际走了 `create(undefined)→runtime 回退 spawn` 路径，与 AC-1.7 直接冲突，且 alt 标签「cwd 合法 / undefined(runtime 回退)→spawn」与紧随的「directory chip(空态若首次)」自相矛盾（spawn 成功返回 SessionSummary(cwd=process.cwd())，chip 不可能为空态）。

**轻微缺口（不单列 BF）**：① UC-6 异常流程「分支名已存在→input 边框 danger+红字，按钮禁用提交」要求**前端实时**校验已存在；⑤ CreateBranchModal 前端校验描述（§4.4）只列「git 分支名规则(AC-7.8)」，未显式列「已存在实时校验」用例（T6.2 覆盖规则非法，T6.3 覆盖提交后已存在）。属 ⑤ 覆盖轻微缺口（branch 列表已在 popover 内存，实现可含），非事实矛盾。

### ② system-architecture.md

**覆盖核对**：D-1（三层不套四层）、D-2（RecentWorkspace DTO）、D-3（messageCount 派生）、D-4（显式状态机）、D-5（git 服务不合并）、D-6（派生函数打回 T3）⑤ 均遵守；§7 模块划分与 ⑤ §1 工程目录一一对应；§12 BC-1~BC-12 处置与 ⑤ §7 现有代码映射表一致；搭便车 T1/T2/T3 真实工作量与 ② 预期一致（T1=~10LOC sessionApi 扩展、T2 打回不合并、T3 降派生函数），**无「搭便车变主工程」**。

**obs-B/分层债核对**：② Obs-B（NewTaskFlow 实例模型）移交⑤裁决→⑤ Q2 裁决「全局单实例」（符合 ③ AC-3.12 v1 假设）；② git-info 分层债补 port 移交⑤评估→⑤ Q自决「本期不补」（符合 ② D-5「修复价值独立，留⑤评估」授权）。均不矛盾。

**潜在张力（不单列 BF，informational）**：⑤ §3.3 selectWorkspace/openDirDialog 引入「换目录=delete 空旧 session + create 新 session(newCwd)」语义，声明「保持②Session.cwd 不变式」。② §4 Session 不变式「cwd 在 NewTaskFlow 正常路径不变」+ §9 swimlane「(后续创建/切换 session 绑定新 cwd)」已暗示此方向，⑤ 用 delete+create 落地是合理细化（维护不变式而非违反），**非事实矛盾**。但 ② §5「cancelled 非终态」论据「代码现状空 session 创建后永久保留（无自动清理）」与 ⑤ selectWorkspace 主动 delete 空旧 session 有轻微张力——⑤ 的 delete 是「换目录替换当前 flow 绑定空 session」，与 D-A25「不自动清理堆积空 session」正交，建议 ② 补一句说明（非阻断）。

### ③ issues.md

**覆盖核对**：#1~#8 均在 ⑤ §1/§3/§4 覆盖；Wave 编排（⑤ §8 DAG）与 ③ Wave 提示一致；D-7（createBranch 失败留 modal）⑤ §4.4 时序图 E10 + §3.3 submitCreateBranch 已落实；AC-7.7 超时经 port 继承 8000ms（④回灌）⑤ §3.8 骨架约束已标。

**发现矛盾（→BF2）**：③ #6 方案 A「改动」描述只列「BranchSelect.vue（popover 分支列表+dirty 标记+inline 确认条）；GitService.getStatus 同步接入（dirty 数据源）」——**未列 checkout 的 runtime 扩展**。⑤ §1.2/§3.2/§3.5/§3.6/§3.7 揭示 #6 还需：`git.checkout` WS 消息 + `GitService.checkout(sessionId,name)` 方法 + `GitCommand` 白名单加 `'checkout'`（#6+#7 共用）+ `git-message-handler.ts` case + `protocol.ts` type。③ #6 的真实工作量大于方案 A 文字描述（含与 #7 同模式的 runtime port 扩展），⑥ 执行计划若照 ③ 方案 A 文字估工时会**低估 #6**。

**轻微措辞（不单列 BF）**：③ AC-7.4「GitCommand 白名单含 branch/checkout -b」措辞不准（`git checkout -b` 是 checkout 命令的参数形式，非独立白名单枚举值；`branch` 命令不用于创建并切换）。⑤ §3.6 修正为「加 'checkout'」更准确。grep 验收不受影响（checkout 命中）。

### ④ non-functional-design.md

**覆盖核对**：④「缓解项回灌登记表」中 `验收方式=骨架约束` 的 8 条 ⑤ §3.8 骨架约束清单逐条落地（session.create 回滚/结构化日志、landing 渲染条件、状态机 debug 日志、getStatus P99 埋点、createBranch port 超时/白名单/日志）；`验收方式=代码测试` 的 12 条 ⑤ §6 来源 B 表 12/12 映射（T1.3/T1.4/T1.8/T4.2/T4.7/T6.2/T6.6/T6.8/T8.6/T8.3/T3.5/T1.9）；D-NFR1（同步保持+观测）、D-NFR2（getStatus 缓存独立新建，v1 条件性）、D-NFR3（createBranch 审计降级）⑤ 均遵守。

**无矛盾**：④ 残余风险「getStatus v1 不加缓存（每次 spawn），P99>200ms 触发后加」与 ⑤ T4.7「缓存命中」用例标注「AC-6.8(加缓存后)」一致（条件性用例）；④「 getStatus 实际跑 status+diff 两次 spawn ~40-50ms」与 ⑤ §3.5/§4.3 一致；④「createBranch 经 port 继承 8000ms 超时」与 ⑤ §3.8 一致。

## 需反哺的矛盾（若有）

### BF1

- **涉及上游**: ① requirements.md（决策记录 G8「session 创建时点」）+ ③ issues.md（AC-1.7 + D-A3 决策记录）
- **矛盾描述**:
  - **上游说什么**：① G8「触发新建即创建空 session，落地空态是该空 session 的初始视口（D-可逆，对齐代码现状）」；③ AC-1.7（D-A3，K 用户裁决）「首次启动 resolveDefaultCwd=undefined 时——directory chip 空态 + 发送按钮 disabled，引导先选目录（**不回退 process.cwd()**）」；① AC-1.3/Q2-b 同义。
  - **⑤ 发现什么**：⑤ §4.1 时序图（L250-264）在首次启动场景走 `resolveDefaultCwd=undefined → create(cwd?=undefined) → session.create{cwd} → alt「cwd 合法 / undefined(runtime 回退)」→ spawn(cwd) → SessionSummary(cwd,status=idle) → state=landing → directory chip(空态若首次)`。即⑤把首次启动 undefined 归入「runtime 回退 process.cwd() 并 spawn」分支，**与 ③ AC-1.7「不回退 process.cwd()」直接冲突**；且 spawn 成功返回 cwd=process.cwd() 的 SessionSummary 后 chip 不可能为「空态」，⑤ §4.1 alt 标签与 chip 描述自相矛盾。
  - **根因（上游内部张力）**：① G8「触发即创建」与 ③ AC-1.7「首次不回退 process.cwd()」在首次启动场景无法同时成立——若触发即 create(undefined)，runtime 必回退 process.cwd()（违反 AC-1.7）；若不回退，则首次启动不能「触发即创建」（违反 G8）。③ D-A3 称「AC-1.7 前端 UX 层与 AC-1.2 runtime 防御层不同层不冲突」，但 ⑤ §4.1 时序图实证：前端 startFlow 直连 create(undefined)→runtime 回退 spawn，前端 UX 层并未 block，两层在实现上确有交汇冲突。⑤ §3.3 startFlow 签名表（L159）写对了「首次启动 cwd=undefined→chip 空态+发送 disabled（AC-1.7）」，但 §4.1 时序图未体现该 block，**⑤ 内部亦不一致**。
- **建议修订**（二选一，需用户拍板）：
  - **方案 (a) 首次启动延迟 create**：resolveDefaultCwd=undefined 时 startFlow **不调 sessionApi.create**，直接 state=landing + chip 空态 + 发送 disabled；用户经 UC-3/UC-5 选目录后才 create(selectedCwd) 进 landing。此方案使首次启动成为 ① G8「触发即创建」的**显式例外**，优先满足 ③ AC-1.7（用户裁决优先级高于 ① G8 自决）。⑤ §4.1 时序图需新增「resolveDefaultCwd=undefined → 不 create → state=landing(chip 空态 disabled)」分支。
  - **方案 (b) 首次启动 create cwd=null/空 session（runtime 不回退）**：扩展 runtime session.create 支持 cwd=null（不回退 process.cwd()，创建无 cwd 的空 session），chip 空态 disabled；用户选目录后 selectWorkspace 把 cwd=null session 替换为 cwd=selectedCwd session。此方案保持 ① G8「触发即创建」字面成立，但需 runtime 新行为（cwd=null 不回退），爆炸半径大于 (a)。
  - **推荐 (a)**：不引入 runtime 新行为，与 AC-1.7 用户裁决一致，爆炸半径最小。无论选哪个，⑤ §4.1 时序图都需修正（当前「runtime 回退 spawn」分支违反 AC-1.7）。
- **是否 NEEDS_USER_CONFIRM**: **是**。① G8 是显式 [D-可逆] 决策（虽标自决，但已写入需求定稿），③ AC-1.7 是 K 类用户裁决，两者在首次启动场景冲突——选择 (a) 还是 (b) 改变 session 生命周期语义（首次启动是否立即创建 session），属 D 类不可逆方向选择，agent 不应自决推翻 ① G8。需用户裁决首次启动 session 创建时点。

### BF2

- **涉及上游**: ③ issues.md（#6「branch popover + dirty + unborn HEAD」方案 A「改动」描述 + AC-6.2）
- **矛盾描述**:
  - **上游说什么**：③ #6 方案 A「改动」仅列「BranchSelect.vue（popover 分支列表+dirty 标记+inline 确认条）；GitService.getStatus 同步接入（dirty 数据源）」，runtime 侧只字未提；AC-6.2「选 dirty 分支→确认切走=执行 git checkout 目标分支」隐含需 checkout 写能力但未指明实现路径。
  - **⑤ 发现什么**：⑤ §1.2/§3.2(api/domains/git.checkout)/§3.5(runtime GitService.checkout)/§3.6(GitCommand 加 'checkout'，#6+#7 共用)/§3.7(handler git.checkout case)/§1.2(protocol git.checkout type) 揭示 **#6 需要与 #7 createBranch 同模式的 runtime port 扩展**：新增 `git.checkout` WS 消息 + `GitService.checkout(sessionId,name)` 方法 + `GitCommand` 白名单加 `'checkout'`（#6 切换 `checkout <name>` / #7 创建 `checkout -b <name>` 共用此白名单项）+ `git-message-handler.ts` case + `protocol.ts` type union 扩展。③ #6 方案 A 文字描述漏掉这整块 runtime 扩展，⑥ 执行计划若照 ③ 文字估工时会低估 #6（误以为 #6 纯前端 popover+getStatus 接入）。
- **建议修订**: ③ #6 方案 A「改动」补充 runtime 侧：
  - 模块增列：`api/domains/git.ts` 新增 `checkout(sessionId,name)`；runtime `GitService.checkout` 新增；`GitCommand` 白名单加 `'checkout'`（**#6+#7 共用**，#6 `checkout <name>`、#7 `checkout -b <name>`）；`git-message-handler.ts` 加 `case 'git.checkout'`；`protocol.ts` 加 `git.checkout` 消息 type（ack 走既有 `message.status`，status='switched'）。
  - 与 ⑤ §3.2/§3.5/§3.6/§3.7 契约一致，让 ⑥ 正确估算 #6 含 runtime port 扩展工作量（与 #7 同模式但更轻，因 checkout 白名单与 #7 共用）。
- **是否 NEEDS_USER_CONFIRM**: **否**。不改变 #6 方案选择（仍 A），只补全方案 A 的「改动」清单，属描述性反哺，agent 可自决修订 ③。

## 结论

有 **2 处** 需反哺/澄清：

- **BF1（NEEDS_USER_CONFIRM=是）**：⑤ §4.1 时序图把首次启动 cwd=undefined 画成「runtime 回退 process.cwd() spawn」，违反 ③ AC-1.7（K 用户裁决）+ ① AC-1.3。根因是 ① G8「触发即创建」与 ③ AC-1.7「首次不回退」在首次启动场景的张力。需用户裁决首次启动 session 创建时点（推荐方案 (a) 延迟 create），⑤ §4.1 时序图据此修正。
- **BF2（NEEDS_USER_CONFIRM=否）**：③ #6 方案 A「改动」描述漏掉 checkout 的 runtime port 扩展（git.checkout 消息 + GitService.checkout + GitCommand 白名单加 checkout + handler case + protocol type），⑤ 揭示 #6 真实工作量含此块。建议 ③ 补全描述，agent 可自决修订。

其余核对项（①UC 覆盖、②模块/状态机/搭便车工作量、③Wave/D-7/AC-7.7、④骨架约束+来源 B 用例映射+残余风险）均无事实性矛盾，⑤ 与上游一致。待主 agent 处理 BF1（提请用户确认）+ BF2（修订 ③ #6 方案 A 描述）后，⑤ code-arch 可视为与上游对齐。
