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

// 单 action 超时（30 分钟）：wave execute 内 agent 要 cw handoff + 写代码 + git commit + 跑测试，
// 复杂 plan/retrospect 也可能较慢；过短会误杀合法长任务（对齐 review-fix-loop.js 的 30min）
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;

// 同一节点卡在同一 action 的轮次上限：超过则 abort 该节点（熔断）。
// 注意：实际熔断需 MAX_ACTION_RETRY+1 轮——第 1 轮建立 prevNextAction 基线（不计入累加），
// 之后连续 N 轮同 action 才累加到阈值。
const MAX_ACTION_RETRY = 3;

// 渐进式 action 熔断豁免：clarify/plan/design-review 天然多轮迭代（gate 多次 fail 正常），
// 不计入卡死判定
const PROGRESSIVE_ACTIONS = new Set(["clarify", "plan", "design-review"]);

// cw frontier 超时：只在 BFS 轮次边界调用，不应阻塞太久
const FRONTIER_TIMEOUT_MS = 30000;

// cw abort 超时：abort 是快速状态变更
const ABORT_TIMEOUT_MS = 5000;

// 合法起始层级白名单（C3：startLayer 校验，防 shell 注入）
const VALID_LAYERS = new Set(["epic", "feature", "slice", "wave"]);

// ── 辅助函数（被调函数先定义，避免 TDZ） ──────────────────────────

/**
 * 判断 WorkUnit 状态是否终态（不再可调度）。
 * closed = 正常完成；aborted = 中止（含熔断/超时主动 abort）。
 */
function isTerminal(status) {
  return status === "closed" || status === "aborted";
}

/**
 * 校验 unitId 格式（C4：防 shell 注入——unitId 拼进 execSync 命令）。
 * 合法形态：`<scope>:<slug>`，scope 全小写字母，slug 含小写字母/数字/连字符/冒号。
 * 通过则静默返回，不通过则 throw。
 */
function assertValidUnitId(id) {
  if (!/^[a-z]+:[a-z0-9:-]+$/i.test(id)) {
    throw new Error("Invalid unitId format: " + id);
  }
}

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
 * 在 dependsOn 链上找已分配 worktree 的祖先/兄弟节点，复用其 worktree 路径。
 * wave 节点若依赖某已开 worktree 的 wave，可共享同一 worktree（避免每 wave 一个 worktree 爆炸）。
 */
function findInheritedWorktree(node, worktreeRegistry) {
  const deps = node.dependsOn ?? [];
  for (const dep of deps) {
    if (worktreeRegistry[dep]) {
      return worktreeRegistry[dep];
    }
  }
  return null;
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
 * replan 会级联 abort 受影响子节点——清理它们的内存状态（已终态，不再参与 BFS），
 * 并设 replanOverride 强制该节点下一步走 plan（回 planning 重走 design-review）。
 */
function handleReplan(r, replanOverride, worktreeRegistry, sessionFiles, retryCount, prevNextAction) {
  log("Node " + r.unitId + " triggered replan, aborted children: " + (r.abortedChildren ?? []).join(", "));
  // 1. 覆盖该节点下一步为 plan（回 planning 重走 design-review）
  replanOverride[r.unitId] = "plan";
  // m2：重置触发 replan 节点自身的 retryCount（replan 周期内 execute 反复 fail 不应误杀）
  for (const key of Object.keys(retryCount)) {
    if (key.startsWith(r.unitId + ":")) delete retryCount[key];
  }
  // 2. 清理被级联 abort 子节点的内存状态（它们已终态，不再参与 BFS）
  const aborted = new Set();
  for (const childId of r.abortedChildren ?? []) {
    aborted.add(childId);
    delete worktreeRegistry[childId];
    delete sessionFiles[childId];
    delete prevNextAction[childId];
    // 清理该子节点所有 action 的 retryCount（key 格式 unitId:action）
    for (const key of Object.keys(retryCount)) {
      if (key.startsWith(childId + ":")) delete retryCount[key];
    }
  }
  return aborted;
}

/**
 * returnMeta 模式下检测 r.error 是否为超时类错误。
 * agent() 失败不 throw（resolve 回退值），需主动检 r.error。
 */
function isTimeoutError(r) {
  if (!r.error) return false;
  const lower = String(r.error).toLowerCase();
  return lower.includes("timeout") || lower.includes("aborted");
}

/**
 * 为单节点构建 action 的 agent prompt。
 * 核心：每 action 走 cw handoff（拿上下文 + guidance）→ 执行 → cw <action>（推进状态）→ gate 处理。
 * guidance 是唯一导航源（cw-cli skill 约定），prompt 不硬编码 schema 字段名。
 */
function buildActionPrompt(node, action) {
  const hints = {
    clarify: "澄清需求，填 clarifications（feature 还需填 FeatureSpec FR/AC）",
    plan: "拆分子任务，填 split（含 slug/description/dependsOn）",
    "design-review": "填 designReviewJudgment + layerSpecific（字段名见 guidance）",
    execute: "planning 层：cw 自动建子层 unit；wave 层：写代码并 git commit，把 commitHash 填入 cw execute input",
    test: "确保测试通过（cw 自动跑测试）",
    "exec-review": "审查代码质量",
    retrospect: "复盘（planning 层读子层 session jsonl 做真实验收）",
    closeout: "冻结交付物",
  };

  // planning 层 execute 后需把 children 信息抄回 schema（供 topoSort 算依赖）。
  // C1 兼容：cw execute 若不返 children，降级用 cw tree 收集 unitId（无 dependsOn → 全并发）。
  let extra = "";
  if (action === "execute" && node.scope !== "wave") {
    extra = `
重要：调 \`cw execute\` 后，检查 stdout JSON 的 \`children\` 字段。
- 如果有 children 字段（含 [{unitId, dependsOn}]）：从中原样抄录 unitId 和 dependsOn 填入你的 schema 输出。
- 如果没有 children 字段：调 \`cw tree --unitId ${node.unitId}\` 收集子 unitId（此时无 dependsOn 信息，拓扑排序退化为全并发）。
不要自己编造 children——从 cw 的返回值或 cw tree 原样抄录。`;
  }

  // replan 操作指示（spec-f §5：支持 replan，agent 发现方案需调整时主动触发）
  const replanGuidance = `

如果你在执行 action 时发现 plan 需要调整（技术方案有误、子任务要增减）：
1. 调 \`cw replan --unitId ${node.unitId} --input '<根据 cw handoff 的 replan input schema 填写>'\`
2. 在 schema 返回值里设 \`replanTriggered: true\`，并把 \`cw replan\` stdout 的 \`replanImpact.aborted\` 数组（被级联 abort 的子 unitId）抄到 schema 的 \`abortedChildren\` 字段
3. 不要继续执行当前 action——replan 后 cw 要求回 plan 重走`;

  // m5：replanGuidance 只对可能发现方案问题的 action 注入（retrospect/closeout 注入会诱导不必要 replan）
  const showReplanHint = ["plan", "design-review", "execute", "test"].includes(action);

  return `你是 cw 流程执行者。

任务：完成 WorkUnit ${node.unitId} 的 ${action} 操作。

步骤：
1. 先调 \`cw handoff --unitId ${node.unitId}\` 获取上下文（含前序 action 的产出 + 下一步 guidance + input schema）
2. 按 guidance 执行 ${action}（${hints[action] ?? ""}）
3. 调 \`cw ${action} --unitId ${node.unitId} --input '<根据 guidance 的 schema 填写>'\` 推进状态
4. 如果 gate fail（返回 ok=false），读 mustFix 修正后重调步骤 3
5. 成功后返回结果${extra}${showReplanHint ? replanGuidance : ""}`;
}

/**
 * 为单节点构建 action 的 schema（returnMeta 模式下约束 agent 返回结构）。
 * planning execute：需 children（供主循环 topoSort）；wave closeout：业务产出；其他：done 哨兵。
 */
function buildActionSchema(node, action, isWave) {
  // base 属性：所有 action 都含 replan 信号字段（replan 可在任何 action 触发）
  const baseProps = {
    done: { type: "boolean" },
    replanTriggered: { type: "boolean", description: "如果调了 cw replan 设为 true" },
    abortedChildren: { type: "array", items: { type: "string" }, description: "被级联 abort 的子 unitId 列表" },
  };

  // planning execute：返回 children（从 cw execute stdout 或 cw tree 抄录）
  if (!isWave && action === "execute") {
    return {
      type: "object",
      required: [],
      properties: {
        ...baseProps,
        children: {
          type: "array",
          description: "从 cw execute stdout 的 children 字段原样抄录（无则从 cw tree 收集 unitId）",
          items: {
            type: "object",
            properties: {
              unitId: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };
  }
  // wave closeout：业务产出（commitHash 供追溯，summary 供上层 retrospect 读）
  if (isWave && action === "closeout") {
    return {
      type: "object",
      required: [],
      properties: {
        ...baseProps,
        commitHash: { type: "string" },
        summary: { type: "string" },
      },
    };
  }
  // 其他 action：base（done 哨兵 + replan 信号）。m4：展开 baseProps 避免共享引用
  return { type: "object", required: [], properties: { ...baseProps } };
}

/**
 * 执行单节点的 nextAction：worktree 决策 + agent 调用 + session 回收 + 失败处理。
 * returnMeta:true → 返回 {unitId, value, sessionFile?, worktreePath?, failedReason?, replanTriggered?, abortedChildren?}。
 * replanTriggered: agent 声明触发 cw replan 时为 true（携 abortedChildren 列表），主循环据此调 handleReplan 清理子节点 + 设 replanOverride。
 * execute 成功后清除 replanOverride（replan 周期结束，恢复信 frontier）：见下方实现。
 * 失败（r.error / 超时）→ abortUnit + 返回 failedReason（不 throw，主循环继续其他节点）。
 * 注意：失败字段命名 failedReason 而非 error，避免被 parallel() 归一化吞掉其他字段（见 C1）。
 */
async function executeNodeNextAction(node, worktreeRegistry, sessionFiles, replanOverride) {
  const isWave = node.scope === "wave";
  const action = node.nextAction;

  // worktree 复用决策（仅 wave 层——唯一写代码层，需文件隔离）：
  // 1. 已有注册 → 复用
  // 2. 依赖链上有 → 继承复用（同 worktree 多 wave 安全：dependsOn 保证顺序）
  // 3. 都没有 → 新开 worktree（agent opts.worktree:true）
  let cwd = $WORKSPACE;
  let useWorktree = false;
  if (isWave) {
    if (worktreeRegistry[node.unitId]) {
      cwd = worktreeRegistry[node.unitId];
    } else {
      const inheritedWt = findInheritedWorktree(node, worktreeRegistry);
      if (inheritedWt) {
        cwd = inheritedWt;
        worktreeRegistry[node.unitId] = inheritedWt;
      } else {
        useWorktree = true;
      }
    }
  }

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
    worktree: useWorktree,
    returnMeta: true,
    cwd,
    timeoutMs: ACTION_TIMEOUT_MS,
  });

  // 回收 worktreePath（wave 首次新开时）：登记到 registry 供后续同依赖链 wave 复用
  if (isWave && r.worktreePath && !worktreeRegistry[node.unitId]) {
    worktreeRegistry[node.unitId] = r.worktreePath;
  }

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
 * 拓扑分组：把 actionable 节点分成 concurrent（无内部依赖，可全并行）和 sequential（有内部依赖，串行）。
 * "内部依赖" = dependsOn 指向本轮 actionable 集合内的节点。
 * 直接环检测（A↔B）：throw（避免死锁调度）。
 */
function topoSort(actionable) {
  const concurrent = [];
  const sequential = [];
  const actionableIds = new Set(actionable.map((n) => n.unitId));

  for (const node of actionable) {
    const deps = node.dependsOn ?? [];
    const internalDeps = deps.filter((d) => actionableIds.has(d));
    if (internalDeps.length > 0) {
      sequential.push(node);
    } else {
      concurrent.push(node);
    }
  }

  // 直接环检测（A↔B）：sequential 集合内若两节点互相依赖，调度会死锁，直接 throw
  if (sequential.length > 0) {
    const seqIds = new Set(sequential.map((n) => n.unitId));
    for (const node of sequential) {
      const cycleDeps = (node.dependsOn ?? []).filter((d) => seqIds.has(d));
      for (const dep of cycleDeps) {
        const depNode = sequential.find((n) => n.unitId === dep);
        if (depNode && (depNode.dependsOn ?? []).includes(node.unitId)) {
          throw new Error("Circular dependency detected: " + node.unitId + " <-> " + dep);
        }
      }
    }
  }

  // Kahn 拓扑排序：sequential 组内按依赖序排列（被依赖者先执行），保证串行执行时依赖已完成。
  // 排序后若 sorted.length !== sequential.length，说明有间接环（A→B→C→A，非两两互依），
  // 直接 throw 避免死锁调度。
  if (sequential.length > 0) {
    const seqIds = new Set(sequential.map((n) => n.unitId));
    const inDegree = {};
    const dependents = {}; // unitId → 依赖它的节点 unitId 列表
    for (const n of sequential) {
      inDegree[n.unitId] = 0;
      dependents[n.unitId] = [];
    }
    for (const n of sequential) {
      for (const dep of (n.dependsOn ?? [])) {
        if (seqIds.has(dep)) {
          inDegree[n.unitId]++;
          dependents[dep].push(n.unitId);
        }
      }
    }
    const queue = sequential.filter((n) => inDegree[n.unitId] === 0).map((n) => n.unitId);
    const sorted = [];
    while (queue.length > 0) {
      const id = queue.shift();
      sorted.push(sequential.find((n) => n.unitId === id));
      for (const depId of dependents[id]) {
        inDegree[depId]--;
        if (inDegree[depId] === 0) queue.push(depId);
      }
    }
    if (sorted.length !== sequential.length) {
      throw new Error("Circular dependency detected in sequential group");
    }
    sequential = sorted;
  }

  return { concurrent, sequential };
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
  // worktreeRegistry: unitId → worktreePath（wave 层复用池）
  const worktreeRegistry = {};
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
    const actionable = frontier.nodes.filter((n) => !n.blocked && !isTerminal(n.status));

    // 无 actionable：全终态 → 正常结束；有非终态但全 blocked → 异常（保守 break）
    if (actionable.length === 0) {
      const allTerminal = frontier.nodes.every((n) => isTerminal(n.status));
      if (allTerminal || frontier.nodes.length === 0) break;
      log("WARN: 无 actionable 节点但树未完成，可能有节点永久 blocked");
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
        handleReplan({ unitId: node.unitId, abortedChildren: [] }, replanOverride, worktreeRegistry, sessionFiles, retryCount, prevNextAction);
        node.nextAction = "plan"; // handleReplan 内已设 replanOverride，但需显式覆盖 node.nextAction
      }
    }

    // retryCount 熔断检查 + 累加（按覆盖后的 nextAction 算 retryKey）：
    // 同节点连续 N 轮（≥ MAX_ACTION_RETRY）卡在同一 action → abort 该节点。
    // progressive action（clarify/plan/design-review）豁免——它们天然多轮迭代。
    const nodesToAbort = [];
    for (const node of actionable) {
      if (PROGRESSIVE_ACTIONS.has(node.nextAction)) {
        // 豁免熔断，但 prevNextAction 仍需记录：保证 nextAction 变化时 retryCount 正确重置
        prevNextAction[node.unitId] = node.nextAction;
        continue;
      }
      const retryKey = node.unitId + ":" + node.nextAction;
      const prevAction = prevNextAction[node.unitId];
      if (prevAction === node.nextAction) {
        retryCount[retryKey] = (retryCount[retryKey] ?? 0) + 1;
        if (retryCount[retryKey] >= MAX_ACTION_RETRY) {
          log("Node " + node.unitId + " stuck at " + node.nextAction + " for " + MAX_ACTION_RETRY + " rounds, aborting");
          nodesToAbort.push(node.unitId);
        }
      } else {
        retryCount[retryKey] = 0;
      }
      prevNextAction[node.unitId] = node.nextAction;
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
        concurrent.map((node) => executeNodeNextAction(node, worktreeRegistry, sessionFiles, replanOverride))
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
          const a = handleReplan(r, replanOverride, worktreeRegistry, sessionFiles, retryCount, prevNextAction);
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
        r = await executeNodeNextAction(node, worktreeRegistry, sessionFiles, replanOverride);
      } catch (e) {
        log("BFS: sequential node " + node.unitId + " threw: " + String(e.message || e));
        continue;
      }
      if (r && r.replanTriggered) {
        const a = handleReplan(r, replanOverride, worktreeRegistry, sessionFiles, retryCount, prevNextAction);
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
