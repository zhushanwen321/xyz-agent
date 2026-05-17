# Retrospective — Bridge Extension

## 回顾

| 指标 | 值 |
|------|---|
| 目标 | 用方案B（before_provider_request + tool_choice）实现agent驱动 |
| 新增扩展 | `xyz-agent-bridge` pi extension（4 hooks） |
| 修改文件 | server.ts, ChatInput.vue, useSession.ts |
| Bug修复 | 4个（Enter阻塞、历史消失、agent找不到、工具限制） |
| 测试 | 116/116 GREEN |
| E2E | 5/5 PASS |

## 关键教训

1. **`tool_choice` 不足以保证跨provider兼容** — 必须配合 `setActiveTools` + `before_agent_start` system prompt 三层保障
2. **Session ID 复用引入了隐式依赖** — `onSessionRestored` 的 `removeSession` 逻辑假设 old !== new
3. **Agent name 渲染是架构级gap** — 事件管道不传递agent名称元数据
4. **SlashMenu 状态管理脆弱** — `watch(text)` 和 `handleSlashSelect` 对 slashVisible 的竞争条件

## CLAUDE.md 改进建议

- 添加 session ID 不可变原则的文档
- 添加 bridge extension 的事件流文档
