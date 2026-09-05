/**
 * Composer 多 skill 注入的标记语法与预算估算 SSOT（foundation 模块）。
 *
 * 设计依据：docs/design/composer-multi-skill-injection.md §3.3：
 * - D3：skill segment 序列化产私有标记 `<xyz-skill name="..." location="..."/>`——
 *   与 pi 原生 `<skill>` 展开格式正交，runtime 只认私有标记展开，手打 /skill: 行为零变化
 * - D6：注入量预检的 CJK 感知 token 估算 + 0.8 contextWindow 阈值（常量单一处便于调参）
 * - D7：超预算整条降级为 `<xyz-skills>` 包裹块 + 指引行（模型自主 read 的最小指令形态）
 *
 * 消费方：runtime 注入器（解析/展开/降级）、shared 序列化与 core 反解析（依赖解析位置
 * 切片保留前后正文）、scripts 探针（CJK 正则同源引用）。纯文本语法层，不依赖 node API，
 * renderer barrel 整包 import 安全。
 */

/** `<xyz-skill/>` 单标记标签裸名（构建/解析/降级块三处共用，避免字符串漂移）。 */
export const SKILL_MARKER_TAG = 'xyz-skill'

/** `<xyz-skills>` 降级包裹块标签裸名。 */
export const SKILLS_BLOCK_TAG = 'xyz-skills'

/**
 * 降级块指引行文案（D7 正文定稿，SSOT）。
 * 不带句号：D7 正文引号内无句号（§3.1 场景 2 示意图中的句号属示意排版）；
 * 本模块只保证块与指引行的相对形态（指引行紧跟块后一行），是否补标点由调用方/呈现层决定。
 */
export const SKILL_FALLBACK_GUIDANCE = '请使用 read 工具加载上述 skill 文件后再继续任务'

/**
 * 注入量预检阈值：预估 token > 0.8 × contextWindow 时整条消息降级为标记模式（D6）。
 * 0.2 余量留给 system prompt / 历史占用；CJK 估算取密度上界偏保守，实际触发只会提早不推迟。
 */
export const CONTEXT_WINDOW_RATIO = 0.8

/**
 * D6 估算系数（单一处便于调参，探针/校准回填检查点 6 时同源调整）：
 * - CJK 每字符 token 数：tokenizer 密度区间约 0.6~1，取上界 1.0 = 高估 = 更早降级
 * - 非 CJK 每 token 字符数：英文约 4 chars/token，÷4 为准确值
 */
export const CJK_TOKENS_PER_CHAR = 1.0
export const NON_CJK_CHARS_PER_TOKEN = 4

/**
 * CJK 字符类（D6「CJK 统一表意文字及常用全角标点范围」的具体区间，scripts 探针同源引用）：
 * - U+3000–U+303F CJK 符号和标点（全角空格、。、《》等）
 * - U+3400–U+4DBF 表意文字扩展 A
 * - U+4E00–U+9FFF CJK 统一表意文字（正文汉字主体）
 * - U+F900–U+FAFF CJK 兼容表意文字
 * - U+FF00–U+FFEF 半角及全角形式（全角标点 ！？与全角字母数字——全角数字/字母的
 *   tokenizer 密度接近汉字，按 CJK 计入 1.0 侧保持高估方向）
 *
 * 刻意不带 g 标志：带 g 的共享正则经 .test() 会推进 lastIndex 产生跨调用漏判；
 * 需要全局形态的消费方（探针等）自行 `new RegExp(CJK_CHAR_RE.source, 'g')`。
 */
export const CJK_CHAR_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

/**
 * 属性值转义/反转义：`\` → `\\`、`"` → `\"`。
 *
 * 选反斜杠方案而非 HTML 实体：封闭规则「`\` 后只允许 `\` 或 `"`」无双转义歧义
 * （实体方案遇用户路径含字面 `&quot;` 时反转义顺序会产生歧义）；`&` 等其余字符
 * 原样保留（自建解析器不解析实体）。escape 用单遍 replace——单遍内产出不会再被
 * 同一遍扫描，天然避免二次转义；unescape 同理单遍配对还原。
 */
export function escapeSkillAttr(value: string): string {
  return value.replace(/["\\]/g, (ch) => `\\${ch}`)
}

export function unescapeSkillAttr(raw: string): string {
  return raw.replace(/\\(["\\])/g, '$1')
}

/**
 * 构建单个 `<xyz-skill/>` 自闭合标记（D3）。
 * location 缺省或空串时不输出该属性——空串路径无意义，输出 `location=""` 会污染
 * 反解析结果（空串与缺省在 Segment 语义上等价，统一归一为缺省）。
 */
export function buildSkillMarker(name: string, location?: string): string {
  const locPart =
    location !== undefined && location !== '' ? ` location="${escapeSkillAttr(location)}"` : ''
  return `<${SKILL_MARKER_TAG} name="${escapeSkillAttr(name)}"${locPart}/>`
}

/** 解析出的单标记：name/location 为反转义后的原始值；index/length 供反解析做正文切片。 */
export interface ParsedSkillMarker {
  name: string
  location?: string
  index: number
  length: number
}

/**
 * 属性值捕获片段：`[^"\\]` 逐个吃普通字符，`\\.` 整体吃转义对——保证遇到未转义的
 * `"`（结构边界）立即停止，转义引号不会被误判为标记结束。经 RegExp 构造器拼接复用。
 */
const SKILL_ATTR_VALUE = '((?:[^"\\\\]|\\\\.)*)'

/**
 * 私有标记解析正则。属性顺序固定 name → location（本模块 buildSkillMarker 的唯一生产格式）：
 * 解析刻意不宽松——顺序错乱/非自闭合一律不识别，与 D8「标记被破坏则透传」语义一致，
 * 手打残缺标记不会被误展开。matchAll 克隆正则迭代，无 module 级 lastIndex 残留问题。
 */
const SKILL_MARKER_RE = new RegExp(
  `<${SKILL_MARKER_TAG} name="${SKILL_ATTR_VALUE}"(?: location="${SKILL_ATTR_VALUE}")?/>`,
  'g',
)

/**
 * 全局解析文本中全部 `<xyz-skill/>` 标记（混排在正文中也命中），返回标记区间信息。
 * 调用方（core 反解析）按 index/length 切片即可保留标记前后的全部正文。
 */
export function parseSkillMarkers(text: string): ParsedSkillMarker[] {
  const results: ParsedSkillMarker[] = []
  for (const m of text.matchAll(SKILL_MARKER_RE)) {
    results.push({
      name: unescapeSkillAttr(m[1]),
      ...(m[2] !== undefined ? { location: unescapeSkillAttr(m[2]) } : {}),
      index: m.index,
      length: m[0].length,
    })
  }
  return results
}

/**
 * 构建降级块（D7）：`<xyz-skills>` 包裹全部自闭合标记 + 紧跟一行的指引文案。
 * 归拢成块的取舍见设计（块 + 单指引行的指令遵循率高于散点）；末尾不加换行，
 * 由调用方决定与后文的拼接方式。
 */
export function buildSkillsFallbackBlock(
  skills: ReadonlyArray<{ name: string; location?: string }>,
): string {
  const lines = skills.map((s) => buildSkillMarker(s.name, s.location))
  return [`<${SKILLS_BLOCK_TAG}>`, ...lines, `</${SKILLS_BLOCK_TAG}>`, SKILL_FALLBACK_GUIDANCE].join(
    '\n',
  )
}

/** 解析出的降级块：块内全部标记 + 块整体区间（index/length 供反解析保留块外正文）。 */
export interface ParsedSkillsBlock {
  skills: ParsedSkillMarker[]
  index: number
  length: number
}

/**
 * 降级块解析正则：非贪婪匹配首个闭合标签，并可选吞入紧随一行的指引文案——构建产物
 * 中指引行是块的组成部分，解析区间若止步于闭合标签，反解析按区间切片保留正文时会把
 * 指引行当孤立正文残留。指引行设为可选：hook 改写删掉指引行时块本身仍可识别（提取
 * name/location 的能力不失效）。多块场景靠 g 标志逐个命中；嵌套块不在生产形态中，
 * 首个闭合标签即视为块结束。
 */
const escapeRegExpSource = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SKILLS_BLOCK_RE = new RegExp(
  `<${SKILLS_BLOCK_TAG}>[\\s\\S]*?</${SKILLS_BLOCK_TAG}>(?:\\n${escapeRegExpSource(SKILL_FALLBACK_GUIDANCE)})?`,
  'g',
)

/**
 * 全局解析文本中全部 `<xyz-skills>` 降级块，块内标记复用 parseSkillMarkers 提取
 * （name/location/转义行为与单标记解析完全一致）。文本中无块时返回空数组。
 */
export function parseSkillsFallbackBlocks(text: string): ParsedSkillsBlock[] {
  const results: ParsedSkillsBlock[] = []
  for (const m of text.matchAll(SKILLS_BLOCK_RE)) {
    results.push({ skills: parseSkillMarkers(m[0]), index: m.index, length: m[0].length })
  }
  return results
}

/**
 * CJK 感知 token 估算（D6）：`CJK 字符数 × 1.0 + 非 CJK 字符数 ÷ 4`，系数见
 * CJK_TOKENS_PER_CHAR / NON_CJK_CHARS_PER_TOKEN。保留小数不取整——阈值比较由调用方
 * 完成，取整口径（向上/向下）属调用方语义，本函数不擅自决定。
 *
 * 逐 code point 计数（for-of）：CJK 区间全在 BMP 内不受影响；astral 字符（emoji 等）
 * 按 1 个非 CJK 计，避免 UTF-16 双 code unit 口径混用导致的计数错位。
 */
export function estimateTokens(text: string): number {
  let cjkCount = 0
  let totalCount = 0
  for (const ch of text) {
    totalCount++
    if (CJK_CHAR_RE.test(ch)) cjkCount++
  }
  return cjkCount * CJK_TOKENS_PER_CHAR + (totalCount - cjkCount) / NON_CJK_CHARS_PER_TOKEN
}
