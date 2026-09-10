// src/__tests__/session-file-locator.test.ts
//
// M4 close 兜底扫描器单测（设计 §3.3 决策 4 / §3.4 错误规格 / V4）。
//
// 覆盖：单命中（原文 + JSON 转义双形态）/ 零命中 / 多命中 / 坏行容错（截断 +
// 非法 UTF8）/ 降级门（候选数 64 / 耗时 100ms）/ fs 异常降级（readdir / stat 抛错
// 均返回放弃而非抛出）/ 空 prompt / 头部键语义（200 字符 + 代理对边界）。
//
// 测试文件写删目标全部 mkdtempSync 自建自删（tmpdir 白名单内，不触碰真实数据目录）；
// session 文件按实装 pi 0.84.4 落盘形态构造（逐行 JSON.stringify，见 K3① 探针）。

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEADER_READ_BYTES,
  MAX_SCAN_CANDIDATES,
  PROMPT_HEAD_CHARS,
  SCAN_TIME_BUDGET_MS,
  locateSessionFileByPromptHead,
  type SessionFileScanInput,
} from "../session-file-locator.ts";

/** 窗口基准（本文件全部 fixture 的 mtime 锚点）。 */
const WINDOW_START = Date.parse("2026-09-10T00:00:00.000Z");
const WINDOW_END = WINDOW_START + 60_000;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "m4-locator-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 按实装 pi 落盘形态写一份 session 文件（逐行 JSON.stringify）并钉住 mtime。 */
function writeSessionFile(name: string, prompt: string, mtimeMs = WINDOW_START + 1000): string {
  const filePath = join(dir, name);
  const entry = {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-09-10T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(entry)}\n`);
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

/** 扫描入参（窗口默认覆盖 fixture；prompt 缺省为空串）。 */
function scanInput(overrides: Partial<SessionFileScanInput> = {}): SessionFileScanInput {
  return {
    sessionDir: dir,
    spawnStartedAtMs: WINDOW_START,
    closeAtMs: WINDOW_END,
    prompt: "任务 prompt",
    ...overrides,
  };
}

describe("locateSessionFileByPromptHead", () => {
  it("单命中：含引号/换行/反斜杠/制表的 prompt 经 JSON 转义形态命中，并回审计证据", () => {
    const prompt = '使用 "引号" 与 C:\\tmp\\x\n第二行\t制表\n第三行';
    const filePath = writeSessionFile("a.jsonl", prompt);
    const expectedMtime = fs.statSync(filePath).mtimeMs;

    const result = locateSessionFileByPromptHead(scanInput({ prompt }));

    expect(result.sessionFile).toBe(filePath);
    expect(result.reason).toBeUndefined();
    expect(result.candidateCount).toBe(1);
    expect(result.matchedFileName).toBe("a.jsonl");
    expect(result.matchedMtimeMs).toBe(expectedMtime);
    expect(result.promptHeadHash).toHaveLength(16);
    expect(result.errorMessage).toBeUndefined();
  });

  it("K3① 反证：文件内无原文形态 → 只做原文 includes 必 miss，双形态才命中", () => {
    // 含真实换行 + 引号 + 反斜杠的 prompt（真实任务 prompt 的常态形态）
    const prompt = '第一行无特殊字符\n第二行 "引号" 与反斜杠 \\';
    const filePath = writeSessionFile("escaped-only.jsonl", prompt);
    const raw = fs.readFileSync(filePath, "utf8");

    // 原文形态（真实换行）在文件里不存在；具体到「首行 + 真实换行 + 次行前缀」也 miss
    expect(raw.includes("第一行无特殊字符\n第二行")).toBe(false);
    expect(raw.includes(prompt)).toBe(false);
    // JSON 转义形态存在（pi 落盘 = 逐行 JSON.stringify）
    expect(raw.includes(JSON.stringify(prompt).slice(1, -1))).toBe(true);
    // 双形态键命中 → 采纳（若只留原文键，此处必为 no_match）
    const result = locateSessionFileByPromptHead(scanInput({ prompt }));
    expect(result.sessionFile).toBe(filePath);
    expect(result.reason).toBeUndefined();
  });

  it("单命中：无特殊字符的 prompt 走原文形态；超 200 字符的 prompt 按头部命中", () => {
    const prompt = `纯中文任务描述${"尾部".repeat(200)}`;
    const filePath = writeSessionFile("plain.jsonl", prompt);

    const result = locateSessionFileByPromptHead(scanInput({ prompt }));

    expect(prompt.length).toBeGreaterThan(PROMPT_HEAD_CHARS);
    expect(result.sessionFile).toBe(filePath);
    expect(result.reason).toBeUndefined();
  });

  it("零命中：候选存在但内容不含 prompt 头 → no_match", () => {
    writeSessionFile("other.jsonl", "完全不同的任务 prompt");

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "本 run 的 prompt 头" }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("no_match");
    expect(result.candidateCount).toBe(1);
    expect(result.matchedFileName).toBeUndefined();
    expect(result.matchedMtimeMs).toBeUndefined();
  });

  it("零候选：mtime 窗口外 / 非 .jsonl / 同名目录均不进候选 → no_candidates", () => {
    writeSessionFile("too-old.jsonl", "本 run 的 prompt", WINDOW_START - 5000);
    writeSessionFile("too-new.jsonl", "本 run 的 prompt", WINDOW_END + 5000);
    writeSessionFile("not-jsonl.txt", "本 run 的 prompt");
    fs.mkdirSync(join(dir, "dir.jsonl"));

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "本 run 的 prompt" }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("no_candidates");
    expect(result.candidateCount).toBe(0);
  });

  it("多命中：同 prompt 双文件 → 放弃（安全语义，不猜）", () => {
    writeSessionFile("twin-a.jsonl", "同模板任务 prompt");
    writeSessionFile("twin-b.jsonl", "同模板任务 prompt");

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "同模板任务 prompt" }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("multiple_matches");
    expect(result.candidateCount).toBe(2);
  });

  it("多命中（头部键失效面）：头部 200 字符相同、尾部不同 → 仍放弃", () => {
    const shared = "同模板前缀".repeat(60);
    expect(shared.length).toBeGreaterThan(PROMPT_HEAD_CHARS);
    const prompt = `${shared}-本 run 的任务参数 A`;
    writeSessionFile("head-a.jsonl", prompt);
    writeSessionFile("head-b.jsonl", `${shared}-另一个 run 的任务参数 B`);

    const result = locateSessionFileByPromptHead(scanInput({ prompt }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("multiple_matches");
    expect(result.candidateCount).toBe(2);
  });

  it("降级门：候选数 > MAX_SCAN_CANDIDATES → candidate_limit（计数为实际候选总数）", () => {
    for (let i = 0; i <= MAX_SCAN_CANDIDATES; i++) {
      writeSessionFile(`many-${i}.jsonl`, "同模板任务 prompt");
    }

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "同模板任务 prompt" }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("candidate_limit");
    expect(result.candidateCount).toBe(MAX_SCAN_CANDIDATES + 1);
  });

  it("降级门：单次扫描耗时 > SCAN_TIME_BUDGET_MS → time_budget", () => {
    writeSessionFile("slow.jsonl", "任务 prompt");
    // 时钟注入：startMs=0，循环内首次读钟即超预算（确定性触发，不真等 100ms）
    let ticks = 0;
    const now = (): number => {
      ticks++;
      return ticks === 1 ? 0 : SCAN_TIME_BUDGET_MS + 1;
    };

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "任务 prompt" }), { now });

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("time_budget");
  });

  it("坏行容错：截断 JSON / 非法 UTF8 候选不拖垮扫描，好候选仍命中", () => {
    // 截断候选（无闭合括号，内容不含 prompt 头）
    fs.writeFileSync(join(dir, "truncated.jsonl"), '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"半截');
    // 非法 UTF8 候选（0xff 0xfe 头 + 无关文本）
    fs.writeFileSync(join(dir, "binary.jsonl"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("无关任务\n", "utf8")]));
    fs.utimesSync(join(dir, "truncated.jsonl"), (WINDOW_START + 500) / 1000, (WINDOW_START + 500) / 1000);
    fs.utimesSync(join(dir, "binary.jsonl"), (WINDOW_START + 500) / 1000, (WINDOW_START + 500) / 1000);
    const goodPath = writeSessionFile("good.jsonl", "本 run 的 prompt");

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "本 run 的 prompt" }));

    expect(result.sessionFile).toBe(goodPath);
    expect(result.candidateCount).toBe(3);
    expect(result.reason).toBeUndefined();
  });

  it("坏行容错：仅坏候选 → no_match（不抛错）", () => {
    const truncatedPath = join(dir, "truncated.jsonl");
    fs.writeFileSync(truncatedPath, '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"半截');
    fs.utimesSync(truncatedPath, (WINDOW_START + 500) / 1000, (WINDOW_START + 500) / 1000);

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "本 run 的 prompt" }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("no_match");
    expect(result.candidateCount).toBe(1);
  });

  it("fs 异常：sessionDir 不存在（readdir 抛）→ fs_error 且不抛出", () => {
    const result = locateSessionFileByPromptHead(scanInput({ sessionDir: join(dir, "missing-dir") }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("fs_error");
    expect(result.errorMessage).toBeTruthy();
  });

  it("fs 异常：sessionDir 是文件（readdir ENOTDIR）→ fs_error 且不抛出", () => {
    const asFile = join(dir, "not-a-dir.jsonl");
    fs.writeFileSync(asFile, "x");

    const result = locateSessionFileByPromptHead(scanInput({ sessionDir: asFile }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("fs_error");
    expect(result.errorMessage).toBeTruthy();
  });

  it("fs 异常：候选在 stat 前消失（stat 抛）→ 整体放弃 fs_error 且不抛出", () => {
    const filePath = writeSessionFile("vanishing.jsonl", "任务 prompt");
    // startMs 读钟后、stat 读钟前删除候选（确定性制造 stat ENOENT）
    let ticks = 0;
    const now = (): number => {
      ticks++;
      if (ticks === 2) fs.rmSync(filePath, { force: true });
      return WINDOW_START;
    };

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "任务 prompt" }), { now });

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("fs_error");
    expect(result.errorMessage).toBeTruthy();
  });

  it("空 prompt → empty_prompt_head（不误配任何文件）", () => {
    writeSessionFile("any.jsonl", "任意任务");

    const result = locateSessionFileByPromptHead(scanInput({ prompt: "" }));

    expect(result.sessionFile).toBeUndefined();
    expect(result.reason).toBe("empty_prompt_head");
  });

  it("代理对边界：截断点落在高代理时丢弃半字符，仍能命中全文前缀", () => {
    // 第 200 个 UTF-16 单元是 emoji 的高代理——不丢弃则两形态均失配（静默失效）
    const prompt = `${"x".repeat(PROMPT_HEAD_CHARS - 1)}😀 尾部任务参数`;
    const filePath = writeSessionFile("emoji.jsonl", prompt);

    const result = locateSessionFileByPromptHead(scanInput({ prompt }));

    expect(result.sessionFile).toBe(filePath);
    expect(result.reason).toBeUndefined();
  });

  it("头读窗口常量 = 64KB（决策 4 契约）", () => {
    expect(HEADER_READ_BYTES).toBe(64 * 1024);
    expect(PROMPT_HEAD_CHARS).toBe(200);
  });
});
