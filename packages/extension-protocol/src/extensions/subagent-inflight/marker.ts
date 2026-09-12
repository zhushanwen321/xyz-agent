/**
 * subagent 在途上报的 title marker。runtime event-adapter（u7b）检测此 marker
 * 区分在途上报与普通 select；pi 侧壳层（@zhushanwen/pi-subagent-workflow 的
 * host/inflight-reporter）经同一 marker 以 fire-and-forget 语义推送
 * SubagentInFlightReport 帧（单一来源，两端口径必然一致）。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 ASK_USER_MARKER / SESSION_MANAGER_MARKER / BRIDGE_MARKER 同理。
 *
 * 设计权威源：docs/design/crash-forensics-and-watchdog.md §3.3 D5
 * 「在途判定谓词 + 求值位置」——extension 聚合上报通道的协议面（u7a）。
 */
export const SUBAGENT_INFLIGHT_MARKER = '\x00XYZ_SUBAGENT_INFLIGHT'

/**
 * 上报类型的 2 个值运行时集合（与 InFlightReportKind 类型同源——types.ts 从此派生）。
 * event-adapter（u7b）用它把 JSON 解析出的 kind 字符串收窄为联合类型，
 * 非法值按 malformed 上报丢弃（不镜像不报错——单帧丢弃由绝对计数语义自愈）。
 *
 * - initial：extension 加载完成（session 就绪）时点的一次性初始上报，语义 =
 *   「本 session 已注入 subagent-workflow 且当前在途计数为帧内值」——服务 u7b 的
 *   errs 判别（区分「缺席/旧版」与「在场且无在途」，D5 缺席语义②）。
 * - delta：生命周期事件触发的常规上报，绝对计数（非增量）。
 */
export const INFLIGHT_REPORT_KINDS = ['initial', 'delta'] as const
