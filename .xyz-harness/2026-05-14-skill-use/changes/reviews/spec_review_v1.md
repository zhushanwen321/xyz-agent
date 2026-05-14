# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-14 22:00
- 评审类型：Spec 独立评审
- 评审对象：spec.md + plan.md
- 评审轮次：第 1 轮

---

## 一、六要素覆盖矩阵

| 要素 | 覆盖状态 | 说明 |
|------|---------|------|
| Outcomes | ✅ | "用户在聊天输入框输入 `/` 后，SlashMenu 弹出内置命令 + skill 列表供选择。选中 skill 后，用户输入附加文本，发送时以 `/skill:name user text` 格式传给 pi，pi 自动展开 SKILL.md 内容注入到 LLM 上下文。" 具体终态描述清晰。 |
| Scope boundaries | ✅ | In-scope 和 Out-of-scope 都明确列出。Out-of-scope 包含 6 项，涵盖 SKILL.md 格式改动、pi 源码改动、自然语言触发、搜索/分类/收藏、热更新等，边界清晰。 |
| Constraints | ✅ | 技术约束（框架、通信、类型共享、状态管理）、功能约束（只传 enabled、路径不存在则跳过、仅新 session 生效、动态获取）、兼容性约束（无 argument-hint 兼容、无 enabled skill 兼容、YAML 解析器限制）三方面完整。 |
| Decisions made | ✅ | 4 项决策均记录了选择和理由，且标注不可推翻。argumentHint 的官方来源调研结论（Anthropic 文档引用）充分支撑了决策。 |
| Verification | ✅ | 10 条验收标准，每条都可量化、可测试，且标注了实现状态。验证方式包含自动化测试 + 手动 E2E + 边界验证三个层次。 |
| 已有基础设施 | ✅ | 详细列出了已实现代码的位置/方法/行号、接口/类型定义位置表、技术调研结论（pi skill 展开机制、启动参数、RPC 命令、sourcePath 转换）、技术债务。 |

---

## 二、必填章节覆盖

| 章节 | 状态 | 说明 |
|------|------|------|
| 目标 | ✅ | 一段话说清要做什么 |
| 已做决策 | ✅ | 表格含决策项/选择/理由/是否可推翻 |
| 行为约束 | ✅ | Always / Ask First / Never 三层 |
| 已有基础设施 | ✅ | 可复用代码表 + 接口类型定义表 + 技术调研 + 技术债务 |
| 验收标准 | ✅ | 10 条，均可量化 |
| 数据流 | ✅（条件触发） | 数据字段表 + 完整流图（argumentHint 链路 + skillPaths 传递链路 + 用户操作时序） |

---

## 三、自包含性检查

### 文件路径完整性
所有引用的文件路径均从项目根开始写完整（如 `src-electron/sidecar/src/rpc-client.ts`），无模糊引用。

### 函数签名明确性
抽查的 5 个关键签名：

| 标识符 | spec 描述 | 代码库实际 | 一致性 |
|--------|----------|-----------|--------|
| `RpcClientOptions.skillPaths` | `skillPaths?: string[]` (L21) | L21: `skillPaths?: string[]` | ✅ |
| `parseSkillMd()` 返回值 | `{ description, triggers, argumentHint }` | L19: `{ description: string; triggers: string[]; argumentHint?: string }` | ✅ |
| `SlashCommand.argumentHint` | `argumentHint?: string` (L18) | L18: `argumentHint?: string` | ✅ |
| `ScannedSkillInfo.argumentHint` | `argumentHint?: string` (L30) | L30: `argumentHint?: string` | ✅ |
| `SkillInfo.argumentHint` | `argumentHint?: string` (L49) | L49: `argumentHint?: string` | ✅ |
| `importSkills()` 透传 argumentHint | stores/provider.ts L63 | L63: `argumentHint: item.argumentHint` | ✅ |
| `mergeSkillCommands()` 使用 `s.argumentHint` | useSlashCommands.ts L51 | L51: `argumentHint: s.argumentHint` | ✅ |

### 接口/类型定义位置
spec 专门有一张「接口/类型定义位置」表，列出了 `SkillInfo`、`ScannedSkillInfo`、`SlashCommand`、`SlashCommandAction`、`CommandContext` 的完整字段和文件路径。

### 隐含知识
未发现"大家都知道"类的未说明假设。argumentHint 的官方定义来源（Anthropic 文档引用）有明确说明。

### 模糊引用
未发现不精确引用。

**结论：无自包含性问题。**

---

## 四、[AMBIGUOUS] 标记检查

扫描全文：无 `[AMBIGUOUS]` 标记残留。

### 隐含歧义检查
- "Ask First" 中有一条："如果所有 skill 都未启用，是否仍在 SlashMenu 中展示空列表"——但这已经被功能约束覆盖（"无 enabled skill 兼容：SlashMenu 仅展示内置命令，不报错"），且在验收标准中也有对应条目（"无 enabled skill 时，SlashMenu 仅展示内置命令，不报错"）。不构成歧义。
- 未发现其他隐含歧义。

---

## 五、Plan 可行性与 Spec-Plan 一致性

### Plan 任务拆分合理性

Plan 包含 7 个 Task：
- Task 1-5: 已实现，标注为 ✅
- Task 6: 手动 E2E 验证，⬜ 未执行
- Task 7: argumentHint 数据源，✅ 已实现

拆分合理，每个 Task 有明确的文件变更表、验收标准和风险点。

### 依赖关系
- Task 1（sidecar 传 --skill）是 Task 4（restoreSession 传 skill）的前置 ✅
- Task 7（argumentHint 数据源）是 Task 2（SlashMenu 展示）的前置 ✅
- Task 6（E2E 验证）依赖所有其他 Task 完成 ✅

### Spec-Plan 一致性
逐一核对 spec 验收标准与 plan 覆盖：

| Spec 验收标准 | Plan 覆盖 |
|-------------|----------|
| pi 进程启动时传递 --skill 路径 | Task 1 ✅ |
| SlashMenu 展示名称、描述和参数提示 | Task 2 + Task 7 ✅ |
| parseSkillMd() 提取 argument-hint | Task 7 ✅ |
| ScannedSkillInfo/SkillInfo 含 argumentHint | Task 7 ✅ |
| importSkills() 透传 | Task 7 ✅ |
| mergeSkillCommands() 使用 argumentHint | Task 7 ✅ |
| 选择 skill 后预填 argumentHint | Task 3 ✅ |
| 发送后 pi 正确展开 skill | Task 6 (E2E) ✅ |
| 新 session 使用更新后的 skill 列表 | Task 1 + Task 4 ✅ |
| 无 enabled skill 时正常 | Task 1 + Task 6 ✅ |

Plan 覆盖了 spec 所有需求，无遗漏。

---

## 六、已实现标注（✅）验证

spec 和 plan 中大量功能标注为 ✅ 已实现。验证其描述和验收标准是否与 spec 一致：

### argumentHint 实现状态验证（重点）

spec 的「实现状态总览」表中将 argumentHint 数据源提取标注为 ✅，并声称：
- `parseSkillMd()` L55-58 提取 `argument-hint` → 代码库实际 L55-58 ✅
- `ScannedSkillInfo` L30 含 `argumentHint?` → 代码库实际 L30 ✅
- `SkillInfo` L49 含 `argumentHint?` → 代码库实际 L49 ✅
- `importSkills()` L63 透传 → 代码库实际 L63 ✅
- `mergeSkillCommands()` L51 使用 `s.argumentHint` → 代码库实际 L51 ✅

**所有 argumentHint 相关标注均与代码库实际一致，自洽。**

### 其他已实现标注验证

| 标注 | 实际验证 |
|------|---------|
| rpc-client.ts L59-61 spawn args | 实际 L59-60（2 行 + 闭合括号），基本一致 |
| SlashMenu.vue L31-33 argumentHint 条件渲染 | 实际 L31 + L33，一致 |
| ChatInput.vue L112-118 placeholder computed | 实际 L112 开始，一致 |
| ChatInput.vue L187-188 handleSlashSelect 预填 | 实际 L187-188，一致 |
| session-pool.ts L113 create() 调用 getSkillPaths | 实际 L113，一致 |
| session-pool.ts L466 restoreSession() | 实际 L466，一致 |
| session-pool.ts L547-553 getSkillPaths() | 实际 L547-552（6 行），略有偏差但不影响理解 |
| skill-paths.test.ts 7 个测试用例 | 文件存在，实际有 7 个用例 |

---

## 七、发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | LOW | 引用准确度 | spec §已有基础设施 getSkillPaths | spec 写 "L547-553"，实际方法体为 L547-552（6 行），结束行差 1 | 更新为 L547-552 或模糊化为 L547 |
| 2 | LOW | 引用准确度 | spec §已有基础设施 rpc-client.ts | spec 写 "L59-61" spawn args，实际 if/for/闭合 共 L59-62（含闭合 `}`），行号范围略有偏差 | 更新为 L59-62 或模糊化为 L59 |

> 注：以上两个 LOW 级问题均为行号范围微小偏差，不影响 Phase 2 agent 定位代码。所有文件路径和函数签名均准确无误。

---

## 八、结论

**通过**

Spec 质量极高。六要素全覆盖，自包含性无问题，所有函数签名和接口字段与代码库实际一致，无 [AMBIGUOUS] 残留，plan 与 spec 完全对齐。仅有的 2 个 LOW 级问题是行号范围微小偏差，不阻塞实现。

---

### Summary

Spec 评审完成，第 1 轮，0 条 MUST FIX，通过。
