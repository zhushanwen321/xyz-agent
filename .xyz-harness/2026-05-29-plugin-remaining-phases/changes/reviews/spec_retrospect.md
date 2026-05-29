---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — plugin-remaining-phases

## 1. Phase Execution Review

### Summary

完成了插件系统剩余功能的 spec 定义。通过深度扫描（4076 行后端 + 6535 行测试）识别出 13 个 stub/断裂点，经用户确认后收敛为 10 项 FR（3 档优先级）。关键决策：

1. **SessionData 持久化放弃 pi bridge 依赖**，改为本地文件方案（ADR-0014）
2. **砍掉 Phase 4 全部分发体系**（npm install/脚手架/文档/压力测试），只保留 SDK 类型包 + 样例插件
3. **砍掉全部 P3 远期增强**（contributes 声明式/API 分层/Worker recycling 等 10 项）

scope 从原始 25 项缩减到 10 项，预计代码量 ~775 行。

### Problems Encountered

1. **初始扫描报告有误**：第一轮 subagent 扫描报告称 StatusBar 渲染和 MessageDecoration 渲染"未实现"。第二轮针对性扫描发现 AppStatusbar.vue 和 MessageDecoration.vue 已完整实现并消费 store 数据。第一轮报告基于"未发现消费组件"的错误判断。**修正**：第二轮扫描直接 grep 了组件名，发现已有完整链路。scope 从 12 项减为 10 项。

2. **spec review 三轮才通过**：
   - v1: 4 条 MUST FIX（AC-1 不可测试、FR-4 组件策略矛盾、FR-3 数据源未定义、FR-7 重试作用域不清）
   - v2: 1 条 MUST FIX（Constraint #4 与 FR-4 描述不一致，遗漏修改）
   - v3: 通过
   - 根因：spec 首次编写时对"复用 vs 新建"组件策略含糊，导致多处自相矛盾。

### What Would You Do Differently

1. **先确定"新建还是复用"的组件策略再写 FR-4**，避免 body 和 constraints 节分别写了不同方案。
2. **AC 编写时先写"空值/边界情况"**，AC-1 的"返回非空数组"是典型错误——没 session 时空数组才是正确行为。

### Key Risks for Later Phases

1. **FR-8 Hook 桥接是最高风险项**：event-adapter 的异步改造可能影响消息流的时序。plan 阶段需要仔细设计 hook 结果如何回传到 event-adapter（当前 event-adapter 是同步翻译）。
2. **FR-4 UI 弹窗的 WS 协议是新通道**：server.ts 需新增 `plugin.uiResponse` 路由，可能与其他 WS 消息处理冲突。
3. **FR-9 SDK 类型包的维护成本**：从 plugin-types.ts 提取类型后，两处需要同步更新。dev 阶段需要设计类型同步策略。

## 2. Harness Usability Review

### Flow Friction

1. **brainstorming skill 的 Step 2-4 在本项目不太适用**：这是一个"补完已有设计"的需求，不是从零探索。用户已经读完 docs/plugin/ 并给出了明确 scope（"本期都要实现"）。大部分 clarifying question 可以跳过。但 skill 要求"ask one question at a time"，按字面执行会浪费轮次。**实际处理**：先做深度扫描验证现状，然后直接给出功能意义分析，让用户确认 scope。偏离了 skill 字面流程但更高效。

2. **gate check 脚本路径不在项目本地**：`check_gate.py` 在 `~/.pi/agent/skills/` 下而非项目 `skills/` 下，需要 find 搜索才能定位。

### Gate Quality

Gate check 正确捕获了 untracked files 问题（spec + ADR 未 git add）。修复后一次通过，无 false positive。

### Prompt Clarity

brainstorming skill 的 six-element completeness check 和 ambiguity marking 指导有效，帮助产出了结构完整的 spec。review subagent 捕获了 4 条 MUST FIX 也说明 spec 质量把关有效。

### Automation Gaps

1. **spec review 的多轮修复循环可以更自动化**：当前需要手动 dispatch review → 读结果 → 修复 → 重新 dispatch。如果能自动检测 verdict=fail 并立即修复再提交，可以省 2 个轮次。

### Time Sinks

1. **两轮 subagent 扫描**占了总时间的 ~40%。第一轮扫描覆盖面广但有误判，第二轮针对性扫描才修正。如果第一轮扫描直接验证"store 是否被组件消费"（而不是只看 store 有没有定义），可以一轮完成。
