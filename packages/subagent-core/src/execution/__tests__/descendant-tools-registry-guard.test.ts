// src/execution/__tests__/descendant-tools-registry-guard.test.ts
//
// [Gate B P3 勘误] DESCENDANT_CAPABLE_TOOLS ↔ 真实注册面 / 记账面 联动守卫。
//
// 背景（Gate B 批次 1 P3 探针实测）：旧清单 ["subagents","workflow","bash"] 与真实注册面
// 漂移——注册名是单数 `subagent`（subagent-tool.ts:148），且漏列 `workflow-script`
// （tool-workflow-script.ts:174）。漂移后果：tools 白名单含 "subagent" 的合法配置被误判
// descendantCapable=false → 零判定快路径杀层主 → spawn 后代后层主被立即杀（G2 回归形态）。
// 既有守卫（agent-end-descendant-fast-path 清单锚定用例）只断言清单自身内容，无法发现
// 「清单 ↔ 注册面」漂移——本文件补上联动半边。
//
// 守卫机制（注册名是 extensions 域的运行时字符串，subagent-core 不能包导入——依赖方向
// extensions → subagent-core——故从 monorepo 源码静态提取）：
//   ① 注册面：subagent-workflow 三个工具文件的静态 `name: "xxx"` 注册行（4 空格缩进 +
//      字符串字面量 + 行尾逗号——registerTool 工厂形态），每个文件恰好提取 1 个；
//   ② 记账面：pending:register emit 的 `type: "xxx"` 值（subagent-core notify-host.ts 的
//      subagent spawn + base-tool-enhance notify.ts 的 bash 后台）；
//   ③ 双向核对：清单 = 注册面 ∪ 记账面 type（双向——清单漏列会误杀，冗余项失去依据也应
//      清理，防止清单腐化成无人认领的死字符串）。
//
// 文件缺失 / 格式漂移 / 数量不符 → 红并给可操作指引（同步义务见
// session-runner.ts DESCENDANT_CAPABLE_TOOLS 注释）。
// 本文件零 mock：真实 fs 只读 extensions / 本包源码，不触碰数据目录。

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { DESCENDANT_CAPABLE_TOOLS } from "../engine/engines/pi/session-runner.ts";

/** 从测试文件位置向上探测 repo root（pnpm-workspace.yaml 锚），不依赖 vitest cwd。 */
function repoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(
    "repo root not found (no pnpm-workspace.yaml upward) — registry guard cannot locate extensions sources",
  );
}

const ROOT = repoRoot();

/** 注册面权威源：subagent-workflow 三个 spawn 类工具文件（相对 repo root）。 */
const REGISTRY_SOURCES = [
  "extensions/universal/subagent-workflow/src/interface/subagent-tool.ts",
  "extensions/universal/subagent-workflow/src/interface/tool-workflow.ts",
  "extensions/universal/subagent-workflow/src/interface/tool-workflow-script.ts",
];

/** 记账面权威源：pending:register emit 的 type 值来源（相对 repo root）。 */
const EMIT_SOURCES = [
  { file: "packages/subagent-core/src/execution/notify-host.ts", expectTypeOf: "subagent" },
  { file: "extensions/universal/base-tool-enhance/src/background/notify.ts", expectTypeOf: "bash" },
];

/** 静态注册行提取：`    name: "xxx",`（4 空格缩进 + 字符串字面量 + 行尾逗号）。 */
const REGISTER_LINE = /^\s{4}name:\s*"([a-z][a-z0-9-]*)",\s*$/gm;

/** pending:register emit 行的 type 提取：`type: "xxx"`（emit 对象字面量内）。 */
const EMIT_TYPE = /emit\(\s*"pending:register"[\s\S]{0,120}?type:\s*"([a-z][a-z0-9-]*)"/g;

function extractMatches(source: string, re: RegExp, what: string, file: string): string[] {
  const found = [...source.matchAll(re)].map((m) => m[1]);
  if (found.length === 0) {
    throw new Error(
      `${what}: no match extracted from ${file} — registration shape changed? ` +
        `Update DESCENDANT_CAPABLE_TOOLS sync guard (session-runner.ts) and this file.`,
    );
  }
  return found;
}

describe("[Gate B P3] DESCENDANT_CAPABLE_TOOLS ↔ 注册面/记账面 联动守卫", () => {
  it("注册面：三个 spawn 类工具文件各提取 1 个注册名，全部在清单内", () => {
    for (const rel of REGISTRY_SOURCES) {
      const abs = path.join(ROOT, rel);
      expect(fs.existsSync(abs), `registry source missing: ${rel} — 工具注册面搬家须同步本守卫与 DESCENDANT_CAPABLE_TOOLS`).toBe(true);
      const source = fs.readFileSync(abs, "utf8");
      const names = extractMatches(source, REGISTER_LINE, "registerTool name", rel);
      expect(
        names,
        `${rel} 应恰好含 1 个静态注册名（提取到 ${names.length} 个）——文件结构变化须人工核对后同步守卫`,
      ).toHaveLength(1);
      expect(
        DESCENDANT_CAPABLE_TOOLS,
        `${rel} 注册的工具 "${names[0]}" 不在 DESCENDANT_CAPABLE_TOOLS —— 漏登记会把合法 keep-alive 翻转为零判定误杀`,
      ).toContain(names[0]);
    }
  });

  it("记账面：pending:register emit 的 type 值全部在清单内", () => {
    for (const { file, expectTypeOf } of EMIT_SOURCES) {
      const abs = path.join(ROOT, file);
      expect(fs.existsSync(abs), `emit source missing: ${file}`).toBe(true);
      const source = fs.readFileSync(abs, "utf8");
      const types = extractMatches(source, EMIT_TYPE, "pending:register emit type", file);
      expect(types).toContain(expectTypeOf);
      for (const t of types) {
        expect(
          DESCENDANT_CAPABLE_TOOLS,
          `pending:register type "${t}" (${file}) 不在 DESCENDANT_CAPABLE_TOOLS —— 后台记账面漏登记会误杀合法等待`,
        ).toContain(t);
      }
    }
  });

  it("双向核对：清单无冗余项——每个清单值都有注册面或记账面依据（防清单腐化成死字符串）", () => {
    const derived = new Set<string>();
    for (const rel of REGISTRY_SOURCES) {
      for (const name of extractMatches(fs.readFileSync(path.join(ROOT, rel), "utf8"), REGISTER_LINE, "registerTool name", rel)) {
        derived.add(name);
      }
    }
    for (const { file } of EMIT_SOURCES) {
      for (const t of extractMatches(fs.readFileSync(path.join(ROOT, file), "utf8"), EMIT_TYPE, "pending:register emit type", file)) {
        derived.add(t);
      }
    }
    const unexpected = [...DESCENDANT_CAPABLE_TOOLS].filter((t) => !derived.has(t));
    expect(
      unexpected,
      `清单项 ${JSON.stringify(unexpected)} 在注册面/记账面均无依据 —— 删除依据后应同步清理清单，防止判据失真`,
    ).toEqual([]);
  });
});
