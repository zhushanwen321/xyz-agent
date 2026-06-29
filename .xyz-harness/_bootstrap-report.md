# 项目文档基建报告（Bootstrap Report）

> 生成时间：2026-06-29
> 触发：design-init 文档清单扫描 + 用户要求建立完整文档体系

## 文档清单状态

### ✅ 必备
- **CLAUDE.md** (417 行) — 主配置 SSOT。新增「Runtime broadcast 时序竞争」架构不变式（源自 slash-command-fix 复盘）
- **AGENTS.md** (17 行) — 指向 CLAUDE.md + docs/standards.md 的指针
- **README.md** (205 行) — 项目说明
- **CONTEXT.md** (35 行) — design workflow 精简统一语言。补充 Generating State / Tool Approval 术语

### ✅ 推荐（本次新建/补全）
- **ARCHITECTURE.md** (83 行) — **新建**。入口式索引，指向 docs/architecture/ 子文档群 + 架构不变式速查（不重复 docs 细节）
- **PRODUCT.md** (103 行) — 补「现状锚点」「功能边界」「非目标/DEFERRED」三章节（原 74 行偏愿景）
- **NFR.md** (63 行) — **新建**。7 维度非功能约束（安全/数据/性能/并发/稳定性/兼容性/可观测性），每条带验证来源

### ✅ 可选（本次新建）
- **TEST-STRATEGY.md** (106 行) — **新建**。测试体系 SSOT：框架/分层/三视角模型/回归基线/mock 策略/pre-commit/覆盖率
- **DESIGN-LOG.md** (103 行) — **新建**。50+ topic 按领域归类 + 关键决策节点

## 关键决策

1. **ARCHITECTURE.md 入口式**：不复制 docs/architecture.md 内容（避免双源漂移），作为 design workflow 入口 + 不变式速查，指向 docs/
2. **TEST-STRATEGY.md 不与 CLAUDE.md 冲突**：CLAUDE.md「测试规范」是规则载体（带 [HISTORICAL] 事故），TEST-STRATEGY.md 补充分层策略/运行手册/mock 细节，两者互补
3. **DESIGN-LOG 按领域归类**：50+ topic 按项目起点/Runtime/新建任务/Composer/Skill/Plugin/导航/渲染/TUI 分组，而非纯时间线
4. **CONTEXT.md 精简版**：保持指向 docs/architecture/context.md 完整版，只补遗漏核心术语（Generating State / Tool Approval）

## 信息来源

- `.xyz-harness/` 下 10+ 关键 spec.md（hello-pi / instance-isolation / agent-run-block-refactor / clarify-plugin-phase1 等）
- `docs/architecture/` 现有架构文档群（architecture.md / runtime-three-layer-design.md / runtime-module-map.md / context.md / standards.md / design.md）
- CLAUDE.md 现有规则（关键规则/架构约定/安全约束/测试规范）
- 源码核实（NewTaskFlow 8 态、workspace 命名 @xyz-agent/frontend|shared）

## 下游衔接

文档基建就绪，design-closeout 后续可把稳定结论沉淀进：
- ①需求澄清结论 → PRODUCT.md
- ②架构设计结论 → ARCHITECTURE.md + docs/architecture/
- ④非功能分析结论 → NFR.md
- ⑥执行计划/测试 → TEST-STRATEGY.md（回归基线）
- 跨主题导航 → DESIGN-LOG.md
