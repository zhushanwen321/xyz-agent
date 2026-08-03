import { describe, expect, it } from 'vitest'
import { PermissionConstants, PluginRpcErrorCodes } from '../../plugin-sdk/src/types'

describe('plugin-sdk freeze 分层（AC12 前半：const 冻结）', () => {
  it('PermissionConstants 已冻结（Object.isFrozen === true）', () => {
    expect(Object.isFrozen(PermissionConstants)).toBe(true)
  })

  it('PluginRpcErrorCodes 已冻结（Object.isFrozen === true）', () => {
    expect(Object.isFrozen(PluginRpcErrorCodes)).toBe(true)
  })

  it('PermissionConstants 字面量值完整（冻结不丢字段）', () => {
    expect(PermissionConstants).toEqual({
      TOOLS_REGISTER: 'tools.register',
      HOOKS_REGISTER: 'hooks.register',
      SESSIONS_SEND_MESSAGE: 'sessions.sendMessage',
      SESSIONS_READ_STATE: 'sessions.readState',
      STORAGE_ACCESS: 'storage.access',
      NOTIFY: 'notify',
    })
  })

  it('PluginRpcErrorCodes 错误码值完整（冻结不丢字段）', () => {
    expect(PluginRpcErrorCodes).toEqual({
      RPC_TIMEOUT: -32000,
      PERMISSION_DENIED: -32001,
      PLUGIN_NOT_FOUND: -32010,
      PLUGIN_NOT_ACTIVE: -32011,
      STORAGE_FULL: -32040,
      PAYLOAD_TOO_LARGE: -32021,
      METHOD_NOT_FOUND: -32601,
      INTERNAL_ERROR: -32603,
    })
  })

  it('strict 模式修改 PermissionConstants 抛 TypeError', () => {
    // Object.freeze 对象在 strict 模式下赋值/defineProperty 均抛 TypeError
    expect(() => {
      Object.defineProperty(PermissionConstants, 'EXTRA_PERMISSION', { value: 'x.y', enumerable: true })
    }).toThrow(TypeError)
  })

  it('strict 模式修改 PluginRpcErrorCodes 抛 TypeError', () => {
    expect(() => {
      Object.defineProperty(PluginRpcErrorCodes, 'NEW_ERROR_CODE', { value: -99999, enumerable: true })
    }).toThrow(TypeError)
  })

  it('SDK 侧冻结与 runtime 源一致（sync 传播验证）', () => {
    // runtime 源经 sync-types.sh 传播：SDK 的 const 就是 runtime 的 const（同一字面量）
    expect(PermissionConstants.TOOLS_REGISTER).toBe('tools.register')
    expect(PluginRpcErrorCodes.INTERNAL_ERROR).toBe(-32603)
  })
})
