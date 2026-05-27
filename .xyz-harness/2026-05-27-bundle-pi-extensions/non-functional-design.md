---
verdict: pass
---

# Non-Functional Design — bundle-pi-extensions

## 1. 稳定性

改动风险极低。Extension 源码已通过 pi CLI 环境验证，xyz-agent 只改变加载路径。如果某个 extension 加载失败，pi 的 jiti loader 会输出 console.warn 但不阻塞 session 创建（getExtensionPaths 已做 try-catch 保护）。唯一风险点是 jiti 在 RPC 模式下的 TS 编译兼容性，但这不是本改动引入的新风险。

## 2. 数据一致性

不涉及数据库或结构化存储。Extension 的持久化数据（goal 的任务列表、todo 的 todo 列表）存储在 pi session 文件中，与 session 生命周期绑定。Logger 写入独立的日期滚动日志文件，无并发冲突（appendFileSync 在 Node.js 单线程下安全）。migrateToPiSubdir 的 cpSync 是首次启动一次性操作，幂等（目标存在则跳过）。

## 3. 性能

getExtensionPaths() 在每次 session create 和 restore 时调用，执行两次 readdirSync（~7 个目录项）和若干 existsSync 检查。总计 < 1ms，不构成性能问题。Logger 的 appendFileSync 每次写入一条日志行（< 200 bytes），频率由 extension 事件触发（非高频），不影响 pi 进程性能。

## 4. 业务安全

Extension 代码作为 AI 行为指令在 pi 进程内执行，与 xyz-agent 主进程隔离（IPC boundary）。Extension 通过 ExtensionAPI 注册工具，工具 schema 在加载时确定，运行时不可修改。不引入新的安全面。

## 5. 数据安全

Logger 修复确保日志数据留在 `~/.xyz-agent/` 目录内（AC-3）。日志内容为工具调用记录和调试信息，不含用户敏感数据（pi session 文件中的对话内容由 pi 自身管理，不经过 logger）。Extension 源码为 TypeScript 文本文件，git 跟踪，无构建产物。
