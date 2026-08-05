// recursive-split.js 真实脚本 e2e（T-1）
//
// 与 recursive-split-integration.test.ts 的根本区别：本文件加载磁盘上的真实
// recursive-split.js 源码并整体执行，而非直接调 utils 纯函数复刻主循环接线
// （后者是「接线镜像」——改坏 .js 的 catch 分支接线，镜像测试仍绿）。
//
// 手段：用 AsyncFunction 复刻 worker-script-builder.ts 的包装（脚本被包进 async
// 函数体，agent/parallel/phase/log/$ARGS/$WORKSPACE/require/process 作为参数注入），
// 执行的是真实的 .js 源码——顶层 try 的 return 成为函数返回值。mock 仅限于外部
// 依赖（agent → 抛异常 / execSync → cw 命令剧本），脚本的 BFS 编排、catch 分支、
// abortUnit 调用、aggregateNodeFailure 写入全是真实接线。
//
// 覆盖目标：sequential catch 分支（recursive-split.js BFS 串行组的 try/catch）。
// mock executeActionAgent 内的 agent() 对 sequential 节点抛异常 → 断言：
//   (1) abortUnit 被调（execSync 记到 cw abort 命令）
//   (2) failedUnits 含 "threw: " 前缀（catch 分支 aggregateNodeFailure 写入）
//
// 验收 #2 自证：手动把脚本 catch 分支的 "threw: " + ... 改成 "error: " + ...，
// 下方 "threw: 前缀" 断言 fail；注释掉整个 catch 分支的 abortUnit + aggregateNodeFailure，
// "abortUnit 被调" + "failedUnits 含 wave:seq" 断言 fail。恢复后全 pass。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "..", "recursive-split.js");
const UTILS_PATH = join(__dirname, "..", "recursive-split-utils.cjs");

// 真实 utils（脚本 require 时返回，保证测的是真实纯函数接线，非复刻）
const nodeRequire = createRequire(import.meta.url);
const realUtils = nodeRequire(UTILS_PATH);

// AsyncFunction 构造器：脚本顶层含 await（无 async 包裹），必须包进 async 函数体
// 才能执行（与 worker-script-builder.ts 的 (async () => { ...用户脚本... })() 同构）。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

interface FrontierNode {
  unitId: string;
  scope: string | string[];
  status: string;
  nextAction: string;
  blocked?: boolean;
  dependsOn?: string[];
}

interface ScriptRunInput {
  /** $ARGS（task 必填，startLayer 可选，默认 slice）。 */
  args?: Record<string, unknown>;
  /** mock agent(opts)：executeActionAgent 内的 agent({...}) 调用。按 opts.prompt 含的 unitId 分流。 */
  agent: (opts: Record<string, unknown>) => Promise<unknown>;
  /** mock execSync(cmd)：cw create / cw frontier / cw abort 剧本。 */
  execSyncImpl: (cmd: string) => string;
}

interface ScriptRunOutput {
  /** 脚本顶层 return 值（{status, rootUnitId?, failedUnits?, error?}）。 */
  result: unknown;
  /** 全部 execSync 调用的命令串（按调用序），供断言 cw abort 是否被调。 */
  execCalls: string[];
}

/**
 * 加载真实 recursive-split.js 源码，包进 AsyncFunction，注入 mock 全局 + mock require 后执行。
 *
 * 注入的标识符与 worker-script-builder.ts 注入的全局一一对应：agent/parallel/pipeline/
 * phase/log/workflow/$ARGS/$WORKSPACE/$BUDGET/require/process/console。脚本顶层的 return
 * 成为 AsyncFunction 的返回值。workerData 未注入 → 脚本双通道走 cwd fallback（O-1），
 * mockRequire 对任何 *.cjs 结尾的 mod 返回 realUtils，故 cwd 返回什么都不影响 utils 解析。
 */
async function runRealScript(input: ScriptRunInput): Promise<ScriptRunOutput> {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const fn = new AsyncFunction(
    "agent", "parallel", "pipeline", "phase", "log", "workflow",
    "$ARGS", "$WORKSPACE", "$BUDGET", "require", "process", "console",
    source,
  );

  const execCalls: string[] = [];
  // 包装一层记录全部 execSync 调用（cw create/frontier/abort），供断言 abortUnit 是否触发。
  const wrappedExecSync = (cmd: string): string => {
    execCalls.push(cmd);
    return input.execSyncImpl(cmd);
  };

  // mock require：child_process → mock execSync；*.cjs → 真实 utils；其余透传 node require。
  const mockRequire = (mod: string): unknown => {
    if (mod === "child_process") return { execSync: wrappedExecSync };
    if (mod === "path") return nodeRequire("path");
    if (typeof mod === "string" && mod.endsWith("recursive-split-utils.cjs")) return realUtils;
    return nodeRequire(mod);
  };

  // mock parallel：与 worker-script-builder 同语义（allSettled + failed 归一化）。
  // executeActionAgent 是 async，concurrent.map 返回 Promise 数组，parallel 直接 allSettled。
  const mockParallel = async (calls: Promise<unknown>[]): Promise<unknown[]> => {
    const settled = await Promise.allSettled(calls);
    return settled.map((r) => {
      if (r.status === "fulfilled") return r.value;
      const reason = r.reason;
      const errMsg = reason instanceof Error ? reason.message : String(reason);
      return { status: "failed", error: errMsg };
    });
  };

  const result = await fn(
    input.agent,
    mockParallel,
    undefined, // pipeline（recursive-split 未用）
    (_name: string) => {}, // phase
    (_msg: string) => {}, // log
    undefined, // workflow（未用）
    input.args ?? {},
    "/tmp/test-workspace", // $WORKSPACE
    { total: 0, spent: () => 0, remaining: () => 0 }, // $BUDGET
    mockRequire,
    { cwd: () => process.cwd() }, // process（cwd fallback 锚点，mockRequire 不依赖具体值）
    console,
  );

  return { result, execCalls };
}

/** 形状守卫：脚本返回值断言前先校验是含 status 字符串的对象。 */
function asDoneResult(r: unknown): {
  status: string;
  rootUnitId?: string;
  failedUnits?: Array<{ unitId: string; failedReason: string }>;
  error?: string;
} {
  if (typeof r !== "object" || r === null) {
    throw new Error("脚本返回值非对象: " + JSON.stringify(r));
  }
  const obj = r as Record<string, unknown>;
  if (typeof obj.status !== "string") {
    throw new Error("脚本返回值 status 非 string: " + JSON.stringify(obj.status));
  }
  const failedUnits = Array.isArray(obj.failedUnits)
    ? (obj.failedUnits as Array<{ unitId: string; failedReason: string }>)
    : undefined;
  return {
    status: obj.status,
    rootUnitId: typeof obj.rootUnitId === "string" ? obj.rootUnitId : undefined,
    failedUnits,
    error: typeof obj.error === "string" ? obj.error : undefined,
  };
}

// ── T-1：sequential catch 分支 "threw: " 前缀真实 e2e ────────────────

describe("recursive-split.js sequential catch — 真实脚本 e2e", () => {
  it("executeActionAgent 抛异常 → abortUnit 被调 + failedUnits 含 'threw: ' 前缀", async () => {
    // 剧本：BFS 第 1 轮 frontier 含 2 节点——wave:dep（无依赖→concurrent）+ wave:seq
    // （依赖 wave:dep→sequential）。mock agent 对 wave:seq 抛异常触发 sequential catch。
    // BFS 第 2 轮 frontier 空 → selectActionable shouldBreak → 退出循环 → done 路径。
    let frontierCount = 0;
    const SEQ_ERROR = new Error("agent boom for seq node");

    const { result, execCalls } = await runRealScript({
      args: { task: "test objective", startLayer: "slice" },
      agent: async (opts) => {
        const prompt = String(opts.prompt ?? "");
        // buildActionPrompt 第一段含 `推进 WorkUnit <unitId>`，据此分流
        if (prompt.includes("wave:seq")) throw SEQ_ERROR;
        // wave:dep 成功（returnMeta 形态：{value, sessionFile}）
        return {
          value: { stopReason: "action-done", actionsExecuted: ["execute"] },
          sessionFile: undefined,
        };
      },
      execSyncImpl: (cmd) => {
        if (cmd.startsWith("cw create")) {
          return JSON.stringify({ unitId: "slice:recursive-root" });
        }
        if (cmd.startsWith("cw frontier")) {
          frontierCount++;
          if (frontierCount === 1) {
            const nodes: FrontierNode[] = [
              { unitId: "wave:dep", scope: "wave", status: "executing", nextAction: "execute", blocked: false, dependsOn: [] },
              { unitId: "wave:seq", scope: "wave", status: "executing", nextAction: "execute", blocked: false, dependsOn: ["wave:dep"] },
            ];
            return JSON.stringify({ nodes });
          }
          return JSON.stringify({ nodes: [] }); // 第 2 轮：空 frontier → BFS 退出
        }
        if (cmd.startsWith("cw abort")) return ""; // abortUnit 成功（空输出）
        throw new Error("unexpected execSync: " + cmd);
      },
    });

    const done = asDoneResult(result);

    // (A) BFS 正常走完（非 error 路径）——证明 catch 分支不 rethrow、不中断主循环
    expect(done.status).toBe("done");
    expect(done.rootUnitId).toBe("slice:recursive-root");

    // (B) failedUnits 含 wave:seq，且 failedReason 以 "threw: " 前缀开头
    //     ——这是 T-1 的核心断言：catch 分支 aggregateNodeFailure 写入的 "threw: " 前缀。
    //     若脚本接线被改坏（如前缀改成 "error: "），stringMatching 断言 fail。
    expect(done.failedUnits).toBeDefined();
    expect(done.failedUnits).toContainEqual({
      unitId: "wave:seq",
      failedReason: expect.stringMatching(/^threw: /),
    });
    // 完整 failedReason 含异常消息（证明 String(e.message || e) 接线正确）
    const seqFailure = done.failedUnits!.find((f) => f.unitId === "wave:seq");
    expect(seqFailure?.failedReason).toContain("agent boom for seq node");

    // (C) abortUnit 被调（catch 分支 `await abortUnit(node.unitId)`）——execSync 记到
    //     "cw abort --unitId wave:seq"。若 catch 分支被注释掉不调 abortUnit，此断言 fail。
    expect(execCalls.some((c) => c.startsWith("cw abort --unitId wave:seq"))).toBe(true);

    // (D) wave:dep（concurrent 成功节点）不进 failedUnits ——证明聚合只记失败节点
    expect(done.failedUnits!.find((f) => f.unitId === "wave:dep")).toBeUndefined();
  });

  it("concurrent 节点正常 + 无 sequential 节点 → done 无 failedUnits（catch 分支不触发，反向佐证）", async () => {
    // 反向场景：只有 concurrent 节点且全部成功，sequential 组为空 → catch 分支不执行，
    // failedUnits 缺省。佐证上面那条测试的 failedUnits 来自 sequential catch 而非其他路径。
    let frontierCount = 0;
    const { result } = await runRealScript({
      args: { task: "only concurrent", startLayer: "slice" },
      agent: async () => ({
        value: { stopReason: "action-done", actionsExecuted: ["execute"] },
        sessionFile: undefined,
      }),
      execSyncImpl: (cmd) => {
        if (cmd.startsWith("cw create")) return JSON.stringify({ unitId: "slice:recursive-root" });
        if (cmd.startsWith("cw frontier")) {
          frontierCount++;
          if (frontierCount === 1) {
            const nodes: FrontierNode[] = [
              { unitId: "wave:a", scope: "wave", status: "executing", nextAction: "execute", blocked: false, dependsOn: [] },
              { unitId: "wave:b", scope: "wave", status: "executing", nextAction: "execute", blocked: false, dependsOn: [] },
            ];
            return JSON.stringify({ nodes });
          }
          return JSON.stringify({ nodes: [] });
        }
        if (cmd.startsWith("cw abort")) return "";
        throw new Error("unexpected execSync: " + cmd);
      },
    });

    const done = asDoneResult(result);
    expect(done.status).toBe("done");
    // 两节点都成功 → failedUnits 缺省（done 路径 collectFailedUnits({}) 为空数组 → 条件展开省略）
    expect(done.failedUnits).toBeUndefined();
  });
});
