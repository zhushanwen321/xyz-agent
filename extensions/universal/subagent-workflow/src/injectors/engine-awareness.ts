// src/injectors/engine-awareness.ts
//
// [engine-awareness U3] 引擎感知检测编排。设计权威源：
// docs/design/subagent-engine-awareness-injection.md §2.3 物理数据流 /
// §3.3 D1（per-turn poll）、D1b（lastEngine 初始化与静默基线化）、D2（reload 先行）、
// D3（通知通道）、D5（三态读取语义）。
//
// 职责：per-turn（before_agent_start）三态 poll 全局 config → 与 per-session
// lastEngine diff → 变更时按硬约束顺序编排：提交读取结果到路由缓存（D2，先于一切——
// 只改注入不改路由会出现「prompt 说引擎 B、实际派发跑引擎 A」，权威信息源说谎）
// → sendMessage 对话流通知（D3/D4，短文案不含任何模型清单）→ 更新 lastEngine。
//
// 本模块是无状态纯编排（依赖注入式，可测）；状态（lastEngine）与宿主能力
// （readConfig / applyRead / sendMessage）由 index.ts engine handler 装配注入。

import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { GlobalConfigReadResult } from "../execution/config.ts";
import { DEFAULT_ENGINE_ID, normalizeEngineId } from "../execution/engine/registry.ts";

const logger = getLogger("subagents");

/** 引擎变更通知 customType（D3；renderer/测试按此识别引擎变更消息）。 */
export const ENGINE_CHANGE_CUSTOM_TYPE = "subagent-engine-changed";

// normalizeEngineId 单一权威源在 registry.ts，此处再导出保持既有导入面（index.ts
// 与测试经本模块导入）不断裂。
export { normalizeEngineId };

/**
 * 引擎变更通知文案（设计 §3.1 英文基准，三行结构逐字骨架；D4：不含任何模型清单，
 * 清单只活在 system prompt 现值一份）。指路段按目标引擎参数化，与
 * <current_subagent_engine> 恒在段的分界语义一致：目标 pi → 指向核心段
 * <available_provider_models>；非 pi → 指向该引擎清单段 <available_<engine>_models>。
 */
export function buildEngineChangeNotice(from: string, to: string): string {
  const modelsLine =
    to === DEFAULT_ENGINE_ID
      ? "Use pi-registry ids from <available_provider_models> for explicit models;"
      : `Use ids from <available_${to}_models> for explicit models;`;
  return [
    `Subagent default engine changed: ${from} → ${to} (effective this turn).`,
    modelsLine,
    "omit `model` to inherit. The <current_subagent_engine> section reflects the current state.",
  ].join("\n");
}

/** 检测编排依赖（注入式）。生产装配在 index.ts engine handler；测试用 stub。 */
export interface EngineAwarenessDeps {
  /** 三态读取全局 config（D5；生产 = () => readGlobalConfig(getAgentDir())）。 */
  readConfig(): GlobalConfigReadResult;
  /**
   * D2：将本 turn 三态读取结果提交路由缓存（生产 = ModelConfigService.applyGlobalConfig，
   * 纯赋值幂等；failed 已由编排层早退，到达此调用的必为 ok/absent）。
   */
  applyRead(read: GlobalConfigReadResult): void;
  /** 对话流通知投递（D3；生产 = pi.sendMessage(message, {})，不设 triggerTurn）。 */
  sendMessage(message: {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }): void;
  /** per-session lastEngine 读取（undefined = 未基线化，D1b）。 */
  getLastEngine(): string | undefined;
  /** per-session lastEngine 写入（仅合法引擎 id，不写 undefined）。 */
  setLastEngine(engine: string): void;
}

/** 单次 per-turn 检测的编排结果（测试断言面 + 诊断留痕消费）。 */
export type EngineAwarenessOutcome =
  | { outcome: "changed"; from: string; to: string }
  | { outcome: "unchanged"; engine: string }
  | { outcome: "baseline"; engine: string }
  | { outcome: "read-failed"; reason: string };

/**
 * 单个 session 的 per-turn 引擎检测编排（§2.3 数据流 ①② 步；③ 渲染归 index.ts）。
 *
 * 分派（D5 三态 × D1b 基线）：
 *   - read failed → 保持 lastEngine 不动、不提交缓存、不通知（防 torn write 瞬间伪通知）；
 *     read-failure warn 日志由 readGlobalConfig 内部落，此处只返回结果。
 *   - lastEngine === undefined（session_start 初始化读失败的兜底形态）→ 静默基线化为
 *     当前目标值：不算变更、不发通知（防「changed: undefined → zcode」首 turn 伪通知）。
 *   - last === target（absent 归一后同值也在内）→ 无事。
 *   - last ≠ target（含 ENOENT=合法缺省）→ 提交缓存先行 → 通知 → 记账，三步同 turn。
 *
 * 抛错面：不主动 try-catch——readGlobalConfig 三态返回不抛，applyRead/sendMessage 的
 * 生产实现各自吞错；handler 顶层 catch 兜底（fail-safe 不阻塞 agent loop）。
 */
export function runEngineAwarenessTurn(deps: EngineAwarenessDeps): EngineAwarenessOutcome {
  const read = deps.readConfig();
  if (read.status === "failed") {
    return { outcome: "read-failed", reason: read.reason };
  }
  const target = normalizeEngineId(read.config.defaultEngine);
  const last = deps.getLastEngine();
  if (last === undefined) {
    // D1b（修订）：基线化前把本 turn 读取结果提交到单例缓存。baseline 形态可能来自
    // session_start 读取失败（lastEngine 未设置 + Service 缓存回落缺省）而文件此后被
    // 修好——若只记账不提交，缓存/路由/状态段永停旧值且永不通知（「改 config 不生效」
    // 以更隐蔽形态复活）。apply 纯赋值——检测值与缓存值构造性同源，重复提交无害。
    deps.applyRead(read);
    deps.setLastEngine(target);
    return { outcome: "baseline", engine: target };
  }
  if (last === target) {
    return { outcome: "unchanged", engine: target };
  }
  // D2 顺序硬约束：先提交读取结果到路由缓存（本 turn 路由 + 渲染同源生效）→ 再通知 → 再记账。
  deps.applyRead(read);
  deps.sendMessage({
    customType: ENGINE_CHANGE_CUSTOM_TYPE,
    content: buildEngineChangeNotice(last, target),
    display: true,
    details: { from: last, to: target },
  });
  deps.setLastEngine(target);
  logger.debug(
    `[engine-awareness] default engine changed: ${last} -> ${target} (route reloaded, notice sent)`,
  );
  return { outcome: "changed", from: last, to: target };
}
