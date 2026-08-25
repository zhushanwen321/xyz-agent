// 差分探针：全量验证 xyz-agent resolveAvailableLevels 与 pi-ai 实装版
// getSupportedThinkingLevels 在 builtin-providers.json 全部模型上的等价性。
// 用法：node scripts/diff-probe-thinking.mjs（仓库根执行）
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import builtinData from '../packages/runtime/src/generated/builtin-providers.json' with { type: 'json' }
const { resolveAvailableLevels } = await import('../packages/core/src/domain/composer/thinking-levels.ts')

let total = 0
let mismatches = 0
const samples = []

for (const p of builtinData.providers) {
  for (const m of p.models ?? []) {
    total++
    // 快照语义：thinkingLevelMap=null 表示 pi-ai 模型无此字段 → 等价 undefined
    const snapMap = m.thinkingLevelMap === null ? undefined : m.thinkingLevelMap
    const fakePiModel = { reasoning: m.reasoning, thinkingLevelMap: snapMap }
    const expected = getSupportedThinkingLevels(fakePiModel) // pi 权威
    const actual = resolveAvailableLevels(snapMap, m.reasoning) // xyz-agent 实现
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      mismatches++
      if (samples.length < 10) {
        samples.push({ id: `${p.id}/${m.id}`, reasoning: m.reasoning, map: snapMap ?? null, expected, actual })
      }
    }
  }
}

console.log(`total models: ${total}, mismatches: ${mismatches}`)
for (const s of samples) console.log(JSON.stringify(s))
process.exit(mismatches > 0 ? 1 : 0)
