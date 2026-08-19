# W6 验收基线：治本（clone 更新 + 断言规则 + 探针 + 观察项）

## 交付物
1. clone 更新：`git -C ~/Code/git-fork/pi-mono-workspace/main pull --ff-only`（更新后记录新 HEAD 与 package version；若领先 0.84.1 属预期）。
2. AGENTS.md 修订（根目录 pi 段）：pi 源码查阅规则改为「**pi 语义断言的权威源 = node_modules 实装版（断言前 `npm ls @earendil-works/pi-coding-agent` 核对版本），clone 仅作可读 TS 参照且须先核对版本**」；ADR-0063 的查阅源声明同步修订（只加不删风格加修订注）。
3. A-10 探针（agent_end willRetry 并发竞争）：真实 pi 复现 auto-retry 窗口 + 用户抢发消息的交错（可行则修 isGenerating 复位时序或 renderer 禁发；不可复现则登记观察 + 防御建议——如实报告）。
4. A-11 探针（execPath 定位 0.84.1 binary 重验）：探针脚本验证 rpc-client.ts:210 的 process.execPath 定位链在 0.84.1 打包 binary 下成立与否，结论回写注释。
5. 观察项登记 docs/troubleshooting.md：F8（SIGINT re-raise 窗口）、jsonl-run-store 首写可见性（state 文件兜底）、pi-ai/compat 上游废弃时间炸弹——各一条（触发条件 + 处置建议）。

## 验收条款
- C1：clone HEAD 更新且记录版本；AGENTS.md/ADR-0063 新规则落文
- C2：A-10/A-11 探针有实测记录（命令 + 输出摘要），结论三态之一明确（已修/不可复现登记/已验证成立）
- C3：troubleshooting.md 三条观察项落档
- C4：docs 改动不破坏 `pnpm run lint`

## 边界
只许改：AGENTS.md、docs/adr/0063、docs/troubleshooting.md、探针涉及的代码行（A-10 修复若可行：runtime event-interpreter 或 renderer 禁发——先探针后改，改动最小化）。禁 git 写（clone 仓外的 pull 允许，本仓禁）。
