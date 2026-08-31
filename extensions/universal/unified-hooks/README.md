# unified-hooks

> **[DEPRECATED] 本包已废弃，被 [`@zhushanwen/pi-base-tool-enhance`](https://www.npmjs.com/package/@zhushanwen/pi-base-tool-enhance) 取代，不再维护。**
>
> 能力承接落点：
>
> | 原 hook | 承接方式 |
> |---------|---------|
> | `test-timeout-guard` | base-tool-enhance 可配置 force-test 白名单：测试类命令**自动转后台执行**并返回 task_id（不再 block 打回补 timeout 参数） |
> | `network-timeout-guard` | 正则不迁入（这类命令时长不定且结果常被立即需要）；挂死保护由模型显式 timeout + base-tool-enhance 可配置前台默认超时承接 |
> | `tool-error-handler` | base-tool-enhance 的 tool_error 审计（customType 保持 `unified-hooks:tool-error`，历史 entry 不断链） |
>
> 迁移指引：`pi uninstall npm:@zhushanwen/pi-unified-hooks` 后 `pi install npm:@zhushanwen/pi-base-tool-enhance`。两者同时安装会对 bash 产生双重拦截，务必先卸载本包。

统一 hooks 管理器 — 将散落的 hooks 收集到一个扩展中统一维护。hook 为自包含模块，全部注册；setup 失败的 hook 标记为 disabled，并在 session_start 时提醒。

## 功能

### 内置 Hooks

| Hook | 说明 |
|------|------|
| `tool-error-handler` | 工具执行错误经 appendEntry 写入 session JSONL（customType `unified-hooks:tool-error`），便于事后排查 |
| `network-timeout-guard` | 网络类 bash 命令未设 timeout 时 block，提示 AI 补 timeout 或开代理 |
| `test-timeout-guard` | 测试类 bash 命令未设 timeout 时 block，提示 AI 补 timeout |

### 扩展方式

在 `src/hooks/` 下新建 hook 模块，然后在 `src/index.ts` 的 `hookModules` 数组中注册即可。

## 使用

加载后自动生效，无需配置。工具错误经 appendEntry 写入 session JSONL（customType `unified-hooks:tool-error`），不弹 TUI 通知；各 hook 的注册结果（enabled/disabled）记录在 `unified-hooks:loaded` customEntry。

## 文件结构

```
unified-hooks/
├── index.ts
└── src/
    ├── index.ts               # 入口 — hook 注册
    └── hooks/
        ├── tool-error-handler.ts    # 工具错误处理（appendEntry 审计）
        ├── network-timeout-guard.ts # 网络命令超时守卫
        └── test-timeout-guard.ts    # 测试命令超时守卫
```
