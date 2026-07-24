# Plan Review：fix-landing-dir-popover

## 审查范围

主 agent 自审（spec 已充分澄清，3 个问题边界清晰，无需派 subagent 禁读重建）。
对照 spec 的 4 FR + 7 AC + 1 decision，核验 dev-plan.json 的 3 个 Wave 覆盖度与架构合理性。

## FR 覆盖度（coverage）

| FR | 落地 Wave | 验证路径 |
|----|----------|---------|
| FR-1 目录列表 ≤6 | W1（runtime MAX_RECORDS 10→6 + 前端 slice 双保险）| AC-1/2 |
| FR-2 landing 态显示 worktree 按钮 | W2（isBare 改 pendingCwd 驱动，Landing.vue computed 改源）| AC-3/4 |
| FR-3 新增 workspace.detectBare RPC | W2（shared protocol + runtime handler + 前端 api）| AC-5 |
| FR-4 默认选中上次 session 目录 | W3（initApp 改读 sessionStore）| AC-6/7 |

**结论：4 FR 全覆盖，无遗漏。** 每个 FR 在对应 Wave 的 changes description 里显式标注了 FR/AC 编号。

## 架构合理性（architecture）

- **W1**：纯配置改动（MAX_RECORDS 常量 + slice），2 文件，独立可验证。无依赖。✅
- **W2**：端到端垂直切片（shared→runtime→api→composable→component），6 文件。
  - 拆分判断：6 文件但同属一条 RPC 贯通链路（protocol 定义→handler 实现→api 封装→composable 消费→component 派生），
    拆成更小 Wave 会破坏链路完整性（tracer-bullet 要求端到端贯通）。保持单 Wave 合理。
  - 复用点：runtime `WorkspaceDetector.detectBareWorkspace` 已存在（session 摘要链路复用），W2 仅新增 RPC 入口，零新增检测逻辑。✅
  - Landing.vue 的 isBareWorkspace computed 改为「优先 pendingCwd 驱动的 isBare，gitInfo.isBare 作 session 态 fallback」——两条数据源并存（ADR 0039），接口清晰。✅
- **W3**：dependsOn W2。判断依据：W3 改 initApp 的 presetCwd 选 session.cwd，session.cwd 作为 pendingCwd 会触发 W2 的 detectBare watch。
  虽然逻辑上 W3 可独立运行，但完整验证（pendingCwd=session.cwd → 按钮正确显隐）需要 W2 先就绪。声明依赖合理（非假依赖——W2 不就绪时 W3 的 presetCwd 不会触发 isBare 刷新，端到端行为不完整）。✅

## 可行性（feasibility）

- 3 个 Wave 均无未识别外部依赖。
- W2 的 RPC 模式（shared protocol 声明 + runtime handler case + 前端 api 封装）与现有 workspace.listRecent/record 完全一致，有现成参考。
- 所有 changes 描述可执行（具体到文件、函数、字段）。

## 审查结论

**plan 就绪，进 tdd_plan。** 无 must-fix / should-fix issue。

## Issues

无（提交空 issues）。
