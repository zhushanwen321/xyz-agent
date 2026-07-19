# 复盘：sidebar-perf-p0

**日期**：2026-07-16
**状态**：test passed，待 closeout

## 做了什么

优化侧边栏 session 状态卡顿。6 个 Wave 跨 runtime + shared + 前端三层：
- W1 messages shallowRef + commitMessages 不可变写入（消除万级深 proxy）
- W2 isGenerating computed 派生 Set（O(n)→O(1)）
- W3 statusOf 缓存化（消除侧栏每次渲染 O(N×M) 重算）
- W4 runtime 写 session_end 终态 entry（3 个终态点）
- W5 SessionStatus 扩展 + scanner 读终态
- W6 前端去全量预 hydrate + deriveStatus 元数据兜底

3 条 ADR（0034 shallowRef / 0035 computed Set / 0036 session_end entry）。

## 做得好的

1. **验证驱动设计**：方向 1-3 + shallowRef 每项都派 agent 做了代码验证（streaming 写入收口、messages 消费点深响应式、pi JSONL 终态落盘），避免了基于假设的错误方案。尤其是方向 3 验证发现 pi JSONL 不写终态标记，推翻了"回扫文件尾部推断终态"的初步设想，改为 runtime 主动写 session_end。
2. **禁读重建 spec_review 有效**：fresh subagent 从源头重建 spec，发现"瞬态来源未定义"和"computed 在 shallowRef 下重算"两个决策接缝问题，虽方案已覆盖但 spec 没显式记录，补强了可追溯性。
3. **独立 review 抓到关键 must-fix**：index.ts:173 注入点丢 stopReason 是实现时遗漏（改了签名/调用方/handler 唯独漏组合根注入），独立 reviewer 不带实现者盲区，精准定位。

## 做得不好的 / 教训

1. **认知外改动反复阻塞**：工作区有 82127011（Message.content 改 string|Segment[]）等多个未完成 topic 的遗留，导致 pre-commit 的 vue-tsc 和运行时测试反复失败。每次"我处理了"后仍有新的失败浮现（useComposerHistory → use-chat-dispose → markdown/extension/fileSearch）。**教训**：在一个有多个并行 topic 的工作区开发前，应先跑一遍全量 tsc + test 确认基线干净，否则认知外失败的排查会持续打断主线。
2. **每个 Wave 没跑全量测试**：dev 阶段每个 Wave 只跑该 Wave 相关 + stores 测试，没跑全 composables。导致 W6 才暴露 use-chat-dispose 等 pre-existing 失败（虽非 W6 引入，但应早发现）。**教训**：每个 Wave commit 前跑全 renderer 测试（至少 stores + composables），不只跑改动相关。
3. **shallowRef 的 Map mutation 陷阱**：W1 初步设想"改 shallowRef 即可"，实现时才发现 shallowRef 下 Map.set 不触发响应式（实测验证），被迫引入 commitMessages helper 改造 28 处写入点。**教训**：shallowRef 对 Map/Set 的响应式语义（只对 .value 整体替换敏感）是关键约束，方案设计时应先验证而非假设。

## 过程数据

- 6 Wave，7 commit（含 review_fix）
- 51 测试通过（U1-U5）
- 1 must-fix + 1 should-fix 在 review 阶段修复
- 3 ADR 记录
- 阻塞来源：3 次认知外改动（82127011 等）的 pre-existing 失败

## 后续

- 已知取舍：extractSessionOutcome 全量读 3 次（性能优化审查 P2，独立改进）
- 已知取舍：Overview sessionDigest 未 hydrate 退化（需产品决策）
- 未做：消息列表虚拟滚动（H1）、markdown 流式节流（H2）——独立大工程
