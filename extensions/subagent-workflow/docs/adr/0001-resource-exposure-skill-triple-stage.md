# ADR-0001: 资源暴露机制统一为 skill 式三段式（发现 / 加载 / 校验）

**状态**: Proposed
**日期**: 2026-08-08
**关联**: 竞品调研（opencode / codex / claude-code subagent 机制）、ADR-030（分层配额）、ADR-031（统一资源发现）、AGENTS.md「派发提示词三段式」

## 背景

本包（`@zhushanwen/pi-subagent-workflow`）内有两个子系统：**subagent**（任务委派）与 **workflow**（多 agent 编排）。两者共享同一套资源发现机制（ADR-031 `resource-discovery.ts`），但**暴露给主 agent 的机制分叉，且质量不对等**。

### 内部四维诊断

| 维度 | subagent | workflow |
|---|---|---|
| **发现层**（进 system prompt） | 只注入 `name + description`（frontmatter 单行）✅ | 把整个 `meta.description`（review-fix-loop 达 ~400 字参数说明）塞进 `available_workflows` ❌ |
| **加载层**（按需查契约） | 正文（systemPrompt）在子进程启动时注入，主 agent context 不持有 ✅ | **无**——主 agent 要么看 description 散文（不够），要么读 `.js` 源码反推参数（错误路径）❌ |
| **校验** | 统一 TypeBox schema（`SubagentParams`），所有 subagent 共享 ✅ | `$ARGS` 纯透传零校验（`worker-script-builder.ts:103`），各脚本自写 `normalizeInt`/`fail`/白名单 ❌ |
| **隐式契约** | task 期望格式靠 description 软传达（部分问题） | 参数约束靠 description 散文 + `workflows/README.md` 表格，双 SSOT ❌ |

subagent 的骨架是健康的（符合下文行业范式）。workflow 的三个结构性缺陷是硬伤。**但 subagent 也有自己的、不同性质的缺陷**（见决策 B），需一并重构。

### 竞品验证：四家趋同，workflow 是唯一反模式

调研 opencode / codex / claude-code 三家 subagent 机制，加上 pi-subagent，四家独立得出高度同构的方案：

| 维度 | pi-subagent | **pi-workflow** | opencode | codex | claude-code |
|---|---|---|---|---|---|
| 发现层 | name+description（轻）| **400 字 ❌** | name+description，拼到**工具** description | name+description+locked note | description+`<example>` |
| 加载层 | 按需注入子进程 ✅ | **无 ❌** | 严格按需（execute 时 `agent.get`）✅ | spawn 时 config layer ✅ | spawn 时正文 ✅ |
| 校验 | 统一 schema ✅ | **各自写 ❌** | 统一 schema ✅ | 统一+`deny_unknown_fields` ✅ | 统一+`validate-agent.sh` ✅ |

**关键事实：没有任何一家用 per-agent / per-workflow 自定义参数 schema。** 差异全部收敛成「统一固定 schema + 配置差异」：
- opencode：所有 subagent 共用 `{description, prompt, subagent_type}`
- codex：所有 role 共用 `{message, task_name, agent_type, ...}`，role 差异只是一个 config layer（`role.rs`「Roles are selected at spawn time and are loaded with the same config machinery as config.toml」）
- claude-code：所有 subagent 共用 `{subagent_type, description, prompt}`，差异只在 frontmatter 静态配置

**前车之鉴**：codex v1 也犯过 pi-workflow 的错——把 ~50 行 delegation 教程塞进 tool description（`multi_agents_spec.rs:682-748`），v2 砍掉教程改成精简说明 + 可配置 `usage_hint`。**pi-workflow 现状 = codex v1**，修法已被验证。

## 决策

**将两个子系统的资源暴露机制统一为 skill 式三段式**，对齐已被四家验证的行业范式：

| 阶段 | 职责 | 类比 skill 机制 |
|---|---|---|
| **① 发现**（system prompt） | 只暴露 `name + 一句话 description`，回答「我该不该用它」 | available_skills：name + description |
| **② 加载**（按需，agent 主动） | 返回完整契约（schema + 使用说明），回答「怎么用、参数是什么」 | agent 用 read 加载 SKILL.md |
| **③ 执行**（引擎层统一校验） | 按契约校验输入，fail-fast，替代散落代码的自校验 | agent() 的 schema 触发 structured-output 工具校验 |

两个子系统分别落地（力度不同）：

### A. workflow 重构（推倒重做三层）

workflow 违背范式，三个缺陷都要正面修：

1. **发现层瘦身**：`available_workflows` 只保留 name + 一句话职责 description，参数全部移出。风格对齐 skill 的「Use when / Not for」。
2. **加载层新增**：workflow tool 加 `info` action，返回 `{ parameters: JSON Schema, usage: markdown }`。这是主 agent 获取参数契约的唯一正规途径（对应 skill 的 read SKILL.md）。`parameters` 管结构性约束，`usage` 管 schema 表达不了的语义约束（互斥、跨字段依赖、示例）。
3. **执行层统一校验**：引擎层在 `$ARGS` 注入前按 `meta.parameters` 用 ajv 校验，fail-fast 且错误回带完整 schema。替代脚本内散落的 `normalizeInt`/`fail`/白名单。

**数据结构**：`meta` 扩展 `parameters`（JSON Schema draft-07）+ `usage`（markdown）两个可选字段。提取层零升级——`config-loader.ts` 的 `safeEvalObject` 已能解析嵌套对象字面量，当前只是显式丢弃了非 name/description/phases 字段（113-120 行），加两行读取即可。

**示例**：
```javascript
const meta = {
  name: "review-fix-loop",
  description: "多批审查-修复循环，review→fix→重审直到 clean",  // 瘦身回一句话
  phases: ["Review", "Fix"],
  parameters: {                          // 结构化契约
    type: "object",
    properties: {
      targetType: { type: "string", enum: ["git-diff","file","dir","text"] },
      target: { type: "string" },
      convergeNewIssues: { type: "integer", minimum: 1, default: 1 },
    },
    patternProperties: { "^batch\\d+$": { type: "string" } },
    required: ["targetType", "target"],
  },
  usage: "## 使用说明\nbatch1..batchN 至少传一个；agents 与 batchN 互斥；fallow-scan 仅 git-diff 合法\n示例：...",
};
```

### B. subagent 重构（健康骨架上增强）

subagent 骨架正确（符合行业范式），**不推倒**。针对其固有缺陷增强：

1. **加载层新增**：subagent tool 加 `info` action，返回 `{ description, taskGuide, capabilities }`。把当前靠人定规范（AGENTS.md「派发提示词三段式」）保证的「task 期望格式」升级为机制内可查契约。主 agent 委派前能查看该 subagent 期望的 task 结构，而非全凭单行 description 猜。
2. **description 质量机制**：借鉴 claude-code `<example>` + `<commentary>` 触发教学样本，提升路由准确率。当前 pi-subagent 发现层只注入单行 description，主 agent 选 subagent 全靠一句话语义匹配，路由不准。允许 description 携带触发样本（何时该用 / 何时**不**该用），把契约从「纯散文」升级为「散文 + 教学样本」。
3. **单行 description 限制放宽**：当前 `parseAgentFrontmatter` 只支持单行 `key: value`（block scalar 不支持），反向激励 description 过简。放开 block scalar 支持，或把详细契约分离到 `taskGuide` 字段（加载层消费，不进发现层）。

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| **动态工具注册**（每个 workflow 注册成独立工具，inputSchema = parameters）| 工具列表膨胀；动态 workflow 变化需重注册工具；MCP 协议时序复杂。过度工程，skill 式加载层已够 |
| **纯 prompt 引导**（在 description 里写「调用前必看」）| 软约束，agent 不看——这正是当前状态，已失效。事故本身就是证据：description 已提参数名，agent 仍去读源码 |
| **subagent 照搬 workflow 的 per-agent schema** | 违背四家共识。subagent 的 task 是自由文本，强行 per-agent schema 是过度结构化 |
| **workflow 照搬 subagent 的隐式加载**（不暴露参数，启动时才注入）| subagent 隐式加载能工作，是因为主 agent 不需要看子 agent 正文（只管委派 task）。workflow 的主 agent **必须**看参数 schema 才能正确调用，必须有显式加载层 |
| **description 补约束**（不动机制，只把约束写进 description）| 治标：review-fix-loop description 已 400 字，补全到 600+；文字约束 LLM 解析不可靠、无 runtime 校验。仅作 schema 落地前的临时止血 |

## 取舍边界（重要）

1. **JSON Schema 管结构性约束，跨字段语义约束留代码**。review-fix-loop 的「agents 与 batchN 互斥」「fallow-scan 仅 git-diff 合法」超出 JSON Schema 表达力，继续留在脚本 `fail()` + `usage` 文字。schema 把能机器化的机器化（消除 ~80% 传错），剩余语义约束靠代码，是合理分工。不要用 `oneOf` 嵌套硬塞语义约束。

2. **subagent 的 task 不强行结构化**。这是委派模式的固有张力——你委派任务给人/agent，任务格式天然是软的。正确解法是 `taskGuide` 软传达 + 加载层，不是给 task 加 schema。强行结构化（强制三段）反而过度约束。

3. **workflow 必须有 per-workflow parameters schema**。与 subagent 不同，workflow 有真正的结构性参数（targetType/batchN/items），不是纯文本 task。这是两者本质差异，不能为「统一」而抹平。

4. **enum 必须下沉到 schema**。opencode / codex 都把 `subagent_type` 做成自由 String（合法清单未下沉 enum），导致幻觉 agent 名要运行时才发现——反面教材。workflow 的 parameters 要用 enum 约束可选值（如 `targetType: enum[...]`），这正是 JSON Schema 相比「脚本 if/else」的优势。

## 强制机制（解决「agent 不看」）

本 ADR 的核心约束力在**执行层**，不在 prompt：

- 发现层引导「先 info」是软约束（agent 可能跳过）
- 加载层 `info` 是自然约束（不查就没契约）
- **执行层引擎校验是硬约束**：就算 agent 跳过 info 直接 run 瞎猜 args，校验必然拦截，错误回带完整 schema，被迫按 schema 重试

对比现状「瞎猜 → 读源码 → 继续瞎猜」，新机制是「瞎猜 → 被拦 → 看 schema → 按重试」。强制力度高于 skill（skill 无执行层校验）。

## 影响 / 迁移路径

按收益/独立性排序：

1. **引擎层统一校验**（最高优先，独立可上线）：加 `validateArgs` + ajv。无 `parameters` 的 workflow 跳过校验，完全向后兼容。直接解决「无统一校验」根因。
2. **`workflow info` / `subagent info` action**：需 meta/agent 定义先支持新字段。
3. **review-fix-loop 作为首个 workflow 迁移示范**：声明 parameters + usage，下线脚本内 normalize（`review-fix-loop-utils.cjs` 大半可删），description 瘦身。它参数最复杂（可变 key、枚举、跨字段约束全覆盖），迁移它能验证完整边界。
4. **available_workflows / available_subagents 瘦身**：所有内置资源 description 回归一句话。
5. **补丁下线**：`findFlattenedArgKeys`（透传口袋平铺检测）在 schema 校验上线后由 schema 覆盖，可移除。

### 借鉴清单（竞品已验证实现）

| 缺陷 | 借鉴来源 | 具体机制 |
|---|---|---|
| 发现层臃肿 | opencode / codex v2 | 清单拼到「消费它的工具」description 而非全局 system prompt；砍掉教程精简 |
| 无加载层 | codex / claude-code | codex「discovery owns rendering prompt, runtime only starts」；claude-code progressive disclosure 三层 |
| 无统一校验 | 三家 + codex `deny_unknown_fields` | 统一固定 schema + 严格反序列化 |
| subagent 路由不准 | claude-code `<example>` | 触发教学样本（context→user→assistant→commentary 四元组）|
| 未知字段幻觉 | codex `deny_unknown_fields` | schema 层拒绝未知参数 |
| 配置差异收敛 | codex role = config layer | 差异是 config layer 而非独立 schema（workflow 因有结构化参数，不完全照搬，但思路可鉴）|
