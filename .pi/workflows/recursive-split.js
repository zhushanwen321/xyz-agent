const meta = {
  name: "recursive-split",
  description: "递归拆分问题求解：cw 状态机 + 每 node 一个 agent + frontier 驱动 BFS",
  // phase 命名：{layer首字母}-{slug}（如 e-auth、w-test-login），每个 WorkUnit 独立 phase。
  // run-time 由 executeActionAgent 内 agent() 的 opts.phase 字段逐 node 设置（per-call
  // 生效，不靠全局 phase()——parallel 并发时多个 layer 的 node 互不覆盖）。
  // init/done/error 三段无 agent() 调用，sidebar 不显示（引擎只渲染含 node 的 phase）。
  phases: ["init", "bfs", "done", "error"],
};

// ── 常量 ────────────────────────────────────────────────────────────

const { execSync } = require("child_process");
// 纯逻辑（常量 + 纯函数）从 utils 模块导入，供 vitest 单测覆盖。
// .cjs 扩展名强制 CommonJS（项目根 package.json 声明 type:module，.js 会被当 ESM 解析）。
// 用 process.cwd() 拼绝对路径：pi worker 线程继承父线程 cwd（= workspace 根），
// 相对路径 "./recursive-split-utils.cjs" 会解析到 <cwd>/recursive-split-utils.cjs 而非脚本同目录。
const {
  MAX_NODE_ROUNDS,
  MAX_FRONTIER_RETRIES,
  VALID_LAYERS,
  isTerminal,
  assertValidUnitId,
  escapeSingleQuotes,
  decideNodeOutcome,
  isProgressive,
  buildActionPrompt,
  buildActionSchema,
  topoSort,
  selectActionable,
  detectStuckNodes,
  pruneTerminalEntries,
} = require(process.cwd() + "/.pi/workflows/recursive-split-utils.cjs");

// 合并 progressive agent（clarify→plan→design-review）超时：15min（跑 3 个 progressive action）
const NODE_TIMEOUT_PROGRESSIVE_MS = 15 * 60 * 1000;
// 非 progressive agent（单 action）超时：10min
const NODE_TIMEOUT_NONPROGRESSIVE_MS = 10 * 60 * 1000;

// cw frontier 超时：只在 BFS 轮次边界调用，不应阻塞太久
const FRONTIER_TIMEOUT_MS = 30000;

// cw abort 超时：abort 是快速状态变更
const ABORT_TIMEOUT_MS = 5000;

// ── 辅助函数（被调函数先定义，避免 TDZ） ──────────────────────────
// isTerminal / assertValidUnitId / isTimeoutError / escapeSingleQuotes /
// decideNodeOutcome / buildActionPrompt / buildActionSchema / topoSort /
// detectStuckNodes 已移至 recursive-split-utils.cjs（供 vitest 单测）

/**
 * 创建 root WorkUnit：调 cw create <startLayer> 建顶层 unit。
 * slug 固定 'recursive-root'（简单稳定；同 workspace 并发跑会冲突，但单跑场景够用）。
 * 返回 unitId string（如 "slice:recursive-root"）。
 */
function createRootUnit(startLayer, task) {
  // task 可能含 shell 特殊字符（引号/$/`），用单引号包裹 + 转义内部单引号
  const safeObjective = escapeSingleQuotes(task);
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
 * 失败返回 null（不回退空 frontier）——空 frontier 会被 selectActionable 判为 allTerminal
 * 导致 BFS 永久终止。主循环按 MAX_FRONTIER_RETRIES 容忍连续失败：单次临时性超时只 continue
 * 进入下一轮重试，连续失败到阈值才判定永久性故障并 break。
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
    return null;
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
 * 执行单节点：派 agent 跑明确的 action（或合并的 progressive action 段）。
 * description 含 action（{layer首字母}-{action}-{slug}，如 e-execute-auth），
 * phase（WorkUnit 级）不含 action（{layer首字母}-{slug}）。
 * timeoutMs 按 isProgressive(node.nextAction) 选 15min / 10min。
 * returnMeta:true → 返回 {unitId, value, sessionFile?, failedReason?}。
 * 失败两个来源：(1) decideNodeOutcome(r) 检 r.error（pi 层崩溃/timeout）；
 *              (2) r.value.failedReason（agent 自报 gate fail 耗尽 / cannot-proceed）。
 * 两者都 abortUnit + 返回 failedReason（不 throw，主循环继续其他节点）。
 * 注意：失败字段命名 failedReason 而非 error，避免被 parallel() 归一化吞掉其他字段。
 */
async function executeActionAgent(node, sessionFiles) {
  const slug = node.unitId.split(":")[1] || node.unitId;
  // phase（WorkUnit 级）不含 action；description（action-centric）含 action。
  const phaseName = node.scope[0] + "-" + slug;
  const description = node.scope[0] + "-" + node.nextAction + "-" + slug;
  const timeoutMs = isProgressive(node.nextAction)
    ? NODE_TIMEOUT_PROGRESSIVE_MS
    : NODE_TIMEOUT_NONPROGRESSIVE_MS;
  const r = await agent({
    prompt: buildActionPrompt(node),
    schema: buildActionSchema(node),
    phase: phaseName,
    description: description,
    fork: true,
    worktree: false,
    returnMeta: true,
    cwd: $WORKSPACE,
    timeoutMs: timeoutMs,
  });

  // 失败来源 1：pi 层崩溃/timeout（decideNodeOutcome 检 r.error）
  const outcome = decideNodeOutcome(r);
  if (outcome.failed) {
    log("Node " + node.unitId + " failed: " + (outcome.failedReason ?? "timeout"));
    await abortUnit(node.unitId);
    return { unitId: node.unitId, value: r.value, sessionFile: r.sessionFile, failedReason: outcome.failedReason };
  }

  // 失败来源 2：agent 自报 failedReason（gate fail 耗尽 / cannot-proceed）
  if (r.value && r.value.failedReason) {
    log("Node " + node.unitId + " failed (agent-reported): " + r.value.failedReason);
    await abortUnit(node.unitId);
    return { unitId: node.unitId, value: r.value, sessionFile: r.sessionFile, failedReason: r.value.failedReason };
  }

  return { unitId: node.unitId, value: r.value, sessionFile: r.sessionFile };
}

// ── BFS 主循环（顶层 try/catch 兜底） ──────────────────────────────

try {
  phase("init");
  const task = $ARGS.task;
  // Info #1：task 未传时 task===undefined → String(undefined)="undefined" 作为 objective，
  // 会静默创建一个无意义 root WorkUnit。这里 fail-fast 拒绝空/非字符串入参，让调用方尽早感知。
  if (!task || typeof task !== "string") {
    throw new Error("Missing required $ARGS.task");
  }
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
  // frontierFailures: queryFrontier 连续返回 null 的次数（达 MAX_FRONTIER_RETRIES 才 break）
  let frontierFailures = 0;

  while (true) {
    // 不变式：queryFrontier 只在轮次边界调（此处 parallel 已全 settle）
    const frontier = queryFrontier(rootUnitId);

    // Suggestion #2：queryFrontier 失败返回 null。区分临时抖动与永久故障——
    // 单次失败 continue 进入下一轮重试，连续 MAX_FRONTIER_RETRIES 次失败才判定永久故障并 break。
    // 不回退空 frontier（会被误判为 allTerminal 永久终止整个递归拆分）。
    if (frontier === null) {
      frontierFailures++;
      log("queryFrontier null (" + frontierFailures + "/" + MAX_FRONTIER_RETRIES + "), retrying next round");
      if (frontierFailures >= MAX_FRONTIER_RETRIES) {
        log("queryFrontier failed " + MAX_FRONTIER_RETRIES + " consecutive times, aborting BFS");
        break;
      }
      continue;
    }
    frontierFailures = 0; // 成功一次即重置连续失败计数

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
        concurrent.map((node) => executeActionAgent(node, sessionFiles))
      );
      // 回收 sessionFile + 识别失败
      for (const r of results) {
        if (!r) continue;
        if (r.status === "failed") {
          // executeActionAgent 意外 throw（parallel 归一化形态），无法拿到 unitId
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
        r = await executeActionAgent(node, sessionFiles);
      } catch (e) {
        // Info #4：sequential 节点意外 throw 时纵深防御——对齐 parallel thrown 分支，
        // 调 abortUnit 中止该节点对应的 WorkUnit（节点状态可能已在半推进态，避免脏状态残留）。
        log("BFS: sequential node " + node.unitId + " threw: " + String(e.message || e) + ", aborting unit");
        await abortUnit(node.unitId);
        continue;
      }
      if (r && r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
      if (r && r.failedReason) log("BFS: " + r.unitId + " failed: " + r.failedReason);
    }

    // Suggestion #3：每轮 BFS 结束后清理已进入终态的节点在 prevStatus / nodeRounds 中的 entry，
    // 防止两 Map 随任务推进无界累积。frontier.nodes 含本轮所有非终态 actionable+blocked 节点，
    // 凡不在本轮 frontier 且上轮 status 已终态的节点即已退出调度，安全清理。
    pruneTerminalEntries(
      prevStatus,
      nodeRounds,
      (frontier.nodes ?? []).map((n) => n.unitId)
    );
  }

  phase("done");
  return { status: "done", rootUnitId };
} catch (e) {
  // 兜底：topoSort 环检测 / createRootUnit 失败 / startLayer 校验 / 其他未预期错误
  // 不 rethrow——workflow 脚本顶层 return 错误结果，由调用方（主 agent）决策
  phase("error");
  return { status: "error", error: String(e.message || e) };
}
