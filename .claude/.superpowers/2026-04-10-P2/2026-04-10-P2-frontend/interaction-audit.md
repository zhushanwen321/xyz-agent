# P2-前端交互遗漏审计

> **状态**：8 个 BLOCKER 已全部通过 mockup 确认解决。以下 ISSUE 待实现时处理。

## 场景 A：同步 dispatch_agent 执行观察

**用户路径**：发消息 → 看 Agent 调用 dispatch_agent → 观察 SubAgent 执行 → 查看结果

### 已覆盖
- ToolCallCard 基础渲染（running/completed/error）
- 预算进度条

### 遗漏
- **A1 [BLOCKER]** ToolCallCard 内 dispatch_agent 的特殊渲染细节未定义
  - 运行中状态：显示什么？模板名 + description + 进度条 + token 数？
  - 当前 ToolCallCard 只有 `running...` 文字和 spinner，没有进度条 slot
  - 需要扩展 ToolCallCard 或新建 DispatchAgentCard

- **A2 [ISSUE]** SubAgent 执行期间，用户能否展开查看 SubAgent 的工具调用？
  - 当前 spec 说"SubAgent 的 TextDelta 不推送到前端"
  - 但 ToolCallStart/ToolCallEnd 也被丢弃了 → 用户完全看不到 SubAgent 在做什么
  - 是否需要在 ToolCallCard 中显示 SubAgent 的工具调用摘要？（如 "Read 3 files, ran 2 commands"）

- **A3 [ISSUE]** BudgetWarning 事件到达时，ToolCallCard 的视觉反馈
  - 卡片闪烁？边框变黄？进度条变色？
  - spec 说 BudgetWarning 只发一次，前端需要确保这次警告被看见

---

## 场景 B：异步 dispatch_agent 执行观察

**用户路径**：发消息 → Agent 异步分发 → 继续工作 → 结果注入

### 遗漏
- **B1 [BLOCKER]** 异步 ToolCallCard 的视觉状态
  - sync=false 时 ToolCallCard 应该显示什么？
  - "Background" 标签？不同的 spinner 颜色？
  - SubAgent 完成后卡片怎么更新？（ToolCallEnd 不会触发，因为没有 bridge 转发）

- **B2 [BLOCKER]** 异步结果注入到消息流中的展示形式
  - spec 定义了 API 层面的注入格式（assistant + user 对）
  - 但前端怎么渲染这两条注入的消息？
  - 用普通 MessageBubble？还是特殊的系统消息样式？
  - 用户需要能区分"Agent 主动回复"和"异步结果注入"
  - 建议方案：特殊的 `system` 消息样式，带 [Async Result] 标签

- **B3 [ISSUE]** 用户打字时异步任务完成
  - 结果是在下次发消息时才注入（下一回合注入）
  - 但用户可能不知道任务已完成
  - 是否需要 toast 通知？"任务 X 已完成，将在下次消息中显示结果"

---

## 场景 C：orchestrate 树形视图

**用户路径**：复杂任务 → 树形面板出现 → 观察树动态生长 → 操作节点

### 遗漏
- **C1 [BLOCKER]** 树形面板的触发和关闭
  - 何时出现？Main Agent 第一次调用 orchestrate 时自动展开？
  - 何时关闭？所有任务完成后自动折叠？
  - 手动开关按钮在哪里？

- **C2 [BLOCKER]** 树形面板的位置
  - spec 说"独立树形面板"但没定义位置
  - 选项：右侧面板（与 SubAgentSidebar 共存？）、底部面板、浮动面板
  - 与消息流的空间关系？

- **C3 [ISSUE]** 深层树的展示
  - 5 层深度时，树形缩进占用大量水平空间
  - 需要可折叠子树？虚拟滚动？
  - 根节点可能同时有多个子节点 running，如何视觉高亮？

- **C4 [ISSUE]** 树节点的新增动画
  - 节点出现时是否需要动画（如展开、淡入）？
  - 节点状态变化时（pending → running）的过渡效果？

- **C5 [ISSUE]** 树完成后（所有节点 completed）的行为
  - 树是否自动折叠？保留但标记为完成？
  - 用户能否回顾历史编排树？

---

## 场景 D：用户干预操作

**用户路径**：看到 running 任务 → 点击暂停/终止

### 遗漏
- **D1 [BLOCKER]** 操作按钮的位置
  - dispatch_agent：在 ToolCallCard 上？在 Sidebar 详情中？还是两处都有？
  - orchestrate：在树节点上 hover 出现？在详情面板中？右键菜单？

- **D2 [ISSUE]** 终止的确认对话框
  - 终止是不可逆操作，是否需要确认？
  - 终止编排树时："这会终止所有 N 个子任务，确定？"

- **D3 [ISSUE]** 暂停状态的视觉
  - 暂停的任务卡片/节点怎么区分？
  - 建议方案：进度条暂停动画、边框变黄、显示 ⏸ 图标

- **D4 [ISSUE]** 全局操作
  - "终止所有任务" 按钮？
  - StatusBar 上的活跃任务数是否可点击（点击跳转到任务列表）？

---

## 场景 E：并发 dispatch_agent

**用户路径**：Agent 连续调用 3 次 dispatch_agent，并发限制 2

### 遗漏
- **E1 [ISSUE]** 多个 ToolCallCard 的堆叠
  - 同一条 assistant 消息中多个 dispatch_agent 卡片如何排列？
  - 当前 segments 数组是有序的，但视觉上需要区分

- **E2 [ISSUE]** 排队中任务（pending）在 ToolCallCard 中的展示
  - pending 状态的卡片：灰色？进度条显示"waiting..."？
  - 从 pending 变为 running 时是否有过渡效果？

---

## 场景 F：Agent 复用的视觉表示

**用户路径**：Executor 完成 → idle → 被复用 → 再次执行

### 遗漏
- **F1 [BLOCKER]** idle 状态的视觉
  - 与 completed 的区别：completed 用 ✓ 绿色，idle 用 ⏳ 蓝色？
  - idle 节点是否有"可复用"的视觉提示（如虚线边框）？

- **F2 [ISSUE]** 复用时的节点变化
  - Orchestrator 复用 Executor A 时，A 的树节点是否变化？
  - 是否在 A 下面追加一个新的子条目表示"第 2 次任务"？
  - reuse_count 如何展示？(2x) 标签？

- **F3 [ISSUE]** 复用后上下文的可视化
  - 用户能否看到"A 带着之前 8.2K token 的上下文继续"？
  - 详情面板中是否展示累积 usage（之前 + 当前）？

---

## 场景 G：反馈消息展示

**用户路径**：Executor 发送 feedback → 用户看到

### 遗漏
- **G1 [BLOCKER]** feedback 在 dispatch_agent 场景下的展示
  - spec 说 feedback 存入 JSONL 并在 TaskDetail 中展示
  - 但 ToolCallCard 中是否显示 feedback 摘要？
  - 例如卡片底部出现 "3 messages" 徽章

- **G2 [BLOCKER]** feedback 在 orchestrate 场景下的展示
  - 树节点上如何展示 feedback？
  - 选项：节点右侧徽章（"3 feedbacks"）、展开节点显示 feedback 列表、点击查看
  - severity=error 的 feedback 是否需要醒目的视觉（红色闪烁）？

- **G3 [ISSUE]** feedback 方向的视觉区分
  - ChildToParent（子→父）和 ParentToChild（父→子）方向不同
  - 是否需要不同颜色/图标区分？

---

## 场景 H：错误和异常状态

### 遗漏
- **H1 [ISSUE]** BudgetExhausted 视觉
  - 与 Failed 的区别？用 ⚡ 图标？
  - 颜色：accent-yellow 而非 accent-red？

- **H2 [ISSUE]** 部分结果的展示
  - 任务被 kill 或 budget_exhausted 后有部分结果
  - ToolCallCard / 树节点详情中如何显示"不完整"的结果？
  - 标记为 "[Partial]" + 截断的输出？

- **H3 [ISSUE]** 级联终止时的视觉反馈
  - orchestrate 中用户终止根节点
  - 子节点逐一变为 killed，是否有级联动画效果？

---

## 场景 I：Session 切换

### 遗漏
- **I1 [ISSUE]** 切换回来时的"已完成"通知
  - 用户切走时有 2 个 running 任务，切回来时都完成了
  - 是否有视觉提示："2 tasks completed while you were away"

- **I2 [ISSUE]** 异步任务完成通知
  - 用户在 session B 时，session A 的异步任务完成
  - 是否需要跨 session 的通知？还是只在切回来时显示？

---

## 场景 J：Sidebar 集成

### 遗漏
- **J1 [BLOCKER]** SubAgentSidebar 和 TaskTreeView 的空间关系
  - 两者都在右侧？
  - 是否合并为一个面板，用 tab 切换（SubAgents | Orchestrate）？
  - 还是各自独立？

- **J2 [ISSUE]** Sidebar 的宽度
  - 固定宽度？可拖拽调整？
  - 折叠时是否只显示图标？

---

## 严重程度汇总

### BLOCKER（7 个，必须在 spec 中定义）
1. A1 - ToolCallCard dispatch_agent 特殊渲染
2. B1 - 异步 ToolCallCard 视觉状态
3. B2 - 异步结果注入的展示形式
4. C1 - 树形面板触发/关闭
5. C2 - 树形面板位置
6. D1 - 操作按钮位置
7. G1/G2 - feedback 展示位置和形式
8. J1 - Sidebar 和 TreeView 空间关系

### ISSUE（14 个，影响 UX 质量）
- A2, A3, B3, C3, C4, C5, D2, D3, D4, E1, E2, F2, F3, H1-H3, I1, I2, J2
