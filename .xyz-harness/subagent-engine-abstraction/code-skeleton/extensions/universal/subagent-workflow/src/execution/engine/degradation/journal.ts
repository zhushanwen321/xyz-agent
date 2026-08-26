// execution/engine/degradation/journal.ts
//
// 公共降级层 ③：event journal 落盘（host 消费 onEvent 统一写，全引擎免费获得，格式唯一）。
// 路径：<getDataDir()>/engines/<engineId>/<poolKey>/journal-<taskId>.jsonl（§3.3.6 v1 中立格式）。
// 写入纪律：onEvent 回调内追加写（有界缓冲 + 批量 flush）；run 终态后 flush 并 fsync 一次。
// journal 不随池删（D5），生命周期跟随 record；record GC 时与池引用计数联动删对应文件。
//
// 重放等价性（C5 断言依据）：重放与 live 通路共用同一 reducer（execution-record.ts
// updateFromEvent——项目关键规则 9「live ≡ reload」的既有模式），不引入第二套解析器。

import { appendFile, readFile } from "node:fs/promises";

import type { AgentEvent, EngineHandleData, JournalEntry, SessionView } from "../types.ts";
import type { ExecutionRecord } from "@real/execution/types.ts";
import { updateFromEvent } from "@real/execution/execution-record.ts";
import { journalFileName } from "../types.ts";

/** journal 绝对路径组装（enginesRoot 由 getDataDir() 动态推导——AC-5 禁写死路径）。 */
export function journalPathFor(enginesRoot: string, engineId: string, poolKey: string, taskId: string): string {
  return `${enginesRoot}/${engineId}/${poolKey}/${journalFileName(taskId)}`;
}

/**
 * host 侧 journal 写入器（有界缓冲 + 批量 flush + 终态 fsync）。
 * 调用点：run 编排层把 ctx.onEvent 的每个事件喂给 append；run 终态后 close。
 */
export class EventJournalWriter {
  private seq = 0;
  private readonly pending: JournalEntry[] = [];

  constructor(
    private readonly engineId: string,
    private readonly path: string,
  ) {}

  /** onEvent 回调内调用（同步追加进有界缓冲；溢出时同步 flush 的背压策略属实现域）。 */
  append(taskId: string, event: AgentEvent): void {
    const entry = this.toEntry(taskId, event);
    this.pending.push(entry);
  }

  private toEntry(taskId: string, event: AgentEvent): JournalEntry {
    // 透传：event 原样（无二次变换）+ host ts + host 侧单调 seq（重放顺序权威）。
    this.seq += 1;
    return { v: 1, ts: Date.now(), taskId, engineId: this.engineId, seq: this.seq, event };
  }

  private serializePending(): string {
    return this.pending.map((e) => JSON.stringify(e)).join("\n") + (this.pending.length > 0 ? "\n" : "");
  }

  /** 批量落盘（真引 node:fs/promises appendFile——SDK 级接线）。 */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    await appendFile(this.path, this.serializePending(), "utf8");
    this.pending.length = 0;
  }

  /** run 终态后调用：flush + fsync 一次（journal 完整性：终态返回时已可重放出全部事件——C3 不变量⑤）。 */
  async close(): Promise<void> {
    await this.flush();
    throw new Error("skeleton: journal fsync on close");
  }
}

/**
 * 第②级数据源：journal → AgentEvent[]（按 seq 排序——顺序权威不依赖文件行序）。
 * 失败（文件缺失/损坏行）返回 undefined——降级链由宿主编排（第③级 outcome-only）。
 */
export async function replayJournalEvents(path: string): Promise<AgentEvent[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const events = deserializeJournal(raw);
  return events ?? undefined;
}

function deserializeJournal(raw: string): AgentEvent[] | null {
  // 逐行 JSON.parse + 按 seq 稳定排序 + 坏行跳过策略（叶子逻辑）。
  void raw;
  throw new Error("skeleton: journal line deserialization + seq ordering");
}

/**
 * 重放 → SessionView（第②级投影；source 标 "journal"）。
 * 真接线 live reducer：逐事件喂 updateFromEvent（C5 重放等价性的构造性实现——
 * journal 重放的 turns 重建逻辑 = live record 的 turns 累积逻辑）。
 */
export function buildSessionViewFromEvents(
  engineId: string,
  events: readonly AgentEvent[],
  createRecord: () => ExecutionRecord,
): SessionView {
  const record = createRecord();
  for (const ev of events) {
    updateFromEvent(record, ev); // 与 live 通路同一 reducer
  }
  return projectRecordToSessionView(engineId, record);
}

function projectRecordToSessionView(engineId: string, record: ExecutionRecord): SessionView {
  // record.turns → ReplayedTurn[]（_status/startedTs 剥离，closed 恒 true）+ usage 聚合。
  // 叶子逻辑（投影细节）；形状契约见 types.ts SessionView/ReplayedTurn。
  void record;
  throw new Error(`skeleton: session view projection (engineId=${engineId})`);
}

/**
 * 第②级入口（engine read() 的降级编排消费）：handle.journalPath 自描述携带。
 * 全链失败（journal 缺失）返回 undefined → 宿主走第③级。
 */
export async function readViaJournal(handle: EngineHandleData): Promise<SessionView | undefined> {
  const events = await replayJournalEvents(handle.journalPath);
  if (!events || events.length === 0) return undefined;
  // createRecord 注入：编排层用 record 身份构造（骨架经参数解耦 execution 层构造细节）。
  throw new Error("skeleton: journal-level session view (createRecord injection by host)");
}
