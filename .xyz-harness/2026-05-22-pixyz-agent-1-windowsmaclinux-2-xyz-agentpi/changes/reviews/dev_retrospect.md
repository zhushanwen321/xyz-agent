---
phase: dev
verdict: pass
timestamp: "2026-05-22"
target: ".xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi"
---

# Phase 3 (Dev) 复盘 — Bundle pi Binary into xyz-agent

## 概要

将 pi Bun 二进制 + 预装 extensions/skills 打包进 xyz-agent 的 packaged app。7 个 Task，分 BG1（Runtime 改动 4 文件）和 BG2（Build 配置 + CI 3 文件）两组并行执行。2 轮 code review 后通过，119 个测试全部通过。

---

## 一、Phase 执行质量

### 1.1 编码质量 — 优良

**优点：**

- **分层清晰**：RuntimeManager（主进程）只负责注入 `XYZ_AGENT_PACKAGED` env；ProcessManager（Sidecar）负责解析 env 并发现 binary；RpcClient 负责注入 `PI_CODING_AGENT_DIR`。三层各司其职，Sidecar 不依赖 Electron API，仅通过 env 感知打包模式，架构边界干净。
- **防御性编程到位**：`findPiExecutable()` 在打包模式找不到 binary 时抛出明确异常（含路径和 binary 名）；`config-store.ts` 用 guard `return null` 跳过 `~/.pi/` 读取；Windows `.exe` 后缀处理完备。
- **脚本复用**：`prepare-pi-resources.sh` 同时服务本地开发和 CI，一份脚本两条路径，减少维护成本。
- **路径安全**：binary 路径拼接使用 `join()` 而非字符串拼接；`process.cwd()` 假设已在 plan 的 Risk Notes 中验证无 `chdir()` 调用。

**不足：**

- **MUST FIX #1 暴露了实现遗漏**：`createSession()` 的 catch 块在打包模式下仍指向全局安装。Plan Task 2 Step 3 明确写了要添加打包模式分支，但首次实现遗漏了。这说明 executor subagent 在执行 plan 时走了 "happy path"（`findPiExecutable` 能找到 binary 的路径），没有系统性地检查每个错误路径是否也做了打包模式适配。
- **LOW #2 冗余日志未修复**：构造函数的日志在打包模式下与 `findPiExecutable()` 重复。这是 plan 中已经规划但在实现中遗漏的小细节。虽然不阻塞，但说明 "plan 已覆盖但执行遗漏" 的模式不止一处。

### 1.2 TDD 执行 — 合格但不充分

- 119 个测试（runtime 46 + frontend 73）全部通过，typecheck 和 lint 也干净。
- 但这些测试主要是既有回归测试，不是针对本次变更新写的。从 test_results.md 来看，没有新增测试覆盖打包模式分支逻辑的证据。
- **建议**：打包模式的 `findPiExecutable()`、`loadPiConfig()` guard、`createSession()` 打包模式 catch 分支，都值得有独立的单元测试（mock `process.env.XYZ_AGENT_PACKAGED` 和 `existsSync`）。这虽然不影响 dev phase 通过，但属于 Phase 4 (test) 应补齐的项。

### 1.3 Review 轮次效率 — 高效

| 指标 | 数值 |
|------|------|
| Review 轮次 | 2 |
| 总问题数 | 3 (MUST FIX 1, LOW 1, INFO 1) |
| MUST FIX 解决率 | 100% (1/1, 在 v2 解决) |
| v1 Review 覆盖面 | spec 合规 9 项全查 + 代码质量 + 架构合规 + 安全 + 集成验证 + CI 交叉检查 + 跨平台 |

**v1 review 的覆盖面非常全面**，这是整个 phase 质量的关键保障：
- 逐条核对 spec FR-1 到 FR-9，标记 FR-4 为 ⚠️（catch 块遗漏）
- 检查了两条关键数据流（`XYZ_AGENT_PACKAGED` 和 `PI_CODING_AGENT_DIR`）的端到端路径
- 验证了 `process.cwd()` 假设的可靠性
- 交叉检查了 CI 构建流程步骤顺序
- 跨平台 binary 命名和 PATH delimiter 验证

**v2 review 聚焦且高效**：只验证 MUST FIX 的修复，附带确认 LOW/INFO 状态不变，直接给出 pass。没有扩大审查范围，避免了无意义的二次全面扫描。

**等级判定校准**是 v1 的亮点：每个问题都附了判定依据，明确说明为什么 MUST FIX 而非 LOW。这避免了主观判断的模糊性。

### 1.4 MUST FIX 发现过程分析

MUST FIX #1 的发现路径值得复盘：

1. **Plan 阶段已规划**：Task 2 Step 3 明确要求修改 catch 块
2. **Executor 遗漏**：首次实现只关注了 `findPiExecutable()` 的主路径，遗漏了 `createSession()` 的错误路径
3. **Reviewer 通过 spec 合规检查发现**：v1 逐条核对 FR-4 时，发现 "运行时 Binary 发现" 的 catch 分支未适配打包模式

**根因**：plan 中的 Step 描述是独立的小任务，executor 容易逐条执行后认为"完成"，不会系统性回溯 "所有与 pi binary 相关的代码路径是否都已适配"。Reviewer 的 spec 合规检查正好弥补了这个盲区。

**改进建议**：plan 的 Task 2 可以在 Step 列表末尾加一条 "完整性自检"：`grep -n 'pi' process-manager.ts | grep -v '//'`，列出所有涉及 pi 的代码行，确认每一行都考虑了打包模式。

---

## 二、Harness 体验

### 2.1 Skill 流程评价

**Plan 质量极高**：plan.md 的 Task 拆分、Step 级别的代码示例、BG1/BG2 并行分组、依赖图和 Risk Notes 都非常扎实。特别是：
- 每个都有精确的文件路径和行号
- 代码示例直接可粘贴，减少了 executor 的理解成本
- Risk Notes 提前识别了 `process.cwd()` 假设和 Windows `.exe` 后缀风险

**执行模式有效**：BG1/BG2 并行无依赖，实际执行中也没有文件冲突。Plan 的 "Wave Schedule" 设计（Wave 1 并行 → Wave 2 集成测试）是合理的。

**不足**：
- Plan 没有包含 "自检 checklist" 或 "完成后验证步骤"。每个 Task 有 commit step 和 typecheck step，但没有 "回溯检查所有改动点是否完整覆盖 spec 要求" 的步骤。MUST FIX #1 的遗漏部分归因于此。

### 2.2 Gate Check 评价

Gate check 在 dev phase 发挥了应有作用：
- v1 review 发现 MUST FIX → gate 返回 fail → 修复 → v2 review 确认通过 → gate 返回 pass
- Review 不是走过场，确实拦截了一个 spec 合规缺陷

**流程效率**：2 轮 review 对于 7 个 Task 的改动规模来说是合理的。1 轮通过说明执行质量极高，但也不现实；3 轮以上说明计划或执行有系统性问题。2 轮是健康区间。

### 2.3 改进建议

| 维度 | 现状 | 建议 |
|------|------|------|
| Plan 自检 | 每个 Task 有 typecheck 验证 | 在每个 BG 结尾加 "spec FR 回溯 checklist"，逐条确认所有 FR 在本 BG 的改动中被覆盖 |
| 测试覆盖 | 119 个既有测试全部通过 | Phase 4 应补充打包模式分支的 mock 测试 |
| Review 模板 | v1 已有等级判定校准 | 在 review 模板中加入 "plan Step 覆盖率检查"：对比 plan 中每个 Step 是否有对应的代码变更，发现遗漏 |
| LOW/INFO 追踪 | v1 标记、v2 确认未修复 | 建立 backlog 跟踪 LOW/INFO 项，避免在后续 phase 被遗忘 |

---

## 三、数据总结

| 指标 | 值 |
|------|---|
| Plan Tasks | 7 |
| 实际修改文件 | 10 (4 modify + 4 create + 2 submodule) |
| Review 轮次 | 2 |
| MUST FIX | 1 (已修复) |
| LOW | 1 (未修复，不阻塞) |
| INFO | 1 (外部依赖，不阻塞) |
| 测试总数 | 119 (全部通过) |
| TypeCheck | 0 errors |
| ESLint | 0 errors (3 pre-existing warnings) |
| Spec FR 覆盖率 | 9/9 (8 完全通过, 1 需 v2 修复后通过) |

---

## 四、结论

Phase 3 整体执行质量优良。Plan 的颗粒度和精确度是关键成功因素——每个 Task 的代码示例和文件路径让 executor 几乎不需要做额外的探索。v1 review 的 spec 合规检查是安全网，准确拦截了 executor 在错误路径上的遗漏。2 轮 review 的节奏健康，gate check 机制运行有效。

主要风险点：MUST FIX #1 反映出 "plan 有但执行遗漏" 的模式。这不是 harness 流程的缺陷（review 成功拦截了），而是 executor 执行层面的改进空间。通过在 plan 中增加 BG 级别的 spec FR 回溯 checklist，可以进一步降低这类遗漏的概率。
