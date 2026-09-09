// src/execution/engine/engines/pi/__tests__/session-file-locator.test.ts
//
// [U1 D2] locateSessionFileByScan 纯函数单测（实施计划 u1-acquire 验收条款②）。
//
// 覆盖：identity 精确匹配 / mtime 过滤 / 目录缺失返回 undefined + warn / 多匹配取第一
// + warn / 坏行跳过 / 值匹配快速路径无关行不阻断 / 非目标 record 不命中 / S5 测试钩子
// env 目录重定向。
//
// 红线对齐：写删目标全部 mkdtempSync(tmpdir) 自建自删，不触碰真实数据目录。

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  locateSessionFileByScan,
  SCAN_DIR_OVERRIDE_ENV,
} from "../session-file-locator.ts";

const RECORD_ID = "run-42";

/** 构造 identity entry 行（对齐 pi 写盘序列化：单行 JSON，customType 在 entry 顶层，id 在 data.id）。 */
function identityLine(recordId: string): string {
  return JSON.stringify({
    type: "custom",
    customType: "subagent-identity",
    timestamp: "2026-09-10T00:00:00.000Z",
    data: {
      id: recordId,
      agent: "general-purpose",
      mode: "background",
      task: "do something",
      startedAt: 1_000_000,
    },
  });
}

/** 干扰行：普通 assistant message entry（不含 identity 值，走快速路径跳过）。 */
function noiseLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: "2026-09-10T00:00:01.000Z",
  });
}

/** 写 session 文件（默认 mtime = now，即大于任何「过去」的 sinceMs）。 */
function writeSessionFile(name: string, lines: string[], mtimeMs?: number): string {
  const path = join(dir, name);
  fs.writeFileSync(path, lines.join("\n") + "\n");
  if (mtimeMs !== undefined) fs.utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "session-file-locator-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  delete process.env[SCAN_DIR_OVERRIDE_ENV];
});

describe("locateSessionFileByScan（[U1 D2] sessionDir 扫描兜底）", () => {
  it("identity 精确匹配：含 record.id 的 identity entry 文件被命中（坏行与干扰行不阻断）", () => {
    const target = writeSessionFile("a.jsonl", [
      noiseLine("hello"),
      '{"type":"assistant","message":', // 坏行（截断 JSON）→ 跳过
      identityLine(RECORD_ID), // identity 落点不固定（非首行）→ 整文件前向读覆盖
      noiseLine("world"),
    ]);

    // sinceMs 取 1 分钟前：新写文件 mtime（now）必然大于基准
    const hit = locateSessionFileByScan({ id: RECORD_ID }, dir, Date.now() - 60_000);

    expect(hit).toBe(target);
  });

  it("mtime 过滤：mtime 早于 sinceMs 的文件即使含目标 identity 也不作为候选", () => {
    const sinceMs = Date.now() - 60_000;
    // 旧文件（mtime < sinceMs）含目标 identity——若被扫描将命中，命中不了才证明过滤生效
    writeSessionFile("old.jsonl", [identityLine(RECORD_ID)], sinceMs - 30_000);
    // 新文件不含目标 identity
    writeSessionFile("new.jsonl", [noiseLine("unrelated")]);

    const hit = locateSessionFileByScan({ id: RECORD_ID }, dir, sinceMs);

    expect(hit).toBeUndefined();
  });

  it("mtime 降序：多匹配（理论不可达形态）取 mtime 最新的第一个", () => {
    const sinceMs = Date.now() - 60_000;
    writeSessionFile("older.jsonl", [identityLine(RECORD_ID)], sinceMs + 10_000);
    const newest = writeSessionFile("newer.jsonl", [identityLine(RECORD_ID)], sinceMs + 20_000);

    const hit = locateSessionFileByScan({ id: RECORD_ID }, dir, sinceMs);

    expect(hit).toBe(newest);
  });

  it("目录不存在 → undefined（不抛，调用方继续走重试/翻转分支）", () => {
    const missing = join(dir, "does-not-exist");

    const hit = locateSessionFileByScan({ id: RECORD_ID }, missing, Date.now() - 60_000);

    expect(hit).toBeUndefined();
  });

  it("目录存在但无匹配（候选非 jsonl / 无 identity / record.id 不符）→ undefined", () => {
    writeSessionFile("not-jsonl.txt", [identityLine(RECORD_ID)]); // 非 .jsonl 排除
    writeSessionFile("other.jsonl", [identityLine("run-other")]); // record.id 不符
    fs.mkdirSync(join(dir, "nested.jsonl")); // 目录名撞 .jsonl 后缀 → 非普通文件排除
    const hit = locateSessionFileByScan({ id: RECORD_ID }, dir, Date.now() - 60_000);

    expect(hit).toBeUndefined();
  });

  it("identity 精确匹配不按 mtime 猜：目录里更新鲜的其他 record 文件不被误命中", () => {
    const sinceMs = Date.now() - 60_000;
    writeSessionFile("sibling.jsonl", [noiseLine("sibling is fresher")], sinceMs + 30_000);
    const target = writeSessionFile("mine.jsonl", [identityLine(RECORD_ID)], sinceMs + 10_000);

    const hit = locateSessionFileByScan({ id: RECORD_ID }, dir, sinceMs);

    expect(hit).toBe(target);
  });

  it("[S5 测试钩子] " + SCAN_DIR_OVERRIDE_ENV + " 设值时扫描目录被重定向（生产不设恒 no-op）", () => {
    // 真实入参目录有目标 identity；钩子目录为空 → 重定向后 miss，证明 env 生效
    writeSessionFile("a.jsonl", [identityLine(RECORD_ID)]);
    const emptyDir = fs.mkdtempSync(join(tmpdir(), "session-file-locator-empty-"));
    try {
      process.env[SCAN_DIR_OVERRIDE_ENV] = emptyDir;
      const redirected = locateSessionFileByScan({ id: RECORD_ID }, dir, Date.now() - 60_000);
      expect(redirected).toBeUndefined();
    } finally {
      delete process.env[SCAN_DIR_OVERRIDE_ENV]; // 先摘钩子再清目录，后半段扫真实入参目录
      fs.rmSync(emptyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }

    // 不设 env（生产形态）→ 扫真实入参目录命中
    const hit = locateSessionFileByScan({ id: RECORD_ID }, dir, Date.now() - 60_000);
    expect(hit).toBe(join(dir, "a.jsonl"));
  });
});
