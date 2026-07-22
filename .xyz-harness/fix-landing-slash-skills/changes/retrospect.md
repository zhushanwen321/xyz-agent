# Retrospect: cw-2026-07-21-fix-landing-slash-skills

## derived 异常归因

| 指标 | 值 | 归因 |
|------|-----|------|
| gateFailCount=3 | spec_review_fix / plan_review_fix (replan) / review_fix 各 1 轮 | 三个审查 gate 都捕到了真问题，是 gate 价值体现，非 gate 设计问题。spec_review 捕到术语不一致 + AC 回归点不显式；plan_review 捕到 W1 change 拆分割裂内聚；review 捕到合并源不去重（核心 bug） |
| firstTryPassRate=0.75 | spec_review / plan_review / review 各首次 fail | 根因：clarify 阶段对 publicSession 数据源分析不完整——原方案 A 设计"合并源"时未识别 pi publicSession 已含 skill 导致常态重叠，到 review 阶段用户核实现象后才纠正 |
| devRetryCount=0 / testRetryCount=0 | 0 | 实现一次过，测试一次过。改动集中（2 文件）+ TDD 红灯先行有效 |

## 可泛化流程模式（processIssues）

1. **[pattern] 对接外部系统的方案，clarify 阶段必须实测数据源内容，不能凭代码推断**。本 topic 最大失误：方案 A 基于"landing 无 pi 进程所以需要合并 settingsStore.skills"的推断，但 publicSession 本身就是 pi 进程，其 get_commands 已含 skill。如果 clarify 阶段让用户描述原现象（看到什么命令）或实测 commandStore 内容，方案会一次选对（直接去重合并而非先合并再修）。泛化：任何涉及外部数据源（pi/api/db）的方案，"数据源里到底有什么"必须实测，不能从代码调用链推断。

2. **[pattern] review 阶段的 should-fix 要核实"触发条件是否常态"，不能默认边缘 case**。reviewer subagent 把"不去重"标 should-fix，理由是"触发条件不确定（pi 对 publicSession 是否扫 skill）"。主 agent 核实用户现象后确认是常态重叠，升级 must-fix。泛化：reviewer 标注的 should-fix 若描述含"取决于/不确定/可能"等模糊触发条件，主 agent 必须核实条件真实性，不能默认边缘放过。

3. **[oneOff] cw dimension 字段枚举跨阶段不同（spec_review/plan_review vs review）**。提交时踩了一次坑（correctness 不是 review 的合法 dimension，应是 design-consistency）。属工具熟悉度问题，一次性。

## 设计级风险（knownRisks）

1. **[设计级 / unverified] publicSession 创建失败的降级路径**：publicSession 在 model 未配置/spawn 失败时不创建（session-service.ensurePublicSession catch 后仅 warn），landing 态 commandStore 无 publicSession 命令，settingsStore.skills 仍补项目级 skill（L11 测试覆盖此路径不崩）。但用户**看不到 extension 命令（/goal 等）**——这是接受的降级（Landing.vue:66-69 注释已说明）。风险：用户若期望 landing 总有 extension 命令，model 未配置时会困惑。unverified：真实 model 未配置场景未实测。

2. **[设计级 / unverified] settingsStore.skills 与 publicSession pi skill 的去重依赖 name 完全一致**。去重 key 是 `/skill:<name>` 精确匹配。若 pi 返回的 skill name 大小写/格式与 settingsStore 不一致（如 pi 返回 `skill:Code-Review`、settingsStore 是 `code-review`），去重失败仍重复。当前假设两者同源（config-service 扫描结果投影给 pi）所以 name 一致。unverified：跨版本 pi 升级后 name 格式若变化需复查。

3. **[代码级] landing 合并源顺序 extCmds 在前 extraSkillCmds 在后**：pi 源（extension + 全局 skill）显示在前，项目级 skill 在后。UX 上 extension 命令优先级更高合理，但用户若主要用项目 skill，排序不理想。低优先，未来可按使用频率排序。

## 未闭环评估

review 阶段所有 issue（R1/R2/R3）已在 review_fix 闭环。spec_review（SR1/SR2/SR3）和 plan_review（PR1）也全部闭环。无未闭环 should-fix/nit。
