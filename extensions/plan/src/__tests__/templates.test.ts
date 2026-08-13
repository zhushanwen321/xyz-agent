import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { getBuiltinTemplateDir, listTemplates, loadTemplate } from "../templates.js";

describe("Template system", () => {
  it("listTemplates returns builtin templates", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(5);
    const names = templates.map((t) => t.name);
    expect(names).toContain("feature-plan");
    expect(names).toContain("bugfix-plan");
    expect(names).toContain("refactor-plan");
    expect(names).toContain("research-plan");
    expect(names).toContain("implementation-plan");
  });

  it("loadTemplate returns content for existing builtin template", () => {
    const content = loadTemplate("feature-plan");
    expect(content).not.toBeNull();
    expect(content).toContain("## ");
  });

  it("loadTemplate returns null for non-existent template", () => {
    const content = loadTemplate("non-existent-template");
    expect(content).toBeNull();
  });

  it("getBuiltinTemplateDir returns valid path", () => {
    const dir = getBuiltinTemplateDir();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("TC8: PI_CODING_AGENT_DIR 隔离目录下扫到全局模板（getAgentDir 派生，不依赖 ~/.pi/agent）", () => {
    const origEnv = process.env.PI_CODING_AGENT_DIR;
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "plan-tpl-"));
    try {
      process.env.PI_CODING_AGENT_DIR = isolated;
      fs.mkdirSync(path.join(isolated, "plan-templates"), { recursive: true });
      fs.writeFileSync(path.join(isolated, "plan-templates", "isolated-template.md"), "# t");

      const templates = listTemplates();
      const names = templates.map((t) => t.name);
      expect(names).toContain("isolated-template");
      // 隔离目录模板 source 为 global（getAgentDir 直接返回 PI_CODING_AGENT_DIR 值，无 .pi/agent 嵌套）
      const tpl = templates.find((t) => t.name === "isolated-template");
      expect(tpl?.source).toBe("global");
      expect(tpl?.path.startsWith(isolated)).toBe(true);
      // 仍能扫到 builtin 模板（最低优先级）
      expect(names).toContain("feature-plan");
    } finally {
      if (origEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = origEnv;
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});
