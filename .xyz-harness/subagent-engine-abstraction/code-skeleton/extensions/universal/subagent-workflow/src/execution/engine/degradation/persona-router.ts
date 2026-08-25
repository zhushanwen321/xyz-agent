// execution/engine/degradation/persona-router.ts
//
// 公共降级层 ④：persona 路由（file/flag/prompt 三策略 + argv 长度估算前置拦截，D4/D5）。
// 按 capabilities.personaInjection 分流注入通道；argv-only 引擎（zcode/kimi）超长时
// 在 prepare 期报 prompt_too_large（禁止 spawn 后撞 E2BIG 才失败）。
// persona 路由优先 file/flag 已为超长场景分流大头，task 文本通常较短。

import type { EngineCapabilities, PersonaSpec } from "../types.ts";

/** persona 注入通道决策结果（launcher 据此组装 argv / prompt 段）。 */
export type PersonaChannel =
  | { kind: "file"; path: string }        // persona 落盘文件，引擎 flag 引用
  | { kind: "flag"; value: string }       // flag 直传（引擎原生 persona flag）
  | { kind: "prompt"; segment: string };  // prompt 拼接段（zcode 类唯一通道；schema 仿真段也走此通道）

/** argv 总长估算（字节；超限报 prompt_too_large 的判据，PreparedExecution.argvEstimateBytes 数据源）。 */
export function estimateArgvBytes(argv: readonly string[]): number {
  // 透传级纯函数：argv 各段长度 + 分隔符 1 字节/段（E2BIG 前置估算）。
  return argv.reduce((sum, part) => sum + Buffer.byteLength(part, "utf8") + 1, 0);
}

/**
 * persona 三策略路由（D4）。
 * 接线：按 capabilities.personaInjection 分流；prompt 通道（zcode 类）把 persona 段
 * 与 schema 仿真段一并并入 prompt 拼接。
 */
export function routePersona(
  persona: PersonaSpec | undefined,
  capabilities: EngineCapabilities,
): PersonaChannel | undefined {
  if (!persona) return undefined;
  switch (capabilities.personaInjection) {
    case "flag":
      return { kind: "flag", value: buildFlagValue(persona) };
    case "file":
      return { kind: "file", path: buildPersonaFilePath(persona) };
    case "prompt":
      return { kind: "prompt", segment: buildPromptSegment(persona) };
  }
}

function buildFlagValue(persona: PersonaSpec): string {
  // flag 值组装（引擎具体 flag 名由 launcher 映射；此处产出中立值）。
  void persona;
  throw new Error("skeleton: persona flag value assembly");
}

function buildPersonaFilePath(persona: PersonaSpec): string {
  // persona 落盘路径（poolDir 下单次性产物——PreparedExecution.spawnedFiles 登记）。
  void persona;
  throw new Error("skeleton: persona file path (poolDir-scoped)");
}

function buildPromptSegment(persona: PersonaSpec): string {
  // prompt 段组装（agentRef 人设正文 + appendSystemPrompt 段拼接顺序）。
  void persona;
  throw new Error("skeleton: persona prompt segment assembly");
}
