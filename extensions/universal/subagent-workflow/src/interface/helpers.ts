/**
 * Workflow Extension — Interface helpers
 *
 * notifyDone(pi, runId, run, notified) — run 完成时发 completion notification。
 *
 * 层归属：Interface（依赖 Pi SDK + Engine WorkflowRun 模型）。
 *
 * 参考：domain-models.md §D-12。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { WorkflowRun } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import {
  guiComponent,
  type GuiContext,
  type GuiRenderResult,
  guiResult,
  isGuiCapable,
} from "@xyz-agent/extension-protocol";
import { mapRunIcon, mapRunStatus } from "./gui-mappers.ts";

// ── 常量 ─────────────────────────────────────────────────────

const JSON_INDENT = 2;
const MAX_RESULT_LENGTH = 8000;

// ── bounded pretty 序列化（IF13/#19，TC5/ES5，helpers 私有）─────────

/**
 * bounded JSON pretty 序列化：只生成会被保留的前缀（≤8000 输出与
 * JSON.stringify(value, null, JSON_INDENT) 逐字节一致；>8000 输出与
 * 全量序列化后 .slice(0, budget) + "\n... (truncated)" 逐字节一致——
 * 等价测试锚定，见 __tests__/helpers-bounded-serialize.test.ts）。
 *
 * 现状成本：全量 stringify 产生数 MB 中间串再丢弃 99%；本函数在输出字符流
 * 越过 budget 后停止一切生成。保真策略：原语（string/number/boolean/null/bigint）
 * 逐值复用 JSON.stringify（转义/Unicode/数字格式原生一致，零重实现），仅结构
 * 拼装（2 空格缩进/逗号/括号）自实现。
 *
 * 特殊值语义（TC5 a-d，与原生 JSON.stringify 全值域对齐）：
 * (a) 含 toJSON 的对象 → 该子树整体走一次 JSON.stringify(subtree)（原生会先调
 *     toJSON，如 Date 输出带引号序列化串；bounded 拼装展开会与原生不同）。注意
 *     边界：toJSON 返回对象时原生 pretty 会按缩进展开，本实现按原语串接其
 *     compact 形态——设计 TC5 锚定面为 Date 型（返回字符串）toJSON。
 * (b) 任何 stringify 抛出（BigInt → TypeError）→ 整体回退 String(value)（对齐
 *     旧实现整体 try/catch 的整串回退；禁止逐节点回退——输出形态与整串回退不同）。
 * (c) 对象属性值为 undefined/function/symbol → 拼装时跳过（原生省略）。
 * (d) 数组元素为 undefined/function/symbol → 序列化为 "null"（原生行为）。
 *
 * 截断边界（输出字符流层级，与对完整串 slice 逐字节等价）：逐段 append 时本段
 * 会使总长越过 budget → 只 append 本段前 (budget - 已累积) 字符（恰好 budget，
 * 可切在转义序列/括号中间，不补任何结构闭合）；越过（exceeded）才追加
 * "\n... (truncated)" 标记——恰好 ===budget 不加（> 判定）。
 *
 * 祖先 Set 循环引用守卫：命中 → 整体回退 String(value)（同 (b) 整串回退语义）。
 */
function boundedPrettySerialize(value: unknown, budget: number): string {
  const ancestors = new Set<object>();
  let out = "";
  let exceeded = false;

  /** 逐段追加：越过 budget 时截到恰好 budget 并置 exceeded（后续生成全部剪枝）。 */
  function append(s: string): void {
    if (exceeded) return;
    if (out.length + s.length <= budget) {
      out += s;
      return;
    }
    out += s.slice(0, budget - out.length);
    exceeded = true;
  }

  function serialize(v: unknown, depth: number): void {
    if (exceeded) return;
    const t = typeof v;
    // 原语逐值复用原生序列化；bigint 的 JSON.stringify 抛 TypeError → 顶层 catch
    // 整体回退 (b)；NaN/Infinity → "null"（原生行为）
    if (v === null || t === "string" || t === "number" || t === "boolean" || t === "bigint") {
      append(JSON.stringify(v));
      return;
    }
    if (t === "object" && v !== null) {
      const obj = v as object;
      if (ancestors.has(obj)) {
        // 循环引用 → 整体回退 String(value)（旧实现同款整串回退）
        throw new TypeError("circular reference");
      }
      // (a) toJSON 子树整体 stringify（Reflect.get 取属性，避免不安全断言）
      if (typeof Reflect.get(obj, "toJSON") === "function") {
        append(JSON.stringify(obj));
        return;
      }
      ancestors.add(obj);
      const childIndent = " ".repeat(JSON_INDENT * (depth + 1));
      const closeIndent = " ".repeat(JSON_INDENT * depth);
      if (Array.isArray(obj)) {
        const arr = obj as unknown[];
        if (arr.length === 0) {
          append("[]");
        } else {
          append("[\n");
          for (let i = 0; i < arr.length && !exceeded; i++) {
            if (i > 0) append(",\n");
            append(childIndent);
            const el = arr[i];
            // (d) 数组元素 undefined/function/symbol → "null"
            if (el === undefined || typeof el === "function" || typeof el === "symbol") {
              append("null");
            } else {
              serialize(el, depth + 1);
            }
          }
          append("\n" + closeIndent + "]");
        }
      } else {
        // (c) 对象属性 undefined/function/symbol 跳过（Object.entries 同原生：
        // 只取 own enumerable，symbol 键天然不出现；getter 求值语义与原生一致）
        const entries = Object.entries(obj).filter(
          ([, val]) => val !== undefined && typeof val !== "function" && typeof val !== "symbol",
        );
        if (entries.length === 0) {
          append("{}");
        } else {
          append("{\n");
          for (let i = 0; i < entries.length && !exceeded; i++) {
            if (i > 0) append(",\n");
            append(childIndent + JSON.stringify(entries[i][0]) + ": ");
            serialize(entries[i][1], depth + 1);
          }
          append("\n" + closeIndent + "}");
        }
      }
      ancestors.delete(obj);
      return;
    }
    // 顶层 undefined/function/symbol（调用方守卫后不可达；防御兜底对齐原生 "null"）
    append(JSON.stringify(v) ?? "null");
  }

  try {
    serialize(value, 0);
    return exceeded ? out + "\n... (truncated)" : out;
  } catch {
    // (b) 整体回退：String(value)（超 budget 仍截断 + 标记，与旧实现截断路径一致）
    const fallback = String(value);
    return fallback.length > budget
      ? fallback.slice(0, budget) + "\n... (truncated)"
      : fallback;
  }
}

/**
 * notifiedRunIds 去重窗口大小。
 *
 * 最近该数量的已通知 runId 可去重，更旧挤出后不再去重——runId 全局唯一
 * （wf-<Date.now>-<rand>），旧 id 重现概率为零，语义无损。
 */
export const MAX_NOTIFIED_RUN_IDS = 1000;

/** runId 前 8 字符用于显示（与 buildWorkflowGui 的 label 格式一致）。 */
const RUN_ID_DISPLAY_LENGTH = 8;

/**
 * notifyDone 的 details 结构（通过 pi.sendMessage 透传给前端）。
 *
 * 抽取为显式接口替代裸 Record<string, unknown>，明确 __gui__ 契约，
 * 便于其他 notify 路径复用（S#7）。
 */
export interface WorkflowNotifyDetails {
  runId: string;
  name: string;
  status: string;
  reason: string | undefined;
  traceLength: number;
  __gui__?: GuiRenderResult;
}

/**
 * workflow 到达 done 终态时发送完成通知。
 *
 * 通过 pi.sendMessage 注入结果消息（含 __gui__ 结构化渲染数据），
 * triggerTurn:true 唤醒 parent agent 处理结果。
 *
 * **去重**：notifiedRunIds Set 由调用方（factory/extension instance）持有，
 * 同一 runId 只通知一次（跨 session_shutdown 等边界防重复）。
 *
 * @param pi ExtensionAPI（调 sendMessage）
 * @param runId run 标识
 * @param run WorkflowRun 聚合根（读 spec.scriptName + state.status + trace + scriptResult）
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 */
export function notifyDone(
  pi: ExtensionAPI,
  runId: string,
  run: WorkflowRun,
  notifiedRunIds: Set<string>,
  ctx?: GuiContext,
): void {
  if (notifiedRunIds.has(runId)) return;
  notifiedRunIds.add(runId);

  const traceNodes = run.state.trace.toArray();
  const name = run.spec.scriptName;
  const status = `${run.state.status}${run.state.reason ? ` (${run.state.reason})` : ""}`;

 // 构建消息内容
  const parts: string[] = [];
  parts.push(`Workflow '${name}' done: ${status}`);

 // 终止性原因（非正常完成）追加防偷懒收尾指令——budget/time 耗尽或 abort 不是任务完成，
 // 模型可能把 "done" 当成功汇报（F3 偷懒完成）。收尾三步骤与 turn-limiter WRAP_UP_MESSAGE 对齐。
  const TERMINAL_REASONS = new Set(["budget_limited", "time_limited", "aborted", "failed", "circular"]);
  if (run.state.reason && TERMINAL_REASONS.has(run.state.reason)) {
    parts.push("");
    parts.push(
      "This is NOT task completion. Summarize what was DONE and VERIFIED, list what remains " +
      "NOT DONE, and give the user the single most important next step.",
    );
  }

  if (run.state.scriptResult !== undefined && run.state.scriptResult !== null) {
    // M10: scriptResult 来自 worker 脚本返回值（用户可控），可能含循环引用导致 JSON.stringify 抛 TypeError
    // IF13(#19)：bounded 序列化（只生成会被保留的前缀；BigInt/循环引用整体回退
    // String(x) 与旧实现整串 catch 同款）——≤8000 与旧全量 pretty 逐字节一致，
    // >8000 与 .slice(0,8000)+标记 逐字节一致（等价测试锚定）
    const truncated = boundedPrettySerialize(run.state.scriptResult, MAX_RESULT_LENGTH);
    parts.push("");
    parts.push("--- Script Result ---");
    parts.push(truncated);
  }

  parts.push("");
  parts.push("--- Agent Trace ---");
  for (const node of traceNodes) {
    parts.push(`[${node.stepIndex}] ${node.agent}: ${node.status}`);
  }

  const content = parts.join("\n");

 // deliverAs:"steer" + triggerTurn:true —— workflow 完成作为 steering 消息注入（g4-allow: 存量待迁移——结果语义通知，账本化迁移登记 pi-boundary-reliability 附录 B 待办）
 // 并立即唤醒 parent agent 处理结果（与 subagent 的 followUp+triggerTurn 对称）
  const details: WorkflowNotifyDetails = {
    runId,
    name,
    status: run.state.status,
    reason: run.state.reason,
    traceLength: traceNodes.length,
  };

  // GUI 协议：RPC 模式下附加结构化渲染数据
  if (ctx && isGuiCapable(ctx)) {
    const reason = run.state.reason;
    const statusStr = `${run.state.status}${reason ? ` (${reason})` : ""}`;
    // label 对齐 buildWorkflowGui 的格式：name + slug + runId 前 8 字符（I#3）
    const slug = run.spec.slug;
    const label = [name, slug, runId.slice(0, RUN_ID_DISPLAY_LENGTH)]
      .filter(Boolean)
      .join(" ");
    details.__gui__ = guiResult(
      guiComponent("list-tree", {
        items: [{
          label,
          status: mapRunStatus(statusStr),
          icon: mapRunIcon(statusStr),
        }],
      }),
    );
  }

  pi.sendMessage(
    {
      customType: "workflow-result",
      content,
      display: true,
      details,
    },
    { triggerTurn: true, deliverAs: "steer" }, // g4-allow: 存量待迁移——workflow 完成通知属结果语义，迁移切片复用 U2 账本设施（附录 B 待办）
  );
}

/**
 * 把 runId 纳入 notifiedRunIds 去重窗口，超 cap 时删最旧（契约 W3C2）。
 *
 * 职责拆分：**去重判定**留在 notifyDone 的 has 读（本体零改动），
 * 本函数只持**有界化**职责——返回 void，不引入双重去重判定语义。
 *
 * 语义：
 * - 幂等 add：Set.add 对已存在元素不改变其迭代位置（重复 track 同一 id，
 *   其「最旧」地位不变）。
 * - FIFO 有界：Set 迭代序=插入序，超 cap 时删迭代器首元素=最旧。
 *   被挤出窗口的旧 id 再经 notifyDone 会重新发送（runId 全局唯一，旧 id
 *   重现概率为零，该边界由 W3TC12 单测钉死）。
 *
 * 调用点：index.ts onRunDone 回调内、notifyDone 之后（notifyDone 内部已 add，
 * 此处 track 的 add 是幂等二次添加）。
 *
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 * @param runId run 标识
 * @param cap 窗口大小（默认 MAX_NOTIFIED_RUN_IDS）
 */
export function trackNotifiedRunId(
  notifiedRunIds: Set<string>,
  runId: string,
  cap: number = MAX_NOTIFIED_RUN_IDS,
): void {
  notifiedRunIds.add(runId);
  while (notifiedRunIds.size > cap) {
    const oldest = notifiedRunIds.values().next().value;
    if (oldest === undefined) break;
    notifiedRunIds.delete(oldest);
  }
}
