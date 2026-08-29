# 审查报告：panel-view-derivation-and-flow-lifecycle.md（Round 1）

> 审查者：tech-design-review agent（对抗式）。结论：方案部分成立——终态架构方向有效，但根因链支柱事实（send 抛错路径）被源码证伪、删唯一会话行为漂移未覆盖。2 must-fix，7 suggestions。

## Must-Fix

1. **§2.2 路径 2 / §3.1 场景 A / D3 / V1 根因链证伪**：`useChat.send` 内部 catch 全部错误只 toast 不 throw（useChat.ts:432-443，W2 策略），`transition('completed')` 在 send 失败时总会执行——「send 抛错卡 landing」现行不可达。V1 验收无区分度。
2. **D1/D5 删唯一会话行为漂移**：deleteSession 删空后 sessionId=null、flow=idle，现行 isLandingView=!sessionId 恒 true → Landing 自动 startFlow；终态 landing 需 isFlowActive → 落入无输入面死态 empty。

## Suggestions

1. D1/D5 empty 定义两处不一致（应直接给最终形态带 sessionId 字段）
2. dead + ask-user 组合未定义（应明确 ⟺ conversation && input==='ask-user'，保留 W6 语义）
3. D2 未声明 dead+streaming 残留组合的行为变化
4. V3 步骤「Esc 取消」不可执行（landing 态无 Esc 绑定）
5. 文件改动地图漏 constraints.json 及 render-constraints 命令
6. WidgetArea 挂载条件在 switch 重写中的归属未说明
7. isTraceView + sessionId=null 组合语义未定义（应补前置约束）

## 已核实为真的关键事实

- Panel.vue:192-197 显隐判据、isLandingView/isSessionActive/isCompacting 定义逐字吻合
- flow-state.ts 单例/10 态/ALLOWED/ACTIVE_STATES、flow.ts startFlow 清 activeId、transition 位置属实
- selectSession 守卫（useSidebar.ts:160-163）、Landing onMounted startFlow（Landing.vue:89-95）属实
- panel.ts 单 panel、Workspace.vue:16 flow.isActive 消费属实
- D4 守卫无非法转换（ACTIVE 态 → cancelled 均合法）、时序论证与代码顺序吻合

## Round 1 修订记录（主 agent）

- §2.2 路径 2 重写为「现行不可达 + 诊断不确定性声明」；终态目标改为「无论 state 因何残留，结构免疫」
- 场景 A / D3 / V1·V1' 重写（结构免疫实证 + 现行行为不回归）；D3 论证改「时序正确性 + 防御加固」
- 新增 D7（deleteSession/deleteFolder 删空编排 startFlow）+ V3'；D1 empty 最终形态 + dead/trace 前置约束；D2 行为变化声明；D5 ask-user/WidgetArea 归属；V3 步骤修正；文件地图补全

# Round 2 复审报告（摘要）+ 修订记录

结论：方案成立（修复 1 处后可进入实施）。1 must-fix, 3 suggestions。

- MUST_FIX：V1' 场景构造矛盾（断 WS 先杀 createSession 而非 send，「session 已建 + send 失败」窗口毫秒级不可手工构造）
- S1：D7 漏 deleteSession/deleteFolder 各自的 S4 兜底分支（共 4 处空态出口）
- S2：__setFlowStateForTesting 钩子破坏 transitionUnchecked 类型锁，应换 Vue devtools 直改 pinia
- S3：恢复指引「残留不可能发生」与诊断声明口径矛盾
- INFO：检查点① startFlow 竞态不成立（体内无 await）；「turn 活跃+无消息」组合预期应标注

## Round 2 修订记录（主 agent）

- V1' 重写为 createSession 失败场景（toast + Landing 停留 + 重连重发到 completed）
- V1 改 Vue devtools 直改 store（删测试钩子，T2 同步删）
- D7 扩为 4 处空态出口统一 helper；恢复指引用词修正；检查点①竞态句删除 + 边界组合标注

# Round 3 收敛确认（摘要）

结论：收敛。0 must-fix, 0 suggestion, 2 info（均已顺手处理：D7 括号改功能性描述并标注 newSession L258 排除项；T4 行同步 4 处定义）。文档进入实施。

审查历程：Round 1（2 must-fix + 7 sug：根因链证伪重写为结构免疫论证 / D7 空态承接）→ Round 2（1 must-fix + 3 sug：V1' 构造矛盾重写 / D7 扩 4 处 / V1 改 devtools）→ Round 3（收敛）。

# 实施记录（dev-flow，2026-08-29）

单元 T1-T5 全部 committed，全量验证：core 1267 passed | renderer 3594 passed | ui 550 passed，三包零失败；双端 typecheck / eslint / vue_rules_checker 全绿；constraints 登记 C-state-09（derivePanelView 唯一派生入口）并经 render --check 校验（83 条）。

偏差登记（一致性审查待裁决项汇总）：T2×4（transition 精确落点 pushChat 后 loadTree 前 / TC-6e 增强断言 / flow-integration 重试用例按新语义改写 / 补修内容被并行会话 commit 820a8700c 携带入库）；T3×7（core session/index.ts 一行导出经用户授权 / widget-area co-located 测试纳入 / v-if 链等价 switch / empty-with-session 防御性判据保留 / 用例③行为等价落地 / 2 个既有测试按新判据更新）；T4×3（守卫测试追加在既有 landing.test.ts / flowMock 补齐三成员 / D7-U6 用 currentCwd 等价断言）；T5×2（authority 相对路径对齐 / ui-consistency 枚举未入 _meta）。
