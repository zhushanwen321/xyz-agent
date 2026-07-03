/**
 * WorkspaceService — 业务编排层（#2）。
 *
 * session→workspace 的唯一入口（system-architecture.md §2 seam 纪律）。
 * SessionLifecycle.create（写入时机 A）+ MessageDispatcher.sendPrompt（写入时机 B）
 * 经此 service 触发记录，不直接持有 store。
 *
 * 职责（§3 模块拆分一致）：
 * - INV-1 主守卫（cwd 空串/undefined → 静默跳过；grep 验证点在此）
 * - trim 编排委托 store（debounce 归位 WriteBackCache，不在 service 额外 debounce）
 * - 读取透传 store.list
 *
 * AC-2.4 约束（grep 守护）：service 无 setTimeout/setInterval（debounce 由 store 的 WriteBackCache 承担）。
 * AC-2.5 约束（grep 守护）：service 不 import SessionService（无回调依赖，无环）。
 */
import type { RecentWorkspaceRecord } from '../../../shared/workspace.js'
import type { RecentWorkspacesStore } from './recent-workspaces-store.js'

export class WorkspaceService {
  constructor(private readonly store: RecentWorkspacesStore) {}

  /**
   * 记录 cwd 使用（写入时机 A/B 共用入口）。
   * INV-1 主守卫：cwd 空串/undefined 静默跳过（不调 store）。
   * 守卫归 service 层（业务规则：什么算合法使用记录），store 层补防御性守卫。
   */
  record(cwd: string | undefined): void {
    if (!cwd) return // INV-1 主守卫（grep 验证点）
    this.store.record(cwd)
  }

  /** 列出全部记录（≤10 倒序），handler 调用。透传 store.list（读内存）。 */
  list(): RecentWorkspaceRecord[] {
    return this.store.list()
  }
}
