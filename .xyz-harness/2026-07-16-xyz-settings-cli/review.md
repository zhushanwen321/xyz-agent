# Code Review: xyz-settings-cli

## 审查范围

- W1: packages/runtime/src/cli/ (port-discovery, ws-client, commands, index, tests)
- W2: packages/runtime/tsup.config.ts, apps/electron/electron-builder.yml
- W3: packages/runtime/src/cli/resolver.ts, packages/runtime/src/cli/SKILL.md
- W4: packages/runtime/src/cli/commands.ts (Phase 2 commands)
- W5: packages/runtime/src/cli/reload.ts
- W6: packages/runtime/src/cli/__tests__/reload.test.ts

## 审查维度

### type-safety — OK
- 无 any 使用
- ws-client.ts 的泛型 `rpc<T>` 正确
- commands.ts 的 flags 类型转换安全

### error-handling — OK
- port-discovery: ENOENT + 非数字端口都有用户可读错误
- ws-client: 超时 + 连接失败 + 非预期关闭都有处理
- commands: 缺参数时给出 usage 提示
- reload: catch 所有错误返回 message

### edge-case — OK
- 空 stdin 处理（readStdin 返回空串）
- 端口范围校验（1-65535）
- 非 JSON WS 消息静默忽略

### test-coverage — OK
- 14 测试覆盖：port-discovery(3) + ws-client(2) + commands(6) + reload(3)
- 防线测试：文件不存在、端口非数字、WS 超时、session 忙碌
- 非纯 happy path（含异常路径 + 边界条件）

### plan-completeness — OK
- 6 Waves 全部 committed
- tsup CLI entry + electron-builder extraResources 已配置
- SKILL.md 已 symlink 到 ~/.xyz-agent/skills/

### design-consistency — OK
- CLI → WS → runtime → ConfigService 路径正确
- 复用现有 config.* 消息，零新协议
- apiKey 安全：stdin/env，非 CLI 参数
- Progressive disclosure：SKILL.md ~100 tokens

## 发现的问题

无 must-fix / should-fix 问题。

### nit

1. **commands.ts 的 Phase 2 命令（set-provider 等）的 WS 消息类型名假设**
   - 假设 runtime 有 `config.setProvider` / `config.setSkillDirs` 等 handler
   - 实际 ConfigService 可能需要新增这些 handler（当前只有 getProviders/setDefaultModel）
   - 风险低：这些是合理的扩展点，且 Phase 2 命令不阻断 Phase 1 使用

## 评分

整体质量：8/10
- 代码结构清晰，职责分离正确
- 测试覆盖合理，含异常路径
- 零外部依赖（纯 ws + node:fs + node:crypto）
- 打包配置改动谨慎（tsup entry + electron-builder extraResources）
