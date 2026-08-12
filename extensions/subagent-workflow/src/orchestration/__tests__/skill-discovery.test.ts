/**
 * resolveSkillPath 测试（S-6：getAgentDir 迁移后全局/npm 两级候选路径断言兜底）。
 * 候选顺序：项目级 .agents/skills → agentDir/skills → agentDir/npm/node_modules 下各包 skills。
 * 注意：getNpmSkillCandidates 有模块级缓存（key = npmSkillsDir），各用例用不同 agentDir 隔离缓存键。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSkillPath } from "../skill-discovery";

const mockedFs = vi.mocked(fs);
const mockedGetAgentDir = vi.mocked(getAgentDir);

beforeEach(() => {
  mockedFs.existsSync.mockReset();
  mockedFs.readdirSync.mockReset();
  mockedGetAgentDir.mockReturnValue("/mock/agent-dir");
  // 默认：任何路径都不存在、npm 目录无包
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readdirSync.mockReturnValue([]);
});

describe("resolveSkillPath", () => {
  it("项目级 .agents/skills 优先命中（返回 cwd 相对路径）", () => {
    const projectPath = path.resolve(process.cwd(), ".agents/skills", "foo");
    mockedFs.existsSync.mockImplementation((p) => p === projectPath);

    expect(resolveSkillPath("foo")).toBe(projectPath);
  });

  it("agentDir 全局 skills 兜底（路径含 getAgentDir 返回值）", () => {
    const agentPath = path.join("/mock/agent-dir", "skills", "foo");
    mockedFs.existsSync.mockImplementation((p) => p === agentPath);

    expect(resolveSkillPath("foo")).toBe(agentPath);
  });

  it("npm 候选命中：readdirSync 枚举包目录，skills/<name> 存在则返回 agentDir 派生路径", () => {
    // 独立 agentDir 避免命中前序用例已缓存的空 npm 候选（getNpmSkillCandidates 按 npmSkillsDir 缓存）
    mockedGetAgentDir.mockReturnValue("/mock/agent-dir-npm");
    const npmSkillsDir = path.join("/mock/agent-dir-npm", "npm/node_modules");
    const npmHit = path.join(npmSkillsDir, "@zhushanwen/pi-x", "skills", "foo");
    mockedFs.readdirSync.mockImplementation((dir) =>
      dir === npmSkillsDir ? ["@zhushanwen/pi-x"] : [],
    );
    mockedFs.existsSync.mockImplementation((p) => p === npmHit);

    expect(resolveSkillPath("foo")).toBe(npmHit);
  });

  it("npm 候选路径构造含 agentDir（getAgentDir 迁移后的候选断言，防回退硬编码）", () => {
    mockedGetAgentDir.mockReturnValue("/mock/agent-dir-2");
    const npmSkillsDir = path.join("/mock/agent-dir-2", "npm/node_modules");
    const probed: string[] = [];
    mockedFs.existsSync.mockImplementation((p) => {
      probed.push(p as string);
      return false;
    });
    mockedFs.readdirSync.mockImplementation((dir) =>
      dir === npmSkillsDir ? ["pkg-a", "pkg-b"] : [],
    );

    expect(resolveSkillPath("missing")).toBeUndefined();
    // 探测过的候选必须包含 agentDir 派生的 npm 路径
    expect(probed).toContain(path.join(npmSkillsDir, "pkg-a", "skills", "missing"));
    expect(probed).toContain(path.join(npmSkillsDir, "pkg-b", "skills", "missing"));
  });

  it("全部 miss 返回 undefined（含 npm 目录不存在时 readdirSync 抛错兜底）", () => {
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockedFs.existsSync.mockReturnValue(false);

    expect(resolveSkillPath("nope")).toBeUndefined();
  });
});
