// src/__tests__/tombstone-store.test.ts
//
// tombstone-store 专属测试。
// 覆盖：write→read 往返 / 缺 sidecar → undefined / 损坏 sidecar → undefined / 结构校验。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCancelledTombstone, writeCancelledTombstone } from "../tombstone-store.ts";

describe("tombstone-store", () => {
  let tmpDir: string;
  let sessionFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-test-"));
    sessionFile = path.join(tmpDir, "2026-01-01_uuid.jsonl");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  describe("write → read 往返", () => {
    it("写入后读回完整数据", () => {
      writeCancelledTombstone(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "worker", startedAt: 1000, endedAt: 2000,
      });
      const tomb = readCancelledTombstone(sessionFile);
      expect(tomb).toEqual({
        id: "bg-1", status: "cancelled", agent: "worker", startedAt: 1000, endedAt: 2000,
      });
    });

    it("sidecar 路径 = sessionFile + '.cancelled'", () => {
      writeCancelledTombstone(sessionFile, {
        id: "bg-1", status: "cancelled", agent: "w", startedAt: 1, endedAt: 2,
      });
      expect(fs.existsSync(`${sessionFile}.cancelled`)).toBe(true);
    });
  });

  describe("读降级", () => {
    it("无 sidecar → undefined（正常——非 cancelled record）", () => {
      expect(readCancelledTombstone(sessionFile)).toBeUndefined();
    });

    it("损坏 JSON → undefined", () => {
      fs.writeFileSync(`${sessionFile}.cancelled`, "NOT JSON\n", "utf-8");
      expect(readCancelledTombstone(sessionFile)).toBeUndefined();
    });

    it("status 非 'cancelled' → undefined", () => {
      fs.writeFileSync(
        `${sessionFile}.cancelled`,
        `${JSON.stringify({ id: "x", status: "done", agent: "w", startedAt: 1, endedAt: 2 })}\n`,
        "utf-8",
      );
      expect(readCancelledTombstone(sessionFile)).toBeUndefined();
    });

    it("缺必填字段 → undefined", () => {
      fs.writeFileSync(
        `${sessionFile}.cancelled`,
        `${JSON.stringify({ id: "x", status: "cancelled" })}\n`, // 缺 agent/startedAt/endedAt
        "utf-8",
      );
      expect(readCancelledTombstone(sessionFile)).toBeUndefined();
    });
  });
});
