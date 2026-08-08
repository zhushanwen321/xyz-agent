/**
 * shared constants 单测（wave-env-check TC1）。
 *
 * 守护：ENV_WHITELIST_PREFIXES 含 6 个 ambient 具体变量名（spec §7 最小暴露面）；
 * AMBIENT_ENV_NAMES 与追加名单一致（shell-env.ts 回写复用，漂移会破坏 ambient 透传）。
 * 用例拆细（每名一用例）：wave testCommand 的 vitest 输出解析取最后一段计数，
 * 本文件是 testCommand 最后一跳，用例数需 >= wave testCases 数。
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

describe('ENV_WHITELIST_PREFIXES ambient 名单（spec §7 最小暴露面）', () => {
  it('含 GOOGLE_APPLICATION_CREDENTIALS（文件型 ADC 自定义路径，spec §7 点名）', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('GOOGLE_APPLICATION_CREDENTIALS')
  })

  it('含 AWS_PROFILE', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('AWS_PROFILE')
  })

  it('含 GOOGLE_CLOUD_PROJECT', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('GOOGLE_CLOUD_PROJECT')
  })

  it('含 GOOGLE_CLOUD_LOCATION', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('GOOGLE_CLOUD_LOCATION')
  })

  it('含 GCLOUD_PROJECT 与 CLOUDSDK_REGION', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('GCLOUD_PROJECT')
    expect(ENV_WHITELIST_PREFIXES).toContain('CLOUDSDK_REGION')
  })

  it('不含 AWS_/GOOGLE_/CLOUDSDK_ 整前缀（防生产凭证进 pi 子进程）', () => {
    expect(ENV_WHITELIST_PREFIXES).not.toContain('AWS_')
    expect(ENV_WHITELIST_PREFIXES).not.toContain('GOOGLE_')
    expect(ENV_WHITELIST_PREFIXES).not.toContain('CLOUDSDK_')
  })
})

describe('AMBIENT_ENV_NAMES', () => {
  it('与 ENV_WHITELIST_PREFIXES 的 ambient 追加名单一致（无漂移）', () => {
    expect([...AMBIENT_ENV_NAMES].sort()).toEqual([...AMBIENT_NAMES].sort())
  })

  it('名单去重', () => {
    expect(new Set(AMBIENT_ENV_NAMES).size).toBe(AMBIENT_ENV_NAMES.length)
  })

  it('每个名字都在 ENV_WHITELIST_PREFIXES 中（shell-env 回写与白名单透传闭环）', () => {
    for (const name of AMBIENT_ENV_NAMES) {
      expect(ENV_WHITELIST_PREFIXES).toContain(name)
    }
  })
})
