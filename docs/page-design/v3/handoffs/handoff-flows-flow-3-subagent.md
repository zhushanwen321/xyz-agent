# Handoff · flows · flow-3-subagent

## 1. 路径
- 目录：`v3/flows/`（★ 目录待建，与 `flow-2-code-review/` 平级）
- 文件：`spec.md` + `draft-cases.html`（★ 待做，护城河 flow）
- 层级：L3 Flow（时序 + L4 联动矩阵）
- 上游：`flow-2-code-review/spec.md`（日常主路径，本 flow 是其并行编排升级）

## 2. 产物 HTML 规范
- spec.md 画时序 + 联动矩阵；draft-cases.html 画屏幕样例
- standalone draft，内联 CSS，冷蓝 token
- **护城河**：多 agent 并行编排是产品差异化，依赖 panel 4 叶深化完成才能做

## 3. 要做的事情
- [ ] 主 agent 派子 agent 编排时序（派发 / 并行执行 / 结果回传 / 汇总）
- [ ] **多子 agent 并行进度聚合**（升级 panel progress-zone：单 session 进度 → 多进度聚合）
- [ ] 子 agent 结果回传 → SubAgent Detail（Side Drawer 内）呈现
- [ ] 中断 / steer 子 agent（依赖 composer-states steer 态）
- [ ] L4 联动矩阵：主 agent ↔ 子 agent 的数据流 + 控制流
- [ ] 边缘态：子 agent 失败 / 超时 / 冲突合并

## 4. 关联文档
- 上游：`flow-2-code-review/spec.md`（单 agent 主路径，本 flow 扩展为多）/ `panel/spec.md`（Process Panel v1 删，子 agent 编排走 Side Drawer）
- 同层依赖：`panel/draft-companion-zones`（progress-zone 多进度聚合升级）/ `panel/draft-detail-pane`（SubAgent Detail 呈现位）/ `panel/draft-composer-states`（steer 影响子 agent 调度）/ `panel/draft-message-stream`（subagent 块）
- 下游：Flow 4（回退分支，←/→ 历史栈粒度依赖本 flow 的分支节点定义）

## 5. 关联 HTML
- 参考：`flow-2-code-review/draft-cases.html`（S1-S6 序列画法，本 flow 类比扩展）/ `panel/draft-message-stream.html`（subagent 块样式）
- 集成点：时序画在 flows/；屏幕态嵌入 panel 的 progress-zone + Side Drawer

## 6. 验收（P0）
- [ ] 编排时序完整（派发/并行/回传/汇总）
- [ ] progress-zone 多进度聚合方案落地
- [ ] SubAgent Detail 呈现 + steer 控制
- [ ] 联动矩阵覆盖主↔子 agent 双向数据流
- [ ] 不出现 Process Panel 旧概念（已删，走 Side Drawer）

## 7. Suggested skills
- `recursive-skeleton`（时序 + 联动矩阵密度自检）
- `frontend-design`（多进度聚合视觉）
- 注：优先级高（护城河），但必须等 panel 4 叶深化完成
