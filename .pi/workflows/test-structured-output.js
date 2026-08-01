// test-structured-output.js — structured-output 方案 A 真 LLM E2E 验收
//
// 用途：验证 workflow 模式下 PI_WORKFLOW_SCHEMA 权威校验真实生效。
// 这是 mock 测不到的层面：mock 只能验证「权威 schema 存在时 data 被正确校验」，
// 但测不到「真 LLM 面对新提示词（只需传 data）的实际行为」——
// LLM 是否还会按旧习惯传 schema 参数？传了之后 steer 提示能否引导修正？
// 最终 parsedOutput 是否符合权威 schema？
//
// 执行方式（在本仓根目录）：
//   workflow run test-structured-output
//
// 期望结果（方案 A 生效）：
//   - agent() 返回的 parsedOutput.score 是 number（权威 schema 要求）
//   - 若 LLM 尝试传字符串 score，权威 schema 会拒绝 → steer 重试 → 最终修正
//   - 若 LLM 按新提示只传 data（不传 schema），直接通过
//
// 失败信号（方案 A 未生效 / 提示词有问题）：
//   - parsedOutput.score 是 string → 权威校验没拦住（致命）
//   - workflow 报 error 且 retry 耗尽 → steer 提示词没能引导 LLM 修正
//
// 不入 CI：消耗 LLM 配额 + 结果非确定性。作为发版前手工验收脚本。

const meta = {
  name: "test-structured-output",
  description:
    "E2E 验收：structured-output 方案 A 权威 schema 校验。验证真 LLM 无法通过自报 schema 绕过格式约束。",
  phases: ["prompt", "verify"],
};

// 权威 schema：score 必须是 number。
// 故意设计成 LLM 容易「优化」的形态——很多模型倾向于把评分当字符串传（如 "85" 或 "good"）。
const scoreSchema = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 100, description: "0-100 的数字评分" },
    summary: { type: "string", description: "一句话评价" },
  },
  required: ["score", "summary"],
};

log("test-structured-output 开始：验证权威 schema 校验生效");

let outcome;

try {
  phase("prompt");
  // prompt 故意不强调「score 必须是数字」——测试权威 schema 是否能兜住 LLM 的类型偏移。
  // 如果方案 A 生效，即使 LLM 传了字符串 score，权威 schema 会拒绝并 steer 重试。
  const result = await agent({
    prompt:
      "评估以下代码变更的质量，给出一个 0-100 的评分和一句话评价：\n\n" +
      "```diff\n" +
      "+ function add(a, b) { return a + b; }\n" +
      "```\n\n" +
      "给出评分和评价。",
    schema: scoreSchema,
    description: "test-structured-output-agent",
  });

  phase("verify");
  // workflow 侧断言：parsedOutput（= agent 返回值）必须符合权威 schema。
  // agent() 返回的 result 已经是经过 structured-output 校验的 parsedOutput。
  const score = result?.score;
  const summary = result?.summary;

  if (typeof score !== "number") {
    // 致命：权威 schema 要求 number，但 parsedOutput 里是别的类型。
    // 方案 A 未生效（或 LLM 绕过了校验），或 agent() 返回的不是 parsedOutput。
    throw new Error(
      "FAIL: score 应为 number（权威 schema 要求），实际为 " + typeof score + ": " + JSON.stringify(score),
    );
  }
  if (typeof summary !== "string") {
    throw new Error("FAIL: summary 应为 string，实际为 " + typeof summary);
  }

  log("PASS: score=" + score + " (number), summary=" + summary);
  outcome = {
    status: "ok",
    message: "方案 A 权威校验生效：parsedOutput 符合权威 schema（score 是 number）",
    parsedOutput: { score, summary },
  };
} catch (err) {
  outcome = {
    status: "error",
    error: err && err.message ? err.message : String(err),
    message: "方案 A 验收失败：parsedOutput 不符合权威 schema 或 steer 重试耗尽",
  };
}

return outcome;
