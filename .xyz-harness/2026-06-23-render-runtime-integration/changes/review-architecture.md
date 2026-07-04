---
verdict: APPROVED
review_target: system-architecture.md
upstream: requirements.md, spec-w11.md, contract.md
reviewer: 独立架构审查 subagent（fresh context，read-only 探索模式）
date: 2026-06-24
machine_check: PASS
---

# Architecture Review Report

## Verdict: APPROVED

## 评分（每维 1-10）

| 维度 | 分数 | 备注 |
|------|------|------|
| 架构完整性 | 8.5 | 目标转换完整、核心计算准确、分层决策有据。3 层 vs 4 层的论证充分 |
| 模型正确性 | 8 | Round 4/5 修复后模型覆盖完整。isGenerating/isStreaming 命名不一致扣分 |
| 边界清晰度 | 8 | Port 定义合理（边界价值论证），模块按变化轴拆分，依赖方向正确 |
| 决策质量 | 7.5 | D-1 到 D-9 + 特化决策均有理由。D-8 事实错误（caller 数）和 mock 文档矛盾扣分 |
| 可执行性 | 8 | AC 机器可检查，LOC 预估合理，issue 分组清晰。AC-5 grep 模式需修正 |

**总分: 8.0 / 10**

---

## 优点

### 1. 目标转换链路完整且可衡量
§1 的业务目标→系统目标转换表每一行都有明确的衡量标准（如 "mock 模式发消息可见 thinking→tool→text→file_changes 全链路"），不是空泛的"完成 XX 功能"。这为下游 issue 验收提供了清晰的判据。

### 2. 降级决策（主动不建模）是架构文档的亮点
§4.3 明确列出 MessageStream / GitZone 四态 / SideDrawer 三个概念**不建模**的理由。特别是 GitZone 四态的"镜子 vs 控制器"比喻精准——前端派生展示态，每次 git.status 返回后重算，无显式转换规则。这避免了过度建模。

### 3. 决策记录有张力描述
每个决策（D-1 到 D-9）都先描述"张力"（两个对立力量），再给决策和理由。例如 D-8 的"ponytail: 当前只有 1 个调用方，过度分层是浪费"。这种格式比"我们决定用 X"的信息密度高得多。

### 4. Round 4 → Round 5 的收敛质量高
12 个 gap 全部解决，无新增 gap。特别是 G-001（GitFileStatus 模型缺失）和 G-008（mock 隔离描述不准确）的处理干净利落。

### 5. git-zone 的独立数据源决策（C12/D-1）架构正确
git.status（全量工作目录状态，含用户手改）和 message.file_changes（per-turn agent 改动）是两条语义不同的数据。合并它们会导致"AI 改了 3 个文件但用户又改了 2 个"时 git-zone 显示错误。独立数据源是正确决策。

### 6. 泳道图（§9）端到端完整
9.1 消息发送和 9.2 git.status 两条泳道覆盖了新增功能的核心路径，从用户操作到 runtime 返回的每一步都有参与者和箭头。

---

## 问题（5 个 minor）

### Minor-1: D-8 caller 数事实错误
- **位置**: system-architecture.md §10 D-8
- **问题**: 文档称 readGitInfo "只有 1 个调用方（session-scanner.ts）"，但 tracing-round-5 的源码验证发现 session-service.ts 也调用了 readGitInfo（2 个调用方）。
- **影响**: 不影响决策结论（ponytail 论证对 2 个调用方同样成立），但作为架构文档的事实准确性需要修正。
- **状态**: 已修正

### Minor-2: mock/index.ts 模块头注释与实际 import 矛盾
- **位置**: mock/index.ts 第 10 行 + 第 24 行
- **问题**: 模块头注释声明 "不 import transport/events/pending，独立内存实现"，但第 24 行实际 `import * as events from '../events'`，且 `pushSession` 函数用 `events.dispatchSession` 模拟 session 通道推送。
- **影响**: system-architecture.md §10 特化决策已正确描述为"mock 共享 events 分发机制"，但源码头注释仍是旧描述。
- **状态**: 架构文档已修正，源码头注释属代码改动，留待实现时更新

### Minor-3: AC-5 grep 模式引用错误字段名
- **位置**: system-architecture.md §11 AC-5
- **问题**: AC-5 验证 `isGenerating = false`，但实际 store 使用 `isStreaming` ref。
- **影响**: 机器可检查性降低。
- **状态**: 已修正

### Minor-4: §5.1 状态机变量名与实现不一致
- **位置**: system-architecture.md §5.1
- **问题**: 状态机描述使用 `isGenerating`，实际 store 使用 `isStreaming` ref。
- **影响**: 架构文档与实现的映射关系模糊。
- **状态**: 已修正（统一为 isStreaming）

### Minor-5: AC-1 验证逻辑可能误判
- **位置**: system-architecture.md §11 AC-1
- **问题**: grep 假设无 `getSkills` 函数名，但未来可能有合法同名函数。
- **影响**: 低。当前确实没有，AC 稳健性可接受。
- **状态**: 保持现状

---

## 建议（可选）

### S1: 考虑补充 git.status 在 IGitExecutor 中的位置
D-9 定义 IGitExecutor 负责 stage/unstage/commit，readGitInfo 负责轻量缓存查询。但 git.status（实时全量状态查询）的归属不明确——它不是缓存查询（需要实时），也不是 stage/unstage/commit 类操作。建议在 §6.3 Port 清单中补充说明 git.status 走 IGitExecutor。

### S2: Compact 状态机的"瞬态"描述可以更精确
§5.3 说 Compact 是"事件流而非状态机"，但又用了 Status 枚举。建议明确：这是 UI 指示态，不是业务状态机。compacted 后自动回到 idle 的转换应由 UI 组件驱动。

### S3: LOC 预估中 stores/chat.ts ~300 行偏紧
当前 stores/chat.ts 已有 ~200 行。W11 新增消费逻辑后，300 行可能不够。建议预估为 ~350-400 行，或提前规划将 applyChunk 进一步拆分。
