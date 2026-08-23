// Medium batch 2 robustness fixes verification
//
// M6: worktree cleanup not gated by patchOk (decoupled)
// M9: store.save not fire-and-forget (has .catch)
// M10: notifyDone serialization circular-ref safe (IF13: boundedPrettySerialize + guard/fallback)
// M12: budget-done transition and onRunDone in separate try blocks

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// ── M6: worktree cleanup decoupled from patchOk ──────────────

describe("M6: worktree cleanup not gated by patchOk", () => {
  const src = readSrc(join("src", "execution", "subagent-service.ts"));

  it("worktree cleanup condition does not reference patchOk", () => {
    // 找到 worktree cleanup 调用前的条件判断
    const cleanupMatch = src.match(/if\s*\([^)]*worktreeHandle[^)]*\)\s*\{[\s\S]*?worktreeManager\.cleanup/);
    expect(cleanupMatch).toBeTruthy();
    const condition = cleanupMatch![0];
    // 条件中不应包含 patchOk（解耦后 worktree cleanup 只依赖 worktreeHandle 存在）
    expect(condition).not.toContain("patchOk");
  });
});

// ── M9: store.save has .catch (not fire-and-forget) ──────────

describe("M9: store.save not fire-and-forget in dispatchAgentCall", () => {
  const src = readSrc(join("src", "orchestration", "error-recovery.ts"));

  it("no bare `void deps.store.save` without .catch", () => {
    // 查找所有 void deps.store.save(run) 的出现
    const bareSave = /void\s+deps\.store\.save\(run\)\s*;(?!\s*\.catch)/g;
    const matches = [...src.matchAll(bareSave)];
    // 修复后不应有裸 void store.save（应有 .catch 或 await）
    expect(matches.length).toBe(0);
  });
});

// ── M10: notifyDone 序列化有循环引用保护（IF13 后形态）─────────
//
// IF13（#19）：notifyDone 的 scriptResult 序列化从「整体 try { JSON.stringify(x, null, 2) }
// catch { String(x) }」重构为 boundedPrettySerialize（只生成 ≤8000 前缀）。循环引用
// 保护语义不变，锚定点迁移：(1) notifyDone 调用 boundedPrettySerialize(scriptResult)；
// (2) 实现内祖先 Set 守卫（命中 throw）+ 顶层 try-catch 整体回退 String(value)。
// 行为级等价（回退输出与旧实现逐字节一致）由 helpers-bounded-serialize.test.ts 锚定。

describe("M10: notifyDone serialization has circular ref protection", () => {
  const src = readSrc(join("src", "interface", "helpers.ts"));

  it("notifyDone serializes scriptResult via boundedPrettySerialize", () => {
    // 调用点：scriptResult 不再直接 JSON.stringify，走 bounded 序列化
    const callMatch = src.match(/boundedPrettySerialize\(run\.state\.scriptResult,\s*MAX_RESULT_LENGTH\)/);
    expect(callMatch).toBeTruthy();
  });

  it("boundedPrettySerialize has ancestor-set guard plus whole-value fallback try-catch", () => {
    // 实现：函数体内含祖先 Set 循环守卫（命中 throw）与顶层 try-catch（整体回退）
    const fnMatch = src.match(/function boundedPrettySerialize\([\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/ancestors\.has\(obj\)/);
    expect(fnBody).toMatch(/throw new TypeError\("circular reference"\)/);
    expect(fnBody).toMatch(/catch\s*\{/);
    expect(fnBody).toMatch(/String\(value\)/);
  });
});

// ── M12: budget-done has separate try blocks ─────────────────

describe("M12: budget-done separates transition and onRunDone error handling", () => {
  const src = readSrc(join("src", "orchestration", "error-recovery.ts"));

  it("budget-done block has more than one catch (transition vs onRunDone separated)", () => {
    // 找到 budget isExceeded 块
    const budgetMatch = src.match(/budget\.isExceeded\(\)[\s\S]*?\}\s*\}\s*\)/);
    expect(budgetMatch).toBeTruthy();
    const budgetBlock = budgetMatch![0];
    // 修复后应有多个 catch（至少 2 个：一个给 transition，一个给 onRunDone/emit）
    const catchCount = (budgetBlock.match(/\bcatch\b/g) || []).length;
    expect(catchCount).toBeGreaterThanOrEqual(2);
  });
});
