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

// queryFrontier 连续失败容忍上限：单次 cw frontier 超时只 continue 重试下一轮，
// 连续失败到 MAX_FRONTIER_RETRIES 才判定为永久性故障并终止整个递归拆分。
// 避免单次临时性网络/进程抖动永久终止长任务。
const MAX_FRONTIER_RETRIES = 3;

// progressive action 集合（从 cw src/rules/state-machine.ts 的 progressive: true 标记抄）。
// progressive action 的 handler 成功后 status 推进到原地语义（如 clarifying→clarifying），
// 必须在 session 内合并跑，否则 frontier 会死循环（每轮返回同一 action）。
// 用途：buildActionPrompt 教 agent 识别可合并 action；executeActionAgent 据 action 类型选 timeout。
// 注：frontier 的 nextAction 永远只会命中 clarify/plan（progressive）或
// execute/test/exec-review/retrospect/closeout（非 progressive），
// 永远不会命中 design-review/replan（STATUS_TO_ACTION 无此映射）。
const PROGRESSIVE_ACTIONS = new Set(["clarify", "plan", "design-review", "replan"]);

/**
 * 判断 action 是否 progressive（需在 session 内合并跑）。
 */
function isProgressive(action) {
  return PROGRESSIVE_ACTIONS.has(action);
}

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
 * 与 executeActionAgent 内联逻辑严格一致：
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
 * 为单节点构建 action-centric agent prompt。
 * agent 跑明确的 action（或合并的 progressive action 段 clarify→plan→design-review）。
 * 最高优先级：design-review 跑完必须停（对抗 ActionResult.nextAction 的 execute 引导）。
 */
function buildActionPrompt(node) {
  const isWave = node.scope === "wave";
  const unitId = node.unitId;
  const nextAction = node.nextAction;

  const sections = [
    `你是 cw 流程执行者，负责推进 WorkUnit ${unitId}.`,
    ``,
    `## 你的起点 action：${nextAction}（由调度器根据 cw status 派发）`,
    ``,
    `## 执行规则（按优先级）`,
    ``,
    `### 最高优先级：design-review 跑完必须停`,
    `如果你跑的 action 是 design-review 且 gate pass，**立即停止并返回**（stopReason=progressive-done）。`,
    `**即便 ActionResult.nextAction 推你去 execute，也不要继续。** execute 是下一个 agent 的任务。`,
    ``,
    `### progressive 链推进（仅当起点是 clarify/plan）`,
    `progressive action（clarify/plan/design-review）跑完 gate pass 后，**读 ActionResult.nextAction**（不是重新调 handoff！）：`,
    `- 若 nextAction 仍是 progressive（plan/design-review）：继续跑`,
    `- 若 nextAction 是 execute：按上面"最高优先级"停止`,
    ``,
    `不要在 progressive 段重新调 cw handoff——它返回的 action 基于 status，在 progressive 区段是幂等的（永远返回同一 action），会导致死循环。推进只靠 ActionResult.nextAction。`,
    ``,
    `### 非 progressive action（仅当起点是 execute/test/exec-review/retrospect/closeout）`,
    `跑完这一个 action（gate pass）后立即停止（stopReason=action-done 或 closed）。不要连续跑下一个 action。`,
    ``,
    `### gate fail`,
    `gate fail 时读 ActionResult 的异常 guidance 四段式（problem + fixCommand）。按 fixCommand 重跑同一 action，最多 3 次。超限则停止（stopReason=gate-failed，填 failedReason）。`,
    ``,
    `### replan 限制`,
    `replan 只允许在 design-reviewed 状态触发。在 executing/testing/tested/exec-reviewed/retrospected 状态**禁止 replan**（会导致不可恢复死路）。若在这些状态遇到问题，停止并返回（stopReason=cannot-proceed）。`,
    ``,
    `## 入口`,
    `调一次 \`cw handoff --unitId ${unitId}\` 拿当前 action 的 guidance + input schema（确认起点）。`,
  ];

  if (isWave) {
    sections.push(
      ``,
      `## 关键提示（wave 层）`,
      `- test action：为本 wave 的代码**产出 vitest 测试文件**（如果还没有测试的话），覆盖 plan 声明的 testCases，跑 \`npx vitest run\` 确认全绿后才调 \`cw test\`——不要只用 testJudgment 文字判定`,
      `- execute（wave 层）：写代码后 \`git add -A && git commit\`，拿到 commitHash 后调 \`cw execute --unitId ${unitId} --commitHash <hash>\``
    );
  }

  sections.push(
    ``,
    `## 返回 schema`,
    `按 schema 填：stopReason（按 enum）+ actionsExecuted[]（实际跑过的 action 名列表）+ failedReason（gate-failed/cannot-proceed 时必填）。crossLayer 如有可填（观测用，调度器不消费）。`
  );

  return sections.join("\n");
}

/**
 * 为单节点构建 action-centric agent schema。
 * 统一 schema（不区分 wave/planning）：stopReason enum + actionsExecuted + crossLayer + failedReason。
 * 旧字段 done/lastStatus/replanTriggered/abortedChildren/children 全部移除（详见设计文档 §17.1）。
 */
function buildActionSchema(node) {
  return {
    type: "object",
    required: ["stopReason"],
    properties: {
      stopReason: {
        type: "string",
        enum: ["progressive-done", "action-done", "gate-failed", "crosslayer-descend", "closed", "cannot-proceed"],
        description:
          "停止原因。progressive-done=合并 progressive 段完成（design-review 跑完）；action-done=非 progressive action 跑完；gate-failed=gate fail 重试超限；crosslayer-descend=planning execute 后 descend；closed=closeout 终态；cannot-proceed=需外部决策或违规 replan",
      },
      actionsExecuted: {
        type: "array",
        items: { type: "string" },
        description: "本次实际跑过的 action 名列表（如 ['clarify','plan','design-review']），供观测",
      },
      crossLayer: {
        type: "string",
        description: "ActionResult 返回的 crossLayer（descend/ascend/sibling），观测用，调度器不消费",
      },
      failedReason: {
        type: "string",
        description: "stopReason 为 gate-failed 或 cannot-proceed 时必填，说明失败/无法继续原因",
      },
    },
  };
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
 * node 级熔断：遍历 actionable 节点，识别两类需 abort 的 node。
 * 返回 nodesToAbort[]（unitId 列表）。mutation prevStatus / nodeRounds。
 *
 * 1. replan 判定（按 §17.3）：node.lastStatusHistoryAction === "replan" 时按 status 区分：
 *    - design-reviewed：合法 replan（plan.from 含 design-reviewed，可恢复）→ 放行，不计数
 *    - executing/testing/tested/exec-reviewed/retrospected：违规 replan（plan.from 不含这些
 *      status，agent 调 plan 会被 guard 拒绝 → 死路）→ 立即 abort
 * 2. status 未推进熔断：跨 BFS 轮 status 不变连续 MAX_NODE_ROUNDS 次 → abort
 *
 * 向后兼容：node 无 lastStatusHistoryAction 字段时走 status 未推进逻辑（原行为）。
 */
function detectStuckNodes(actionable, prevStatus, nodeRounds) {
  const nodesToAbort = [];

  for (const node of actionable) {
    // replan 判定（按 status 区分合法/违规）
    if (node.lastStatusHistoryAction === "replan") {
      if (node.status === "design-reviewed") {
        // 合法 replan：放行，不计数为 stuck
        prevStatus[node.unitId] = node.status;
        continue;
      }
      // 违规 replan：executing/testing/tested/exec-reviewed/retrospected → 立即 abort
      nodesToAbort.push(node.unitId);
      prevStatus[node.unitId] = node.status;
      continue;
    }

    // status 未推进熔断
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

/**
 * 清理 prevStatus / nodeRounds 中已进入终态的节点 entry（防止两 Map 无界增长）。
 *
 * 问题：prevStatus / nodeRounds 只增不减，终态节点的 entry 永不清理。超长任务（成百上千
 * 个 wave node 依次完成）下两 Map 会累积所有历史终态节点的 status，造成内存浪费 + 跨轮
 * 比对时遍历无意义 entry。
 *
 * 终态节点不会出现在 frontier（cw frontier 只返回非终态 actionable/blocked 节点），所以无法
 * 从"本轮 frontier"直接得知哪些节点刚变终态。本函数用"上一轮见过 + 本轮 frontier 中不存在 +
 * 在 prevStatus 中有记录"来推断刚消失的节点，再按其 prevStatus 判定是否终态决定是否清理。
 *
 * 纯函数：直接 mutate 入参两 Map（与 detectStuckNodes 同样的副作用契约——调用方传入需持久
 * 化的累加器对象，函数就地修改避免反复浅拷贝大对象）。返回被清理的 unitId 列表（供测试断言）。
 *
 * @param prevStatus    unitId → 上一轮 status（mutable）
 * @param nodeRounds    unitId → 连续未推进轮数（mutable）
 * @param currentUnitIds 本轮 frontier 中出现的所有 unitId（含 blocked 节点，不含终态）
 * @returns 被清理掉的 unitId 列表
 */
function pruneTerminalEntries(prevStatus, nodeRounds, currentUnitIds) {
  const present = new Set(currentUnitIds);
  const pruned = [];

  for (const unitId of Object.keys(prevStatus)) {
    // 本轮 frontier 仍存在 → 还在调度，保留
    if (present.has(unitId)) continue;
    // 本轮没出现 + 上轮 status 是终态 → 已完成/中止，清理 entry
    if (isTerminal(prevStatus[unitId])) {
      delete prevStatus[unitId];
      delete nodeRounds[unitId];
      pruned.push(unitId);
    }
    // 本轮没出现 + 上轮 status 非终态：可能是 queryFrontier 临时失败/抖动漏报，
    // 保守保留 entry（下轮再判），避免误清掉仍在调度的活跃节点。
  }

  return pruned;
}

// ── 导出 ────────────────────────────────────────────────────────────

module.exports = {
  // 常量
  MAX_NODE_ROUNDS,
  VALID_LAYERS,
  MAX_FRONTIER_RETRIES,
  PROGRESSIVE_ACTIONS,
  // 纯函数
  isTerminal,
  isProgressive,
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
  pruneTerminalEntries,
};
