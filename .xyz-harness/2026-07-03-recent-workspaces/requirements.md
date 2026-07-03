---
topic: recent-workspaces
deliverable: requirements
verdict: pass
stage: mid-plan
complexity_tier: L2
created_at: 2026-07-03
---

# 需求规格 — recent-workspaces（最近工作区独立持久化）

> 设计工作流 mid-plan 产出。本文件只定义「做什么 + 为什么 + 约束」，**不含**系统实现（API/RPC/数据 schema 在 system-architecture.md）。技术约束（必须用 JSON store）只记录不展开。

## 1. 业务目标（根）

**G1：让「最近工作区」成为独立于 session 生命周期的持久化使用记录。**

当前「最近工作区」列表是从 session 列表实时派生的（`recentWorkspaces(session.list)`），session 被删后对应目录从列表消失，不符合「使用记录应独立持久化」的用户预期。

### 成功标准（可衡量）

| ID | 标准 | 当前态（违反） | 目标态 |
|----|------|---------------|--------|
| S1 | 删除某 session 后，该 session 的 cwd 仍出现在最近目录列表 top10 内（只要它历史 top10 内） | cwd 随 session 删除而消失 | cwd 保留 |
| S2 | 记录按独立时间戳排序，与 session 列表解耦 | 排序依赖 session.lastActiveAt | 独立时间戳 |
| S3 | 进程重启后记录不丢（持久化到磁盘） | 无磁盘存储（纯内存派生） | 持久化文件存在 |
| S4 | 新目录首次使用即记录，老目录重新活跃即刷新时间戳 | — | 两个写入时机覆盖 |

> 「成功」= S1-S4 全部成立。S1 是核心 AC（用户可感知），S3 是持久化基线。
>
> **成功标准 → AC 追溯**（需求审查 should_fix-3 补全）：S1→AC-5.1；S2→AC-1.2；S3→AC-7.1（见下）；S4→AC-2.1+AC-3.1。

### AC-7（跨进程生命周期，对应 S3）

- **AC-7.1**：runtime 进程重启后，`workspace.listRecent` 返回重启前已记录的 cwd 列表（顺序与内容一致）——验证持久化文件落盘且 reload 一致

## 2. Actors

| Actor | 描述 | 隐含？ |
|-------|------|--------|
| 用户 | 通过「新建任务」流程选择工作目录的人 | 否（主 Actor） |

无隐含 Actor（无审核人/管理员/外部系统消费方）。这是用户直接交互的单 Actor 场景。

## 3. 业务用例（非技术用例）

> 区分「目标」与「方案」：以下描述用户**想达成什么**，不描述 RPC/store/数据结构。

### UC-1：查看最近工作区列表（主流程）

- **Actor**：用户
- **前置**：用户进入「新建任务」流程，触发「选目录」popover（DirSelectPopover）
- **主流程**：
  1. 用户看到「最近工作区」列表，按最近使用时间倒序排列，最多 10 条
  2. 每条显示目录名（basename）+ 完整路径
  3. 用户可在搜索框过滤列表
- **替代**：列表为空 → 显示「暂无最近工作区 · 选择一个本地目录开始」空态（已有，不变）；搜索无命中 → 同空态（DirSelectPopover.vue:59 isEmpty 涵盖两种）
- **后置**：用户选某条 → 进入「选分支」步骤；或点「打开文件夹」→ 走 OS 原生目录选择器
- **AC**：
  - AC-1.1：列表条目数 ≤ 10
  - AC-1.2：列表按「最近使用时间」倒序
  - AC-1.3：搜索输入即时过滤（按 cwd 子串匹配，label 是 cwd 的 basename 故已被覆盖）
  - AC-1.4：列表项显示「目录名 + 完整路径」两行（不变更现有形态）

### UC-2：新建目录时记录（写入时机 A）

- **Actor**：系统（响应用户的「创建任务」动作）
- **前置**：用户在「新建任务」流程选/输入了一个本地目录，系统创建 session
- **主流程**：session 创建成功时，该 cwd 被记入「最近工作区」记录
- **边界（需求审查 should_fix-1 + 禁读重建 MISMATCH-2，K 类待 mid-detail-plan batch-ask）**：`useNewTaskFlow` 是**延迟 create**（首发消息才 create，选目录只记 pendingCwd）。故「用户选了目录但未提交消息就退出」时，目录不被记录。本 UC 当前语义 = 「只有 create 才记录」（实现最简）。是否扩展为「选目录即记录」（pendingCwd 写入时触发）留 mid-detail-plan batch-ask。
- **AC**：
  - AC-2.1：每次 session 创建，对应 cwd 加入记录（若已存在则刷新时间戳到最新）
  - AC-2.2：cwd 为空串/undefined 时跳过（脏数据防御）

### UC-3：老目录重新活跃时刷新时间戳（写入时机 B）

- **Actor**：系统（响应用户在已存在 session 上发消息）
- **前置**：用户切到/继续一个已存在的 session，并发送消息
- **主流程**：session 活跃时（发消息），对应 cwd 的时间戳刷新到最新
- **AC**：
  - AC-3.1：同一 cwd 多次活跃 → 时间戳更新、列表中不重复（保持单条）
  - AC-3.2：（写入频率控制）频繁发消息不会导致每条消息都触发磁盘写——debounce 归位 WriteBackCache（set 即时更新内存 + dirty，定时 flush 落盘），具体 flush 周期参数属 architecture（见 system-architecture.md §7，json-store.ts DEFAULT_FLUSH_MS=500 / session-data-store FLUSH_INTERVAL_MS=5000）

### UC-4：LRU 淘汰

- **Actor**：系统
- **前置**：记录已达上限 10 条，出现第 11 个新 cwd
- **主流程**：最旧的记录被淘汰，新 cwd 入列
- **AC**：
  - AC-4.1：记录上限固定 10 条（与现有 `MAX_RECENT_WORKSPACES` 一致）
  - AC-4.2：淘汰最久未使用的（按 lastUsedAt 时间戳最小者）

### UC-5：删除 session 不影响记录（核心反向 AC，对应 S1）

- **Actor**：用户
- **前置**：记录中含某 cwd（来自已删 session 的历史）
- **主流程**：用户删除该 session
- **后置**：该 cwd 仍在最近工作区列表（只要它在历史 top10 内）
- **AC**：
  - **AC-5.1（核心）**：删除 session 后，`recentWorkspaces` 列表不变（不因 session 文件消失而丢目录）

### UC-6：默认工作目录（默认 cwd）

- **Actor**：系统（响应用户进入「新建任务」流程）
- **前置**：用户进入「新建任务」流程，composer 预填默认 cwd
- **主流程**：默认 cwd = 最近使用的目录（时间戳最新者）
- **AC**：
  - AC-6.1：有记录时，默认 cwd = 列表第一条（时间戳最新）的 cwd
  - AC-6.2：无记录时，默认 cwd = undefined（由上层 fallback，不变更现有 fallback 语义）

## 4. 数据（业务概念，非 schema）

| 概念 | 说明 |
|------|------|
| 最近工作区记录 | 一条「目录路径 + 最近使用时间」的二元组，全局唯一（不绑 session） |
| 记录列表 | 最多 10 条，按时间倒序 |
| 目录路径（cwd） | 业务标识，相同 cwd 视为同一条（去重键） |
| 最近使用时间 | 业务排序键，每次该目录被「新建」或「重新活跃」时刷新 |

> 字段名/类型/schema（lastUsedAt: number vs ISO string 等）属 system-architecture.md。

### 4.1 数据流转（Data Flow，业务层）

```
用户动作（新建任务/发消息）
  → 系统 record(cwd)              [业务事件：目录被使用]
  → 记录持久化（落盘，独立于 session）
  → 用户下次打开选目录 popover
  → 系统 pull 最近记录列表        [读取，非派生]
  → popover 展示（与 session 列表解耦）
```

**关键转变**：当前数据流是 `session.list → 派生 recentWorkspaces`（间接依赖 pi session 文件）；改造后是 `独立持久化记录 → pull`（解除对 session 生命周期的依赖）。这是本功能的业务核心。

## 5. 界面场景

| 场景 | 位置 | 变更 |
|------|------|------|
| 选目录 popover | `DirSelectPopover.vue` | 数据源从 session 派生 → 独立记录（形态/交互不变） |
| composer 预填默认 cwd | `useNewTaskFlow.ts` | `resolveDefaultCwd` 数据源变更（行为不变） |

**无新增界面**，无前端设计稿需求（handoff §6 约束：不创建 demos/）。

## 6. 约束（Constraints，只记录不展开）

> 来源标注 [from: handoff §6] / [from: CLAUDE.md 规则 #N]

- **C1**：数据目录禁止硬编码 `~/.xyz-agent`，用动态 `getConfigDir()`（CLAUDE.md 规则 #2）
- **C2**：持久化用原子写（atomicWrite），不用裸 `writeFileSync`（复用现有抽象）
- **C3**：不引入 SQLite（数据量极小 top10 × ~100B，访问模式整体读写非按行查；SQLite 引入原生依赖与打包约束 #12 冲突）—— handoff §2 已论证
- **C4**：runtime→前端消息遵循「所有消息带 sessionId」隔离规则（规则 #7）+ 「broadcast 时序竞争」约束（renderer 主动拉取，不依赖 broadcast）
- **C5**：emit 只传单个 payload 对象（规则 #1）
- **C6**：测试用 vitest，禁 node:test / tsx --test（测试规范）
- **C7**：若新增 runtime dependencies，须同步 `tsup.config.ts` 的 `noExternal`（打包约束 #12）—— 本功能预期无新依赖（复用 WriteBackCache），architecture 确认

## 7. 不做（边界）

- **不做** SQLite 迁移（C3）
- **不做** 跨机器同步（单机本地记录）
- **不做** 目录内容索引/搜索（仅记录路径 + 时间）
- **不清理** pi 的 session 文件
- **不改** pi 侧任何东西（xyz-agent 侧独立维护记录，与 pi 数据目录完全隔离——规则 #11）
- **不做** 迁移现有 session 派生数据（冷启动从空记录开始，随使用积累）—— **已确认（D-001）**：纯空开始，YAGNI，不加迁移逻辑

## 8. 跨系统依赖

| 依赖 | 类型 | 说明 |
|------|------|------|
| session 创建流程 | 内部触发 | UC-2 写入时机 A 的触发源 |
| session 活跃（发消息）| 内部触发 | UC-3 写入时机 B 的触发源 |
| filesystem（持久化文件）| 内部 infra | 记录的存储介质 |
| pi session 文件扫描 | 只读上游 | **本功能解耦此依赖**——这是改造的核心动机（S1） |

> 与 pi 的依赖关系变更：当前「最近工作区」**间接依赖** pi session 文件存在（派生自 session.list，而 session.list 扫描 pi jsonl）。改造后**解除此依赖**——记录独立持久化，pi session 文件删除不影响。这是本功能的核心价值。

## 9. 决策记录

> 本功能业务决策少（核心是架构决策，见 system-architecture.md）。已通过 batch-ask 确认的决策见 `decisions.md`（D-001 冷启动空开始 / D-002 删除派生函数）。架构层 agent-opinionated 决策（D-003 三层 / D-004 global+pull / D-005 复用 WriteBackCache / D-006 number 时间戳）见 system-architecture.md §10 + decisions.md。
