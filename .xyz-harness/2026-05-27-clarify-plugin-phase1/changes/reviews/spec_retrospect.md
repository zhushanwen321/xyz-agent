---
phase: spec
verdict: pass
---

# Phase Retrospect — Phase 1 (Spec)

## Phase Execution Review

### Summary

本 Phase 产出了一份 432 行的 spec，覆盖插件系统 Phase 1（核心基础设施）的全部功能需求。内容包括 9 个 FR（PluginService、PluginRegistry、PluginHost、PluginRPC、PluginActivator、PluginStorage、类型定义、Server 集成、集成测试）、6 个 AC、5 个决策点、3 个风险评估。

关键决策：
- Worker Thread 隔离模型：trusted 共享 / untrusted 独占，比 VSCode 的 ExtHost 模型更激进
- JSON-RPC 2.0 自实现约 200 行，零外部依赖
- PluginService 与现有 ExtensionService 完全独立，不复用扫描逻辑，在 server.ts 中共存
- 最小 agentAPI（仅 storage/notify/sessions.list/events），Phase 2 再加 tools/hooks/ui 等

spec 是在已有的 4 份调研/设计文档 + 1 份代码盘点报告基础上写的，不是凭空设计。整体质量高——技术细节深入到接口签名、JSON-RPC 协议消息格式、Worker 生命周期、存储限制、错误码定义、状态机转换。

### Problems Encountered

Gate check 三次失败，但都是格式问题而非内容问题：

1. **verdict 字段**：spec.md 初始写为 `pending`，需改为 `pass`。这是模板习惯问题，一眼修正。
2. **review 文件路径**：spec_review_v1.md 最初放在 harness 根目录，gate 要求放在 `changes/reviews/` 子目录。目录结构约定未在 gate 错误消息中说清楚——只说 "no spec_review_v*.md found"。
3. **YAML frontmatter closing `---`**：review 文件缺少 closing `---`，导致 frontmatter 解析失败。gate 报错 "no YAML frontmatter (no closing ---)"，但实际是有 opening `---` 的，只是没 closing。错误消息不够精准。
4. **must_fix 字段重复**：在 frontmatter 中同时有 `statistics.must_fix` 和顶层 `must_fix`，后者多余。

### What Would You Do Differently

- 一开始就把 review 文件放在 `changes/reviews/` 下，直接参考已有 project 的 review 文件格式做模板
- verdict 默认写 `pass`（如果 spec 本身质量 OK），不写 `pending`

### Key Risks for Later Phases

| 风险 | 说明 | 可能影响 Phase |
|------|------|---------------|
| Worker Thread 在 Electron 环境中的表现 | 测试在 Node.js 下通过，但 Electron 内嵌 Node 可能有差异 | Phase 3 dev |
| `structuredClone` 大对象性能 | PluginStorage 的大 value 写入可能慢，1MB 限制够用但极端场景可能不够 | Phase 2-3 |
| PluginService 和 ExtensionService 命名混淆 | 两者都是 "service" 且功能有重叠，开发者可能搞混 | 所有 Phase |
| 多 trusted 插件共享 Worker 的命名空间冲突 | Phase 1 不做模块隔离，trusted 插件间变量可能污染 | Phase 2 dev |

## Harness Usability Review

### Flow Friction

1. **Gate 错误消息不够精准**：第三次 gate 失败报 "no YAML frontmatter (no closing ---)"，但实际上是 closing `---` 缺失，不是完全没有 frontmatter。建议改为 "YAML frontmatter missing closing `---`"。
2. **Review 文件目录约定未文档化**：gate 要求 review 文件在 `changes/reviews/` 下，但错误消息只说 "no spec_review_v*.md found"，不知道正确的目录位置。需要看已有项目才能知道。

### Gate Quality

- Gate 检查准确识别了 4 个问题：verdict pending、review 文件缺失、缺少 must_fix 字段、YAML frontmatter 不闭合
- Gate 的 gate_review_1.md 是自动生成的反欺诈检查，覆盖 7 个检查项，内容合理
- 无 false positive——所有 flag 都是真实问题

### Automation Gaps

- **Review 文件模板缺失**：每次写 review 文件都要手写 YAML frontmatter 结构（review/statistics/issues），容易写错。建议提供一个模板或 scaffold 命令。
- **Gate 重试次数**：格式问题导致重试 3 次，如果 gate 能主动告诉 expected file path 和 expected frontmatter structure，重试次数会更少。

### Time Sinks

- 3 次 gate 重试 + 修复格式问题约占总时间的 ~30%
- 阅读已有 review 文件以理解格式约 5 分钟
- Spec 本身内容编写很快（已有调研和设计文档支撑），占总时间 ~40%

### Summary

Harness 体验整体可用但有小摩擦。Gate 检查的准确性高（没有误报），但错误消息的精度和修复指引可以改进。最大痛点是不熟悉 review 文件的 expected format——第一次写会踩坑。
