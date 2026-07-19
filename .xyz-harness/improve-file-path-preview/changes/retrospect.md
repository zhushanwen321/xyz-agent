# Retrospect: improve-file-path-preview

## 执行概览

- 目标：修复文件路径预览缺陷（~ 图片、Windows 路径、正则盲区）+ 点击失败/0 匹配路径 fallback 到搜索面板。
- 实际产出：4 个 wave，7 个 testCase 全部通过。
- 首次通过率：
  - tdd_plan 阶段因 testRunner command 复杂导致 CW 红灯校验 spawn error，改用 custom shell 脚本后通过。
  - 其余阶段首次通过。

## 关键决策回顾

1. **~ 路径图片预览**：主进程 `local-file` handler 统一展开 `~`，渲染进程保持原样展示。这是正确分层（渲染进程无 homedir 权限）。
2. **Windows 路径兼容**：前端 `resolvePreviewPath` 统一转义分隔符计算 relative，展示保留原始路径。
3. **路径识别正则扩展**：允许空格和可选扩展名，但可能引入误识别（如 `a/b` 目录路径）。
4. **失败 fallback**：含 / 路径点击前先 `file.read` 预检查，失败打开搜索面板；basename 0 匹配也打开搜索面板。多匹配保留浮层。

## 已知风险

| 风险 | 严重度 | 说明 |
|---|---|---|
| E1 测试硬编码 homedir | low | `/Users/zhushanwen/Code/foo.png` 是机器特定路径，换机器跑测试会失败。当前 CW 流程在本机执行，可接受。 |
| 路径正则扩展后误识别 | medium | 无扩展名路径（如 `src/Makefile`）和带空格路径被识别，但 `a/b` 这类目录或普通词也可能被误识别为文件链接。 |
| Windows 路径未在真实 Windows 验证 | medium | 单元测试在 macOS 用模拟 Windows 路径，真实 Windows 运行可能还有边界（如盘符大小写）。 |
| useMarkdownInteractions 测试 Vue warn | low | 测试不在 setup 上下文调用 composable，触发 `onBeforeUnmount` 警告，不影响测试结果。 |
| useMarkdownInteractions 直接 import `@/api/domains/file` | low | 打破了项目用 `@/api` 门面的统一约定，仅为测试可 mock。长期应让门面导出也支持 mock。 |

## 流程问题

1. **spec_review 后无法追加 AC**：进入 `spec_reviewed` 状态后 `cw clarify` 被拒绝，无法补充 AC 章节。最终 AC 在 tdd_plan 阶段以 testCases 形式落地，功能等价但 spec 文档不完整。
2. **custom testRunner 脚本**：CW 无法直接 spawn 复杂 bash command（`cd ... && npx vitest ...`），需要额外创建 `.cw/run-improve-tests.sh`。增加了维护成本，但跨包测试场景确实需要。
3. **W4 plan 过度拆解**：原计划写 `MarkdownRenderer.vue` 注入 useSearchModal，实际 `useMarkdownInteractions` 自己调用即可。说明 plan 阶段对职责边界判断不够准。

## 改进建议

- 给 CW 增加跨 worktree/package 的 testRunner 原生支持，减少 custom shell 脚本。
- 在 spec 阶段就写好完整 AC，避免 spec_review 后无法修改。
- 后续给 `useMarkdownInteractions` 补组件级测试，验证 SearchModal 真正被打开且预填 query。
