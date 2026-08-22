/**
 * session-runner message_update 分流测试。
 *
 * 核心回归点：toolcall_delta（工具入参 JSON 增量）不得被当成 text_delta
 * forward 到 subagent overlay 的 streaming content——否则 assistant 正文会
 * 原样流出 {"path":"..."}{"command":"..."} 工具参数 JSON 串，表现为对话末尾
 * JSON 与 text 混杂、无 ICON+title 工具卡片前缀（用户实际报告的现象）。
 *
 * 根因：pi-ai AssistantMessageEvent 的 type 集合含 text_delta / thinking_delta /
 * toolcall_delta / signature_delta 等（见 @earendil-works/pi-ai types.d.ts）。
 * 旧实现 `ame?.delta !== undefined` 反向排除（只拦 thinking_delta），toolcall_delta
 * 因带 delta 字段被误判为 text_delta。正向判定（只放行 text_delta）根治。
 */
import { describe, it, expect } from "vitest";
import { mapAssistantMessageDelta } from "../execution/session-runner.js";

describe("mapAssistantMessageDelta: assistantMessageEvent → streaming 事件分流", () => {
  it("text_delta → forward 为 text_delta", () => {
    expect(mapAssistantMessageDelta({ type: "text_delta", delta: "hello" })).toEqual({
      type: "text_delta",
      delta: "hello",
    });
  });

  it("thinking_delta → forward 为 thinking_delta（走独立通道，不进 text stream）", () => {
    expect(mapAssistantMessageDelta({ type: "thinking_delta", delta: "思考" })).toEqual({
      type: "thinking_delta",
      delta: "思考",
    });
  });

  it("thinking_delta 缺 delta 兜底空串（不抛错，与旧实现行为一致）", () => {
    expect(mapAssistantMessageDelta({ type: "thinking_delta" })).toEqual({
      type: "thinking_delta",
      delta: "",
    });
  });

  it("toolcall_delta → null（工具入参 JSON 增量绝不混入 text）", () => {
    // 核心回归：旧实现 ame?.delta !== undefined 会把 toolcall_delta 当 text_delta
    expect(mapAssistantMessageDelta({ type: "toolcall_delta", delta: '{"path":"/x"}' })).toBeNull();
  });

  it("toolcall_delta 的部分 JSON 片段也不混入（流式累积的中间态）", () => {
    expect(mapAssistantMessageDelta({ type: "toolcall_delta", delta: '{"path":"' })).toBeNull();
    expect(mapAssistantMessageDelta({ type: "toolcall_delta", delta: "/Users/foo/bar" })).toBeNull();
    expect(mapAssistantMessageDelta({ type: "toolcall_delta", delta: '"}}' })).toBeNull();
  });

  it("其他带 delta 的 type（signature_delta 等未来扩展）也不混入 text", () => {
    expect(mapAssistantMessageDelta({ type: "signature_delta", delta: "sig-xyz" })).toBeNull();
  });

  it("非 delta 事件（start/end/done 等）返回 null", () => {
    expect(mapAssistantMessageDelta({ type: "text_start" })).toBeNull();
    expect(mapAssistantMessageDelta({ type: "text_end" })).toBeNull();
    expect(mapAssistantMessageDelta({ type: "toolcall_start" })).toBeNull();
    expect(mapAssistantMessageDelta({ type: "toolcall_end" })).toBeNull();
    expect(mapAssistantMessageDelta({ type: "done" })).toBeNull();
  });

  it("缺 type 或缺 delta 的异常输入返回 null（不抛错）", () => {
    expect(mapAssistantMessageDelta({})).toBeNull();
    // text_delta 缺 delta → null（无法 forward 空 delta 增量）
    expect(mapAssistantMessageDelta({ type: "text_delta" })).toBeNull();
    // 有 delta 无 type → null（未知来源，不放行）
    expect(mapAssistantMessageDelta({ delta: "x" })).toBeNull();
  });
});
