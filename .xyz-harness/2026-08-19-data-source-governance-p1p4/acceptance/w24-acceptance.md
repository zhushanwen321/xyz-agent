# W24 验收标准：R2 从直呼形态收紧到调用图

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §6 W24 节（L724-745）是 W24 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W2、W13（renderer 写入口收敛完成——许可表稳定）。
> **附带扩围（W4 verifier 裁决遗留）**：R3 扫描范围从 renderer stores/ 扩到全仓 renderer/core（W4 时实测 17 处 stores 外模块级缓存——本 wave 补注解或豁免登记，规则 docstring「范围裁定」节同步更新）。

## 目标（一句话）

R2 store 写入口检查从「拦直呼形态」升级为「跨文件调用图分析」——mutation 只能被 owner 文件（登记表 owner 列）调用，一层转发起步。

## 交付物

1. `taste-lint/rules/no-non-owner-store-mutation.mjs`（修改：import 直呼 → import 边调用图分析——复用 scripts/check-domain-boundaries-node.mjs 的 import 边分析思路；检测文件 import store 后经任意中间函数转发调用 mutation（一层起步）；**若 mjs 规则体系不适合调用图分析，允许落在 scripts/ 的 node 扫描器体系并同步退役 mjs 骨架——二选一 wave 内定案并汇报理由**；allowlist 先例对齐该脚本现状）
2. 许可表驱动：从登记表 markdown 表格解析 owner 列，或读配置（W6-W8 实例形态）——两形态都实现「许可表来自登记表」即合规
3. R3 扩围：require-data-owner-annotation.mjs 扫描范围扩到全仓 renderer/core + 存量 17 处补 @data-owner 注解（条目引用登记表；不可注解的走豁免清单 + 登记表同步）
4. 误报豁免闭环沿用 W4 约定

## 通过命令（builder 自验 + verifier 实跑）

1. 收紧证明：构造三层转发违规（文件 A import store → 函数 f 转 → f 内调 mutation）→ 新版报错、W4 直呼版不报（超集不是替换——W4 直呼用例保留且通过）
2. `pnpm run lint` 全仓绿（存量无违规）；`cd packages/renderer && pnpm typecheck && pnpm test` + CORE_TEST 绿
3. 行为级（场景 4①机器层）留 P4 gate：转发调用被拦；③语义违规机器层不拦 = 预期（S1 拦）
4. 规则自检：node --test 用例更新全过（含三层转发用例 + R3 扩围用例）

## 禁改清单

- 验收权威文档；登记表（豁免登记草稿制——主 agent 落表）；生产代码（补注解注释行除外）
- 禁 git 写操作；禁 eslint-disable 静默

## 备注

- 完成后 P4 剩 W25。
