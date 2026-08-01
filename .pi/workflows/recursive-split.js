const meta = {
  name: "recursive-split",
  description: "递归拆分问题求解：cw 状态机 + 每 action 一个 agent + frontier 驱动 BFS",
  phases: [
    { title: "init", detail: "创建 root WorkUnit" },
    { title: "bfs", detail: "frontier 驱动 BFS 主循环" },
    { title: "done", detail: "返回结果" },
    { title: "error", detail: "顶层兜底错误返回" },
  ],
};

// ── 常量 ────────────────────────────────────────────────────────────

const { execSync } = require("child_process");
// 纯逻辑（常量 + 纯函数）从 utils 模块导入，供 vitest 单测覆盖。
// .cjs 扩展名强制 CommonJS（项目根 package.json 声明 type:module，.js 会被当 ESM 解析）。
// 用 process.cwd() 拼绝对路径：pi worker 线程继承父线程 cwd（= workspace 根），
// 相对路径 "./recursive-split-utils.cjs" 会解析到 <cwd>/recursive-split-utils.cjs 而非脚本同目录。
const {
  MAX_ACTION_RETRY,
  PROGRESSIVE_ACTIONS,
  VALID_LAYERS,
  isTerminal,
  assertValidUnitId,
  isTimeoutError,
  buildActionPrompt,
  buildActionSchema,
  handleReplan,
  topoSort,
  selectActionable,
  detectStuckNodes,
  reduceActionResults,
} = require(process.cwd() + "/.pi/workflows/recursive-split-utils.cjs");

// 单 action 超时（30 分钟）：wave execute 内 agent 要 cw handoff + 写代码 + git commit + 跑测试，
// 复杂 plan/retrospect 也可能较慢；过短会误杀合法长任务（对齐 review-fix-loop.js 的 30min）
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;

// cw frontier 超时：只在 BFS 轮次边界调用，不应阻塞太久
const FRONTIER_TIMEOUT_MS = 30000;

// cw abort 超时：abort 是快速状态变更
const ABORT_TIMEOUT_MS = 5000;

// ── 辅助函数（被调函数先定义，避免 TDZ） ──────────────────────────
// isTerminal / assertValidUnitId / isTimeoutError / buildActionPrompt /
// buildActionSchema / handleReplan / topoSort 已移至 recursive-split-utils.cjs

/**
 * 创建 root WorkUnit：调 cw create <startLayer> 建顶层 unit。
 * slug 固定 'recursive-root'（简单稳定；同 workspace 并发跑会冲突，但单跑场景够用）。
 * 返回 unitId string（如 "slice:recursive-root"）。
 */
function createRootUnit(startLayer, task) {
  // task 可能含 shell 特殊字符（引号/$/`），用单引号包裹 + 转义内部单引号
  const safeObjective = String(task).replace(/'/g, "'\\''");
  const out = execSync(
    `cw create ${startLayer} --slug recursive-root --objective '${safeObjective}'`,
    { encoding: "utf-8", timeout: FRONTIER_TIMEOUT_MS }
  );
  const parsed = JSON.parse(out);
  if (!parsed.unitId) {
    throw new Error("cw create 未返回 unitId: " + out.slice(0, 200));
  }
  // C4：cw stdout 解析出的 unitId 也需校验（防 cw 异常返回被注入命令串）
  assertValidUnitId(parsed.unitId);
  return parsed.unitId;
}

/**
 * 查询 frontier：返回当前可调度的 actionable 节点列表。
 * 不变式：只在 BFS 轮次边界调用（parallel 全 settle 后），绝不在 parallel 进行中调——
 * 否则 cw 状态机并发读写会脏读。
 * 失败回退空 frontier → BFS 终止（保守停止，不继续调度脏状态）。
 */
function queryFrontier(rootUnitId) {
  try {
    assertValidUnitId(rootUnitId); // C4：rootUnitId 拼进 execSync，防 shell 注入
    const out = execSync(`cw frontier --root ${rootUnitId} --format json`, {
      encoding: "utf-8",
      timeout: FRONTIER_TIMEOUT_MS,
    });
    return JSON.parse(out);
  } catch (e) {
    log("queryFrontier failed: " + String(e.message || e));
    return { rootUnitId, nodes: [] };
  }
}

/**
 * 中止单个 WorkUnit（熔断/超时/失败时）。
 * 不抛——abort 失败只记日志，不阻塞主循环（节点状态可能已是 aborted）。
 * C4：unitId 校验放在 try 内，校验失败按 execSync 失败同样处理（记日志，不 throw 到主循环）。
 */
async function abortUnit(unitId) {
  try {
    assertValidUnitId(unitId); // C4：unitId 拼进 execSync，防 shell 注入
    execSync(`cw abort --unitId ${unitId}`, {
      encoding: "utf-8",
      timeout: ABORT_TIMEOUT_MS,
    });
  } catch (e) {
    log("Failed to abort " + unitId + ": " + String(e.message || e));
  }
}

/**
 * replan 后清理 + 覆盖设置（spec-f §5 replan 机制）。
 * 已移至 recursive-split-utils.cjs。主循环通过 reduceActionResults 间接调用。
 */

/**
 * buildActionPrompt / buildActionSchema 已移至 recursive-split-utils.cjs。
 */

/**
 * 执行单节点的 nextAction：worktree 决策 + agent 调用 + session 回收 + 失败处理。
 * returnMeta:true → 返回 {unitId, value, sessionFile?, worktreePath?, failedReason?, replanTriggered?, abortedChildren?}。
 * replanTriggered: agent 声明触发 cw replan 时为 true（携 abortedChildren 列表），主循环据此调 handleReplan 清理子节点 + 设 replanOverride。
 * execute 成功后清除 replanOverride（replan 周期结束，恢复信 frontier）：见下方实现。
 * 失败（r.error / 超时）→ abortUnit + 返回 failedReason（不 throw，主循环继续其他节点）。
 * 注意：失败字段命名 failedReason 而非 error，避免被 parallel() 归一化吞掉其他字段（见 C1）。
 */
async function executeNodeNextAction(node, sessionFiles, replanOverride) {
  const isWave = node.scope === "wave";
  const action = node.nextAction;

  // wave 不用 worktree 隔离：pi 的 worktree 绑定单次 agent() record，
  // 每次 executeAndAwait 结束 finalizeRecord 无条件 cleanup（git worktree remove），
  // worktree 无法跨 action 存活。wave 的所有 action 在主 cwd（$WORKSPACE）跑。
  // 并发 wave 改同文件的 .git/index.lock 冲突靠 BFS 串行调度（topoSort sequential）缓解。
  const cwd = $WORKSPACE;
  const useWorktree = false;

  // retrospect sessionFile hint：planning 层复盘时读子层 session jsonl 做真实验收
  // （而非仅依赖 cw 状态机的 closeout 标记）。列出子层已记录的 session 路径供 agent bash 读取。
  let sessionFileHint = "";
  if (action === "retrospect" && !isWave) {
    const childFiles = Object.entries(sessionFiles)
      .filter(([uid]) => (node.childUnitIds ?? []).includes(uid))
      .map(([uid, sf]) => `- ${uid}: ${sf}`);
    if (childFiles.length > 0) {
      sessionFileHint = `\n\n子层 session 记录（用 bash 读取做复盘）：\n${childFiles.join("\n")}`;
    }
  }

  const r = await agent({
    prompt: buildActionPrompt(node, action) + sessionFileHint,
    schema: buildActionSchema(node, action, isWave),
    fork: true,
    worktree: false,
    returnMeta: true,
    cwd,
    timeoutMs: ACTION_TIMEOUT_MS,
  });

  // execute 成功后清除 replanOverride（replan 周期结束，恢复信 frontier）：
  // replan 后节点重走 plan→design-review→execute，execute 成功说明新 plan 已落地建新子节点。
  if (action === "execute" && !r.error && !(r.value?.replanTriggered === true)) {
    delete replanOverride[node.unitId];
  }

  // 失败处理：returnMeta 模式 r.error 检测（agent 失败不 throw）。
  // 超时/错误 → abort 该节点（熔断），返回带 failedReason 的结果（主循环记 sessionFile 后继续）。
  // 注意：失败标识字段用 failedReason 而非 error——parallel() 会对含非空 error 字符串字段的对象
  // 归一化成 {status:"failed", error}，会吞掉 unitId/sessionFile 等其他字段。
  if (r.error || isTimeoutError(r)) {
    log("Action " + action + " for " + node.unitId + " failed: " + (r.error ?? "timeout"));
    await abortUnit(node.unitId);
    return {
      unitId: node.unitId,
      value: r.value,
      sessionFile: r.sessionFile,
      failedReason: r.error,
      replanTriggered: false,
      abortedChildren: undefined,
    };
  }

  return {
    unitId: node.unitId,
    value: r.value,
    sessionFile: r.sessionFile,
    replanTriggered: r.value?.replanTriggered === true,
    abortedChildren: r.value?.abortedChildren,
  };
}

/**
 * topoSort 已移至 recursive-split-utils.cjs。
 */

// ── BFS 主循环（顶层 try/catch 兜底） ──────────────────────────────

try {
  phase("init");
  const task = $ARGS.task;
  const startLayer = $ARGS.startLayer ?? "slice";
  // C3：startLayer 白名单校验（拼进 cw create 命令，防 shell 注入）
  if (!VALID_LAYERS.has(startLayer)) {
    throw new Error("Invalid startLayer (must be epic/feature/slice/wave): " + startLayer);
  }
  const rootUnitId = createRootUnit(startLayer, task);
  log("Root WorkUnit created: " + rootUnitId + " (layer=" + startLayer + ")");

  phase("bfs");
  // sessionFiles: unitId → sessionFile（returnMeta 回收，供上层 retrospect 读）
  const sessionFiles = {};
  // retryCount: retryKey(unitId:action) → 连续同 action 轮数（熔断用）
  const retryCount = {};
  // prevNextAction: unitId → 上一轮的 nextAction（跨轮对比判定"卡在同一步"）
  const prevNextAction = {};
  // replanOverride: unitId → "plan"（replan 后覆盖 frontier 的 nextAction）
  const replanOverride = {};

  while (true) {
    // 不变式：queryFrontier 只在轮次边界调（此处 parallel 已全 settle）
    const frontier = queryFrontier(rootUnitId);
    const { actionable, shouldBreak } = selectActionable(frontier);

    // 无 actionable：全终态 → 正常结束；有非终态但全 blocked → 异常（保守 break）
    if (shouldBreak) {
      if (!actionable.length && frontier.nodes.length > 0) {
        const allTerminal = frontier.nodes.every((n) => isTerminal(n.status));
        if (!allTerminal) log("WARN: 无 actionable 节点但树未完成，可能有节点永久 blocked");
      }
      break;
    }

    // m1：replanOverride 覆盖必须先于 retryCount 熔断——
    // 否则 replan 后 frontier 给 retrospect 但实际走 plan，retryKey 按 retrospect 算（幽灵计数）。
    // 双重检测：主信号 replanOverride（agent 声明 replanTriggered 时设）+ 后备信号 lastStatusHistoryAction。
    for (const node of actionable) {
      if (replanOverride[node.unitId]) {
        node.nextAction = replanOverride[node.unitId]; // 强制 "plan"，不信 frontier
      }
      // 后备检测：frontier 的 lastStatusHistoryAction === "replan" 且 agent 没声明（replanOverride 未设）
      if (node.lastStatusHistoryAction === "replan" && !replanOverride[node.unitId]) {
        // C1：后备信号也调 handleReplan——agent 调了 cw replan 但未声明 replanTriggered。
        // 无法拿 abortedChildren（子节点已从 frontier 消失），用空列表调 handleReplan——
        // 子节点内存清理靠下轮 frontier 不再返回（frontier 只返回非终态，aborted 的子节点自然消失）。
        handleReplan({ unitId: node.unitId, abortedChildren: [] }, replanOverride, sessionFiles, retryCount, prevNextAction);
        node.nextAction = "plan"; // handleReplan 内已设 replanOverride，但需显式覆盖 node.nextAction
      }
    }

    // retryCount 熔断检测（detectStuckNodes 在 utils 中可单测）。
    // 同节点连续 N 轮（≥ MAX_ACTION_RETRY）卡在同一 action → abort 该节点。
    const nodesToAbort = detectStuckNodes(actionable, retryCount, prevNextAction);
    for (const unitId of nodesToAbort) {
      log("Node " + unitId + " stuck, aborting (circuit breaker)");
    }

    for (const unitId of nodesToAbort) {
      await abortUnit(unitId);
    }

    // 排除已熔断 abort 的节点
    const dispatchable = actionable.filter((n) => !nodesToAbort.includes(n.unitId));
    const { concurrent, sequential } = topoSort(dispatchable);

    // 并发组：无内部依赖的节点全并行（parallel allSettled 语义，单项失败不拖整批）
    if (concurrent.length > 0) {
      log("BFS: " + concurrent.length + " concurrent + " + sequential.length + " sequential");
      const results = await parallel(
        concurrent.map((node) => executeNodeNextAction(node, sessionFiles, replanOverride))
      );
      // 回收 sessionFile + 识别失败（C1+C2）：
      // - executeNodeNextAction 主动失败：返回 {unitId, sessionFile, failedReason}（无 error 字段，避免被 parallel 归一化吞掉）
      // - executeNodeNextAction 意外 throw（如 agent postMessage reject）：parallel 归一化成 {status:"failed", error}，丢失 unitId
      const abortedThisRound = new Set();
      for (const r of results) {
        if (!r) continue;
        if (r.status === "failed") {
          // executeNodeNextAction 意外 throw（parallel 归一化形态），无法拿到 unitId
          log("BFS: concurrent node failed (thrown): " + (r.error ?? "unknown"));
          continue;
        }
        // 先收集本轮 aborted（replanTriggered 的子节点会被 handleReplan 从内存清理）
        if (r.replanTriggered) {
          const a = handleReplan(r, replanOverride, sessionFiles, retryCount, prevNextAction);
          for (const id of a) abortedThisRound.add(id);
        }
        // M2：跳过被 abort 子节点的 sessionFile 回收（已被 handleReplan 清理）
        if (abortedThisRound.has(r.unitId)) continue;
        if (r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
        if (r.failedReason) log("BFS: " + r.unitId + " failed: " + r.failedReason);
      }
    }

    // 串行组：有内部依赖的节点逐个执行（保证依赖顺序：被依赖者先完成推进状态机）
    // sequential 已由 topoSort 按拓扑序排列（被依赖者在前）。
    // 串行 executeNodeNextAction 若意外 throw（非 returnMeta 失败路径），此处 try/catch 兜底记日志继续。
    const abortedThisRoundSeq = new Set();
    for (const node of sequential) {
      // M1：跳过被级联 abort 的子节点（前序 replan 的 handleReplan 清了它的内存）
      if (abortedThisRoundSeq.has(node.unitId)) {
        log("BFS: skip aborted sequential node " + node.unitId);
        continue;
      }
      let r;
      try {
        r = await executeNodeNextAction(node, sessionFiles, replanOverride);
      } catch (e) {
        log("BFS: sequential node " + node.unitId + " threw: " + String(e.message || e));
        continue;
      }
      if (r && r.replanTriggered) {
        const a = handleReplan(r, replanOverride, sessionFiles, retryCount, prevNextAction);
        for (const id of a) abortedThisRoundSeq.add(id);
      }
      // M1：被 abort 的子节点不回收 sessionFile（已被 handleReplan 清理）
      if (r && !abortedThisRoundSeq.has(r.unitId) && r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
      if (r && r.failedReason) log("BFS: " + r.unitId + " failed: " + r.failedReason);
    }
  }

  phase("done");
  return { status: "done", rootUnitId };
} catch (e) {
  // 兜底：topoSort 环检测 / createRootUnit 失败 / startLayer 校验 / 其他未预期错误
  // 不 rethrow——workflow 脚本顶层 return 错误结果，由调用方（主 agent）决策
  phase("error");
  return { status: "error", error: String(e.message || e) };
}
