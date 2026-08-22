/**
 * index.ts wiring SDK 契约测试（round3 review：替换占位测试）。
 *
 * 复用 system-prompt-trace index-wiring.test.ts 的 Proxy 假体模式：
 * - pi 用 Proxy 假体：捕获 registerCommand 注册的命令定义 + appendEntry 落点
 * - ctx 只需 index.ts 实际消费的字段（reload / navigateTree / getSystemPrompt），
 *   以 ExtensionCommandContext 最小形状驱动 handler（SDK 双参契约 (args, ctx)）
 * - index.ts 对 @earendil-works/pi-coding-agent 是 type-only import（运行时擦除），
 *   无需 vi.mock SDK 模块
 *
 * 锚定三命令注册面 + handler 行为：
 * - __xyz_reload__（host 触发的 skill/extension 重载内部命令）→ ctx.reload()
 * - xyz-navigate（session tree 导航）→ 空 entryId 早退；有效 entryId →
 *   ctx.navigateTree(entryId, { summarize: false })
 * - __xyz_get_system_prompt__（Trace 视图「现取当前值」通道）→ pi.appendEntry
 *   写 xyz:current-system-prompt custom entry（fullText/charCount/fetchedAt 形状）
 *
 * 运行：cd extensions/taiji/agent-ext && npx vitest run
 */
import { describe, it, expect, vi } from "vitest";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

interface RecordedCommand {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

interface RecordedEntry {
  customType: string;
  data: unknown;
}

interface WiringHarness {
  pi: ExtensionAPI;
  commands: Map<string, RecordedCommand>;
  entries: RecordedEntry[];
}

/** Proxy 假体 pi：捕获 registerCommand 注册面与 appendEntry 落点（其余成员 no-op）。 */
function createWiringHarness(): WiringHarness {
  const commands = new Map<string, RecordedCommand>();
  const entries: RecordedEntry[] = [];
  const pi = new Proxy<ExtensionAPI>({} as ExtensionAPI, {
    get(_target: unknown, prop: string | symbol): unknown {
      if (prop === "registerCommand") {
        return (name: string, def: RecordedCommand): void => {
          commands.set(name, def);
        };
      }
      if (prop === "appendEntry") {
        return (customType: string, data?: unknown): void => {
          entries.push({ customType, data });
        };
      }
      return (): void => undefined;
    },
  });
  return { pi, commands, entries };
}

/** ctx 假体（index.ts 实际消费：reload / navigateTree / getSystemPrompt；vi.fn 捕获调用）。 */
function createCtx(prompt = "current system prompt"): {
  ctx: ExtensionCommandContext;
  reload: ReturnType<typeof vi.fn>;
  navigateTree: ReturnType<typeof vi.fn>;
  getSystemPrompt: ReturnType<typeof vi.fn>;
} {
  const reload = vi.fn();
  const navigateTree = vi.fn();
  const getSystemPrompt = vi.fn(() => prompt);
  const ctx = {
    cwd: "/home/user/project",
    reload,
    navigateTree,
    getSystemPrompt,
  } as unknown as ExtensionCommandContext;
  return { ctx, reload, navigateTree, getSystemPrompt };
}

/** 以 SDK 双参契约 (args, ctx) 驱动已注册命令 handler。 */
async function runCommand(
  h: WiringHarness,
  name: string,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const cmd = h.commands.get(name);
  if (cmd === undefined) throw new Error(`command "${name}" not registered`);
  await cmd.handler(args, ctx);
}

/** 加载默认导出工厂（wiring 入口）。 */
async function loadExtension(): Promise<(pi: ExtensionAPI) => void> {
  const mod = await import("../index.js");
  return mod.default;
}

describe("index.ts wiring SDK 契约", () => {
  it("注册恰好三个命令（__xyz_reload__ / xyz-navigate / __xyz_get_system_prompt__），各带非空 description", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    expect([...h.commands.keys()].sort()).toEqual([
      "__xyz_get_system_prompt__",
      "__xyz_reload__",
      "xyz-navigate",
    ]);
    for (const def of h.commands.values()) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.handler).toBe("function");
    }
  });

  it("__xyz_reload__ handler → 调 ctx.reload()（host 触发的 skill/extension 重载，无参）", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    const { ctx, reload } = createCtx();
    await runCommand(h, "__xyz_reload__", "", ctx);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith();
  });

  it("xyz-navigate 空 entryId（空串/纯空白）→ 早退，不调 ctx.navigateTree", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    const { ctx, navigateTree } = createCtx();
    await runCommand(h, "xyz-navigate", "", ctx);
    await runCommand(h, "xyz-navigate", "   ", ctx);
    expect(navigateTree).not.toHaveBeenCalled();
  });

  it("xyz-navigate 有效 entryId → ctx.navigateTree(entryId, { summarize: false })（args 去首尾空白）", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    const { ctx, navigateTree } = createCtx();
    await runCommand(h, "xyz-navigate", " 0198f-entry-1  ", ctx);
    expect(navigateTree).toHaveBeenCalledTimes(1);
    expect(navigateTree).toHaveBeenCalledWith("0198f-entry-1", { summarize: false });
  });

  it("__xyz_get_system_prompt__ → appendEntry 写 xyz:current-system-prompt（fullText/charCount/fetchedAt 形状，不写其他 customType）", async () => {
    const ext = await loadExtension();
    const h = createWiringHarness();
    ext(h.pi);
    const prompt = "prompt body\nline-1";
    const { ctx, getSystemPrompt } = createCtx(prompt);
    await runCommand(h, "__xyz_get_system_prompt__", "", ctx);

    expect(getSystemPrompt).toHaveBeenCalledTimes(1);
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]?.customType).toBe("xyz:current-system-prompt");
    const data = h.entries[0]?.data as Record<string, unknown>;
    expect(data.fullText).toBe(prompt);
    expect(data.charCount).toBe(prompt.length);
    // fetchedAt = new Date().toISOString()（动态值，断言 ISO 可解析形状）
    expect(typeof data.fetchedAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(data.fetchedAt)))).toBe(false);
  });
});
