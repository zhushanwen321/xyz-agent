# dispatch_agent 用例与流程

## UC-DA-01 同步 Preset 模式

**触发**：Main Agent 调用 `dispatch_agent(mode="preset", subagent_type="Explore", prompt="...")`

**前置条件**：Main Agent 正在执行 turn

**流程**：
1. dispatch_agent.call() 被 execute_batch 调用，ctx=Some(ToolExecutionContext)
2. 查找 AgentTemplate("Explore") → 获取 tool_filter、system_prompt、default_budget
3. 从 ctx.tool_registry 过滤出子 Agent 可用的工具（排除 dispatch_agent）
4. 创建 TaskNode（status=running），写入 TaskTree
5. 发送 AgentEvent::TaskCreated 到主 event_tx
6. 创建独立 event channel (sub_tx, sub_rx)
7. 启动桥接 task：sub_rx → 过滤 TaskProgress/TaskCompleted/BudgetWarning → 转发到主 event_tx
8. 创建 PromptManager::new_with_prompt(template.system_prompt)
9. 创建 BudgetGuard(template.default_budget)
10. 创建子目录 {data_dir}/{session_id}/subagents/
11. 调用 AgentLoop::run_turn(prompt, [], None, sub_tx, filtered_registry, ..., Some(budget_guard))
12. 每轮迭代：
    - BudgetGuard.check() → Continue/Stop
    - BudgetGuard.should_warn_90() → 发送 BudgetWarning
    - 发送 TaskProgress（节流 ≤1次/2s）
13. run_turn 结束 → 收集 entries
14. SubAgent entries 写入 {data_dir}/{session_id}/subagents/{task_id}.jsonl
15. 截断结果到 ≤100K 字符，完整输出存 {data_dir}/tasks/output/{task_id}.txt
16. 更新 TaskNode（status=completed/failed/budget_exhausted, usage）
17. TaskNode 写入主 session JSONL（作为 TranscriptEntry 变体）
18. 发送 AgentEvent::TaskCompleted
19. 返回 ToolResult（XML 格式通知）

**异常分支**：
- E01 模板不存在 → 返回 ToolResult::Error
- E02 预算耗尽 → 步骤 12 检测到 Stop → 跳到步骤 13，使用部分结果
- E03 AgentLoop 内部错误 → status=failed，使用已有部分 entry
- E04 用户 kill → 步骤 12 检测 kill_requested → break，status=killed

**设计决策**：
- [x] SubAgent token usage 独立追踪在 TaskNode.usage，不累加到 Main Agent 的 TokenUsage
- [x] 部分结果同样截断到 100K 字符
- [x] TaskNode 的 uuid 使用 task_id，task_id 从 uuid 生成

---

## UC-DA-02 同步 Fork 模式

**触发**：Main Agent 调用 `dispatch_agent(mode="fork", prompt="...")`

**前置条件**：Main Agent 正在执行 turn，已有 api_messages 积累

**流程**：
1. 与 UC-DA-01 步骤 1-2 相同，但无模板查找
2. 从 ctx 获取 api_messages（原始 API JSON）和 current_assistant_content
3. 调用 build_fork_messages(api_messages, current_assistant_content, prompt)
4. Fork 预算 = min(父剩余预算, 100K)。主 Agent 无预算限制时用 100K
5. 创建 TaskNode（mode=fork）
6. 创建独立 channel + 桥接
7. PromptManager = 克隆父 Agent 的 PromptManager（byte-identical system prompt）
8. tool_schemas = 父 tool_schemas（byte-identical，但排除 dispatch_agent）
9. 调用 AgentLoop::run_turn(fork_messages 作为 history, ...)
10. 其余与 UC-DA-01 步骤 12-19 相同

**设计决策**：
- [x] api_messages 在 consume_stream 返回后立即保存为 run_turn 局部变量，execute_batch 调用前填入 ctx
- [x] current_assistant_content 同上
- [x] 父剩余预算：主 Agent 无 BudgetGuard 时默认用 100K
- [x] Fork SubAgent 继承父 Agent 的 PermissionContext

---

## UC-DA-03 异步模式

**触发**：Main Agent 调用 `dispatch_agent(sync=false, ...)`

**前置条件**：当前活跃 SubAgent 数 < max_concurrent_subagents

**流程**：
1. 与 UC-DA-01 步骤 1-10 相同
2. 但 dispatch_agent **不等待** run_turn 完成
3. 立即返回 ToolResult：
   ```xml
   <task_notification>
     <task_id>{id}</task_id>
     <status>pending</status>
     <message>Task started in background</message>
   </task_notification>
   ```
4. SubAgent 在后台 tokio task 中继续执行
5. JoinHandle 存入 AppState.background_tasks
6. 完成后：结果存文件，发送 TaskCompleted 事件

**下一回合注入**：
7. 用户发送新消息
8. 调用 history_to_api_messages 时，检查是否有已完成的异步任务
9. 按创建时间排序，每个任务注入 assistant + user 对：
   ```json
   [
     {"role": "assistant", "content": "[Background task completed: {description}]\n{result_summary}"},
     {"role": "user", "content": "[System: 以上是异步任务结果，请结合用户消息处理]"}
   ]
   ```
10. 最后是用户实际消息

**设计决策**：
- [x] 注入格式：独立 assistant + user 对，按创建时间排序
- [x] 异步任务失败时注入 `[FAILED] {description}: {error_message}`，同样用 assistant + user 对
- [x] 切换 session 时后台任务继续运行，前端停止接收 Progress；切换回来时 loadHistory 从 JSONL 重新加载，不遗漏
- [ ] session 被删除时后台任务怎么处理（需终止并清理）

---

## UC-DA-04 并发排队

**触发**：Main Agent 连续调用 dispatch_agent，超过并发限制

**流程**：
1. Main Agent 调用 dispatch_agent → 检查活跃 SubAgent 数
2. 如果 < max_concurrent → 正常执行（UC-DA-01/03）
3. 如果 >= max_concurrent → TaskNode 状态设为 pending，加入等待队列
4. 前端展示 pending 状态的节点
5. 某个活跃 SubAgent 完成 → 从队列取出最早的 pending 任务 → 开始执行

**设计决策**：
- [x] 并发队列为全局限制，所有 session 共享队列
- [x] 排队中的任务可被用户取消（status=killed）
- [x] 排队期间不消耗预算（预算在开始执行时才分配）
- [x] 同步模式下排队任务阻塞 Main Agent 的 turn，直到轮到执行并完成

---

## UC-DA-05 用户干预

**触发**：用户在前端点击暂停/恢复/终止按钮

**暂停流程**：
1. 前端调用 Tauri command pause_task(session_id, task_id)
2. 后端 TaskTree.request_pause(task_id) → status=paused
3. SubAgent AgentLoop 下一轮迭代检查 should_pause → 进入 sleep 循环

**恢复流程**：
1. 前端调用 resume_task
2. TaskTree.request_resume → status=running
3. sleep 循环退出，继续执行

**终止流程**：
1. 前端调用 kill_task
2. TaskTree.request_kill → kill_requested=true
3. AgentLoop 下一轮迭代 break → status=killed → 返回部分结果

**未定义项**：
- [ ] 异步模式下的终止：前端怎么知道有哪些异步任务可以终止？
- [ ] 暂停期间的 BudgetGuard 状态：duration_ms 是否继续累加？
