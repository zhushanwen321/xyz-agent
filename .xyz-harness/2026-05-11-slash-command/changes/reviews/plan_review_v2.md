## 评审记录 v2
- 评审时间: 2026-05-11
- 评审类型: 计划评审（第 2 轮）
- 评审对象: spec.md + plan.md（修订后版本）
- 评审轮次: 2 / 3

---

### 上轮 MUST FIX 验证

| # | 上轮问题 | 修复状态 | 验证说明 |
|---|---------|---------|---------|
| 1 | Spec 第 6 节 skill badge 未被 plan 覆盖 | **已解决** | Plan 新增 Task 5，覆盖 Message 接口扩展（`skillName` 字段）、ChatInput 注入、PaneSessionView 传递、MessageBubble 渲染。链路完整，从数据层到 UI 层全覆盖。 |
| 2 | /help 执行路径缺口 | **已解决** | Plan 引入 `CommandContext` 接口，包含 `sessionId`（通过 ChatInput props 传入）、`getAllCommands()`（延迟获取完整命令列表，解决 skills 尚未合并的时序问题）、`onLocalAction` 回调（将 local 命令执行委托给 PaneSessionView）。设计合理，ChatInput 保持纯粹的 UI 组件角色。 |

### 上轮 LOW 问题跟踪

| # | 上轮问题 | 状态 | 说明 |
|---|---------|------|------|
| 3 | 大小写过滤逻辑未明确 | **已解决** | Plan Task 1 第 4 点明确写出 `name.toLowerCase().includes(filter.toLowerCase())`。 |
| 4 | Skill 标签 UI CSS 规范合规性 | **未变** | Plan Task 3 仍使用 `skill-tag-bar`、`skill-tag` 等自定义类名。由于 spec 已明确"使用 Tailwind 类或 @apply"，实现时应遵守。这是编码阶段关注的问题，不阻塞计划评审。 |
| 5 | /compact 命令执行路径绕行 | **未变** | Plan 仍采用 ChatInput → emit → PaneSessionView 的路径。当前设计保持了 ChatInput 与 ws-client 的解耦，是一个合理的架构选择。 |
| 6 | spec 涉及文件表不完整 | **已解决** | Plan Task 5 明确列出 MessageBubble.vue 和 message.ts，spec 涉及文件表也包含了这两个文件。 |

---

### Spec 与 Plan 一致性逐项检查

| Spec 需求 | Plan Task | 覆盖状态 |
|-----------|----------|---------|
| 1. 触发：输入 `/` 弹出匹配框 | Task 2（SlashMenu visible prop） | 覆盖 |
| 2. 子串过滤（不区分大小写） | Task 1（filterCommands） | 覆盖 |
| 3. 最多显示 5 项，可滚动 | Task 2（CSS max-height, overflow-y: auto） | 覆盖 |
| 4. 每项前置类型标签 CMD/SK | Task 2（source 判断渲染 tag） | 覆盖 |
| 5. 按字母排序，不分组 | Task 1（mergeSkillCommands 排序） | 覆盖 |
| 6. 键盘操作（↑↓ Tab Enter Esc） | Task 2（保留键盘导航） | 覆盖 |
| 7. CMD 类型立即执行，清空输入框 | Task 3（handleSlashSelect 分发） | 覆盖 |
| 8. /clear 清空聊天记录 | Task 4（local-action clear → chatStore 清空） | 覆盖 |
| 9. /compact 发 ws 消息 | Task 3+4（send-command emit → ws send） | 覆盖 |
| 10. /help 插入系统消息 | Task 4（local-action help → chatStore 插入） | 覆盖 |
| 11. SK 类型：关闭匹配框，显示标签 | Task 3（activeSkill = cmd） | 覆盖 |
| 12. Skill 标签 UI（名称、× 关闭、accent 色、勾 icon） | Task 3（skill tag UI） | 覆盖 |
| 13. Skill 标签单次模式（发送后消失） | Task 3（handleSend 后 clearSkill） | 覆盖 |
| 14. Skill 消息拼接 `/skill:<name>` | Task 3（handleSend 拼接前缀） | 覆盖 |
| 15. 聊天记录展示 skill badge | Task 5（Message 接口 + MessageBubble 渲染） | 覆盖 |
| 16. 内置命令 3 个（硬编码） | Task 1（注册 3 个内置命令） | 覆盖 |
| 17. Skill 命令从 providerStore 提取 | Task 1（mergeSkillCommands） | 覆盖 |
| 18. 合并后按字母排序 | Task 1（去重 + 排序） | 覆盖 |
| 19. 输入框边框变 accent 色 | Task 3（skill tag 存在时边框变化） | 覆盖（隐含） |

---

### 本轮发现的问题

无新的 MUST FIX 问题。

Spec 所有需求在 Plan 中均有对应 Task 覆盖，数据流和事件链路完整：

```
用户输入 → ChatInput 触发 SlashMenu → 选中 SlashCommand
  ├─ local: onLocalAction → PaneSessionView → chatStore 操作
  ├─ protocol: send-command → PaneSessionView → ws send
  └─ skill: activeSkill → 用户补充输入 → handleSend 拼接 /skill: 前缀
      → PaneSessionView handleSend → chatStore.addMessage(含 skillName)
      → MessageBubble 渲染 badge
```

Plan 中 Task 间的依赖关系清晰：Task 1（类型系统）→ Task 2（菜单 UI）+ Task 3（输入框集成）→ Task 4（父组件接线）→ Task 5（badge 渲染）。

---

### 结论

**通过**。上轮 2 条 MUST FIX 均已解决，Plan 完整覆盖 Spec 全部需求，无新发现的 MUST FIX 问题。可以进入编码阶段。
