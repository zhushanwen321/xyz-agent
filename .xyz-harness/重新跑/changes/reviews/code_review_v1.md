# Code Review v1 — xyz-agent-bridge Extension

## 评审范围
- `~/.pi/extensions/xyz-agent-bridge/index.ts` — 新增 pi extension
- `src-electron/sidecar/src/server.ts` — 修改 sidecar subagent 处理
- `src-electron/renderer/src/components/chat/ChatInput.vue` — 修复 Enter 提交
- `src-electron/renderer/src/composables/useSession.ts` — 修复历史消息消失

## 检查项

| 维度 | 状态 | 说明 |
|------|------|------|
| 架构遵循 | PASS | Extension hook 链路正确：input → before_agent_start → before_provider_request → tool_call |
| 安全性 | PASS | JSON.stringify 自动转义，无注入风险；隐藏标记在 input hook 中被剥离 |
| Provider 兼容性 | PASS | 三层保障：setActiveTools(系统级) + system prompt + tool_choice(API级) |
| 扩展性 | PASS | pendingForce状态隔离在同一 extension 内，不影响其他 extension |

## Bug Fix 验证

| Bug | 修复 | 状态 |
|-----|------|------|
| Enter 阻塞 | watch(text) 添加 activeCommand 守卫 | PASS |
| 历史消失 | onSessionRestored 添加 old!==new 守卫 | PASS |
| agent 找不到 | setActiveTools 限制工具 | PASS |
| 无 agent 标签 | 架构级问题，待后续 | NOTE |

## 结论

0 条阻塞项，1 条 NOTE。审查通过。
