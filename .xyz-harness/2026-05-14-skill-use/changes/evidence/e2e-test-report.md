# E2E Test Report — Skill Slash 命令使用

**日期**: 2026-05-14
**测试环境**: macOS, Node.js v24.11.1, Electron + Vue 3

## 自动化验证结果

### 单元测试（17/17 通过）

| 测试文件 | 用例数 | 结果 |
|---------|--------|------|
| skill-paths.test.ts | 7 | PASS |
| skill-scanner.test.ts | 10 | PASS |

**覆盖的关键路径**：
- RpcClient create/restore 路径传递 --skill 参数
- 空 skillPaths / undefined skillPaths 边界
- SessionPool 过滤 disabled + 不存在路径
- parseSkillMd() 从 frontmatter 提取 argument-hint（正常/空值/无frontmatter/多行等）

### 测试数据准备

- 测试 skill 已创建：`/tmp/xyz-test-skill/SKILL.md`
- 含 `argument-hint: "[filename] describe what to do"`
- 含 `[XYZ-TEST-SKILL-ACTIVE]` 标记用于 LLM 回复验证

## 手动 E2E 测试（需人工执行）

以下 15 个用例需要启动 Electron 应用（`npm run dev`）后人工操作验证。

### Group A: Skill 路径传递

| 用例 ID | 描述 | 状态 | 备注 |
|---------|------|------|------|
| E2E-01 | enabled skill 的 --skill 路径传递 | ⬜ | 需启动应用，检查 sidecar 日志 + ps aux |
| E2E-02 | 禁用所有 skill 后不传 --skill | ⬜ | 需启动应用 |
| E2E-03 | sourcePath 不存在时不崩溃 | ⬜ | 需启动应用 |
| E2E-04 | restoreSession 传 skill 路径 | ⬜ | 需启动应用 |

### Group B: SlashMenu 交互

| 用例 ID | 描述 | 状态 | 备注 |
|---------|------|------|------|
| E2E-05 | SlashMenu 展示 skill 名称、描述、参数提示 | ⬜ | 需 UI 交互 |
| E2E-06 | 无 skill 时仅展示内置命令 | ⬜ | 需 UI 交互 |
| E2E-07 | 键盘导航选择 skill | ⬜ | 需 UI 交互 |

### Group C: 输入框预填

| 用例 ID | 描述 | 状态 | 备注 |
|---------|------|------|------|
| E2E-08 | 有 argumentHint 时预填文本 | ⬜ | 需 UI 交互 |
| E2E-09 | 无 argumentHint 时不预填 | ⬜ | 需 UI 交互 |
| E2E-10 | 取消选择后恢复原始状态 | ⬜ | 需 UI 交互 |

### Group D: 端到端发送

| 用例 ID | 描述 | 状态 | 备注 |
|---------|------|------|------|
| E2E-11 | 带文本发送 /skill:name text | ⬜ | 需 pi + LLM |
| E2E-12 | 不带文本发送 /skill:name | ⬜ | 需 pi + LLM |
| E2E-13 | 消息气泡显示 skill 名称/标签 | ⬜ | 需 UI 交互 |

### Group E: Settings 变更验证

| 用例 ID | 描述 | 状态 | 备注 |
|---------|------|------|------|
| E2E-14 | 禁用 skill 后新 session 不传被禁用 skill | ⬜ | 需 Settings 交互 |
| E2E-15 | 旧 session 发送 /skill:name 仍正常 | ⬜ | 需多 session 操作 |

## 执行指南

```bash
# 1. 启动应用
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-skill-use
npm run dev

# 2. 按 e2e-test-plan.md 的执行顺序逐个验证
# Group A: E2E-01 → E2E-04 → E2E-03 → 恢复 → E2E-02 → 恢复
# Group B → C → D → E

# 3. 每个用例验证后在本文档更新状态为 ✅ 或 ❌
```

## 结论

- **自动化验证**: 17/17 单元测试通过，核心逻辑（skillPaths 传递 + argumentHint 提取）已验证
- **手动 E2E**: 15/15 需人工执行（Electron 桌面应用 UI 交互）
- **阻塞问题**: 无
