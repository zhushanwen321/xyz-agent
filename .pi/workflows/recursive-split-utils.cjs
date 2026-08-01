"use strict";
// recursive-split-utils.js
// 从 recursive-split.js 抽出的纯逻辑函数 + 常量，供 vitest 单测覆盖。
// 不依赖任何 pi 全局（$ARGS / $WORKSPACE / execSync / agent / parallel / log / phase）。
// 主脚本通过 require("./recursive-split-utils") 消费。

// ── 常量 ────────────────────────────────────────────────────────────

// 同一节点卡在同一 action 的轮次上限：超过则 abort 该节点（熔断）。
// 注意：实际熔断需 MAX_ACTION_RETRY+1 轮——第 1 轮建立 prevNextAction 基线（不计入累加），
// 之后连续 N 轮同 action 才累加到阈值。
const MAX_ACTION_RETRY = 3;

// 渐进式 action 熔断豁免：clarify/plan/design-review 天然多轮迭代（gate 多次 fail 正常），
// 不计入卡死判定
const PROGRESSIVE_ACTIONS = new Set(["clarify", "plan", "design-review"]);

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
1. 调 \`cw replan --unitId ${node.unitId}\`（input 格式按 replan guidance 的命令行：cw 的 --input 是文件路径语义，字面 JSON 串会报错；用文件路径或 stdin 提交，或按 guidance 给的 flags）
2. 在 schema 返回值里设 \`replanTriggered: true\`，并把 \`cw replan\` stdout 的 \`replanImpact.aborted\` 数组（被级联 abort 的子 unitId）抄到 schema 的 \`abortedChildren\` 字段
3. 不要继续执行当前 action——replan 后 cw 要求回 plan 重走`;

  // m5：replanGuidance 只对可能发现方案问题的 action 注入（retrospect/closeout 注入会诱导不必要 replan）
  const showReplanHint = ["plan", "design-review", "execute", "test"].includes(action);

  return `你是 cw 流程执行者。

任务：完成 WorkUnit ${node.unitId} 的 ${action} 操作。

步骤：
1. 先调 \`cw handoff --unitId ${node.unitId}\` 获取上下文（含前序 action 的产出 + 下一步 guidance + input schema）
2. 按 guidance 执行 ${action}（${hints[action] ?? ""}）
3. 按 \`cw handoff\` guidance 给的命令格式推进状态（copy guidance 的 "命令" 那行的完整命令，不要自己拼——cw 的 --input 是文件路径语义，字面 JSON 串会报错；execute 用 --commitHash flags，其他 action 用 --input 文件路径或 stdin）
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
  // 其他 action：base（done 哨兵 + replan 信号）。展开 baseProps 避免共享引用
  return { type: "object", required: [], properties: { ...baseProps } };
}

/**
 * replan 处理：清理被 abort 子节点的内存态 + 设 replanOverride + 重置 retryCount。
 * mutation 入参对象（replanOverride / sessionFiles / retryCount / prevNextAction）——保持原副作用语义。
 * 返回 aborted Set（主循环用于跳过本轮 dispatch）。
 */
function handleReplan(r, replanOverride, sessionFiles, retryCount, prevNextAction) {
  // 设 replanOverride：下一轮 frontier 会给 retrospect，但实际要重走 plan
  replanOverride[r.unitId] = "plan";

  // 重置触发 replan 节点自身的 retryCount（replan 周期内 execute 反复 fail 不应误杀）。
  // 清该节点所有 action 的计数（key 格式 unitId:action）
  for (const key of Object.keys(retryCount)) {
    if (key.startsWith(r.unitId + ":")) delete retryCount[key];
  }

  // 清理被 abort 子节点的内存态——它们已终态，不再参与 BFS
  const aborted = new Set(r.abortedChildren ?? []);
  for (const childId of aborted) {
    delete sessionFiles[childId];
    delete prevNextAction[childId];
    for (const key of Object.keys(retryCount)) {
      if (key.startsWith(childId + ":")) delete retryCount[key];
    }
  }

  return aborted;
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
 * 熔断检测：遍历 actionable 节点，识别连续卡在同一 action 的节点。
 * progressive action（clarify/plan/design-review）豁免熔断。
 * 返回 nodesToAbort[]（unitId 列表）。mutation retryCount / prevNextAction。
 */
function detectStuckNodes(actionable, retryCount, prevNextAction) {
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
        nodesToAbort.push(node.unitId);
      }
    } else {
      retryCount[retryKey] = 0;
    }
    prevNextAction[node.unitId] = node.nextAction;
  }

  return nodesToAbort;
}

/**
 * 归约单节点 action 执行结果：回收 sessionFile / 识别失败 / 处理 replan。
 * concurrent 和 sequential 共用此逻辑。
 *
 * @param {object} r - executeNodeNextAction 返回的结果
 *   - 成功: { unitId, value, sessionFile? }
 *   - 主动失败: { unitId, value?, sessionFile?, failedReason }
 *   - parallel 归一化 throw: { status:"failed", error }（无 unitId）
 *   - replan 触发: { unitId, ..., replanTriggered:true, abortedChildren }
 * @param {object} ctx - { replanOverride, sessionFiles, retryCount, prevNextAction, logFn }
 * @returns { {abortedChildren?: Set} } replan 清理出的 aborted 子节点（主循环用于跳过 dispatch）
 */
function reduceActionResults(r, ctx) {
  const { replanOverride, sessionFiles, retryCount, prevNextAction, logFn } = ctx;
  const log = logFn ?? (() => {});
  const result = { abortedChildren: null };

  if (!r) return result;

  // parallel 归一化形态：意外 throw（{status:"failed", error}），无 unitId
  if (r.status === "failed") {
    log("BFS: node failed (thrown): " + (r.error ?? "unknown"));
    return result;
  }

  // 回收 sessionFile
  if (r.sessionFile) {
    sessionFiles[r.unitId] = r.sessionFile;
  }

  // replan 检测：agent 声明 replanTriggered
  if (r.replanTriggered) {
    const aborted = handleReplan(r, replanOverride, sessionFiles, retryCount, prevNextAction);
    result.abortedChildren = aborted;
    return result;
  }

  // 失败处理
  if (r.failedReason) {
    log("BFS: " + r.unitId + " failed: " + r.failedReason);
  }

  return result;
}

// ── 导出 ────────────────────────────────────────────────────────────

module.exports = {
  // 常量
  MAX_ACTION_RETRY,
  PROGRESSIVE_ACTIONS,
  VALID_LAYERS,
  // 纯函数
  isTerminal,
  assertValidUnitId,
  isTimeoutError,
  buildActionPrompt,
  buildActionSchema,
  handleReplan,
  topoSort,
  // 新抽函数
  selectActionable,
  detectStuckNodes,
  reduceActionResults,
};
