/**
 * Event adapter — 薄路由（#4 拆分后）。
 *
 * 5 个事件 handler + 1 个共享辅助拆在 event-handlers/，本文件只做 re-export。
 * handler 逻辑见各自文件。pi.on 注册在 index.ts（保持不变）。
 *
 * 行为等价（#4 验收）：handler 逻辑原样搬迁，仅 persistAndUpdate 签名 ports 化
 * （见 service.ts）+ turn_end 的 buildPorts 调用从两次收敛为一次。
 */

export { handleAgentEnd } from "./event-handlers/agent-end";
export { handleBeforeAgentStart } from "./event-handlers/before-agent-start";
export type { MessageEndLikeEvent } from "./event-handlers/message-end";
export { handleMessageEnd } from "./event-handlers/message-end";
export { handleSessionStart } from "./event-handlers/session-start";
export { handleTurnEnd } from "./event-handlers/turn-end";
