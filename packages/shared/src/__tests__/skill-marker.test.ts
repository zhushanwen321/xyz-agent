/**
 * skill-marker 单测：私有标记语法（D3）、降级块形态（D7）、CJK 感知估算（D6）。
 *
 * 重点验收面：标记序列化/解析往返无损（含 location 缺省、引号/反斜杠转义边界）、
 * 降级块构建/解析往返、CJK 估算边界（纯中文/纯英文/混合/空串/全角标点/代码密集）、
 * 解析位置切片（后续 core 反解析依赖 index/length 保留标记前后正文）。
 */
import { describe, it, expect } from 'vitest'
import {
  SKILL_MARKER_TAG,
  SKILLS_BLOCK_TAG,
  SKILL_FALLBACK_GUIDANCE,
  CONTEXT_WINDOW_RATIO,
  CJK_CHAR_RE,
  escapeSkillAttr,
  unescapeSkillAttr,
  buildSkillMarker,
  parseSkillMarkers,
  buildSkillsFallbackBlock,
  parseSkillsFallbackBlocks,
  estimateTokens,
} from '../skill-marker'

describe('buildSkillMarker', () => {
  it('name + location 产出标记形态', () => {
    expect(buildSkillMarker('cw-cli', '/abs/path/SKILL.md')).toBe(
      '<xyz-skill name="cw-cli" location="/abs/path/SKILL.md"/>',
    )
  })

  it('location 缺省时不输出该属性', () => {
    expect(buildSkillMarker('cw-cli')).toBe('<xyz-skill name="cw-cli"/>')
  })

  it('location 空串等价缺省（归一为不输出属性）', () => {
    expect(buildSkillMarker('cw-cli', '')).toBe('<xyz-skill name="cw-cli"/>')
  })
})

describe('属性值转义（escape/unescape）', () => {
  it('引号与反斜杠均转义为反斜杠前缀', () => {
    expect(escapeSkillAttr('a"b\\c')).toBe('a\\"b\\\\c')
  })

  it('反转义还原转义对；孤立反斜杠 + 普通字符（如 \\n 字面）原样保留', () => {
    expect(unescapeSkillAttr('a\\"b\\\\c')).toBe('a"b\\c')
    expect(unescapeSkillAttr('C:\\new')).toBe('C:\\new')
  })

  it('连续混合序列往返无损（防单遍扫描二次转义）', () => {
    const samples = ['a\\"b', '\\\\\\', '"', '\\', '\\\\\\"x', '&quot;&amp;']
    for (const s of samples) {
      expect(unescapeSkillAttr(escapeSkillAttr(s))).toBe(s)
    }
  })
})

describe('parseSkillMarkers 往返无损', () => {
  it('常规 name + location 往返', () => {
    const marker = buildSkillMarker('code-review-graph', '/Users/x/.agents/skills/code-review-graph/SKILL.md')
    const parsed = parseSkillMarkers(`前文 ${marker} 后文`)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('code-review-graph')
    expect(parsed[0].location).toBe('/Users/x/.agents/skills/code-review-graph/SKILL.md')
  })

  it('location 缺省往返后保持缺省（不产生 undefined/空串错位）', () => {
    const parsed = parseSkillMarkers(buildSkillMarker('cw-cli'))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('cw-cli')
    expect(parsed[0].location).toBeUndefined()
  })

  it('路径含空格往返无损', () => {
    const loc = '/Users/x/My Skills/SKILL.md'
    const parsed = parseSkillMarkers(buildSkillMarker('cw-cli', loc))
    expect(parsed[0].location).toBe(loc)
  })

  it('location 含引号/反斜杠的转义往返无损', () => {
    const trickyLocations = [
      '/Users/x/说"你好"/SKILL.md',
      'C:\\Users\\x\\SKILL.md',
      'a\\b"c\\\\d/SKILL.md',
      '/path/ends\\',
    ]
    for (const loc of trickyLocations) {
      const parsed = parseSkillMarkers(`前 ${buildSkillMarker('cw-cli', loc)} 后`)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].location).toBe(loc)
    }
  })

  it('name 含转义字符往返无损（解析器对属性值不做业务校验，忠实还原）', () => {
    const parsed = parseSkillMarkers(buildSkillMarker('a"b\\c'))
    expect(parsed[0].name).toBe('a"b\\c')
  })

  it('残缺标记不解析（顺序错乱 / 非自闭合 / 未闭合引号 / 尾部截断）——破坏即透传（D8）', () => {
    expect(parseSkillMarkers('<xyz-skill location="/b.md" name="a"/>')).toHaveLength(0)
    expect(parseSkillMarkers('<xyz-skill name="a">')).toHaveLength(0)
    expect(parseSkillMarkers('<xyz-skill name="a" location="/b">')).toHaveLength(0)
    expect(parseSkillMarkers('<xyz-skill name="a location="/b"/>')).toHaveLength(0)
    expect(parseSkillMarkers('<xyz-skill name="a" loc')).toHaveLength(0)
    expect(parseSkillMarkers('正文无标记')).toHaveLength(0)
  })

  it('混排多标记返回精确位置切片（前后正文可无损还原）', () => {
    const m1 = buildSkillMarker('a')
    const m2 = buildSkillMarker('b', '/b.md')
    const text = `帮我看看 ${m1} 中间说明 ${m2} 收尾`
    const parsed = parseSkillMarkers(text)
    expect(parsed).toHaveLength(2)
    // index 与独立定位交叉验证（防 index 计算漂移）
    expect(parsed[0].index).toBe(text.indexOf(m1))
    expect(parsed[1].index).toBe(text.indexOf(m2))
    expect(parsed[0].length).toBe(m1.length)
    expect(parsed[1].length).toBe(m2.length)
    // 按区间切片：正文全部保留（u3 core 反解析依赖此契约）
    expect(text.slice(0, parsed[0].index)).toBe('帮我看看 ')
    expect(text.slice(parsed[0].index + parsed[0].length, parsed[1].index)).toBe(' 中间说明 ')
    expect(text.slice(parsed[1].index + parsed[1].length)).toBe(' 收尾')
  })
})

describe('buildSkillsFallbackBlock（D7 降级块）', () => {
  it('单 skill：块形态 + 指引行精确断言', () => {
    const block = buildSkillsFallbackBlock([{ name: 'cw-cli', location: '/c/SKILL.md' }])
    expect(block).toBe(
      [
        '<xyz-skills>',
        '<xyz-skill name="cw-cli" location="/c/SKILL.md"/>',
        '</xyz-skills>',
        '请使用 read 工具加载上述 skill 文件后再继续任务',
      ].join('\n'),
    )
  })

  it('多 skill：每标记独立一行、location 缺省不输出属性', () => {
    const block = buildSkillsFallbackBlock([
      { name: 'a', location: '/a.md' },
      { name: 'b' },
    ])
    expect(block).toBe(
      [
        '<xyz-skills>',
        '<xyz-skill name="a" location="/a.md"/>',
        '<xyz-skill name="b"/>',
        '</xyz-skills>',
        SKILL_FALLBACK_GUIDANCE,
      ].join('\n'),
    )
  })

  it('指引行文案常量精确匹配设计 D7 定稿', () => {
    expect(SKILL_FALLBACK_GUIDANCE).toBe('请使用 read 工具加载上述 skill 文件后再继续任务')
  })
})

describe('parseSkillsFallbackBlocks（D7 降级块解析）', () => {
  it('构建 → 解析往返：多 skill 全部还原（含 location 缺省）', () => {
    const block = buildSkillsFallbackBlock([
      { name: 'code-review-graph', location: '/x/SKILL.md' },
      { name: 'code-simplify' },
    ])
    const blocks = parseSkillsFallbackBlocks(`前文\n${block}\n后文`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].skills).toHaveLength(2)
    expect(blocks[0].skills[0]).toMatchObject({ name: 'code-review-graph', location: '/x/SKILL.md' })
    expect(blocks[0].skills[1]).toMatchObject({ name: 'code-simplify' })
    expect(blocks[0].skills[1].location).toBeUndefined()
  })

  it('块位置切片：块前后正文保留', () => {
    const block = buildSkillsFallbackBlock([{ name: 'a' }])
    const text = `正文头\n${block}\n尾`
    const blocks = parseSkillsFallbackBlocks(text)
    expect(blocks[0].index).toBe(text.indexOf(`<${SKILLS_BLOCK_TAG}>`))
    expect(text.slice(0, blocks[0].index)).toBe('正文头\n')
    expect(text.slice(blocks[0].index + blocks[0].length)).toBe('\n尾')
  })

  it('正文混排多个降级块逐个命中', () => {
    const b1 = buildSkillsFallbackBlock([{ name: 'a' }])
    const b2 = buildSkillsFallbackBlock([{ name: 'b', location: '/b.md' }])
    const blocks = parseSkillsFallbackBlocks(`甲 ${b1} 乙 ${b2} 丙`)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].skills[0].name).toBe('a')
    expect(blocks[1].skills[0].name).toBe('b')
  })

  it('指引行被改写删除时块本身仍识别（提取能力不失效）', () => {
    const stripped = '<xyz-skills>\n<xyz-skill name="a" location="/a.md"/>\n</xyz-skills>'
    const text = `前\n${stripped}\n后`
    const blocks = parseSkillsFallbackBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].skills[0].name).toBe('a')
    // 区间止于闭合标签（指引行不存在，可选组不吞入），切片交叉验证
    expect(blocks[0].index).toBe(text.indexOf(`<${SKILLS_BLOCK_TAG}>`))
    expect(text.slice(blocks[0].index, blocks[0].index + blocks[0].length)).toBe(stripped)
    expect(text.slice(blocks[0].index + blocks[0].length)).toBe('\n后')
  })

  it('文本无降级块返回空数组；游离单标记不算块', () => {
    expect(parseSkillsFallbackBlocks('纯文本消息')).toHaveLength(0)
    expect(parseSkillsFallbackBlocks(buildSkillMarker('a'))).toHaveLength(0)
  })
})

describe('estimateTokens（D6 CJK 感知估算）', () => {
  it('纯中文：CJK × 1.0', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('纯英文：÷4', () => {
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('中英混合：CJK × 1.0 + 非 CJK ÷ 4（空格计入非 CJK）', () => {
    expect(estimateTokens('你好ab')).toBe(2.5)
    // '中文 abc 中文' = 4 CJK + 5 非 CJK（空格 a b c 空格）
    expect(estimateTokens('中文 abc 中文')).toBe(4 + 5 / 4)
  })

  it('全角标点计入 CJK（U+FF01！/ U+FF0C，/ U+3002。）', () => {
    expect(estimateTokens('你好！')).toBe(3)
    expect(estimateTokens('你好，世界。')).toBe(6)
  })

  it('代码密集样本（base64 长串）：全部按非 CJK ÷ 4', () => {
    const b64 =
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkhQCMkJSYqKCk='
    expect(estimateTokens(b64)).toBe(b64.length / 4)
  })

  it('全角空格（U+3000）计入 CJK', () => {
    expect(estimateTokens('　')).toBe(1)
  })
})

describe('常量与 CJK 字符类定义', () => {
  it('阈值常量为 0.8（单一调参处）', () => {
    expect(CONTEXT_WINDOW_RATIO).toBe(0.8)
  })

  it('标签名常量与构建/解析产物一致', () => {
    expect(SKILL_MARKER_TAG).toBe('xyz-skill')
    expect(SKILLS_BLOCK_TAG).toBe('xyz-skills')
  })

  it('CJK 区间边界：五个区间逐一边缘码位判定', () => {
    // [否, 是] 对：区间外沿/内沿各一
    const edges: Array<[string, boolean]> = [
      ['\u2FFF', false], ['\u3000', true], ['\u303F', true], ['\u3040', false],
      ['\u33FF', false], ['\u3400', true], ['\u4DBF', true], ['\u4DC0', false],
      ['\u4DFF', false], ['\u4E00', true], ['\u9FFF', true], ['\uA000', false],
      ['\uF8FF', false], ['\uF900', true], ['\uFAFF', true], ['\uFB00', false],
      ['\uFEFF', false], ['\uFF01', true], ['\uFFEF', true], ['\uFFF0', false],
    ]
    for (const [ch, expected] of edges) {
      expect(CJK_CHAR_RE.test(ch)).toBe(expected)
    }
  })

  it('半角字母数字与 emoji 不属 CJK（按非 CJK ÷4 侧计入）', () => {
    expect(CJK_CHAR_RE.test('a')).toBe(false)
    expect(CJK_CHAR_RE.test('1')).toBe(false)
    expect(CJK_CHAR_RE.test('😀')).toBe(false)
  })
})
