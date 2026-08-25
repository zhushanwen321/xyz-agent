// src/execution/engine/model-prompt.ts
//
// [U7] 引擎模型段 system prompt 注入（模型可发现性）。
//
// 背景：pi 核心在 system prompt 生成 <available_provider_models> 段并教育 agent
// 「subagent/workflow 的 model 参数用这些 id」——该教育对 engine: zcode 等自带
// provider 体系的引擎是误导（pi 的 id 在引擎侧是未知 provider）。本模块按
// 「defaultEngine 开关」（用户拍板 2026-08-25）补齐非默认引擎的模型可发现性：
// defaultEngine 指向非 pi 引擎且该引擎实现 EnginePort.listModels 时，追加
// <available_<engine>_models> 段，与 pi 段形成「一段一引擎」的分界标注。
//
// engine-neutral：遍历注册表驱动，未来引擎实现 listModels 即自动注入，宿主零改动。

import { DEFAULT_ENGINE_ID, getEngine, hasEngine } from "./registry.ts";

/** pi 段之外的引擎才需要清单段（pi 与主 agent 模型体系一致，核心已有段）。 */
const CORE_ENGINE_ID = DEFAULT_ENGINE_ID;

/** 单引擎段格式：XML 包裹 + 分界语义（与 pi 核心段的 <model><id> 形态对齐）。 */
function buildEngineSection(engineId: string, models: Array<{ id: string; name?: string }>): string {
  const lines = models.map((m) =>
    m.name !== undefined ? `<model><id>${m.id}</id><name>${m.name}</name></model>` : `<model><id>${m.id}</id></model>`,
  );
  return [
    `<available_${engineId}_models>`,
    `The following models are available for subagents dispatched with engine '${engineId}' ONLY (their provider registry differs from the main agent's; ids above in <available_provider_models> do NOT apply to engine '${engineId}' dispatches). Omit model to use the engine default.`,
    ...lines,
    `</available_${engineId}_models>`,
  ].join("\n");
}

/**
 * 依据全局 defaultEngine 生成追加段（不含前导换行；无需注入时返回空串）。
 *
 * 规则（用户拍板的开关语义）：
 *   - defaultEngine 为 pi / 缺省 → 不注入（pi 段已由核心提供）；
 *   - defaultEngine 指向已注册且实现 listModels 的引擎 → 注入该引擎段；
 *   - 引擎未实现 listModels / 清单为空 → 不注入（可发现性降级不阻塞，prepare 报错
 *     的事后清单兜底仍在）。
 * fail-safe：任何异常返回空串（注入失败不阻塞 agent loop——与 system-prompt
 * extension 的 before_agent_start 处置一致）。
 */
export function buildEngineModelsPromptAppend(defaultEngine: string | undefined): string {
  try {
    const engineId = defaultEngine?.trim() || CORE_ENGINE_ID;
    if (engineId === CORE_ENGINE_ID) return "";
    if (!hasEngine(engineId)) return "";
    const engine = getEngine(engineId);
    if (engine.listModels === undefined) return "";
    const models = engine.listModels();
    if (models === null || models.length === 0) return "";
    return buildEngineSection(engineId, models);
  } catch {
    return "";
  }
}

/** 测试口：段格式导出（避免测试依赖注册表组装全链）。 */
export const _testHooks = { buildEngineSection, CORE_ENGINE_ID };
