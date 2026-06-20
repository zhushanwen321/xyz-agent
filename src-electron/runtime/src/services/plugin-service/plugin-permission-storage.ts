/**
 * 插件权限持久化存储
 *
 * 负责读写 <dir>/permissions.json。底层用 JsonStore（read-through + ENOENT 容错
 * + atomicWrite），对外保留 async load/save 签名以维持 PluginPermissionChecker /
 * PluginService 的调用契约不变（async 方法内调 sync IO 合法，KB 级文件无感）。
 */

import { join } from 'node:path'
import { JsonStore } from '../../utils/json-store.js'

const PERMISSIONS_FILE = 'permissions.json'

type PermissionsRecord = Record<string, string[]>

export class PermissionStorage {
  private store: JsonStore<PermissionsRecord>

  constructor(dir: string) {
    this.store = new JsonStore<PermissionsRecord>(
      join(dir, PERMISSIONS_FILE),
      {},
      {
        deserialize: (raw): PermissionsRecord => {
          const obj: PermissionsRecord = {}
          if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
              if (Array.isArray(v)) obj[k] = v
            }
          }
          return obj
        },
      },
    )
  }

  /**
   * 从磁盘加载权限数据。
   * 文件不存在或 JSON 损坏时返回空 Map。
   */
  async load(): Promise<Map<string, string[]>> {
    const record = this.store.read()
    return new Map(Object.entries(record))
  }

  /**
   * 保存权限数据到磁盘（atomic write）。
   */
  async save(data: Map<string, string[]>): Promise<void> {
    const record: PermissionsRecord = {}
    for (const [k, v] of data) {
      record[k] = v
    }
    this.store.write(record)
  }
}
