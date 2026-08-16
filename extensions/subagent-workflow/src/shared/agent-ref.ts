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

/**
 * agent ref 的显示名：basename + 去 .md 扩展名（`/a/b/worker.md` → `worker`）。
 *
 * agentRef 是绝对路径，UI 显示层（TUI tool block 标题 / list / 完成通知、GUI list item /
 * pending 通知 name）统一经本函数取短名，避免长路径挤占显示宽度。数据层不动——
 * record.agent / env 注入（PI_SUBAGENT_AGENT）/ 持久化 / LLM 通知文本保持完整路径。
 *
 * 非路径值（DEFAULT_AGENT_NAME "general-purpose"）与无 .md 后缀的值原样返回。
 * 手动 split(/[\\/]) 而非 path.basename：跨平台统一（macOS 的 path.basename
 * 不切 Windows `\` 分隔符，反之类推），且本模块避免引入平台分支。
 */
export function displayAgentName(ref: string): string {
  const base = ref.split(/[\\/]/).pop() ?? ref;
  return base.endsWith(AGENT_REF_EXT) ? base.slice(0, -AGENT_REF_EXT.length) : base;
}
