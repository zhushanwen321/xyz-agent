# Handoff · panel · companion-zones

## 1. 路径
- 目录：`v3/panel/`
- 文件：`draft-companion-zones.html`（★ 待做）
- 层级：L2 Module · Panel 内 ③ `progress-zone`（composer 上方）+ ⑤ `git-zone`（composer 下方）
- 上游 spec：`panel/spec.md`（line 29-30 zone 定位 + line 87 骨架）

## 2. 产物 HTML 规范
- standalone 单文件，内联 CSS，冷蓝 token
- **两 zone 合并一稿**：progress 与 git 都内嵌 composer 上下带、强耦合，一个文件画全状态更省（避免跨文件对齐）
- progress-zone 高度自适应（无进度时折叠/隐藏），git-zone 同理
- 单 / 双 Panel 下两 zone 行为一致（双 Panel 仅 Side Drawer 方向变，zone 本身不变）

## 3. 要做的事情
- [ ] progress-zone 4 态：待办 / 进行 / 完成 / 阻塞（进度条粒度待定）
- [ ] git-zone 4 态：干净 / 已暂存 / 有 diff / 冲突（冲突态视觉待定）
- [ ] 与 composer 的视觉关系：progress 在上、git 在下，三者共享 composer 上下带（视觉连贯）
- [ ] progress 阻塞态的「展开 Process Panel」入口（**注**：Process Panel v1 已删，阻塞态如何呈现待裁决——可能走 Side Drawer Detail）

## 4. 关联文档
- 上游：`panel/spec.md`（progress 内嵌胜出 / Process Panel v1 删除裁决）/ `workspace/spec.md`（内嵌 zone 方案来源）
- 同层：`draft-composer-states`（共享上下带）/ `draft-message-stream`（tool-call 块与 progress 关联）
- 下游：`draft-detail-pane`（git Diff → Side Drawer）/ `flows/flow-3-subagent`（进度与子 agent）

## 5. 关联 HTML
- 参考：`workspace/draft-dual-panel.html`（composer 上下区现有画法）
- 集成点：嵌入 `panel/spec.md` ③ progress-zone + ⑤ git-zone

## 6. 验收（P0）
- [ ] progress 4 态 + git 4 态全画
- [ ] 两 zone 与 composer 视觉连贯（共享上下带，不割裂）
- [ ] 无进度 / git 干净时 zone 的空态处理明确
- [ ] 不出现 Process Panel 旧概念（已删）

## 7. Suggested skills
- `frontend-design`（状态徽标 + 进度条粒度）
- `recursive-skeleton`（合并稿密度自检：两 zone 是否真该合一）
