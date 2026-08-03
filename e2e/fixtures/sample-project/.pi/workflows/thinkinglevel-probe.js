// thinkinglevel-probe.js — E2E 探针 workflow：agent() 传 thinkingLevel=high 做最小任务。
//
// 用途：e2e/workflow-thinkinglevel-real.spec.ts 的 TC1/TC2/TC3 用它验证
// agent() 的 thinkingLevel 参数端到端真实生效。断言表面全部是 pi 自己写的
// 文件（零 xyz-agent 代码介入）：
//   - workflow state JSONL 的 calls[0].opts（扩展持久化的脚本请求值，TC1）
//   - 子进程 session JSONL 的 thinking_level_change entry（pi 真实生效值，TC2）
//
// 注意：本文件是 repo 内 fixture 资产。实际运行发现路径是 user 级
// <dataDir>/pi/agent/workflows/（makePresetDataDir 复制到此），因 sample-project
// 的祖先 .bare 导致 findWorkspaceRoot 跳转到 xyz-agent-workspace/，project 级
// .pi/workflows/ 不会被 workflow registry 扫描（详见 spec 文件注释）。
//
// ⚠️ lintScript 约束（本脚本已遵守）：
//   - 含 agent() 入口
//   - 禁止 bare IIFE（用 top-level await）
//   - 禁止用 result 作变量名（用 outcome）

phase("probe");

const outcome = await agent({
  prompt: "Reply with exactly: PROBE-OK",
  model: "deepseek-router/ds-pro",
  thinkingLevel: "high",
  description: "thinkinglevel-probe",
});

return outcome;
