# Plan Review: cw-2026-07-21-scan-project-agents-skills

**审查对象**: dev-plan.json 初稿（W1 getSkillPaths + W2 loadSkills+RPC+前端）
**审查方法**: 禁读重建 + 三维度（coverage / architecture / feasibility）+ 源码核实
**主 agent 核实**: 4 个 must-fix 已逐条 grep 确认为真实问题。

## 源码核实结果（主 agent 复核 reviewer 发现）

| 核实项 | 事实 | 与 reviewer 一致 |
|--------|------|------------------|
| getSkillPaths 委托链 | session-service.ts:680 → configStore.getSkillPaths → pi-provider-store:386（读 discovery.json），**不经 loadSkills** | ✓ #2 假依赖确认 |
| selectWorkspace 位置 | useNewTaskDirSelect.ts:48 定义，useNewTaskFlow.ts:309 仅重导出 | ✓ #3 路径错位确认 |
| RPC 命名空间 | settings-message-handler.ts 现有全是 `config.<action>` 单层（scanSkills/setSkillDirs/scanAgents/...） | ✓ #4 命名不一致确认 |
| settingsStore.skills 全局性 | useSettings.ts:67 AppShell 单例订阅 config.onSkills 填充，所有 panel 共享 | ✓ #5 全局污染风险确认 |

## 发现的问题

| # | Severity | Dimension | Ref | Description | 修复方向 |
|---|----------|-----------|-----|-------------|---------|
| 1 | must-fix | coverage | W1/W2 | FR-3/FR-4 零代码机制验证型 FR，plan 未说明验证路径 | ✅ resolved（replan W1 description 补说明） |
| 2 | must-fix | architecture | W2.dependsOn=["W1"] | 假依赖 | ✅ resolved（拆 W2 独立 dependsOn:[]） |
| 3 | must-fix | architecture | W2 文件 useNewTaskFlow.ts | 路径错位 | ✅ resolved（改为 useNewTaskDirSelect.ts） |
| 4 | must-fix | architecture | W2 RPC config.scanProjectSkills | 命名不符约定 | ✅ resolved（改 config.scanSessionSkills） |
| 5 | must-fix | architecture | W2 合并 settingsStore.skills | 全局污染 | ✅ resolved（新增 useProjectSkills 按 cwd key 缓存） |
| 6 | should-fix | architecture | W2 loadSkills + 新 RPC | 配套关系未说明 | ✅ resolved（W2 description 点明） |
| 7 | should-fix | feasibility | W2 5 文件横切 | 范围过大 | ✅ resolved（按 layer 拆 W2+W3） |

plan_review turn 2 复查：空 issues，进 tdd_plan。新 plan 结构：W1（getSkillPaths，pi 加载）+ W2（loadSkills+RPC，runtime）+ W3（前端 useProjectSkills+CommandPopover）。

## 审查结论

**未就绪进 tdd_plan**。5 个 must-fix 需 plan_review_fix 重构 plan。

核心问题集中在 W2：
- #5 是最关键的——landing 态项目 skill 的状态管理需要重新设计（不能污染全局 settingsStore.skills，也不能用 per-sessionId 分区因 landing 无 sid）
- #2 假依赖需要拆 wave
- #3/#4 是文件路径和命名修正
- #1 补验证说明

建议 plan_review_fix 阶段把 W2 重新拆分：
- W1: getSkillPaths(cwd)（pi 加载链路，session 创建后生效）
- W2: loadSkills(cwd) + 新 RPC（runtime 侧，dependsOn:[] 与 W1 并行）
- W3: 前端 landing 调用 + 状态管理（按 cwd key 的独立 state，不污染全局，dependsOn W2）
