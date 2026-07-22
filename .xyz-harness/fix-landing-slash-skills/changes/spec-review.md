# Spec Review: fix-landing-slash-skills

**审查对象**: cw-spec-fix-landing-slash-skills.md（初稿）
**审查方法**: 禁读重建 + 三维度（completeness / consistency / reasonableness）
**源码核实**: 主 agent 已在 clarify 阶段逐行核实关键事实（CommandPopover slashCommands computed、Landing.vue:70 composerSid、Composer.vue variant prop、pi agent-session.ts:1210 /skill: 前缀、command-popover-landing.test.ts mount 方式）。本审查基于已核实事实 + 初稿一致性。

## 1. 禁读重建（应有大纲）

基于 objective + CL1（不依赖初稿）重建认为 spec 应含：

**FR**
- FR-A: landing 态 slash 浮层显示 settingsStore.skills（项目级 + 全局 skill）
- FR-B: landing 态保留 publicSession 的 pi extension 命令（不回归）
- FR-C: session 态命令源不变（pi 真源，不合并 settingsStore.skills）
- FR-D: landing 选中 skill 后命令名带 /skill: 前缀，pi 可路由
- FR-E: 判定 landing 用 variant 而非 sessionId（根因修复）

**AC**
- 每个 FR 一条可机器判定的 unit AC
- 一条"测试 mount 方式修正"AC（variant=landing + 非空 sessionId）

**决策**
- D-1: variant 分支（非 sessionId）
- D-2: session 不合并 skills
- D-3: skill name 归一化 /skill:<name>

## 2. 与初稿 diff

初稿 FR-1~FR-5、AC-1~AC-5、D1~D3 与重建**一一对应，无遗漏无多余**。初稿额外含 UC-1~UC-3 业务用例 + "不做"清单，属合理补充。**结构完全对齐**。

## 3. 三维度审查

### completeness — 1 个 should-fix
- CL1 三条结论（variant 分支 / session 不合并 / skill name 归一化）均有 FR + D 落地。
- objective 根因（双源互斥 + 非空 composerSid）在"背景"章节复述准确。
- 潜伏 bug（/skill: 前缀）有 FR-4 + D3 覆盖。
- **缺口（SR3）**：UC-2 描述端到端"选中 skill → chip 插入 → 提交后 pi 正确加载（不报 unknown command）"，但 AC 只到 AC-4（emit name 形如 /skill:<name>），无 pi 实际加载验证。UC 写了 AC 不覆盖构成 completeness 缺口。建议将 pi 加载验证明确划入"不做（需 integration/pi 真环境，超出 unit 范围）"并在 UC-2 标注，消除 UC-AC 悬空。

### consistency — 1 个 should-fix
- **术语偏差（SR1）**：Objective / FR-1 标题 / UC-1 反复用"项目维度 skill"（出现 4 次），但 FR-1 正文明确 settingsStore.skills 范围是"项目级 .xyz-agent/skills + 全局 ~/.pi/agent/skills 等"。即实际修复后显示的是**项目级 + 全局**两类，而"项目维度 skill"措辞窄于实际语义，易让实现者误以为只显示项目级。建议统一为"settingsStore.skills（项目级 + 全局）"或显式说明"项目维度 skill"是 settingsStore.skills 的口语代称。

### reasonableness — 1 个 should-fix
- **AC-5 回归点不显式（SR2）**：AC-5 只说"用 variant=landing + 非空 sessionId mount，反映真实运行"，但 CL1 的核心回归点是"**非空 sessionId 时也走 landing 分支**"（现状 bug 正是 sessionId 非空走错分支）。AC-1 已含"sessionId=publicSessionId 非空"，AC-5 应显式以"非空 sessionId 下仍显示 settingsStore.skills"作为回归基线断言，否则 AC-5 易被实现成"换成 variant 判定即可"而漏掉非空 sessionId 这一触发条件。
- 其余 AC 可机器判定（vitest 断言），可实现。✓
- 复杂度 low 评估合理，改动范围（CommandPopover + Composer 透传 variant + 1 测试）描述准确，无过度设计。

### nit（不进 issues）
- FR-5 假设 Composer 已透传 variant 给 CommandPopover；实际 CommandPopover 当前无 variant prop 需新增（已确认），spec 仅在"复杂度"提及。plan 阶段处理。
- FR-2 未说明 publicSession 命令的拉取时序，属 plan 细节。

## 4. 审查结论

**spec 就绪进 plan**。无 must-fix。3 个 should-fix（SR1/SR2/SR3）已在 spec_review_fix 阶段修订（CL2，specSections 更新）：

| ID | severity | dimension | ref | 修订内容 | 状态 |
|----|----------|-----------|-----|---------|------|
| SR1 | should-fix | consistency | FR-1 | FR-1 标题改为「landing 态显示 settingsStore.skills（项目级 + 全局 skill）」，detail 补充「项目维度 skill」是口语代称的消歧说明 | ✅ resolved |
| SR2 | should-fix | reasonableness | AC-5 | AC-5 显式包含「非空 sessionId 下仍显示 settingsStore.skills」作为根因回归基线断言 | ✅ resolved |
| SR3 | should-fix | completeness | UC-2 / outOfScope | UC-2 expectedResult 标注 pi 加载验证不做（unit 只验 AC-4）；outOfScope 增项「UC-2 的 pi 实际加载验证」 | ✅ resolved |

spec_review turn 2 复查：空 issues，进 plan。
