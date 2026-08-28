/**
 * Agent options resolver — resolves skill / schema to append-system-prompt
 * content + env vars on every dispatch (BL-1).
 *
 * BL-1：解析 workflow 脚本里 `agent({skill,schema})` 的 inline override，
 * 否则 pi 子进程只收到原始 prompt，没有 --append-system-prompt /
 * --skill / PI_WORKFLOW_SCHEMA。
 *
 * 职责范围（M2 修正）：仅处理 schema SO 指令（内容直传 appendSystemPrompt）+ skill。
 * agent ref 处理（systemPrompt/model/thinkingLevel）已移交 resolveIdentity（execution 层，
 * 经 getAgentConfig + resolveModel 完整覆盖），消除双重注入与 model 层级混乱。
 *
 * 调用方：engine/error-recovery.ts dispatchAgentCall（每次 agent-call 消息）。
 * - skill → resolveSkillPath → skillPath（--skill）
 * - schema → 结构化输出指令内容直传 appendSystemPrompt（--append-system-prompt）+ schemaEnv（PI_WORKFLOW_SCHEMA）
 *
 * M2 bug 修正：旧实现把 schema 指令写成临时文件、push 文件路径（而非内容）给下游，
 * 下游 mapper/session-runner 把路径当文本拼进最终 append 文件，导致 schema 指令从未
 * 进入子进程。改为指令内容直传（不写盘、无临时文件）。
 */

import type { AgentCallOpts } from "./models/types.ts";
import { resolveSkillPath } from "./skill-discovery.ts";
import { stringifySchemaCached } from "../shared/schema-jsonify.ts";

export interface ResolveResult {
  opts: AgentCallOpts;
  error?: string;
}

/**
 * 构造 schema structured-output 指令——resolver 单点注入的唯一文案源。
 *
 * [审查项#2] 消费链：resolveAgentOpts → appendSystemPrompt（ASP 稳定前缀区）。
 * 此前 session-runner 有一份措辞相近的同名函数并把指令拼进 task 末尾，形成
 * ASP + task 双重静态注入；task 后缀已删（task 每 agent 变化不可缓存，工具
 * parameters 是 pi 必然注入的权威展示，文本重复浪费 ~730 tokens/子进程）。
 *
 * [审查项#4] AP 告知：注入侧校验用 additionalProperties:false 收窄后的
 * parameters，模型自带 schema 外字段会被拒——不前置告知，拒绝显得凭空。
 *
 * JSON 序列化用 compact（stringifySchemaCached），与 schemaEnv 复用同串（IF7 #13）。
 */
export function formatSchemaInstruction(schema: Record<string, unknown>): string {
  const schemaJson = stringifySchemaCached(schema, "compact");
  return [
    "## MANDATORY: Structured Output Requirement",
    "",
    "This task requires structured output.",
    "Your FINAL action must be calling the `structured-output` tool.",
    "",
    "Your call arguments ARE the result data itself — the tool's parameter schema IS the required shape of your result.",
    `Your result must conform to this schema:`,
    "```json",
    schemaJson,
    "```",
    "",
    "Rules:",
    "- Call the structured-output tool with your result data as its arguments. The system validates them against the schema above automatically.",
    "- Do NOT output JSON in your text response — use the structured-output tool.",
    "- Do NOT skip this step. The structured-output call IS your result.",
    "- Complete all other work FIRST, then call structured-output as the last action.",
    "- Fields not defined in this schema are rejected — do not add extra fields.",
  ].join("\n");
}

/**
 * Resolve skill and schema into appendSystemPrompt (content array) + skillPath + schemaEnv.
 *
 * - Skill name -> resolved SKILL.md dir path via --skill
 * - Schema JSON -> structured-output instruction string pushed into appendSystemPrompt
 *   (content, not file path) + PI_WORKFLOW_SCHEMA env
 *
 * Agent ref is intentionally NOT handled here — resolveIdentity (execution layer)
 * covers it via getAgentConfig + resolveModel. Handling agent here would cause
 * double-injection (agentConfig.systemPrompt at session-runner + appendSystemPrompt)
 * and model-tier confusion.
 *
 * Returns the enriched opts.
 */
export function resolveAgentOpts(opts: AgentCallOpts): ResolveResult {
  const appendSystemPrompt: string[] = [];

 // Resolve skill name to SKILL.md path
  if (opts.skill) {
    const skillPath = resolveSkillPath(opts.skill);
    if (!skillPath) {
      return { opts, error: `Skill not found: ${opts.skill}. Searched .agents/skills/ and ~/.pi/agent/skills/` };
    }
    opts = { ...opts, skillPath };
  }

 // Inject schema as structured-output instruction into appendSystemPrompt (content,
 // not temp file) and set environment variable for conditional tool + hook activation.
 // M2 fix: previously wrote the instruction to a temp file and pushed the FILE PATH,
 // which got concatenated into the final append file as path garbage — the SO instruction
 // never reached the subprocess. Now the instruction content is pushed directly.
  if (opts.schema) {
    // IF7(#13)：formatSchemaInstruction 与 schemaEnv 对同一 schema 对象引用共享
    // WeakMap 缓存条目（compact stringify 整个 dispatch 只发生一次）
    appendSystemPrompt.push(formatSchemaInstruction(opts.schema));

 // Set env var for structured-output extension to activate tool + hook
    opts = { ...opts, schemaEnv: stringifySchemaCached(opts.schema, "compact") };
  }

  return {
    opts: { ...opts, ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}) },
  };
}
