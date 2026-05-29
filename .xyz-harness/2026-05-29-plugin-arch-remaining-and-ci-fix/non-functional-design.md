---
verdict: pass
---

# Non-Functional Design — plugin-arch-remaining-and-ci-fix

## 1. 稳定性

Worker 端 tool execute handler 是新增代码路径，不修改现有的 `msg.response` / `msg.notification` 处理逻辑，对已有功能零风险。`toolHandlers` Map 是 Worker 进程内的内存结构，随 Worker 生命周期生灭，无跨进程状态同步问题。`handleIncomingRequest` 中所有异常路径都有 try-catch 包裹并返回 error response，不会出现未捕获异常导致 Worker crash。

CI 脚本修复使用 `elif` 互斥分支（`pi/` 目录 vs `pi.exe` 直接存在），不影响 macOS/Linux 的 tar.gz 分支逻辑。

## 2. 数据一致性

`toolRegistry`（主线程）和 `toolHandlers`（Worker）之间是 schema/handler 分离设计：主线程存储 schema 用于路由，Worker 存储 execute handler 用于执行。两者通过相同的 toolKey（`${pluginId}:${toolName}`）关联。一致性风险点在 register 顺序（Worker 本地存 handler 后才 RPC 发 schema 到主线程），如果 RPC 失败，handler 已存但主线程无 schema，tool 不会被路由到，无副作用。

## 3. 性能

`toolHandlers.get()` 是 O(1) Map 查找，tool execute 的性能瓶颈在插件 handler 本身（用户代码），不在框架层。Worker 进程内无锁竞争。单次 RPC 往返延迟约 1-5ms（同机 Worker Thread 通信），可忽略。

CI 脚本改动仅增加一个 `elif [[ -f "pi.exe" ]]` 文件检测，无性能影响。测试路径标准化 `p.replace(/\\/g, '/')` 对每个 mock readFile 调用增加一次字符串替换，CI 中微不足道。

## 4. 业务安全

不适用。本次改动不涉及用户数据处理、权限变更或安全策略调整。Worker 侧 tool execute handler 的执行权限已在 Phase 1 的 PermissionChecker 中控制（`tools.register` 权限），本次不新增权限检查。

## 5. 数据安全

不适用。不涉及敏感信息处理或文件权限变更。CI 脚本操作仅在构建环境中执行，不接触用户数据。测试路径修复仅改变 mock 中的路径匹配逻辑，不改变数据内容。
