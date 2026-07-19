# Retrospect — drawer-composer-injection

**日期**: 2026-07-17
**topic**: cw-2026-07-16-drawer-composer-injection
**交付**: 6 commits（W1-W5 + review_fix），17 testCase 全 pass

## 做对了什么

1. **架构决策前置（ADR-0034）**：clarify 阶段发现 feat-gui-optimize 已有的 `#file` mention chip 是伪结构化（无 dataset，getSegmentsFromEl 读成纯文本），决定"升级而非新增第三种类型"，让 `#` 输入和 drawer 注入共用一条结构化通道。避免了两个 file chip 通道并存的维护陷阱。

2. **spec_review 禁读重建发现真实漏洞**：fresh subagent 从 objective 重建 spec，发现 FR-4 与 FR-8 矛盾、target=new 路由缺失、payload schema 未定义、AC 全空。这些在直接读初稿时容易"顺着走"漏掉。

3. **Wave 拆分合理**：W1 基础设施→W2 通道→W3 简单入口→W5 渲染→W4 选区 bubble。依赖链无环，每个 wave 可独立验证。W3 先于 W4 验证了端到端链路，给最复杂的 W4 打基础。

4. **review 抓到 1 blocker + 2 major**：B1（选区 bubble click 前 mouseup 清选区）是真实浏览器 bug，M1（lineRange 发给 LLM 时丢失）破坏核心价值，M2（dual mount 误拆 session）是并发态问题。这些都是写测试时没发现的。

## 教训

### 1. jsdom 测试掩盖真实浏览器行为（B1 根因）
**现象**：选区 bubble 测试 mock 了 window.getSelection 返回非 collapsed，直接 trigger('click')。测试绿，但真实浏览器 mousedown 会折叠选区，mouseup 清掉 selectionRange，bubble 在 click 前卸载。

**根因**：jsdom 的 selection API 与真实浏览器行为不一致，且 vue-test-utils 的 trigger('click') 不模拟完整 mousedown→mouseup→click 事件序列。测试验证的是"bubble 存在时点击能注入"，但没验证"bubble 能否在真实交互中存活到点击"。

**改进**：涉及 selection/focus/事件冒泡的交互，单测只能验证逻辑分支，真实浏览器行为必须手动或 E2E 验证。测试注释应明确标注"绕过了哪些 jsdom 限制"，而非默默绕过。

### 2. 完整链路的端到端验证缺失（M1 根因）
**现象**：file segment 的 lineRange 在 chip DOM、badge 渲染、store 都正确携带，唯独 segmentsToPrompt（发给 LLM 的序列化）丢弃了 lineRange。每层测试都绿，但跨层（segment→prompt 文本）没测。

**根因**：W1 测了 getSegmentsFromEl（DOM→segment），W5 测了 Turn 渲染（segment→badge），但 segmentsToText（segment→prompt）的 file case 没测。这是 feat-gui-optimize 既有代码（ADR-0037 引入），我假设它正确，没验证。

**改进**：跨层的序列化/反序列化是 bug 高发区。新增 segment 类型时，必须测"完整往返"：DOM 写入 → getSegments → segmentsToPrompt → 文本。不能只测单层。

### 3. dual-mount 并发态未测（M2 根因）
**现象**：target=new 在 landing+panel 同时挂载时，两个 composer 的 watch 都触发，panel 分支无条件 startFlow 拆 session。测试 U8/U9 分别只挂单个 composer。

**根因**：split/dual 模式是项目的核心特性（多 panel），但注入测试只覆盖单 composer 场景。

**改进**：涉及"哪个实例消费"的路由逻辑，必须测多实例并发场景（至少 2 个 mount）。这是路由类 bug 的标准回归点。

## 流程评估

- **clarify → spec_review → plan → tdd_plan → dev → review → test** 全流程走完，9 阶段无跳过
- spec_review 的禁读重建价值最高（发现 5 must-fix）
- review 的独立 subagent 审查价值高（发现写测试时盲区）
- test 阶段的 actual.text===expected.text 严格匹配设计，对"测试通过即实际=预期"的语义合理，但对人类可读的 expected 描述不够友好（需手动同步）

## 待办（非本 topic）
- W4 选区 bubble 的行范围反推首版仅 preview/code 模式（diff 模式禁用），diff 模式的精确行号反推（从 DOM data-line 取）留后续
- R1/R3 真实 DOM chip 端到端（mount 真实 ComposerInput 验证 chip 出现在 contenteditable）留手动/E2E 验证
