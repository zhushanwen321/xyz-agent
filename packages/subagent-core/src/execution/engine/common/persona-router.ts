// src/execution/engine/common/persona-router.ts
//
// persona 路由与 argv 预算（P2 公共降级层）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D4（persona 路由按 capabilities
// 选择 file/flag/prompt 三策略，兼作 argv 长度分流）+ D5（preparer 在 spawn 前估算
// argv 总长度：仅 argv 投递的引擎超长时在 prepare 期报 prompt_too_large，禁止 spawn
// 后撞 E2BIG 才失败）+ §3.3.3 prompt_too_large 行。
//
// 路由产出按 capabilities.personaInjection 三分（中立层只决策通道与内容，具体 flag
// 组装归各引擎 launcher）：
//   - 'file'  → fileCandidate（人设全文落盘为文件，argv 只带文件路径——kimi
//               --agent-file 形态）；promptSegment 为空（人设不进 prompt）。
//   - 'flag'  → promptSegment 为人设全文（launcher 组 --system-prompt 类 flag 直传）。
//   - 'prompt'→ promptSegment 为带引导结构的人设段（拼进最终 prompt——zcode 形态）。

import { promptTooLargeError } from "./errors.ts";
import type { EngineCapabilities } from "../types.ts";

/**
 * 人设注入内容（[D6 合流] 原 PersonaSpec 的内容面——收拢层删除后 persona 路由
 * 只需人设正文的两个来源字段，取合流形状 AgentCallOpts 的结构子集：appendSystemPrompt
 * 是人设正文，skillPath 以引用提示行进文本。原 agentRef 字段随 PersonaSpec 裁撤
 * （无生产写入方）。
 */
export interface PersonaContent {
  appendSystemPrompt?: string[];
  skillPath?: string;
}

// ============================================================
// persona 三策略路由
// ============================================================

/** applyPersona 的返回：按通道产出人设载体。 */
export interface PersonaRouting {
  /** 进 prompt / flag 通道的人设文本（file 通道为空串）。 */
  promptSegment: string;
  /** file 通道的人设文件落盘候选（suggestedPath 相对池目录，preparer 负责落位）。 */
  fileCandidate?: { suggestedPath: string; content: string };
}

/** file 通道的人设文件建议名（相对池目录——preparer 知道池根，router 不感知）。 */
const PERSONA_FILE_NAME = "persona.md";

/**
 * 按 capabilities.personaInjection 路由 persona 的注入通道。
 *
 * router 不解析 agent .md / skill 文件内容（身份解析归宿主 resolveIdentity）——
 * 只把 PersonaContent 声明的内容组装成通道载体：appendSystemPrompt 是人设正文，
 * skillPath 以引用提示行进文本（prompt 通道）或正文头（file 通道）。
 */
export function applyPersona(persona: PersonaContent, capabilities: EngineCapabilities): PersonaRouting {
  switch (capabilities.personaInjection) {
    case "file": {
      const content = buildPersonaBody(persona);
      // 全空 persona 走 file 通道无意义（空文件白占 argv 一段）——降级为无载体
      if (content === "") return { promptSegment: "" };
      return { promptSegment: "", fileCandidate: { suggestedPath: PERSONA_FILE_NAME, content } };
    }
    case "flag":
      // flag 直传：纯正文（launcher 把它作为 --append-system-prompt 类 flag 的值）
      return { promptSegment: buildPersonaBody(persona) };
    case "prompt":
      return { promptSegment: buildPromptSegment(persona) };
  }
}

/** 人设正文：appendSystemPrompt join + skillPath 头部引用行。 */
function buildPersonaBody(persona: PersonaContent): string {
  const parts: string[] = [];
  if (persona.skillPath !== undefined) parts.push(`Skill context: ${persona.skillPath}`);
  const body = persona.appendSystemPrompt?.join("\n") ?? "";
  if (body !== "") parts.push(body);
  return parts.join("\n");
}

/** prompt 通道的人设段（带结构头，拼进最终 prompt）。 */
function buildPromptSegment(persona: PersonaContent): string {
  const body = buildPersonaBody(persona);
  if (body === "") return "";
  return `## Persona\n${body}`;
}

// ============================================================
// argv 长度预算（prepare 期前置拦截）
// ============================================================

/**
 * argv 预算默认上限（128KB）。依据：POSIX ARG_MAX 通常 ≥ 256KB（Linux 单字符串
 * MAX_ARG_STRLEN 128KB 是更紧的硬顶）——预算取 128KB 留出参数个数与 env 余量，
 * spawn 前拦截，绝不 spawn 后撞 E2BIG（D5）。可经 assertArgvBudget 第二参覆盖。
 */
export const DEFAULT_ARGV_BUDGET_BYTES =
  // eslint-disable-next-line no-magic-numbers -- 128KB = 128 * 1024 bytes 预算换算常数
  128 * 1024;

/**
 * 估算 argv 总字节数：各参数 UTF-8 字节数之和 + 每参数一个 NUL 分隔符。
 * execve 按字节计算参数区，估算口径与内核一致（字符数会低估多字节文本）。
 */
export function estimateArgvBytes(argv: string[]): number {
  let total = 0;
  for (const arg of argv) {
    total += Buffer.byteLength(arg, "utf8") + 1;
  }
  return total;
}

/**
 * argv 预算断言：估算超限抛 EngineError(prompt_too_large)（恢复指引三条：缩短 task /
 * persona 移 file 通道 / 换 stdin 引擎）。调用点在 preparer（进程创建前，D5）。
 */
export function assertArgvBudget(argv: string[], limitBytes: number = DEFAULT_ARGV_BUDGET_BYTES): void {
  const actual = estimateArgvBytes(argv);
  if (actual > limitBytes) {
    throw promptTooLargeError(actual, limitBytes);
  }
}
