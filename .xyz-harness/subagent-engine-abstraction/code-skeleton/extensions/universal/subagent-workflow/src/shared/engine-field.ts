// shared/engine-field.ts
//
// agent .md frontmatter `engine` 字段解析（issues #4①；meta-parser 扩展）。
// 配置错误前置暴露：agent 解析期发现未注册 engine id → engine_not_found
// （错误指向注册表清单 + 配置文件路径），不留到运行时（AC-1.3）。
// 落点：parseResourceMeta 的 AgentMeta 增补 engine 字段（kind=agent 专属，workflow 串类 reject）。

import type { AgentMeta } from "@real/shared/resource-meta.ts";

/** frontmatter 字段名（agent .md：`engine: zcode`）。 */
export const ENGINE_FIELD = "engine";

/** AgentMeta + engine 扩展（实现期并入 resource-meta.ts 的 AgentMeta 定义；骨架经交叉类型接线真实类型）。 */
export type AgentMetaWithEngine = AgentMeta & { engine?: string };

/** frontmatter 值校验：非空字符串才有效（畸形值 reject——对齐 typecheckMeta 严格化纪律）。 */
export function parseEngineFieldValue(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** agent 解析期前置校验（engine_not_found 前置暴露——AC-1.3）。 */
export function validateEngineIdOrThrow(id: string, registeredIds: readonly string[]): void {
  if (!registeredIds.includes(id)) {
    // 错误指向注册表清单 + 配置文件路径（§3.3.3 engine_not_found 恢复指引）。
    throw new Error(
      `engine_not_found: agent frontmatter 引用了未注册引擎 "${id}"（已注册：${registeredIds.join(", ")}）；` +
        "检查 agent .md 的 engine 字段或全局默认引擎配置",
    );
  }
}
