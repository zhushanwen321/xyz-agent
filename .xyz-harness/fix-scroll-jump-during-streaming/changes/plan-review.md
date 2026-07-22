# Plan Review: fix-scroll-jump-during-streaming

## 审查方法

plan 改动面极小（1 Wave 改 1 文件加 guard），禁读重建的价值集中在 coverage 维度（6 个细 FR 是否都被 W1 覆盖）。主 agent 直接对照 spec 重建的 6 FR 逐条映射 W1 description，未派 subagent（单 Wave 单文件场景，重建成本 > 收益）。

## 审查范围

- coverage：6 个细 FR（重建所得 FR1-FR6）→ W1 description 映射
- architecture：单 Wave 单文件，无拆分/依赖问题可审
- feasibility：changes 描述可执行性

## FR 覆盖映射（coverage 维度核心）

| 细 FR（spec_review 重建） | W1 description 对应点 | 覆盖 |
|--------------------------|----------------------|------|
| FR1 不施加 scrollTop += delta | 第 2 点 stickToBottom=false 分支跳过 | ✓ |
| FR2 清零丢弃不延后 | 第 2 点 + 第 3 点「两个分支都清零」 | ✓ |
| FR3 贴底分支不变 | 第 2 点 stickToBottom=true 分支保留原逻辑 | ✓ |
| FR4 不动 scrollToBottom 路径 | 约束段「不修改 useChatScroll.ts 对外 API」 | ✓ |
| FR5 读最新 stickToBottom | 约束段「watch 回调内读，非调用时捕获」 | ✓ |
| FR6 guard 留消费侧不下沉 | 约束段「不下沉到 useVirtualTurnList」 | ✓ |

spec 提交的粗粒度 FR-1/FR-2/FR-3（3 条）是重建 6 FR 的合并表述：
- spec FR-1「不补偿」= 重建 FR1 + FR2
- spec FR-2「贴底不变」= 重建 FR3
- spec FR-3「回归底部恢复」= 重建 FR2 的「清零」自然涵盖（不残留 = 回归后正常）

CW 的 "FR-1, FR-2, FR-3 可能未覆盖" warning 是编号不匹配（spec 用 FR-N，plan 用 FR1/FR2 细 FR），非真覆盖缺口。

## 发现的问题

无。单 Wave 单文件 bugfix，FR 全覆盖，架构无可挑剔处，changes 可执行。

## 审查结论

plan 就绪进 tdd_plan。W1 description 已明确 6 个细 FR 的覆盖点 + 三条约束（不动 API / 读最新值 / 不下沉），实现时遵循即可。
