---
round: 1
frame: modeling
perspectives: [1, 2]
converged: false
---

# 架构追踪 · Round 1 · 建模帧（视角 1 模型完整性 + 视角 2 状态正交性）

> 独立 fresh-context 追踪。仅扫本组 2 视角。证据栏给出 file（函数/行）。
> 对疑似多余边界/模型已跑证伪三连（删/翻/挪）。

## 视角 1 模型完整性

### G-1（F + D）Session 被标注为「aggregate（已有复用）」与代码现状不符；不变式「cwd 绑定后不变」被 restore 路径打破

**问题**：
- §4 模型表把 Session 标为 `aggregate`，不变式「cwd 绑定后不变（要改=换目录=新建 chip 切换，非 mutate）」。但代码里**没有 Session 领域 aggregate 类**：`ManagedSession`（session-service.ts）是个**技术封装**——把 cwd/label/modelId 与 `adapter`/`interceptor`/`unsubUsageListener` 句柄打包，无任何不变式守卫方法，字段被裸 mutate（`renameSession` 直接 `session.label = newName`）。
- 不变式「cwd 绑定后不变」**不成立**：`restoreSession` 在持久化 cwd 不存在时会把 cwd 改写成 `homedir()` 并 `patchSessionCwd`（session-lifecycle.ts `restoreSession` 的 `existsSync(target.cwd)` 分支）。这是对「cwd 不变」的合法破坏，但与架构声称的不变式冲突。
- **「装着行为的对象」反模式命中**：`ManagedSession` 持有 adapter/interceptor/listener（运行期行为句柄），不是领域对象，却被文档当成领域 aggregate 复用。

**证伪三连**：删「aggregate 标注」→ 复杂度塌缩（Session 退化为「带 cwd 的技术记录」，D-3 的「复用现有 active/idle」依然成立，不需要 aggregate 语义）→ 标注多余。建议改为「技术实体（复用，非领域 aggregate）」，并把 cwd 不变式限定到「new-task-flow 正常路径」。

**证据**：
- `src-electron/runtime/src/services/session/session-service.ts` `ManagedSession` interface + `toSummary()`（status 由 isGenerating 派生，无守卫）
- `src-electron/runtime/src/services/session/session-lifecycle.ts` `renameSession`（裸 mutate label）、`restoreSession`（cwd → homedir 回退）
- system-architecture.md §4 模型表 Session 行

**类型**：F（aggregate 标注与代码事实不符）+ D（不变式该限定到哪条路径 / 是否补守卫方法）

---

### G-2（D）「默认 cwd 解析」与「最近 workspace 列表」两个概念被混用，未分别建模

**问题**：
- requirements G1.1 / UC-2 定义默认新 session 的 cwd = **「最近活跃 session 的 cwd」**——这是从 session 列表按 `lastActiveAt` 派生的单值，**不需要新缓存**。
- 但 §4 只建模了 `RecentWorkspace`（DTO，LRU 10，喂 directory popover 列表），§9 swimlane 写 `create(recentCwd, undefined)` 用了一个未定义来源的 `recentCwd`。
- 两者数据源不同、生命周期不同：
  - 默认 cwd：session 派生（session 销毁即失效）
  - RecentWorkspace 列表：独立 LRU 缓存（跨 session 生命周期持久）
- 若 `recentCwd` 取自 `RecentWorkspaceCache[0]`，则与 G1.1「最近活跃 session」语义偏离（用户可能活跃了一个旧 session 但没动过 picker 列表）；若取自 session 派生，则 swimlane 命名误导且 RecentWorkspaceCache 仅服务 popover。

**证伪三连（挪）**：边界能滑动——把「默认 cwd」并入 RecentWorkspaceCache（取 [0]）或独立成 `resolveDefaultCwd(sessions)` 派生函数，两版都说得通 → 说明文档未把不对称钉死，需决策。

**证据**：
- requirements.md §1 G1.1、UC-2（默认 cwd = 最近活跃 session 的 cwd）
- system-architecture.md §4 RecentWorkspace DTO、§9 swimlane `create(recentCwd, undefined)`、§7 RecentWorkspaceCache 模块（职责仅写「LRU 缓存…本地持久化」，未提默认 cwd 解析）

**类型**：D（默认 cwd 解析是 session 派生还是 RecentWorkspaceCache 首项？需明确数据源与命名）

---

## 视角 2 状态正交性

### G-3（D）`landing → completed` 把「发送尝试 / 成功 / 失败」折叠成一跳；发送中/失败态未建模，直接压迫「不引入 Reason」决策的成立前提

**问题**：
- §5 转换表只有 `landing --> completed: 发送首条消息`，把「用户按发送」「发送成功进对话流」「发送失败」三种结果压成一条边。
- requirements 明确存在发送失败路径：UC-2 异常「发送时网络断/pi 无响应 → composer 显示发送失败提示，允许重试」、UC-1 异常「session 创建失败 → composer 显示错误提示…不进入对话流」。这些都需要在 `landing` 与 `completed` 之间有表达。
- 文档对此沉默。两种合理处理都没写明：
  - (a) 发送中/失败折叠为 `landing` 内的 composer 子态（flow 状态不变）→ 则转换语义应表述为「**发送成功**才 → completed，失败留 landing」，且「不引入 Reason」决策成立（失败不产新终态）。
  - (b) 发送中/失败是独立 flow 态（如 `sending`/`send_failed`）→ 当前 8 态机漏态。
- 「不引入 Reason」的辩护（「失败在各 overlay 内处理，不改流程状态」）**只对 overlay 内失败成立**（branch-modal 创建失败、git 读失败），对**主流程发送失败**未覆盖。G-3 正是该辩护的盲区。

**证据**：
- requirements.md UC-1 异常流程、UC-2 异常流程（发送/创建失败处理）
- system-architecture.md §5 NewTaskFlowState 转换表 `landing --> completed`、Reason 字段辩护段

**类型**：D（发送中/失败折叠为 composer 子态，还是独立 flow 态？决定了 8 态机是否完备 + 不引入 Reason 是否站得住）

---

### G-4（K）`cancelled` 终态「空 session 视策略保留或清理」未定义重入路径；若保留，cancelled 可逆，与「终态不可逆」自相矛盾

**问题**：
- §5 声明 `cancelled`（用户切到别的 session）是终态、不可逆。但同段又写「空 session 视策略保留或清理」。
- 若空 session 被保留，用户在 sidebar 重新点回该空 session，NewTaskFlow 是否复活（`cancelled → landing`）？
  - 若复活 → `cancelled` 非真终态，「终态不可逆」被打破，状态机需补 `cancelled → landing` 转换。
  - 若不复活（保留的空 session 进了对话流之外的孤儿态）→ 需定义该孤儿态如何被清理或重新触发新建。
- 当前两种语义都没写，「视策略」是未决空洞。

**证据**：
- system-architecture.md §5 cancelled 描述（「空 session 视策略保留或清理」）、终态集合声明

**类型**：K（保留的空 session 是否可重入 NewTaskFlow？需问用户/产品定策略）

---

### G-5（F）D-3「落地空态判据 = messageCount === 0 && !isGenerating」声称派生，但派生数据源（chat store messages）未在文档登记，且 SessionSummary 不携带 messageCount

**问题**：
- D-3 决策本身（status 正交、不引入 empty）**成立**——`SessionStatus(active|idle)` 描述「pi 是否生成」，与「有无消息」正交，派生判据方向正确。
- 但「派生」的数据源文档未交代：`SessionSummary`（shared/src/session.ts）字段为 id/label/cwd/gitBranch/gitIsWorktree/status/lastActiveAt/modelId/thinkingLevel/tokenCount，**无 messageCount**。
- 实际派生源是前端 `chat` store 的 `messages: Map<sessionId, Message[]>`（getHistory 按需加载后才填充）。即：
  - 新建空 session：messages 未加载 → 判据需约定「未加载视为空」
  - 重选历史空 session：需先 getHistory 才能判空，存在加载窗口
- 文档把 messageCount 当作现成可派生量，未登记源、未提加载时机，下游实现易踩坑（如把判据错挂在 SessionSummary 上）。

**证据**：
- `src-electron/shared/src/session.ts` `SessionSummary`（无 messageCount 字段）
- `src-electron/renderer/src/stores/chat.ts` `messages: Map<sessionId, Message[]>`（按 sessionId 分区，按需加载）
- system-architecture.md §5 D-3 + 落地空态判据公式

**类型**：F（messageCount 派生源是 chat store 而非 SessionSummary；文档未登记）→ 补一句即可闭合，非阻塞，但属事实需二次确认。

---

## 收敛判定

**未收敛**（5 个新 gap：G-1..G-5）。其中：
- G-1 / G-5 为 F（事实核对型，补文档/限定语义即可闭合）
- G-2 / G-3 为 D（需 agent/用户决策数据源与状态归属）
- G-4 为 K（需问用户：空 session 保留策略）

**与另两组的潜在交叉**：
- G-1（Session aggregate 误标 / ManagedSession 是技术封装）可能被**结构帧**视角 4（上帝对象/扁平 struct 打包不同生命周期字段）命中 → 候选 `[CROSS-VALIDATED]` 点。ManagedSession 把领域字段（cwd/label）与运行期句柄（adapter/interceptor/listener）打包在同一 struct，正是「扁平 struct 打包不同生命周期字段」反模式。
- G-2（recentCwd 概念散落）可能被**演进帧**视角 5（命名不符责 / 一个模块多个变化轴）侧面命中。
