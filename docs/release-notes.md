# Release Notes 写作规范

> SSOT：GitHub Release body 的写作规范。merge 流程阶段 5 撰写 notes 前必须先读本文档。

## 受众定位

Release note 面向**应用使用者**，不是开发者。它的两个消费场景共用同一份 body：

- 升级按钮 hover 浮层（Sidebar UpdateButton，360px 宽、最高 360px、12px 字号，超长即滚动）——`useAppUpdate` 按用户语言提取 `<!-- LANG:xx -->` 段后渲染
- GitHub Release 页面

因此：**工程细节不进 note**——测试加固、CI/门禁、内部重构、构建脚本、文档整理、ADR 编号等放 PR 描述，note 只写用户可感知的变化。

## 三节结构

每个语言段固定三节，按此顺序排列，空节可省略：

| 节名（zh / en） | 条目开头动词 | 放什么 |
|---|---|---|
| 新增功能 / New Features | 新增 / Add | 新能力、新入口、新面板 |
| 功能优化 / Improvements | 优化 / Optimize | 交互改进、性能优化、体验打磨 |
| 修复缺陷 / Bug Fixes | 修复 / Fix | 缺陷修复，按重要程度排序 |

## 条目写法

1. **每条一行，约 30 字以内**，简述即可；超出说明在写实现细节，回头删
2. **面向用户模糊化**：不写 commit 数量、文件名、字段名、内部机制术语、版本号对比。反例：「修正 13 处 pi 协议错误假设：工具错误改为 throw（而非返回 isError）」；正例：「修复部分 pi 协议错误」
3. **extension / workflow 能力变化也要写**，表述为「优化 review-fix-loop workflow 流程」这类用户视角的动词短语
4. **修复按重要程度排序**；超过 10 条时，第 11 条起不再单列，合并为一条「修复其他缺陷」
5. en 与 zh 条目一一对应，翻译保持同等模糊度

## 双语格式 [MANDATORY]

沿用既有强制规范：`<!-- LANG:en -->` 在前、`<!-- LANG:zh -->` 在后，标记独占一行，前后留空行；无标记的旧 release 向后兼容（前端全文显示）。

## 完整示例

```markdown
<!-- LANG:en -->
## New Features
- Add full conversation attribution: bash and user actions now show in the chat stream and survive reload
- Bundle builtin extensions with the app — no install on first run

## Improvements
- Optimize review-fix-loop workflow with per-round metrics

## Bug Fixes
- Fix pi protocol mismatches
- Fix session data inconsistency after reload

<!-- LANG:zh -->
## 新增功能
- 新增对话流归因显示，bash 与用户操作实时可见，重开不丢失
- 新增内置扩展打包，首次启动免安装

## 功能优化
- 优化 review-fix-loop workflow 流程，支持逐轮度量

## 修复缺陷
- 修复部分 pi 协议错误
- 修复会话重开后数据不一致
```

## 与工具的关系

`merge/scripts/release.sh` 的自动生成（conventional commits 按 feat/fix/perf/breaking 分组）**仅作参考草稿**，其格式与本规范不一致（commit 原文直出、无字数与模糊度约束）。发布前必须按本规范手写定稿，再用 `gh release edit <tag> --notes-file <双语文件>` 覆盖。
