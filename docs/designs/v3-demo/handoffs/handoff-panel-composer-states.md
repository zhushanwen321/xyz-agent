# Handoff · panel · composer-states

## 1. 路径
- 目录：`v3-demo/panel/`
- 文件：`draft-composer-states.html`（★ 待做）
- 层级：L2 Module · Panel 内 ④ `composer` zone
- 上游 spec：`panel/spec.md`（line 86 骨架 + line 34 split 规则）

## 2. 产物 HTML 规范
- standalone 单文件，内联 CSS，冷蓝 token（`../../design-tokens.md`）
- **默认双块视觉一体**：输入区 + 工具区上下排列，视觉为同一个容器（同一背景/边框/圆角），中间无强分割
- **工具区固定项**：`+ 添加内容` / 上下文状态徽标 / 模型选择 / thinking-level / 发送按钮（右锚定）
- composer 宽度 = Panel 内宽，不高出 viewport 底
- 术语：`../architecture-and-terminology.html` §1

## 3. 要做的事情
- [ ] 画 8 态：空 / 输入中 / **@浮层**（composer 内，非 Overlay）/ 附件 / 发送中 / 停止 / **steer（pending）** / **followup（pending）**
- [ ] steer = AI **工作中**提交的引导，排队不打断；followup = AI **完成后**提交的追问，开新一轮。两者都显 pending 气泡（区别于已发送态）
- [ ] 工具区 5 项布局定稿（水平排列，发送右锚）
- [ ] 输入区与工具区的视觉一体方案（容器、留白、分隔弱化）
- [ ] @浮层：上下文候选列表，浮在输入区上方，算 composer 内部状态

## 4. 关联文档
- 上游：`panel/spec.md`（5 zone 定位 + steer/followup 裁决）/ `architecture-and-terminology.html` / `ui-skeleton.md`（L2 总纲）
- 同层：`draft-message-stream`（steer·followup 在消息流显 pending 气泡）/ `draft-companion-zones`（progress-zone 在 composer **上方**，git-zone 在**下方**，三者共享 composer 上下带）
- 下游：`flows/flow-3-subagent`（steer 影响子 agent 调度）

## 5. 关联 HTML
- 参考：`draft-message-stream.html`（文末 §4 规则附录 · steer/followup 块样式要一致）/ `workspace/draft-dual-panel.html`（composer 现有布局）
- 集成点：嵌入 `panel/spec.md` 的 ④ composer zone；steer/followup 提交 → 追加到 message-stream

## 6. 验收（P0）
- [ ] 8 态全画，steer/followup 视觉可区分（pending 标记）
- [ ] 输入区+工具区视觉一体（同容器、弱分隔）
- [ ] 工具区 5 项齐全且布局稳定
- [ ] @浮层在 composer 内，不误归 Overlay
- [ ] 冷蓝 token 一致，无废弃术语

## 7. Suggested skills
- `frontend-design`（输入/工具区一体视觉）
- `impeccable`（8 态状态视觉可区分性 review）
- `recursive-skeleton`（状态清单密度自检）
