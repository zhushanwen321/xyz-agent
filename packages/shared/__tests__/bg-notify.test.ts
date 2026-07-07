import { describe, it, expect } from 'vitest'
import { parseBgNotifyDetails } from '../src/message'
import type { BgNotifyRecord } from '../src/message'

describe('parseBgNotifyDetails', () => {
  const validRecord: Record<string, unknown> = {
    id: 'job-1',
    status: 'done',
    agent: 'coder',
    model: 'claude-4.5',
    result: 'Done.',
    startedAt: 1000,
    endedAt: 13000,
  }

  it('单条形态：返回 BgNotifyRecord', () => {
    const d = parseBgNotifyDetails(validRecord)
    expect(d).not.toBeNull()
    expect(!('batch' in (d as object))).toBe(true)
    const rec = d as BgNotifyRecord
    expect(rec.id).toBe('job-1')
    expect(rec.status).toBe('done')
    expect(rec.agent).toBe('coder')
    expect(rec.model).toBe('claude-4.5')
    expect(rec.startedAt).toBe(1000)
    expect(rec.endedAt).toBe(13000)
  })

  it('批量形态：{batch, items} → 返回批量', () => {
    const d = parseBgNotifyDetails({
      batch: true,
      items: [validRecord, { ...validRecord, id: 'job-2', status: 'failed' }],
    })
    expect(d).not.toBeNull()
    expect('batch' in (d as object)).toBe(true)
    const batch = d as { batch: boolean; items: BgNotifyRecord[] }
    expect(batch.items).toHaveLength(2)
    expect(batch.items[1].status).toBe('failed')
  })

  it('批量中过滤掉非法 item（缺必需字段）', () => {
    const d = parseBgNotifyDetails({
      batch: true,
      items: [
        validRecord,
        { status: 'done' }, // 缺 id/agent/startedAt
      ],
    })
    const batch = d as { batch: boolean; items: BgNotifyRecord[] }
    expect(batch.items).toHaveLength(1)
    expect(batch.items[0].id).toBe('job-1')
  })

  it('批量 items 全非法 → 返回 null', () => {
    const d = parseBgNotifyDetails({ batch: true, items: [{ foo: 'bar' }] })
    expect(d).toBeNull()
  })

  it('null / undefined / 非 object → null', () => {
    expect(parseBgNotifyDetails(null)).toBeNull()
    expect(parseBgNotifyDetails(undefined)).toBeNull()
    expect(parseBgNotifyDetails('string')).toBeNull()
    expect(parseBgNotifyDetails(123)).toBeNull()
  })

  it('单条缺必需字段（id/status/agent/startedAt）→ null', () => {
    expect(parseBgNotifyDetails({ status: 'done', agent: 'x', startedAt: 1 })).toBeNull() // 缺 id
    expect(parseBgNotifyDetails({ id: 'x', agent: 'y', startedAt: 1 })).toBeNull() // 缺 status
    expect(parseBgNotifyDetails({ id: 'x', status: 'done', startedAt: 1 })).toBeNull() // 缺 agent
    expect(parseBgNotifyDetails({ id: 'x', status: 'done', agent: 'y' })).toBeNull() // 缺 startedAt
  })

  it('status 非法值 → null', () => {
    expect(parseBgNotifyDetails({ ...validRecord, status: 'unknown' })).toBeNull()
  })

  it('可选字段缺失时正常解析', () => {
    const minimal = { id: 'x', status: 'cancelled', agent: 'y', startedAt: 1 }
    const rec = parseBgNotifyDetails(minimal) as BgNotifyRecord
    expect(rec.id).toBe('x')
    expect(rec.status).toBe('cancelled')
    expect(rec.model).toBeUndefined()
    expect(rec.result).toBeUndefined()
    expect(rec.endedAt).toBeUndefined()
    expect(rec.patchFile).toBeUndefined()
  })
})
