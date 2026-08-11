// src/execution/__tests__/idle-marker.test.ts
//
// .idle sidecar 读写测试（M2-A：对话模式轮次完成的 idle 标记）。
//
// 参照 alive-store.test.ts 风格：write/read/remove 往返 + 损坏/缺失/字段不全降级。
// idle-marker 是纯文件 I/O（无进程依赖），直接测真实 tmpDir 文件往返。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readIdleMarker,
  removeIdleMarker,
  writeIdleMarker,
} from "../idle-marker.ts";
import type { IdleMarker } from "../idle-marker.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "idle-marker-test-"));
}

describe("idle-marker", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── writeIdleMarker + readIdleMarker 往返 ──

  it("write → read round-trip（含 rootSessionId）", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const marker: IdleMarker = {
      id: "sa-abc123",
      sessionFile,
      rootSessionId: "session-main",
      round: 1,
    };

    writeIdleMarker(sessionFile, marker);
    const result = readIdleMarker(sessionFile);

    expect(result).toEqual(marker);
    // 验证 sidecar 文件是单行 JSON（与 .alive/.cancelled 同格式族）
    const raw = fs.readFileSync(`${sessionFile}.idle`, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw.trim())).toEqual(marker);
  });

  it("write → read round-trip（rootSessionId 为 undefined）", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "s2.jsonl");
    const marker: IdleMarker = {
      id: "sa-no-root",
      sessionFile,
      rootSessionId: undefined,
      round: 5,
    };

    writeIdleMarker(sessionFile, marker);
    const result = readIdleMarker(sessionFile);

    expect(result).toEqual(marker);
    expect(result?.round).toBe(5);
  });

  it("覆盖写：同 sessionFile 第二次 write 覆盖第一次", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "s3.jsonl");

    writeIdleMarker(sessionFile, { id: "sa-1", sessionFile, rootSessionId: undefined, round: 1 });
    writeIdleMarker(sessionFile, { id: "sa-1", sessionFile, rootSessionId: undefined, round: 2 });

    const result = readIdleMarker(sessionFile);
    expect(result?.round).toBe(2);
  });

  // ── readIdleMarker 降级 ──

  it("readIdleMarker returns undefined for corrupted file", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "s4.jsonl");
    fs.writeFileSync(`${sessionFile}.idle`, "not-json", "utf-8");

    expect(readIdleMarker(sessionFile)).toBeUndefined();
  });

  it("readIdleMarker returns undefined when required fields missing（缺 round）", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "s5.jsonl");
    // round 字段缺失
    fs.writeFileSync(
      `${sessionFile}.idle`,
      `${JSON.stringify({ id: "sa-x", sessionFile })}\n`,
      "utf-8",
    );

    expect(readIdleMarker(sessionFile)).toBeUndefined();
  });

  it("readIdleMarker returns undefined when file does not exist", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "s6.jsonl");

    expect(readIdleMarker(sessionFile)).toBeUndefined();
  });

  // ── removeIdleMarker ──

  it("removeIdleMarker removes existing sidecar", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "s7.jsonl");
    writeIdleMarker(sessionFile, { id: "sa-r", sessionFile, rootSessionId: undefined, round: 1 });
    expect(fs.existsSync(`${sessionFile}.idle`)).toBe(true);

    removeIdleMarker(sessionFile);
    expect(fs.existsSync(`${sessionFile}.idle`)).toBe(false);
  });

  it("removeIdleMarker does not throw when file does not exist", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "s8.jsonl");

    expect(() => removeIdleMarker(sessionFile)).not.toThrow();
  });
});
