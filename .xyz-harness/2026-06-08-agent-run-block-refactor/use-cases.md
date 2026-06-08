---
verdict: pass
---

# Use Cases: AgentRunBlock

## UC-1: 用户查看 Agent 执行结果

- **Actor**: 开发者
- **Preconditions**: compactStreaming=true，Agent 已完成一次包含文件修改的任务
- **Main Flow**:
  1. 用户打开聊天界面，查看 assistant 消息
  2. 看到 write/edit 卡片，显示文件路径和修改量（如 `src/auth.ts +12/-31`）
  3. 看到最终文字结论（text block）
  4. 过程中的 thinking/read/grep 等折叠在 chip 条中，显示 `思考 ×3 · read ×5 · grep ×2`
  5. 用户点击 chip 条的"过程"标签，展开查看具体操作细节
  6. 用户再次点击，折叠回 chip 条
- **Alternative Paths**:
  - Agent 未修改文件 → 无 StandaloneToolCard，只有 MergeBlock + text
  - Agent 只修改了一个文件 → 一个 StandaloneToolCard
- **Postconditions**: 用户了解了哪些文件被修改、修改量、以及最终结论
- **Module Boundaries**: AgentRunBlock → message-layout.ts（分组） → MergeBlock/StandaloneToolCard（渲染）

## UC-2: 用户监控 Agent 执行过程

- **Actor**: 开发者
- **Preconditions**: compactStreaming=true，Agent 正在执行复杂任务
- **Main Flow**:
  1. 用户发送消息后，观察 assistant 消息区域
  2. 看到 MergeBlock 紧凑行显示 "思考中..." + 耗时
  3. Agent 切换到 read 操作，MergeBlock 更新为 "read src/auth.ts · 2.3s"
  4. Agent 执行 write，write 卡片从上方出现
  5. 新的 MergeBlock 出现，显示后续操作
  6. 耗时每秒实时更新
- **Alternative Paths**:
  - Agent 长时间 thinking → MergeBlock 持续显示 "思考中..." + 递增耗时
  - 多个 toolCall 并发 → 显示最新的 running toolCall
- **Postconditions**: 用户在不展开任何 block 的情况下了解了 Agent 当前进度
- **Module Boundaries**: MergeBlock (streaming) → useChat.ts（状态更新） → Timer（耗时）

## UC-3: 含 subagent 的任务执行

- **Actor**: 开发者
- **Preconditions**: compactStreaming=true，Agent 调用 subagent 执行子任务
- **Main Flow**:
  1. Agent 执行过程中调用 subagent 工具
  2. subagent 显示为独立 CustomToolBlock 卡片（工具名 + 任务描述）
  3. subagent 卡片显示状态：running → complete
  4. 用户点击展开查看子任务的执行结果
  5. Agent 继续执行后续操作
- **Alternative Paths**:
  - subagent 执行失败 → 卡片显示错误状态
  - 多个 subagent → 每个独立展示，不合并
- **Postconditions**: 用户清楚看到哪些子任务被执行及其结果
- **Module Boundaries**: StandaloneToolCard → isMergeBlock（自定义工具判断）

## UC-4: 用户配置独立展示工具

- **Actor**: 开发者
- **Preconditions**: 用户打开 Settings 页面
- **Main Flow**:
  1. 用户导航到"对话偏好"设置区域
  2. 看到"独立展示工具"多选列表，7 个 pi 内置工具
  3. 默认 write 和 edit 已选中
  4. 用户勾选 bash
  5. 返回聊天，发送新消息触发 Agent
  6. bash 操作现在显示为独立卡片而非折叠在 MergeBlock 中
- **Alternative Paths**:
  - 用户取消所有工具 → 所有内置工具折叠到 MergeBlock
  - 用户恢复默认 → 点击恢复 write + edit
- **Postconditions**: standaloneTools 配置持久化，影响后续所有消息渲染
- **Module Boundaries**: Settings UI → settings store → message-layout.ts（读取 standaloneTools）

## 覆盖映射

| UC | 覆盖 AC |
|----|---------|
| UC-1 | AC-1, AC-2, AC-3 |
| UC-2 | AC-4, AC-1 |
| UC-3 | AC-2, AC-3 |
| UC-4 | AC-5, AC-8 |
| （主题/兼容由测试覆盖） | AC-6, AC-7 |
