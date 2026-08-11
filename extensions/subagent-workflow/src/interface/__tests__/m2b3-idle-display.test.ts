// src/interface/__tests__/m2b3-idle-display.test.ts
//
// M2-B3 idle 态展示：format.statusGlyph + gui-mappers.mapRunStatus/mapRunIcon 的 idle case。
//
// idle（对话模式轮次完成、等待续聊）必须有独立的展示语义（waiting），不能落入
// running（误显进行中）或 done（误显已完成）。决策 10 细则 3 四态收敛。

import { describe, expect, it } from "vitest";

import { statusGlyph } from "../format.ts";
import { mapRunIcon, mapRunStatus } from "../gui-mappers.ts";

describe("M2-B3 idle 展示（waiting 语义）", () => {
  it("statusGlyph(idle) → 非空图标 + 非 running/done 色（与 running spinner、done ✓ 区分）", () => {
    const g = statusGlyph("idle");
    expect(g.icon).toBeTruthy(); // 暂停图标 ⏸
    expect(g.color).not.toBe("accent"); // 非 running
    expect(g.color).not.toBe("success"); // 非 done
  });

  it("mapRunStatus(idle) → running（活跃态，配 pause icon 表达 waiting）", () => {
    expect(mapRunStatus("idle")).toBe("running");
  });

  it("mapRunIcon(idle) → pause（与 paused 同 icon，表达可恢复的等待）", () => {
    expect(mapRunIcon("idle")).toBe("pause");
  });
});
