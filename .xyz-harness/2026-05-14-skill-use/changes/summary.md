# Skill Slash 命令使用 - 全流程追溯

## 基本信息
- 需求描述: 在聊天框中通过 slash 命令使用 skill，用户输入 `/` 后选择 skill，pi 自动加载 SKILL.md 内容
- 开始时间: 2026-05-14
- 当前阶段: 1 需求分析

## 阶段状态

| 阶段 | 状态 | 评审轮次 | 备注 |
|------|------|---------|------|
| 1 需求分析 | 🔄 进行中 | - | spec + plan 已编写 |
| 2 需求评审 | ⬜ 未开始 | - | - |
| 3 编码实现 | ⬜ 未开始 | - | - |
| 4 编码评审 | ⬜ 未开始 | - | - |
| 5 测试编写 | ⬜ 未开始 | - | - |
| 6 测试评审 | ⬜ 未开始 | - | - |
| 7 代码推送 | ⬜ 未开始 | - | - |
| 8 CI 验证 | ⬜ 未开始 | - | - |
| 9 部署验证 | ⬜ 未开始 | - | - |
| 10 用户确认 | ⬜ 未开始 | - | - |
| 11 自动复盘 | ⬜ 未开始 | - | - |

## 评审摘要
[待评审后填写]

## 异常记录
[待异常发生后填写]

## 阶段 3 - 编码实现 (Task 3)

- 状态：done
- 变更文件：
  - `src-electron/renderer/src/components/chat/ChatInput.vue`
- 摘要：选中 skill 后预填 argumentHint 或动态切换 placeholder；取消标签恢复默认
- 时间：2026-05-14

## 阶段 5 - 测试编写 (Task 5: sidecar skillPaths 链路测试)

- 状态：done
- 变更文件：
  - `src-electron/sidecar/test/skill-paths.test.ts` (新建)
  - `src-electron/sidecar/vitest.config.ts` (新建)
  - `src-electron/sidecar/package.json` (添加 vitest 依赖和 test 脚本)
  - `src-electron/sidecar/tsconfig.json` (include test 目录)
- 摘要：7 个测试用例覆盖 skillPaths 从 RpcClient 到 SessionPool 的完整传递链路，包括 create 和 restoreSession
- 时间：2026-05-14

## 阶段 11 - 单元测试 (Change-driven Testing)

- 状态：done
- 变更文件：
  - `src-electron/sidecar/test/skill-scanner.test.ts` (新建)
  - `src-electron/sidecar/src/skill-scanner.ts` (导出 parseSkillMd)
- 摘要：10 个测试用例覆盖 parseSkillMd() 的 argumentHint 提取（7 例）和 description/triggers 提取（3 例）。全部 17 个 sidecar 测试通过。
- 备注：useSlashCommands.mergeSkillCommands() 为 Vue composable（依赖 ref 响应式系统），需 renderer 测试基础设施才能测试，记录为缺口。
- 时间：2026-05-14

## 阶段 6 - E2E 测试计划 (Task 6)

- 状态：done
- 变更文件：
  - `.xyz-harness/2026-05-14-skill-use/e2e-test-plan.md` (新建)
- 摘要：编写 13 个手动 E2E 测试用例，覆盖 Group A (skill 路径传递 4 例) + Group B (SlashMenu 交互 3 例) + Group C (输入框预填 3 例) + Group D (端到端发送 3 例)，含边界场景和测试结果记录模板
- 时间：2026-05-14
