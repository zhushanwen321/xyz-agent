# Agent-Facing 功能编写指南（pi 专属）

> **方法论入口**：设计或审查 agent prompt 前，先加载 `meta-prompt-creator` skill。
> 它提供 15 条通用原则（P1-P15）+ 9 种载体模式（agent-prompt / tool-description / skill-design 等）+ 审查清单（`review/rubric-<carrier>.md`）。
> 本文档**只补充 meta-prompt-creator 不覆盖的 pi 平台落地契约**——通用方法论不写在这里。

## 为什么单独有这份

meta-prompt-creator 回答「怎么想」「怎么查」，是通用方法论 SSOT。pi 有几项平台特有的格式与调用约定，通用 skill 不该管（也不该重复），统一收在这里。两者关系：

| 文档 | 职责 | 何时读 |
|------|------|--------|
| `meta-prompt-creator` | 通用方法论 + 审查清单 | 设计/审任何 agent prompt 时 |
| 本文档 | pi 专属格式契约 | 写 pi 的 agent.md / registerTool / workflow 时查 |

## 1. agent.md frontmatter 格式契约

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | kebab-case，与文件 basename 一致（AgentRegistry 按 basename 匹配）|
| `description` | 是 | **能力摘要，不需触发词**——agent 不是概率匹配加载（区别于 SKILL.md 的 description）|
| `tools` | 是 | 逗号分隔的 pi 工具名；最小权限原则（meta-prompt-creator P2）|
| `color` | 否 | 16 进制色值，仅 UI 标识 |
| `model` | 否 | `inherit`（默认）或 `provider/modelId` |

**tools 语法约束**：只能是 pi 注册的独立工具名（`read`/`bash`/`write`/`edit`/`grep`/`structured-output`/`subagent`/...）。不要写 bash 子命令——`grep`/`find`/`ls`/`cat` 是 `bash` 内的，不是独立工具（实测：把 `grep,find,ls` 列进 tools 无效，工具实际不存在）。

**description 写法**（区别于 SKILL.md）：写「这个 agent 能做什么、领域是什么」，不写「Use when user wants...」。

```
好例："TypeScript/Vue 代码品味审查专家。读取品味文档后执行 P0-P3 四级审查"
坏例："Use when user wants to review TypeScript code"（这是 SKILL.md 的写法，agent 不需要）
```

## 2. 被内置 workflow 调用的 schema 契约

`review-fix-loop` 等编排 workflow 用固定 schema 调 review agent。要接入的 agent 必须在正文里**显式告诉 agent 输出哪些字段**（否则 agent 不知道契约，输出不符 schema 被丢弃）：

```
reviewerSchema = {
  report_content,  // 完整报告 markdown（无 write 工具的 agent 用此返回全文）
  report_file,     // 已写盘的报告路径（有 write 工具的 agent）
  must_fix,        // critical+major 计数（clean 判定 = 此值 === 0）
  suggestion,      // minor 计数
  reconciliation,  // 跨轮对账用，首轮空数组
}
```

**两类 agent 的返回路径**：
- **schema-only agent**（tools 无 write，如 `doc-reviewer`）：经 `report_content` 返回全文，workflow 负责落盘到 `<roundDir>/<report>.md`。
- **write agent**（tools 含 write，如 `reviewer`）：自己写盘后经 `report_file` 返回路径。

约定：参考 `doc-reviewer.md` 作为 schema-only agent 的完整范例（含完成定义 + 防注入声明 + schema 字段说明）。

## 3. AgentRegistry 发现优先级

```
builtin（包内 agents/）< npm global < user .pi/agent < user .agents
< project .pi < project .agents        ← 最高，可覆盖内置同名 agent
```

**接入内置 workflow 的方式**：项目级 agent 放 `.agents/agents/<name>.md`，`batch1=<name>` 传入即可。AgentRegistry 自动发现，优先级高于内置。

## 4. 防平铺守卫（弱模型兼容）

弱模型常把 workflow args 子字段（`task`/`target`/`batchN`）平铺到 params 顶层，导致 `args={}` 静默启动缺参 run（P0）。

两处清单**必须同步**：
- `src/interface/tool-workflow.ts` 的 `KNOWN_ARG_KEYS`（registerTool 层检测）
- `workflows/<name>-utils.cjs` 的 `VALID_ARG_KEYS`（workflow 层白名单校验）

新增 workflow 参数时，**两处都加**，否则检测有缺口。检测命中时带 Correct JSON 示例纠正（见 `findFlattenedArgKeys`）。

## 5. workflow meta.description 格式

`meta.description` 进 LLM context，决定主 agent 是否选用此 workflow。

- **what + when + when-NOT**（与 tool description 同，meta-prompt-creator P1/P4）
- 必填参数显式标「必填」，枚举值列出
- **参数语义别单行塞满**——长描述重点被稀释（meta-prompt-creator P14 约束衰减）。结构化分行或详解放 README，description 只留摘要 + 必填项

反面案例：把 8 个参数的完整语义压进 description 单行，LLM 选用时抓不住重点。

## 参考实现

- `extensions/subagent-workflow/agents/doc-reviewer.md` — schema-only review agent 范例（四遍方法论 + 完成定义 + 防注入 + schema 契约声明）
- `extensions/subagent-workflow/agents/reviewer.md` — write 型 review agent 范例
- `extensions/subagent-workflow/workflows/review-fix-loop.js` — 编排 workflow + 配套 utils.cjs

## 审查

审查 agent-facing 改动时，走 `meta-prompt-creator` 的 `flow/review.md` + 对应 `review/rubric-<carrier>.md`（快速审查模式走 P0），再补本文档 §1-§5 的 pi 专属检查项。详见 `.agents/agents/review-extension-api.md` 的「Agent-facing 表面 checklist」章节。
