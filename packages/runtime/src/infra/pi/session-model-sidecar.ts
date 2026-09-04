/**
 * Session model binding sidecar（`<sessionFile>.model.json`）家族。
 *
 * 从 session-file-utils.ts 提取（行数合规）：三函数与字段声明随迁，函数体逐字节不变。
 * persistBindingSidecar / readBindingSidecar 公共骨架仍留在 session-file-utils.ts
 * （preset/project/agent/model 四家族共用；为此在原文件最小导出，本文件 import 复用，
 * 形成 session-file-utils ⇄ 本模块的函数级循环引用——两侧均为 function 声明，ESM
 * 实例化期完成绑定，运行时调用无 TDZ 风险）。
 *
 * 与 preset/project/agent sidecar 家族并列独立：switchModel / setThinkingLevel /
 * create / fork / restore 各写点写生效值，scanner scanSessionMeta 第七读提取进
 * ScannedSessionMeta（设计 docs/design/composer-model-session-isolation.md D1）。
 */
import { persistBindingSidecar, readBindingSidecar } from './session-file-utils.js'

/**
 * model binding 的扫描字段声明（ScannedSessionMeta extends 收编）。
 *
 * 字段 SSOT 与 model sidecar IO 同文件归属（随本家族自 session-file-utils.ts 迁出，
 * 行数合规）；session-binding-fields.ts 的 BindingFieldKey 经
 * OptionalKeys<ScannedSessionMeta> 派生，对 extends 收编的字段照常生效，注册表无需改动。
 */
export interface ModelBindingFields {
  /**
   * 该 session 绑定的模型 id（从 .model.json sidecar 读，model binding）。
   * 'provider/modelId' 格式。undefined 表示无 sidecar（历史 session / create 时未绑定）。
   */
  modelId?: string
  /**
   * 该 session 绑定的思考等级（从 .model.json sidecar 读，model binding）。
   * undefined 表示无 sidecar（历史 session / create 时未绑定）。
   */
  thinkingLevel?: string
}

/**
 * 计算 session model binding sidecar 路径。
 * `<sessionFile>.model.json`：session 的模型与思考等级绑定信息（与 preset/project/agent sidecar 并列独立）。
 */
export function modelSidecarPath(filePath: string): string {
  return filePath + '.model.json'
}

/**
 * 将 session 模型绑定持久化到 sidecar `.model.json`（model binding）。
 *
 * switchModel / setThinkingLevel 生效后调用，记录 session 当前绑定的 modelId 与 thinkingLevel。
 * 与 preset/project/agent sidecar 并列独立。
 *
 * [规则 #6] session JSONL 文件不存在时**绝不创建 sidecar**：pi 延迟写入窗口内
 * existsSync=false → 静默跳过。
 *
 * @param filePath session JSONL 绝对路径（sidecar = modelSidecarPath(filePath)）
 * @param modelId 模型 id（'provider/modelId' 格式）
 * @param thinkingLevel 思考等级
 */
export function persistModelBinding(filePath: string, modelId: string, thinkingLevel: string): void {
  if (!filePath || !modelId) return
  persistBindingSidecar(
    filePath,
    modelSidecarPath,
    { modelId, thinkingLevel, version: 1 as const },
    'model',
  )
}

/**
 * 从 `.model.json` sidecar 读取模型绑定。
 *
 * scanSessionMeta 第七读：与 agent/project/preset 同批次提取，结果合并进
 * ScannedSessionMeta.modelId / thinkingLevel，享受 sessionMetaCache 缓存。
 *
 * @returns { modelId, thinkingLevel }；sidecar 不存在/损坏/字段非法 → undefined
 */
export function readModelBinding(filePath: string): { modelId: string; thinkingLevel: string } | undefined {
  return readBindingSidecar(modelSidecarPath(filePath), (binding) => {
    const b = binding as Record<string, unknown> | undefined
    if (b && typeof b.modelId === 'string' && b.modelId !== '') {
      return {
        modelId: b.modelId,
        thinkingLevel: typeof b.thinkingLevel === 'string' ? b.thinkingLevel : '',
      }
    }
    return undefined
  })
}
