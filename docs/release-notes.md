# Release Notes 写作规范（xyz-agent 特化补充）

> **通用写作规范 SSOT 已上移全局**：`~/.agents/guide/release-notes.md`（受众定位、三节结构、条目写法、双语格式 [MANDATORY] 的权威源）。merge 流程阶段 5 撰写 notes 前必读全局指引 + 本文档。
>
> 本文档只保留 xyz-agent 特有部分，与全局指引互补不重复。

## 展示位（本项目消费场景）

Release note 面向**应用使用者**，两个消费场景共用同一份 body：

- 升级按钮 hover 浮层（Sidebar UpdateButton，360px 宽、最高 360px、12px 字号，超长即滚动）——`useAppUpdate` 按用户语言提取 `<!-- LANG:xx -->` 段后渲染
- GitHub Release 页面

## 与工具的关系

`merge/scripts/release.sh` 不指定 `--notes` 时会自动生成草稿：双语三节骨架与全局规范一致，但条目是 conventional commit 原文直出（feat → 新增功能、perf → 功能优化、fix → 修复缺陷、breaking → 重大变更），**没有**全局规范的模糊化、30 字、排序与合并约束，chore/test/docs 类被过滤。脚本会在生成后提醒定稿：按全局规范手写后用 `gh release edit <tag> --notes-file <双语文件>` 覆盖。
