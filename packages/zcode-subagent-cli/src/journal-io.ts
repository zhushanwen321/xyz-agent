// src/journal-io.ts
//
// read 第②级（journal 重放）的引擎包承接：journal 文件 I/O（replayJournal）+
// replayJournalToSessionView 编排。reducer 本体（eventsToSessionView /
// updateFromEvent / toReplayedTurn / aggregateUsage）用 SDK journal-replay——
// 与 core live reducer 同源（W1 已把纯投影部分下沉 SDK，见 SDK 该文件头注）。
//
// 与 core 版差异（登记）：core replayJournalToSessionView 消费 core
// common/event-journal.ts 的 replayJournal；引擎包进程内无 core，此处按同一
// JournalLine v1 行格式（{v,ts,taskId,engineId,seq,event}，seq 排序、坏行跳过）
// 自持解析——格式漂移面由 W10 golden 往返测试覆盖。

import { readFileSync } from "node:fs";

import {
  eventsToSessionView,
  sessionIdFromHandle,
  type AgentEvent,
  type EngineHandleData,
} from "@zhushanwen/subagent-engine-sdk";

/** 单行结构（v=1 journal 行；engineId/taskId 仅诊断字段，重放不消费）。 */
interface JournalLine {
  seq: number;
  event: AgentEvent;
}

/** 读 journal 文件 → 事件序列（seq 升序；缺文件/坏行跳过——②级降级语义）。 */
export function replayJournal(path: string): AgentEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines: JournalLine[] = [];
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    const parsed = parseLine(trimmed);
    if (parsed !== undefined) lines.push(parsed);
  }
  lines.sort((a, b) => a.seq - b.seq);
  return lines.map((l) => l.event);
}

/** 单行 parse + 结构 guard（v=1 + event 形状最小判别：object 且 type 为 string）。 */
function parseLine(trimmed: string): JournalLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  const event = rec.event;
  if (rec.v !== 1 || typeof rec.ts !== "number" || typeof rec.seq !== "number") return undefined;
  if (typeof event !== "object" || event === null || typeof (event as Record<string, unknown>).type !== "string") {
    return undefined;
  }
  return { seq: rec.seq, event: event as AgentEvent };
}

/**
 * journal → SessionView（read 第②级）。
 * 返回 undefined = ②级不可达（journal 路径缺省 / 文件不存在 / 无事件），调用方落 ③级。
 */
export function replayJournalToSessionView(handle: { data: EngineHandleData }, engineId: string) {
  const journalPath = handle.data.journalPath;
  if (journalPath === undefined) return undefined;
  const events = replayJournal(journalPath);
  if (events.length === 0) return undefined;
  return eventsToSessionView(events, engineId, sessionIdFromHandle(handle.data));
}
