# Claude Code 架构分析 — xyz-agent 参考文档

> 来源：Claude Code v2.1.88 源代码逆向分析（2026-04-10）
> 目的：提炼对 xyz-agent P5/P6 阶段有参考价值的架构模式

---

## 1. Agent Loop 架构

### 1.1 核心循环：极简 + 生产级包装

Claude Code 的 Agent Loop 本质是一个 `while(true)` 循环，但被包裹在多层生产级编排中：

```
用户输入 → processUserInput() → fetchSystemPromptParts()
  → recordTranscript() → normalizeMessagesForAPI()
  → Claude API (streaming)
  → stop_reason == "tool_use" ?
     → 是: StreamingToolExecutor → tool_result → 继续循环
     → 否: 返回文本给用户
```

**状态机模型**：每次循环迭代通过**整体替换 state 对象**实现状态转换（`state = next`），而非部分更新。State 包含 messages、toolUseContext、turnCount、maxOutputTokensRecoveryCount、transition.reason 等字段。

**关键设计**：
- **AsyncGenerator 模式**：整个 `query()` 函数是 `async function*`，通过 `yield` 流式产出消息，支持惰性求值和可控终止
- **Withholding 机制**：可恢复的错误（413、max_output_tokens）被"扣留"不 yield 给消费者，先尝试内部恢复
- **transition.reason**：每次状态转换携带原因（`next_turn`、`collapse_drain_retry`、`reactive_compact_retry`、`max_output_tokens_escalate` 等），用于控制重试逻辑

### 1.2 对 xyz-agent 的启示

| 模式 | xyz-agent 现状 | 建议 |
|------|---------------|------|
| AsyncGenerator | `run_turn()` 返回 `Vec<AgentEvent>` | 考虑改为 `impl Stream<Item = AgentEvent>` 流式产出，避免等整轮完成才返回 |
| 状态整体替换 | 已有 `state` 更新模式 | ✅ 已对齐 |
| Withholding | 无 | 可在 BudgetGuard 层引入错误扣留 + 自动恢复 |
| transition.reason | 无显式追踪 | 可在 AgentLoop 的 turn 状态中增加 reason 字段，便于调试和重试控制 |

---

## 2. 工具系统

### 2.1 工具接口：自描述的能力单元

Claude Code 的 Tool 接口有 50+ 方法，分为 8 个类别：

| 类别 | 方法 | 用途 |
|------|------|------|
| **核心** | `call()`, `description()`, `prompt()`, `inputSchema` | 执行和提示词 |
| **权限** | `checkPermissions()`, `validateInput()`, `isReadOnly()`, `isDestructive()` | 安全控制 |
| **并发** | `isConcurrencySafe()` | 并发执行控制 |
| **UI** | `renderToolUseMessage()`, `renderToolResultMessage()` | 界面渲染 |
| **权限优化** | `preparePermissionMatcher()` | Hook 匹配加速 |
| **输入处理** | `backfillObservableInput()` | 路径标准化 |
| **分类** | `toAutoClassifierInput()` | 安全分类 |
| **延迟加载** | `shouldDefer`, `alwaysLoad` | ToolSearch 集成 |

**buildTool 工厂函数**：提供 Fail-Closed 默认值（`isConcurrencySafe=false`, `isReadOnly=false`），新工具只需覆盖差异化逻辑。

### 2.2 并发执行模型

**StreamingToolExecutor** 是核心执行引擎：

```
规则：
1. 无工具在执行 → 任何工具可开始
2. 当前执行的都是并发安全工具 → 新的并发安全工具可加入
3. 有非并发安全工具在执行 → 等待

分区策略 (partitionToolCalls):
  连续的并发安全工具 → 合并为一个 batch 并行执行
  非并发安全工具 → 独立 batch 串行执行

并发度上限: 默认 10
```

**错误级联**：Bash 工具错误触发 `siblingAbortController.abort()`，取消所有兄弟工具。其他工具（Read/Grep/WebFetch）失败不影响其他。

### 2.3 权限检查：5 层防线

```
1. validateInput — 工具级输入验证（Zod schema）
2. checkPermissions — 工具级权限检查
3. PreToolUse Hooks — 自定义脚本
4. 权限模式检查 — yolo/auto/default
5. 分类器 + UI 对话框 — ML 模型判断 + 用户决策
```

### 2.4 对 xyz-agent 的启示

| 模式 | xyz-agent 现状 | 建议 |
|------|---------------|------|
| Fail-Closed 默认值 | `is_concurrency_safe()` 默认 false | ✅ 已对齐 |
| 流式工具执行 | `execute_batch()` 等待全部完成 | **高价值改进**：改为流式，先完成的工具结果先返回 |
| Bash 错误级联 | 无 | 可引入 BashTool 失败时取消同批其他工具 |
| 工具自描述 | Tool trait 已有 `description()`, `call()` | 可考虑增加 `is_destructive()`, `to_classifier_input()` 等 |
| `backfillObservableInput` | 无 | 对于权限匹配（白名单/黑名单）中的路径标准化有用 |
| `preparePermissionMatcher` | 无 | 在 Hook 数量增多时可能需要预编译匹配器 |
| 结果持久化 | `maxResultSizeChars` 阈值 + 磁盘 | xyz-agent 的 ToolResult 目前都在内存，大文件读取可能导致内存问题 |
| **sed 模拟编辑** | 无 | BashTool 中 `sed -i` 被拦截 → 模拟为 diff 预览 → 用户确认 → 内部写入。精妙的安全设计 |

---

## 3. 子代理系统 ⭐（P5/P6 关键参考）

### 3.1 三层调度机制

Claude Code 的 AgentTool 实现了三层调度：

```
AgentTool.call()
  ├─ 有 teammate 参数? → Teammate spawn (InProcessTeammateTask, 同进程, 交互式)
  ├─ isolation == remote? → RemoteAgentTask (CCR 远程环境)
  ├─ isolation == worktree? → 创建临时 git worktree, 在隔离目录执行
  └─ 默认:
      ├─ subagent_type 未设置 & Fork 实验开启 → Fork path (继承完整上下文)
      ├─ subagent_type 已设置 → Named agent (查找 AgentDefinition → runAgent())
      └─ 默认 → general-purpose agent
```

### 3.2 状态隔离：createSubagentContext()

这是整个子代理系统最关键的函数。隔离策略：

| 资源 | 隔离策略 | 原因 |
|------|---------|------|
| `readFileState` | 克隆（`cloneFileStateCache`） | 防止子 Agent 污染主会话的文件缓存 |
| `setAppState` | **默认 no-op** | 防止子 Agent 修改全局状态；交互式子级可共享 |
| `setAppStateForTasks` | **始终指向 root** | 确保后台 bash 任务能被注册和清理（防止僵尸进程） |
| `contentReplacementState` | 克隆 | 保持相同的替换决策，cache hit 的关键 |
| `abortController` | 默认创建子级（父级 abort 传播到子级，子级 abort 不影响父级） | 安全取消 |
| `agentId` | 每个子级独立 ID | 进度追踪 |
| `queryTracking.depth` | 父级 depth + 1 | 控制嵌套深度 |

### 3.3 Fork 机制：Prompt Cache 共享

Fork 是 Claude Code 最精妙的设计，解决"如何让子 Agent 共享父级的 prompt cache"：

**CacheSafeParams**（5 个缓存键必须完全匹配）：
1. system prompt
2. tools 定义
3. model
4. messages prefix
5. thinking config

**Fork 消息构建**：
```
父级请求: [system][tools][msg1][msg2]...[msgN]                    → 缓存写入
Fork 子级: [system][tools][msg1][msg2]...[msgN][fork_directive]    → 缓存命中!
```

所有 fork 子级收到相同的 `tool_result` 占位符，只有最后的 `directive` 文本块不同。

**防递归**：通过 `FORK_BOILERPLATE_TAG` 检测 + `querySource` 检测双层防护。

### 3.4 Agent 类型体系

6 种内置 Agent，每种有明确的工具集策略和权限模式：

| Agent | 工具集 | 特殊设计 |
|-------|--------|---------|
| general-purpose | 全量 `tools: ['*']` | 默认全能 |
| Explore | 排除写操作+Agent+ExitPlanMode, `omitClaudeMd: true` | 用廉价模型（haiku）快速探索 |
| Plan | 同 Explore，禁止所有写操作 | 架构设计，确保不改文件 |
| verification | 排除写操作+Agent, `background: true` | 对抗性验证 prompt |
| claude-code-guide | 只读工具 + WebFetch/Search | 回答使用问题 |
| statusline-setup | Read + Edit | 配置状态栏 |

**关键洞察**：Explore/Plan 禁止 Agent 工具 → 防止产生子 Agent（避免无限嵌套）。`omitClaudeMd` 省略不相关的项目配置，节省 ~5-15 Gtok/周。

### 3.5 Task 系统

7 种任务类型（`local_bash/local_agent/remote_agent/in_process_teammate/local_workflow/monitor_mcp/dream`），统一管理框架：

- Task ID: 类型前缀 + 8 字符 base36（36^8 ≈ 2.8 万亿，抵抗符号链接暴力攻击）
- 状态机: pending → running → completed/failed/killed
- 终端状态触发: 从 AppState 驱逐 + 清理磁盘 + 通知父 Agent
- 前台/后台切换: Agent 超过阈值（默认 2 分钟）自动后台化
- 进度追踪: `ProgressTracker` 追踪 token 数和最近 5 条活动

### 3.6 对 xyz-agent P5/P6 的启示

| 模式 | xyz-agent 现状 | P5/P6 建议 |
|------|---------------|------------|
| **三层调度** | `DispatchAgent` + `Orchestrate` 双模式 | 可参考: 简单任务 → DispatchAgent(fork 模式), 复杂任务 → Orchestrate(编排模式), 远程任务 → RemoteAgent |
| **状态隔离** | `ToolExecutionContext` 有基本隔离 | **需要增强**: (1) 子 Agent 的文件缓存独立, (2) `set_app_state` 默认 no-op, (3) 后台任务的 bash 注册始终可达 root |
| **Fork + Cache 共享** | 无（每次子 Agent 调用都是全新 API 请求） | **高价值优化**: 如果 xyz-agent 接入支持 prompt caching 的 provider，fork 机制可大幅降低子 Agent 成本 |
| **Agent 类型体系** | 有 `AgentTemplate`（Explore/Plan/general-purpose） | ✅ 已部分对齐；可考虑增加 `verification` 和 `claude-code-guide` 类型 |
| **防止 Agent 嵌套** | 有最大深度 5 | 可增加: Explore/Plan 类型的 Agent 禁止再 spawn 子 Agent |
| **Task ID 安全** | 无特殊设计 | Task ID 应有足够熵（防暴力攻击），且带类型前缀（可观测性） |
| **前台/后台切换** | 无 | 可考虑: Agent 执行超过阈值自动后台化，前端通过事件流追踪进度 |
| **磁盘输出安全** | 无 | `O_NOFOLLOW` 防符号链接攻击，输出文件大小限制（5GB） |
| **递归 Fork 防护** | 无 fork 机制 | 如果实现 fork，必须有双层防护：querySource 检测 + 消息扫描 |

---

## 4. 上下文管理

### 4.1 五层渐进式压缩

| 层级 | 机制 | 触发方式 | 成本 | 信息损失 |
|------|------|---------|------|---------|
| 0 | History Snip | 自动 | 零（裁剪旧消息） | 最小 |
| 1 | Microcompact | 自动/时间 | 零（清除过期 tool results） | 中等 |
| 2 | Context Collapse | 自动 | 低（归档可恢复） | 可恢复 |
| 3 | AutoCompact | 阈值 | 高（API 调用生成摘要） | 大 |
| 4 | Reactive Compact | API 413 错误 | 高（API 调用） | 大 |

**设计哲学**：99% 的情况通过轻量层解决，只有 1% 需要完整摘要。

### 4.2 关键参数

```
AUTOCOMPACT_BUFFER_TOKENS = 13,000      // 压缩触发缓冲
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3 // 熔断器
WARNING_THRESHOLD_BUFFER = 20,000       // 警告阈值
有效阈值 = contextWindow - 13,000
  200K 窗口 → 阈值 ~187K (93.5%)
  128K 窗口 → 阈值 ~115K (89.8%)
```

### 4.3 Cached Microcompact（最精妙的一层）

传统 microcompact 修改消息内容 → prompt 前缀变化 → 缓存 98% miss。

Claude Code 的方案：使用 API 层的 `cache_edits` 机制，**不修改本地消息内容**，只在 API 请求中注入删除指令。缓存命中率从 2% → 98%。

### 4.4 Post-Compact 恢复

压缩后主动重新注入关键状态，解决"失忆"问题：

| 恢复项 | 预算 | 设计 |
|--------|------|------|
| 最近读取的文件 | 50K tokens, 最多 5 个, 每个 5K | 按时间排序，去重（已在保留消息中的跳过） |
| 已调用技能 | 25K tokens, 每技能 5K 截断 | 按调用时间排序，头部优先 |
| Plan 文件 | 无限制 | 引用注入 |
| 工具/Agent/MCP | 增量通告 | 只通告变化部分（delta） |

### 4.5 对 xyz-agent 的启示

| 模式 | xyz-agent 现状 | 建议 |
|------|---------------|------|
| **多层压缩** | 有 `trim` + `LLM 摘要` + `熔断` | ✅ 基本对齐；可增加 Microcompact 层（清除过期 tool results） |
| **熔断器** | 有 | ✅ 已对齐（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` = 3） |
| **Reactive Compact** | 无 | 可增加: 413 错误后的被动恢复链路 |
| **Post-Compact 恢复** | 无 | **重要缺失**: 压缩后应重新注入最近文件 + 技能 + 当前任务状态 |
| **Cached Microcompact** | 无 | 需要 API provider 支持缓存编辑；可先实现简单的 time-based tool result 清除 |
| **系统提示词分节缓存** | 无 | 可在 `PromptManager` 中引入分节缓存，`/compact` 时重置 |

---

## 5. 记忆/技能系统

### 5.1 四种记忆子系统

| 系统 | 触发时机 | 解决的问题 |
|------|---------|-----------|
| extractMemories | 对话结束（fire-and-forget） | **跨会话失忆**: 提取用户偏好/项目决策 → 写入 `memory/` 目录 |
| SessionMemory | 周期性后台更新（post-sampling hook） | **会话内失忆**: 维护当前状态/任务/错误 → 压缩时作为摘要 |
| autoDream | 24h + 5 个新会话后 | **记忆腐败**: 审查多个会话 → 清理过时/矛盾记忆 |
| teamMemorySync | 文件监听触发 | **团队失忆**: HTTP API 同步团队记忆，含密钥扫描 |

### 5.2 记忆存储结构

```
~/.claude/projects/<sanitized-git-root>/memory/
  ├── MEMORY.md              # 索引文件（≤200行, ≤25KB）
  ├── user_role.md           # 用户偏好
  ├── feedback_testing.md    # 反馈记忆
  ├── project_decisions.md   # 项目决策
  ├── .consolidate-lock      # autoDream 锁（mtime = lastConsolidatedAt）
  └── team/                  # 团队记忆子目录
```

**分离索引和内容**：索引快速扫描可用记忆，`findRelevantMemories` 用 Sonnet 小模型选择最相关的 5 个文件按需读取。

### 5.3 Forked Agent 用于记忆操作

所有记忆操作都使用 `runForkedAgent()`：
- 完美复制主对话的 prompt cache（5 个缓存键完全匹配）
- 独立的 tool 权限控制（白名单只读工具 + 记忆目录内写操作）
- 不干扰主对话流（`skipTranscript: true`）
- 主 Agent 已写入记忆 → forked extraction 跳过（互斥 `hasMemoryWritesSince`）

### 5.4 技能加载

Claude Code 的技能系统（`src/skills/`）：
- 技能定义以 `.md` 文件存储，含 frontmatter（工具列表、模型、权限模式等）
- `SkillTool` 作为工具入口，动态加载技能内容
- 延迟加载：通过 `ToolSearch` 发现，需要时才注入上下文
- Post-compact 后技能内容重新注入（每技能 5K token 截断，头部优先）

### 5.5 对 xyz-agent 的启示

| 模式 | xyz-agent 现状 | 建议 |
|------|---------------|------|
| **记忆提取** | 无 | 可考虑: 对话结束时自动提取关键信息到项目记忆文件 |
| **会话记忆** | 无 | **高价值**: 在上下文压缩前维护 `SESSION_MEMORY.md`，压缩时作为摘要来源，避免昂贵的 API 调用 |
| **记忆巩固** | 无 | 长期可考虑: 定期清理过时记忆 |
| **技能延迟加载** | 无（所有工具定义始终发送） | 可参考 `shouldDefer` 模式: 工具搜索型工具默认不注入 schema，需要时才加载 |
| **Forked Agent 做记忆** | 无 fork 机制 | 如果 xyz-agent 接入支持 prompt caching 的 provider，这是高价值优化 |

---

## 6. 应采纳的模式

### 高优先级（直接影响产品质量）

1. **流式工具执行**：先完成的工具结果先返回给模型，节省 30-60% 等待时间
2. **Post-Compact 恢复**：压缩后重新注入文件/技能/任务状态，避免"失忆"
3. **子 Agent 状态隔离增强**：`set_app_state` 默认 no-op，文件缓存独立克隆
4. **前台/后台切换**：Agent 执行超过阈值自动后台化，前端通过事件流追踪
5. **SessionMemory 辅助压缩**：维护会话级笔记，压缩时作为零成本摘要来源

### 中优先级（提升架构健壮性）

6. **Bash 错误级联**：Bash 失败取消同批其他工具
7. **Microcompact 层**：清除过期的 tool results，减少缓存浪费
8. **Reactive Compact**：413 错误后的被动恢复链路
9. **工具自描述增强**：`is_destructive()`, `to_classifier_input()` 等方法
10. **Task ID 安全**：足够熵 + 类型前缀 + 磁盘输出 O_NOFOLLOW

### 低优先级（需要 provider 配合或长期投入）

11. **Fork + Cache 共享**：需要 API provider 支持 prompt caching
12. **Cached Microcompact**：需要 API provider 支持 cache_edits
13. **记忆提取/巩固**：需要长期记忆基础设施
14. **backfillObservableInput / preparePermissionMatcher**：Hook 系统成熟后引入

---

## 7. 应避免的模式

1. **不要复制 793 行 Tool 接口**：Claude Code 的 50+ 方法接口是历史演化的结果，xyz-agent 的 Rust trait 应保持精简，通过组合（`ToolExt`、`ToolPermissions`、`ToolRenderer`）而非继承
2. **不要复制 4 层压缩的复杂度**：xyz-agent 的 Rust 实现应从 2 层（trim + LLM 摘要）开始，按需增加
3. **不要过早实现 Fork 机制**：Fork 的价值完全依赖 Anthropic 的 prompt caching API，xyz-agent 接入其他 provider 时 fork 无意义
4. **不要复制 Feature Gate 复杂度**：Claude Code 的 `feature()` 编译时门控对开源项目增加了不必要的间接层
5. **不要复制 5K 行 REPL.tsx**：单体 UI 文件难以维护，xyz-agent 的 Vue 组件应严格按职责拆分

---

## 8. 架构对比速查

| 维度 | Claude Code | xyz-agent | 差距 |
|------|------------|-----------|------|
| Agent Loop | AsyncGenerator + 状态机 | Rust 循环 + 事件流 | ✅ 基本对齐 |
| 工具并发 | 流式 + 分区并发 (10 上限) | safe 并发 + unsafe 串行 | ⚠️ 可改进为流式 |
| 子 Agent | 三层调度 + Fork cache 共享 | Dispatch + Orchestrate | ⚠️ 需增强隔离 |
| 上下文压缩 | 5 层 + Cached MC + Post-Recovery | 2 层 + 熔断 | ⚠️ 需增加 Post-Recovery |
| 记忆系统 | 4 种 + 自动提取 + 团队同步 | 无 | ❌ 可从 SessionMemory 开始 |
| 权限系统 | 5 层 + Hook + 分类器 | 3 层 (白名单/黑名单/权限上下文) | ✅ 基本够用 |
| 可恢复性 | sidecar 持久化 + resume | JSONL 持久化 | ✅ 基本对齐 |

---

*文档生成时间: 2026-05-06*
