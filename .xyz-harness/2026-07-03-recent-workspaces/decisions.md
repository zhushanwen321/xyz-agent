---
topic: recent-workspaces
created_at: 2026-07-03
---

# 决策账本 — recent-workspaces

mid-plan 创建。append-only，一行一条决策。字段 schema 见 `loop-skeleton.md` Step 1.2。
`source` 字段初稿前填 `§TBD`，Step 5a 纳入用户答案后补实章节锚点。

## 决策账本（append-only，一行一条决策）

> 表头与字段顺序固定（check 脚本/下游引用依赖）。`superseded_by` 空列留空；有值时原行 `status` 必须同步改 `revisited`。

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-001 | 冷启动纯空开始，不做 session 派生种子迁移 | YAGNI：迁移代码是一次性的，架构最简。老用户升级首屏空态代价低（用一两次即恢复），不值得加 loadPartition fallback 逻辑 | `D-可逆` | `ask_user` | `mid-plan` | `[from: requirements.md §7]` | `confirmed` | |
| D-002 | 删除 utils.ts 的 recentWorkspaces()/resolveDefaultCwd()，改用独立记录，不做 fallback | SSOT：独立记录已覆盖两函数职责，保留=双数据源漂移风险（违反「一致性>品味」）。调用方（DirSelectPopover/useNewTaskFlow）改接 workspaceStore | `D-可逆` | `ask_user` | `mid-plan` | `[from: system-architecture.md §2.1]` | `confirmed` | |
| D-003 | 采用三层架构（不引入 DDD4） | 核心计算是技术流程编排（LRU/去重/排序纯算法），无业务规则引擎/聚合行为，DDD4 过度设计 | `D-不可逆` | `agent-opinionated` | `mid-plan` | `[from: system-architecture.md §1]` | `confirmed` | |
| D-004 | 采用 pull-only RPC（workspace.listRecent），不做 broadcast | **措辞澄清（架构审查 SF-1 + 红队 S1 + 禁读重建 MISMATCH-1 三路独立指出原措辞「走 global 通道」是概念错位）**：pull RPC reply 经前端 routeInbound 的 pending map（msg.id 匹配，见 useConnection.ts:52-72），**不经 events.ts 订阅通道**（session/global 通道是 broadcast 推送专用）。原措辞「走 global 通道 + pull model」中「global 通道」误导，已修正为「pull-only RPC + 不 broadcast」。避开 broadcast 时序坑（invariant #3）。WriteBackCache 读内存使 pull 总拿最新值 | `D-不可逆` | `agent-opinionated` | `mid-plan` | `[from: system-architecture.md §6]` | `confirmed` | |
| D-005 | 复用 write-back 意图（dirty + 定时 flush）+ atomicWrite | 一致性>品味：项目现有持久化模式即「每域一 JSON + write-back + atomicWrite」，不另起。**具体抽象（WriteBackCache 固定 partition vs JsonStore+service debounce）归 code-arch 选定**（§7 形态适配列两方案） | `D-不可逆` | `agent-opinionated` | `mid-plan` | `[from: system-architecture.md §7, code-architecture.md §4]` | `confirmed` | |
| D-006 | lastUsedAt 用 number（Date.now()），与 session.lastActiveAt 一致 | 与现有惯例一致（utils.ts:47 已用 number 比较），无冲突则不自立标准 | `D-可逆` | `agent-opinionated` | `mid-plan` | `[from: system-architecture.md §10 D-候选-4]` | `confirmed` | |
| D-007 | 写入时机 A 只挂 SessionLifecycle.create，不扩展到 useNewTaskFlow.selectDirectory（选目录未提交消息不记录） | 语义清晰「真正开始的任务才算使用记录」；实现最简（无需新增 workspace.record push RPC，保持 D-004 pull-only）；「选了没用的目录」不污染最近列表。useNewTaskFlow 是延迟 create，首发消息才 create | `D-可逆` | `ask_user` | `mid-detail-plan` | `[from: issues.md #2 K-1]` | `confirmed` | |
| D-008 | INV-7 cwd 失效 UX：toast 提示 + homedir fallback（选中失效 cwd → toast「目录 X 已不存在，已切换到主目录」+ 静默 fallback homedir） | 平衡：用户知道发生什么（不困惑「目录为何变了」），不打断流程（继续选分支/发消息）。复用 session-lifecycle.restoreSession 现有 existsSync + homedir fallback 模式 | `D-可逆` | `ask_user` | `mid-detail-plan` | `[from: issues.md #6 K-2]` | `confirmed` | |
