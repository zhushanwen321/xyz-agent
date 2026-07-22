# Spec Review: scan-project-agents-skills

**审查对象**: cw-spec-scan-project-agents-skills.md（含 CL1 + CL2 两轮 clarify）
**审查方法**: spec 内部一致性 + completeness 核对

## 发现的问题

spec 经历两轮 clarify（CL1 原方案「新增 RPC + 双端适配架构」→ CL2 修正「改既有 cwd 解析，不新增 RPC」）。CL2 推翻了 CL1 的方案前提，但 cw gen-spec 是 progressive append，**旧 FR/AC/决策没被覆盖，新旧两套并存**，导致：

1. **FR 重复且描述冲突**：旧 FR-1（config-service 扫 .agents/skills 高优先级 + .xyz-agent/skills 兼容）vs 新 FR-1（getSkillPaths 按 cwd resolve 相对路径）。两套 FR-1 同 id 不同语义
2. **AC 重复**：旧 AC-1~5 vs 新 AC-1~5，同 id 不同条件
3. **决策矛盾**：旧 D1".agents/skills 为标准目录" vs 新 D1"改既有 cwd 解析不新增 RPC"——新 D1 推翻旧方案前提
4. **旧"不做"清单引用的 publicSession 扫描逻辑**已在新方案 outOfScope 没列（CL2 把 publicSession 描述放到 ADR 待验证项）

**plan 阶段会卡住**：dev-plan.json 的 changes 要描述具体改哪个函数，新旧 FR 冲突会让 plan 不确定改哪套。

## 审查结论

**有 1 个 must-fix**：清理 CL1 旧 FR/AC/决策，spec 只保留 CL2 修正版（修既有 cwd 解析）。统一术语为 CL2 版。

| ID | Severity | Dimension | Ref | Description |
|----|----------|-----------|-----|-------------|
| SR1 | must-fix | consistency | FR-1~4 / AC-1~5 / D1~4（旧版）| CL1 旧版 FR/AC/决策被 CL2 推翻但 progressive append 导致并存，新旧同 id 冲突。清理：spec 只保留 CL2 版（getSkillPaths/loadSkills cwd 解析修复，不新增 RPC），CL1 旧版作废。需用 replaceSpec 或重新构造 specSections 覆盖。 | ✅ resolved（CL3 replaceSpec 整体替换） |

spec_review turn 2 复查：空 issues，进 plan。
