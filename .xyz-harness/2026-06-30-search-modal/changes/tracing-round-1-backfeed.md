---
verdict: pass
upstream: non-functional-design.md
downstream: issues.md
backfed_from: []
converged: false
---

# Tracing Round 1 — 视角3 回灌完整性（反向覆盖）

> 独立回灌指针重建。先从 issues.md 真相源重建 issue 清单，再反向核对 NFR 缓解项回灌登记表里每条 ③指针 是否真实存在 + 属性一致。
> ⑤ 指针（MR-3.1/MR-3.2/MR-4.1/MR-4.2 → ⑤test-matrix/⑤骨架）按约定不核查（延期承诺，闭环由⑤来源 B 接住）。

## 重建的 issues.md issue 清单（从 issues.md 独立重建，非按 NFR 表锚定）

| # | P 级 | 标题 |
|---|------|------|
| #1 | P0 | 匹配引擎提取为纯函数模块 |
| #2 | P0 | 命令注册表（command store 扩展 + useCommandRegistry composable）|
| #3 | P0 | recents composable（localStorage 持久化）|
| #4 | P1 | search real domain（编排 4 数据源查询）|
| #5 | P1 | api/index.ts 接线（search mock→real 切换）|
| #6 | P1 | 跳转编排（选中项分发）|
| #7 | P1 | SearchModal 改造（接入新模块，收敛为纯 UI 交互）|
| #8 | P1 | loading 态 + error 态（核心闭环质量契约）|
| #9 | P2 | Tab 切类（类型过滤）|
| #10 | P2 | 搭便车 2 项（待⑤骨架验证确认）|
| #11 | P3 | 符号搜索真实数据（延后）|
| #12 | P3 | 文件内容全文搜索（延后）|
| #13 | P3 | 危险命令分级与二次确认（延后）|
| #14 | P3 | 会话跳转进概览视图（延后）|
| #15 | P3 | ⌘1…⌘5 直达类型快捷键（延后）|
| #16 | P3 | 跨项目检索 scope 过滤条（延后）|

## 回灌表 ③指针 diff（PHANTOM / MISMATCH / ORPHAN 分类）

NFR 缓解项回灌登记表中「回灌去向含 ③issues」的行共 4 条（MR-4.3 / MR-6.1 / MR-7.1 / MR-8.1），逐条核对：

| 缓解项 | 指向 | 核对结果 | 分类 |
|--------|------|---------|------|
| MR-4.3 | ③issues #4 AC-4.7 | ⚠️ AC-4.7 **存在**但**值不一致**：NFR 表写 `MAX_SEARCH_RESULTS=5000`（MR-4.3:208、残余风险:222、详细分析:90 均一致，且引用 `file-service.ts:59`），而 issues.md:388 AC-4.7 仍写 `MAX_SEARCH_RESULTS=500`（`file-service.ts:52`，示例文案「仅显示前 500 项」）。NFR/源码/D-021 正确，issues.md 文本尚未反哺 | **MISMATCH** |
| MR-6.1 | ③issues #6 AC-6.5/6.6/6.7/6.8 | ✅ 四个 AC 编号在 issues.md #6（:506-509）全部真实存在，属性（异常/异常恢复、toast+浮层保持）一致 | 一致 |
| MR-7.1 | ③issues #7 AC-7.14/7.15 | ✅ 两个 AC 编号在 issues.md #7（:588-589）全部真实存在，属性（并发竞态/性能·debounce 清理）一致 | 一致 |
| MR-8.1 | ③issues #8 AC-8.4 | ✅ AC-8.4 在 issues.md #8（:652）真实存在，属性（资源·setTimeout clearTimeout）一致 | 一致 |

**PHANTOM（指针指向不存在的 #N/AC）**: 无。4 条 ③指针指向的 issue 编号与 AC 编号均真实存在。
**MISMATCH（属性不一致）**: 1 条（MR-4.3 / AC-4.7 值与文件行号过时）。
**ORPHAN（issues.md 声称来自 NFR 回灌但表无登记）**: N/A — issues.md issue-template 无「来自 NFR 回灌」来源标注字段，按约定跳过。（注：issues.md 部分 AC 带 AH-* 异常猎手标注，如 AC-7.13(AH-B3)/AC-4.8(AH-E5)/AC-8.5(AH-S1) 等未在 MR 表单独登记，但这些是行为型 AC 本身即自洽验收，不属「需 NFR 缓解但漏登记」范畴，非 orphan。）

## Gap 清单

### G-BF1 [D] issues.md #4 AC-4.7 反哺未闭环（MAX_SEARCH_RESULTS 值过时）
- **现象**: issues.md:388 AC-4.7 仍写 `MAX_SEARCH_RESULTS=500`（`file-service.ts:52`，文案「仅显示前 500 项」）；NFR 回灌表 MR-4.3 / 残余风险 / 详细分析均已按 D-021 校正为 `5000`（`file-service.ts:59`）。
- **方向**: NFR→issues 反哺（反向覆盖）。NFR 侧已正确，issues.md 侧文本待同步。
- **性质**: 反哺执行缺口，**非新决策**——D-021 已 confirmed（"AC-4.7 反哺修订：引用值从 500 校正为 5000"），仅 issues.md AC-4.7 文本编辑未落地。不构成对 D-021 的 gap 重报，而是 confirmed 决策的反向传播未闭环。
- **影响**: ⑤写测试 / ⑥验收若直接读 issues.md AC-4.7，会沿用错阈值 500（而非真实值 5000），且 `file-service.ts:52` 行号过时（真实在 :59）。
- **修复**: 将 issues.md:388 AC-4.7 的 `500`→`5000`、`file-service.ts:52`→`file-service.ts:59`、示例文案「前 500 项」→「前 5000 项」同步反哺，与 D-021 + NFR 三处对齐。
- **为何标 D 而非 F**: 事实判定已在 D-021 confirmed，残留的是文档同步执行（D=doc/backfeed），非待重新判定的事实争议。

## 结论

③指针编号无 PHANTOM；4 条 ③指针中 3 条（MR-6.1/MR-7.1/MR-8.1）完全一致，1 条（MR-4.3/AC-4.7）存在**值过时 MISMATCH**（NFR 正确、issues.md 待反哺，D-021 已 confirmed 但文本未传播）。`converged: false`——待 issues.md AC-4.7 文本反哺后此视角收敛。
