---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
backfed_from: []  # ④无下游反哺；④对③的反哺标注已落地 issues.md AC-7.7
---

# 非功能性设计 — 新建任务

> 评估 [issues.md](./issues.md)（③）每个已决策方案对系统的副作用，并给缓解方案。
> 7 维度：安全 / 数据 / 性能 / 并发 / 稳定性 / 兼容性 / 可观测性。
> 8 个 issue（#1~#8），#9~#12 为 P3 延后项不在本期分析范围（P3 方案未决，无副作用可评估）。

## 分析矩阵

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 | A (sessionApi.create cwd 透传) | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| #2 | A (Landing.vue + messageCount 派生) | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| #3 | A (useNewTaskFlow composable) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| #4 | A (recentWorkspaces 纯函数) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #5 | A (dir popover + OS dialog) | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| #6 | A (branch popover + getStatus 同步) | ⚠️ | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| #7 | A (createBranch modal + port 扩展) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| #8 | (forkSession cwd 波及) | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |

（✅ 无风险 / ⚠️ 有风险已缓解 / ✘ 不可接受需回退（本期无） / — 不适用+理由）

> **无不可接受项**：所有维度风险均可缓解或显式接受为残余风险，无需回 Step 3 重选方案。

## 详细分析

### Issue #1: sessionApi.create cwd 透传（T1）— 方案 A

#### 安全影响
**风险**: cwd 由前端透传至 runtime，若前端被注入恶意路径（XSS 篡改变量），可能让 pi spawn 到非预期目录。
**影响范围**: `session.create` WS 消息的 cwd 字段 → runtime `session-lifecycle.ts:42` spawn pi 的 cwd。
**缓解方案**: runtime 侧 `session-lifecycle.ts` 对 cwd 做路径校验（必须是绝对路径 + 目录存在 + 可读），与 AC-1.3「非法 cwd 显错不静默回退」一致。前端不信任自校验，runtime 是信任边界。
**残余风险**: **cwd 路径校验是⑤待落项，当前 `session-lifecycle.ts:42` 仅 `const sessionCwd = cwd ?? process.cwd()` 零校验**（源码核实）。校验⑤落地前为残余风险；落地后归零。

#### 数据一致性影响
**事务边界**: 不涉及（无多表写）。
**并发场景**: 见「并发控制」维度。
**迁移方案**: 无存量数据迁移（cwd 是新建 session 才带，老 session cwd 仍为 null，#4 AC-4.5 已处理脏数据过滤）。
**回滚策略**: sessionApi 签名扩展是 non-breaking（cwd 可选），回滚只需删 cwd 字段。

#### 性能影响
**预期负载**: 新建 session 是低频操作（用户手动触发），QPS 极低。
**关键路径延迟**: cwd 透传是 payload 加字段，零额外开销。
**扩展性瓶颈**: 无。
**优化方案**: 无需。

#### 并发控制
**竞态场景**: 双击 sidebar+ 与 ⌘N 并发、newSession 触发点叠加 → 重复创建空 session（AC-1.5）。
**幂等策略**: useNewTaskFlow composable 内 in-flight 标记（create 飞行中再触发忽略）或 debounce。归属 #3 composable 实现。
**锁策略**: 无锁（单用户桌面，in-flight flag 足够）。
**分布式考虑**: 不适用（单进程）。

#### 稳定性影响
**故障场景**: session.create 业务校验通过但 pi spawn 失败（cwd 无权限 / pi 崩溃）→ 半创建态僵尸 session（AC-1.6）。
**降级方案**: runtime 侧 session.create 失败时回滚（不持久化 session 实体），前端显错。
**熔断/限流**: 不适用（低频操作）。
**重试策略**: 不自动重试（pi spawn 失败通常是环境问题，重试无意义），用户手动重试。
**SLA 影响**: 无。

#### 兼容性影响
**API 变更**: `sessionApi.create` 签名 `create(title?)` → `create(cwd?, label?)` 是 **non-breaking**（新增可选参数 + payload 可选字段）。runtime 协议已支持 cwd，前端对齐。
**数据兼容**: 老 session（cwd=null）不受影响，#4 派生函数已过滤。
**客户端影响**: forkSession（#8）无参调用需同步改（否则 cwd=undefined 回退，语义错误），由 #8 独立 ticket 处理。
**灰度/回滚**: 签名扩展可安全灰度/回滚。

#### 可观测性
**日志**: session.create 的 cwd 值进结构化日志（便于排查「为什么 spawn 到错目录」）。
**指标**: 新建 session 成功率 / cwd 透传命中率（undefined 占比 → 反推调用点遗漏）。
**追踪**: WS 消息含 sessionId 便于关联。
**告警**: 不适用。
**审计**: 不适用（非敏感操作）。

---

### Issue #2: Landing.vue + messageCount 派生判据 — 方案 A

#### 安全影响
**不适用** — 纯前端展示组件，无信任边界跨越，无用户输入进入查询。判据从 chat store 派生（内部数据源）。

#### 数据一致性影响
**不适用** — landing 只读不写，messageCount 派生自 chat store 现有 Map，不引入新数据存储。

#### 性能影响
**风险**: getHistory 未 hydrate 时乐观渲染 landing（AC-2.3），hydrate 完成后若非空切对话流 → 视觉闪烁（landing 一闪即换）。
**缓解方案**: landing 渲染前有极短 loading 占位（如 50ms 内 hydrate 完成则不闪），或 hydrate 完成前渲染骨架屏而非完整 landing。具体阈值属⑤实现。
**残余风险**: 弱网/大 session history 下闪烁，接受（不影响功能，仅视觉）。

#### 并发控制
**不适用** — 前端渲染无并发，Vue 响应式自动处理状态变更。

#### 稳定性影响
**故障场景**: getHistory 加载失败（网络/文件损坏）→ landing 永久卡住（AC-2.6）。
**降级方案**: landing 有失败出口（超时 / 重试 / 显错），未 hydrate 乐观空判据仅适用于「加载中」。
**熔断/限流**: 不适用。
**重试策略**: 提供「重试加载历史」按钮。
**SLA 影响**: 无。

#### 兼容性影响
**不适用** — 新增组件，不改既有 Panel.vue 对话流渲染（仅加 v-if 分支）。

#### 可观测性
**日志**: landing→对话流切换时机可埋点（诊断「为什么没显示 landing」）。
**指标**: 无关键指标。
**追踪**: 无。
**告警**: 无。
**审计**: 无。

---

### Issue #3: useNewTaskFlow composable（状态机 + overlay + Esc）— 方案 A

#### 安全影响
**不适用** — 前端编排逻辑，不跨信任边界。

#### 数据一致性影响
**不适用** — composable 只管理 UI 状态机，不持久化（NewTaskFlow 实例模型移交⑤）。

#### 性能影响
**不适用** — 状态机转换是 O(1)，无性能风险。

#### 并发控制
**竞态场景**:
1. overlay 打开时用户切 session（AC-3.10）→ 4 overlay 态需 →cancelled 转移，否则卡死。
2. overlay 打开时 Esc 与状态转换竞争（AC-3.9）。
**幂等策略**: 状态机单值 enum（overlay 互斥，AC-3.2）+ 显式转移表（非法转换抛错，AC-3.1）。
**锁策略**: 无锁（单线程 JS，状态机本身是串行化）。
**分布式考虑**: 不适用。

#### 稳定性影响
**故障场景**:
1. 非法状态转换抛错（AC-3.11）→ 组件崩溃。
2. 发送失败（AC-3.4）→ 状态卡在非法态。
**降级方案**: 非法转换抛错后状态机回安全态（idle），Vue 错误边界兜底不崩组件。发送失败不改 flow 态（留 landing），composer 子态显错。
**熔断/限流**: 不适用。
**重试策略**: 状态机不自动重试（回 idle 让用户重新触发）。
**SLA 影响**: 无。

#### 兼容性影响
**不适用** — 新增 composable，useSidebar.newSession 退化为薄封装（保留旧 API 兼容）。

#### 可观测性
**日志**: 状态转换序列可 debug 级日志（诊断「为什么 Esc 没关 popover」）。
**指标**: overlay 打开时长 / 非法转换抛错次数（反推状态机 bug）。
**追踪**: 无。
**告警**: 无。
**审计**: 无。

---

### Issue #4: recentWorkspaces 派生 + resolveDefaultCwd 纯函数 — 方案 A

> **7 维度全 ✅ / —**：纯函数，输入 SessionSummary[] 输出派生结果，无副作用、无 IO、无信任边界、无并发（前端调用）、无兼容性问题（新增函数）。
> - 安全 —：无外部输入处理，session list 是内部数据源。
> - 数据 ✅：无写操作，纯派生。
> - 性能 ✅：session list 量级 0~数十，O(n) 排序去重零开销。
> - 并发 ✅：纯函数无状态，前端 computed 包裹自动响应式。
> - 稳定性 ✅：无外部依赖。
> - 兼容性 ✅：新增函数，不影响既有。
> - 可观测性 ✅：无需埋点（纯逻辑）。

---

### Issue #5: directory popover + OS dialog 接入 — 方案 A

#### 安全影响
**风险**: pick-directory IPC 返回的路径直接进 session.create cwd，若 IPC handler 被篡改返回恶意路径。
**影响范围**: `dialog.showOpenDialog` 返回的 filePaths → session cwd。
**缓解方案**: OS 原生 dialog 是信任边界（用户手动选），IPC handler 复用既有 `privileged-handlers.ts:42-58`（已存在且验证过）。runtime 侧 session.create 仍做路径校验（与 #1 安全影响同源）。
**残余风险**: 无。

#### 数据一致性影响
**不适用** — 选目录是元信息调整，不写持久数据（除非提交新建 session）。

#### 性能影响
**不适用** — OS dialog 是用户交互，无性能瓶颈；popover 列表来自 #4 纯函数派生。

#### 并发控制
**不适用** — OS dialog 是模态阻塞（OS 层面串行），popover 是单实例。

#### 稳定性影响
**故障场景**:
1. pick-directory IPC handler 抛错（getFocusedWindow null，AC-5.6）→ popover 崩。
2. 用户选不可读目录（AC-5.7）→ session.create 失败但 popover 已关，错误反馈割裂。
**降级方案**: IPC 抛错时 popover 显错 toast 不崩；不可读目录错误经统一错误策略（#3 AC-3.13）在 landing composer 子态显错。
**熔断/限流**: 不适用。
**重试策略**: 用户可重新点 chip 选目录。
**SLA 影响**: 无。

#### 兼容性影响
**不适用** — 复用既有 IPC handler，零 runtime 改动（BC-7）。

#### 可观测性
**日志**: pick-directory IPC 调用结果（选中/取消/失败）。
**指标**: 目录选择成功率。
**追踪**: 无。
**告警**: 无。
**审计**: 无。

---

### Issue #6: branch popover + getStatus 同步接入 — 方案 A

> **本 issue 是 NFR 重灾区**（git 同步阻塞 + 不可逆操作 dirty 切走）。

#### 安全影响
**风险**: getStatus / git checkout 的 cwd 来自 session，若 cwd 被篡改指向敏感系统目录，git 命令在其下执行。
**影响范围**: GitService.getStatus / git checkout 的 cwd 参数。
**缓解方案**: GitService 复用 git-info.ts 的 cwd 来源（session.cwd，runtime 已校验）。git checkout 是本地分支切换，命令白名单（不执行任意命令）。dirty 数据只读。
**残余风险**: 无。

#### 数据一致性影响
**风险**: dirty 分支切走（AC-6.2）执行 `git checkout 目标分支`，未提交改动保留在工作区——若目标分支与改动冲突，git 会报错或部分应用。
**事务边界**: git checkout 是原子操作（git 内部保证）。
**并发场景**: 用户切走 dirty 分支时，工作区文件可能被其他进程（编辑器/构建）修改 → git checkout 冲突。
**迁移方案**: 不涉及。
**回滚策略**: v1 选「留在工作区」（不 stash），git checkout 失败时工作区不变（用户可手动 stash 后重试）。
**残余风险**: 多进程并发改工作区导致 checkout 冲突，接受（单用户桌面，概率低）。

#### 性能影响
**风险**: getStatus 同步执行阻塞 runtime event loop（Q2 用户决策「git 全同步」，AC-6.5/AC-6.8）。
**源码事实（G1 修正）**: `getStatus`（`git-service.ts:87`）走 **IGitExecutor port**（`infra/git-executor.ts` execFileSync），与 `git-info.ts:readGitInfo`（execSync 缓存 `{branch,isWorktree}`）是**两条完全独立的代码路径，无共享缓存，且缓存数据类型不同**（branch 元信息 vs dirty/numstat 状态）。getStatus 拿不到 readGitInfo 缓存里的 dirty 数据——因为那缓存里根本没有 dirty 数据。AC-6.6「BC-6 同源」指的是「同走 GitService」，非「同走 readGitInfo 缓存」。
**预期负载**: 开 branch popover 时触发（低频，用户手动）。
**关键路径延迟**: 本地 .git 实测 git status ~20ms；getStatus 实际跑 status + diff（numstat）**两次 spawn，阻塞 ~40-50ms**（非初稿误估的 ~20ms）。仍远低于消息流 RTT，单用户桌面可接受。
**扩展性瓶颈**: session 量级 0~数十，单次 popover 单次 getStatus，无 N+1。
**优化方案**: getStatus **新建自己的 per-cwd 缓存**（缓存 GitStatusResult，TTL 复用 CACHE_TTL_MS 量级），同 cwd 重复开 popover 命中缓存零 spawn。分支切换低频，v1 可先不加缓存（每次 spawn），性能问题实测后优化。
**渲染性能（AC-6.9）**: 分支列表极多（100+）时 popover 需虚拟滚动/限制渲染数量 + 搜索过滤（属前端渲染，⑤实现处理，非 event loop 阻塞）。
**残余风险**: ~40-50ms 阻塞对单用户桌面应用可接受，监控 P99（若实测 >200ms 则 worker_threads 化作独立优化 ticket）。

#### 并发控制
**竞态场景**: getStatus 同步阻塞 event loop 期间用户 Esc（AC-6.7）→ execSync 期间 JS 冻结，Esc 排队，阻塞结束后处理。
**幂等策略**: 状态机按队列 Esc 转移不丢事件（#3 composable 保证）。
**锁策略**: 无锁（execSync 本身串行）。
**分布式考虑**: 不适用。

#### 稳定性影响
**故障场景**: getStatus 同步执行失败（AC-6.4）→ popover 显错不崩；unborn HEAD（AC-6.3）→ 空态引导首次 commit。
**降级方案**: getStatus 失败 popover 显错，git checkout 失败工作区不变（用户可重试）。
**熔断/限流**: 不适用。
**重试策略**: 用户重新点 chip。
**SLA 影响**: 无。

#### 兼容性影响
**不适用** — 复用既有 GitService.getStatus（BC-6），dirty 标记是新增展示。

#### 可观测性
**日志**: getStatus 调用 + 耗时（关键，验证 ~40-50ms 阻塞假设）。
**指标**: getStatus P99 耗时 / 缓存命中率 / git checkout 成功率。
**追踪**: 无。
**告警**: P99 > 200ms 告警（运维项）。
**审计**: dirty 切走是用户主动确认操作（inline 二次确认条），不另记审计。

---

### Issue #7: createBranch modal + GitService.createBranch 扩 port — 方案 A

> **本 issue 是 NFR 第二重灾区**（不可逆 git 写 + port 扩展 + 同步阻塞）。

#### 安全影响
**风险**:
1. createBranch 执行 `git checkout -b <分支名>`，分支名来自前端用户输入 → 命令注入（如分支名含 `; rm -rf`）。
2. port 扩展（GitCommand 白名单 +branch/-b）若白名单过宽 → 任意 git 命令执行。
**影响范围**: GitService.createBranch 的分支名参数 + GitCommand 枚举。
**缓解方案**:
1. 分支名校验（AC-7.8）：前端实时校验 git 分支名规则（禁空格/特殊字符/`..`/`-`开头/`~^:` 等）+ runtime 二次校验（不信任前端）。
2. GitCommand 白名单显式枚举（只含 `branch` / `checkout -b`，结构 G-2），handler 不接受任意命令字符串。
3. execSync 用参数数组传递（不经 shell），消除命令注入面。
**残余风险**: 无（白名单 + 参数化 + 双重校验）。

#### 数据一致性影响
**风险**: createBranch 是**不可逆 git 写操作**（spec §2.3），执行后 git 仓库多一个分支。
**事务边界**: `git checkout -b` 是原子操作（git 内部保证：要么创建并切换成功，要么不变）。
**并发场景**: 用户在 modal 提交时，工作区被其他进程修改 → checkout -b 可能因 dirty 冲突失败。
**迁移方案**: 不涉及。
**回滚策略**: 创建失败留 modal 显错（AC-7.3，D-7 决策），用户修正分支名重试。成功后无法自动回滚（分支已建），用户需手动 `git branch -d`。
**残余风险**: 误建分支需手动清理，接受（modal 是用户主动确认的不可逆操作）。

#### 性能影响
**风险**: createBranch 同步执行阻塞 event loop（Q2 决策，AC-7.6）。
**预期负载**: 用户手动创建分支（低频）。
**关键路径延迟**: 本地 .git `git checkout -b` ~30-50ms，阻塞可接受。
**扩展性瓶颈**: 无。
**优化方案**: 无需（低频 + 短耗时）。
**残余风险**: 无。

#### 并发控制
**竞态场景**:
1. createBranch WS 飞行中用户重复点击（AC-7.9）→ 重复创建。
2. createBranch 飞行中用户 Esc 关 modal（AC-7.9）→ 孤儿 promise。
3. execSync hang（.git/index.lock 持有，AC-7.7）→ 永久阻塞。
**幂等策略**: 提交按钮 disabled 防重复点击；Esc 后返回的孤儿 promise 忽略（状态已变不回灌 chip）。
**锁策略**: **createBranch 经 IGitExecutor port 已继承 8000ms 超时**（`infra/git-executor.ts:18` execFileSync timeout，源码核实，G2 修正），无需另加包装。AC-7.7「execSync 无原生超时」表述修正为「port 已有 8000ms 超时，createBranch 直接复用」。（注：git-info.ts 另有同名常量 GIT_TIMEOUT_MS=2000 未导出，与 port 的 8000 不同，不混淆。）
**分布式考虑**: 不适用。

#### 稳定性影响
**故障场景**:
1. createBranch 经 port 超时（8000ms，AC-7.7）→ modal 显错「git 操作超时」。
2. createBranch 失败（分支名非法/已存在）→ 留 modal 显错（AC-7.3）。
3. （已缓解）port 自带 8000ms 超时，无永久阻塞风险。
**降级方案**: port 超时 + modal 显错 + 用户可重试或取消。
**熔断/限流**: 不适用。
**重试策略**: 用户修正分支名后重试（modal 不关）。
**SLA 影响**: 无。

#### 兼容性影响
**API 变更**: GitService 扩展 createBranch 方法 + GitCommand 白名单加项 + protocol 加 git.createBranch 消息 → **non-breaking**（纯新增，不影响既有 git 命令）。
**数据兼容**: 不涉及。
**客户端影响**: 无（前端是新调用方）。
**灰度/回滚**: port 扩展可安全灰度/回滚（白名单加项不影响既有）。

#### 可观测性
**日志**: createBranch 调用（分支名 + cwd + 结果 + 耗时）。
**指标**: createBranch 成功率 / P99 耗时 / 分支名校验失败率。
**追踪**: 无。
**告警**: createBranch 失败率突增告警（运维项）。
**审计**: createBranch 是不可逆 git 写，**建议记审计日志**（谁/何时/创建什么分支）——但单用户桌面应用审计价值有限，v1 仅结构化日志，审计移后续。

---

### Issue #8: forkSession cwd 波及 — 方案（无 ≥2 对比，P2）

> **7 维度全 ✅ / ⚠️**：
> - 安全 ✅：cwd 取源 session（内部数据），非用户输入。
> - 数据 ✅：fork 语义明确，源 cwd 透传。
> - 性能 ✅：零开销。
> - 并发 ✅：与 #1 同源 in-flight 保护。
> - 稳定性 ✅：源 cwd 不存在时 session.create 失败显错（AC-8.4），不创建僵尸。
> - 兼容性 ⚠️：T1 改 sessionApi.create 签名后，forkSession 无参调用需同步改（否则 cwd=undefined 回退，语义错误）。**这是 T1 的波及面，独立 ticket #8 闭合**。
> - 可观测性 ✅：与 #1 同源日志。

---

## 缓解项回灌登记（Mitigation Rollback）

> 每条缓解必须落地为下游可执行项 + 标验收方式（代码测试 / 骨架约束 / 运维项）。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|----------|------|
| runtime cwd 路径校验（绝对路径+存在+可读） | #1, #5 | 安全 | ⑤契约 | session-lifecycle.ts session.create handler 加校验 | 代码测试 | 待落 |
| session.create 失败回滚（不留僵尸 session） | #1 | 稳定性 | ⑤时序图 | §session.create 时序图标 rollback 分支 | 骨架约束 | 待落 |
| 新建触发点幂等保护（in-flight 标记/debounce） | #1 | 并发 | ⑤test-matrix | 验证双击并发只创建 1 个 session | 代码测试 | 待落 |
| session.create 结构化日志（含 cwd） | #1 | 可观测 | ⑤契约 | session-lifecycle.ts logger 加 cwd 字段 | 骨架约束 | 待落 |
| landing 渲染条件约束（hydrate 前不渲染完整 landing） | #2 | 性能 | ⑤契约 | landing 组件渲染条件 grep 约束 | 骨架约束 | 待落 |
| getHistory 失败 landing 有重试出口 | #2 | 稳定性 | ⑤test-matrix | 验证加载失败有重试按钮 | 代码测试 | 待落 |
| 状态机非法转换回 idle + Vue 错误边界 | #3 | 稳定性 | ⑤test-matrix | 验证非法转换不崩组件且回 idle | 代码测试 | 待落 |
| overlay 打开时切 session 的 cancelled 转移 | #3 | 并发 | ⑤test-matrix | 验证 4 overlay 态切 session 不卡死 | 代码测试 | 待落 |
| 状态转换 debug 级日志 + 非法转换计数 | #3 | 可观测 | ⑤契约 | composable 加 logger + 计数器 | 骨架约束 | 待落 |
| getStatus 新建 per-cwd 缓存（GitStatusResult，非复用 readGitInfo） | #6 | 性能 | ⑤test-matrix | 验证同 cwd 重复开 popover 命中缓存 | 代码测试 | 条件性待落（依赖⑤骨架验证 P99>200ms 触发，见 D-NFR1） |
| getStatus P99 耗时埋点 | #6 | 可观测 | ⑤契约 | GitService.getStatus 加耗时日志 | 骨架约束 | 待落 |
| getStatus P99 > 200ms 告警 | #6 | 可观测 | 运维项 | 阈值监控（部署期配置） | 运维项 | 待落 |
| dirty 切走 inline 二次确认条 | #6 | 数据 | ⑤test-matrix | 验证 dirty 切走有确认 + 留工作区 | 代码测试 | 待落 |
| pick-directory IPC 抛错 popover 显错 toast | #5 | 稳定性 | ⑤test-matrix | 验证 IPC 失败不崩 popover | 代码测试 | 待落 |
| createBranch 分支名双重校验（前端+runtime） | #7 | 安全 | ⑤test-matrix | 验证非法分支名被拦截 | 代码测试 | 待落 |
| createBranch 经 port 继承 8000ms 超时（无需另加包装） | #7 | 并发 | ⑤契约 | createBranch 经 IGitExecutor port（infra/git-executor.ts:18） | 骨架约束 | 待落 |
| GitCommand 白名单显式枚举（branch/checkout -b） | #7 | 安全 | ⑤契约 | GitCommand enum grep 验证 | 骨架约束 | 待落 |
| createBranch 提交按钮 disabled 防重复 | #7 | 并发 | ⑤test-matrix | 验证飞行中 disabled | 代码测试 | 待落 |
| createBranch 失败留 modal 显错（D-7） | #7 | 稳定性 | ⑤test-matrix | 验证失败不关 modal 可重试 | 代码测试 | 待落 |
| createBranch 结构化日志（分支名+cwd+耗时） | #7 | 可观测 | ⑤契约 | GitService.createBranch logger | 骨架约束 | 待落 |
| forkSession 源 cwd 透传 | #8 | 兼容性 | ⑤test-matrix | 验证 fork 后 cwd=源 cwd | 代码测试 | 待落 |

**回灌指针说明**：
- 本表无「③新 issue」回灌去向——所有缓解项要么去⑤（契约/时序图/test-matrix），要么是运维项。无需 Step2 回灌指针重建器查③PHANTOM（机器检查 `check_backfeed_phantom` 会 SKIP，因无③指向行）。
- ⑤指针为延期承诺，由⑤code-arch §6「来源 B：NFR 风险→用例映射表」反向核对每条 `验收方式=代码测试` 的缓解项有 ≥1 对应用例，④不重复查。

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| git 同步阻塞 event loop ~40-50ms | 开 popover 期间其他 WS 请求等待（getStatus 实际跑 status+diff 两次 spawn） | 本地 .git 实测 ~40-50ms，单用户桌面应用可接受；Q2 用户决策 git 全同步 | getStatus/createBranch P99 耗时埋点，>200ms 告警 |
| 多进程并发改工作区致 git checkout 冲突 | dirty 切走/创建分支失败 | 单用户桌面，编辑器与构建并发改工作区概率低；git 报错用户可重试 | checkout 成功率指标 |
| 误建分支需手动清理 | git 仓库堆积孤儿分支 | modal 是用户主动确认的不可逆操作，v1 不自动回滚（避免二次副作用） | createBranch 成功率指标 |
| landing hydrate 闪烁（弱网/大 history） | 视觉闪烁 | 不影响功能，仅视觉 | 无（接受） |
| 空 session 堆积（cancelled 不自动清理） | session list 膨胀 | D-A25 用户决策 v1 不自动清理，用户手动 delete；session 量级 0~数十，堆积慢 | session count 指标（运维项） |
| getStatus 无缓存时每次开 popover spawn（status+diff 两次） | 性能开销 | AC-6.8 v1 可接受每次 spawn；若性能问题加 per-cwd 缓存 | 缓存命中率指标（若加缓存） |

## 需⑤骨架验证的副作用

> 不确定性高的副作用标记，stub 方法进⑤骨架，结论回写本节。

| 副作用 | 验证要点 | 预期结论方向 | stub 落点 |
|--------|---------|------------|----------|
| git 同步阻塞实测耗时（status+diff 两次 spawn） | 本地 + 大仓库（monorepo）下 getStatus 的 P99（实际跑 status + diff numstat 两次 spawn） | 确认 ~40-50ms 假设在常规仓库成立；大仓库可能 100-200ms 需评估缓存 | GitService.getStatus 加耗时埋点（⑤骨架落地） |
| NewTaskFlow 单实例模型（cancelled vs idle 重叠） | completed 后 ⌘N 再触发，单实例销毁重建是否丢状态 | 单实例可行（Obs-B，②已移交⑤裁决） | useNewTaskFlow 实例管理逻辑（⑤骨架） |
| getStatus 与 readGitInfo 是否需统一缓存 | #6 getStatus 走 IGitExecutor port 无缓存，git-info.ts readGitInfo 有独立缓存，两者数据类型不同（branch 元信息 vs dirty 状态） | 现状分叉合理（职责不同），getStatus 需新建自己的缓存（缓存 GitStatusResult），不与 readGitInfo 合并 | GitService.getStatus 实现独立缓存（⑤骨架） |

## 决策记录

> Step 1 Grilling 解决的根本取舍（K 类用户裁决）。

- **D-NFR1 git 同步阻塞缓解力度 = 方案 A（保持同步+现有超时/缓存+加观测）**（K 用户裁决）：3 档方案对比（A 保持同步/B 读异步写同步/C 全 worker_threads）。用户选 A。理由：本地 .git 实测 git 同步操作 ~40-50ms（getStatus 跑 status+diff 两次 spawn）阻塞对单用户桌面应用可接受，port 自带 8000ms 超时（createBranch）+ git-info.ts readGitInfo 自带 2000ms 超时+per-cwd LRU 缓存（branch 读），加可观测埋点即可。worker_threads 化是过度设计（当前负载不值得 worker 开销），作为未来独立优化 ticket（若 P99>200ms 触发）。符合 Ponytail（最短可行）+ 事实支撑。
- **D-NFR2（自决，G1 修正）git 读路径缓存独立新建**：#6 getStatus 走 IGitExecutor port，与 git-info.ts readGitInfo 是两条独立路径（源码核实），数据类型不同（GitStatusResult 含 dirty/numstat vs GitInfo 仅 branch/isWorktree）。**getStatus 需新建自己的 per-cwd 缓存**（缓存 GitStatusResult，TTL 复用量级），不与 readGitInfo 合并。原初稿「复用 readGitInfo 缓存」基于对 AC-6.6「BC-6 同源」的误读（同源指同走 GitService，非同走缓存），已修正。
- **D-NFR3（自决）createBranch 审计降级**：#7 createBranch 是不可逆 git 写，理论应记审计日志。但单用户桌面应用审计价值有限（无多用户追责场景），v1 仅结构化日志（含分支名/cwd/耗时/结果），审计移后续迭代。理由：避免过度设计，结构化日志已满足排查需求。

## 待确认

无。[D-NFR1 已由用户裁决，D-NFR2/D-NFR3 为 agent 自决（可逆/有明确启发式），定稿暴露。]
