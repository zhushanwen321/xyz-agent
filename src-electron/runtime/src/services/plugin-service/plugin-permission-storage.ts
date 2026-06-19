/**
 * 插件权限持久化存储
 *
 * 负责读写 ~/.xyz-agent/plugins/permissions.json，
 * 使用 atomic write（先写 .tmp 再 rename）确保数据完整性。
 */

import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteAsync } from '../../utils/fs-utils.js'

const PERMISSIONS_FILE = 'permissions.json'

export class PermissionStorage {
  private dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /**
   * 从磁盘加载权限数据。
   * 文件不存在或 JSON 损坏时返回空 Map。
   */
  async load(): Promise<Map<string, string[]>> {
    const filePath = join(this.dir, PERMISSIONS_FILE)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch {
      return new Map()
    }

    try {
      const obj = JSON.parse(raw) as Record<string, string[]>
      const map = new Map<string, string[]>()
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) {
          map.set(k, v)
        }
      }
      return map
    } catch {
      // JSON 损坏时返回空 Map
      return new Map()
    }
  }

  /**
   * 保存权限数据到磁盘（atomic write）。
   * 先写入 .tmp 文件，再 rename 为目标文件。
   */
  async save(data: Map<string, string[]>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const filePath = join(this.dir, PERMISSIONS_FILE)

    const obj: Record<string, string[]> = {}
    for (const [k, v] of data) {
      obj[k] = v
    }

    const JSON_INDENT = 2
    const content = JSON.stringify(obj, null, JSON_INDENT)
    await atomicWriteAsync(filePath, content)
  }
}
