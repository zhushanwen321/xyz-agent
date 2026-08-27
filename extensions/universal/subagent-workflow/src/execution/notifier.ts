// src/execution/notifier.ts
//
// Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）。
//
// 职责（迁移后，U3）：
//   - buildLlmContent：格式化通知文案（本文件唯一逻辑职责）
//   - createNotifier：薄工厂，装配 @xyz-agent/session-delivery 内核
//   - 合并窗口 / 去重 / 退避 / flush 全部委托内核
//
// 投递通道：内核 → pi.sendMessage({ deliverAs:"steer", triggerTurn:true }) 注入——
//   当前 turn 结束后唤醒父 agent 处理结果（steer 不打断 streaming、不锁滚动）

import { createDelivery, type DeliveryHandle, type DeliveryPort } from "@xyz-agent/session-delivery";

import { deriveOutcome } from "./execution-record.ts";
import type { ClosedReason, ExecutionOutcome } from "./types.ts";

/**
 * 一条待发送的完成通知记录。
 * SP-1: done/failed/crashed 合并为 closed + closedReason L2 子枚举。
 */
export interface BgNotifyRecord {
  id: string;
  /**
   * 完成状态。v4 B-1 两态收敛：closed（终态，含 cancelled，closedReason 表达 L2 原因）
   * 或 running（对话模式轮次完成，旧 idle 折入 running，携带本轮结果送回主 agent）。
   * toNotifyRecord 守卫放行后经此联合穷尽。
   */
  status: "running" | "closed";
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。内部诊断 + outcome 兑底派生输入。 */
  closedReason?: ClosedReason;
  /**
   * 终态三态对外语义（U3 C-outcome）。notify() 投影边界物化：closed 入参缺省时按
   * deriveOutcome(closedReason, error) 兑底填充（所有可达流程下与 completeRecord
   * 冻结的 record.outcome 等价——toNotifyRecord 构造点在 completeRecord 之后；该
   * 构造点属 U3 领地外，不透传本字段）。buildLlmContent 与 bg-notify-render 只读本字段。
   */
  outcome?: ExecutionOutcome;
  agent: string;
  /** 执行所用 model（RecordSnapshot.model），用于完成通知显示。 */
  model?: string;
  result?: string;
  error?: string;
  startedAt: number;
  endedAt: number | undefined;
  /**
   * 对话轮次计数（仅 idle 有意义）。dedup key 按 `id:round` 去重——对话模式每轮 round
   * 不同，60s 内多轮不被吞；非 chatMode round 恒定（0/undefined），key 同旧 id 行为不变。
   */
  round?: number;
  /** [MF#1] worktree 模式下子 agent 改动的 patch 路径（worktree 外，cleanup 后留存）。
   *  done 时通知文本显式提示 `git apply`，否则 background 子 agent 在隔离 worktree 的改动
   *  会静默丢失——父 LLM 不知 patch 路径，无法应用。 */
  patchFile?: string;
  /** [wave2] 子 agent session 文件路径（增量语义的全文恢复通道）。
   *  仅 chatMode 透传（toNotifyRecord 条件透传）——轮次/完成通知末尾追加
   *  "Full transcript: <path>" 指针行，父 LLM 可按需读全文；one-shot 不透传，
   *  通知输出逐字节不变。缺失时 buildLlmContent 省略整行。 */
  sessionFile?: string;
  /** [C-2] close 终态通知的轮次统计（文案 "completed after N rounds." 用）。
   *  仅 chatMode close 语义（notifyClosed）构造时携带——此时 dedup 身份 round 已被
   *  置 undefined（与轮次通知的 id:round key 区分，终态不被吞），轮数改由本字段进
   *  文案。one-shot 完成通知不设置，文案保持 "completed. Result:" 逐字节（G4）。 */
  totalRounds?: number;
}

/** notifier 依赖的宿主最小接口（解耦，便于测试）。
 *  迁移后：仅用于构造 DeliveryPort 的底层依赖。 */
export interface NotifierHost {
  /** 注入消息到主对话。 */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  /** 是否还有 running 的 background 任务（用于滑动窗口立即 flush 判断）。 */
  hasRunningBackground(): boolean;
  /** 主 agent 是否空闲（非 streaming）。可选：未注入时 flush 不 gate。 */
  isIdle?: () => boolean;
  /**
   * 原生 settled 事件订阅能力（D8）：注册 handler 监听主 agent settled 边沿。
   * 无退订语义（pi 0.84.1 的 `pi.on(...)` 全部重载返回 void、无 off——实装锚点：
   * node_modules `@earendil-works/pi-coding-agent` dist/core/extensions/types.d.ts
   * `on()` 系列重载，0.84.1 实测）——退订由本模块的 disposed
   * 标志包装兑现（见下方 port 装配）。可选：未注入时内核退化退避轮询（busy 消息
   * 靠退避达上限强发，不走 settled 边沿驱动）。
   */
  onAgentSettled?(handler: () => void): void;
}

/** 发送给主对话的 customType（bg-notify-render 消费）。 */
const NOTIFY_CUSTOM_TYPE = "subagent-bg-notify";

/**
 * 将 BgNotifyRecord 格式化为 LLM 可读的 notification content。
 *
 * 模块内唯一消费方是下方 createNotifier 的 notify()（预格式化后传 delivery.send，
 * 内核只做拼接——多条以 "\n\n---\n\n" join）。
 */
function buildLlmContent(record: BgNotifyRecord): string {
  const agent = record.agent;
  const id = record.id;
  // [wave2 指针行] 增量语义下轮次通知只携带本轮增量，异步 flush 窗口丢失时不可重发
  //（见 subagent-service.ts onRoundSettled 注释），恢复通道是 session 文件全文。
  // 仅 chatMode 透传 sessionFile，one-shot 通知不含该行；cancelled/gc-failed 不追加
  //（无成功结果可读，指针无意义）；缺失时省略整行（追加空串 = 输出逐字节不变）。
  const transcriptPointer = record.sessionFile
    ? `\n\nFull transcript: ${record.sessionFile}`
    : "";
  switch (record.status) {
    case "closed": {
      // U3 C-outcome：终态文案只读 outcome（notify() 投影边界已物化；?? 兑底为防御
      // 完整性——单一权威函数，非同构重写）。判定先于 patchFile——失败轮也会写
      // patchFile（doFinalizeRecord Step 0 对 worktreeHandle 无条件 collectPatch），
      // failed 分支不展示 patch 提示，否则 worktree 失败并存时 LLM 被告知 completed
      // （历史 bug 存档见 deriveOutcome 注释）。
      const outcome = record.outcome ?? deriveOutcome(record.closedReason, record.error);
      if (outcome === "cancelled") {
        return `Subagent "${agent}" (${id}) cancelled.`;
      }
      if (outcome === "failed") {
        return `Subagent "${agent}" (${id}) failed: ${record.error}`;
      }
      // 成功完成或通用结束：展示结果。
      // [C-2] chatMode close 终态通知附轮次统计（设计 D2 路径①"completed after N rounds"）。
      // totalRounds 仅 close 语义携带（notifyClosed）；one-shot 完成通知不设置（round 无轮次
      // 语义），文案保持 "completed. Result:" 逐字节（G4 硬约束，one-shot 字节锁测试锚定）。
      const roundsSuffix =
        record.totalRounds != null && record.totalRounds > 0
          ? ` after ${record.totalRounds} round${record.totalRounds === 1 ? "" : "s"}`
          : "";
      const base = `Subagent "${agent}" (${id}) completed${roundsSuffix}. Result:\n${record.result ?? "(empty)"}`;
      if (record.patchFile) {
        // [wave2 review] 长 return 拆行：模板串内不可直接换行（会改变输出内容），提取 patchHint 中转变量
        const patchHint = `\n\nThis subagent ran in an isolated worktree; its file changes were captured as a patch:\n  ${record.patchFile}\nTo bring these changes into the current repo, run: \`git apply ${record.patchFile}\``;
        return `${base}${patchHint}${transcriptPointer}`;
      }
      return `${base}${transcriptPointer}`;
    }
    case "running":
      // v4 B-1: 对话模式轮次完成（旧 idle 折入 running）：携带本轮结果送回主 agent，等待下一轮 message。
      return `Subagent "${agent}" (${id}) finished a round. Reply:\n${record.result ?? "(empty)"}${transcriptPointer}`;
  }
}

/**
 * Background 完成通知器接口（迁移后由内核实现）。
 *
 * 保持与旧 BgNotifier 类相同的公共 API，避免消费方（subagent-service）改动面过大。
 */
export interface BgNotifier {
  /** 入队一条完成通知（去重 + 合批窗口合并）。dispose 后短路。 */
  notify(record: BgNotifyRecord): void;
  /** 立即 flush（session_shutdown 调用，防丢失）。 */
  flushPendingNotifications(): void;
  /** session 结束：清队列，dispose 内核 handle。 */
  dispose(): void;
  /** /resume /fork /new 后复活。 */
  revive(): void;
}

/**
 * 创建 Background 完成通知器（薄工厂，装配 @xyz-agent/session-delivery 内核）。
 *
 * 内核接管：gate（isIdle 退避）/ 合批窗口（滑动 60s）/ dedup（按 id:round）/ flush / shutdown flush。
 * 本函数职责：将 BgNotifyRecord → DeliveryMessage 映射 + buildLlmContent 预格式化。
 *
 * @param host 宿主能力注入（pi.sendMessage + hasRunningBackground + isIdle）
 * @returns BgNotifier 接口（与旧类同形）
 */
export function createNotifier(host: NotifierHost): BgNotifier {
  let disposed = false;

  // 构造 DeliveryPort：intent → pi 参数翻译在适配器内（D3）
  const port: DeliveryPort = {
    supportedPayloads: ["custom"],
    isIdle: () => {
      if (host.isIdle) {
        return host.isIdle();
      }
      // 未注入 isIdle → 视为 idle（不 gate，向后兼容旧 host）
      return true;
    },
    hasPendingMessages: () => false, // notifier 不关心 hasPendingMessages
    // D8（must-fix #4）：settled 边沿驱动装配——内核 busy 入队后由 settled 事件唤醒
    // flush（watch-dog 兜底事件丢失），替代无订阅时的退避轮询。host 只注入原生订阅
    // 能力；disposed 标志包装（兑现退订语义——pi.on 返回 void 且无 off）在此完成。
    subscribeSettled:
      host.onAgentSettled === undefined
        ? undefined
        : (cb) => {
            let disposed = false;
            host.onAgentSettled?.(() => {
              if (!disposed) cb();
            });
            return () => {
              disposed = true;
            };
          },
    send: (msg, intent) => {
      host.sendMessage(
        {
          customType: NOTIFY_CUSTOM_TYPE,
          content: msg.payload.content,
          display: true,
          details: msg.payload.kind === "custom" ? msg.payload.details : undefined,
        },
        intent === "interrupt-at-turn-boundary"
          ? { triggerTurn: true, deliverAs: "steer" }
          : { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  };

  // #5（must-fix）：内核 handle 的 disposed 不可逆——dispose 后 revive 必须重建 handle，
  // 否则 revive 后所有 notify() 被内核静默吞（外层标志复位救不回已销毁的内核）。
  // revive = 新生命周期：合批窗口 / 在途批次 / dedup LRU 随重建自然复位（可接受）。
  const createHandle = (): DeliveryHandle =>
    createDelivery(port, {
      intent: "interrupt-at-turn-boundary",    // D3：turn 边界抢占（F1 教训内化）
      mergeWindowMs: 60_000,                   // 滑动窗口合批（继承 MERGE_WINDOW_MS=60s）
      mergeHoldActive: () => host.hasRunningBackground(), // D4 must-fix #1：禁止用 isIdle 代替
      busyPolicy: "retry-force",               // settled 边沿驱动 + 退避达上限强发
      backoff: { ms: 100, max: 50 },           // 继承 FLUSH_BACKOFF_MS/MAX
      // dedup LRU：语义与旧 DEDUP_TTL_MS=60s **不同**——按 key 永久去重（仅 LRU 逐出后
      // 同 key 可再入）。当前 key 空间（id / id:round，id 每 spawn 唯一）无实际差异；
      // 后续复用方勿按「60s 内不重复」假设接入（同 key 通知会被永久吞）。
      dedupe: { maxKeys: 1000 },
    });
  let handle: DeliveryHandle = createHandle();

  return {
    notify(record: BgNotifyRecord): void {
      if (disposed) return;

      // U3 C-outcome：投影边界物化 outcome——closed payload 缺省时按单一权威
      // deriveOutcome 兑底填充，content 与 details（GUI pane 消费）均携带一等 outcome；
      // 所有可达流程下与 record.outcome 等价（toNotifyRecord 在 completeRecord 之后
      // 构造）。running（轮次通知）语义上无 outcome，不物化。消源自 record 的浅拷贝
      // ——不改写入方对象（BgNotifyRecord 由调用方持有）。
      const payload: BgNotifyRecord =
        record.status === "closed"
          ? { ...record, outcome: record.outcome ?? deriveOutcome(record.closedReason, record.error) }
          : record;

      // dedup key：idle（对话模式每轮完成）按 id:round 去重——不同轮次不互相掩蔽；
      // 非 idle（closed/cancelled）round 恒定 undefined，key 同旧行为不变。
      const dedupeKey = payload.round != null ? `${payload.id}:${payload.round}` : payload.id;

      handle.send({
        payload: {
          kind: "custom",
          customType: NOTIFY_CUSTOM_TYPE,
          content: buildLlmContent(payload),
          display: true,
          details: payload,
        },
        dedupeKey,
      });
    },

    flushPendingNotifications(): void {
      handle.flush();
    },

    dispose(): void {
      disposed = true;
      handle.dispose();
    },

    revive(): void {
      disposed = false;
      // #5：内核 disposed 不可逆——revive 必须重建 handle（/resume /fork /new 后的
      // session_start 时序：disposeAll → initSession → revive）。旧 handle 若仍存活
      // （首次 session_start 的 revive）dispose 为幂等清理，无副作用。
      handle.dispose();
      handle = createHandle();
    },
  };
}
