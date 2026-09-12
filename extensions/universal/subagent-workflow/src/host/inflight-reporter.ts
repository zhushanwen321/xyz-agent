// src/host/inflight-reporter.ts
//
// 壳层在途上报出口（u7a，设计权威源：docs/design/crash-forensics-and-watchdog.md
// §3.3 D5「extension 聚合上报」）。本文件属壳侧（shell），对 pi SDK（ExtensionContext
// 的 ctx.ui.select 通道）的消费收敛在 host/ 层——core 闭包红线只约束 core（出口回调
// 由 core 的 inflight-snapshot 注入，见组合根 index.ts 的 setInFlightListener 接线）。
//
// 链路：core 状态迁移点（session-runner 子进程注册/移除、idle timer arm/disarm）
// → notifyInFlightChanged（同步回调）→ 本 reporter（绝对计数快照 → select 通道帧，
// title = SUBAGENT_INFLIGHT_MARKER）→ runtime event-adapter（u7b）。
//
// D5 接线三约束的落点：
//   ① 不阻塞生命周期主链——onInFlightChanged 同步返回，推送全部 void fire-and-forget，
//      绝不进 agent_settled handler await 链；
//   ② 事件产生点在 core、上报出口在壳层——本文件即出口（core 零 pi SDK）；
//   ③ marker 路由不广播前端是 u7b（runtime 侧）的约束，本文件不涉及。
//
// 语义（D5）：每帧携带**绝对计数**（getInFlightSnapshot，谓词与 core 内
// hasRunningBackground 同源），非增量；初始上报（initial）触发时点 = extension 加载
// 完成——factory 阶段拿不到 ctx/ui（pi 0.84.4 实装：dist/core/extensions/loader.js:463
// await factory(load.api) 只收静态注册面 API（registerTool/events.on…，
// createExtensionAPI :209 函数体无 ui 字段）；per-session ctx 由
// dist/core/extensions/runner.js createContext() :503（get ui :508）在事件派发时点
// 构造，emit :624 每次现场建 ctx）——session_start 是 pi 启动序列里最早带 ctx 的钩子
// （dist/core/agent-session.js:1919 _extensionRunner.emit(_sessionStartEvent)，默认
// 事件 :152）= 「session 就绪」，即设计所指加载完成时点；不挂任何懒触发（无 subagent
// 的 session 也必上报）。
//
// 失败语义（D5 缺席语义②）：select 失败（超时/通道异常/非确认回包）折叠后**延迟重试
// 直至成功一次**。送达判据 = runtime resolve 的确认回包（INFLIGHT_REPORT_ACK）——
// fire-and-forget 下 resolve(undefined) 与超时不可区分，必须靠显式 ack 区分「已送达」
// 与「旧版 runtime 无路由」，否则 errs 判别（「从未收到上报」只覆盖缺席/旧版）失效。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_INFLIGHT_MARKER, isInFlightReportAck } from "@xyz-agent/extension-protocol";
import { getInFlightSnapshot } from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/pi-extension-logger";

/** select 通道级超时（控制面单请求，秒级校准——超时默认原则规则 19）。取值对齐
 *  plugin-bridge 启动 sync 的 2s 自愈闸：session_start 首帧可能早于 runtime adapter
 *  attach（R2 实证），超时折叠后重试必然自愈；fire-and-forget 帧不留 pending 挂死面。 */
const SELECT_TIMEOUT_MS = 2_000;

/** 失败重试退避（对齐 plugin-bridge SYNC_RETRY_MS 控制面节奏）。 */
const RETRY_DELAY_MS = 2_000;

/** 在途上报器（组合根 index.ts 持有；per-factory 实例，session_start/shutdown 驱动）。 */
export interface InFlightReporter {
  /**
   * session_start 注入当前 ctx 并发起初始上报（fire-and-forget——本方法同步返回，
   * 不阻塞 session_start 装配链；初始帧 kind='initial'，count 为当下绝对计数）。
   */
  attachSession(ctx: ExtensionContext): void;
  /** session_shutdown 摘除 ctx 并停止重试（session 已死，上报通道随之终结）。 */
  detachSession(): void;
  /** core 出口回调（notifyInFlightChanged 直连）：同步返回，内部合并 + void 推送。 */
  onInFlightChanged(): void;
}

export interface InFlightReporterOpts {
  /** 测试注入：select 超时（ms）。缺省 SELECT_TIMEOUT_MS。 */
  selectTimeoutMs?: number;
  /** 测试注入：重试退避（ms）。缺省 RETRY_DELAY_MS。 */
  retryDelayMs?: number;
}

/**
 * sessionId 从 ctx 取（plugin-bridge getSessionId 同款防御）：pi session 文件延迟写入
 * 窗口内取失败不阻断上报——sessionId 缺席时 runtime 按无法归属丢弃整帧（契约
 * SubagentInFlightReport.sessionId 可选语义），不视为协议错误。
 */
function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

export function createInFlightReporter(opts: InFlightReporterOpts = {}): InFlightReporter {
  const selectTimeoutMs = opts.selectTimeoutMs ?? SELECT_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const logger = getLogger("subagents");

  // 闭包状态（per-factory 实例；禁模块级 let——同进程多 factory 实例会串台）。
  let ctx: ExtensionContext | null = null;
  /** 初始上报是否已送达（送达后所有帧 kind='delta'）。 */
  let initialAcked = false;
  /** 一次推送尝试在途（串行化——绝对计数语义下中间值可安全合并丢弃）。 */
  let attemptInFlight = false;
  /** 有待推帧（onInFlightChanged 在推送在途期间置位，成功后立即补推最新值）。 */
  let dirty = false;
  /** 重试定时器句柄（单飞；成功/dispose 即清）。 */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 首次失败已 warn 留痕（重试循环不刷屏——旧版 runtime 场景会长期重试）。 */
  let firstFailureLogged = false;

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /** 推送在途或无 ctx 时仅置脏；否则发起一次尝试（void，不阻塞调用方）。 */
  function kick(): void {
    if (attemptInFlight || ctx === null) {
      dirty = true;
      return;
    }
    dirty = false;
    attemptInFlight = true;
    void attempt();
  }

  async function attempt(): Promise<void> {
    const active = ctx;
    if (active === null) {
      attemptInFlight = false;
      return;
    }
    // 帧内容在发送时刻现取：绝对计数 = 此刻快照（「当前非 idle 句柄数」）、
    // 产生时点 = 此刻、kind 按初始上报是否已送达裁决（初始未送达前，脏帧也以
    // initial 语义送达——对 errs 判别等价：runtime 收到任何帧即「在场」）。
    const snapshot = getInFlightSnapshot();
    const payload = JSON.stringify({
      kind: initialAcked ? "delta" : "initial",
      inFlight: snapshot.inFlight,
      sessionId: getSessionId(active),
      emittedAt: Date.now(),
    });
    let value: unknown;
    try {
      value = await active.ui.select(SUBAGENT_INFLIGHT_MARKER, [payload], { timeout: selectTimeoutMs });
    } catch (err) {
      // 通道异常折叠（plugin-bridge callBridge 同款：不静默吞，但只首败 warn）。
      value = undefined;
      logFailure("select channel threw", err);
    }
    attemptInFlight = false;
    if (typeof value === "string" && isInFlightReportAck(value)) {
      // 送达确认：清重试；初始上报「成功一次」达成后，后续帧一律 delta。
      initialAcked = true;
      clearRetryTimer();
      if (dirty && ctx !== null) kick();
      return;
    }
    // 失败折叠（resolve undefined = 超时/取消/旧版无路由）→ 延迟重试直至成功一次
    //（D5 缺席语义②：使「从未收到」只覆盖缺席/旧版形态，不覆盖一次性丢包）。
    logFailure("no ack (timeout, cancelled, or runtime without marker routing)", value);
    if (ctx !== null && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        kick();
      }, retryDelayMs);
      // unref：不阻塞进程退出（退出收割由既有 process hook 负责，与 plugin-bridge 同款）。
      retryTimer.unref?.();
    }
  }

  function logFailure(reason: string, detail: unknown): void {
    if (!firstFailureLogged) {
      firstFailureLogged = true;
      logger.warn(`[subagent-inflight] in-flight report failed (${reason}); retrying every ${retryDelayMs}ms until acked`, {
        detail: detail instanceof Error ? detail.message : String(detail),
      });
      return;
    }
    logger.debug(`[subagent-inflight] in-flight report retry failed (${reason})`);
  }

  return {
    attachSession(target: ExtensionContext): void {
      ctx = target;
      clearRetryTimer();
      // 初始上报（count=当下绝对计数；session 就绪时点恒为 0——子进程只会在后续
      // subagent 调用里出现）。fire-and-forget：不阻塞 session_start 装配链。
      kick();
    },

    detachSession(): void {
      ctx = null;
      dirty = false;
      clearRetryTimer();
    },

    onInFlightChanged(): void {
      // 同步返回（D5 约束①）：core 迁移点直连本方法，任何 await 都会进
      // agent_settled 等生命周期链——这里只置脏 + void 发起。
      kick();
    },
  };
}
