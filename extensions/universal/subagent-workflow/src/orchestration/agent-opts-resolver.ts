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
    // IF7(#13)：同 schema 对象引用的 compact stringify 走 WeakMap 缓存
    // （与 session-runner formatSchemaInstruction 的 pretty 版共享缓存条目）
    const schemaJson = stringifySchemaCached(opts.schema, "compact");
    const content = [
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
    ].join("\n");
    appendSystemPrompt.push(content);

 // Set env var for structured-output extension to activate tool + hook
    opts = { ...opts, schemaEnv: schemaJson };
  }

  return {
    opts: { ...opts, ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}) },
  };
}
