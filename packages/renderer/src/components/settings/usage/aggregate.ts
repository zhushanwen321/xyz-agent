/**
 * 用量统计前端聚合工具。
 *
 * 从 UsageRow[] 行集切片聚合出七个子组件所需的视图数据。
 * 移植自 docs/page-design/usage-dashboard.html 的 aggregate() 逻辑。
 *
 * totalTokens 口径：input + output + cacheRead + cacheWrite 四项，不含 reasoning。
 * pi 落盘的 totalTokens 含 reasoning，本模块按四项和计算，与 demo 对齐。
 */
import type { UsageRow } from '@xyz-agent/shared'

/* ── 聚合后指标（与 UsageMetrics 对齐，但 cost 字段名不同） ── */
export interface AggMetrics {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  messages: number
}

/** provider 颜色阶梯上限 */
const MAX_PROVIDER_COLORS = 5

/** provider 颜色 CSS 变量映射（--chart-p1..p5） */
const PROVIDER_COLORS: Record<string, string> = {}

/** 按使用量降序分配 provider 色阶梯（p1 占比最高） */
function assignProviderColors(perProv: Record<string, AggMetrics>): void {
  const sorted = Object.keys(perProv)
    .sort((a, b) => totalTokens(perProv[b]) - totalTokens(perProv[a]))
  sorted.forEach((pid, i) => {
    PROVIDER_COLORS[pid] = `var(--chart-p${Math.min(i + 1, MAX_PROVIDER_COLORS)})`
  })
}

/** 获取 provider 对应的 chart 色变量 */
export function getProviderColor(pid: string): string {
  return PROVIDER_COLORS[pid] ?? 'var(--chart-p5)'
}

/* ── 工具函数 ── */

export function newMetrics(): AggMetrics {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 }
}

export function accumulate(target: AggMetrics, source: AggMetrics): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.cost += source.cost
  target.messages += source.messages
}

/** 总 token = input + output + cacheRead + cacheWrite */
export function totalTokens(u: AggMetrics): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

/** 指标值：根据 metric 选择 token 总量或费用 */
export function metricValue(u: AggMetrics, metric: 'tokens' | 'cost'): number {
  return metric === 'cost' ? u.cost : totalTokens(u)
}

/* ── 格式化 ── */

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

const MILLION = 1e6
const TEN_MILLION = 1e7
const THOUSAND = 1e3

export function fmtCompact(n: number): string {
  if (n >= MILLION) return (n / MILLION).toFixed(n >= TEN_MILLION ? 0 : 1) + 'M'
  if (n >= THOUSAND) return (n / THOUSAND).toFixed(0) + 'k'
  return String(Math.round(n))
}

const COST_TINY_DECIMALS = 3
const COST_SMALL_THRESHOLD = 0.01
const COST_MEDIUM_THRESHOLD = 100
const COST_NORMAL_DECIMALS = 2

export function fmtUSD(n: number): string {
  if (!n) return '—'
  if (n < COST_SMALL_THRESHOLD) return '$' + n.toFixed(COST_TINY_DECIMALS)
  if (n < COST_MEDIUM_THRESHOLD) return '$' + n.toFixed(COST_NORMAL_DECIMALS)
  return '$' + Math.round(n).toLocaleString('en-US')
}

const PERCENT_MULTIPLIER = 100

export function fmtPct(x: number): string {
  return (x * PERCENT_MULTIPLIER).toFixed(1) + '%'
}

const LOG_BASE = 10
// eslint-disable-next-line no-magic-numbers -- 「nice number」算法规范值（Heckbert 1990），不可语义化
const NICE_FACTORS = [1, 2, 2.5, 5, 10] as const
// eslint-disable-next-line no-magic-numbers -- 同上，与 NICE_FACTORS 对齐的分档阈值
const NICE_THRESHOLDS = [1, 2, 2.5, 5] as const

export function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const f = v / Math.pow(LOG_BASE, exp)
  let nf = NICE_FACTORS[NICE_FACTORS.length - 1]
  for (let i = 0; i < NICE_THRESHOLDS.length; i++) {
    if (f <= NICE_THRESHOLDS[i]) {
      nf = NICE_FACTORS[i]
      break
    }
  }
  return nf * Math.pow(LOG_BASE, exp)
}

/* ── 日期工具（本地时区） ── */

export function toLocalDate(dateStr: string): Date {
  // dateStr 是 'YYYY-MM-DD' 本地时区字符串
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function fmtMMDD(d: Date): string {
  return `${String(d.getMonth() + 1)}/${String(d.getDate())}`
}

export function fmtISO(d: Date): string {
  const y = d.getFullYear()
  const PAD_WIDTH = 2
  const m = String(d.getMonth() + 1).padStart(PAD_WIDTH, '0')
  const day = String(d.getDate()).padStart(PAD_WIDTH, '0')
  return `${y}-${m}-${day}`
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
export function fmtWeekday(d: Date): string {
  return '周' + WEEKDAYS[d.getDay()]
}

/* ── 过滤器状态 ── */

export interface FilterState {
  /** 关闭的 provider 集合 */
  offProv: Set<string>
  /** 单看模型（null = 不单看） */
  isolate: string | null
  /** 时间范围：7 / 30 / 90 / 0(全部) */
  range: number
  /** 指标：token 总量 or 费用 */
  metric: 'tokens' | 'cost'
}

/* ── 每日视图行 ── */

export interface DayView {
  date: Date
  dateStr: string
  provs: Record<string, AggMetrics>
  dTot: AggMetrics
}

/* ── 排名行 ── */

export interface RankRow {
  name: string
  metrics: AggMetrics
  provider?: string
  provs?: Record<string, AggMetrics>
}

/* ── 聚合结果 ── */

export interface AggregatedData {
  perDay: DayView[]
  perModel: Record<string, AggMetrics>
  perProv: Record<string, AggMetrics>
  tot: AggMetrics
  msgs: number
  activeDays: number
  peak: { v: number; d: string | null }
  nDays: number
}

/* ── 核心聚合 ── */

/**
 * 从 UsageRow[] 聚合出全部视图数据。
 *
 * @param rows - 原始行集（date × provider × model × project）
 * @param filter - 过滤器状态
 * @param allDateStrs - 全量日期字符串数组（用于热力日历，传入全部 rows 的去重日期）
 */
export function aggregate(
  rows: UsageRow[],
  filter: FilterState,
): AggregatedData {
  // 按 date 分组
  const byDate = new Map<string, UsageRow[]>()
  for (const row of rows) {
    const arr = byDate.get(row.date) ?? []
    arr.push(row)
    byDate.set(row.date, arr)
  }

  // 以全量 rows 计算 provider 色序（过滤变化不重排）
  const fullPerProv: Record<string, AggMetrics> = {}
  for (const row of rows) {
    if (!fullPerProv[row.provider]) fullPerProv[row.provider] = newMetrics()
    const u: AggMetrics = {
      input: row.input, output: row.output,
      cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
      cost: row.costUSD, messages: row.messages,
    }
    accumulate(fullPerProv[row.provider], u)
  }
  assignProviderColors(fullPerProv)

  // 确定日期范围
  const sortedDates = [...byDate.keys()].sort()
  let sliceDates: string[]
  let nDays: number
  if (filter.range > 0) {
    // 构造完整日历日序列（今天往回 range 天，本地时区）
    const today = new Date()
    const dates: string[] = []
    for (let i = filter.range - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      dates.push(fmtISO(d))
    }
    sliceDates = dates
    nDays = filter.range
  } else {
    // 全部：维持有数日期全集
    sliceDates = sortedDates
    nDays = sortedDates.length
  }

  const perDay: DayView[] = []
  const perModel: Record<string, AggMetrics> = {}
  const perProv: Record<string, AggMetrics> = {}
  const tot = newMetrics()
  let msgs = 0
  let activeDays = 0
  const peak = { v: 0, d: null as string | null }

  for (const dateStr of sliceDates) {
    const date = toLocalDate(dateStr)
    const dayRows = byDate.get(dateStr) ?? []
    const provs: Record<string, AggMetrics> = {}
    const dTot = newMetrics()
    let has = false

    for (const row of dayRows) {
      if (filter.offProv.has(row.provider)) continue
      if (filter.isolate && row.model !== filter.isolate) continue

      has = true
      msgs += row.messages

      const u: AggMetrics = {
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        cost: row.costUSD,
        messages: row.messages,
      }

      if (!provs[row.provider]) provs[row.provider] = newMetrics()
      accumulate(provs[row.provider], u)
      accumulate(dTot, u)

      if (!perModel[row.model]) perModel[row.model] = newMetrics()
      accumulate(perModel[row.model], u)

      if (!perProv[row.provider]) perProv[row.provider] = newMetrics()
      accumulate(perProv[row.provider], u)
    }

    if (has) {
      activeDays++
      accumulate(tot, dTot)
      const v = filter.metric === 'cost' ? dTot.cost : totalTokens(dTot)
      if (v > peak.v) {
        peak.v = v
        peak.d = dateStr
      }
    }

    perDay.push({ date, dateStr, provs, dTot })
  }

  return { perDay, perModel, perProv, tot, msgs, activeDays, peak, nDays }
}

/**
 * 热力日历聚合：独立于 range，使用全量日期数据。
 * 返回 { dateStr -> totalTokens } 映射。
 */
export function aggregateHeatmap(
  rows: UsageRow[],
  filter: Pick<FilterState, 'offProv' | 'isolate'>,
): Map<string, number> {
  const result = new Map<string, number>()
  for (const row of rows) {
    if (filter.offProv.has(row.provider)) continue
    if (filter.isolate && row.model !== filter.isolate) continue
    const prev = result.get(row.date) ?? 0
    result.set(row.date, prev + row.input + row.output + row.cacheRead + row.cacheWrite)
  }
  return result
}

/**
 * 项目谱聚合：按 project × provider 聚合。
 */
const TOP_PROJECTS = 8

export function aggregateProjects(
  rows: UsageRow[],
  filter: Pick<FilterState, 'offProv' | 'isolate' | 'range'>,
): RankRow[] {
  const byDate = new Map<string, UsageRow[]>()
  for (const row of rows) {
    const arr = byDate.get(row.date) ?? []
    arr.push(row)
    byDate.set(row.date, arr)
  }
  const sortedDates = [...byDate.keys()].sort()
  let sliceDates: string[]
  if (filter.range > 0) {
    const today = new Date()
    const dates: string[] = []
    for (let i = filter.range - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      dates.push(fmtISO(d))
    }
    sliceDates = dates
  } else {
    sliceDates = sortedDates
  }

  const projMap = new Map<string, { provs: Record<string, AggMetrics>; total: AggMetrics }>()
  for (const dateStr of sliceDates) {
    for (const row of byDate.get(dateStr) ?? []) {
      if (filter.offProv.has(row.provider)) continue
      if (filter.isolate && row.model !== filter.isolate) continue
      const key = row.project
      if (!projMap.has(key)) projMap.set(key, { provs: {}, total: newMetrics() })
      const entry = projMap.get(key)!
      if (!entry.provs[row.provider]) entry.provs[row.provider] = newMetrics()
      const u: AggMetrics = {
        input: row.input, output: row.output,
        cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
        cost: row.costUSD, messages: row.messages,
      }
      accumulate(entry.provs[row.provider], u)
      accumulate(entry.total, u)
    }
  }

  return [...projMap.entries()]
    .map(([name, { provs, total }]) => ({ name, metrics: total, provs }))
    .sort((a, b) => totalTokens(b.metrics) - totalTokens(a.metrics))
    .slice(0, TOP_PROJECTS)
}

/**
 * 缓存构成聚合：按 model 聚合 cacheRead / input / output+cacheWrite。
 */
const TOP_CACHE_MODELS = 4

export function aggregateCacheMix(
  perModel: Record<string, AggMetrics>,
): { model: string; hit: number; newIn: number; out: number; hitRate: number }[] {
  return Object.entries(perModel)
    .filter(([, u]) => u.cacheRead + u.input > 0)
    .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
    .slice(0, TOP_CACHE_MODELS)
    .map(([model, u]) => {
      const base = u.cacheRead + u.input + u.output + u.cacheWrite
      return {
        model,
        hit: base ? u.cacheRead / base : 0,
        newIn: base ? u.input / base : 0,
        out: base ? (u.output + u.cacheWrite) / base : 0,
        hitRate: u.cacheRead + u.input > 0 ? u.cacheRead / (u.cacheRead + u.input) : 0,
      }
    })
}

/**
 * 明细台账分组：按 provider 分组，每组内按 model 排序。
 */
export function aggregateDetailGroups(
  perProv: Record<string, AggMetrics>,
  perModel: Record<string, AggMetrics>,
  rows: UsageRow[],
): { pid: string; u: AggMetrics; models: { model: string; u: AggMetrics }[] }[] {
  // 建立 model -> provider 映射
  const modelProv = new Map<string, string>()
  for (const row of rows) {
    if (!modelProv.has(row.model)) modelProv.set(row.model, row.provider)
  }

  const provs = Object.keys(perProv)
    .map((pid) => {
      const models = Object.entries(perModel)
        .filter(([m]) => modelProv.get(m) === pid)
        .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
        .map(([model, mu]) => ({ model, u: mu }))
      return { pid, u: perProv[pid], models }
    })
    .sort((a, b) => totalTokens(b.u) - totalTokens(a.u))

  return provs
}
