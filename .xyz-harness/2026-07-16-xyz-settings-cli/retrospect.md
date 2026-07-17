# Retrospect: xyz-settings-cli

## 执行概况

| 指标 | 结果 |
|------|------|
| Waves | 6/6 committed |
| 测试 | 11/13 passed, 2 需手工（E1/E2 需 runtime） |
| Commits | 8 commits (W1-W6 + 2 test_fix) |
| CW 轮次 | clarify → spec_review → plan → plan_review → tdd_plan → dev → review → test (4 turns) |

## 做得好的

1. **TDD 流程完整**：红灯 → 实现 → 绿灯，14 测试覆盖核心路径
2. **CW 流程遵守**：每 Wave 独立 commit，gate 全部通过
3. **打包安全**：tsup + electron-builder 改动经过 preflight + runtime bundle 验证
4. **ESLint 修复**：发现非本次改动的 warning 一并修复

## 做得不好的

1. **U3 expected 写错**：tdd_plan 阶段 expected 写了子串 "invalid port"，但 CW 做精确比较。3 轮 test_fix 才修好
2. **E1/E2 未测**：集成测试需要运行中的 runtime，当前环境无法执行。应在有 runtime 的环境补测

## 经验教训

1. **expected 必须是完整字符串**：CW 做 `===` 精确比较，不是子串/regex 匹配。tdd_plan 写 expected 时必须是完整的实际输出值
2. **打包配置改动需谨慎**：tsup entry + electron-builder extraResources 都经过了完整的 preflight 验证流程

## processIssues

- E1/E2 需手工测试：启动 xyz-agent app → 运行 `node apps/electron/dist/runtime/cli.cjs list-providers --json` 和 `set-default-model`
- 后续可考虑在 CI 中添加 runtime smoke test 覆盖 E1/E2

## knownRisks

- Phase 2 命令（set-provider 等）的 WS 消息类型假设 runtime 有对应 handler，实际可能需要在 ConfigService 新增
- SKILL.md 路径在 packaged app 中为 `resourcesPath/bin/xyz-settings`，需在打包后验证
