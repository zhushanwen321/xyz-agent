---
verdict: APPROVED
upstream: non-functional-design.md
reviewer: independent NFR subagent
---

# NFR 审查报告 — 前端 renderer ↔ runtime 集成（W11+）

## 1. Verdict

**APPROVED**

non-functional-design.md 已覆盖全部 12 个 issue 的 7 维度副作用分析，所有 ⚠️ 风险均配有可落地方案，残余风险登记表完整，矩阵中无 ❌ 不可接受项。当前 NFR 设计达到可向下游 code-architecture.md 推进的标准。

---

## 2. 五维评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 覆盖性 | 9/10 | 12 个 issue × 7 维度矩阵完整；每个 issue 均按 nfr-dimensions.md 模板展开分析。扣分点：部分标 ✅ 的维度仅用「残余风险：无」一句话带过，未显式说明「为何无风险」。 |
| 缓解可行性 | 8/10 | 所有 ⚠️ 风险均有具体缓解措施（execFileSync 数组参数、path 白名单、button disabled guard、debounce、virtual scroll、备份、timeout 等），可在现有架构内落地。扣分点：#5 Extension 安全风险的缓解最终依赖「用户确认 + 审计」，缺乏技术级纵深防御。 |
| 残余风险 | 9/10 | 登记表从 8 行扩展到 19 行，每条均含「影响、接受理由、监控方式」。扣分点：少数条目监控方式偏开发侧（如「开发时统计未取消订阅句柄数」），未明确线上/测试期如何实际采集。 |
| 无 ❌ 项 | 10/10 | 矩阵中无任何 ❌ 定级；所有风险要么无风险 ✅，要么已缓解 ⚠️ 并登记残余风险。 |
| 可观测性 | 7/10 | 关键风险均配置了日志/指标/告警（status 耗时、session.list 推送频率、widget payload 大小、未知 message 类型等）。扣分点：告警阈值后缺少响应动作/升级路径；部分矩阵中「可观测」列标 ⚠️ 但正文已覆盖较完整，图例语义可更清晰。 |

**综合评分：8.6/10**

---

## 3. 发现的问题

### 3.1 矩阵与正文粒度存在轻微不一致

部分 issue 在矩阵的「可观测性」列标为 ⚠️，但正文已明确给出日志、指标、审计、告警四项覆盖（如 #5 Extension、#10 FileView、#11 widget）。图例「⚠️ 有风险已缓解」在可观测维度上容易造成「覆盖不完整」的误读，建议将已配置完整可观测手段的单元格调整为 ✅，或在图例中增加说明。

### 3.2 #5 Extension 安装安全残余风险较高

缓解方案止步于「来源白名单 + 用户确认 + 审计日志」，对「用户确认后仍可能安装恶意 extension」的残余风险仅标注「deep 扫描超出本轮范围」。这是桌面应用的核心信任边界问题，建议至少追加后续 wave 的 hardening 计划（如 manifest 签名验证、运行期权限白名单、沙箱化 Worker）。

### 3.3 #6 compact 备份保留策略未设计

正文提到「可配置保留策略」，但未给出默认值、清理周期、磁盘上限。若长期不清理，`~/.xyz-agent/backups/` 可能无限增长，存在磁盘占用的隐性风险。

### 3.4 可观测性阈值缺少响应动作

例如：
- git status > 1s 时 warn → 是否自动降级为 `--untracked-files=no`？
- session.list 推送 > 10 次/秒时 warn → 是否触发采样或断连保护？
- widget payload > 1MB 时 warn → 是否触发分片或丢弃？

当前只记录了「监控方式」，未定义「达到阈值后的系统行为」。

### 3.5 性能目标缺少与当前基线的对比

虽然 Prototype 2 测得 50K 未跟踪文件 ~800ms、10K 跟踪文件 ~120ms，但未明确 xyz-agent 典型仓库规模（如项目自身 worktree）的实测基线，也缺少 GitZone 首次渲染 300ms 目标的验证计划。

---

## 4. 改进建议

| 优先级 | 建议 | 位置 |
|--------|------|------|
| P2 | 统一矩阵图例语义：对已配置完整可观测手段的 issue，将「可观测」列改为 ✅，或新增图例说明「⚠️ 表示存在可观测相关残余风险」。 | non-functional-design.md 矩阵与图例 |
| P2 | 在 #5 Extension 安全章节末尾追加后续 hardening 计划条目（签名验证 / 权限白名单 / 沙箱 Worker），即使不在本轮实现也应列入路线图。 | non-functional-design.md #5 |
| P2 | 为 compact 备份定义默认保留策略：例如保留 30 天 / 最大 1GB / 启动时清理过期备份，并在 code-architecture.md 中实现。 | non-functional-design.md #6 + code-architecture.md |
| P3 | 为关键告警阈值补充响应动作：warn 后是否降级、采样、限流或仅记录，形成「监控-响应」闭环。 | non-functional-design.md 各可观测性段落 |
| P3 | 在 implementation 阶段补充性能基线测试：对 xyz-agent 自身 worktree 执行 git status，记录首次渲染耗时，验证 300ms 目标。 | code-architecture.md / test plan |

---

## 5. 审查结论

当前 NFR 文档已达到收敛标准，无需回退任何方案。建议在进入 code-architecture.md 前，优先处理 P2 项（矩阵图例统一、Extension 安全后续计划、compact 备份保留策略），以避免下游设计时遗漏关键边界条件。P3 项可作为 implementation 阶段的补充要求。
