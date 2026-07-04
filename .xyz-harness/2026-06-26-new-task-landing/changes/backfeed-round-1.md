---
round: 1
entries: 1
---

# 反哺检查 Round 1 · architecture → requirements

> 独立 subagent，上下文隔离。检测 ②architecture 定稿是否引入与 ①requirements 已拍板事实/决策矛盾。
> 结论速览：**无强制反哺矛盾，可交接**。仅 1 条 borderline 项（checkpoint 1，属实现层细化非业务推翻，可选追溯标注，NEEDS_USER_CONFIRM=否）。

## 逐条核对

### 检查点 1 — §7「最近 workspace LRU 上限 10」vs architecture D-6（独立缓存→派生函数）

| 维度 | requirements | architecture | 判定 |
|------|-------------|--------------|------|
| 上限 10 条（业务） | §7/Q12「上限 10 条」 | §4/§7/D-6「distinct cwd top10」 | ✅ 保持 |
| 「最近」语义（业务） | Q12「LRU 淘汰最久未用」 | §4「按 lastActiveAt 倒序」 | ✅ 保持（语义等价：LRU淘汰最久未用 ≡ 按最近活跃倒序取 top10） |
| 存储机制（实现） | §3 数据清单「来源: **本地缓存**（LRU，上限 10 条）」 | §4/D-6「**派生函数**，不独立缓存，无持久化模块」 | ⚠️ 机制变更 |
| 机制决策权归属 | [移交②]「LRU 上限 10 条的**存储格式**属实现层」 | D-6 行使该授权 | ✅ 在 ② 授权范围内 |

**判定：属于「实现层细化，不推翻业务约束」**（任务选项 B）。理由：
1. 用户拍板（Q12 [D-可逆]）pin 的是**策略+上限**（LRU 淘汰、上限 10），非**存储机制**（独立缓存 vs 派生）。
2. requirements 已通过 [移交②] 把「存储格式」明确授权给 ②，D-6 是在授权范围内行权。
3. 用户可见行为完全一致（top10 最近 distinct cwd）；派生法反而更正确（session 删除后不残留陈旧 cwd 条目，独立 LRU 缓存会有此问题——requirements 未规定该边界行为，无冲突）。
4. D-6 证伪的是 requirements 的**隐含实现假设**（「需要独立本地缓存」），非业务决策。

**但**：requirements §3 数据清单「来源: 本地缓存（LRU）」一行，在 architecture 定稿后**事实性失准**（来源实为 session list 派生，非本地缓存）。这构成「设计假设被下游证伪」→ 触发一条**可选**追溯标注（详见矛盾清单 #1）。

### 检查点 2 — G1.1「沿用最近活跃 session cwd」vs resolveDefaultCwd 派生

- requirements：G1.1 / §7 / UC-2 AC-2.1 / Q2-a [D-可逆] 四处一致表述「非首次沿用最近活跃 session 的 cwd」。
- architecture：§4 `resolveDefaultCwd` 纯函数 =「session list 中最近活跃 session 的 cwd（单值）」；§1 G1.1 转换、§7 模块表、§9 泳道图（`create(recentCwd, undefined)`）三处对齐。
- **判定：完全一致，无矛盾。** resolveDefaultCwd 是 G1.1 的精确落地，且与 RecentWorkspace（top10 列表视图）正确区分（单值 vs 列表）。

### 检查点 3 — UC-7 非 git 目录 vs BC-12 + §5 不变式

- requirements：UC-7 后置状态/AC-7.1（branch chip 隐藏、分支入口隐藏、session 正常创建）+ AC-7.2（外部 git init 后 TTL 过期/重开恢复显示）+ §7 约束 + Q3 [D-不可逆]。
- architecture：
  - BC-12「git-info 非 git 目录返回 null → branch chip 隐藏」+「branch-popover/branch-modal 不可达」覆盖 UC-7 后置状态/AC-7.1。
  - §5 不变式「gitInfo == null 时 branch-popover/branch-modal 不可达、chip 隐藏；状态机只走 idle↔landing↔dir-popover↔dir-dialog 子集」覆盖入口隐藏。
  - §7 landing 组件「按 gitInfo 派生 branch chip 可见性（非 git 目录隐藏，UC-7）」。
  - git-info 5min TTL（§4 GitInfo / BC-6）覆盖 AC-7.2 的「TTL 过期恢复」；重开应用缓存清空→重读覆盖「重开恢复」。
- **判定：完整覆盖，无矛盾。** [D-不可逆] Q3 未被触碰。

### 检查点 4 — 「分支/dirty 同步 git 命令（有超时阻塞约束）」vs git-info / GitService

- requirements §7 技术约束：「分支/dirty 读取为**同步** git 命令（有**超时阻塞**约束）」；UC-4 异常流程「git 命令读取失败/**超时** → branch popover 禁用切换并提示」。
- architecture：
  - git-info 定性为「services 层裸 `execSync`」（§4 / §6 / D-5 / §7 多处）—— execSync 即**同步**，与「同步 git 命令」一致。
  - dirty 接入「复用 GitService.getStatus」（D-5 / §7），同样是同步 git 读。
  - architecture **全文未出现具体超时数值**（已 grep 确认：无 `2s`/`timeout`/`超时` 字样出现在 architecture 正文）。architecture 把 git-info 当**既有稳定模块**引用，既未增设也未删除超时——「有超时阻塞约束」作为现状约束被**默认保持**，未被推翻。
- **判定：一致，约束保持，无矛盾。** （注：任务描述中的「2s timeout」来自 git-info.ts 现状代码，非 architecture 文档引入；architecture 未触碰该约束。）

### 广域扫描（4 检查点之外）

| requirements 决策/约束 | architecture 对应 | 判定 |
|----------------------|------------------|------|
| Q1 [D-不可逆] 覆盖 5 步流程 | §5 状态机 8 态覆盖全 5 步 | ✅ |
| Q2-a [D-不可逆] 任务=会话 1:1 | D-2「task=session 1:1 已定」 | ✅ |
| Q2-b [D-不可逆] 首次启动 chip 空态+发送 disabled | §5/§7 landing 未显式重述「发送 disabled」，但**未推翻**（属 elaboration gap，非矛盾；落地实现需遵守 requirements AC-1.3/AC-2.2） | ✅ 无矛盾（仅覆盖度 gap，不反哺） |
| G8 [D-可逆] 触发即创建空 session | §5「create: 触发新建即创建空 session」 | ✅ |
| §7 dirty「留在工作区，不自动 stash」 | §7 branch popover dirty 标记+二次确认；D-5 复用 getStatus。未提 stash 但**未推翻** | ✅ |
| §7「创建分支仅基于 HEAD」 | §6 port 扩 `+branch/-b`（从 HEAD 创建）一致 | ✅ |
| §7 git「5min TTL 缓存，非实时」 | §4 GitInfo「5min TTL」一致 | ✅ |
| F8 unborn HEAD 空态 | §7 branch popover「unborn HEAD 空态文案+引导首次 commit（F8/AC-4.3）」 | ✅ |

**无 [D-不可逆] 决策被推翻。** Q1/Q2-a/Q2-b/Q3 四项 [D-不可逆] 均保持。

## 矛盾清单

### #1 [borderline · 非业务推翻] requirements §3 数据清单「最近 workspace 来源: 本地缓存（LRU）」事实性失准

- **矛盾类型**：设计假设被下游证伪（实现层），**非业务约束推翻**。
- **涉及上游章节**：requirements.md §3 数据清单第 4 行（「最近 workspace 列表 | 来源: 本地缓存（LRU，上限 10 条） | ... | 本地，无云端，LRU 淘汰最久未用」）。
- **矛盾描述**：architecture D-6 + §4 + BC-9 已证伪「需要独立本地缓存」这一隐含假设——SessionSummary 已含 cwd+lastActiveAt，改为从 session list 派生 `recentWorkspaces(sessions)`，无独立缓存模块、无独立持久化。requirements §3 该行「来源: 本地缓存」「归档: 本地，无云端，LRU 淘汰最久未用」在新模型下**事实性失准**（来源实为 session list 派生；无独立 LRU 淘汰动作，由 session 生命周期自然驱动）。
- **业务影响**：零。用户可见行为（top10 最近 distinct cwd）与 Q12 用户拍板（LRU 策略 + 上限 10）完全一致。
- **是否 NEEDS_USER_CONFIRM**：**否**。Q12 为 [D-可逆] 且用户拍板的是策略+上限（均保持）；存储格式已 [移交②] 授权；②在授权內行权，无需用户再确认。

## 建议

### 建议 #1（对应矛盾 #1）— 可选追溯标注，非强制

- **涉及上游章节**：requirements.md §3 数据清单「最近 workspace 列表」行 + §7 业务约束「最近 workspace 列表 LRU 淘汰，上限 10 条」+ 决策记录 Q12。
- **建议修订**（三处统一加追溯注释，措辞供主 agent 参考）：
  - §3 数据清单该行「来源」与「归档策略」列追加：`[BACKFED from architecture on 2026-06-26] 存储机制经②D-6 确认为派生函数 recentWorkspaces(sessions)（非独立本地缓存），来源实为 session list；业务行为（top10 最近 distinct cwd、LRU 语义）不变。`
  - §7 业务约束该行追加：`[BACKFED from architecture on 2026-06-26] 「LRU 缓存」措辞为实现假设，②已证伪并改为派生；LRU 淘汰语义（按最近活跃倒序）保持。`
  - Q12 决策记录追加尾注：`[BACKFED from architecture on 2026-06-26] 存储格式（独立缓存 vs 派生）属②授权范围，D-6 改为派生；本决策 pin 的策略+上限未变。`
- **是否 NEEDS_USER_CONFIRM**：否（[D-可逆] + 授权范围内 + 业务行为不变）。
- **优先级**：低（纯文档可追溯性，不影响后续阶段）。主 agent 可选做或不做；不做也不阻断 issues 阶段。

---

## 整体结论

**无强制反哺矛盾，可交接至 issues 阶段。**

- 4 个特别检查点中，#2/#3/#4 完全一致；#1 为 borderline（实现层细化，业务约束未推翻）。
- 无 [D-不可逆] 决策被推翻。
- 唯一可选动作：建议 #1 的追溯标注（NEEDS_USER_CONFIRM=否，非强制，纯文档可追溯性）。
