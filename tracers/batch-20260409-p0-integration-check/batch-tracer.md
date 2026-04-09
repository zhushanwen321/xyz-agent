# 批量代码分析汇总报告

## 概述
- 批次名称：20260409-p0-integration-check
- 批次时间：2026-04-09
- 分析范围：P0 全部变更文件的跨模块调用链路
- 分析文件数：6 组（覆盖 16 个源文件）
- 成功完成：6/6
- 失败：0

## 文件清单

| 文件组 | 分析范围 | 严重 | 一般 | 轻微 | 状态 |
|--------|----------|------|------|------|------|
| chat.rs | commands/chat.rs 调用链 | 1 | 3 | 2 | 完成 |
| agent_loop.rs | AgentLoop 主循环 | 1 | 3 | 4 | 完成 |
| llm.rs | LLM Gateway | 2 | 4 | 3 | 完成 |
| session + event_bus | 命令处理器 + 事件桥接 | 0 | 2 | 4 | 完成 |
| db-layer | JSONL 存储 + Session 索引 | 0 | 3 | 3 | 完成 |
| frontend-integration | 前端类型 + 通信 + Composables | 2 | 2 | 3 | 完成 |

## 问题汇总

### 严重问题（去重后 4 个）

#### P0-1: parent_uuid 断链（评分 9）
- **文件**: services/agent_loop.rs `run_turn` 返回值
- **现象**: `TranscriptEntry::Assistant` 的 `parent_uuid` 硬编码为 `None`
- **影响**: `build_conversation_chain()` 无法从 Assistant 节点回溯到 User 节点，对话链断裂
- **根因**: `run_turn` 签名不接收 `parent_uuid` 参数，chat.rs 已计算但无法传递

#### P0-2: 未知 SSE 事件映射为空 TextDelta（评分 8）
- **文件**: services/llm.rs SSE 解析的 default 分支
- **现象**: `ping`、`message_start`、`content_block_start` 等事件被映射为 `TextDelta { delta: "" }`
- **影响**: 每次流式响应产生 3-5 个无意义事件，前端收到空字符串增量

#### P0-3: createSession 返回类型不匹配（评分 8）
- **文件**: src/lib/tauri.ts `createSession` 返回类型
- **现象**: 前端声明返回 `{ session_id, path }`，后端实际返回 `{ session_id, title }`
- **影响**: 当前仅使用 `session_id` 不崩溃，但 TypeScript 类型有误导性

#### P0-4: ThinkingDelta 事件未处理（评分 7）
- **文件**: src/composables/useChat.ts switch 语句
- **现象**: 后端发送 `ThinkingDelta` 事件，前端 useChat 的 switch 没有处理此变体
- **影响**: 思考过程数据被静默丢弃（P0 阶段可接受，但应有显式忽略）

### 一般问题（去重后 6 个）

#### P1-1: chat_stream_with_retry 盲目重试（评分 6）
- **文件**: services/llm.rs `chat_stream_with_retry`
- **现象**: 对所有错误类型（含 401/400）都进行重试
- **影响**: 不可恢复错误浪费 3 次重试 + 用户等待时间

#### P1-2: find_session_path / walkdir_for_session 重复（评分 6）
- **文件**: commands/chat.rs + commands/session.rs
- **现象**: 两个文件各有几乎相同的 session 文件查找函数
- **影响**: 维护成本，逻辑不一致风险

#### P1-3: 前端 TranscriptEntry 类型不完整（评分 6）
- **文件**: src/types/index.ts
- **现象**: 前端只定义了 user/assistant/system 三种变体，缺少 CustomTitle 和 Summary
- **影响**: 如果后端返回包含这两种变体的历史数据，前端类型断言可能出错

#### P1-4: new_session 返回值不一致（评分 5）
- **文件**: commands/session.rs `new_session`
- **现象**: new_session 返回 `{ session_id, title }`，list_sessions 返回完整 `SessionMeta`（含 created_at/updated_at）
- **影响**: 前端创建新 session 后拿不到完整元数据

#### P1-5: run_turn 未使用 chat_stream_with_retry（评分 5）
- **文件**: services/agent_loop.rs
- **现象**: 直接调用 `chat_stream` 而非带重试的 `chat_stream_with_retry`
- **影响**: 网络抖动时缺少自动重试

#### P1-6: model 名称硬编码（评分 5）
- **文件**: services/agent_loop.rs `run_turn`
- **现象**: model = "claude-sonnet-4-20250514" 硬编码在函数体内
- **影响**: 无法动态切换模型

### 轻微问题（去重后 5 个）

- chat.rs 手动构造 TranscriptEntry::User 而非使用 new_user() 辅助方法
- event_tx.send() 和 app_handle.emit() 返回值被 let _ = 丢弃
- session_index.rs 参数名 projects_dir 有误导（实际传入 config_dir）
- new_session 中 created_at/updated_at 使用两次独立 Utc::now()
- session.rs 有未使用的 LlmProvider import
