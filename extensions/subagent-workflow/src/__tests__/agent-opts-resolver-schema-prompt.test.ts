// agent-opts-resolver schema prompt wording lock (suggestion #4).
//
// resolveAgentOpts writes a temp system-prompt file when opts.schema is provided.
// The wording of that file was changed to instruct the LLM to pass ONLY `data`
// and NOT a `schema` parameter (because the schema is enforced by the system).
// Without an assertion on this wording, a regression back to the old
// `schema = ${schemaJson}, data = <your result>` phrasing would not be caught.
//
// This test calls resolveAgentOpts with a real (empty) AgentRegistry + a tmp
// session dir, then reads back the written systemPromptFiles content.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentRegistry } from "../execution/agent-registry.ts";
import type { AgentCallOpts } from "../orchestration/models/types.ts";
import { resolveAgentOpts } from "../orchestration/agent-opts-resolver.ts";

const tmpDirs: string[] = [];

function makeTmpSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-opts-resolver-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Empty registry: no agent is resolved because opts.agent is undefined. */
function emptyRegistry(): AgentRegistry {
  return new AgentRegistry({
    workspaceRoot: makeTmpSessionDir(),
    agentDir: path.join(makeTmpSessionDir(), ".fake-agent"),
  });
}

describe("resolveAgentOpts schema prompt wording (suggestion #4)", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a temp system-prompt file when opts.schema is provided", () => {
    const sessionDir = makeTmpSessionDir();
    const opts: AgentCallOpts = { prompt: "do the thing", schema: { type: "object" } };
    const result = resolveAgentOpts(opts, emptyRegistry(), sessionDir, new Set());

    expect(result.error).toBeUndefined();
    expect(result.opts.systemPromptFiles).toBeDefined();
    expect(result.opts.systemPromptFiles!.length).toBe(1);
    expect(fs.existsSync(result.opts.systemPromptFiles![0])).toBe(true);
  });

  it("schema prompt instructs the LLM to pass ONLY the `data` parameter", () => {
    const sessionDir = makeTmpSessionDir();
    const opts: AgentCallOpts = { prompt: "x", schema: { type: "object" } };
    const result = resolveAgentOpts(opts, emptyRegistry(), sessionDir, new Set());

    const content = fs.readFileSync(result.opts.systemPromptFiles![0], "utf-8");
    expect(content).toContain("ONLY the `data` parameter");
  });

  it("schema prompt instructs the LLM NOT to pass a `schema` parameter", () => {
    const sessionDir = makeTmpSessionDir();
    const opts: AgentCallOpts = { prompt: "x", schema: { type: "object" } };
    const result = resolveAgentOpts(opts, emptyRegistry(), sessionDir, new Set());

    const content = fs.readFileSync(result.opts.systemPromptFiles![0], "utf-8");
    expect(content).toContain("do NOT pass a `schema` parameter");
  });

  it("schema prompt states the schema is enforced by the system", () => {
    const sessionDir = makeTmpSessionDir();
    const opts: AgentCallOpts = { prompt: "x", schema: { type: "object" } };
    const result = resolveAgentOpts(opts, emptyRegistry(), sessionDir, new Set());

    const content = fs.readFileSync(result.opts.systemPromptFiles![0], "utf-8");
    expect(content).toContain("schema is enforced by the system");
  });

  it("sets schemaEnv from the provided schema (PI_WORKFLOW_SCHEMA contract)", () => {
    const sessionDir = makeTmpSessionDir();
    const schema: Record<string, unknown> = { type: "object", properties: { n: { type: "number" } } };
    const opts: AgentCallOpts = { prompt: "x", schema };
    const result = resolveAgentOpts(opts, emptyRegistry(), sessionDir, new Set());

    expect(result.opts.schemaEnv).toBe(JSON.stringify(schema));
  });

  it("no systemPromptFiles and no schemaEnv when opts.schema is absent", () => {
    const sessionDir = makeTmpSessionDir();
    const opts: AgentCallOpts = { prompt: "x" };
    const result = resolveAgentOpts(opts, emptyRegistry(), sessionDir, new Set());

    expect(result.error).toBeUndefined();
    expect(result.opts.systemPromptFiles).toBeUndefined();
    expect(result.opts.schemaEnv).toBeUndefined();
  });
});
