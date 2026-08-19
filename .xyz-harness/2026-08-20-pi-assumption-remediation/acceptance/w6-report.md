# W6 验收报告（verifier 对抗式验收）

- 基线：commit `899157062` 的 `acceptance/w6-acceptance.md`
- 日期：2026-08-20 · verifier 独立验收（禁 git 写；探针已清理）
- **总结论：PASS**（4/4 验收条款满足；0 阻塞项；4 条 observation 不阻塞）

## 1. 防篡改 + 越界扫描 — 通过

- harness 基线文件（`w6-acceptance.md` / `ledger.md` / 各 wave report）零改动；无未授权 untracked 进 `.xyz-harness/`。
- 工作区改动 = W6 自报 5 文件（AGENTS.md、docs/adr/0063、docs/troubleshooting.md、pi-protocol.ts、rpc-client.ts）+ 豁免域（.githooks=W5、subagent-workflow=W4b、packages/core=W5、chat-app）+ W4b 的 untracked 测试文件。无第 6 个 W6 范围内文件，无越界。
- diff 量级：5 文件 +42/-1，与「注释 + 文档」交付形态一致，无夹带逻辑改动。

## 2. pi-mono clone 更新核验 — 通过

- HEAD = `496185f6e`（package version **0.84.2**，领先实装 0.84.1，符合基线「领先属预期」）；`git status` 干净。
- reflog 证实 `pull --ff-only: Fast-forward`（`647c5554b`→`496185f6e`），且 `647c5554b` 的 package version 恰为审计 C #6 记录的 0.80.3——更新前状态与审计一致，无先行偷改。
- 另两个失效 worktree 指针（`fix-compaction-crash-assistant@13bba654a`、`fix-setactivetools-undefined@f237852a8`）仍 prunable 挂在列表上，未 prune、未改动——属实。

## 3. A-10「已验证无竞争」独立复核 — 结论成立（最高优先项）

**复核深度：dist 源码逐行推演 + 0.80.3 语义 git 考证 + 半程真实探针实测。未实测真正的 auto-retry 退避窗口**（需 500 provider + retry settings 覆盖，按任务允许以源码推演 + 交叉核对代替；如实注明）。

### 3.1 dist 源码链（node_modules 0.84.1，npm ls 核对）

| 断言 | 锚点（实装 dist） | 核验 |
|---|---|---|
| isStreaming = `_isAgentRunActive` | agent-session.js:588-589 getter | 属实 |
| 仅 `_runAgentPrompt` finally 的 `_emitAgentSettled` 复位 | 744-757（try 内含 retry while 循环 748-750）→ 327-328 复位 | 属实 |
| retry 全程 isStreaming=true | `_prepareRetry`（2121-2166）是 while 循环内 await，退避 sleep 期间仍处 try 块，`_isAgentRunActive` 未复位 | 属实 |
| 窗口内新 prompt 被 pi 拒 | 831-833：isStreaming 且无 streamingBehavior → throw `"Agent is already processing..."` | 属实 |
| auto_retry_start/end 序列 | start@2133-2139；end{success:true}@390-397 / end{success:false}@767-774 / cancelled@2154-2159 | 属实 |

xyz 侧消费链同样逐环证实：rpc-mode.js:298-318 把 throw 转为 RPC error response；rpc-client.ts:499-503 prompt 只发 `{message, images}` 不传 streamingBehavior；message-dispatcher.ts:146-157 catch → `isGenerating=false` + `message.error` 广播（与注释引用的行号精确吻合）；session-internal.ts:71 `handleTurnEndSideEffects` 证实「首个 agent_end 已复位 isGenerating」的 UX 瑕疵前提。

### 3.2 0.80.3 旧语义考证（clone git show，只读）

`git show 647c5554b:packages/coding-agent/src/core/agent-session.ts` 795-796 行：

```ts
get isStreaming(): boolean {
    return this.agent.state.isStreaming;
}
```

0.80.3 是 loop 级状态（agent.prompt() 返回即 false）→ 审计 A-10「retry delay 窗口 isStreaming=false → 新 prompt 被 pi 直接接受 → 并发竞争」的**前提确实只在旧 clone 语义下成立**，0.84.1 已改为 run 级 `_isAgentRunActive`。builder 注释的历史断言属实，推翻审计 finding 有据。

### 3.3 半程探针（verifier 独立实测，已清理）

命令形态：`node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc --session-dir /tmp/<隔离> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve`，stdin JSONL 发 prompt p1；收到 `agent_start` 后 400ms 抢发 prompt p2（不带 streamingBehavior）。

输出摘要：

```
p1 response: {"id":"p1","type":"response","command":"prompt","success":true}
evt: agent_start
>>> sending second prompt (during streaming) <<<
p2 response: {"id":"p2","type":"response","command":"prompt","success":false,
  "error":"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."}
```

探针验证的窗口（streaming）与 retry 退避窗口共享同一变量 `_isAgentRunActive`（同一 getter），拒绝始点（831-833 throw）与透传路径（rpc error response）均被实测复现。「retry 窗口该变量为 true」一环由源码结构（3.1 表第 3 行）保证。

**结论：builder 的「xyz 不消费 willRetry 是安全的、无数据竞争」三态结论（不可复现→登记）可信；UX 瑕疵（retry 窗口 UI 视为空闲、用户收到 pi 英文错误）的披露诚实准确。**

## 4. A-11「已验证成立」复核 — 结论成立（verifier 独立重验）

- dist config.js:293-313：bun binary 分支（isBunBinary = import.meta.url 含 `$bunfs`/`~BUN`/`%7EBUN`）→ `dirname(process.execPath)`；Node 分支 → 从 `__dirname` 向上找 package.json。与注释一致。
- 打包产物布局实测：`apps/electron/resources/pi/` 下 `pi-darwin-arm64` + 同目录 `theme/`、`package.json`（及 assets/export-html/wasm）——与 bun 分支资源布局一致。
- **独立重验**（对齐 builder 实测声明）：① `cd /tmp && .../pi-darwin-arm64 --version` → `0.84.1`；② node dist 形态在 HOME / /tmp / /usr 三种 cwd 下 `getPackageDir()` 与 `getThemesDir()` 输出完全一致（均解析到包根 / dist/modes/interactive/theme）。cwd 无关性双形态均成立，rpc-client spawn cwd 设用户项目目录的安全性依据在 0.84.1 upstream 成立。
- 注释锚点回写位置（rpc-client.ts:210 附近 spawnCwd 逻辑上方）真实对应。

## 5. AGENTS.md / ADR-0063 文本审查 — 通过

- AGENTS.md：新规则完整覆盖基线要求（权威源=node_modules 实装版 + `npm ls` 核对命令 + clone 降为可读 TS 参照 + 引用前核对版本 + 历史事故锚点）；「不靠网络搜索」原句保留；基线允许此段改写。
- ADR-0063：**只加不删**（纯新增 2 行 blockquote 修订注）；修订注引用的「审计 C #6 抽验 setSessionFile / `_persist` 在 0.84.1 dist 成立」与审计报告原文（report-c #6 明细）逐字对应，引用真实；原正文锚点全部保留。
- 无过度承诺：pi-protocol.ts 注释的「无数据竞争」有上述完整证据链支撑，且同步披露 UX 瑕疵与「登记不修」决策。

## 6. troubleshooting 三条观察项 — 通过（锚点 3/3 全核，超出抽 2 要求）

每条均含触发条件 + 处置建议 + pi 锚点 + 触发域限定（如 F8 标明 xyz 桌面链路不走该路径）：

| 项 | pi 锚点 | dist 核验 |
|---|---|---|
| F8 SIGINT re-raise | interactive-mode.js:3193-3223 | 属实：空 `ignoreSigint` 注册 + SIGCONT 移除均在区间内 |
| F10 jsonl 延迟首写 | session-manager.js:724-752 | 属实：hasAssistant 检查 / 未 flush 不落盘 / 首条 assistant `openSync("wx")` 全量写出，逐行吻合 |
| U1 pi-ai/compat 废弃 | pi-ai dist/compat.js 头注释 | 属实：原文含 "This module is deleted with the coding-agent ModelManager migration." |

## 7. lint + typecheck — 通过

- `packages/runtime && pnpm typecheck`：tsc --noEmit 零错误。
- `pnpm run lint`：W6 五文件零 error、零新增 warning（C4 满足）。全仓唯一 error 在 `chat-app/src/components/ChatHistory.tsx`（'Message' unused）——chat-app 属豁免域、非 W6 产物，如实登记不属于本 wave。

## 8. Observations（不阻塞）

1. **C2 实测记录落档形态**：A-10/A-11 的实测记录只存在于代码注释（含结论与部分命令细节），无独立 harness 记录文件；本报告 §3.3/§4 的 verifier 独立探针命令 + 输出摘要可作该层补强。建议后续 wave 的探针记录直接落 `acceptance/` 一份。
2. **「连产 4 条漂移 bug」口径差**：AGENTS.md 新句沿用设计文档（`docs/architecture/pi-assumption-remediation.md:63`「批次二的 4 条漂移」）口径，而审计 C 报告原文明说「#1、#2、#7 **三条**漂移全部源于按旧 clone 断言」。出处真实但两文档数字不一致，建议后续统一口径（设计文档为前序 commit 产物，非 W6 引入）。
3. **rpc-client 注释未提 `PI_PACKAGE_DIR` env override**（config.js:295-298，优先级高于两分支）：xyz-agent 不设此变量，结论不受影响；若用户环境手动设置该变量则两形态行为均被覆盖。可作注释补充点。
4. **ledger.md wave 表未更新 W6 状态**（仍 pending）：与 W2-W5 同样滞后，系 orchestrator 统一更新惯例，非 W6 特有。
