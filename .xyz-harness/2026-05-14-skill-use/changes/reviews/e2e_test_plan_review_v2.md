# E2E 测试计划评审 v2

## 评审记录
- 评审时间：2026-05-14 23:30
- 评审类型：E2E 测试计划独立评审（Round 2 — 验证 Round 1 MUST FIX 修复）
- 评审对象：e2e-test-plan.md
- 评审轮次：第 2 轮

---

### Round 1 MUST FIX 修复验证

| # | Round 1 问题描述 | 修复状态 | 验证详情 |
|---|-----------------|---------|---------|
| 1 | Group A 执行顺序 E2E-02→E2E-03 依赖冲突 | ✅ 已修复 | Section 2 执行顺序已调整为 E2E-01 → E2E-04 → E2E-03 → 恢复 → E2E-02。E2E-03 在 E2E-02 之前执行，避免了"先禁用全部再要求 enabled skill"的矛盾。 |
| 2 | E2E-03 后缺 skills.json 恢复步骤 | ✅ 已修复 | E2E-03 新增"恢复步骤"行，包含：① 具体 `jq` 恢复命令（将 sourcePath 从不存在路径改回 `/tmp/xyz-test-skill/SKILL.md`）② python3 验证命令确认 sourcePath 已恢复 ③ 明确要求"恢复后确认 Settings > Skills 页面 skill 状态正常，再继续执行 E2E-02 及后续 Group"。命令可直接复制执行。 |
| 3 | Section 4 边界场景缺可执行操作步骤 | ✅ 已修复 | 4 个边界场景（路径含空格、名称含特殊字符、多 enabled skill、快速连续选择）均已改为"准备/操作/期望/验证/清理"完整格式。每个场景有具体的准备命令（mkdir、cp、jq）、操作步骤、期望结果和清理指令。 |

---

### Spec AC 覆盖矩阵

（Round 1 已验证完整，本轮未发现 AC 覆盖变化，简要确认）

| AC | 描述 | 覆盖状态 | 测试用例 |
|----|------|---------|----------|
| AC1 | pi 进程启动时传递 --skill 路径参数 | ✅ 完整覆盖 | E2E-01, E2E-02, E2E-03, E2E-04 |
| AC2 | SlashMenu 展示名称、描述、参数提示 | ✅ 完整覆盖 | E2E-05, E2E-06, E2E-07 |
| AC3 | parseSkillMd() 提取 argument-hint | ✅ 间接覆盖 | E2E-05, E2E-08 |
| AC4 | ScannedSkillInfo/SkillInfo 含 argumentHint | ✅ 间接覆盖 | E2E-05, E2E-08 |
| AC5 | importSkills() 透传 argumentHint | ✅ 间接覆盖 | E2E-05, E2E-08 |
| AC6 | mergeSkillCommands() 使用 argumentHint | ✅ 间接覆盖 | E2E-05, E2E-08 |
| AC7 | 选择 skill 后输入框预填 argumentHint | ✅ 完整覆盖 | E2E-08, E2E-09, E2E-10 |
| AC8 | 发送 /skill:name 后 pi 正确展开 | ✅ 完整覆盖 | E2E-11, E2E-12 |
| AC9 | Settings 变更后新 session 使用更新列表 | ✅ 完整覆盖 | E2E-14, E2E-15 |
| AC10 | 无 enabled skill 时 SlashMenu 仅展示内置命令 | ✅ 完整覆盖 | E2E-02, E2E-06 |

覆盖结论：10 条 AC 全部覆盖，无遗漏。

---

### 四层策略合理性

与 Round 1 结论一致，无变化。验证方式与场景匹配（后端用日志/UI 用 DOM+视觉/全链路用消息内容+LLM 回复），无不合理层级选择。

---

### 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | **MUST FIX** | 依赖关系 | Section 2 → Group A → Group B 过渡 | **E2E-02（禁用所有 skill）是 Group A 最后一步，执行后环境处于"所有 skill 已禁用"状态。但 Group B 的 E2E-05 前置条件是"至少一个 skill 已 enabled"，E2E-07 同理。计划在 E2E-02 之后、Group B 之前缺少 skills 重新启用的恢复步骤。** 注意：Section 2 的注释"E2E-02（禁用所有 skill）放在最后，因为后续 Group B-E 都需要有效的 skill 配置"——这句话的因果关系有误：放在最后恰恰会在 Group A 结束时破坏环境，导致 Group B 无法开始。 | 方案一（推荐）：在 E2E-02 之后增加恢复步骤——"E2E-02 验证完成后，进入 Settings > Skills 页面，将 xyz-test-skill 重新启用，确认 Settings 页面显示 enabled 状态"。方案二：调整 Group B 执行顺序为 E2E-06（all disabled）→ 恢复 → E2E-05 → E2E-07，利用 E2E-02 的脏状态直接跑 E2E-06。 |
| 2 | LOW | 依赖关系 | Section 2 ASCII 图 | ASCII 依赖图仍显示 `E2E-01 ── E2E-02 ── E2E-03`（旧顺序），与下方执行顺序 `E2E-01 → E2E-04 → E2E-03 → 恢复 → E2E-02` 矛盾。执行 agent 可能先看图再看文字，造成混淆。 | 更新 ASCII 图为：`E2E-01 ── E2E-04 ── E2E-03(恢复) ── E2E-02`，或在图下方加粗注明"图中为逻辑依赖关系，实际执行顺序见下方建议"。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

### 结论

**需修改后重审**

Round 1 的 3 条 MUST FIX 均已正确修复。但修复引入了一个新的执行间隙：E2E-02（禁用所有 skill）作为 Group A 最后一步，执行后环境处于"所有 skill 禁用"状态，而 Group B 首个用例 E2E-05 需要"至少一个 skill 已 enabled"。计划缺少 E2E-02 → Group B 之间的恢复步骤。

### Summary

E2E 测试计划评审完成，第 2 轮，1 条 MUST FIX（E2E-02 后缺 skill 重新启用恢复步骤导致 Group B 阻塞），1 条 LOW（ASCII 依赖图与执行顺序不一致），Round 1 的 3 条 MUST FIX 全部验证通过，结论为需修改后重审。
