/**
 * W1 TC17: i18n key 完整性（zh-CN 与 en-US connection.remoteConnect 命名空间同步）。
 *
 * 验两语言 remoteConnect 子树 key 集合完全相等（locale-sync-check.test.ts 是全局闸门，
 * 本测试聚焦 remoteConnect 命名空间，定位更精确）。
 *
 * 运行：npx vitest run src/__tests__/remote/remote-connect-i18n.test.ts
 */
import { describe, it, expect } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN/connection'
import enUS from '@/i18n/locales/en-US/connection'

interface LocaleObject {
  [key: string]: string | LocaleObject
}

/** 拍平嵌套对象为 '.' 路径集合 */
function flattenKeys(obj: LocaleObject, prefix = ''): Set<string> {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') {
      for (const sub of flattenKeys(v as LocaleObject, fullKey)) out.add(sub)
    } else {
      out.add(fullKey)
    }
  }
  return out
}

describe('W1 TC17: connection.remoteConnect i18n key 双侧同步', () => {
  it('zh-CN 与 en-US 的 remoteConnect 子树 key 集合完全相等', () => {
    const zhKeys = flattenKeys(zhCN.remoteConnect as LocaleObject)
    const enKeys = flattenKeys(enUS.remoteConnect as LocaleObject)
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k))
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k))
    expect(missingInEn).toEqual([])
    expect(missingInZh).toEqual([])
  })

  it('remoteConnect 命名空间含必备顶层 key（tabs/paste/manual/saved/probe）', () => {
    const required = ['tabs', 'paste', 'manual', 'saved', 'probe', 'hostLabel', 'switchBtn', 'disconnectBtn']
    for (const key of required) {
      expect(zhCN.remoteConnect[key as keyof typeof zhCN.remoteConnect]).toBeDefined()
      expect(enUS.remoteConnect[key as keyof typeof enUS.remoteConnect]).toBeDefined()
    }
  })

  it('tabs 含 paste/manual/saved 三个子 key', () => {
    expect(zhCN.remoteConnect.tabs.paste).toBeTruthy()
    expect(zhCN.remoteConnect.tabs.manual).toBeTruthy()
    expect(zhCN.remoteConnect.tabs.saved).toBeTruthy()
  })

  it('probe 含 authFailed/networkFailed/timeout/probing 四态文案', () => {
    expect(zhCN.remoteConnect.probe.authFailed).toContain('认证')
    expect(zhCN.remoteConnect.probe.networkFailed).toContain('无法连接')
    expect(zhCN.remoteConnect.probe.timeout).toContain('超时')
    expect(zhCN.remoteConnect.probe.probing).toBeTruthy()
  })

  it('stub 占位 key remoteConnectStubHint 已删除（被真实组件替代）', () => {
    expect(zhCN.remoteConnectStubHint).toBeUndefined()
    expect(enUS.remoteConnectStubHint).toBeUndefined()
  })
})
