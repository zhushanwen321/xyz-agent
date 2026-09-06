/**
 * BackgroundTask 域 —— 后台命令侧边栏的拉取/操作 RPC（docs/design/background-task-sidebar-view.md
 * §3.3 D3，u-proto 单元）。
 *
 * 三个封装：list（拉全量 + 隐式加入 runtime watched 集合）/ output（tail 输出尾部）/ kill（终止）。
 * 状态变更刷新走 Server→Client 广播 backgroundTask:updated——本 domain 只封装 RPC 面，广播订阅归
 * 消费侧 composable（经 events 通道、模块级单 listener，AGENTS 规则 2），不在此处封装。
 *
 * 任务条目形状直接用 @xyz-agent/extension-protocol 的 BackgroundTaskRegistryEntry（D9 数据契约
 * 零新造，与 bash_output 工具面的 snake_case 契约互不相干）。shared protocol.ts 侧是结构镜像
 *（shared 不依赖 extension-protocol），镜像 ⇔ 契约的逐字段全等由本文件 BackgroundTaskMirrorEqualsContract
 * 编译期守卫——任一侧形状漂移即 tsc 红。
 *
 * 注：本 domain 暂未接入 api/index.ts 门面聚合（isMock 三元）——u-proto 领地仅限本文件与
 * shared protocol.ts，门面注册与 mock 轨由消费单元（u-renderer-store / u-drawer）接线；
 * 消费方直接 `import * as backgroundTask from '@/api/domains/background-task'`。
 */
import type { ServerMessageMap } from '@xyz-agent/shared'
import type { BackgroundTaskRegistryEntry } from '@xyz-agent/extension-protocol'
import { command } from '../request'

// ── D9 编译期守卫：shared 镜像 ⇔ extension-protocol 契约逐字段全等 ──
// 全等断言惯用法（比 extends 严：可选性/字面量成员任一差异即 false）。
// 任一侧字段漂移（改名/增删/可选性/枚举成员）→ Equal 求值 false → Expect 约束在
// 本文件 TS 2344 编译红（renderer typecheck 覆盖此处，shared __tests__ 不在 tsc include）。
// 零运行时产物；list() 返回类型标注（Shared → Contract 单向可赋值）之上的强断言补全。
type Equal<X, Y> = (<T>() => T extends X ? true : false) extends (<T>() => T extends Y ? true : false) ? true : false
type Expect<T extends true> = T
export type BackgroundTaskMirrorEqualsContract = Expect<Equal<
  ServerMessageMap['backgroundTask.tasks']['tasks'][number],
  BackgroundTaskRegistryEntry
>>

/**
 * 拉取 session 的后台任务全量（runtime 直读 registry 的投影；目录/文件不存在 → 空数组）。
 *
 * 首次调用同时把 session 加入 runtime watched 集合（D8③，后续变更经 backgroundTask:updated
 * 广播推回）；renderer 在切换/激活 session、打开后台命令 tab 时主动调用（架构约定「runtime
 * broadcast 时序竞争」C6——广播只做增量刷新，拉取兜底是唯一真相入口）。
 */
export async function list(sessionId: string): Promise<BackgroundTaskRegistryEntry[]> {
  const reply = await command('backgroundTask.list', { sessionId })
  // D9 结构等价守卫：shared 镜像（reply.tasks）→ extension-protocol 契约的赋值，
  // 任一侧字段漂移（改名/缺失/必选性变化）即编译错误。
  return reply.tasks
}

/**
 * 读取任务输出尾部（字节窗口，从文件末尾读；对齐 bash_output 的 tail 语义，D7）。
 * maxBytes 省略时由 runtime 用默认窗口（32KB 上界）。lost=true 表示输出文件不可用
 *（已清理/丢失），此时 text 为空串（§3.1 失败路径「输出不可用」分支）。
 */
export function output(
  sessionId: string,
  taskId: string,
  maxBytes?: number,
): Promise<ServerMessageMap['backgroundTask.outputResult']> {
  const payload: { sessionId: string; taskId: string; maxBytes?: number } = { sessionId, taskId }
  if (maxBytes !== undefined) payload.maxBytes = maxBytes
  return command('backgroundTask.output', payload)
}

/**
 * 终止后台任务（D6 分支矩阵）。reason 语义（BackgroundTaskKillReason）：
 * - killed                 发令成功（killing 预写 + killProcessTree；AI 零感知，主路径）
 * - already-exited         任务已退出，无副作用（toast「任务已结束」）
 * - identity-unverifiable  进程身份无法验证，拒绝终止（宁不杀勿误杀，可重试）
 * - registry-write-failed  锁内 registry 写失败，操作未生效（可重试）
 */
export function kill(
  sessionId: string,
  taskId: string,
): Promise<ServerMessageMap['backgroundTask.killResult']> {
  return command('backgroundTask.kill', { sessionId, taskId })
}
