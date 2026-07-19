# Spec Review — settings-prompt-polish

日期：2026-07-17 · 三维度自审

## 三维度结论

### completeness
- CL1（菜单 i18n）→ 修复 i18n + 测试解耦 ✓
- CL2（参考区 accent + 复制）→ 改样式 + 加复制按钮 ✓
- CL3（去快照卡）→ 前后端全链路 ✓，隐含需求：删快照后 SystemPromptSnapshot 类型是否也从 shared 删除？→ 是，类型无其他消费方
### consistency
- CL3 删快照涉及多文件，需确保删干净不残留 import → plan 拆 wave 时按层分（shared → runtime → renderer）
### reasonableness
- 复制按钮用 navigator.clipboard API，HTTPS/Electron 环境可用 ✓
- 删快照后插件仍正常工作（只是不写文件），hook 追加逻辑不受影响 ✓

## 结论
无 must-fix / should-fix。进 plan。
