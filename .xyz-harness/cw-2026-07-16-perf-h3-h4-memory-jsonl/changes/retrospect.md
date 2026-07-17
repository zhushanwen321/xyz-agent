# Retrospect: perf-h3-h4-memory-jsonl

## 交付总结

H3（前端消息内存）+ H4（runtime JSONL 读取）联合优化，4 Wave + review_fix：

| Wave | 内容 | commit |
|------|------|--------|
| W1 | tailReadHistory 尾读+turn边界截断（runtime） | 9fb3d7db |
| W2 | truncateToolOutput 共享截断（实时+回流路径） | 21ba97e3 |
| W3 | chat-lru LRU 驱逐 + subagent 虚拟 key 清理 | 468e1c49 |
| W4 | 加载更多 fallback + UI（全量读兜底） | 4600af78 |
| review_fix | R1-R5 修复（isEnoent 拼写 + tailReadHistory 接入 + LRU 真 recency + 内存泄漏） | 40f7563a |

30 个单测全绿。性能收益：
- H3：消息 Map 从无限增长 → 保留最近 8 个 + panel/streaming 豁免；tool result 从全量 → 4KB 头部截断
- H4：大 session 点开从全量 readFile → 256KB 尾读最近 20 turn；加载更多 fallback 全量读

## 做得好的

1. **spec_review 禁读重建发现了 SR1 must-fix**（截断必须覆盖回流路径）——如果不做禁读重建，切回老 session 时 20 turn × MB 级 tool result 会抵消 H3 收益。这是 spec 阶段最有价值的发现。

2. **W2 的共享截断设计（D9）**——truncateToolOutputBatch 同时用于实时路径（tool_call_end）和回流路径（hydrate/setMessages/prependHistory），单一入口保证策略一致。review 确认两条路径截断行为完全一致。

3. **UTF-8 codepoint 边界对齐**——truncateToBytes 用 `buf[cutPos] & 0xC0 === 0x80` 检测续字节，CJK 截断不产生半个字符。review 确认正确。

## 做得不好的

1. **R1 isEnaent 拼写 bug 未被测试捕获**——tailReadHistory 的 readFile fallback 路径里用了 `isEnaent`（errors.ts 只导出 `isEnoent`）。AC-6 测试用的不存在的文件先被 statSync 守卫拦截，从未走到 isEnaent。vitest/esbuild 的 loose 模式不检查 import 导出是否存在，编译期也没报错。**教训：import 拼写错误是运行时炸弹，单测覆盖不到的路径要靠 code review 兜底**。

2. **R2 tailReadHistory 是 dead code**——W1 实现了 tailReadHistory 但忘记在 session-service.ts 的 getHistory 里接入。review 发现时整个 W1 的尾读优化都没生效。**教训：新函数写了要接入调用链，否则等于没写。dev 阶段应该在主链路上验证（不只是单测）**。

3. **R3 LRU 退化为 FIFO**——touchLru 只在 hydrate（有 hydrated 守卫）里调用，重新访问已 hydrate session 不更新 recency。测试通过是因为手动调了 store.touchLru。**教训：单测用手动调用掩盖了"真实调用链缺失"的问题。应该测试真实的 selectSession 路径而非直接调 store action**。

4. **chat.ts max-lines 反复触发 pre-commit**——W3/W4 让 setup 函数超过 300 行，被迫多次重构（抽 makeLruEvictDeps/truncateFromImpl/prependHistory 到模块级）。**教训：大文件的 setup 函数已经是技术债，新增功能前应该先做模块拆分**。

5. **test.json expected 校准错误（U11）**——expected 写了 `m0-reloaded` 但 makeMessage 产出 `msg-m0-reloaded`。CW replan 防作弊拦截了 expected 修改，被迫改测试代码。**教训：expected 要从测试断言的实际值提取，不手写**。

## 关键决策回顾

| 决策 | 选择 | 效果 |
|------|------|------|
| D7 tool result 4KB 截断不可恢复 | 用户选了更激进的方案 | 单 tool output 从 200KB→4KB，但展开只能看头部 |
| D2 LRU K=8 | 平衡内存与切换体验 | 截断后 8 session ≈ 40-80MB |
| D9 共享截断函数 | SR1 must-fix 修复 | 实时+回流策略一致 |

## 待改进的 follow-up

- R7（浅 clone 脆弱）：truncateToolOutputBatch 的 toolCalls 仍原引用，当前安全但需注释标注约束
- N1（hasMoreHistory 默认 true）：空 session 闪现按钮
- H1 虚拟滚动、H2 流式 markdown 节流：独立 topic
