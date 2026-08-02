"use strict";
// recursive-split-utils.cjs
// 从 recursive-split.js 抽出的纯逻辑函数 + 常量，供 vitest 单测覆盖。
// .cjs 扩展名强制 CommonJS（项目根 package.json 声明 type:module，.js 会被当 ESM 解析）。
//
// 调度模型：每 node 一个 agent 跑到阻塞（非每 action 一个 agent）。
// agent 在 session 内自主连续推进 cw action，直到 crossLayer / 反复 gate fail / 无法继续。

// ── 常量 ────────────────────────────────────────────────────────────

// 同一 node 被 BFS 连续 dispatch 的轮次上限：status 没推进 → abort 该 node。
// 注意：实际熔断需 MAX_NODE_ROUNDS 轮——第 1 轮建 prevStatus 基线，之后连续 N 轮 status 不变才累加到阈值。
const MAX_NODE_ROUNDS = 3;

// 合法起始层级白名单（C3：startLayer 校验，防 shell 注入）
const VALID_LAYERS = new Set(["epic", "feature", "slice", "wave"]);

// ── 纯函数 ──────────────────────────────────────────────────────────

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
 * returnMeta 模式下检测 r.error 是否为超时类错误。
 * agent() 失败不 throw（resolve 回退值），需主动检 r.error。
 */
function isTimeoutError(r) {
  if (!r.error) return false;
  const lower = String(r.error).toLowerCase();
  return lower.includes("timeout") || lower.includes("aborted");
}

/**
 * 转义 objective 中的单引号（C2/C4：拼进 cw create 的 shell 命令，防引号破坏 + 注入）。
 * task 用单引号包裹传入 shell——单引号内只剩单引号需特殊处理：每个 ' 替换为 '\''。
 * 入参强制 String(task)（task 来自 $ARGS，可能 undefined → "undefined"，调用方应在更上游 fail-fast）。
 */
function escapeSingleQuotes(task) {
  return String(task).replace(/'/g, "'\\''");
}

/**
 * 判定 returnMeta 结果 r 的节点结局（W2 核心收尾分支）。
 * r.error 非空 或 isTimeoutError(r) → 失败，返回 { failed: true, failedReason }。
 *   failedReason = r.error（超时时为 timeout 关键字串，由 isTimeoutError 判定后回退）。
 * 否则 → 正常，返回 { failed: false }。
 *
 * 与 executeNodeNextAction 内联逻辑严格一致：
 *   if (r.error || isTimeoutError(r)) failedReason = r.error
 * 注意 isTimeoutError(r) 仅在 r.error 为真时返回 true，故与 r.error 等价——
 * 此处保留 || 形态以显式表达"任何 r.error 都视为失败"的契约。
 */
function decideNodeOutcome(r) {
  if (r.error || isTimeoutError(r)) {
    return { failed: true, failedReason: r.error };
  }
  return { failed: false };
}

/**
 * 为单节点构建 agent prompt（推进到阻塞模型）。
 * agent 在 session 内自主连续推进 cw action，直到遇到停止条件。
 * guidance 是唯一导航源（cw-cli skill 约定），prompt 不硬编码 schema 字段名。
 */
function buildActionPrompt(node) {
  const isWave = node.scope === "wave";

  // planning 层 execute 后需把 children 信息抄回 schema（供 topoSort 算依赖）。
  let childrenHint = "";
  if (!isWave) {
    childrenHint = `

如果你推进到了 planning 层的 execute：
- 调 \`cw execute\` 后，检查 stdout JSON 的 \`children\` 字段。
- 如果有 children（含 [{unitId, dependsOn}]）：从中原样抄录 unitId 和 dependsOn 填入你的 schema 输出。
- 如果没有 children：调 \`cw tree --unitId ${node.unitId}\` 收集子 unitId（无 dependsOn → 全并发）。
- execute 后 cw 返回 crossLayer.descend（指向第一个子 unit），这是你的停止条件——子层交给主调度器。`;
  }

  return `你是 cw 流程执行者。

任务：推进 WorkUnit ${node.unitId} 尽可能远，直到遇到以下停止条件之一：
1. \`cw handoff\` 或 \`cw <action>\` 返回的 nextAction 含 crossLayer（action 为 undefined）——需要跳到另一个 WorkUnit，这是你的停止信号
2. 同一 action 连续 gate fail 超过 3 次——返回说明哪个 action 反复 fail、mustFix 内容
3. 你判断无法继续（如需要外部决策）——返回说明原因

方法：
1. 调 \`cw handoff --unitId ${node.unitId}\` 获取上下文 + guidance + input schema
2. 按 guidance 的命令行执行当前 action（copy guidance 的"命令"那行，不要自己拼——cw 的 --input 是文件路径语义，字面 JSON 串会报错；execute 用 --commitHash flags，其他 action 用 --input 文件路径或 stdin）
3. 如果 gate fail（返回 ok=false），读 mustFix 修正后重调同一个 action
4. gate pass 后不要返回——继续调 \`cw handoff\` 拿下一步 guidance，重复步骤 2-3
5. 直到遇到上述停止条件才返回${childrenHint}

关键提示：
- clarify 是 progressive action——调一次 \`cw clarify\` 后如果需求已清晰，**立即调 \`cw plan\` 前进**，不要重复 clarify
- test action：为本 wave 的代码**产出 vitest 测试文件**（如果还没有测试的话），覆盖 plan 声明的 testCases，跑 \`npx vitest run\` 确认全绿后才调 \`cw test\`——不要只用 testJudgment 文字判定
- execute（wave 层）：写代码后 \`git add -A && git commit\`，拿到 commitHash 后调 \`cw execute --unitId ${node.unitId} --commitHash <hash>\``;
}

/**
 * 为单节点构建 agent schema（推进到阻塞模型）。
 * 统一 schema——不再区分 action 类型，agent 在 session 内连续跑多个 action。
 */
function buildActionSchema(node) {
  const isWave = node.scope === "wave";

  const baseProps = {
    done: { type: "boolean", description: "是否推进到了停止条件" },
    stopReason: {
      type: "string",
      description: "停止原因：crossLayer / gateFailed / blocked / cannotProceed",
    },
    lastStatus: { type: "string", description: "最后查到的 cw status" },
    replanTriggered: { type: "boolean", description: "如果调了 cw replan 设为 true" },
    abortedChildren: {
      type: "array",
      items: { type: "string" },
      description: "被级联 abort 的子 unitId 列表（replan 时从 cw replan stdout 抄录）",
    },
  };

  // planning 层需要 children（execute 后供 topoSort）
  if (!isWave) {
    return {
      type: "object",
      required: ["done"],
      properties: {
        ...baseProps,
        children: {
          type: "array",
          description: "planning execute 后从 cw stdout 或 cw tree 抄录的子 unitId + dependsOn",
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

  return { type: "object", required: ["done"], properties: baseProps };
}

/**
 * 拓扑分组：把 actionable 节点分成 concurrent（无内部依赖，可全并行）和 sequential（有内部依赖，串行）。
 * "内部依赖" = dependsOn 指向本轮 actionable 集合内的节点。
 * 直接环检测（A↔B）：throw（避免死锁调度）。
 */
function topoSort(actionable) {
  const concurrent = [];
  let sequential = [];

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

// ── 从主循环内联块新抽的函数 ────────────────────────────────────────

/**
 * 从 frontier 提取 actionable 节点 + 判定是否应该终止 BFS。
 * actionable = !blocked && !isTerminal(status)。
 * 返回 { actionable, shouldBreak }。
 * shouldBreak=true 表示无 actionable 且树已完成或空——BFS 应退出。
 */
function selectActionable(frontier) {
  const nodes = frontier.nodes ?? [];
  const actionable = nodes.filter((n) => !n.blocked && !isTerminal(n.status));

  if (actionable.length > 0) {
    return { actionable, shouldBreak: false };
  }

  // 无 actionable：全终态 → 正常结束；有非终态但全 blocked → 异常（保守 break）
  const allTerminal = nodes.length === 0 || nodes.every((n) => isTerminal(n.status));
  return { actionable: [], shouldBreak: true, allTerminal };
}

/**
 * node 级熔断：遍历 actionable 节点，识别连续 dispatch 但 status 没推进的 node。
 * 替代旧的 action 级熔断（PROGRESSIVE_ACTIONS 豁免已删除）。
 * 返回 nodesToAbort[]（unitId 列表）。mutation prevStatus / nodeRounds。
 */
function detectStuckNodes(actionable, prevStatus, nodeRounds) {
  const nodesToAbort = [];

  for (const node of actionable) {
    const prev = prevStatus[node.unitId];
    if (prev === node.status) {
      // status 没变——可能是 agent 只做了 progressive action（如 clarify）没前进
      nodeRounds[node.unitId] = (nodeRounds[node.unitId] ?? 0) + 1;
      if (nodeRounds[node.unitId] >= MAX_NODE_ROUNDS) {
        nodesToAbort.push(node.unitId);
      }
    } else {
      // status 变了——node 在推进，重置计数
      nodeRounds[node.unitId] = 0;
    }
    prevStatus[node.unitId] = node.status;
  }

  return nodesToAbort;
}

// ── 导出 ────────────────────────────────────────────────────────────

module.exports = {
  // 常量
  MAX_NODE_ROUNDS,
  VALID_LAYERS,
  // 纯函数
  isTerminal,
  assertValidUnitId,
  isTimeoutError,
  escapeSingleQuotes,
  decideNodeOutcome,
  buildActionPrompt,
  buildActionSchema,
  topoSort,
  // 主循环辅助
  selectActionable,
  detectStuckNodes,
};
