// src/execution/__tests__/manifest-store-tmp-recovery.test.ts
//
// [u-svc / T5④ / PS-13] recoverTmpFiles 循环内 per-file 容错：
// 单个 tmp 文件操作失败（ENOENT——并发回收/外部清理抢先）只 warn + 跳过，
// 不再中断整轮——剩余 tmp 继续处理；返回值形态不变（跳过者不计数）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// fs partial mock：unlinkSync 可按路径注错，其余转发真实实现。
const { unlinkSyncMock } = vi.hoisted(() => ({ unlinkSyncMock: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: unlinkSyncMock,
    default: { ...actual, unlinkSync: unlinkSyncMock },
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ManifestStore } from "../manifest-store.ts";

const VALID_MANIFEST = {
  id: "sa-good",
  rootSessionId: "root-1",
  agentName: "general-purpose",
  createdAt: 1,
  status: "running",
};

describe("T5④ recoverTmpFiles per-file tolerance", () => {
  let dir: string;
  let store: ManifestStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-tmp-recovery-"));
    store = new ManifestStore(dir);
    // 真实 unlinkSync（mock 模块对象上的 unlinkSync 已被替换，不能自引用转发）
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    unlinkSyncMock.mockReset();
    unlinkSyncMock.mockImplementation((p: fs.PathLike) => actualFs.unlinkSync(p));
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("processes remaining tmp files when one unlink fails mid-loop", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    // 三个 tmp：good（合法 → promote）、stale（manifest sa-stale.json 已存在 → 删）、
    // doomed（unlink ENOENT）
    fs.writeFileSync(path.join(dir, "sa-good.json.tmp.111"), JSON.stringify(VALID_MANIFEST));
    fs.writeFileSync(path.join(dir, "sa-stale.json"), JSON.stringify(VALID_MANIFEST));
    fs.writeFileSync(path.join(dir, "sa-stale.json.tmp.222"), "{}");
    fs.writeFileSync(path.join(dir, "sa-doomed.json.tmp.333"), "not json");
    const doomedPath = path.join(dir, "sa-doomed.json.tmp.333");
    unlinkSyncMock.mockImplementation((p: fs.PathLike) => {
      if (String(p) === doomedPath) {
        const err = new Error("ENOENT: file vanished") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actualFs.unlinkSync(p);
    });

    const result = await store.recoverTmpFiles();

    // 整轮不中断：doomed 之外的 tmp 全部处理完
    expect(result.recovered).toBe(1); // good promote
    expect(result.deleted).toBe(1); // stale 删
    // good 被提升为正式 manifest
    expect(fs.existsSync(path.join(dir, "sa-good.json"))).toBe(true);
    // 失败留痕（warn 级，含文件名）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("sa-doomed.json.tmp.333"),
      expect.objectContaining({ detail: expect.stringContaining("ENOENT") }),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("1 of 3 tmp file(s)"));
  });

  it("returns counts unchanged and no warnings when all tmp files succeed", async () => {
    fs.writeFileSync(path.join(dir, "sa-ok.json.tmp.444"), JSON.stringify(VALID_MANIFEST));
    const result = await store.recoverTmpFiles();
    expect(result).toEqual({ deleted: 0, recovered: 1 });
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
