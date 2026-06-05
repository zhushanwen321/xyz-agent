---
verdict: pass
must_fix: 0
---

# Spec Review — Phase 0: TUI Bridge (EventAdapter + 基础设施)

## Summary

spec.md 结构完整、边界清晰、验收标准可量化。无 `[待决议]` 项，所有需求都有明确的输入→输出定义。通过审查。

## Issues Found

无 MUST_FIX 问题。以下为观察项（无需修复，仅供参考）：

### OBS-1：FR-7 event-bus 类型加固的迁移验证

FR-7 改为 `on(event: ServerMessageType, handler)` 后，需要确认项目中所有 `on()` 调用是否都使用 `ServerMessageType` 而非 custom string。当前代码中有 `on('extension.error', handler)`、`on('plugin:statusBarUpdate', handler)` 等——这些 `ServerMessageType` 已包含这些类型，理论上没问题。建议添加一条构建验证步骤到 AC 中。

**建议**：已在 AC-2.3 和 AC-2.4 覆盖（编译报错 + 不变更 handler 签名编译通过），accepted。

### OBS-2：AC-3.4 "sessionId 不匹配时静默忽略"的测试边界

AC-3.4 要求 handler 按 sessionId 路由。但有些事件（如 `session.renamed`）的 sessionId 来自 payload，有些来自事件来源的绑定 session。建议在测试中覆盖三种场景：
1. payload.sessionId 匹配 → handler 执行
2. payload.sessionId 不匹配 → handler 不执行
3. payload 无 sessionId → handler 不执行（与现有 useChat 行为一致）

**建议**：已在 AC-3.4 中覆盖 "sessionId 不匹配时静默忽略"。无 sessionId 的 case 已隐含在 "与现有 useChat 行为一致"。无需修改。

### OBS-3：Complexity Assessment 的 2-3 天估算

~450 行代码 + ~380 行测试的估算合理。但需要注意事件测试涉及 mock pi RPC 事件格式，setup 成本较高。

**建议**：估算合理，无需修改。

## Conclusion

| 维度 | 结果 | 说明 |
|------|------|------|
| 目标明确 | ✅ | EventAdapter 15 处 + event-bus 加固 + handler/Store |
| 范围合理 | ✅ | 明确排除了 GUI 组件（Phase 1-2） |
| 验收标准可量化 | ✅ | 22 条具体 AC，都是输入→输出验证 |
| 待决议项 | ✅ | 无 |
| MUST_FIX 数量 | 0 | 直接通过 |
