---
frame: structure
round: 1
perspectives: [3-layering, 4-dependency]
converged: false
created_at: 2026-06-28
---

# 结构帧追踪 · Round 1（视角3 分层纪律 + 视角4 依赖边界）

> 追踪对象：system-architecture.md（初稿）｜对照：runtime-three-layer-design.md + git-service.ts（既有范式）
> 决策账本 D-001~D-012 全 confirmed，不重报。

## Gap 汇总表

| ID | 视角 | 类型 | 严重度 | 位置 | 一句话 |
|----|------|------|--------|------|--------|
| **GAP-S1** | 4(+1交叉) | F/D | 🔴 高 | §3/§4/D-012 | FileNode 带 gitStatus? 打包两种生命周期字段，与 D-012「分离避免树重建」冲突，且 §4 不变式未列 gitStatus，自相矛盾 |
| **GAP-S2** | 4(+协议) | F/D | 🔴 高 | §9.1 vs §10 D-012 | file.tree 响应是否带 status：泳道图画两步（无标注），D-012 说可一步合并，协议设计矛盾 |
| **GAP-S3** | 3 | [REVISIT of D-008] | 🟡 中 | §6/§2/git-service.ts:26 | IIgnoreReader 用 port 与 git-service 纯函数豁免范式（git-status-parser）不对称 |
| **GAP-S4** | 3 | F/D | 🟡 中 | §6/§9.2/§12 BC-3/three-layer:149 | file.read 内容读取路径不明；现状 transport 直接 fs 违反三层纪律，D-010④ 仅裁决放开权限未裁决重构进 service |
| **GAP-S5** | 3 | F/D | 🟢 低 | §6 vs §9.1 | IFileExecutor.readdir 是否带 depth 参数未定义；带则 executor 承担递归编排（违反薄 IO） |
| **GAP-S6** | 4(+1交叉) | F | 🟢 低 | §3/§4 vs §9.1/§11 AC-5 | FileNode（runtime DTO）vs TreeNode（前端既有类型）未区分；是同一类型还是 DTO→渲染类型映射 |

## 详细追踪

### 视角 3: Layering Discipline
- L3-Check 1/2（核心计算+分层深度）：✅ 通过（§2 明确技术编排 + 三层沿用）
- L3-Check 3（依赖方向）：⚠️ 表达不全（层级图未画依赖倒置 U 型箭头，文字 §6 补了，非硬伤）
- L3-Check 4（核心层零外部依赖）：⚠️ **GAP-S4**（file.read 现状 transport 直接 fs 违反 three-layer:149「transport 不碰 node:内置」）
- L3-Check 5（空壳层）：✅ 通过
- L3-Check 6（伪 port）：IFileExecutor port 真实✅；**GAP-S3** IIgnoreReader 存疑（git-service.ts:26 实证 GitService 直接 import infra/git-status-parser 纯函数豁免，不包 port，与 §2 声称的「范式对称」矛盾）；**GAP-S5** readdir depth 语义未定义
- L3-Check 7（port 价值定位）：✅ 通过（IIgnoreReader「可替换库」价值偏弱，措辞非 gap）

### 视角 4: Dependency Boundary
- D4-Check 1（循环依赖）：✅ 通过
- D4-Check 2（上帝对象）：✅ 通过（最大 DetailPane ~200 行）
- D4-Check 3（扁平 struct 打包不同生命周期）：🔴 **GAP-S1**（FileNode §3 带 gitStatus? vs §4 D-012 解耦，自相矛盾）
- D4-Check 4（boolean flag）：✅ 通过（用 Status 枚举）
- D4-Check 5（interface 过度抽象）：✅ 通过
- D4-Check 6（deletion test）：见 L3-Check 6
- **GAP-S2**（§9.1 泳道两步取数 vs §10 D-012 一步合并，协议矛盾）
- **GAP-S6**（FileNode vs TreeNode 命名/契约未区分）

## CONVERGED: 否
6 个 gap 待处理。GAP-S1/S2 文档自相矛盾硬伤最高优先级。
