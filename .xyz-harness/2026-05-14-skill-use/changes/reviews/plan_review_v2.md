# 计划评审 v2

## 评审记录
- 评审时间：2026-05-14
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-14-skill-use/spec.md` + `plan.md`
- 评审轮次：第 2 轮（针对 v1 MUST FIX 修复后的重新评审）

---

## 一、v1 MUST FIX 修复验证

### #1（v1）: spec In Scope #4 与验收标准 #5 矛盾 — 已修复 ✅

- **In Scope #4** 已改为"仅保证新 session 使用最新 skill 列表"（原文加删除线标注变更）
- **Out of Scope** 新增"已有活跃 session 的 skill 热更新"
- **已做决策表** 新增"Skill 变更同步 → 仅新 session 生效"
- **验收标准 #5** 改为"新创建的 session 使用更新后的 skill 列表（已有活跃 session 不受影响）"
- In Scope、Out of Scope、已做决策、验收标准四方一致，矛盾消除。

### #3（v1）: Task 5 缺少自动化测试 — 已修复 ✅

- 原 Task 5（手动端到端验证）拆分为 Task 5（自动化测试）+ Task 6（端到端验证）
- Task 5 明确列出 5 个测试场景，有独立验收标准，新增 `skill-paths.test.ts` 文件
- Task 6 为手动验证，无代码变更，定位清晰

### #4（v1）: plan 无 task 覆盖活跃 session skill 同步 — 已修复 ✅

- spec 已将活跃 session 热更新移至 Out of Scope，plan 不需要覆盖此需求
- plan 的 Task 1 + Task 4 覆盖了"新 session 和恢复 session 都传 skill 路径"的完整链路

---

## 二、v1 LOW 问题追踪

### #2（v1）: Ask First 与已做决策不一致 — 已修复 ✅

"Skill sourcePath 不存在 → 跳过并继续"已出现在已做决策表中，Ask First 中仅保留"所有 skill 都未启用时是否展示空列表"。

### #5（v1）: sourcePath 路径说明 — 已修复 ✅

Task 1 描述已明确"取 `dirname(skill.sourcePath)`（skill 目录），确保 pi 的 resourceLoader 正确扫描目录上下文"。

### #6（v1）: Task 2 参数提取方案模糊 — 已修复 ✅

Task 2 描述改为"不在 description 中做参数提取，仅在 SlashCommand 类型中预留 argumentHint 字段"。方案务实，减少了不可控的 description 解析风险。

---

## 三、spec 完整性评审

### 3.1 目标明确性 ✅

一段话可说清：用户在聊天输入框输入 `/` 后选择 skill，通过 pi 已有的 `_expandSkillCommand()` 机制展开 skill 内容。

### 3.2 范围合理性 ✅

In Scope 4 条（--skill 参数传递、SlashMenu 参数提示、输入框预填、新 session 使用最新 skill 列表），Out of Scope 6 条。边界清晰。

### 3.3 验收标准可量化 ✅

6 条验收标准均可通过功能验证或测试验证。无模糊描述。

### 3.4 六要素覆盖 ✅

| 要素 | 状态 |
|------|------|
| Outcomes | ✅ |
| Scope | ✅ |
| Constraints | ✅ |
| Decisions | ✅ 4 条已做决策，理由充分 |
| Verification | ✅ 功能/端到端/边界三类 |
| Infrastructure | ✅ 可复用 API、类型定义、技术调研结论齐全 |

### 3.5 待决议项

无 `[待决议]` 标记。Ask First 仅 1 条（所有 skill 未启用时的展示），不影响核心功能。

---

## 四、plan 可行性评审

### 4.1 任务拆分 ✅

6 个 Task，粒度合理：

| Task | 文件数 | 判定 |
|------|--------|------|
| Task 1: Sidecar 传 --skill | 3 | ✅ 适中 |
| Task 2: SlashMenu 参数提示 | 2 | ✅ 适中 |
| Task 3: 输入框预构建参数 | 1 | ✅ 适中 |
| Task 4: Session 恢复传 skill | 1 | ✅ 适中 |
| Task 5: 自动化测试 | 1 | ✅ 适中 |
| Task 6: 端到端验证 | 0 | ✅ 合理 |

### 4.2 依赖关系 ✅

- Task 1 是核心基础设施（sidecar 链路）
- Task 4 依赖 Task 1（同链路的 restore 路径补充）
- Task 2、3 前端改动互相独立，与 Task 1 也独立
- Task 5 测试依赖 Task 1（测试 Task 1 的代码）
- Task 6 集成验证依赖所有前序 Task

依赖关系正确，无循环依赖。

### 4.3 工作量估算 ✅

L1 复杂度合理。总改动约 7 个文件（含 1 个测试文件），新增代码 < 300 行。

---

## 五、spec 与 plan 一致性评审

逐条对照 spec 验收标准与 plan task：

| Spec 验收标准 | Plan Task 覆盖 | 状态 |
|--------------|---------------|------|
| AC1: pi 启动传 --skill 路径参数 | Task 1（create 路径）+ Task 4（restore 路径） | ✅ |
| AC2: SlashMenu 展示参数提示 | Task 2 | ✅ |
| AC3: 选择 skill 后输入框预填 | Task 3 | ✅ |
| AC4: pi 正确展开 skill 内容 | Task 1（机制）+ Task 6（验证） | ✅ |
| AC5: 新 session 用更新后的 skill 列表 | Task 1 + Task 4（每次 create/restore 读 loadSkills 最新列表） | ✅ |
| AC6: 无 enabled skill 时正常 | Task 1 AC#3 + Task 5 测试场景#4 | ✅ |

所有验收标准均有 task 覆盖，无遗漏。

plan 中无 spec 未提及的额外工作（Task 4 的 session 恢复是对 spec 验收标准 AC5 的必要补充，不算多余）。

---

## 六、技术方案评审

### 6.1 sourcePath 处理 ✅

Task 1 明确用 `dirname(skill.sourcePath)` 取目录路径传给 `--skill`。这与 pi 的 resourceLoader 目录扫描机制匹配。

### 6.2 参数提示方案 ✅

Task 2 采用了务实方案：预留 `argumentHint` 字段，不实现参数提取。避免了解析不可控的 description 文本的风险。

### 6.3 Session 恢复覆盖 ✅

Task 4 识别了 `restoreSession()` 也需要传 skill 路径的需求。当前代码确认 `restoreSession()` 调用 `this.pm.createSession(id, target.cwd)` 不传额外参数，需要改造。

### 6.4 测试覆盖 ✅

Task 5 的 5 个测试场景覆盖了核心路径和边界条件：
1. 正常传 --skill
2. SessionPool 读取 skill 列表
3. sourcePath 不存在时跳过
4. 无 skill 时不传 --skill
5. restoreSession 也正确传递

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| — | — | — | 无问题 | — |

v1 的 3 条 MUST FIX 和 3 条 LOW 全部修复到位，未发现新问题。

spec 目标明确、范围合理、验收标准可量化、已做决策充分。plan 任务拆分合理、依赖关系正确、覆盖所有 spec 需求。技术方案务实，无过度设计。

---

### 结论

通过

### Summary

计划评审完成，第2轮通过，0条MUST FIX。
