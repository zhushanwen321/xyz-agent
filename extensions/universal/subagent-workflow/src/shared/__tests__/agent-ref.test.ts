/**
 * displayAgentName 测试：agent ref 绝对路径 → UI 显示短名（basename 去 .md）。
 *
 * 数据层不变式（displayAgentName 只服务显示出口）：非路径值原样返回。
 */
import { describe, expect, it } from "vitest";

import { displayAgentName } from "../agent-ref.ts";

describe("displayAgentName", () => {
  it("mac/linux 绝对路径取 basename 并去 .md", () => {
    expect(displayAgentName("/Users/x/.agents/agents/worker.md")).toBe("worker");
    expect(displayAgentName("/home/u/project/.agents/agents/reviewer.md")).toBe("reviewer");
  });

  it("windows 路径（反斜杠分隔）同样取短名", () => {
    expect(displayAgentName("C:\\Users\\x\\agents\\worker.md")).toBe("worker");
    expect(displayAgentName("C:/Users/x/agents/worker.md")).toBe("worker");
  });

  it("非路径 agent 名原样返回（DEFAULT_AGENT_NAME 等）", () => {
    expect(displayAgentName("general-purpose")).toBe("general-purpose");
    expect(displayAgentName("worker")).toBe("worker");
  });

  it("无 .md 扩展名的 basename 原样返回（不去别的后缀）", () => {
    expect(displayAgentName("/a/b/worker")).toBe("worker");
    expect(displayAgentName("/a/b/agent.spec.ts")).toBe("agent.spec.ts");
  });

  it("裸文件名（无目录）也去 .md", () => {
    expect(displayAgentName("worker.md")).toBe("worker");
  });
});
