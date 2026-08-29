// Medium batch 2 — M10（壳侧 interface 守卫段）
//
// [u1-move 拆分] 原 robustness-medium-batch2.test.ts 的 M10 describe：读壳侧
// interface/helpers.ts 源文本做锚定断言。batch2 其余用例（M6/M9/M12，读 core 源文件）
// 随主体迁入 @zhushanwen/subagent-core；M10 被锚定的 boundedPrettySerialize 是壳件
// （interface/helpers.ts），故随壳留守本包。
//
// M10: notifyDone serialization circular-ref safe (IF13: boundedPrettySerialize + guard/fallback)

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

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
