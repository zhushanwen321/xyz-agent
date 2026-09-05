// src/execution/engine/common/session-view-service.ts
//
// 非 pi 引擎 record 的 GUI 历史详情读取链单一实现（dual-track-convergence D1：
// journal 读取链收敛）。收敛三段：①三级降级链编排（引擎原生 reader → journal 重放
// → outcome-only）②SessionView → HistoryMessage[] 投影（原 runtime 手写版）③引擎
// 分发（reader registry 查表，取代引擎 id 硬编码分支——接入第三引擎 runtime 零改动）。
//
// 收益口径（设计 D1 / r2 审查钉正）：守护对称（生产路径从零测试手写副本切到
// conformance C5 守护的 updateFromEvent reducer）+ engine-generic 正确性
// （message_end 携带 error 的记账语义就位）；对现役 zcode 是内容 parity——同一
// journal 输入，新旧链投影输出等价（zcode 现役 journal 形态 = coarse 两事件
// [message_end(usage), turn_end] 与失败态 [error(, message_end, turn_end)]，两者
// 的新旧投影逐字段一致，见 __tests__ 的 parity 用例）。
//
// ②级重放的 reducer 唯一性：turns 累积走 execution-record.updateFromEvent（C5
// conformance 守护实现，journal 重放与 live 通路共用同一 reducer）——本模块不持有
// 第二套事件 reducer。与原 runtime 手写 reducer 的两个已知投影差异均为现役不可达
// 形态（zcode journal 不产出），属「记账语义就位」的新增行为而非 parity 破坏：
// - message_end 带 error 且其后无 turn_end 清除 → 记账进末条 assistant 的
//   status='error' + error 字段（原手写版不记——设计 §2.2 #1 漂移维度，收敛方向
//   以守护实现为准）；
// - 交错多 error 事件（独立 error 事件 × N 且与 turn_end 交错）→ 收敛为单条物化
//   消息（现役 zcode 每任务至多 emit 一个 error 事件，形态不可达）。
//
// pi 分支维持现状（A1 守护）：pi 历史走 runtime 自有 JSONL 直读链
// （session-service.getSubagentHistory），不经本模块；engineId='pi' 的防御分支
// 返回空数组，与被收敛前的 runtime 实现一致。

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

// 相对 import 用 .js 形态（本文件是双端复用模块，被 xyz-agent runtime import——对齐
// engines/zcode/reader.ts 先例：runtime tsconfig 无 allowImportingTsExtensions，.ts
// 形态在 runtime tsc 下报 TS5097；.js 后缀经 bundler/ESM 解析器 substitution 到 .ts）。
import { getLogger } from "../../../core/logger.js";
import { createRecord, updateFromEvent } from "../../execution-record.js";
import type { Turn } from "../../types.js";
import { readZcodeSessionView } from "../engines/zcode/reader.js";
import { ZCODE_ENGINE_ID, ZCODE_HOST_DB_SUFFIX } from "../engines/zcode/constants.js";
import { resolveEnginesRoot, resolvePoolDir } from "../paths.js";
import type { SessionView } from "../types.js";
import { replayJournal } from "./event-journal.js";
import { aggregateUsage } from "./session-view-projection.js";
import type {
  EngineHandleView,
  EngineToolCallSource,
  HistoryMessage,
  HistoryToolCallView,
  SubagentRecordSnapshot,
} from "./session-view-types.js";
import { parseEngineHandle } from "./session-view-types.js";

const logger = getLogger("subagents");

/**
 * 缺省引擎 id（与 registry.ts 的 DEFAULT_ENGINE_ID 同值本地锚定——对齐
 * engines/pi/reader.ts 的 PI_ENGINE_ID 先例：import registry 会连带 port.ts →
 * stream-sink.ts 的 .ts 后缀值 import 链进 runtime tsc 编译图，破坏双端复用闭包
 * 约束；锚定漂移由本包 registry.test / 读取链测试双重守护）。
 */
const DEFAULT_ENGINE_ID = "pi";

// ============================================================
// 引擎 id 提取（record 路由段）
// ============================================================

/**
 * record 的引擎路由段：engine 非 string 或空串 → 缺省 pi（存量 record 零迁移）。
 * 与被收敛前的 runtime extractRecordEngine 语义一致（非 trim 透传——空白 id 由
 * reader registry miss 落③级，与旧行为等价）。
 */
export function extractEngineId(record: SubagentRecordSnapshot): string {
  const engine = record.engine;
  return typeof engine === "string" && engine.length > 0 ? engine : DEFAULT_ENGINE_ID;
}

// ============================================================
// reader registry（③引擎分发：查表取代引擎 id 硬编码）
// ============================================================

/**
 * 引擎原生 reader（①级）：handle + dataDir → SessionView。
 * 返回 undefined = 本级不可达/失败（编排层降②级）；reader 内部自行留 debug 日志。
 * 双端复用约束（设计 §3.3.7，与 zcode/reader.ts 同款）：实现必须无状态纯函数、
 * 不 import 引擎运行时件（launcher/preparer/parser）。
 */
export type NativeSessionReader = (
  handle: EngineHandleView,
  dataDir: string,
) => Promise<SessionView | undefined>;

/** 进程级注册表槽位（globalThis[Symbol.for] 防 jiti 双路径加载分裂，对齐 registry.ts 惯例）。 */
const NATIVE_READER_SLOT_KEY = Symbol.for(
  "@zhushanwen/pi-subagent-workflow.nativeSessionReaders",
);

function getReaderSlot(): Map<string, NativeSessionReader> {
  let slot = Reflect.get(globalThis, NATIVE_READER_SLOT_KEY) as
    | Map<string, NativeSessionReader>
    | undefined;
  if (!slot) {
    slot = new Map();
    // 内置注册：core 自带 reader 的引擎（当前仅 zcode——pi 的历史读取按 D1 范围声明
    // 走 runtime 自有 JSONL 直读链，不注册原生 reader）
    slot.set(ZCODE_ENGINE_ID, readZcodeNativeTier);
    Reflect.set(globalThis, NATIVE_READER_SLOT_KEY, slot);
  }
  return slot;
}

/**
 * 登记引擎原生 reader（未来引擎 / 测试注入 fake 用）。重复注册同 id = 覆盖
 * （幂等，对齐 registerEngine 惯例）。生产调用方 = core 内新引擎的接入模块；
 * xyz-agent runtime 不需要注册（zcode 内置）。
 */
export function registerNativeSessionReader(engineId: string, reader: NativeSessionReader): void {
  getReaderSlot().set(engineId, reader);
}

/** 查表（未注册引擎返回 undefined → 编排层落③级，行为面与旧「无 native reader 分支」一致）。 */
function lookupNativeSessionReader(engineId: string): NativeSessionReader | undefined {
  return getReaderSlot().get(engineId);
}

/** 清空注册表并重置为内置集（测试隔离专用，生产禁用——对齐 clearEngines 惯例）。 */
export function resetNativeSessionReaders(): void {
  const slot = getReaderSlot();
  slot.clear();
  slot.set(ZCODE_ENGINE_ID, readZcodeNativeTier);
}

// ============================================================
// ①级：zcode sqlite 原生读取（内置注册的 reader）
// ============================================================

/**
 * zcode ①级 reader：sessionRef 的 dbPath/sessionId 重定位 + 白名单 +
 * readZcodeSessionView（extension/runtime 双端复用的同一份 reader）。
 * 语义复刻被收敛前的 runtime readZcodeNativeTier（含共享宿主 HOME 形态的绝对
 * dbPath 精确白名单）：绝对 dbPath 只认宿主 zcode 会话 db（ZCODE_HOST_DB_SUFFIX
 * SSOT 推导，防任意读）；相对路径锚池目录 resolve，越界路径（../ 逃逸 / 跨池）
 * 拒绝降②级；读取失败（结构化错误）降②级。
 */
async function readZcodeNativeTier(
  handle: EngineHandleView,
  dataDir: string,
): Promise<SessionView | undefined> {
  const dbPathRaw = handle.sessionRef["dbPath"];
  const sessionId = handle.sessionRef["sessionId"];
  if (typeof dbPathRaw !== "string" || typeof sessionId !== "string") {
    logger.debug("[session-view-service] zcode tier1 skipped: handle missing dbPath/sessionId");
    return undefined;
  }
  let dbPath: string;
  if (dbPathRaw.startsWith("/")) {
    // 共享宿主 HOME 形态（2026-09 起，写侧 zcode-engine 恒绝对路径）：唯一合法绝对
    // 路径 = 宿主 zcode 会话 db（record 来自 JSONL 文本不可信，精确匹配 core SSOT
    // 后缀拼出的路径，防任意读）
    if (dbPathRaw !== resolve(homedir(), ...ZCODE_HOST_DB_SUFFIX)) {
      logger.warn(
        `[session-view-service] zcode absolute dbPath not host db, reject tier1: ${dbPathRaw}`,
      );
      return undefined;
    }
    dbPath = dbPathRaw;
  } else {
    // 旧池时代 records（HOME 池化时期）：相对路径锚池目录重定位，白名单防逃逸
    const poolDir = resolvePoolDir(dataDir, ZCODE_ENGINE_ID, handle.poolKey);
    dbPath = resolve(poolDir, dbPathRaw);
    if (!isStrictlyUnder(poolDir, dbPath)) {
      logger.warn(`[session-view-service] zcode dbPath escapes pool dir, reject tier1: ${dbPath}`);
      return undefined;
    }
  }
  try {
    return await readZcodeSessionView(dbPath, sessionId);
  } catch (err) {
    logger.debug(
      `[session-view-service] zcode tier1 read failed, degrade to journal tier: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

// ============================================================
// ②级：宿主 event journal 重放（C5 守护 reducer）
// ============================================================

/**
 * ②级：journalPath 白名单 + 重放。返回 undefined = 本级不可达 / 重放无内容（降③级）。
 */
function readJournalTier(
  record: SubagentRecordSnapshot,
  handle: EngineHandleView,
  dataDir: string,
): HistoryMessage[] | undefined {
  const journalPath = handle.journalPath;
  if (journalPath === undefined) {
    logger.debug("[session-view-service] tier2 skipped: no journalPath in handle");
    return undefined;
  }
  if (!isStrictlyUnder(resolveEnginesRoot(dataDir), journalPath)) {
    logger.warn(
      `[session-view-service] journalPath escapes engines root, reject tier2: ${journalPath}`,
    );
    return undefined;
  }
  const messages = replayEventsToHistory(replayJournal(journalPath), record);
  if (messages === undefined) {
    logger.debug(
      `[session-view-service] tier2 journal replay produced no content, degrade to outcome-only ` +
        `(path=${journalPath})`,
    );
  }
  return messages;
}

/** ①②级共用的中间 turn 形状（投影到 HistoryMessage 前的聚合单元）。 */
interface HistoryTurnView {
  text: string;
  thinking: string;
  toolCalls: EngineToolCallSource[];
  usage?: { input: number; output: number };
}

/**
 * journal 事件流 → HistoryMessage[]（②级重放的投影半段）。
 *
 * turns 累积 = updateFromEvent（C5 守护 reducer，唯一实现）。本函数只做投影决策：
 * - 有内容 turn（text/thinking/toolCalls 任一非空）→ 逐 turn 投影（per-turn
 *   usageDelta → Message.usage，与旧手写 reducer 的 message_end 挂点一致）；
 * - 无内容但事件流含独立 error 事件（或 reducer 记账的 lastError 存活）→ 物化单条
 *   assistant（旧手写 reducer 的 applyErrorEvent「错误文本落空 turn」语义的投影面；
 *   现役 zcode 失败 journal 即此形态）；
 * - 全空 → undefined（降③级——zcode 成功 journal 的 coarse 两事件重放无内容，
 *   与旧链 sawAssistantContent=false 同落点）。
 */
function replayEventsToHistory(
  events: ReturnType<typeof replayJournal>,
  record: SubagentRecordSnapshot,
): HistoryMessage[] | undefined {
  if (events.length === 0) return undefined;
  // createRecord 参数取 journal-replay.ts eventsToSessionView 的同款中性占位——
  // record 身份字段不参与投影（投影输入是外部 record 快照），只需 turns 累积容器
  const replayRecord = createRecord("journal-replay", {
    agent: "journal-replay",
    model: "",
    mode: "background",
    task: "",
    slug: "",
    startedAt: 0,
  });
  for (const ev of events) updateFromEvent(replayRecord, ev);

  const contentTurns = replayRecord.turns.filter(hasTurnContent);
  if (contentTurns.length > 0) {
    const messages = turnsToMessages(
      contentTurns.map(turnToHistoryTurnView),
      record,
    );
    // message_end.error 的记账语义（engine-generic，现役 zcode 不可达）：存活至重放
    // 末尾的 lastError 落到末条 assistant 的 status/error 字段——守护实现的记账
    // 随投影就位（设计 D1「未来 parser 演进或新引擎接入产出该形态时正确生效」）。
    if (replayRecord.lastError !== undefined) {
      applyAccountedError(messages, replayRecord.lastError);
    }
    return messages;
  }

  const materializedError = firstStandaloneErrorMessage(events) ?? replayRecord.lastError;
  if (materializedError !== undefined) {
    // 物化单条 assistant：text = 首个 error 事件文本；usage = 全 turn 聚合
    // （[error, message_end(usage), turn_end] 形态下 usage 落在无内容 turn 上，
    // 聚合后随物化消息带出——与旧链「同 turn text+usage」逐字段一致）。
    const usage = aggregateUsage(replayRecord.turns);
    return turnsToMessages(
      [
        {
          text: materializedError,
          thinking: "",
          toolCalls: [],
          ...(usage !== undefined ? { usage: { input: usage.input, output: usage.output } } : {}),
        },
      ],
      record,
    );
  }
  return undefined;
}

function hasTurnContent(turn: Turn): boolean {
  return turn.text !== "" || turn.thinking !== "" || turn.toolCalls.length > 0;
}

/** Turn（reducer 内部态）→ 投影中间形状（usageDelta → usage，剥内部字段）。 */
function turnToHistoryTurnView(turn: Turn): HistoryTurnView {
  return {
    text: turn.text,
    thinking: turn.thinking,
    toolCalls: turn.toolCalls,
    ...(turn.usageDelta !== undefined
      ? { usage: { input: turn.usageDelta.input, output: turn.usageDelta.output } }
      : {}),
  };
}

/** 事件流中首个独立 error 事件的 message（物化分支的数据源；非 reducer，纯过滤）。 */
function firstStandaloneErrorMessage(events: ReturnType<typeof replayJournal>): string | undefined {
  for (const ev of events) {
    if (ev.type === "error" && typeof ev.message === "string" && ev.message.length > 0) {
      return ev.message;
    }
  }
  return undefined;
}

/** 存活 lastError → 末条 assistant 记账（status='error' + error 字段同源）。 */
function applyAccountedError(messages: HistoryMessage[], lastError: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === "assistant") {
      msg.status = "error";
      msg.error = lastError;
      return;
    }
  }
}

// ============================================================
// 投影（HistoryTurnView[] / SessionView → HistoryMessage[]）
// ============================================================

/** ①级 SessionView → HistoryMessage[]（usage 聚合挂最后一个 turn 供 GUI 展示）。 */
function sessionViewToMessages(
  view: SessionView,
  record: SubagentRecordSnapshot,
): HistoryMessage[] {
  const turns: HistoryTurnView[] = view.turns.map((t) => ({
    text: t.text,
    thinking: t.thinking,
    toolCalls: t.toolCalls,
  }));
  if (view.usage !== undefined && turns.length > 0) {
    const last = turns[turns.length - 1];
    if (last !== undefined) {
      last.usage = { input: view.usage.input, output: view.usage.output };
    }
  }
  return turnsToMessages(turns, record);
}

/** HistoryTurnView[] → HistoryMessage[]（①②级共用投影；user task 前置一条）。 */
function turnsToMessages(
  turns: HistoryTurnView[],
  record: SubagentRecordSnapshot,
): HistoryMessage[] {
  const base = record.startedAt ?? Date.now();
  const messages: HistoryMessage[] = [];
  if (record.task.length > 0) {
    messages.push({
      id: randomUUID(),
      role: "user",
      content: record.task,
      status: "complete",
      timestamp: base,
    });
  }
  for (const [i, turn] of turns.entries()) {
    messages.push({
      id: randomUUID(),
      role: "assistant",
      content: turn.text,
      status: "complete",
      ...(turn.thinking.length > 0
        ? { thinking: [{ id: randomUUID(), content: turn.thinking, collapsed: true }] }
        : {}),
      ...(turn.toolCalls.length > 0
        ? { toolCalls: turn.toolCalls.map((tc) => toHistoryToolCall(tc, base + i + 1)) }
        : {}),
      ...(turn.usage !== undefined
        ? { usage: { inputTokens: turn.usage.input, outputTokens: turn.usage.output } }
        : {}),
      timestamp: base + i + 1,
    });
  }
  return messages;
}

/** 引擎 toolCall → GUI 工具调用视图（id/时间戳为展示占位）。 */
function toHistoryToolCall(tc: EngineToolCallSource, ts: number): HistoryToolCallView {
  const output = extractTextFromContent(tc.result?.content);
  const details = tc.result?.details;
  return {
    id: randomUUID(),
    toolName: tc.toolName,
    input: tc.args ?? {},
    ...(output !== undefined ? { output } : {}),
    ...(typeof details === "object" && details !== null && !Array.isArray(details)
      ? { details: details as Record<string, unknown> }
      : {}),
    status: tc.isError === true ? "error" : "completed",
    startTime: ts,
    endTime: ts,
  };
}

/** tool result content（unknown[]）→ 拼接文本（string 元素 + {type:'text',text} 块）。 */
function extractTextFromContent(content: unknown[] | undefined): string | undefined {
  if (content === undefined) return undefined;
  let text = "";
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
    } else if (typeof block === "object" && block !== null) {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") text += b.text;
    }
  }
  return text.length > 0 ? text : undefined;
}

// ============================================================
// ③级：outcome-only（摘要卡数据源）
// ============================================================

/**
 * ③级：outcome-only 投影（record 现有字段就够）。①②级都不可达时兜底，
 * 永不返回空数组（详情页至少有 task/结果）。
 */
function outcomeOnlyMessages(record: SubagentRecordSnapshot): HistoryMessage[] {
  const base = record.startedAt ?? Date.now();
  const messages: HistoryMessage[] = [];
  if (record.task.length > 0) {
    messages.push({
      id: randomUUID(),
      role: "user",
      content: record.task,
      status: "complete",
      timestamp: base,
    });
  }
  const isErrorOutcome = record.result === undefined && record.error !== undefined;
  messages.push({
    id: randomUUID(),
    role: "assistant",
    // result 优先（正常轮终文本）；error 次之（失败终态）；双缺占位（运行中被杀等）
    content: record.result ?? record.error ?? "(no outcome recorded)",
    status: isErrorOutcome ? "error" : "complete",
    timestamp: record.endedAt ?? base,
    ...(isErrorOutcome && record.error !== undefined ? { error: record.error } : {}),
  });
  return messages;
}

// ============================================================
// 主入口（三级降级编排）
// ============================================================

/**
 * 非 pi record 的历史详情读取（三级降级主入口，D1 收敛后的唯一生产实现）。
 *
 * 降级顺序 ①→②→③ 逐级尝试，每级失败留 debug/warn 日志不抛崩溃（GUI 详情页
 * 永不白屏报错，设计 A8）。engineId='pi' 返回 []（pi 的①级 = 调用方现有 JSONL
 * 直读链，A1 守护）。未注册 reader 的引擎（未来）直接落③级——record 字段就够，
 * 详情页至少有摘要卡。
 *
 * @param record  record 快照（engine/engineHandle 为不可信源，内部守卫消费）
 * @param dataDir xyz-agent 数据根（journal/dbPath 白名单经 paths.ts 布局 SSOT 推导）
 */
export async function readSubagentHistoryMessages(
  record: SubagentRecordSnapshot,
  dataDir: string,
): Promise<HistoryMessage[]> {
  const engineId = extractEngineId(record);
  if (engineId === DEFAULT_ENGINE_ID) return [];
  const handle = parseEngineHandle(record.engineHandle);
  if (handle === undefined) {
    logger.debug(
      `[session-view-service] engine '${engineId}' record has no engineHandle, ` +
        `degrade to outcome-only (subagentId=${record.subagentId})`,
    );
    return outcomeOnlyMessages(record);
  }
  const reader = lookupNativeSessionReader(engineId);
  if (reader === undefined) {
    logger.debug(
      `[session-view-service] engine '${engineId}' has no native reader tier, ` +
        `degrade to outcome-only (subagentId=${record.subagentId})`,
    );
    return outcomeOnlyMessages(record);
  }
  const native = await reader(handle, dataDir);
  if (native !== undefined) return sessionViewToMessages(native, record);
  const journaled = readJournalTier(record, handle, dataDir);
  if (journaled !== undefined) return journaled;
  return outcomeOnlyMessages(record);
}

/** 路径白名单判定（语义复刻 runtime path-utils.isStrictlyUnder：严格子路径，不含自身）。 */
function isStrictlyUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
