// src/execution/engine/host/host-bridge.ts
//
// HostBridge 契约 + core 侧实现（W6，impl-plan §2.6 / 设计 §3.8 D2 表 + 最小示例）。
//
// 归属裁定（设计 §3.8 D2 表逐条）：PiEngineService 的 9 成员中——executeAndAwait /
// getRecordForAction / collectRecords / closeSubagent / cancel / ChatRoundTicket /
// record 状态回写 / idle+activate lock 定时器——都是「宿主执行链 / 数据所有权在宿主」，
// 归 HostBridge（core）；pi 包（W7）经 host/* 反向请求消费本面。spawnedChildren 归
// 引擎进程（core 镜像见同目录 spawned-children.ts）；sendPromptCommand / EPIPE 兜底 /
// 冷续轮 resume（stdin-writer）归 pi 包（W7 迁移物）。
//
// 本文件只依赖 core 公共类型（types.ts / record-store / stream-sink /
// lifecycle-manager / orchestration 类型），不 import inproc pi 引擎目录 内部——它是 pi 包
// 反向请求消费面的契约落点（协议无关，类型闭包经 HostBridgeServiceFace 泛型参数化）。

import { CANCEL_SETTLE_GRACE_MS } from "@zhushanwen/subagent-engine-sdk";

import { armIdleTimer, disarmIdleTimer } from "../../lifecycle-manager.ts";
import type { AgentResult as WorkflowAgentResult } from "../../../orchestration/models/types.ts";
import type { StatusFilter } from "../../record-store.ts";
import type { SubagentStream } from "../../stream-sink.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecuteOptions,
  ExecutionRecord,
  SubagentRecord,
} from "../../types.ts";

/**
 * chat 域轮次交接包的 core 契约基座（设计 §3.8 D2「ChatRoundTicket → HostBridge」）。
 * pi 专有扩展（identity / SessionRunnerContext / SpawnResumeOpts resume）在
 * pi-engine.ChatRoundTicket extends 本接口（W7 随包迁移；过渡期 record/opts/signal/
 * priority/stream 五字段的宿主编排语义在此单一权威）。
 */
export interface HostChatRoundTicket {
  record: ExecutionRecord;
  opts: ExecuteOptions;
  signal: AbortSignal | undefined;
  priority: number;
  stream?: SubagentStream;
}

/**
 * HostBridge 的服务实现面（SubagentService 的结构子集，鸭子类型——与原 pi-engine 的
 * PiEngineService 同一形态的协议化泛化：chat 域轮次面泛型参数化，pi 绑定 =
 * HostBridgeServiceFace<ChatRoundTicket>，见 pi-host-binding.ts 的 re-export）。
 * 为什么用结构接口而非 import SubagentService 类型：防 Service 内部演进连锁影响
 * 契约面 + 测试可注入 fake（PiEngineService 的既有先例，语义照搬）。
 */
export interface HostBridgeServiceFace<TTicket extends HostChatRoundTicket = HostChatRoundTicket> {
  executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult>;
  getRecordForAction(id: string): ExecutionRecord;
  closeSubagent(record: ExecutionRecord, force: boolean): Promise<void>;
  cancel(id: string): boolean;
  collectRecords(limit: number, statusFilter?: StatusFilter): SubagentRecord[];
  /** chat 域轮次交接（run 的 chat 分支入口）：按 taskId 取走预备包（一次性消费）。 */
  takeChatRound?(taskId: string): TTicket | undefined;
  /** 执行预备的 chat 轮次（编排归 Service：pool 槽 + runSpawn + 终态迁移）。 */
  runChatRound?(ticket: TTicket): Promise<AgentResult>;
  /** 冷路径续轮（interact message 分支的编排回调：守卫 + record 迁移 + kick-off）。 */
  resumeChatRound?(record: ExecutionRecord, text: string): void;
  /** record 状态迁移上报（热路径投递后让 runtime 派生缓存失效 / GUI 回流）。 */
  reportRecordTransition?(record: ExecutionRecord): void;
}

/**
 * HostBridge 接口（设计 §3.8 最小示例，9 方法）。core 侧实现；pi 包经 host/* 反向
 * 请求消费。签名与最小示例的两处实现级偏差（均按现状语义落地）：
 *   - getRecordForAction 返回 ExecutionRecord | null（现状实现面的活 record 形态；
 *     不存在 / 不可达 → null，引擎侧 resolveRecord 的 try/catch 语义内聚到本面）；
 *   - reportRecordTransition 收 record 对象（现状状态回写以 record 为单位整体上报，
 *     无 patch 增量形态——造 patch 形态属凭空造词，W7 反向通道载荷再议）。
 */
export interface HostBridge {
  executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult>;
  getRecordForAction(id: string): ExecutionRecord | null;
  collectRecords(limit: number, filter?: StatusFilter): SubagentRecord[];
  closeSubagent(record: ExecutionRecord, force: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  takeChatRound(taskId: string): HostChatRoundTicket | null;
  reportRecordTransition(record: ExecutionRecord): void;
  armIdleTimer(id: string, ms: number): void;
  disarmIdleTimer(id: string): void;
}

/** createHostBridge 依赖（服务面 + idle 超时处置 + [W3 D3] cancel 收敛面）。 */
export interface HostBridgeDeps {
  /** HostBridge 服务实现面（生产 = SubagentService 的结构子集）。 */
  service: HostBridgeServiceFace;
  /**
   * idle timer 超时处置（回收层兜底）：宿主在 arm 时注入杀链回调（现状语义 =
   * killRecordChildWithEscalation 升级杀，pi-engine.rearmIdleTimerAfterHotPathFailure
   * 同款）。不注入则 arm 时 throw（无处置的 idle timer = 永不回收的泄漏源，宁可显式）。
   */
  onIdleTimeout: (recordId: string) => void;
  /**
   * [W3 D3 协议层] cancel 收敛等待源：目标轮次的终态信号——roundLifecycle
   * settled/failed 相位帧或 interact cancel 应答——到达时 resolve(true)。
   * 信号源 = 宿主 chat 轮路由（EngineClient recordRoutes / RunContext.onRoundLifecycle）
   * 与 interact cancel 应答（协议层收敛语义，引擎面应答即收敛）。不注入 = 无收敛面
   * 可等（无 chat 轮在途/纯测试装配）→ cancel 保持受理即返回的旧形态。
   */
  waitForRoundTerminal?: (recordId: string) => Promise<boolean>;
  /**
   * [W3 D3 协议层] 收敛超时的杀链升级（run 域同构：remote-engine abort 分级的
   * killAll 兜底形态）。与 waitForRoundTerminal 成对注入。
   */
  escalateKill?: (recordId: string, reason: string) => Promise<void>;
}

/** HostBridge core 实现（SubagentService 编排面的协议化视图）。 */
export function createHostBridge(deps: HostBridgeDeps): HostBridge {
  const { service } = deps;
  return {
    executeAndAwait: (opts, signal, onEvent, stream) =>
      service.executeAndAwait(opts, signal, onEvent, stream),
    getRecordForAction: (id) => {
      try {
        return service.getRecordForAction(id);
      } catch {
        return null;
      }
    },
    collectRecords: (limit, filter) => service.collectRecords(limit, filter),
    closeSubagent: (record, force) => service.closeSubagent(record, force),
    /**
     * [W3 D3 协议层] cancel 语义 = 受理 → 等目标轮次终态 → 超时杀链升级：
     *   1. 受理：service.cancel(id)（CAS 终态化 + 终止意图记账，同步布尔）；
     *   2. 等待：roundLifecycle settled/failed 或 interact cancel 应答，窗长
     *      CANCEL_SETTLE_GRACE_MS（SDK 常量 3s，run 域同源）；
     *   3. 升级：未收敛走与 run 域同构的杀链（escalateKill）。轮次 failed 相位
     *      （engine_round_aborted 等失败码）由 chat 轮路由消费并如实标 failed
     *      （失败相位错误码分诊）——本方法只负责收敛等待与升级，不做 completed
     *      谎报方向的合成。
     */
    cancel: async (id) => {
      const accepted = service.cancel(id);
      if (!accepted) return; // 未受理（record 不存在/已终态）——无收敛对象
      if (deps.waitForRoundTerminal === undefined) return;
      const graceTimer = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), CANCEL_SETTLE_GRACE_MS);
        if (typeof t.unref === "function") t.unref();
      });
      const settled = await Promise.race([deps.waitForRoundTerminal(id), graceTimer]);
      if (!settled) {
        await deps.escalateKill?.(id, `cancel did not settle within grace for record ${id}`);
      }
    },
    takeChatRound: (taskId) => service.takeChatRound?.(taskId) ?? null,
    reportRecordTransition: (record) => service.reportRecordTransition?.(record),
    armIdleTimer: (id, ms) => {
      armIdleTimer(id, () => deps.onIdleTimeout(id), ms);
    },
    disarmIdleTimer: (id) => {
      disarmIdleTimer(id);
    },
  };
}
