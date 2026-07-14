# Retrospect — i18n-frontend

## 目标达成
前端渲染层全模块 i18n 国际化完成。571 个 i18n key 覆盖 zh-CN/en-US 双语，所有组件和 composables 中的硬编码中文已替换为 t() 调用。

## 实际数据
- **Wave 数**: 6（W1 基础层 + W2-W6 并行模块）
- **Commit 数**: 8（W1 + W2-W6 + 2 个 key 同步 fix）
- **修改文件**: ~70 个 .vue/.ts 文件
- **i18n key 总数**: 571（zh-CN 和 en-US 完全一致）
- **硬编码替换**: ~320 处
- **locale 文件拆分**: 原 2 个大文件 → 26 个子模块文件（每个 <130 行）

## 流程经验

### 做得好的
1. **W1 先行 + W2-W6 并行**: subagent 并行效率高，5 个模块同时开发
2. **locale 文件拆分**: ESLint 500 行限制逼出了更好的架构（按 namespace 拆子模块）
3. **grep 验证**: 零残留确认 i18n 化彻底

### 踩坑
1. **zh-CN/en-US key 不同步**: W4 subagent 给 zh-CN/panel.ts 加了额外 keys 但没同步到 en-US。根因是 subagent 各自独立修改 locale 文件，缺乏同步机制。后续应由主 agent 统一管理 locale 文件变更
2. **CW expected 精确匹配**: plan 的 expected.text 填的是描述性文字，CW engine 做精确匹配导致 test fail。replan 修正后 status 回退需重走 dev→review→test，多了一轮
3. **replan 不可改 committed wave changes**: W5 的 changes 列表被 subagent 实际执行时微调（去掉了 useSidebar.ts），replan 时需保持原样

### 改进方向
1. locale 文件变更应集中在 W1 完成，后续 Wave 只改组件文件不改 locale
2. CW test expected 应填可精确匹配的短文本（如 "PASS"、"0 matches"），不填描述句
3. 考虑写一个 i18n key 一致性检查脚本加入 CI，防止 zh-CN/en-US 脱节
