/**
 * chat store 共享类型（从 chat.ts 提取，供 chunk-processor 等模块引用，避免循环依赖）。
 */

/**
 * 自动重试运行态（W06-B）。auto_retry_start 设置，auto_retry_end 清空。
 * 对应 event-adapter message.auto_retry_start payload（attempt/maxAttempts/delayMs/errorMessage）。
 */
export interface RetryState {
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  errorMessage?: string
}

/**
 * 消息队列运行态（W06-B）。auto_retry 与 steer/follow_up 排队无关；
 * queue_update 反映 pi 队列里的 steering（steer 排队）和 followUp（follow-up 排队）。
 */
export interface QueueState {
  steering?: string[]
  followUp?: string[]
}
