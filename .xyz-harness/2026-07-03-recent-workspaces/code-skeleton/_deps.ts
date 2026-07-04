/**
 * 骨架自包含 minimal 依赖占位（skeleton-spike.md：in-process local-substitutable 依赖放 minimal stand-in）。
 *
 * 真实实现见项目：
 * - WriteBackCache: src-electron/runtime/src/utils/json-store.ts（per-partition KV write-back）
 * - atomicWrite: src-electron/runtime/src/utils/fs-utils.ts
 * - getConfigDir: src-electron/runtime/src/services/config-service.ts
 * - MessageHandlerContext: src-electron/runtime/src/transport/message-context.ts
 * - ClientMessage/ServerMessageMap: src-electron/shared/src/protocol.ts
 * - defineStore/ref/computed: pinia + vue
 * - pending/transport: src-electron/renderer/src/api/{pending,transport}.ts
 *
 * 骨架内放 minimal 可运行版本，仅为让骨架 tsc 编译过 + Level 1 接线（this.x.foo()）可验证。
 * 不是实现 body（实现属 coding-execute Wave）。
 */

// ── WriteBackCache minimal（per-partition KV write-back） ─────────────────

export interface WriteBackBacking<K extends string, IK extends string, IV> {
  loadPartition(k: K): Map<IK, IV>
  persistPartition(k: K, data: Map<IK, IV>): void
}

export type WriteBackOnSet<K extends string, IK extends string, IV> = (
  k: K, ik: IK, v: IV, partitionSize: number, valueSize: number,
) => void

interface Partition<IK, IV> {
  data: Map<IK, IV>
  dirty: Set<IK>
  flushTimer: ReturnType<typeof setTimeout> | null
}

export class WriteBackCache<K extends string, IK extends string, IV> {
  private readonly partitions = new Map<K, Partition<IK, IV>>()
  private readonly flushMs: number

  constructor(
    private readonly backing: WriteBackBacking<K, IK, IV>,
    opts?: { flushMs?: number },
    private readonly onSet?: WriteBackOnSet<K, IK, IV>,
  ) {
    this.flushMs = opts?.flushMs ?? 500
  }

  get(k: K, ik: IK): IV | undefined {
    return this.getPartition(k).data.get(ik)
  }

  set(k: K, ik: IK, v: IV): void {
    const partition = this.getPartition(k)
    partition.data.set(ik, v)
    partition.dirty.add(ik)
    this.scheduleFlush(k)
  }

  delete(k: K, ik: IK): void {
    const partition = this.partitions.get(k)
    if (!partition) return
    partition.data.delete(ik)
    partition.dirty.add(ik)
    this.scheduleFlush(k)
  }

  keys(k: K): IK[] {
    return Array.from(this.getPartition(k).data.keys())
  }

  flush(k: K): void {
    const partition = this.partitions.get(k)
    if (!partition || partition.dirty.size === 0) return
    if (partition.flushTimer) {
      clearTimeout(partition.flushTimer)
      partition.flushTimer = null
    }
    this.backing.persistPartition(k, partition.data)
    partition.dirty.clear()
  }

  flushAll(): void {
    for (const k of this.partitions.keys()) {
      this.flush(k)
    }
  }

  dispose(): void {
    for (const partition of this.partitions.values()) {
      if (partition.flushTimer) {
        clearTimeout(partition.flushTimer)
        partition.flushTimer = null
      }
    }
  }

  private getPartition(k: K): Partition<IK, IV> {
    let partition = this.partitions.get(k)
    if (!partition) {
      const data = this.backing.loadPartition(k)
      partition = { data, dirty: new Set(), flushTimer: null }
      this.partitions.set(k, partition)
    }
    return partition
  }

  private scheduleFlush(k: K): void {
    const partition = this.partitions.get(k)
    if (!partition) return
    if (partition.flushTimer) clearTimeout(partition.flushTimer)
    partition.flushTimer = setTimeout(() => {
      partition.flushTimer = null
      this.flush(k)
    }, this.flushMs)
  }
}

// ── infra 叶子（atomicWrite + getConfigDir，runtime infra 复用） ────────────

export function atomicWrite(_filePath: string, _content: string): void {
  // 真实实现：temp + rename（原子），骨架叶子不展开
  throw new Error('Not implemented: atomicWrite — 见 src-electron/runtime/src/utils/fs-utils.ts')
}

export function getConfigDir(): string {
  // 真实实现：动态推导（dev=~/.xyz-agent-dev，prod=~/.xyz-agent），INV-5 pre-commit 守护
  throw new Error('Not implemented: getConfigDir — 见 src-electron/runtime/src/services/config-service.ts')
}

// ── shared 协议 minimal（type-only，对齐真实 protocol.ts） ─────────────────

export interface ClientMessage {
  type: string
  id?: string
  payload: Record<string, unknown>
}

export interface ServerMessage<T extends string = string> {
  type: T
  id?: string
  payload: unknown
}

export type ServerMessageMap = Record<string, unknown> & {
  'workspace.recentList': { records: import('./shared/workspace.js').RecentWorkspaceRecord[] }
}

export interface MessageHandlerContext {
  send(ws: unknown, msg: ServerMessage): void
  sendError(ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>): void
  reply<T extends string>(ws: unknown, id: string | undefined, type: T, payload: ServerMessageMap[T]): void
}

// ── renderer minimal（pending/transport/vue） ─────────────────────────────

export const pending = {
  create(): string {
    return 'pending-id-stub'
  },
  register<T>(_id: string): Promise<T> {
    return new Promise<T>(() => {
      // 骨架：真实 pending.register 经 routeInbound resolve；骨架不模拟
    })
  },
  resolve<T>(_id: string, _value: T): void {
    // 真实实现：routeInbound 阶段①调用
  },
}

export const transport = {
  send(_msg: ClientMessage): void {
    // 真实实现：ws-client 发送
  },
}

// vue/pinia minimal（type-only 够骨架用）
export interface Ref<T> { value: T }
export function ref<T>(value: T): Ref<T> {
  return { value }
}
export interface ComputedRef<T> { readonly value: T }
export function computed<T>(_getter: () => T): ComputedRef<T> {
  // 骨架：真实 vue computed 是响应式，骨架返静态 getter 包装
  return { get value(): T { return _getter() } }
}
export function defineStore(_id: string, _setup: () => unknown): unknown {
  // 骨架：真实 pinia defineStore 返 useStore hook，骨架不模拟
  return function useStore(): unknown {
    return _setup()
  }
}
