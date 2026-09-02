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

## 待发布草稿

> 本节存放**待随下次发版并入正式 release note 的条目草稿**（设计文档验收条款要求的指引先落于此，merge skill 阶段 5 定稿时按全局规范并入，并入后清空本节）。npm 包侧（CHANGELOG / deprecate 文案）随发版流程另行处理，不在本节。

### 旧版 `@zhushanwen/pi-base-tool-enhance` npm 安装残留卸载指引（2026-09，随含收殓下沉的版本发布）

来源：[file-lock-unification-and-reaper-sink](design/file-lock-unification-and-reaper-sink.md) §3.3 D2 过渡窗口（S5 验收项）。格式参照 unified-hooks 废弃先例（`pi uninstall npm:<pkg>` + 双重拦截理由 + 动作顺序；命令形态按 pi 实装 CLI，无 `pi extension uninstall` 子命令）。

**背景**：2026-09-01 事故后该扩展的孤儿收殓 reaper 下沉 xyz-agent runtime（扩展本体改为随应用 builtin 打包内置）。xyz-agent 托管的 pi 不受 npm 层残留影响（spawn 用 `--no-extensions` 抑制全局发现 + 显式 `--extension` 注入）；但**曾在裸 pi 环境（脱离 xyz-agent 独立使用）用 npm 安装过旧版**的机器，裸 pi 场景仍会加载旧版——旧版自带全局扫描 reaper（崩溃触发面）且可能与新装版本双重注册 bash override。

**面向用户的操作指引**：

```bash
pi uninstall npm:@zhushanwen/pi-base-tool-enhance
# 需在裸 pi 继续使用者，卸载后重装新版（无 reaper、锁已换自实现）：
pi install npm:@zhushanwen/pi-base-tool-enhance
```

仅使用 xyz-agent 桌面的用户无需操作（builtin 已随应用内置，随应用升级自动跟进）。

**并入正式 note 时的双语条目（定稿按全局规范 30 字模糊化）**：

- en: If you installed the background-bash extension standalone before, remove the old copy (`pi uninstall npm:@zhushanwen/pi-base-tool-enhance`) to avoid duplicate bash handling.
- zh: 曾在裸 pi 环境独立安装过后台任务扩展的用户，请卸载旧拷贝（`pi uninstall npm:@zhushanwen/pi-base-tool-enhance`）避免双重拦截。
