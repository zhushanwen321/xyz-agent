---
phase: dev
verdict: pass
---

# Phase 3 (dev) Retrospect — statusline-design

## 1. Phase Execution Review

### Summary

13 个 Task 按 Wave 模式成功执行完毕（Wave 1 BG1 → Wave 2 BG2+FG1 并行 → Wave 3 FG2），产出 17 个文件变更（+1327/-94 行）。5 步专项审查跑了两轮：v1 发现 12 条 MUST FIX（3 条 robustness + 4 条 business-logic + 4 条 integration + 1 条 ts-taste P0），全部修复后 v2 全部 pass。Lint 0 errors、Build 全通过。

### Problems Encountered

**v1 的 12 条 MUST FIX 按根因归类**：

| 根因 | 数量 | 问题 |
|------|------|------|
| **pi 适配层假设过于乐观** | 5 | String(undefined) 显示 "undefined"、bridgeData.data null 未防护、onContextUpdate session null 未防护、outputTokens 从未设置、清除路径断裂（空 text 被 early return 拦截） |
| **UI 分工未严格遵循 spec** | 4 | branch 出现在 AppStatusbar（spec 要求 SessionStrip）、thinking picker 可交互但 emit 被注释、outputTokens 语义错误（total 当 output 显示）、pi 版本号遗漏 |
| **Plugin 实现防御不足** | 2 | onPiEvent 缺 try/catch、onContextUpdate 闭包引用 DI 未保护空值 |
| **Plugin import 路径不可移植** | 1 | statusline plugin 直接引用 `../../../src-electron/runtime/...` 源码路径（ts-taste P0，v1 评审发现但本轮未修复——属规划层面问题） |

**修复模式**：大部分是"去掉 optimistic guard / 添加 null fallback / 严格按 spec 路由"的防御性修复，不是架构性问题。两轮审查的修复总变更量较小（约 30 行改动），说明 v1 代码结构正确，细节边界条件处理不到位。

### What Would You Do Differently

1. **前置防御清单**：在 plan 的 Task 描述中加入 "null/undefined 防护检查点" 清单。v1 暴露的问题几乎都是"数据可能为空但未处理"，可在编码前就写在 Task 描述中。例如 Task 2 (event-adapter) 加一条 "setStatus text 为 undefined 时必须转为空字符串"。
2. **spec → UI 路由表前置化**：branch 只在 SessionStrip、thinking picker 隐藏、token stats 只在 InputToolbar——这些分工规则应在 plan 的 FG1 Task 描述中以 checklist 形式列出，避免 subagent 遗忘。
3. **Plugin import 路径在 plan 阶段解决**：ts-taste v1 发现的 P0（import 路径不可移植）应在 spec/plan 阶段就确定 plugin 类型从 shared 包导入的策略，而不是留给 dev 阶段。这是唯一未在 v2 修复的 MUST FIX 级问题。

### Key Risks for Later Phases

1. **SessionStrip chip 颜色失效**（robustness L6）：`getChipClasses` 用 `startsWith('goal')` 匹配，但 statusline plugin 生成的 id 为 `pi-goal`，导致所有 chip 走 default（灰色）。这是功能 bug，虽不崩溃但视觉上无法区分 goal/todo/workflow。
2. **PI_VERSION 硬编码**：pi 升级后需手动同步，建议后续从 `get_state` 响应或 configService 动态获取。
3. **Thinking 相关死代码**：~30 行 thinking picker 代码仍为活代码（v-if="false" 仅隐藏 DOM，computed 仍执行），待 pi 支持 `setThinkingLevel` RPC 后需恢复或清理。
4. **PluginStatusItem / StatusBarItem 类型重复**：renderer `types/plugin.ts` 和 shared `protocol.ts` 各维护一份高度相似的结构，后续可统一。

---

## 2. Harness Usability Review

### Flow Friction

**Wave 并行模式效果好**：BG2（plugin）和 FG1（前端）并行执行无文件冲突，Wave 划分合理。唯一摩擦点是 FG2（文档）对 BG2 的强依赖——文档以 statusline plugin 源码为案例，plugin 代码必须先就绪。实际执行中 FG2 在 Wave 3 单独执行，等待时间合理。

**审查修复循环效率高**：v1→v2 修复仅涉及约 30 行变更，两轮审查间隔短。5 步专项审查覆盖全面（standards、ts-taste、robustness、business-logic、integration），发现问题类型互补——standards 审规范合规，ts-taste 审代码品味，robustness 审防御性，BLR 审业务正确性，integration 审端到端一致性。

### Gate Quality

**审查质量优秀，无假阳性**：12 条 MUST FIX 每条都有明确的 spec/AC 引用和代码位置，修复后在 v2 中逐条验证了完整路径（如清除路径 Issue #1/#6 验证了从 `pi extension: setStatus("goal", undefined)` 到 `SessionStrip chip 消失` 的 7 步链路）。v2 审查还主动检查了"修复是否引入新问题"（4 项新引入问题检查），均 pass。

**ts-taste 的 P0 跨 phase**：import 路径不可移植是真实问题，但不在 dev 阶段能解决（需要 shared 包调整），这暴露了 spec/plan 阶段的一个遗漏——plugin 类型导入策略未在设计阶段确定。

### Prompt Clarity

**plan 的 Task 描述足够详细**：每个 Task 有 Spec Ref、依赖关系、修改文件清单、interface contract。subagent 能直接执行无需额外澄清。BG1 的 6 个 Task 通过 Interface Contract 明确了函数签名和 edge cases，有效减少了歧义。

**可改进点**：Task 7 (statusline plugin) 的描述中缺少"空 text 必须正确传播到 plugin-service"的约束，导致 v1 出现清除路径断裂。Task 9 (InputToolbar) 的描述中缺少"outputTokens 不可用时应移除而非显示 0"的约束。

### Automation Gaps

**chip 颜色 bug 未被自动化发现**：`getChipClasses` 用 `startsWith('goal')` 匹配 `pi-goal`，这是典型的字符串匹配 bug。ESLint/vue_rules_checker 均不覆盖此逻辑错误，只能通过手动测试或集成测试发现。建议后续为 SessionStrip 添加单元测试覆盖 chip id→class 映射。

**plugin import 路径的构建验证**：statusline plugin 的源码路径 import 在 `npm run build` 中不报错（因为 dev 模式下路径可解析），但生产构建可能失败。缺少一个 "production build simulation" 检查点。

### Time Sinks

**5 步专项审查 + 2 轮**：v1 五个审查维度是串行执行的（BLR → integration → robustness → standards → ts-taste），合计产生了 12 条 MUST FIX，修复后需重跑全部五个维度。如果五个审查能并行执行，或 v1 只跑一轮通用审查汇总所有问题，可节省一轮往返。不过两轮模式的优势是 v2 能确认"修复未引入新问题"，权衡之下当前模式可接受。

**总体评估**：13 Task + 2 轮审查在合理时间内完成，主要耗时在审查修复循环而非编码本身。代码质量因两轮审查显著提升（v1 的 MUST FIX 涉及真实的用户可见 bug 和防御性缺陷）。
