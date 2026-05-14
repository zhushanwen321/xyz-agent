# Task 7 编码评审 v1 — argumentHint 数据源提取

## 评审记录
- 评审时间：2026-05-14
- 评审类型：编码评审（阶段④）
- 评审范围：commit 796e29e，仅涉及 `src-electron/renderer/src/composables/useSlashCommands.ts`
- 变更规模：+2 行，0 删除

## 评审依据
- spec.md（验收标准）
- plan.md（Task 7 章节）
- docs/standards.md + CLAUDE.md（架构约束）
- 实际代码验证

---

## 1. Spec 合规检查

### 验收标准 1："mergeSkillCommands() 中 argumentHint 有具体值（非 undefined）"

**结果：通过。** `argumentHint: s.description` 在 `s.description` 非空时会产生非 undefined 值。`SkillInfo.description` 由 `skill-scanner.ts` 的 `parseSkillMd()` 从 SKILL.md 正文提取，绝大多数 skill 的 description 非空。

### 验收标准 2："SlashMenu 中 skill 项展示参数提示"

**结果：通过。** SlashMenu.vue L31-33 的 `v-if="cmd.argumentHint"` 条件渲染会对 truthy 的 `s.description` 生效，参数提示标签会展示。

### 问题：argumentHint 语义与 description 重复

| # | 优先级 | 文件 | 行号 | 问题描述 |
|---|--------|------|------|---------|
| 1 | **MUST FIX** | `useSlashCommands.ts` | L50 | `argumentHint: s.description` 与同一行 `description: s.description` 值完全相同。SlashMenu 中同一行会同时展示 `cmd.description`（第三列）和 `cmd.argumentHint`（第四列），内容一模一样——这是 UX 上的信息冗余。 |

**具体分析：**

SlashMenu.vue 中每个 skill 项的渲染结构：
```
[skill 标签] [/skillName] [description 文本...] [argumentHint 文本]
```

当 `argumentHint === description` 时，用户看到：
```
[skill] [/cc-agent-design] [设计 AI agent 系统...] [设计 AI agent 系统...]
```

同一行出现两次完全相同的文本。

此外，在 ChatInput.vue L187-188 中：
```ts
if (cmd.action.type === 'skill' && cmd.argumentHint) {
  text.value = cmd.argumentHint
}
```
用户选中 skill 后，输入框被预填 skill 的 description（如 "设计 AI agent 系统..."），而不是参数模板或提示。用户需要手动删除这段不相关的文本才能输入自己的参数。

**问题根因：** `description` 是对 skill 功能的描述（"是什么"），而 `argumentHint` 的语义应该是参数使用提示（"怎么用"）。两者不应相同。

**修改方向：**
- 方案 A（最小改动）：如果 spec 的意图是先用 description 兜底、后续再精细化，应在 SlashMenu 中去掉 argumentHint 展示列（或仅在 `argumentHint !== description` 时展示），避免重复
- 方案 B（推荐）：不使用 `description`，而是从 `SkillInfo` 中提取更合适的字段作为 hint。例如 `s.triggers?.[0]`（第一个触发词示例），或截断 description 加 "..." 后缀作为示例
- 方案 C（如 plan.md 中提到但未采纳的）：保持 `argumentHint: undefined`，等待更完善的提取规则

**关于 spec 的判定：** spec 的验收标准字面要求是 "argumentHint 有具体值（非 undefined）"，当前实现满足了字面要求。但 spec 中对 argumentHint 的定位是 **参数提示**（plan.md L43: "参数提示标签"、spec.md L70: "skill 项展示参数提示"），用 description 填充在语义上是偏差的——它不是参数提示，而是功能描述。这属于 **理解偏差**（spec 合规检查维度中的第三项）。

---

## 2. 代码质量

| # | 优先级 | 文件 | 行号 | 问题描述 |
|---|--------|------|------|---------|
| 2 | LOW | `useSlashCommands.ts` | L50 | `s.description` 可能是空字符串（`parseSkillMd()` 在 SKILL.md 没有 frontmatter 且正文为空时会返回 `''`）。空字符串是 falsy 的，`v-if="cmd.argumentHint"` 不会渲染，ChatInput 中也不会预填，所以不会导致 bug。但类型上 `SkillInfo.description` 是 `string`（非 optional），空字符串场景值得注意。 |

---

## 3. 架构合规

无问题。变更仅涉及前端 composable 内部逻辑，未违反 CLAUDE.md 中列出的架构约束（无跨层调用、无 any、无原生 HTML 元素、emit 规范等）。

---

## 4. 前端专项评审

不适用——本次变更不涉及 `.vue` 文件、CSS 文件或 UI 组件。变更仅限于 `.ts` composable 文件中的数据映射。

---

## 评审结论

**需修改后重审。**

MUST FIX 问题 1 条：`argumentHint` 使用 `s.description` 导致同一行中 description 和 argumentHint 展示完全相同的内容，且 ChatInput 预填的文本是功能描述而非参数提示。这属于对 spec "参数提示" 语义的理解偏差。

本轮次：1/2

