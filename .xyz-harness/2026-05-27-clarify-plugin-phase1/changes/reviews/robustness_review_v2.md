---
review:
  type: robustness_review
  round: 2
  timestamp: "2026-05-28T12:00:00+08:00"
  target: "src-electron/runtime/src/services/plugin-service/ (7 files, verified)"
  verdict: pass
  must_fix: 0
  summary: "第 2 轮健壮性审查。上一轮 6 条 MUST_FIX 全部确认已修复，verdict=pass。"

statistics:
  total_issues_round1: 9
  must_fix_round1: 6
  must_fix_resolved: 6
  low_remaining: 3
  info_remaining: 1

must_fix_verification:
  - id: 1
    location: "plugin-host.ts:172 (createWorker)"
    title: "new Worker(bootstrapPath) 未做异常防护"
    status: FIXED
    evidence: "new Worker 已包裹 try-catch(err)，catch 中 console.error 记录 workerId 和异常后 rethrow。handle 在 try-catch 之后才注册到 workers/workerInstances Map，不存在部分构造泄露风险。"
  - id: 2
    location: "plugin-bootstrap.ts:102-108 (deactivate case)"
    title: "deactivate 失败仍发送 deactivated 回复"
    status: FIXED
    evidence: "mod.deactivate() 已包裹 try-catch，catch 中发送 { type: 'error', pluginId, error: String(e) } 并 break，不再 fall-through 到 deactivated 回复。主线程收到 error 后 resolve(false)，activator 正确识别停用失败。"
  - id: 3
    location: "plugin-activator.ts:122 (activatePlugin catch)"
    title: "插件激活失败静默吞异常"
    status: FIXED
    evidence: "catch 块第一行添加了 console.error('[plugin-activator] failed to activate ${pluginId}:', err)，记录 pluginId 和完整错误对象。状态仍正确设置为 UNLOADED。"
  - id: 4
    location: "plugin-host.ts:215-222 (shutdown)"
    title: "shutdown 中 worker.terminate() 未 await/未 catch"
    status: FIXED
    evidence: "改为 await Promise.all([...workerInstances.values()].map(w => w.terminate()))，所有 terminate 被 await。Node.js 的 w.terminate() 返回 Promise<number>（exit code），极少 reject。虽然未使用 allSettled，但已消除 unhandled rejection 风险。"
  - id: 5
    location: "plugin-service.ts:117-129 (shutdown 时序)"
    title: "storage.flushAll() 在 host.shutdown() 之后调用导致数据丢失"
    status: FIXED
    evidence: "顺序已修正为：deactivateAll() → flushAll() → host.shutdown()。flushAll 在 terminate 之前执行，确保脏缓存先写入磁盘。deactivateAll 通过 sendAndWaitReply 等待 Worker 完成清理（含最后一批 storage 操作），然后 flush 写入，最后终止 Worker。"
  - id: 6
    location: "plugin-registry.ts:27-36,61-75 (parsePlugin / scan)"
    title: "插件扫描解析失败静默跳过"
    status: FIXED
    evidence: "（1）scan() 的 stat 失败捕获中有 console.warn 记录；（2）parsePlugin 中 JSON.parse 失败有 console.warn 记录路径；（3）manifest 缺失/版本不对有 console.warn 记录目录名。readFile 失败的静默 catch 保留（非插件目录无 package.json 是正常路径，不应 warn）。"

remaining_low_info:
  - id: 7
    severity: LOW
    location: "plugin-activator.ts:184 (disposeContext)"
    title: "subscription dispose 失败被静默吞掉"
    status: UNCHANGED
    note: "catch { /* best effort */ } 保留——subscription dispose 不应阻塞 deactivate 流程，静默吞掉是最佳实践。"
  - id: 8
    severity: LOW
    location: "plugin-service.ts:14-22 (constructor)"
    title: "构造参数 registry/broker 未做 null 校验"
    status: UNCHANGED
    note: "未修复——PluginService 为内部构造（非 public API），调用链保证参数非 null。如需修复可日后添加 assert。"
  - id: 9
    severity: INFO
    location: "plugin-host.ts:137-148 (startMemoryMonitor)"
    title: "方法名与实际实现不符"
    status: IMPROVED (观察记录)
    note: "JSDoc 已更新，明确说明当前仅刷新 lastActiveAt 时间戳，未来可扩展为采集 process.memoryUsage()。"
---

# 健壮性评审 v2

## 评审结论

**verdict: pass** — 上一轮 6 条 MUST_FIX 全部确认已修复。

## 修复对照表

| 问题 | 文件 | 修复方式 | 验证结论 |
|------|------|---------|---------|
| #1 Worker 创建无异常防护 | plugin-host.ts | try-catch + console.error + rethrow | ✅ |
| #2 deactivate 假阳性 | plugin-bootstrap.ts | try-catch + error 回复 + break | ✅ |
| #3 activate 失败静默吞异常 | plugin-activator.ts | catch 中添加 console.error | ✅ |
| #4 shutdown terminate 未 await | plugin-host.ts | await Promise.all(terminate()) | ✅ |
| #5 shutdown 时序数据丢失 | plugin-service.ts | flushAll → host.shutdown 交换顺序 | ✅ |
| #6 扫描解析失败静默跳过 | plugin-registry.ts | JSON/manifest 失败记录 warn | ✅ |

## 额外观察

- 3 条 LOW 和 1 条 INFO 未要求修复，保持原样。
- 整体代码健壮性较 v1 明显提升：核心异常路径现在都有日志记录，Worker 生命周期管理更安全，shutdown 时序消除了数据丢失风险。
