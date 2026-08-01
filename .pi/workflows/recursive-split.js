const meta = {
  name: "recursive-split",
  description: "递归拆分问题求解：cw 状态机 + 每 node 一个 agent + frontier 驱动 BFS",
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
  MAX_NODE_ROUNDS,
  VALID_LAYERS,
  isTerminal,
  assertValidUnitId,
  isTimeoutError,
  buildActionPrompt,
  buildActionSchema,
  topoSort,
  selectActionable,
  detectStuckNodes,
} = require(process.cwd() + "/.pi/workflows/recursive-split-utils.cjs");

// 单 node 超时（60 分钟）：agent 在 session 内连续跑多个 cw action（8 action + gate 重试），
// 比 per-action 更耗时。对齐 review-fix-loop.js 的 30min/action × 2 的量级。
const NODE_TIMEOUT_MS = 60 * 60 * 1000;

// cw frontier 超时：只在 BFS 轮次边界调用，不应阻塞太久
const FRONTIER_TIMEOUT_MS = 30000;

// cw abort 超时：abort 是快速状态变更
const ABORT_TIMEOUT_MS = 5000;

// ── 辅助函数（被调函数先定义，避免 TDZ） ──────────────────────────
// isTerminal / assertValidUnitId / isTimeoutError / buildActionPrompt /
// buildActionSchema / topoSort / detectStuckNodes 已移至 recursive-split-utils.cjs

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
 * 执行单节点：派 agent 自主连续推进 cw action 直到阻塞。
 * returnMeta:true → 返回 {unitId, value, sessionFile?, failedReason?}。
 * 失败（r.error / 超时）→ abortUnit + 返回 failedReason（不 throw，主循环继续其他节点）。
 * 注意：失败字段命名 failedReason 而非 error，避免被 parallel() 归一化吞掉其他字段。
 */
async function executeNodeNextAction(node, sessionFiles) {
  const r = await agent({
    prompt: buildActionPrompt(node),
    schema: buildActionSchema(node),
    fork: true,
    worktree: false,
    returnMeta: true,
    cwd: $WORKSPACE,
    timeoutMs: NODE_TIMEOUT_MS,
  });

  // 失败处理：returnMeta 模式 r.error 检测（agent 失败不 throw）。
  if (r.error || isTimeoutError(r)) {
    log("Node " + node.unitId + " failed: " + (r.error ?? "timeout"));
    await abortUnit(node.unitId);
    return { unitId: node.unitId, value: r.value, sessionFile: r.sessionFile, failedReason: r.error };
  }

  return { unitId: node.unitId, value: r.value, sessionFile: r.sessionFile };
}

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
  // prevStatus: unitId → 上一轮 frontier 的 status（跨轮对比判定"node 没推进"）
  const prevStatus = {};
  // nodeRounds: unitId → status 未推进的连续轮数（node 级熔断用）
  const nodeRounds = {};

  while (true) {
    // 不变式：queryFrontier 只在轮次边界调（此处 parallel 已全 settle）
    const frontier = queryFrontier(rootUnitId);
    const { actionable, shouldBreak } = selectActionable(frontier);

    // 无 actionable：全终态 → 正常结束；有非终态但全 blocked → 异常（保守 break）
    if (shouldBreak) {
      if (actionable.length === 0 && frontier.nodes.length > 0) {
        const allTerminal = frontier.nodes.every((n) => isTerminal(n.status));
        if (!allTerminal) log("WARN: 无 actionable 节点但树未完成，可能有节点永久 blocked");
      }
      break;
    }

    // node 级熔断：同一 node 被 dispatch 多轮 status 没推进 → abort
    const nodesToAbort = detectStuckNodes(actionable, prevStatus, nodeRounds);
    for (const unitId of nodesToAbort) {
      log("Node " + unitId + " stuck (status not progressing for " + MAX_NODE_ROUNDS + " rounds), aborting");
      await abortUnit(unitId);
    }

    // 排除已熔断 abort 的节点
    const dispatchable = actionable.filter((n) => !nodesToAbort.includes(n.unitId));
    const { concurrent, sequential } = topoSort(dispatchable);

    // 并发组：无内部依赖的节点全并行（parallel allSettled 语义，单项失败不拖整批）
    if (concurrent.length > 0) {
      log("BFS: " + concurrent.length + " concurrent + " + sequential.length + " sequential");
      const results = await parallel(
        concurrent.map((node) => executeNodeNextAction(node, sessionFiles))
      );
      // 回收 sessionFile + 识别失败
      for (const r of results) {
        if (!r) continue;
        if (r.status === "failed") {
          // executeNodeNextAction 意外 throw（parallel 归一化形态），无法拿到 unitId
          log("BFS: concurrent node failed (thrown): " + (r.error ?? "unknown"));
          continue;
        }
        if (r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
        if (r.failedReason) log("BFS: " + r.unitId + " failed: " + r.failedReason);
      }
    }

    // 串行组：有内部依赖的节点逐个执行（保证依赖顺序：被依赖者先完成推进状态机）
    // sequential 已由 topoSort 按拓扑序排列（被依赖者在前）。
    for (const node of sequential) {
      let r;
      try {
        r = await executeNodeNextAction(node, sessionFiles);
      } catch (e) {
        log("BFS: sequential node " + node.unitId + " threw: " + String(e.message || e));
        continue;
      }
      if (r && r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
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
