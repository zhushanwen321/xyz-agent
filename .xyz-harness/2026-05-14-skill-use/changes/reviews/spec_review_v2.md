# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-14 17:02
- 评审类型：Spec 独立评审（验证 v1 MUST FIX 修复情况）
- 评审对象：`.xyz-harness/2026-05-14-skill-use/spec.md`
- 评审轮次：第 2 轮

## v1 MUST FIX 逐条验证

### #1 "可复用 API"表是否区分已实现/待实现？
**已修复** ✅ — spec 新增"实现状态总览"章节，并将"已有基础设施"拆为"已实现的代码（可直接复用）"和"待实现的代码"两张表。6 个之前误标"需改造"的方法现在正确标注为已实现。

### #2 In Scope #1 是否标注已实现？
**已修复** ✅ — In Scope #1 标注删除线 + "✅ 已实现"。In Scope 区域底部明确列出"真正待实现的工作"。

### #3 In Scope #3 是否标注已实现？
**已修复** ✅ — 同上，In Scope #3 已用删除线 + ✅ 标注。

### #4 SkillInfo 接口描述是否准确（source/triggers 必填、sourcePath/content 可选）？
**已修复** ✅ — 接口/类型定义位置表中 `SkillInfo` 现在列出完整字段：`source: string`（必填）、`triggers: string[]`（必填）、`sourcePath?: string`（可选）、`content?: string`（可选）。与代码库 `src-electron/shared/src/provider.ts` L23-38 完全一致。

### #5 SlashCommand 接口是否包含 argumentHint?
**已修复** ✅ — 接口表中 `SlashCommand` 字段列表包含 `argumentHint?: string`。与代码库 `useSlashCommands.ts` L18 一致。

### #6 skillPaths 是否标注为已有字段？
**已修复** ✅ — 数据字段表中 `skillPaths` 状态列标注为"✅ 已实现"，不再是"新增"。

### #7 argumentHint 是否区分字段已存在/数据源待接？
**已修复** ✅ — 数据字段表中 `argumentHint` 状态列标注为"UI 已就绪，数据源待接"，明确区分了字段存在但值恒为 `undefined`。

### #8 SlashCommandAction 是否写明 discriminated union？
**已修复** ✅ — 接口表中写明完整定义：`{ type: 'local'; handler: (ctx: CommandContext) => void } | { type: 'protocol'; messageType: string } | { type: 'skill'; skillId: string }`。与代码库 `useSlashCommands.ts` L8-11 一致。

### #9 AC #4 验证方式是否可量化？
**已修复** ✅ — AC #4 改为"需 E2E 验证"，对应的 e2e-test-plan.md 中定义了 `[XYZ-TEST-SKILL-ACTIVE]` 标记验证法：创建测试 skill 要求 LLM 回复中包含特定标记字符串。这是可量化的——检查 pi 返回的文本是否包含 `[XYZ-TEST-SKILL-ACTIVE]`。

### #10 数据流是否包含 dirname() 转换步骤？
**已修复** ✅ — 数据流图中明确写出 `filter(enabled && sourcePath) → map(dirname(sourcePath)) → filter(existsSync)`，三步转换清晰。技术调研结论中也补充了"sourcePath 转换"说明。

### #11 技术债务描述是否与代码现状一致？
**已修复** ✅ — 技术债务表仅保留一条真实存在的债务："argumentHint 数据源未接入（预存，需决策提取规则）"。v1 中提到的"spawn 参数硬编码"已移除。

## v1 LOW 逐条验证

### #12 scanSkills 参数名是否准确？
**不适用** — v2 spec 中不再引用 `scanSkills`（已从可复用 API 表中移除，因为该方法不属于本次需求的实现路径）。LOW 问题自然消除。

### #13 argumentHint 提取规则是否定义？
**部分解决** — 已做决策表中第 4 项标注"argumentHint 提取规则：待定（需决策）"，状态为"是（可推翻）"。提取规则仍未定义，但已明确标记为需要决策的开放项，不会让 Phase 2 agent 猜测。考虑到实际待实现代码量极小（一行赋值），且 spec 在行为约束中未写死规则，这给 Phase 2 agent 留了合理决策空间。**标为 LOW**。

## 六要素覆盖矩阵

| 要素 | 覆盖状态 | 说明 |
|------|---------|------|
| Outcomes | ✅ | 目标描述清晰，实现状态总览表精确区分已完成/待实现 |
| Scope boundaries | ✅ | In Scope 和 Out of Scope 边界清晰，已实现项有明确标注 |
| Constraints | ✅ | 行为约束 Always/Never 完整，sourcePath 转换规则已说明 |
| Decisions made | ✅ | 4 项决策有选择和理由，argumentHint 提取规则标注待决策 |
| Verification | ✅ | AC 可量化（自动化测试 + E2E 标记验证法），边界条件覆盖 |
| 已有基础设施 | ✅ | 已实现/待实现分离，接口签名与代码库一致，技术债务真实 |

## 自包含性问题

无自包含性问题。

## 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | LOW | 歧义检查 | §已做决策 #4 | argumentHint 提取规则仍为"待定"，Phase 2 agent 需自行决策（取全文/截取/正则等） | 可在 Phase 2 开始前补充规则，或接受 Phase 2 agent 自行决定 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

## 结论

通过

## Summary

Spec 评审完成，第 2 轮，0 条 MUST FIX，1 条 LOW，通过。v1 的 11 条 MUST FIX 全部已修复。spec 准确反映了代码库现状，清晰区分了已实现和待实现工作，接口签名与代码库一致，数据流完整包含 dirname() 转换步骤。唯一剩余的 LOW 是 argumentHint 提取规则尚未定义，但不阻塞实现（待实现代码量极小）。
