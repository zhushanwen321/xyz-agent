# Plan Review — system-prompt-config

日期：2026-07-16 · 审查方法：禁读重建（fresh subagent 仅从 spec FR/AC 重建 wave 拆分，不读 dev-plan.json）+ 三维度审查

## 1. 审查范围与 diff 结果

盲重建产出 10 wave 方案 vs 初稿 8 wave（W1 验证+插件 / W2 协议+配置+handler / W3 插件注册 / W4 替换链路 / W5 前端数据层 / W6 UI / W7 打包 / W8 文档）。

| 盲重建发现 | 初稿状态 | 判定 |
|---|---|---|
| shared 协议应独立 wave，且 16000 上限放 `shared/constants.ts` 作 SSOT（前端 UI 提示/计数也要用） | 上限埋在 config-service，协议+服务+handler 混在 W2（4 文件两层） | **PR1/PR2 should-fix** |
| 新建独立 system-prompt-service.ts 而非扩展 config-service | 初稿扩展 config-service | nit（不采纳：config-service 已有 loadAppConfig/saveAppConfig 与 IConfigService 注入点，新服务要多动组合根+接口，违背最小改动；corrupted 语义用 JsonStore 即可承载） |
| 测试文件列在 wave changes 里 | 初稿不含测试文件 | 无问题（CW 的 tdd_plan 阶段统一写红灯测试，dev-plan 本就不含 testCases；重建方不知此流程约束） |
| UI wave 拆 section 与 modal 两波（防 5 文件超标） | 初稿 W6 为 4 文件（page+modal+2 locale） | nit（第 5 个文件是测试，归 tdd_plan，wave 不超标） |
| 验证脚本拆两个（CLI 语义 + hook 契约/env 可达性） | 初稿一个脚本覆盖两项 | nit（单脚本两节即可；env 可达性检查已纳入脚本实现要点） |
| 插件文件创建与注册（runtime-env/extension-service）合波 | 初稿分 W1/W3（dependsOn 衔接） | nit（拆分有依赖衔接，不影响正确性） |
| 生效时机读取位置：spawn 三处实时读、插件每轮读、防抖只作用快照 | 初稿 W4/W1 描述均已覆盖 ✓ | 无问题 |
| FR→wave 映射无断档 | 初稿 FR-1~7 全覆盖 ✓ | 无问题 |

## 2. 问题清单（进 CW tracking）

| id | severity | dimension | 描述 | ref |
|---|---|---|---|---|
| PR1 | should-fix | architecture | W2 混合 shared 协议层与 runtime 服务/handler 层（4 文件跨两层），建议拆为 shared 协议 wave + runtime 配置/WS wave，依赖链更准确（前端数据层只需依赖协议 wave） | W2 |
| PR2 | should-fix | coverage | 16000 长度上限缺 shared/constants.ts SSOT，前端 UI（计数/提示）与 runtime 校验需共用同一常量 | FR-7 |

## 3. 三维审查结论

- **coverage**：FR-1~7 与 AC-1~11 均有 wave/验证路径落地，除 PR2 外无断档。
- **architecture**：依赖链无环；W2 跨层混合（PR1）是唯一结构性问题；打包独立 wave（W7）满足规则 #12。
- **feasibility**：各 wave 均可在一个 dev cycle 完成；验证脚本前置依赖正确；无未识别外部条件。

**结论**：无 must-fix。2 条 should-fix 采纳，经 `cw replan --plan` 修订：W2 拆为「shared 协议+constants」与「runtime 配置服务+WS handler」两波，constants.ts 加入上限 SSOT，其余 wave 顺延重编号。

## 4. 复查（turn 2）

replan 后核对：PR1→新 W2（protocol+constants）/新 W3（config-service+interfaces+handler）已拆分，W6 依赖 W2、W5 依赖 W3 ✓；PR2→constants.ts 已入 W2 changes，config-service 描述引用 SSOT ✓。9 wave 依赖链无环，文件数均 ≤4，FR-1~7 覆盖无断档。无新问题，提交空 issues 进 tdd_plan。
