/**
 * Restore 附着辅助（从 session-lifecycle.ts 提取，行数合规）：
 *
 * ① F2/F3 归一化管线：附着前检测 session_end / cwd 死路径并原地归一化
 *    （restore-fork-attach-fix W1；renameSession 非活跃分支共用同一入口，
 *    两处附着前检测/变换必须同源，否则行为漂移）。
 * ② U2/D1 生效值播种：switchSession 成功后 get_state 读回 pi 生效
 *    model+thinkingLevel，经 registerSession 的 metaOverride 播种
 *    （composer-model-session-isolation 设计 §3.3 D2，r3 校准）。
 *    get_state 解析与 create 路径共用 readEffectiveModelFromState（原两处逐字节重复）。
 *
 * [infra 直引豁免] 本模块 import infra/pi（session-file-utils）与 session-lifecycle.ts
 * 的既有四处同属 R3 ports 依赖倒挂豁免（见 session-lifecycle.ts 头注释登记），R3
 * 阶段随 ISessionStore port 扩展一并收口。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { ScannedSessionMeta } from '../../infra/pi/session-file-utils.js'
import { cleanupMigrateResidues, normalizeSessionFileInPlace, persistModelBinding } from '../../infra/pi/session-file-utils.js'

/**
 * 匹配 `"type":"session_end"` 或 `'type':'session_end'`（容忍引号/空格差异）。
 * 用单/双引号字符类容忍 JSON.stringify（双引号）与手写（单引号）两种写法。
 *
 * stripSessionEndEntries（变换）与 containsSessionEndLine（F2/F3 分流判定）共用同一正则
 * ——判定与变换必须同源，否则会出现「判进 F3 却剔不干净」或反向的缝隙。
 */
const SESSION_END_RE = /["']type["']\s*:\s*["']session_end["']/

/**
 * 检测 JSONL 文本是否含 session_end 行（W1 restore-fork-attach-fix F2/F3 分流判定）。
 *
 * 与 stripSessionEndEntries 同款正则逐行检测。W1 设计文档明令禁止用
 * `stripSessionEndEntries(原文) === 原文` 字符串全等做本判定——strip 函数有末尾换行
 * 规范化副作用（原文末尾无 `\n` 时即使零剔除也产出不等文本），全等会把几乎所有文件
 * 误判进 F3 归一化路径。
 */
function containsSessionEndLine(jsonlContent: string): boolean {
  for (const line of jsonlContent.split('\n')) {
    if (line !== '' && SESSION_END_RE.test(line)) return true
  }
  return false
}

/**
 * 从 JSONL 文本中剔除 session_end 行。
 *
 * 背景（动机经 restore-fork-attach-fix §2.3 复核改判保留）：B7 sidecar 方案下 runtime
 * 不再往 JSONL 写 session_end（改写 .meta.json sidecar），但历史 session（迁移前写入的）
 * JSONL 仍可能含 `type:"session_end"` 行。pi 侧 `_buildIndex`（pi-mono
 * session-manager.ts）对所有非 session entry 无差别执行 `byId.set(entry.id);
 * leafId = entry.id`——legacy session_end 行无 id 无 parentId，使 leafId=undefined →
 * 后续 appendMessage 的 parentId 断链 → 全部旧历史不进 LLM 上下文（AI 失忆）。
 * 因此 restore 必须在附着前剔除该类行。
 *
 * 实现按行扫描：命中 SESSION_END_RE 的整行丢弃，其余行原样保留（含换行）。纯文本扫描
 * 不解析 JSON，避免格式异常的行被误吞。
 *
 * @param jsonlContent 原始 JSONL 文本
 * @returns 剔除 session_end 行后的文本（行数可能减少；末尾换行统一补一个）
 */
export function stripSessionEndEntries(jsonlContent: string): string {
  const lines = jsonlContent.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (line === '') continue // split 末尾产生的空串（原末尾换行）跳过，末尾统一补回
    if (SESSION_END_RE.test(line)) continue
    kept.push(line)
  }
  // 末尾统一补一个换行（W2/A-06 注释修正：pi 读取侧按行 trim 分行——session-manager.js
  // parseSessionEntries/parseSessionEntryLine 对内容先 trim 再 split("\n")，末尾 \n 非必须；
  // 补 \n 是保守对齐 pi 写出格式，非 pi 期望）
  return kept.length > 0 ? kept.join('\n') + '\n' : ''
}

/**
 * 对 JSONL 文本首行的 session header 应用 cwd fallback（W11 引入，语义随 W1 更新）。
 *
 * 纯字符串变换（不落盘）：restoreSession 的 F3 归一化管线内调用——session 原始 cwd 已被
 * 删除时，把首行 header 的 cwd 改为 fallback 值，使 pi switch_session 不因 cwd 不存在
 * 失败（pi 加载 header cwd 死路径的 session 直接 throw MissingSessionCwdError，pi-mono
 * session-cwd.ts；RPC switch_session 无 cwdOverride 字段，只能由 xyz 在附着前修）。
 * 变换产物经 normalizeSessionFileInPlace 原地 rename-over 落回原文件。
 *
 * 防御语义与原实现一致：首行缺失/非 session 类型/JSON parse 失败 → 原样返回（不抛）。
 *
 * @param jsonlContent stripSessionEndEntries 后的 JSONL 文本
 * @param fallbackCwd  降级 cwd（调用方传 homedir()）
 * @returns 首行 header.cwd 替换为 fallbackCwd 后的文本；无法解析时原样返回
 */
export function applyHeaderCwdFallback(jsonlContent: string, fallbackCwd: string): string {
  const lines = jsonlContent.split('\n')
  if (!lines[0]) return jsonlContent
  try {
    const header = JSON.parse(lines[0])
    if (typeof header !== 'object' || header === null || header.type !== 'session') {
      return jsonlContent
    }
    header.cwd = fallbackCwd
    lines[0] = JSON.stringify(header)
    return lines.join('\n')
  } catch {
    // 首行 JSON parse 失败：原样返回（交 pi switch_session 报错），不阻断 restore 主流程
    return jsonlContent
  }
}

/**
 * 附着前 F2/F3 分流归一化（restore-fork-attach-fix W1 形态；p1p4-closure W1 起
 * renameSession 非活跃分支共用——两处附着前检测/变换必须同源，否则行为漂移）。
 *
 * 判定：containsSessionEndLine(raw) || cwdFellBack。禁止用
 * stripSessionEndEntries(raw) === raw 字符串全等——strip 有末尾换行规范化副作用
 * （原文末尾无 \n 时零剔除也产出不等文本），见 containsSessionEndLine。
 *
 * 变换（F3 一次性归一化，legacy 文件；每文件最多一次，产物收敛到 F2，幂等）：
 * - strip session_end：legacy 行无 id/parentId，pi _buildIndex 对所有非 session
 *   entry 无差别 byId.set(entry.id); leafId = entry.id（pi-mono session-manager.ts），
 *   session_end 使 leafId=undefined → 新 entry parentId 断链 → 历史不进 LLM 上下文
 * - header cwd fallback：仅 cwd 死时应用（cwdFellBack）——pi 0.84.1 switchSession
 *   内 assertSessionCwdExists 对死 cwd 硬拒绝（pi-mono coding-agent/src/core/
 *   agent-session-runtime.ts switchSession，binary strings 实证见 findings §4.1；
 *   抛 MissingSessionCwdError，pi-mono session-cwd.ts；RPC switch_session 不透传
 *   cwdOverride，只能由 xyz 附着前修）
 *
 * 落盘经 normalizeSessionFileInPlace（同目录临时名 rename-over 原子替换，路径
 * 不变，登记表 §4 ⑨ 合法形态）。判定未命中（正常文件）时零变换：不写不拷贝，
 * 调用方直附着原文件。
 *
 * @param filePath    目标 session JSONL 绝对路径（原地归一化，路径不变）
 * @param cwdFellBack 调用方已判定的 session cwd 死路径标记（检测源 = scanner 从
 *                    header 读出的 ScannedSession.cwd）
 */
export function normalizeInactiveSessionFileIfNeeded(filePath: string, cwdFellBack: boolean): void {
  // 附着前清扫该文件的 .tmp-migrate-* 崩溃/失败残留（差距复审 suggestion 6；F2/F3
  // 两路都过此处——F2 判定未命中会提前 return，清扫必须在其前）。此刻无归一化在途
  //（restore 已销毁同 id 会话），同 basename 残留必然 stale，best-effort 清除。
  cleanupMigrateResidues(filePath)
  const raw = readFileSync(filePath, 'utf-8')
  const needsNormalize = containsSessionEndLine(raw) || cwdFellBack
  if (!needsNormalize) return
  let cleaned = stripSessionEndEntries(raw)
  if (cwdFellBack) {
    cleaned = applyHeaderCwdFallback(cleaned, homedir())
  }
  normalizeSessionFileInPlace(filePath, cleaned)
}

/**
 * 从 pi get_state 回执解析生效 model + thinkingLevel（create/restore 共用解析）。
 *
 * pi get_state 返回 `{ model: { id, provider }, thinkingLevel }` 或扁平字段
 * （modelId）。provider+id 齐全时拼 'provider/modelId'，仅 id 时用裸 id。
 * 字段缺失 → 对应键 undefined（调用方各自决定兜底链）。
 *
 * @param stateData client.getState() 回执（结构未建模，运行时守卫收窄）
 */
export function readEffectiveModelFromState(stateData: unknown): { modelId?: string; thinkingLevel?: string } {
  const stateObj = stateData as Record<string, unknown> | null | undefined
  let modelId: string | undefined
  let thinkingLevel: string | undefined
  if (stateObj?.model && typeof stateObj.model === 'object') {
    const m = stateObj.model as Record<string, unknown>
    const provider = typeof m.provider === 'string' ? m.provider : undefined
    const id = typeof m.id === 'string' ? m.id : undefined
    if (provider && id) modelId = `${provider}/${id}`
    else if (id) modelId = id
  }
  if (!modelId && typeof stateObj?.modelId === 'string') {
    modelId = stateObj.modelId
  }
  if (typeof stateObj?.thinkingLevel === 'string') {
    thinkingLevel = stateObj.thinkingLevel
  }
  return { modelId, thinkingLevel }
}

/**
 * restore 路径的生效值播种（U2/D1）：get_state 读回 + metaOverride 组装 + 写点⑤ sidecar 自愈。
 *
 * r3 校准：metaOverride 恒提供（读回成功/失败两路径同构），每字段独立走
 * 「读回值 → sidecar 扫描值 → ''」兜底链。restore 从不播种全局默认：空串经
 * registerSession 的 ?? 短路阻断 modelOverride/fallbackModelId，composer 按 D3
 * 显示占位而非假值，快照收敛自愈。
 * hydrateBindingMeta restore='none' 不覆写播种值（D1 裁决），所以兜底链在此完成不经过 hydrate。
 *
 * @param client    已附着目标文件的 pi client（switchSession 成功后调用）
 * @param sessionId restore 的 session id（仅用于失败日志，与调用方日志同前缀）
 * @param target    findScannedSession 的扫描 meta（sidecar 兜底值来源）
 * @returns 播种值（恒提供；传给 registerSession 的 metaOverride）
 */
export async function seedRestoreMetaOverride(
  client: IPiEngine,
  sessionId: string,
  target: Pick<ScannedSessionMeta, 'filePath' | 'modelId' | 'thinkingLevel'>,
): Promise<{ modelId: string; thinkingLevel: string }> {
  try {
    const stateData = await client.getState()
    const readback = readEffectiveModelFromState(stateData)
    const restoredModelId = readback.modelId ?? target.modelId ?? ''
    const restoredThinkingLevel = readback.thinkingLevel ?? target.thinkingLevel ?? ''
    const metaOverride = { modelId: restoredModelId, thinkingLevel: restoredThinkingLevel }
    // D1 写点⑤ / E6 自愈闭环：读回成功后用真值覆写 sidecar 过期值（restore 窗口外
    // 切模产生的 .model.json 漂移在此收敛）。catch 分支不写——sidecar 原值保持作下次
    // restore 的兜底源。persistModelBinding 自带 existsSync + 空值/写失败守卫。
    persistModelBinding(target.filePath, restoredModelId, restoredThinkingLevel)
    return metaOverride
  } catch (e) {
    // E2: get_state 读回失败 → 每字段回落 sidecar 扫描值（target 来自 findScannedSession，
    // 含 .model.json 值），仍缺则 '' 占位。与读回成功路径同构：双无值也播种 ''/''，
    // 不保持 undefined 走 registerSession 全局默认（D2 被否谱系：全局默认播种让 restore
    // 窗口显示他 session 的假值，违 G4「不知道显示占位」）。
    console.warn(`[session-lifecycle] restoreSession(${sessionId}): get_state readback failed, falling back to sidecar values`, e)
    return {
      modelId: target.modelId ?? '',
      thinkingLevel: target.thinkingLevel ?? '',
    }
  }
}
