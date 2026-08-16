/**
 * providers secrets 路径推导单元测试（TC3 + TC4）。
 *
 * 验证 kimi-coding / opencode-go / zhipu 三个 provider 的 secrets 路径常量
 * 从 pi 的 getAgentDir() 派生（支持 PI_CODING_AGENT_DIR 实例隔离）。
 *
 * 测试策略（design-review RK1）：不 vi.mock getAgentDir（mock 工厂跨
 * resetModules 持久，与验证真实 env 读取冲突）。改用 stubEnv + resetModules
 * + dynamic import，让 provider 模块在隔离 env 下重新求值顶层路径常量。
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run src/__tests__/providers-path.test.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("providers secrets paths (getAgentDir derivation)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("TC3: kimi SECRETS_DIR and KIMI_API_KEY_PATH derive from PI_CODING_AGENT_DIR", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/mock/pi/agent");
    const kimi = await import("../providers/kimi-coding.js");
    expect(kimi.SECRETS_DIR).toBe("/mock/pi/agent/secrets");
    expect(kimi.KIMI_API_KEY_PATH).toBe(
      "/mock/pi/agent/secrets/kimi-coding-api-key.txt",
    );
  });

  it("TC3: opencode SECRETS_DIR and OPENCODE_COOKIE_PATH derive from PI_CODING_AGENT_DIR", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/mock/pi/agent");
    const opencode = await import("../providers/opencode-go.js");
    expect(opencode.SECRETS_DIR).toBe("/mock/pi/agent/secrets");
    expect(opencode.OPENCODE_COOKIE_PATH).toBe(
      "/mock/pi/agent/secrets/opencode-cookie.txt",
    );
  });

  it("TC3: zhipu ZHIPU_TOKEN_PATHS[0] derives from getAgentDir parent; [1] keeps homedir (.claude)", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/mock/pi/agent");
    const zhipu = await import("../providers/zhipu.js");
    // [0] getAgentDir() = /mock/pi/agent，上级 = /mock/pi
    expect(zhipu.ZHIPU_TOKEN_PATHS[0]).toBe("/mock/pi/.zhipu_auth_token");
    // [1] Claude 目录非 pi 目录，实例隔离不适用，保留 homedir 推导
    expect(zhipu.ZHIPU_TOKEN_PATHS[1]).toBe(
      join(homedir(), ".claude", ".zhipu_auth_token"),
    );
  });

  it("TC4: all providers isolate to custom PI_CODING_AGENT_DIR", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/test-agent-dir");
    const [kimi, opencode, zhipu] = await Promise.all([
      import("../providers/kimi-coding.js"),
      import("../providers/opencode-go.js"),
      import("../providers/zhipu.js"),
    ]);
    expect(kimi.SECRETS_DIR.startsWith("/tmp/test-agent-dir")).toBe(true);
    expect(opencode.SECRETS_DIR.startsWith("/tmp/test-agent-dir")).toBe(true);
    // zhipu [0] 派生自 getAgentDir 上级：/tmp/test-agent-dir/.. 被 resolve 规范化为 /tmp
    expect(zhipu.ZHIPU_TOKEN_PATHS[0]).toBe("/tmp/.zhipu_auth_token");
  });
});
