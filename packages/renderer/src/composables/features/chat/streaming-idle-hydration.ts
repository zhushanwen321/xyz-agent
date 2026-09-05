/**
 * streaming idle 阈值启动水合（docs/design/timeout-streaming-ui-idle.md §5.3 D3 配置链注水端）。
 *
 * app 连接 runtime 后拉取持久化阈值（config.getStreamingIdleTimeout，单位秒），
 * 换算 ms 注入 chat store（setStreamingIdleTimeoutMs，u-s1 落的「读当前值」挂点）——
 * 之后新 turn 的 idle timer 按持久化值挂载，进行中 turn 不受影响（「保存后新 turn 生效」）。
 *
 * 独立模块而非内联 App.vue：水合链路可单测（mock RPC + 真实 pinia store，断言 idle
 * timer 行为），App.vue 只保留一行接线（对齐 refreshModels 兜底拉取范式）。
 */
import { getStreamingIdleTimeout } from '@/api/domains/settings'
import { useChatStore } from '@/stores/chat'

/** 协议单位换算：RPC 秒 → chat store ms。 */
const MS_PER_SECOND = 1000

/** 拉取持久化阈值并注入 chat store。best-effort：失败保持 core 默认 1800s，不阻塞启动。 */
export async function hydrateStreamingIdleTimeout(): Promise<void> {
  try {
    const res = await getStreamingIdleTimeout()
    useChatStore().setStreamingIdleTimeoutMs(res.timeout * MS_PER_SECOND)
  } catch (e) {
    // 降级策略（best-effort）：启动期配置拉取失败不重试不弹窗——chat store 保持在
    // core 默认 1800s，功能可用，用户下次重启或改设置即恢复；warn 落盘供排查。
    console.warn('[streaming-idle-hydration] failed to load streaming idle timeout, keeping core default:', e)
  }
}
