# 复盘 — settings-prompt-polish

三项打磨：菜单 i18n 修复 + 参考区 accent 样式与复制按钮 + 去掉快照卡全链路。

## 执行过程

| 阶段 | 结果 |
|------|------|
| clarify | 3 条确认（用户预确认方案） |
| dev | 3 wave（shared→runtime→renderer），W1+W2 并行 |
| review/test | 0 issues，11 测试全绿 |

## 关键改动
1. 菜单名称从变量名回退 → 正常 i18n 翻译（「系统提示词」/「System Prompt」），测试改 nav 顺序定位解耦 textContent
2. 参考区 toggle 改 accent 主色 + 加复制按钮（clipboard API）
3. 快照卡全链路删除（shared 类型 + runtime 方法/handler/interfaces + 插件 writeSnapshot + renderer 卡片/api/mock + 测试断言），共删 ~150 行

## 做得好的
- 快照删除按层拆 wave（shared→runtime→renderer），依赖链清晰，W1+W2 并行
- 测试解耦（nav 顺序定位替代 textContent.includes）是根因修复，不是 workaround

## 已知风险
无。快照删除是纯减法，参考区 accent+复制是增量改进。
