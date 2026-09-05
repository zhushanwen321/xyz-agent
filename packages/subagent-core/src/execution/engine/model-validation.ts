// src/execution/engine/model-validation.ts
//
// [u-h2] 引擎感知的派发期 model 校验入口 + 错误文案构造。设计权威源：
// docs/design/timeout-audit-hygiene-batch.md §3.2（D2-1 路由先行 / D2-2 validateModel
// 可选面 / D2-3「引擎与模型不配套」文案 / D2-4 pi 未命中跨引擎候选）。
//
// 背景（§2.2 双重错配）：model 校验曾固定用 pi registry 且时机在引擎路由之前——
// zcode 合法模型被误导性拒绝（F2-A）、pi 模型过校验后到 zcode 执行期才炸（F2-B）。
// 修复定案：校验源 = 目标引擎 registry（EnginePort.validateModel 可选面），时机 =
// 路由之后的派发同步期（record 创建前，不产生孤儿 record）。
//
// 两个调用点共享本入口与错误文案（D2-2 调用点双路径覆盖）：
//   ① chat 路径 subagent-service.executeViaEngine（非 pi 分支）；
//   ② workflow 路径 subprocess-agent-runner.run（route.engine.run 之前，非 pi 分支）。

import { stripThinkingSuffix } from "../../shared/model-ref.ts";
import type { EnginePort } from "./port.ts";
import { DEFAULT_ENGINE_ID } from "./registry.ts";

/** 错误消息中列出的目标引擎可用清单上限（防超长错误信息；与 shared/model-ref 同量级口径）。 */
const ENGINE_MODEL_LIST_LIMIT = 20;

// ============================================================
// 场景 2：engine+model 不配套的结构化错误（D2-3）
// ============================================================

/**
 * 「引擎与模型不配套」错误（设计 §3.2.1 场景 2）。code 沿用 §3.3.3 错误规格表的
 * model_not_available（与 ZcodePrepareError 同码——同一失败域的早抛形态）。
 */
export class EngineModelMismatchError extends Error {
  readonly code = "model_not_available";
  /** 恢复指引（错误 → 权威源 → 重试闭环；EngineError.recovery 同构字段）。 */
  readonly recovery: string;

  constructor(message: string, recovery: string) {
    super(message);
    this.name = "EngineModelMismatchError";
    this.recovery = recovery;
  }
}

/**
 * 非 pi 引擎的派发同步期 model 校验（两路径统一入口）。
 *
 * - 引擎实现 validateModel：同步裁决（含 undefined = 查引擎缺省模型），返回 canonical
 *   全名供 record.model 留痕；失败包装为 EngineModelMismatchError（场景 2 文案：
 *   点破 registry 独立 + 目标引擎可用清单 + 按引擎区分的省略语义修正动作）。
 * - 引擎未实现 validateModel：返回 modelRef 原样（透传给其 prepare 期校验兜底——
 *   现状语义，未来引擎零强制接入）。
 *
 * @param engine   路由解析出的目标引擎
 * @param modelRef 显式 model（调用参数或 agent .md frontmatter；undefined = 引擎缺省语义）
 * @returns canonical ref（引擎裁决后全名）；未实现校验面时 = modelRef 原样
 */
export function validateModelForEngine(
  engine: EnginePort,
  modelRef: string | undefined,
): string | undefined {
  if (engine.id === DEFAULT_ENGINE_ID) return modelRef; // 防御：pi 不经此入口（走既有三层解析链）
  if (typeof engine.validateModel !== "function") return modelRef;
  try {
    return engine.validateModel(modelRef).canonicalRef;
  } catch (err) {
    throw buildMismatchError(engine, modelRef, err);
  }
}

/**
 * 场景 2 文案构造（D2-3）：① 点破 registry 独立；② 列目标引擎可用清单（数据源
 * listModels；引擎未实现时省略清单行，保留引擎原始错误作诊断行）；③ 👉 修正动作
 * （清单重试 / 省略 model 用引擎缺省——pi 的「继承主 agent」语义对非 pi 引擎是错误
 * 指引，此处按引擎缺省表述）。
 */
function buildMismatchError(engine: EnginePort, modelRef: string | undefined, cause: unknown): EngineModelMismatchError {
  const ref = modelRef === undefined || modelRef.trim() === "" ? "(engine default)" : modelRef;
  const lines = [
    `model '${ref}' is not available on engine '${engine.id}'.`,
    `Engine registries are independent — ids in <available_provider_models> (pi registry) do NOT apply to '${engine.id}' dispatches.`,
  ];
  const available = safeListModels(engine);
  if (available.length > 0) {
    lines.push(`${engine.id} models with configured credentials:`);
    lines.push(`  ${available.slice(0, ENGINE_MODEL_LIST_LIMIT).join(", ")}${available.length > ENGINE_MODEL_LIST_LIMIT ? ", ..." : ""}`);
  }
  // 引擎缺省模型名（validateModel(undefined) 成功才给——失败时省略句不带具体名，
  // 缺省本身也不可用属于凭据级故障，引擎原始错误行已覆盖诊断）。
  const engineDefault = safeEngineDefault(engine);
  lines.push(
    `👉 Retry with one of the above (exact string), or omit \`model\` to use the '${engine.id}' engine default` +
      (engineDefault !== undefined ? ` (${engineDefault})` : "") +
      `.`,
  );
  // 引擎侧原始裁决失败原因（provider 未配凭据 / 模型未启用等）——诊断行，避免包装层吞掉细节。
  lines.push(`Engine said: ${cause instanceof Error ? cause.message : String(cause)}`);
  const recovery =
    `Retry with an exact model id from the '${engine.id}' list above, or omit the \`model\` param to use the '${engine.id}' engine default` +
    (engineDefault !== undefined ? ` (${engineDefault})` : "") +
    `.`;
  return new EngineModelMismatchError(lines.join("\n"), recovery);
}

// ============================================================
// 场景 3：pi registry 未命中的跨引擎纠错候选（D2-4）
// ============================================================

/** notFoundError 的结构化标记（shared/model-ref.ts 挂载；跨引擎反查的识别面）。 */
interface RefNotFoundMarker {
  refNotFound?: boolean;
  refInput?: string;
}

/**
 * pi registry 未命中时反查其他已注册引擎的 listModels（D2-4）：**唯一**引擎全等命中
 * （strip thinking 后缀后与清单 id 全等——对齐零宽容原则，模糊匹配不参与建议）才追加
 * 「该 id 属于引擎 X」候选段；多引擎命中/零命中原样返回（既有文案零回归——V2-4③）。
 *
 * @param err        resolveModel 抛出的错误（须带 refNotFound 标记才处理）
 * @param engineIds  已注册引擎清单（registry.listEngines 快照）
 * @param getEngineFn 引擎获取（registry.getEngine；测试注入）
 * @returns 原错误（无可附候选）或追加候选段的新错误（不 mutate 原错误）
 */
export function withCrossEngineHint(
  err: unknown,
  engineIds: readonly string[],
  getEngineFn: (id: string) => EnginePort | undefined,
): unknown {
  if (!(err instanceof Error)) return err;
  const marker = err as Error & RefNotFoundMarker;
  if (marker.refNotFound !== true || marker.refInput === undefined) return err;
  const clean = stripThinkingSuffix(marker.refInput);

  let matchedEngineId: string | undefined;
  let matchCount = 0;
  for (const id of engineIds) {
    if (id === DEFAULT_ENGINE_ID) continue; // pi 是裁决源本身，不参与反查
    const engine = getEngineFn(id);
    if (engine === undefined || typeof engine.listModels !== "function") continue;
    let ids: string[];
    try {
      // listModels 契约允许返回 null（= 与主 agent 模型体系一致，无引擎清单）——按零清单处理
      ids = engine.listModels()?.map((m) => m.id) ?? [];
    } catch {
      continue; // 单引擎清单读取失败不阻塞反查（可发现性降级语义）
    }
    if (ids.includes(clean)) {
      matchCount++;
      matchedEngineId ??= id;
    }
  }
  if (matchCount !== 1 || matchedEngineId === undefined) return err;
  return new Error(
    `${err.message}\n` +
      `This id matches the registry of engine '${matchedEngineId}'.\n` +
      `👉 Retry with engine: '${matchedEngineId}', or use a pi model from <available_provider_models>, ` +
      `or omit \`model\` to inherit the main agent model.`,
  );
}

// ============================================================
// 内部：引擎面的失败安全读取
// ============================================================

/** 引擎可用清单（listModels 失败安全——校验错误路径不再叠加清单读取故障；null 契约按零清单）。 */
function safeListModels(engine: EnginePort): string[] {
  if (typeof engine.listModels !== "function") return [];
  try {
    return engine.listModels()?.map((m) => m.id) ?? [];
  } catch {
    return [];
  }
}

/** 引擎缺省模型（validateModel(undefined)；失败安全返回 undefined）。 */
function safeEngineDefault(engine: EnginePort): string | undefined {
  if (typeof engine.validateModel !== "function") return undefined;
  try {
    return engine.validateModel(undefined).canonicalRef;
  } catch {
    return undefined;
  }
}
