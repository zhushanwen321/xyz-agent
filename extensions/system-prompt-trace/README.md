# @zhushanwen/pi-system-prompt-trace

Session Trace 单元 1（留痕 extension）。system prompt 在 pi 中每次运行时动态重建、默认不落盘——本包在
system prompt 确立或变化时向 session JSONL 追加留痕 entry，让「resume/reload/换配置前后 prompt 到底是什么」
可追溯（设计：`docs/page-design/session-trace/design.md` D2）。

## 落盘格式

```ts
appendEntry("xyz:system-prompt", {
  version: number;                    // session 内单调递增，首条 1
  hash: string;                       // sha256(fullText) 十六进制
  reason: "initial" | "resume" | "change";
  fullText: string;                   // 完整 system prompt
  charCount: number;                  // fullText.length
  parentVersionDiffSummary?: string;  // 与上一版的行级 diff 摘要（有 parent 全文时）
});
```

## 写入时机（设计 D2 校正）

- **不在 `session_start` 写**：该事件 emit 早于 resources_discover 的 prompt 重建，快照必不完整。
- **首个 `turn_start` 写 initial/resume**：此时 `getSystemPrompt()` 已含 `before_agent_start` 注入，是最终 prompt。
- **后续每个 `turn_start`** 做 hash 对比，变化才写 `change`。

## reason 映射

`SessionStartEvent.reason` 原生 5 值（startup/reload/new/resume/fork）→ 落盘 reason：

| SessionStartEvent.reason | 落盘 reason | 状态 |
|---|---|---|
| startup / new | initial | 定案 |
| resume | resume | 定案 |
| fork / reload | resume | 暂定，待 P2 探针实测定（A13） |

存在任一 hash 基线（见下）时，首个 turn 写 `resume`（无论 session_start reason）。

## 跨重启 hash 基线三路径（优先级从高到低）

1. **进程内 resume**：`session_before_switch.targetSessionFile` 直读目标 session 文件，取最后一条留痕 entry 的
   hash/version/fullText。switch 会 teardown 并重建 extension runtime，该基线经模块级 stash 跨 runtime 传递。
2. **app 重启直 spawn resume**：`<agentDir>/system-prompt-trace-baseline.json` 自持久化小文件（sessionId →
   hash/version），原子写入，保留最近 64 个 session。
3. **兜底**：两路都读不到且 reason=resume → 必写一条（宁可多写不可漏记）。

## 注册状态

本包尚未注册进 `packages/shared/src/mandatory-extensions.json`（后续单元处理；feature tier，可禁不可卸）。
