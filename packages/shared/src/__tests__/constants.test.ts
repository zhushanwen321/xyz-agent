/**
 * shared constants 单测（wave-env-check TC1）。
 *
 * 守护：ENV_WHITELIST_PREFIXES 含 6 个 ambient 具体变量名（spec §7 最小暴露面）；
 * AMBIENT_ENV_NAMES 与追加名单一致（shell-env.ts 回写复用，漂移会破坏 ambient 透传）。
 */
import { describe, it, expect } from 'vitest'
import { ENV_WHITELIST_PREFIXES, AMBIENT_ENV_NAMES } from '../constants.js'

const AMBIENT_NAMES = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_PROFILE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GCLOUD_PROJECT',
  'CLOUDSDK_REGION',
]

describe('ENV_WHITELIST_PREFIXES ambient 名单', () => {
  it('含全部 6 个 ambient 具体变量名（spec §7 最小暴露面）', () => {
    for (const name of AMBIENT_NAMES) {
      expect(ENV_WHITELIST_PREFIXES).toContain(name)
    }
  })

  it('不含 AWS_/GOOGLE_ 整前缀（防生产凭证进 pi 子进程）', () => {
    expect(ENV_WHITELIST_PREFIXES).not.toContain('AWS_')
    expect(ENV_WHITELIST_PREFIXES).not.toContain('GOOGLE_')
    expect(ENV_WHITELIST_PREFIXES).not.toContain('CLOUDSDK_')
  })
})

describe('AMBIENT_ENV_NAMES', () => {
  it('与 ENV_WHITELIST_PREFIXES 的 ambient 追加名单一致（无漂移）', () => {
    expect([...AMBIENT_ENV_NAMES].sort()).toEqual([...AMBIENT_NAMES].sort())
    // 名单去重
    expect(new Set(AMBIENT_ENV_NAMES).size).toBe(AMBIENT_ENV_NAMES.length)
  })
})
