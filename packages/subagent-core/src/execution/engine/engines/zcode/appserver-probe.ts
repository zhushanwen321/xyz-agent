// src/execution/engine/engines/zcode/appserver-probe.ts
//
// [R5 D8] app-server 协议冒烟探针。设计权威源：docs/design/zcode-engine-appserver-
// resident.md §3.3 D8①（独立连接 create 探针会话 → close → shutdown、校验应答形状
// 与 sessionId 提取、预算 10s、不触发模型请求不产生费用）+ D2 降级链第①步（探针
// 失败 → 本任务起直接走 spawn）。
//
// 关键约束：
//   - 独立短命连接（AppServerConnection 全新实例，不与常驻主连接共享进程/状态）；
//     探针结束 shutdown 杀链收割，绝不留孤儿进程；
//   - 必须用**已引导的常驻 HOME**（D7 教训：先 bootstrap 再 probe，否则 app-server
//     启动即因 config 缺失报 -32603，探针永远误降级 spawn）——homeDir 由调用方
//     （zcode-engine 的 probe 门控）经 ensureAppServerHome 保证；
//   - create 帧键集与 SessionChannel.createSession 逐字同源（A.2 ① strict——对面
//     zod 拒未知键），但不带 model、绝不发 session/send（无模型请求、无费用）；
//   - 预算整体 race 兜底：请求级超时之外，进程假死/spawn 挂起由外层 deadline 收割。
//
// 结论消费方：zcode-engine 的 probe 门控（结论与 CLI mtime 绑定缓存——zcode 升级
// mtime 变化后首个任务前重探，D2③）。

import { getLogger } from "../../../../core/logger.ts";

import { AppServerConnection, buildAppServerEnv } from "./connection.ts";
import { extractCreatedSessionId, stableWorkspaceKey } from "./session-channel.ts";
import {
  ZCODE_APPSERVER_PROBE_BUDGET_MS,
  ZCODE_APPSERVER_PROBE_CONN_ENV,
  ZCODE_KILL_GRACE_MS,
} from "./constants.ts";

const logger = getLogger("subagents");

/** 应答形状异常时的摘要截断长度（够定位形态、不刷屏）。 */
const CREATE_REPLY_LOG_CHARS = 300;

/** 冒烟探针参数（依赖全量注入：cliPath/homeDir/env 来自引擎，测试可换 tmp 路径）。 */
export interface AppServerSmokeProbeOptions {
  /** zcode CLI 路径（node 脚本）。 */
  cliPath: string;
  /** 已引导的常驻 HOME（D7：探针连接的 --cwd 与 $HOME）。 */
  homeDir: string;
  /** env 基底（引擎 deps.processEnv；探针 env 在其上叠 HOME/嵌套标记/探针连接标记）。 */
  baseEnv: NodeJS.ProcessEnv;
  /** stderr tee 落盘路径（append；与常驻连接分文件——探针故障独立取证）。 */
  stderrLogPath: string;
  /** 总预算（缺省 ZCODE_APPSERVER_PROBE_BUDGET_MS；测试注入短预算验证超时路径）。 */
  budgetMs?: number;
}

/** 冒烟探针结论（ok=false 时 detail 携带失败素材——降级 reason 的数据源）。 */
export interface AppServerSmokeProbeResult {
  ok: boolean;
  detail: string;
}

/** 错误出声用 message 提取（非 Error 值不抛二次异常）。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 跑一次协议冒烟：独立连接上 create 探针会话（校验 sessionId 可提取）→ close →
 * shutdown。任何一步失败/超预算 → ok=false（调用方降级 spawn，不抛——探针失败是
 * 结论不是异常）。
 */
export async function runAppServerSmokeProbe(opts: AppServerSmokeProbeOptions): Promise<AppServerSmokeProbeResult> {
  const budgetMs = opts.budgetMs ?? ZCODE_APPSERVER_PROBE_BUDGET_MS;
  const conn = new AppServerConnection({
    cliPath: opts.cliPath,
    cwd: opts.homeDir,
    env: {
      ...buildAppServerEnv(opts.homeDir, opts.baseEnv),
      // 探针连接标记（fake/诊断侧区分探针进程与常驻进程的判据；对真 CLI 透明）
      [ZCODE_APPSERVER_PROBE_CONN_ENV]: "1",
    },
    stderrLogPath: opts.stderrLogPath,
    requestTimeoutMs: budgetMs,
  });

  // 探针工作面：create（形状校验）→ close。绝不 send（无模型请求）。
  const work = (async (): Promise<string> => {
    const created = await conn.request("session/create", {
      workspace: {
        workspacePath: opts.homeDir,
        workspaceKey: stableWorkspaceKey(opts.homeDir),
      },
      mode: "yolo",
      persistence: "immediate",
    });
    const sessionId = extractCreatedSessionId(created);
    if (sessionId === undefined) {
      throw new Error(
        `session/create 应答无可提取 sessionId: ${JSON.stringify(created).slice(0, CREATE_REPLY_LOG_CHARS)}`,
      );
    }
    await conn.request("session/close", { sessionId });
    return sessionId;
  })();

  // 预算 race：进程假死/spawn 挂起时请求级超时不够（帧可能永不到达）——外层
  // deadline 兜底，超时即判探针失败（错误规格表末行：probe 预算耗尽 → 降级 spawn）
  let timedOut = false;
  const deadline = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, budgetMs);
    if (typeof t.unref === "function") t.unref();
  });

  let failure: unknown;
  const sessionId = await Promise.race([
    work.catch((err: unknown) => {
      failure = err;
      return undefined;
    }),
    deadline.then(() => undefined),
  ]);

  // 无论成败都收割探针进程（短命语义：shutdown 是杀链全序，幂等；失败只 debug——
  // 探针结论已定，收割失败留给宿主 dispose 兜底）
  await conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS }).catch((err: unknown) => {
    logger.debug(`[zcode-probe] 探针连接 shutdown 失败（best-effort）: ${errMessage(err)}`);
  });

  if (failure !== undefined) {
    return { ok: false, detail: `探针会话失败: ${errMessage(failure)}` };
  }
  if (sessionId === undefined) {
    return {
      ok: false,
      detail: timedOut
        ? `探针 ${budgetMs}ms 预算耗尽（create/close 未完成——协议无响应或进程假死）`
        : "探针未产出会话 id（未知形态）",
    };
  }
  return {
    ok: true,
    detail: `协议冒烟通过（create→close→shutdown，探针会话 ${sessionId}，未发模型请求）`,
  };
}
