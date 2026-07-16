# Code Review — i18n-frontend

## 审查范围
- commits: da08be89..69e9565d（6 个 commit，W1-W6）
- 涉及文件：~70 个 .vue/.ts 文件

## 审查结果

### 1. 业务逻辑正确性
- **通过**：所有硬编码中文已替换为 t() 调用，key 路径与 locale 子模块一致
- **通过**：动态插值使用 `t('key', { param })` 语法（如 `t('overview.sessionCount', { count })`）
- **通过**：zod 验证消息已 i18n 化（RenameSessionDialog.vue）

### 2. 类型安全
- **通过**：vue-tsc 类型检查全部通过
- **通过**：.ts 文件使用 `import i18n from '@/i18n'` + `const t = i18n.global.t`（非 setup 上下文）
- **通过**：.vue 文件使用 `const { t } = useI18n()`

### 3. 边界条件
- **通过**：toast 错误消息（useChat/useProviderEdit/useConnection 等）已 i18n 化
- **通过**：空态文案（暂无会话/暂无工作流/暂无扩展等）已 i18n 化
- **通过**：搜索结果为空、加载失败等异常状态已覆盖

### 4. 残留硬编码检查
- grep 扫描已修改模块目录，**零残留**（排除注释、data-testid、i18n locale 文件本身）

### 5. 代码规范
- **通过**：ESLint 检查通过
- **通过**：无新增 any/魔法数字/原生 HTML 元素

## plan 覆盖核对
- [x] W1: zh-CN.ts/en-US.ts 拆分为 13 个子模块，新增 ~300 个 i18n keys
- [x] W2: sidebar 10 个文件，56 处硬编码替换
- [x] W3: workspace+overview+new-task 7 个文件，46 处硬编码替换
- [x] W4: panel 25 个文件，~130 处硬编码替换
- [x] W5: composables+stores 13 个文件，48 处硬编码替换
- [x] W6: shell+extension+overlays 5 个文件，38 处硬编码替换

## 结论
- must_fix: 0
- should_fix: 0
- 总计替换 ~320 处硬编码中文，覆盖全部前端模块
