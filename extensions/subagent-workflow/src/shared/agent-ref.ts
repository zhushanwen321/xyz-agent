/**
 * agentRef / workflowRef 统一路径解析（S2）。
 *
 * 设计（agent-ref-path-redesign D1）：资源引用唯一形态 = 绝对路径。
 * - agentRef    → .md 文件绝对路径（注入段 <available_subagents> 的 <location>）
 * - workflowRef → .js 文件绝对路径（注入段 <available_workflows> 的 <location>）
 * - 支持 `~/` 前缀展开（homedir）；相对路径不认（注入段给绝对路径，模型照抄零歧义）
 *
 * 名字不再是引用——只是注入段展示标签。执行侧拿到引用后一律 normalizeRef →
 * 文件加载（AgentRegistry.loadByPath / WorkflowScriptRegistry.getPath）。
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * 归一化资源引用：~ 展开 + 绝对路径校验。
 *
 * @param ref   原始引用（注入段 location / 工具参数值）
 * @param ext   期望扩展名（如 ".md" / ".js"），不匹配返回 null
 * @returns 归一化绝对路径；非法（空/相对路径/扩展名不符）返回 null
 */
export function normalizeRef(ref: string, ext?: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  const expanded = trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) return null; // 相对路径无基准（注入段给绝对路径）

  if (ext !== undefined && !expanded.endsWith(ext)) return null;
  return expanded;
}

/** agentRef 扩展名。 */
export const AGENT_REF_EXT = ".md";
/** workflowRef 扩展名。 */
export const WORKFLOW_REF_EXT = ".js";
