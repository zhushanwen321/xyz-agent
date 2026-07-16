# Spec Review — drawer-composer-injection

**审查日期**: 2026-07-16
**审查方法**: 禁读重建（fresh subagent 从 objective + clarifyRecords 重建 spec，与初稿 specSections diff）

## 审查范围

重建章节：FR + AC。初稿有 8 FR + 0 AC + 1 决策（ADR-0034 统一 file chip 通道）+ outOfScope 3 条。

## 发现的问题

### must-fix

| ID | dimension | 问题 | ref |
|----|-----------|------|-----|
| SR1 | consistency | **FR-4 与 FR-8 / outOfScope 矛盾**：FR-4"选中文本弹 bubble，引用到当前/新对话"中的"引用""选中文本"与 FR-8"注入内容仅 file chip（不带选中文本）"+ outOfScope"排除选中文本引用块（quote）"三处打架。需明确 FR-4 的 bubble 是把**选区对应行范围**作为 file chip（path + lineRange）注入，而非引用文本。 | FR-4 |
| SR2 | completeness | **target='new' 路由 + landing composer sessionId 匹配缺失独立 FR**：FR-2 只说"注入通道存在"，但注入到新对话（landing composer）的路由逻辑未定义。Landing.vue:70 的 composerSid 落到 publicSessionId（非 null），不能靠 sessionId=null 匹配；landing 与 session 两个 composer 都挂 useComposerInjection，无 discriminator 会重复消费或都不消费。需新增 FR 定义 target 路由（landing composer 消费 target='new'，session composer 消费 target='current'）。 | FR-2 |
| SR3 | completeness | **注入 payload schema 未显式定义**：payload 字段集未定。应显式给出 `{ target: 'current'\|'new', path, lineStart?, lineEnd? }`，不含 text 字段（FR-8 转为正向 schema 约束）。 | FR-2 |
| SR4 | completeness | **{type:file} segment 提交序列化决策缺失**：file segment 提交时如何上送未定。实际已有答案——segments.ts 的 segmentsToPrompt 把 file 段序列化为 `path` 文本（client-only 归一化，wire format 不变），但 spec 未写明。补一条决策型 spec 条目确认此路径。 | FR-1 |
| SR5 | completeness | **整个 AC 层缺失**：8 FR 0 AC，无法判断"做完了"。至少 must-fix/should-fix 相关的 FR 需补可机器判定 AC。 | 全部 FR |

### should-fix

| ID | dimension | 问题 | ref |
|----|-----------|------|-----|
| SR6 | reasonableness | insertFileChip 对 # 输入路径的向后兼容未覆盖：核心决策说 # 输入和 drawer 注入共用 insertFileChip，即 CommandPopover # file 分支要从 insertMentionChip 改调 insertFileChip，FR-1 未覆盖此迁移与回归。 | FR-1 |
| SR7 | reasonableness | @mention 路径保留未澄清：insertMentionChip 被改造，但 @mention 仍走 insertMentionChip("@", name)，需明确 insertMentionChip 保留供 @ 使用，避免误删共享函数。 | FR-1 |
| SR8 | reasonableness | 行范围字符串格式未规范：FR-5 用"Lno"（单行），FR-1 用 lineRange?（范围），FR-4 选区是多行。需统一规范：单行 `path:L<n>`，多行 `path:L<s>-L<e>`，无范围 `path`。 | FR-1/4/5 |

### nit（不进 issues，仅记录）

- FR-7 file badge 视觉/交互（显示路径末段 + tooltip 全路径 + 是否可点跳 DetailPane）需在 tdd_plan 细化
- FR-3 header 按钮注入语义（当前文件 path，target=current）需在 tdd_plan 细化
- handleBackspaceOnChip 已含 mention-chip classList 检查，file chip 复用此类名理论无需改，加回归 AC 兜底即可
- 注入状态生命周期：pendingInjection 单值覆盖（同 pendingSlash 语义），消费即清

## 审查结论

**spec 未就绪进 plan。** 5 个 must-fix 必须先补：

1. **SR1**：定稿 FR-4 不含选中文本，明确是选区行范围→file chip
2. **SR2/SR3**：新增 FR-2.1「注入目标路由」，定义 target 路由机制 + payload schema + landing 命中方案
3. **SR4**：补序列化决策（client-only 归一化为 `#path[:Ls-Le]`，wire format 不变）
4. **SR5**：补 AC（至少覆盖 must-fix/should-fix 的 FR）

should-fix SR6/SR7/SR8 同批补齐。进 spec_review_fix 改 spec 后复查。
