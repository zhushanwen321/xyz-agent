/**
 * 插件权限检查器
 *
 * 根据插件的 trustLevel 和 granted permissions 判断
 * 是否允许调用特定方法。
 *
 * 规则：
 * - built-in / trusted 插件: 全部放行
 * - sandbox 插件: 需要在 granted map 中有对应权限
 * - 未知插件: 拒绝
 */

import type { PluginRegistry } from './plugin-registry.js'
import { PermissionStorage } from './plugin-permission-storage.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

export class PluginPermissionChecker {
  private registry: PluginRegistry
  private granted = new Map<string, Set<string>>()
  private storage: PermissionStorage

  constructor(registry: PluginRegistry, storage?: PermissionStorage) {
    this.registry = registry
    this.storage = storage ?? new PermissionStorage(
      join(homedir(), '.xyz-agent', 'plugins'),
    )
  }

  /**
   * 检查插件是否有权调用指定方法。
   *
   * @param pluginId 插件 ID
   * @param method 权限标识（如 'tools.register'）
   * @returns true 表示允许，false 表示拒绝
   */
  check(pluginId: string, method: string): boolean {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) return false

    // trusted / built-in 插件始终放行
    if (descriptor.trustLevel === 'trusted' || descriptor.source === 'built-in') {
      return true
    }

    // sandbox 插件检查 granted map
    const permissions = this.granted.get(pluginId)
    if (!permissions) return false
    return permissions.has(method)
  }

  /**
   * 授予插件权限。
   * 追加到已授予权限集合，不覆盖已有权限。
   *
   * @param pluginId 插件 ID
   * @param permissions 权限列表
   */
  grant(pluginId: string, permissions: string[]): void {
    const existing = this.granted.get(pluginId)
    if (existing) {
      for (const p of permissions) existing.add(p)
    } else {
      this.granted.set(pluginId, new Set(permissions))
    }
  }

  /**
   * 返回尚未审批的权限列表。
   * Activator 在激活插件时调用，用于判断是否需要弹出权限审批 UI。
   *
   * @param pluginId 插件 ID
   * @param permissions 插件声明的权限列表
   * @returns 尚未审批的权限子集
   */
  getUnapproved(pluginId: string, permissions: string[]): string[] {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) return permissions

    // trusted / built-in 插件不需要审批
    if (descriptor.trustLevel === 'trusted' || descriptor.source === 'built-in') {
      return []
    }

    const granted = this.granted.get(pluginId)
    if (!granted) return permissions

    return permissions.filter(p => !granted.has(p))
  }

  /**
   * 撤销插件的所有权限。
   *
   * @param pluginId 插件 ID
   */
  revoke(pluginId: string): void {
    this.granted.delete(pluginId)
  }

  /**
   * 从磁盘加载已保存的权限数据。
   */
  async load(): Promise<void> {
    const data = await this.storage.load()
    for (const [pluginId, permissions] of data) {
      this.granted.set(pluginId, new Set(permissions))
    }
  }

  /**
   * 保存当前权限数据到磁盘。
   */
  async save(): Promise<void> {
    const data = new Map<string, string[]>()
    for (const [pluginId, permissions] of this.granted) {
      data.set(pluginId, [...permissions])
    }
    await this.storage.save(data)
  }
}
