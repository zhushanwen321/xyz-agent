// deriveClosedDisplay 三源同构契约护栏（R1 INFO → review 修复）。
//
// closed 终态的展示语义派生在三处手写同构（跨包依赖方向不允许互相 import 源码，
// 只能复制判定逻辑）：
//   1. packages/shared/src/subagent.ts —— deriveClosedDisplay（renderer 消费的 SSOT）
//   2. extensions/universal/subagent-workflow/src/interface/bg-notify-render.ts —— renderRecordLines
//      （TUI 渲染：verb 派发块 + closed case 正文块两轮判定）
//   3. extensions/universal/subagent-workflow/src/execution/notifier.ts —— buildLlmContent
//      （LLM 通知文案的 closed 分支）
//
// 同构契约（顺序敏感，勿回退成「error 有值即 failed」的旧规则）：
//   a. closedReason 缺失兜底 'gc'（`?? "gc"`）
//   b. cancelled 判定优先（cancelled 分支不参与 error）
//   c. gc + error 判定次之（gc 失败终态 → failed）
//   d. 其余 → done/finished/completed（patch/result 展示在成功分支）
//
// 历史 bug（M1 修复）：notifier 的 gc+error 判定曾被 patchFile 分支遮蔽——gc 失败 +
// worktree 并存时 LLM 被告知 completed。本护栏机械锁定三处判定顺序，任一源重构导致
// 特征失配时 fail-loud 并给出同步指引。
//
// 实现方式：仿 packages/runtime/test/workflow-extractor.test.ts 的 wf-run-v 三源护栏
// ——读三份源码文本，定位目标函数体（花括号平衡），提取判定 token 序列断言同构。
// 放 extension 侧的原因：extension 测试可 import 自己的源 + fs 读 shared 源文件文本；
// runtime 测试读不到 extensions/（import 边界）。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** 三源绝对路径（测试文件位于 extensions/universal/subagent-workflow/src/__tests__/）。 */
const SOURCES = {
  shared: join(here, "..", "..", "..", "..", "..", "packages", "shared", "src", "subagent.ts"),
  render: join(here, "..", "interface", "bg-notify-render.ts"),
  notifier: join(here, "..", "execution", "notifier.ts"),
} as const;

/**
 * 定位函数体源码文本：锚点正则命中后，跳过参数列表（其后的第一个 `)`——三处函数
 * 参数均不含嵌套圆括号），再从其后第一个 `{` 起做花括号平衡扫描到配对 `}`
 * （shared 的参数签名含对象类型字面量 `{ closedReason?: string }`，不能直接取
 * 锚点后第一个 `{`，否则截到参数而非函数体）。三处函数体内的字符串/模板串
 * `${...}` 花括号均平衡、注释无裸花括号，平衡计数可靠；失配时 fail-loud 人工核查。
 */
function functionBody(src: string, anchor: RegExp, what: string): string {
  const m = anchor.exec(src);
  if (!m || m.index === undefined) {
    throw new Error(
      `[derive-closed-display-parity] 锚点未找到（${what}，anchor=${anchor.source}）——` +
        `函数是否被重命名/移动？改任一处必须同步其余两处与本护栏测试。`,
    );
  }
  const paramsEnd = src.indexOf(")", m.index);
  if (paramsEnd < 0) {
    throw new Error(`[derive-closed-display-parity] ${what} 锚点后未找到参数列表右括号。`);
  }
  const start = src.indexOf("{", paramsEnd);
  if (start < 0) {
    throw new Error(`[derive-closed-display-parity] ${what} 锚点后未找到函数体左花括号。`);
  }
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(
    `[derive-closed-display-parity] ${what} 函数体花括号不平衡——` +
      `可能是注释/字符串内出现裸花括号。请人工核查三源判定是否仍同构，再更新本护栏的特征提取。`,
  );
}

/**
 * 从函数体提取 closed 判定签名（按源码行序的 token 序列）：
 * - fallback-gc：`closedReason ?? "gc"` 兜底行
 * - cancelled：`=== "cancelled"` 判定行（三源中该比较仅用于 cancelled 分支守卫）
 * - gc-error：`=== "gc"` 判定行（三源中该比较仅用于 gc+error 联合判定，
 *   两侧操作数顺序不限——notifier 写作 `record.error && reason === "gc"`，语义同构）
 */
function extractSignature(body: string): string[] {
  const tokens: string[] = [];
  for (const line of body.split("\n")) {
    if (/\?\?\s*["']gc["']/.test(line)) tokens.push("fallback-gc");
    if (/===\s*["']cancelled["']/.test(line)) tokens.push("cancelled");
    if (/===\s*["']gc["']/.test(line)) tokens.push("gc-error");
  }
  return tokens;
}

const BASE = ["fallback-gc", "cancelled", "gc-error"];

/** 失配时的行动指引错误消息（vitest expect 第二参数）。 */
const MISMATCH_GUIDE =
  "deriveClosedDisplay 三源同构契约失配。期望判定顺序 [closedReason??'gc' 兜底 → cancelled 优先（不参与 error）→ gc+error 次之 → 其余 done]。" +
  "改任一处必须同步其余两处：packages/shared/src/subagent.ts deriveClosedDisplay / extensions/universal/subagent-workflow/src/interface/bg-notify-render.ts renderRecordLines / extensions/universal/subagent-workflow/src/execution/notifier.ts buildLlmContent。" +
  "历史 bug：notifier gc+error 分支曾被 patch 分支遮蔽，gc 失败终态被 LLM 告知 completed。若你是有意重构此处判定，请同步更新本护栏测试（src/__tests__/derive-closed-display-parity.test.ts）的特征提取。";

describe("deriveClosedDisplay 三源同构契约（shared / bg-notify-render / notifier）", () => {
  it("三源文件均可读且锚点函数存在（缺文件/改名的 fail-loud 前置）", () => {
    for (const [key, p] of Object.entries(SOURCES)) {
      expect(() => readFileSync(p, "utf-8"), `源文件不可读：${p}`).not.toThrow();
    }
  });

  it("shared deriveClosedDisplay 判定顺序 = [兜底gc → cancelled → gc+error]", () => {
    const src = readFileSync(SOURCES.shared, "utf-8");
    const body = functionBody(src, /export function deriveClosedDisplay\s*\(/, "shared deriveClosedDisplay");
    expect(extractSignature(body), MISMATCH_GUIDE).toEqual(BASE);
  });

  it("notifier buildLlmContent 的 closed 分支判定顺序与 shared 同构", () => {
    const src = readFileSync(SOURCES.notifier, "utf-8");
    const body = functionBody(src, /export function buildLlmContent\s*\(/, "notifier buildLlmContent");
    // buildLlmContent 整个方法体内只有 closed case 一轮判定
    expect(extractSignature(body), MISMATCH_GUIDE).toEqual(BASE);
  });

  it("bg-notify-render renderRecordLines 两轮判定（verb 派发 + closed case 正文）均与 shared 同构", () => {
    const src = readFileSync(SOURCES.render, "utf-8");
    const body = functionBody(src, /function renderRecordLines\s*\(/, "bg-notify-render renderRecordLines");
    // renderRecordLines 内有两轮独立判定（标题 verb 派发 + closed case 正文分支），
    // 每轮都必须与 BASE 同构
    expect(extractSignature(body), MISMATCH_GUIDE).toEqual([...BASE, ...BASE]);
  });
});
