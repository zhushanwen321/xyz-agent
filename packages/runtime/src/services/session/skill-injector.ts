/**
 * SkillInjector —— composer 多 skill 注入的 runtime 预处理（composer-multi-skill-injection P1）。
 *
 * 职责（设计 §3.3）：
 * - D3/D5：解析文本中全部 `<xyz-skill/>` 私有标记（u1 parseSkillMarkers），展开为与 pi
 *   `_expandSkillCommand` 逐字一致的 `<skill>` block，原位替换（保留 chip 与正文相对位置，
 *   block 与相邻正文以空行分隔）；无标记文本零改动
 * - D4：name → SKILL.md 路径以 pi RPC get_commands 的 source:"skill" 项为权威映射，
 *   不自建扫描（避免与 pi loadSkills 双实现漂移）
 * - D6：发送前预检——估算「若全文注入的整条 message」token（CJK 感知，u1 estimateTokens），
 *   超过 0.8 × contextWindow（get_session_stats 实时取）→ 整条降级为 `<xyz-skills>` 标记块
 *   （D7 形态，模型自主 read）；contextWindow 获取失败 fail-safe 降级（不 fail-open）
 * - D8：失效降级必须可见——name 无映射 / SKILL.md 读取失败 / 标记被 hook 改写残缺：
 *   该标记原样保留在 prompt 文本（对齐 pi 未知 skill 透传行为）+ 产出提示 notice，
 *   禁止静默。notice 由调用方（message-dispatcher）经 messageBus 发布
 *
 * 挂载契约（D9）：dispatcher 三入口各恰好单次调用（结构化幂等，不做文本 grep 判重），
 * 在 BeforeSend hook 之后、client.prompt/steer/followUp 之前。
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  buildSkillsFallbackBlock,
  CONTEXT_WINDOW_RATIO,
  estimateTokens,
  parseSkillMarkers,
  SKILL_MARKER_TAG,
  unescapeSkillAttr,
  type ParsedSkillMarker,
  type ServerMessageMapBase,
} from '@xyz-agent/shared'
import type { IPiEngine } from '../ports/pi-engine.js'

/**
 * get_commands 返回的 skill 命令项（ports 翻译层类型的结构化挑选子集，本模块只消费
 * name / source / sourceInfo 三字段）。不直接引用 ports 原类型：check_pi_type_leak
 * （C-comm-02）对 services 层新文件做 Pi[A-Z]* 标识符文本拦截，alias import 的源文本
 * 仍含原标识符（实测命中）；此处的结构化子集与 ports 翻译层类型结构兼容（IPiEngine
 * .getCommands() 返回值可直接赋值），单一事实源仍在 ports/pi-engine.ts。
 */
interface SkillCommandInfo {
  name: string
  source: string
  sourceInfo?: {
    path: string
    source: string
    scope?: string
    origin?: string
    baseDir?: string
  }
}

/** session.skillNotice 的 reason 联合（从 protocol 契约提取，单一事实源；index.ts 未单独导出该联合，不越权补登记）。 */
type SkillNoticeReason = ServerMessageMapBase['session.skillNotice']['reason']

/** 单条提示：事件种类 + 受影响 skill 名（reason 从 protocol 契约提取，与广播 payload 单一事实源）。 */
export interface SkillNotice {
  reason: SkillNoticeReason
  skills: string[]
}

/** 注入结果：注入后待发送文本 + 待发布提示列表（广播编排归 dispatcher，本模块不发消息）。 */
export interface SkillInjectionResult {
  text: string
  notices: SkillNotice[]
}

// ── pi stripFrontmatter 镜像（锚点 @earendil-works/pi-coding-agent 0.84.4
//    dist/utils/frontmatter.js + dist/utils/text.js，逐字对齐）──
//
// 为什么不直接 import pi 包根导出（设计 D5 原意）：pi 包 exports 白名单仅 "." / "./rpc-entry" /
// "./client" 三口子，dist/utils/frontmatter.js 深路径被 exports 拦截；包根 import 的静态依赖图
// 经 index.js → main.js → TUI 组件 → @silvia-odwyer/photon-node（WASM 图像库）全量拖进 tsup
// bundle，违反 noExternal 既有判据（tsup.config.ts「纯 JS 包、无 native addon、体积合理」）。
// 漂移防线等价迁移：u6 探针（check-pi-semantics 场景 8）对「pi 展开输出 vs 本展开器输出」做
// golden diff——stripFrontmatter 行为漂移必然变红，与 import 实现的防漂移效果等价。
//
// yaml throw 分支不镜像：frontmatter 非法的 SKILL.md 在 pi loadSkills 阶段已被过滤
//（skills.js loadSkillFromFile 的 parseFrontmatter catch → skill:null，不进 get_commands 映射），
// 展开阶段不可达，故镜像无需 yaml 依赖（解析成功性由 pi 侧保证，本函数只做文本剥离）。

/** stripBom 镜像（dist/utils/text.js splitBom/stripBom）：剥前导 U+FEFF。 */
function stripBomPi(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content
}

/** frontmatter 开界符长度（`---`，起点偏移与开界判定共用）。 */
const FRONTMATTER_DELIM_LEN = 3
/** 行首闭界符长度（`\n---`，slice 越过闭界的偏移）。 */
const FRONTMATTER_CLOSED_DELIM_LEN = 4

/**
 * stripFrontmatter 镜像：BOM 剥除 → 换行归一 → frontmatter 边界剥离（extractFrontmatter）。
 * 无 frontmatter / 闭合缺失时原文返回；有 frontmatter 时 body 已 trim（对齐实装，pi 展开处
 * 再 trim 一次属幂等，保留同款双 trim 形态以求逐字）。
 */
function stripFrontmatterPi(content: string): string {
  const normalized = stripBomPi(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.startsWith('---')) return normalized
  const endIndex = normalized.indexOf('\n---', FRONTMATTER_DELIM_LEN)
  if (endIndex === -1) return normalized
  return normalized.slice(endIndex + FRONTMATTER_CLOSED_DELIM_LEN).trim()
}

// ── 标记完整性检测（D8 残缺分支）──

/**
 * pi get_commands 的 skill 命令 name 前缀（实装锚点 agent-session.js 0.84.4 :1996
 * `name: \`skill:${skill.name}\``）。映射 key 与展开 block 的 name 插值都必须剥前缀：
 * 私有标记的 name 是裸 skill 名（u1 语法，无前缀），block 的 name 须与 pi 原生展开
 * （`name="${skill.name}"`，无前缀）逐字一致。
 */
const PI_SKILL_COMMAND_PREFIX = 'skill:'

/** 剥 pi 命令 name 的 `skill:` 前缀得裸 skill 名（无前缀输入原样返回，防手滑）。 */
function stripPiSkillCommandPrefix(commandName: string): string {
  return commandName.startsWith(PI_SKILL_COMMAND_PREFIX)
    ? commandName.slice(PI_SKILL_COMMAND_PREFIX.length)
    : commandName
}

/**
 * 标记开头顶点统计：`<xyz-skill` 后紧跟空白 / `/` / `>` 视为标记开头（含完整标记与残缺标记；
 * `<xyz-skills>` 降级块的包裹标签后跟字母 s，不命中——手打降级块不在本模块处理范围）。
 */
const MARKER_OPEN_RE = new RegExp(`<${SKILL_MARKER_TAG}[\\s/>]`, 'g')

/** 残缺片段的 name 尽力提取（片段截断 / 属性缺失时跳过，skills 列表允许为空）。 */
const MALFORMED_NAME_RE = /name="((?:[^"\\]|\\.)*)"/

/** 残缺片段 name 提取的检查窗口：name（≤64 字符，pi MAX_NAME_LENGTH）+ 属性前缀的余量。 */
const MALFORMED_SNIPPET_LEN = 200

/**
 * 统计文本中标记开头顶点，归类哪些是残缺的（parse 未命中的开头顶点）。
 * 一次遍历同时产出存在性判定与 name 尽力提取——提取失败（片段截断/属性缺失）不影响
 * 存在性判定，提示仍须发（D8 禁止静默）。
 */
function scanMalformed(text: string, markers: ParsedSkillMarker[]): { hasMalformed: boolean; names: string[] } {
  const names: string[] = []
  let hasMalformed = false
  for (const m of text.matchAll(MARKER_OPEN_RE)) {
    // matchAll 的 m.index 指向 `<`（正则从 `<` 起匹配）；完整标记集合按位置排除
    if (markers.some((mk) => mk.index === m.index)) continue
    hasMalformed = true
    const snippet = text.slice(m.index, m.index + MALFORMED_SNIPPET_LEN)
    const nameMatch = snippet.match(MALFORMED_NAME_RE)
    if (nameMatch) names.push(unescapeSkillAttr(nameMatch[1]))
  }
  return { hasMalformed, names }
}

// ── 展开文本构建 ─--

/** 求值后的单标记：block=null 表示失效（原样透传该标记 token）。 */
interface MarkerResolution {
  marker: ParsedSkillMarker
  block: string | null
  /** 展开成功时的 SKILL.md 路径（降级块 location 数据源）。 */
  path?: string
}

/**
 * 原位替换构建（D5：保留 chip 与正文相对位置，block 与相邻正文以空行分隔）。
 *
 * 切片规则：标记区间替换为 block（失效标记原样保留）；block 与相邻内容的空行分隔按
 * 「block 前 rstrip 已累积文本 + 补 `\n\n`，block 后的文本 part lstrip」实现——正文语义
 * 字符不动，只归一标记落点的边界空白。pi 原生单 skill 消息形态（block 开头 + args 在后、
 * block 与 args 间 `\n\n`）是本算法在「标记位于文本两端」时的自然特例。
 */
function buildExpandedText(text: string, resolutions: MarkerResolution[]): string {
  let result = ''
  let lastWasBlock = false
  let cursor = 0
  // text part 落在 block 之后时：lstrip 边界空白并前置 `\n\n`（空行分隔由本侧补齐；
  // part 为纯空白时视为不存在，lastWasBlock 保持，由下一 part 继续判定）。
  const appendAfterBlock = (raw: string): void => {
    const stripped = raw.replace(/^\s+/, '')
    if (stripped !== '') {
      result += '\n\n' + stripped
      lastWasBlock = false
    }
  }
  for (const { marker, block } of resolutions) {
    const before = text.slice(cursor, marker.index)
    if (before !== '') {
      if (lastWasBlock) appendAfterBlock(before)
      else {
        result += before
        lastWasBlock = false
      }
    }
    const end = marker.index + marker.length
    if (block === null) {
      result += text.slice(marker.index, end)
      lastWasBlock = false
    } else {
      result = result.replace(/\s+$/, '')
      result += (result === '' ? '' : '\n\n') + block
      lastWasBlock = true
    }
    cursor = end
  }
  const tail = text.slice(cursor)
  if (tail !== '') {
    if (lastWasBlock) appendAfterBlock(tail)
    else result += tail
  }
  return result
}

/**
 * 降级文本构建（D7）：移除全部可展开标记区间（失效/残缺标记与正文保留），正文 trim 后
 * 与 `<xyz-skills>` 降级块以空行拼接；正文为空时仅块。归拢成块 + 单指引行的形态见设计 D7。
 */
function buildFallbackText(text: string, resolutions: MarkerResolution[], skills: ReadonlyArray<{ name: string; location?: string }>): string {
  let stripped = ''
  let cursor = 0
  for (const { marker, block } of resolutions) {
    if (block === null) continue
    stripped += text.slice(cursor, marker.index)
    cursor = marker.index + marker.length
  }
  stripped += text.slice(cursor)
  const body = stripped.trim()
  const block = buildSkillsFallbackBlock(skills)
  return body !== '' ? `${body}\n\n${block}` : block
}

/** skill 名去重（保持首次出现顺序），notice 的 skills 列表归一。 */
function dedupeNames(markers: ReadonlyArray<ParsedSkillMarker>): string[] {
  return [...new Set(markers.map((m) => m.name))]
}

/** 逐 reason 聚合失效 notice（skills 并集去重），供非降级路径产出。 */
function aggregateNotices(groups: Map<SkillNoticeReason, string[]>): SkillNotice[] {
  const notices: SkillNotice[] = []
  for (const [reason, names] of groups) {
    if (names.length === 0) continue
    notices.push({ reason, skills: [...new Set(names)] })
  }
  return notices
}

export class SkillInjector {
  /**
   * 对发送前文本做 skill 注入预处理（无标记文本零改动、零 RPC 开销——预检只在确有
   * 可展开标记时才发起 get_commands / get_session_stats 往返）。
   *
   * 错误面：内部 RPC / fs 失败全部转为降级或透传 + notice（D8 禁止静默），本方法不向
   * 调用方抛业务错误；调用方（dispatcher）把 notices 在 client 发送成功后经 bus 发布。
   */
  async inject(client: IPiEngine, text: string): Promise<SkillInjectionResult> {
    const markers = parseSkillMarkers(text)
    if (markers.length === 0) {
      // 无完整标记：只剩残缺透传分支（hook 改写破坏 / 手打残缺），不发起任何 RPC
      const malformed = scanMalformed(text, markers)
      if (malformed.hasMalformed) {
        return { text, notices: [{ reason: 'marker_malformed', skills: malformed.names }] }
      }
      return { text, notices: [] }
    }

    // ── get_commands 权威映射（D4）。整体失败 → 全部透传（映射服务不可用；降级块需要
    //    映射提供的 location，无从构建，故不走 D6 降级路径），发提示禁止静默。
    let commands: SkillCommandInfo[]
    try {
      commands = await client.getCommands()
    } catch (e) {
      console.warn('[skill-injector] get_commands failed, pass-through all markers:', e instanceof Error ? e.message : String(e))
      return { text, notices: [{ reason: 'mapping_unavailable', skills: dedupeNames(markers) }] }
    }
    // 映射 key 用剥 `skill:` 前缀后的裸 skill 名（与私有标记的 name 同一口径）
    const skillsByName = new Map<string, SkillCommandInfo>()
    for (const cmd of commands) {
      if (cmd.source === 'skill') skillsByName.set(stripPiSkillCommandPrefix(cmd.name), cmd)
    }

    // ── 逐标记求值：映射 → 读 SKILL.md → 构建与 pi 逐字一致的 block（D5 模板）──
    const failGroups = new Map<SkillNoticeReason, string[]>([
      ['skill_missing', []],
      ['skill_read_failed', []],
    ])
    const resolutions: MarkerResolution[] = markers.map((marker) => {
      const cmd = skillsByName.get(marker.name)
      if (!cmd) {
        failGroups.get('skill_missing')!.push(marker.name)
        return { marker, block: null }
      }
      const path = cmd.sourceInfo?.path
      if (typeof path !== 'string' || path === '') {
        // 映射存在但 pi 未给路径（sourceInfo 缺失）：无法读文件，按读取失败处理
        failGroups.get('skill_read_failed')!.push(marker.name)
        return { marker, block: null }
      }
      try {
        const body = stripFrontmatterPi(readFileSync(path, 'utf-8')).trim()
        // References 行 baseDir 取 SKILL.md 所在目录（dirname(path)）——pi 展开用的 skill.baseDir
        // 恒为 skillDir = dirname(filePath)（skills.js :236/:260 实装锚点）。不用 sourceInfo.baseDir：
        // skills.js 的 createSkillSourceInfo 分支（:90-110）虽恒透传 skillDir，但装载链上游可变——
        // resource-loader.js :514-518 的 extension 覆盖链（findSourceInfoForPath 命中时 createSourceInfo
        // 直接采用 extension metadata.baseDir）与 :612 兜底（getDefaultSourceInfoForPath 的 `<...>`
        // 形态返回对象无 baseDir 字段），使 get_commands 的 sourceInfo.baseDir 不保证是 SKILL.md
        // 所在目录（PS-22 真实 pi 探针实证漂移），golden diff 抓到后弃用。
        const baseDir = dirname(path)
        // pi _expandSkillCommand 模板（agent-session.js 0.84.4 :997）逐字：
        // `<skill name="..." location="...">\nReferences are relative to <baseDir>.\n\n<body>\n</skill>`
        // name 用裸 skill 名（get_commands 的 name 带 `skill:` 前缀，pi 原生展开无前缀）；
        // name/baseDir 与 pi 同款直接插值不转义（对齐实装行为）
        const skillName = stripPiSkillCommandPrefix(cmd.name)
        const block = `<skill name="${skillName}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`
        return { marker, block, path }
      } catch (e) {
        console.warn(`[skill-injector] failed to read SKILL.md for "${marker.name}" (${path}):`, e instanceof Error ? e.message : String(e))
        failGroups.get('skill_read_failed')!.push(marker.name)
        return { marker, block: null }
      }
    })

    const invalidNotices = aggregateNotices(failGroups)
    const malformed = scanMalformed(text, markers)
    const invalidAndMalformed = [
      ...invalidNotices,
      ...(malformed.hasMalformed ? [{ reason: 'marker_malformed' as const, skills: malformed.names }] : []),
    ]

    const validSkills = resolutions
      .filter((r): r is MarkerResolution & { block: string; path: string } => r.block !== null)
      .map((r) => ({ name: r.marker.name, location: r.path }))
    if (validSkills.length === 0) {
      // 无可展开标记（全部失效/残缺）：跳过预检，原文透传 + 失效提示
      return { text, notices: invalidAndMalformed }
    }

    // ── 预检（D6）：估算「若全文注入的整条 message」token（展开产物天然含正文 + skill
    //    全文 + 标记/分隔开销），与 0.8 × contextWindow 比较。
    const hypothetical = buildExpandedText(text, resolutions)
    let contextWindow: number | null = null
    try {
      const stats = await client.getSessionStats()
      const w = stats.contextUsage?.contextWindow
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) contextWindow = w
    } catch (e) {
      // fail-safe 降级（D6）：RPC 失败视同窗口不可得，走标记模式降级——设计裁定不重抛
      //（方向安全：放行大消息若真超窗即落持续失败态，代价只是功能减弱一轮）。
      console.warn('[skill-injector] get_session_stats failed (fail-safe fallback):', e instanceof Error ? e.message : String(e))
    }
    if (contextWindow === null) {
      // fail-safe（D6）：窗口信息不可得即降级为标记模式，不放行全文注入——
      // get_session_stats 失败预示 RPC 异常，放行大消息若真超窗即落持续失败态。
      const fallback = buildFallbackText(text, resolutions, validSkills)
      return {
        text: fallback,
        notices: [{ reason: 'context_window_unavailable', skills: validSkills.map((s) => s.name) }, ...invalidAndMalformed],
      }
    }
    if (estimateTokens(hypothetical) > CONTEXT_WINDOW_RATIO * contextWindow) {
      const fallback = buildFallbackText(text, resolutions, validSkills)
      return {
        text: fallback,
        notices: [{ reason: 'budget_exceeded', skills: validSkills.map((s) => s.name) }, ...invalidAndMalformed],
      }
    }
    return { text: hypothetical, notices: invalidAndMalformed }
  }
}
