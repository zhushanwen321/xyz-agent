# orchestrate 用例与流程

## UC-OR-01 简单编排（单层 Orchestrator + 多 Executor）

**触发**：Main Agent 调用 `orchestrate(task_description="重构认证模块", agent_type="orchestrator", directive="拆分并执行")`

**流程**：
1. orchestrate.call() 被 execute_batch 调用
2. 创建 OrchestrateNode（role=Orchestrator, depth=0）
3. 创建 Orchestrator Agent：
   - system_prompt = 编排专用 prompt（含 orchestrate + feedback 工具说明）
   - 工具集 = orchestrate + feedback + Read（只读观察）
   - BudgetGuard（独立预算）
4. 创建独立 event channel + 桥接
5. Orchestrator 的 AgentLoop::run_turn 启动
6. Orchestrator LLM 思考后调用 orchestrate(agent_type=executor, directive="分析现有代码")
   → 创建 Executor A（depth=1）
7. Orchestrator LLM 继续调用 orchestrate(agent_type=executor, directive="编写新逻辑")
   → 创建 Executor B（depth=1）
8. Executor A 完成 → orchestrate 工具返回结果给 Orchestrator
9. Executor B 完成 → orchestrate 工具返回结果给 Orchestrator
10. Orchestrator LLM 综合结果，生成总结
11. Orchestrator run_turn 结束 → 结果返回给 Main Agent

**设计决策**：
- [x] 等待机制：同步 + 异步混合。orchestrate(sync=true) 阻塞等待，orchestrate(sync=false) 立即返回。异步结果在 Orchestrator 下一次 LLM 调用时注入（同 dispatch_agent 的下一回合注入机制）
- [x] 并行 Executor：Orchestrator 先用 sync=false 创建多个 Executor，再在后续 LLM 轮次中通过注入机制收集结果
- [x] Orchestrator 可在一次 turn 内多次调用 orchestrate
- [x] 结果通过 tool_result 返回给 Orchestrator

---

## UC-OR-02 反馈循环

**触发**：Executor 在执行中遇到问题，需要向 Orchestrator 请求指导

**流程**：
1. Executor 执行任务时发现依赖缺失
2. Executor 调用 feedback(message="找不到 auth.rs 文件，请确认路径", severity="warning")
3. feedback 工具通过 event channel 发送 AgentEvent::TaskFeedback
4. feedback 工具返回 ToolResult（确认已发送），Executor **继续执行**（不暂停）
5. TaskFeedback 事件通过桥接传到 Orchestrator 的事件通道
6. **问题**：Orchestrator 正在阻塞等待 Executor 完成，如何处理这个反馈？

**设计决策**：
- [x] 分级反馈：severity=info 时 Executor 继续执行（纯通知）；severity=error 时 Executor 暂停，feedback 工具阻塞等待 Orchestrator 的响应作为 tool_result 返回
- [x] Orchestrator 调整方向：当 severity=error 的 feedback 到达时，Orchestrator 通过 feedback 工具的 tool_result 回传新指令
- [ ] 反馈频率限制：待定（建议每个 Executor 每分钟最多 5 次）

---

## UC-OR-03 Agent 复用

**触发**：Orchestrator 想将新任务交给已完成任务的空闲 Executor

**流程**：
1. Executor A 完成任务 1 → status 变为 idle
2. Orchestrator LLM 决定复用 Executor A 执行新任务
3. Orchestrator 调用 orchestrate(target_agent_id="A", directive="现在请执行...", agent_type=executor)
4. 系统检查 Agent A 是否空闲且存在
5. 将 directive 作为新 user message 追加到 Agent A 的 JSONL
6. 从 JSONL 重新构建 Agent A 的 api_messages（含完整历史）
7. 恢复 Agent A 的 AgentLoop（新建 run_turn，history 从 JSONL 加载）
8. Agent A 带着任务 1 的完整上下文执行新任务

**设计决策**：
- [x] 空闲判定：Executor 的 run_turn 结束后自动标记为 idle（非 completed）
- [x] 资源管理：JSONL 保留在磁盘，内存中只保留 OrchestrateNode 引用
- [x] 上下文窗口满时：自动 compact 后继续（复用 compact 已有逻辑）
- [x] 复用预算：从 0 开始新计数（每次复用分配新预算），之前 usage 保留在 OrchestrateNode 中记录
- [x] 空闲超时：10 分钟无复用后自动清理（status=completed，JSONL 保留）
- [x] 同一 Agent 不能被不同父节点复用（所有权归属于创建者）

---

## UC-OR-04 递归编排

**触发**：Orchestrator 在 depth=1 处调用 orchestrate 创建子 Orchestrator

**流程**：
1. Main Agent → Orchestrator A (depth=0)
2. Orchestrator A 调用 orchestrate(agent_type=orchestrator, directive="分析并拆分子任务")
3. 系统**检查深度**：当前 depth=0 + 1 = 1 < MAX_DEPTH(5) → 允许
4. 创建 Orchestrator B (depth=1)
5. Orchestrator B 调用 orchestrate(agent_type=executor, ...)
6. 创建 Executor C (depth=2)
7. Executor C **不能**调用 orchestrate（类型限制）
8. 结果逐层回传：C → B → A → Main Agent

**深度限制边界**：
9. 如果 Orchestrator 在 depth=4 调用 orchestrate(agent_type=orchestrator)
10. 系统检查：depth=4 + 1 = 5 = MAX_DEPTH → **自动降级**为 Executor

**设计决策**：
- [x] 深度存储在 OrchestrateNode.depth 字段，子节点 depth = 父 depth + 1
- [x] 深度限制行为：自动降级为 Executor（不报错，保证任务能继续）
- [x] 预算分配：Orchestrator 在 orchestrate 参数中显式指定子节点预算，不传时用模板默认值
- [ ] 深层 Orchestrator 的 system_prompt 是否需要调整？
- [ ] 深层工具集是否受限？

---

## UC-OR-05 异常处理

### 05a Executor 失败

**流程**：
1. Executor 遇到错误（工具执行失败 / LLM API 错误）
2. Executor AgentLoop 结束，status=failed
3. orchestrate 工具返回给 Orchestrator：包含错误信息
4. Orchestrator LLM 决定策略：
   - 重试：调用 orchestrate 创建新 Executor
   - 换路径：调整 directive 创建新 Executor
   - 跳过：标记此子任务为跳过，继续其他
   - 整体失败：Orchestrator 返回错误给上层

### 05b 用户终止编排树

**流程**：
1. 用户在树视图中点击终止根节点
2. 系统递归遍历子节点，发送终止信号
3. 所有运行中的 AgentLoop 在下一轮检查到 kill_requested → break
4. Orchestrator 的 run_turn 被中断
5. 部分结果沿树向上回传

### 05c 父节点预算耗尽

**流程**：
1. Orchestrator 的 BudgetGuard 检测到预算耗尽
2. Orchestrator 的 AgentLoop break
3. **问题**：子 Executor 是否同时终止？还是继续运行？

**设计决策**：
- [x] Executor 失败返回：orchestrate 工具返回 XML 格式的错误通知，包含错误消息和部分结果
- [x] 终止信号传播：级联终止。TaskTree.request_kill_tree(task_id) 递归设置所有子节点 kill_requested
- [x] 父预算耗尽时：子节点全部级联终止（因为父节点无法处理结果，继续浪费资源）
- [x] 部分结果：随终止信号一起回传，格式同正常的 XML 通知但标记 status=partial

---

## UC-OR-06 前端展示

### 树形视图

**数据来源**：AgentEvent 事件实时构建
- OrchestrateNodeCreated → 新增节点
- OrchestrateNodeProgress → 更新进度
- OrchestrateNodeCompleted → 标记完成
- TaskFeedback → 添加反馈消息

**展示内容**：
```
编排树
├─ [O] 重构认证模块     running   45.2K t  depth=0
│  ├─ [E] 分析现有代码  completed  8.2K t   depth=1
│  ├─ [O] 拆分子任务    running   12.1K t  depth=1
│  │  └─ [E] 编写单元测试  pending  0 t    depth=2
│  └─ [E] 编写新逻辑    idle      3.5K t   depth=1  ← 可复用
```
[O] = Orchestrator, [E] = Executor

**用户操作**：
- 点击节点 → 展开详情面板
- 右键/按钮 → 暂停/恢复/终止
- 查看反馈历史
- 查看子 Agent 对话

**未定义项**：
- [ ] 树视图的位置：独立面板？右侧？
- [ ] Agent 复用时的视觉表示
- [ ] 反馈消息的展示形式
- [ ] 节点详情面板的内容
