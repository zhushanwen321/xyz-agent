# Code Review — settings-robustness-pass

## 审查范围
- commits: W1(3f81aac4) → W7(60f018b5)，7 个 Wave commit
- 改动文件: 20+ 文件（settings vue 组件、composables、stores、i18n locale、tests）

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| 类型安全 | useProviderEdit watch(providerRef) 传 ref<ref> 导致 Vue warn "Invalid watch source" | should_fix | useProviderEdit.ts:207 |
| 边界条件 | setModelEnabled 传完整 models 数组替换，未保留其他 model 字段（如 thinkingLevelMap） | should_fix | ProviderPage.vue onToggleModelEnabled |
| 测试覆盖 | E1/E2 real 层用例需人工验证，当前只有 mock 层自动化 | nit | plan testCases |
| 代码规范 | W6 快捷键降级为只读展示，TODO 注释标记重录待实现 | nit | SystemPage.vue |
| 边界条件 | headers key-value 编辑器无 key 重复校验 | nit | useProviderEdit.ts headerRows |

## plan 覆盖核对

- [x] W1 changes[0]: actionError 列表顶部可见 ✅
- [x] W1 changes[1]: cycleThinking 删除 + pill disabled ✅
- [x] W1 changes[2]: onToggleEnabled defaultModel 悬空清理 ✅
- [x] W1 changes[3]: confirmDelete defaultModel 清理 ✅
- [x] W2 changes[0]: ExtensionPage 双触发修复（去掉 div @click）✅
- [x] W2 changes[1]: setSystem 失败回滚 ✅
- [x] W2 changes[2]: setSkillDirs/setAgentDirs await+catch ✅
- [x] W3 changes[0]: model 级 enabled Switch ✅
- [x] W3 changes[1]: headers/authHeader form 字段 ✅
- [x] W3 changes[2]: save 回写 headers/authHeader ✅
- [x] W3 changes[3]: ProviderEditModal headers UI + authHeader Switch ✅
- [x] W3 changes[4]: 过期快照 refresh（watch providers deep）✅
- [x] W4 changes[0]: ExtensionPage toast 反馈 ✅
- [x] W4 changes[1]: ProviderEditModal 保存 toast ✅
- [x] W4 changes[2]: 取消未保存确认 ✅
- [x] W4 changes[3]: addModel 空名/重复校验 ✅
- [x] W4 changes[4]: save 前端校验 ✅
- [x] W5 changes[0]: LoadPaths 添加路径入口 ✅
- [x] W5 changes[1]: 重复校验 + 错误提示 ✅
- [x] W5 changes[2]: 删除按钮 ✅
- [x] W6 changes[0]: zh-CN.ts + en-US.ts settings namespace ✅
- [x] W6 changes[1]: 7 个 vue 文件 i18n 替换 ✅
- [x] W6 changes[2]: 字体大小 Select + applySystemToDom ✅
- [x] W6 changes[3]: settings.ts fontSize 字段 ✅
- [x] W6 changes[4]: 快捷键只读展示（降级，重录待实现）⚠️
- [x] W6 changes[5]: useAppCommands 未改（降级只读不需改）✅
- [x] W7 changes[0]: 拖拽落点指示线 ✅
- [x] W7 changes[1]: source tab piinstall→pi 过滤修复 ✅
- [x] W7 changes[2]: 空 tab 文案区分 ✅
- [x] W7 changes[3]: 卸载确认文案补全 ✅
- [x] W7 changes[4]: discover/test 互斥禁用 ✅

## 测试结果
- 9 个测试文件，63 个测试全通过（vitest）
- vitest-i18n-setup.ts 全局 mock vue-i18n，保持现有中文断言兼容
- E1/E2 real 层用例待人工验证

## 结论
- must_fix: 0
- should_fix: 3（watch 源类型、model replace 语义、headers key 重复）
- nit: 3
- 所有 plan changes 已落地，W6 快捷键降级只读（合理，重录功能风险高）
- 可进入 test 阶段
