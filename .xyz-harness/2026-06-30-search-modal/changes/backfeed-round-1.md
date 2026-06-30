---
phase: nfr
entries: 1
tracer: independent-backfeed-subagent
date: 2026-06-30
---

# 反哺检查 Round 1 — nfr → architecture(②)/requirements(①)/issues(③)

> 独立 subagent，上下文与主 agent 隔离。检测 ④NFR 定稿（non-functional-design.md + D-021~D-025）是否引入与上游 ①requirements.md / ②system-architecture.md / ③issues.md 已拍板事实/决策矛盾的结论。
> 反哺纪律：只修订「事实性矛盾」或「设计假设被下游证伪」；下游「更优方案」不构成反哺理由；D-不可逆决策 → 必须 ask_user（标 NEEDS_USER_CONFIRM）。每处反哺须可追溯（[BACKFED from nfr]）。

## 反哺检查结论

逐上游 .md 核对 ④NFR（含 D-021~D-025 全部新增决策），检出 **1 处事实性矛盾**（①requirements 文件截断值未随 D-021 同步），其余 4 项重点反哺点（#17 / AC-6.9 / DTO 映射 / error 冒泡链）经核验均为 NFR 忠实执行上游机制或对上游未覆盖边界的合理补充，**不构成与上游矛盾的结论**。详见下表。

### 重点反哺点闭环核验（主 agent 已知 5 项）

| 反哺点 | 上游定位 | NFR 处理 | 一致性判定 |
|--------|---------|---------|-----------|
| **AC-4.7 500→5000（D-021）** | ①req:28/191 仍写「上限 500」；②arch 无该值；③issues:391 AC-4.7 已改 5000 | NFR:263/281 已用 5000 | ⚠️ **①矛盾未同步**（见检出 #1） |
| **新建 #17 WS 超时 race（D-023）** | ②arch §9 swimlane 用 allSettled，**未定义 WS 断连处理**；§6/§8 无 WS 层错误处理契约被推翻 | NFR:129 新建 #17 补 transport 层遗漏的兜底 | ✅ 补充②未覆盖边界，非推翻②（②无对立定义） |
| **AC-6.9 直调 fileApi.read（D-024）** | ②arch §9:279 swimlane `JO->>RT: file.read`（即直调 file.read）；§7:205 跳转编排分发 | NFR:182 要求直调 fileApi.read 不经 useDetailPane.openPreview 吞错层 | ✅ 与②§9 swimlane 一致（②本就是 JO 直调 file.read），细化②非推翻② |
| **DTO 映射（D-025）** | ②arch §4:55 SearchItem 是 DTO；classDiagram:95-96 已有「命令源转换」映射；§9:262 swimlane 注 file.search 返回 FileNode[] | NFR:154 要求 domain 做 DTO 映射（FileNode/SessionSummary/SessionCommand→SearchItem） | ✅ 补充②（②只画命令源转换，未明示 file/session 源映射），与②§9 FileNode[] 返回一致 |
| **error 冒泡链（K-1）** | ②arch:127「error 态原因由 api 调用 catch 表达（toast 反馈）」；无吞错层处理定义 | NFR:107 细化「domain 直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层」 | ✅ 实现层细化②（②无对立的吞错层定义），与②:127 catch+toast 方向一致 |

## 检出的矛盾

### 矛盾 #1：①requirements.md 文件截断值未随 D-021 同步（500→5000）

- **涉及上游 .md**：`requirements.md`
- **章节**：§1 达成路线（:28「上限 500」）+ §3 数据清单（:191「深度 8/上限 500」）
- **矛盾描述**：D-021（decisions.md:32，`ask_user` confirmed）已确认 `file-service.ts:59` 真实值为 **5000**（2026-06 已从 500 调整，旧值 500 会丢失根目录 AGENTS.md 等靠后文件）。③issues.md AC-4.7（:391）与 ④NFR（:263/281）均已反哺为 5000。但 **①requirements.md:28/191 仍引用旧值「上限 500」**——这是事实性陈述错误（描述 searchFiles 的既有属性），与已拍板的事实（D-021）矛盾。
- **是否 D-不可逆 / NEEDS_USER_CONFIRM**：否。D-021 分类为 `D-可逆`，且已 `ask_user` confirmed（非推翻决策，仅同步事实性数值）。属反哺纪律第 1 条「事实性矛盾必修订」，agent 可直接同步修订，无需再次 ask_user。
- **建议修订**：
  - ①requirements.md:28「上限 500」→「上限 5000」并加注 `[BACKFED from nfr on 2026-06-30] D-021 校正：file-service.ts:59 真实值 5000（2026-06 已从 500 调整，旧值 500 会丢失靠后文件）`
  - ①requirements.md:191「深度 8/上限 500」→「深度 8/上限 5000」并加同样 `[BACKFED from nfr]` 注
- **风险**：若不同步，下游 ⑤test-matrix 写截断测试用 5000、⑥验证用 5000，而 ①requirements 作为业务 SSOT 之一仍留 500，造成「同一事实两套数字」的文档漂移；且 D-021 rationale 明确点名「不修订会让⑤写测试用错阈值、⑥验证用错数字」，①作为溯源上游同样适用此风险。

## 其余逐上游核对（摘要，均 ✅ 无矛盾）

| 核对维度 | 上游源 | NFR 对应 | 一致性 |
|---------|--------|---------|--------|
| NFR 约束（UC-3 AC-3.4 >200ms loading） | ①req:119/234「>200ms 显示加载态，<200ms 不显示」 | NFR:230（#8 AH-S2 对齐）+ issues #8 AC-8.1 | ✅ NFR 正确体现阈值与防闪烁语义 |
| 分层/port/模型决策（D-011/012/013） | ②arch §6/§10 | NFR 未触碰，#1/#2/#9 全 ✅ | ✅ 遵守账本纪律 |
| 行为契约（②§12 BC-1~BC-12） | ②arch §12 | NFR #7 缓解项（MR-7.1 孤儿查询守卫）是 BC-11 生命周期副作用的细化，非推翻 | ✅ 细化非矛盾 |
| 缓解项落地方式（MR-* 回灌登记） | ②arch §7 签名表 / §9 swimlane | MR-4.1 loadSeq 迁移、MR-6.2 直调 fileApi.read、MR-17.1 超时 race 均落点与②§7/§9 模块定义一致 | ✅ 落点与②签名/契约相符 |
| ③issues AC 反哺（AC-4.7/4.10/6.9 + #17） | ③issues #4/#6/#17 | NFR「回灌去向=③」指针均指向 issues.md 真实存在的 AC（已 [BACKFED from nfr] 标注） | ✅ ③已闭环 |
| D-023 新建 #17（transport 层语义） | ②arch 无 WS 断连定义 | NFR 选方案 A（domain 层超时 race）非方案 B（改 transport 层），明确标注方案 B 超本期 scope 另开 topic | ✅ 未越界改 transport 共享基建 |

## 结论（nfr 阶段）

检出 **1 处事实性矛盾**（①requirements.md:28/191 截断值 500 未随 D-021 同步为 5000），建议按 [BACKFED from nfr] 标注同步修订（D-可逆，D-021 已 ask_user confirmed，无需再次确认）。其余 5 项重点反哺点（AC-4.7/4.10/6.9 + #17 + DTO 映射 + error 冒泡链）与上游 ①/②/③ 均无矛盾，③issues 反哺已闭环。**NEEDS_USER_CONFIRM：无**（唯一矛盾的 D-021 已是 confirmed 状态）。
