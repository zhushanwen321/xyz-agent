/**
 * spawn.ts 单元测试
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run src/__tests__/spawn.test.ts
 */

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────

const { mockSpawn, mockExistsSync, mockMkdirSync, mockReaddirSync, mockStatSync, mockUnlinkSync, mockWriteFile, mockRandomUUID } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockWriteFile: vi.fn(),
  mockRandomUUID: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  unlinkSync: mockUnlinkSync,
  promises: {
    writeFile: mockWriteFile,
  },
}));

vi.mock("node:os", () => ({
  tmpdir: () => "/tmp",
}));

// Import AFTER mocks are set up
import { getFinalOutput, cleanupOldTempFiles, runSingleVisionAgent } from "../spawn.js";

// ── Helpers ────────────────────────────────────────────

function createMockChildProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn();
  return proc;
}

// ── Tests ──────────────────────────────────────────────

describe("getFinalOutput", () => {
  it("returns the last assistant text content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    ] as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(getFinalOutput(messages)).toBe("final answer");
  });

  it("returns empty string when no assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ] as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(getFinalOutput(messages)).toBe("");
  });

  it("skips assistant messages with empty text", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "   " }] },
      { role: "assistant", content: [{ type: "text", text: "real answer" }] },
    ] as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(getFinalOutput(messages)).toBe("real answer");
  });
});

describe("cleanupOldTempFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates temp dir if it does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    cleanupOldTempFiles();
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/pi-vision", { recursive: true });
  });

  it("deletes files older than 1 hour", () => {
    const now = Date.now();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "old-file.md", isFile: () => true },
      { name: "new-file.md", isFile: () => true },
    ]);
    mockStatSync.mockImplementation((p: string) => {
      if (p.includes("old-file")) return { mtimeMs: now - 7200_000 }; // 2 hours old
      return { mtimeMs: now - 1000 }; // 1 second old
    });

    cleanupOldTempFiles();

    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining("old-file"));
  });

  it("skips non-file entries", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "subdir", isFile: () => false },
    ]);

    cleanupOldTempFiles();

    expect(mockStatSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("ignores unlink errors silently", () => {
    const now = Date.now();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "stale.md", isFile: () => true },
    ]);
    mockStatSync.mockReturnValue({ mtimeMs: now - 7200_000 });
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    // Should not throw
    expect(() => cleanupOldTempFiles()).not.toThrow();
  });
});

describe("runSingleVisionAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRandomUUID.mockReturnValue("12345678-aaaa-bbbb-cccc-ddddeeeeffff");
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFile.mockResolvedValue(undefined);
    // Default: no temp dir exists
    mockExistsSync.mockReturnValue(false);
  });

  it("completes a normal spawn flow with JSON events", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runSingleVisionAgent({
      task: "describe image",
      systemPrompt: "You are vision",
      resolvedModel: "test/model",
      cwd: "/work",
    });

    // Wait for spawn to be called so event listeners are registered
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Simulate child emitting a message_end event
    const event = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "An image of a cat" }],
        model: "test/model",
        stopReason: "end_turn",
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 }, totalTokens: 150 },
      },
    });
    proc.stdout.emit("data", Buffer.from(event + "\n"));

    // Simulate close after a tick so stdout data is processed
    setTimeout(() => proc.emit("close", 0), 10);

    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(result.messages).toHaveLength(1);
    expect(result.model).toBe("test/model");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
    expect(result.usage.turns).toBe(1);
  }, 10000);

  it("handles spawn error gracefully", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "",
      resolvedModel: "m",
      cwd: "/w",
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    proc.emit("error", new Error("ENOENT"));

    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("ENOENT");
  });

  it("cleans up temp file in finally block", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "system prompt text",
      resolvedModel: "m",
      cwd: "/w",
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    setTimeout(() => proc.emit("close", 0), 10);
    await promise;

    // unlinkSync should have been called for the temp prompt file
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("vision-prompt-"),
    );
  }, 10000);

  it("handles tool_result_end events", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "",
      resolvedModel: "m",
      cwd: "/w",
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    const toolEvent = JSON.stringify({
      type: "tool_result_end",
      message: {
        role: "tool",
        content: [{ type: "text", text: "file content" }],
      },
    });
    proc.stdout.emit("data", Buffer.from(toolEvent + "\n"));
    setTimeout(() => proc.emit("close", 0), 10);

    const result = await promise;

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("tool");
  }, 10000);

  it("ignores non-JSON lines in stdout", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "",
      resolvedModel: "m",
      cwd: "/w",
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    proc.stdout.emit("data", Buffer.from("not json\n"));
    proc.stdout.emit("data", Buffer.from("\n"));
    setTimeout(() => proc.emit("close", 0), 10);

    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(result.messages).toHaveLength(0);
  }, 10000);

  it("collects stderr output", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "",
      resolvedModel: "m",
      cwd: "/w",
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    proc.stderr.emit("data", Buffer.from("warning: "));
    proc.stderr.emit("data", Buffer.from("deprecated flag\n"));
    setTimeout(() => proc.emit("close", 0), 10);

    const result = await promise;

    expect(result.stderr).toBe("warning: deprecated flag\n");
  }, 10000);

  it("calls onUpdate callback when message arrives", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const onUpdate = vi.fn();

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "",
      resolvedModel: "m",
      cwd: "/w",
      onUpdate,
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    const event = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "result" }],
        usage: { input: 10, output: 5 },
      },
    });
    proc.stdout.emit("data", Buffer.from(event + "\n"));
    setTimeout(() => proc.emit("close", 0), 10);

    await promise;

    expect(onUpdate).toHaveBeenCalled();
    expect(onUpdate.mock.calls[0]![0].content[0].text).toBe("result");
  }, 10000);

  it("sets SIGTERM on abort signal", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "",
      resolvedModel: "m",
      cwd: "/w",
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    controller.abort();

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    // Resolve the promise
    setTimeout(() => proc.emit("close", null), 10);
    await promise;
  }, 10000);

  it("sets durationMs based on startTime", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "",
      resolvedModel: "m",
      cwd: "/w",
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    setTimeout(() => proc.emit("close", 0), 10);

    const result = await promise;

    expect(result.startTime).toBeGreaterThan(0);
    expect(result.endTime).toBeGreaterThanOrEqual(result.startTime);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 10000);

  it("does not write temp file when systemPrompt is empty", async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runSingleVisionAgent({
      task: "test",
      systemPrompt: "   ",
      resolvedModel: "m",
      cwd: "/w",
    });

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    setTimeout(() => proc.emit("close", 0), 10);
    await promise;

    // No temp file should be created
    expect(mockWriteFile).not.toHaveBeenCalled();
    // No unlink should be attempted
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  }, 10000);
});
