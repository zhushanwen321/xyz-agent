// src/__tests__/finalized-marker.test.ts
//
// finalized-marker 专属测试。
// 覆盖：write→read 往返 / 缺 sidecar → false / best-effort IO 错静默 / .cancelled 互斥。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFinalized, readFinalizedReason, writeFinalized } from "../finalized-marker.ts";

describe("finalized-marker", () => {
  let tmpDir: string;
  let sessionFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-test-"));
    sessionFile = path.join(tmpDir, "2026-01-01_uuid.jsonl");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("write → read 往返", () => {
    it("写入后 readFinalized 返回 true", () => {
      writeFinalized(sessionFile);
      expect(readFinalized(sessionFile)).toBe(true);
    });

    it("sidecar 路径 = sessionFile + '.finalized'", () => {
      writeFinalized(sessionFile);
      expect(fs.existsSync(`${sessionFile}.finalized`)).toBe(true);
    });

    it("sidecar 内容为空（无 reason 时保持旧格式兼容）", () => {
      writeFinalized(sessionFile);
      const content = fs.readFileSync(`${sessionFile}.finalized`, "utf-8");
      expect(content).toBe("");
      expect(readFinalizedReason(sessionFile)).toBe("");
    });

    // [v8.5 A2] 携带真实 closedReason 写入 → 读取返回原值（trim 后）
    it("带 reason 写入 → readFinalizedReason 返回原值", () => {
      writeFinalized(sessionFile, "user-close");
      expect(readFinalized(sessionFile)).toBe(true);
      expect(readFinalizedReason(sessionFile)).toBe("user-close");

      writeFinalized(sessionFile, "parent-shutdown");
      expect(readFinalizedReason(sessionFile)).toBe("parent-shutdown");
    });

    it("带 reason 的内容含首尾空白时 trim 后返回", () => {
      fs.writeFileSync(`${sessionFile}.finalized`, "  gc \n", "utf-8");
      expect(readFinalizedReason(sessionFile)).toBe("gc");
    });
  });

  describe("readFinalizedReason 无 sidecar", () => {
    it("不存在 → undefined（与「存在但空串」区分）", () => {
      expect(readFinalizedReason(sessionFile)).toBeUndefined();
    });
  });

  describe("readFinalized 无 sidecar", () => {
    it("不存在 → false", () => {
      expect(readFinalized(sessionFile)).toBe(false);
    });
  });

  describe("best-effort IO 错静默", () => {
    it("writeFileSync 抛错时不抛出", () => {
      // 目标路径不存在（不存在的父目录），writeFileSync 会抛
      const badPath = path.join(tmpDir, "nonexistent-sub", "session.jsonl");
      expect(() => writeFinalized(badPath)).not.toThrow();
    });

    it("写失败后 readFinalized 返回 false（sidecar 未写入）", () => {
      const badPath = path.join(tmpDir, "nonexistent-sub", "session.jsonl");
      writeFinalized(badPath); // 静默失败
      expect(readFinalized(badPath)).toBe(false);
    });
  });

  describe("与 .cancelled 互斥（BC-4）", () => {
    it("写 finalized 时删除已有的 .cancelled", () => {
      // 先写一个 .cancelled sidecar
      fs.writeFileSync(`${sessionFile}.cancelled`, `{"id":"bg-1","status":"cancelled","agent":"w","startedAt":1,"endedAt":2}\n`, "utf-8");
      expect(fs.existsSync(`${sessionFile}.cancelled`)).toBe(true);

      // 写 finalized → .cancelled 应被删除
      writeFinalized(sessionFile);
      expect(fs.existsSync(`${sessionFile}.cancelled`)).toBe(false);
      expect(readFinalized(sessionFile)).toBe(true);
    });

    it("无 .cancelled 时写 finalized 正常（不报错）", () => {
      expect(fs.existsSync(`${sessionFile}.cancelled`)).toBe(false);
      expect(() => writeFinalized(sessionFile)).not.toThrow();
      expect(readFinalized(sessionFile)).toBe(true);
    });
  });
});
