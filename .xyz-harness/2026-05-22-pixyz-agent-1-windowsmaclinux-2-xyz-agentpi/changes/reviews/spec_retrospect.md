---
phase: spec
verdict: pass
---

# Phase Retrospect: Spec

## 基本信息

| 项 | 值 |
|---|---|
| Phase | spec（Phase 1） |
| 目标 | 将 pi Bun binary + 预装 extension/skill 打包进 xyz-agent 安装包 |
| 交付物 | spec.md, infrastructure-scan.md, spec_review_v1.md, spec_review_v2.md |
| 评审轮次 | 2 轮（v1 发现 1 条 MUST FIX → v2 确认通过） |

---

## 一、Phase 执行质量

### 1.1 Brainstorming 流程顺畅度

**评分：良好**

spec.md 的 Background 章节清晰定义了三个痛点（用户需预装 Node.js、pi 版本不可控、extension/skill 需手动配置），然后直接给出解决方案。问题空间到方案空间的映射逻辑顺畅，没有过度发散。

**亮点**：
- "开箱即用"这个核心目标从一开始就是明确的，没有在方案选择上浪费轮次
- Decisions Made 表格将 5 个关键决策及其理由结构化呈现，Binary 形态选 Bun 编译而非 npm install 的理由（70MB vs 179MB）有数据支撑

**不足**：
- spec 未记录 brainstorming 过程中是否考虑过"让 pi 成为 npm workspace 依赖"这一替代方案。从 Decisions Made 表来看直接跳到了 Bun binary，中间的方案比较过程不可见。如果 brainstorming 确实只考虑了两种方案（npm global vs Bun binary），应该在 spec 中记录排除其他方案的理由；如果考虑了更多方案但没记录，说明 brainstorming 输出有信息损失。

### 1.2 问题澄清充分度

**评分：良好，v1 评审有效弥补了初始遗漏**

spec 初版在功能描述上覆盖全面（9 个 FR），但存在几个未澄清的假设：

| 问题 | 初版状态 | 评审后发现 | 最终处理 |
|------|---------|-----------|---------|
| Windows .exe 后缀 | 模糊（"可能带"） | v1 标记为 MUST FIX | v2 前直接决策为确定行为 |
| pi 版本来源 | 未提及 | v1 标记为 LOW | 确认为 env 硬编码 |
| 6 平台 vs 3 平台 | 有歧义 | v1 标记为 LOW | 补充说明段落 |
| process.cwd() = resourcesPath | 未验证假设 | v1 标记为 INFO | 明确化假设，加安全网 |
| buildProviderEnv() 是否存在 | 未确认 | v1 标记为 INFO | 留到 plan 阶段验证 |
| Git submodule CI 认证 | 未说明 | v1 标记为 INFO | 留到 plan 阶段细化 |

评审机制在这里起到了关键作用——初始 spec 有 6 处模糊点，评审全部捕获并分级处理。MUST FIX 要求立即解决，LOW/INFO 允许推迟到 plan 阶段，这个分级策略合理。

**风险点**：
- "process.cwd() = resourcesPath" 和 "buildProviderEnv() 是否已存在"这两个假设在 v2 中仍未验证，被推迟到 plan 阶段。如果 plan 阶段发现假设不成立，可能导致 FR-4 或 FR-5 需要大幅修改。这不是 spec 阶段的失职（spec 的职责是描述"要做什么"而非"怎么做"），但值得 plan 阶段优先验证。

### 1.3 设计决策合理性

**评分：良好**

5 个核心决策逐一评估：

| 决策 | 合理性 | 潜在风险 |
|------|--------|---------|
| Bun 编译独立 binary | 体积优势明显（70MB vs 179MB），无运行时依赖 | pi 官方 Bun binary 的成熟度和稳定性未知，spec 中未记录验证结果 |
| 严格不 fallback | 版本一致性保证，逻辑简单 | 如果 bundled binary 在某些环境下启动失败（如 glibc 版本不兼容），用户完全没有回退路径 |
| Provider 全部通过 UI 注入 | 配置集中管理，不硬编码 | 放弃了 pi 原生 `~/.pi/config.json` 的兼容性，已有 pi 用户需要迁移 |
| Git submodule | 版本关系明确 | 增加了仓库复杂度，submodule 更新和 CI 认证是额外维护成本 |
| extraResources（非 asar） | 技术上正确，可执行文件不能在 asar 内运行 | 无争议 |

**值得注意**："不与系统 pi 冲突"这个 AC-6 的验证方式是"在有系统 pi 的机器上安装打包的 xyz-agent，确认使用 bundled 版本"。但 spec 同时声明"不读 `~/.pi/`"——如果 config-store.ts 当前会 fallback 到 `~/.pi/config.json` 读取 provider 配置，那么 AC-6 和 FR-5（Provider 全部通过 UI）需要 plan 阶段确认 config-store.ts 的 fallback 逻辑在打包模式下是否会被跳过。infrastructure-scan 已经记录了这个风险点。

### 1.4 Infrastructure Scan 质量

**评分：优秀**

infrastructure-scan.md 是本次 spec 阶段最有价值的辅助产出。它完整映射了：

- 项目目录结构
- 5 层进程启动链（Electron Main → Sidecar → pi subprocess）
- 现有 API（findPiExecutable, RpcClient, EventAdapter, ConfigStore）
- 类型体系（25 种 ClientMessage + 33 种 ServerMessage）
- CI/CD 矩阵
- **明确的 Touch Points 清单**（打包需要改的 5 个位置）

这份扫描使得 spec 的 FR 不是空中楼阁——每个 FR 都可以对应到具体的代码文件和函数。评审时能快速判断"process.cwd() = resourcesPath 是假设"正是因为 infrastructure-scan 记录了 runtime-manager.ts 的行为。

---

## 二、Harness 体验

### 2.1 Skill 流程效率

**整体评价：高效，两轮评审即通过**

xyz-harness-brainstorming skill 引导了从问题定义到 spec 产出的流程。从交付物来看：

- spec.md 结构完整（Background → FR → AC → Constraints → Decisions → Out of Scope），符合 harness 模板
- infrastructure-scan 是自发产出（skill 未硬性要求），说明执行者有主动补全信息的意识
- 两轮评审的节奏合理：v1 发现问题，spec 修复，v2 确认通过，没有无效轮次

**可改进点**：
- infrastructure-scan 产出时间点不明确。从内容看它应该在 spec 写作之前完成（为 FR 提供事实基础），但如果它和 spec 是并行产出的，可能存在 spec 写了不可行方案后来又改的情况。建议 harness 流程明确：infrastructure-scan 是 spec 的前置步骤，先扫描再写 spec。

### 2.2 Gate Check 有效性

Gate check 要求 spec 阶段交付物包含：spec.md（带 YAML frontmatter）、评审报告（至少一轮，verdict: pass）。

**有效性评估**：
- ✅ YAML frontmatter 格式正确（`verdict: pass`）
- ✅ 评审报告有两轮，v1 标记 MUST FIX，v2 确认通过
- ✅评审分级机制（MUST FIX / LOW / INFO）有效运作，避免了"全有或全无"的二分判断

**发现的盲区**：
- Gate check 不检查 infrastructure-scan 的存在和质量。本次的 infrastructure-scan 质量很高，但如果某个 spec 阶段跳过了代码扫描直接写 spec，gate check 不会发现。建议将 infrastructure-scan 列为 spec 阶段的推荐交付物（非必须，但有的话质量更有保障）。
- v2 评审中"process.cwd() 假设"和"buildProviderEnv() 引用"仍标记为 INFO 未关闭，但 gate check 依然通过了。这是否合理？INFO 项本就不阻塞通过，但如果 INFO 项在 plan 阶段发现不成立，可能需要回溯 spec。建议 gate check 至少检查"是否有未关闭的 INFO 项"，不阻塞但作为提示。

### 2.3 工具改进建议

| 建议 | 优先级 | 理由 |
|------|--------|------|
| 明确 infrastructure-scan 在流程中的位置 | 中 | 避免扫描和 spec 写作并行导致的不一致 |
| 评审报告增加"plan 阶段需优先验证"标记 | 低 | 当前 INFO 项隐含了这一语义，但不够显式 |
| spec 模板增加"方案比较"段落 | 中 | 记录被排除的替代方案及其理由，减少后续回溯 |
| infrastructure-scan 列为 gate 可选检查项 | 低 | 提升交付物质量下限 |

---

## 三、总结

### 做得好的

1. **评审分级机制运作有效**：6 个问题被准确分级（1 MUST FIX / 2 LOW / 3 INFO），MUST FIX 在 v2 前修复，LOW/INFO 合理推迟，没有过度评审。
2. **Infrastructure scan 价值高**：将 spec 从"文档"提升到"有代码支撑的设计"，评审能据此发现假设性错误。
3. **决策有数据支撑**：Bun binary 选型有体积数据（70MB vs 179MB），Constraints 表格有量化指标。
4. **两轮评审无浪费**：每轮都产出了新的信息增量，没有重复检查已通过项。

### 可改进的

1. **方案比较过程不可见**：spec 只记录了最终决策，未记录备选方案和排除理由。
2. **两个关键假设推迟验证**：process.cwd() 和 buildProviderEnv() 的假设在 plan 阶段需优先确认。
3. **Git submodule CI 认证策略未说明**：公开/私有仓库的认证方式影响 CI 实现，应在 spec 中至少声明。

### 对 Plan 阶段的建议

1. **Task 0（首个 task）**：验证 `runtime-manager.ts` 是否已将 sidecar 的 cwd 设置为 `process.resourcesPath`，以及 `buildProviderEnv()` 的实际签名和行为。这两个假设如果不成立，会影响 FR-4 和 FR-5 的实现方案。
2. **优先实现 FR-4（运行时 Binary 发现）**：这是整个功能的卡点——binary 找不到，其他功能都无法验证。
3. **Windows CI 验证要早**：.exe 后缀虽然是已决策项，但 Windows CI 环境的路径行为（反斜杠、空格、权限）需要在开发早期验证。
