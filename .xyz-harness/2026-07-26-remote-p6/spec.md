# 远程化 P6 设计：并发保护扩展（git/config/worktree/session delete/terminal）

**日期**: 2026-07-26 | **状态**: 设计定稿（待实施） | **上游方案**: [docs/feature-map/2026-07-26-remote.md](../../docs/feature-map/2026-07-26-remote.md)（§九 P6 阶段、§8.4 P2 协同改造、§十二.2 多客户端并发冲突） | **前置设计**: [P5](../2026-07-26-remote-p5/spec.md)（clientId 透传 + broker 定向 API broadcastExcept/sendToClient + onDisconnect 回调）。**【R2-C3 修正】P5 不交付 fence**（P5 D3 推迟 fence），P6 不依赖 fence

> P6 范围（feature-map §九）：除 pi 外的写入型操作当前全裸奔——git commit 是 TOCTOU、config 是 last-write-wins、worktree 同名并发失败、session delete 其他客户端无感知、terminal resize 多客户端冲突。P6 按 per-resource 加并发保护。feature-map 预估「runtime 中改」。
>
> **代码核实后的关键发现**（explorer 报告）：
> 1. **全仓零 mutex/lock 基础设施**：grep `mutex/Mutex/async-lock/semaphore` 零命中。P6 需从零引入。
> 2. **git**: `git-service.ts:226-254` commit 是 TOCTOU（先 status 再 commit，两次 spawn 之间无锁）。其他写入命令（add/reset/checkout/createBranch）也无串行化。命令白名单已编译期限定（`GitCommand` 联合类型）。
> 3. **config**: provider store **无 version 字段**，纯 last-write-wins。system-prompt.json/terminalConfig 有 `version:1` 但仅做 schema 兜底合并，**不用作 CAS**。
> 4. **worktree**: 只有 create（无 delete 路由），create 无 in-flight 去重——同名分支并发会撞失败。
> 5. **terminal**: 一 session 一 PTY 确认（`terminal-service.ts:65`）；resize 直接 proc.resize，无 owner 协商。**attach 的 scrollback 回灌已在 P2 D7 落地**（P2 把 attach 从 no-op 改为同步点对点回灌 per-session chunk ring buffer），P6 不再重复设计 scrollback，只做 resize owner。
> 6. **session delete**: `session.deleted` 只是定向 reply（仅发起方收到），**无广播**——其他客户端靠下一次 broadcastSessionList 全量覆盖感知。
>
> **对 P5 的依赖**：config CAS 用独立的 `version` 字段（D4），**不依赖 P5 的 fence**（P5 审查 M1 已推迟 fence，P5-P7 无 fence）。P6 的并发保护（mutex/CAS/owner）自身独立，只用 P5 的 clientId 透传 + broker 定向 API（工具复用）。

---

## 一、设计决策总表

| # | 决策 | 选择 | 理由 / 证据 |
|---|---|---|---|
| D1 | **mutex 基础设施** | 新建 `packages/runtime/src/infra/async-mutex.ts`，提供 `createKeyedMutex(): (key) => { run<T>(fn): Promise<T> }`。基于 Promise chain 串行化同 key 的 async 函数。**自实现，不引第三方**（async-mutex 库） | 全仓零 mutex 基础设施，引入第三方库要同步加 tsup noExternal（架构约定 #12），且需求简单（per-key 串行队列），自实现 < 50 行。第三方库的价值（可取消/优先级/超时）本场景用不到 |
| D2 | **git 锁粒度 = per-cwd** | `createKeyedMutex()` keyed by cwd（git 仓库根目录）。所有写入型命令（add/reset/commit/checkout/createBranch/checkoutByCwd）经 mutex 串行；status/diff/log 等只读命令**不经 mutex**（并发读安全） | feature-map §8.4 P2 原文「per-cwd git 操作 mutex（串行化所有 git 命令）」——修正为**只串行写入命令**，只读命令并发读不影响一致性，串行化反而降低性能。`index.lock` 是 git 自己的写入锁，per-cwd mutex 在应用层提前串行化，避免抢锁失败 |
| D3 | **config CAS** | provider store schema 新增 `version: number`（初始 0）；setProvider/setDefaultModel 等 set 路径要求 payload 带 `expectedVersion`；服务端对比 `current.version === expectedVersion`，不等则拒绝（reply error `{ code:'version_conflict', currentVersion }`）；相等则 `version++` 落盘 | feature-map §8.4 P2「带 version 的 CAS」。CAS 比 mutex 更适合 config——config 编辑是用户低频操作，CAS 无锁开销，冲突时让用户决策（"X 设备已修改，是否覆盖"）比静默串行化更透明 |
| D4 | **config CAS 与 fence 关系** | **不强制要求持有 lease 才能改 config**——config 是全局资源（非 session 级），与 pi 操作互斥是两个维度。CAS 的 `version` 是独立的乐观锁字段，**不复用 fence**（P5 审查 M1 已推迟 fence，P5-P7 无 fence） | config 是全局资源。若要求改 config 必须持某 session 的 lease，会强制用户先打开 session 才能改设置，体验差。CAS 独立工作，用自身 version 字段 |
| D5 | **worktree in-flight 去重** | `createKeyedMutex()` keyed by `${cwd}:${branchName}`。createBareWorktree/createPlainRepoWorktree 经 mutex 串行——同分支并发第二个会等第一个完成后看到分支已存在，正常报错（不特殊去重，靠串行化自然消解竞态） | 不引入显式 pending Map（feature-map §8.4 P2 提到的 in-flight 去重）。mutex 串行化已足够：A 发起 create branch X → B 发起 create branch X → B 等 A 完成 → A 成功 → B 看到 X 已存在 → 报错 reply。语义干净 |
| D6 | **session.delete 广播** | `session.deleted` 从定向 reply 升级为**广播事件**（全客户端）。新增 `session.deleting` 广播（删除前广播，让其他客户端先收起 panel + 清 store 分区，避免收到 deleted 时 panel 还开着导致 store 操作 404） | feature-map §8.4 P5 原文。两步广播：deleting（预告，客户端收起 panel）→ deleted（确认，客户端清分区）。发起方走现状的 reply 路径（自己知道删了），其他客户端走广播路径 |
| D7 | **terminal resize owner** | per-session 记录 `resizeOwner: { clientId, ownerDevice }`（**R1-m1：字段名统一为 ownerDevice**，非 resizeOwnerDevice）。resize 请求带 clientId，若 session 已有 resizeOwner 且 ≠ 当前 clientId → 拒绝（reply error `{ code:'resize_locked', owner, ownerDevice }`）；resizeOwner 释放时机 = 该客户端断开连接（onDisconnect 清理）。**不协商"取最小客户端"**（feature-map §8.4 P2 提到，太复杂） | 最后生效冲突的本质是「谁有权决定终端大小」。owner 模型简单：先 resize 的客户端持有权，断开后释放。其他客户端 resize 被拒时 UI 提示「{ownerDevice} 正在控制终端大小」（R1-m1：reply 字段名与记录字段名都用 ownerDevice，消除 resizeOwnerDevice 的歧义） |
| D8 | **terminal write 不互斥** | 接受字符交错（终端协同常见行为）。**【R2-M2 修正】不绑定 P5 presence 的 isOperating**（isOperating 是 pi 租约态非 typing 态，语义错配——见 §3.6 说明）。真正的「X 正在输入」提示需要独立 typing 信号，留后续阶段 | feature-map §8.4 P2 明确「接受（终端协同常见行为）」。R2-M2 审查发现 isOperating 表达「持有 pi lease」而非「正在终端输入」，两者语义不同（A 跑 pi 时 B 终端会误显示「A 正在输入」）。P6 不引入 typing 信号，多客户端同时输命令是罕见场景，加互斥反而妨碍 |
| D9 | **【R4-C1 删除】terminal scrollback 归 P2** | ~~P6 新增 scrollback ring buffer~~ **scrollback 已在 P2 D7 落地**（per-session chunk ring buffer，1000 chunks / 256KB，attach 同步点对点回灌）。P6 不重复设计，避免与 P2 数据结构冲突。feature-map §九 P6 行已去 scrollback | R4-C1 审查发现 P2 D7 和 P6 原设计双重定义且数据结构冲突（P2 用 `Map<string, {chunks: string[]; bytes: number}>`，P6 原设计用 `Map<sessionId, RingBuffer<Uint8Array>>`）。scrollback 与可靠投递层强相关（都是断线恢复），归 P2 更内聚。P6 只做 resize owner |
| D10 | **错误码标准化** | 所有并发拒绝统一用 reply error + code：`version_conflict`（config CAS）/ `resize_locked`（terminal）/ `git_busy`（git mutex 排队超时，见 D11）/ `worktree_busy`（worktree mutex 排队超时） | 标准化 code 让客户端能区分「并发冲突」与「业务错误」，UI 给不同提示 |
| D11 | **mutex 排队超时** | git/worktree mutex 排队超过 10s（`XYZ_AGENT_MUTEX_TIMEOUT_MS`）则拒绝（reply error code `*_busy`）。避免某客户端崩溃后持有锁导致其他人永远等 | mutex 是内存队列，正常情况 ms 级完成。10s 超时是兜底（pi 长命令如 git status 大仓库可能慢，但 git 经 mutex 的只是写入命令，写入不会太慢） |

**明确不在 P6**：
- terminal 输入互斥（D8 接受交错）
- 取最小客户端 resize 协商（D7 用 owner 模型替代）
- 文件上传/下载并发保护（→ P13）
- 多 pi session 之间的资源竞争（MAX_SESSIONS 已限总量，P0 §七）

**对 P5 的依赖**：config CAS 不依赖 fence（D4 独立 version 字段）；presence「X 正在输入」提示依赖 P5 presence store（D8）。P6 的并发保护逻辑自身独立，只复用 P5 的 clientId 透传 + broker 定向 API（工具层面）。

---

## 二、协议变更

### 2.1 ClientMessage 扩展

```ts
// config set 路径加 expectedVersion
| { type: 'config.setProvider'; payload: { provider: ProviderConfig; expectedVersion: number } }
| { type: 'config.setDefaultModel'; payload: { ...; expectedVersion: number } }
// ... 其他 config set 命令同理

// session delete 已有，无需改协议（D6 是服务端多广播一次）
```

### 2.2 ServerMessage 新增/扩展

```ts
// 新增广播（D6）
// 【R1-m4】byClientId 表达「发起删除的客户端」，与 session.busy 的 clientId（=lease 持有者）语义不同，刻意区分命名
| { type: 'session.deleting'; payload: { sessionId: string; byClientId: string } }
// session.deleted 升级为广播（现状是定向 reply，P6 改为广播 + 仍 reply 发起方）
| { type: 'session.deleted'; payload: { sessionId: string } }   // 现有定义，payload 不变

// 错误 reply（D10 标准化 code）
// reply error 已有机制（sendError/reply error），P6 只是新增 code 常量
```

### 2.3 config store schema 变更（R3-M2 修正）

**【R3-M2】现状核实**（`packages/runtime/src/infra/pi/pi-provider-store.ts:64-66`）：

```ts
// models.json 现状（非 spec 原写的数组）
export interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>   // key=providerId 的 Record，非 ProviderConfig[]
}
// defaultModel 不在 models.json，在 settings.json（PiSettings，pi-provider-store.ts:152-208 经 updateSettingsSync 读写 s.defaultModel）
```

**目标**（CAS version 字段加在 models.json，因为 setProvider 改的是 models.json）：

```ts
interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>
  version: number   // D3 CAS 字段，初始 0，每次 set 自增
}
```

**defaultModel 的 CAS**：setDefaultModel 改的是 settings.json，应在 PiSettings 加独立 version 字段（或共用一个全局 config version，见 §七.1 开放问题）。两个文件两个 JsonStore 实例，version 不共享。

**迁移**：读取旧 models.json（无 version 字段）时默认 version=0。第一次 set 后写入 version=1。

---

## 三、实现

### 3.1 async-mutex（D1）

新建 `packages/runtime/src/infra/async-mutex.ts`：

```ts
interface MutexChain { promise: Promise<unknown> }

export function createKeyedMutex() {
  const chains = new Map<string, MutexChain>()
  return {
    async run<T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve()
      let resolveChain: () => void
      const next = new Promise<void>(r => { resolveChain = r })
      chains.set(key, { promise: next })
      try {
        await prev   // 等前一个完成
        if (timeoutMs) {
          // 简单超时：Promise.race，超时抛 TimeoutError
        }
        return await fn()
      } finally {
        resolveChain!()
        // 清理：若当前 chain 还是 next（无人排队），删 key 防泄漏
        if (chains.get(key)?.promise === next) chains.delete(key)
      }
    }
  }
}
```

**使用**：

```ts
// git-service.ts
const gitMutex = createKeyedMutex()
async function commit(cwd, message) {
  return gitMutex.run(cwd, async () => {
    // 现有 status + commit 逻辑
  }, 10_000)  // D11 10s 超时
}
```

### 3.2 git per-cwd mutex（D2）

`packages/runtime/src/services/git-service.ts` 改造：

- **写入命令**（add/reset/commit/checkout/createBranch/checkoutByCwd/unstage）：包裹 `gitMutex.run(cwd, async () => { ... }, 10_000)`
- **只读命令**（status/diff/log/branch/list）：不经 mutex（现状不变）
- 超时抛 TimeoutError → handler 捕获 → reply error `{ code: 'git_busy' }`

**测试要点**：
- 并发两个 commit 同 cwd：第二个等第一个完成（串行化验证）
- 并发两个 commit 不同 cwd：互不阻塞（keyed 验证）
- 只读命令与写入命令并发：只读不等（D2 验证）

### 3.3 config CAS（D3/D4）

`packages/runtime/src/services/config-service.ts` 改造：

- setProvider/setDefaultModel/upsertSkill/deleteSkill/setSkillDirs 等 set 方法签名加 `expectedVersion: number` 参数
- 实现：读取 current.version → 对比 expectedVersion → 不等抛 VersionConflictError → 相等则 set 字段 + version++
- VersionConflictError → handler 捕获 → reply error `{ code: 'version_conflict', currentVersion: current.version }`

**客户端配合**：
- 客户端 config store 缓存当前 version（每次 config.* 广播/reply 时更新）
- setProvider 调用时带 `expectedVersion: store.version`
- 收到 version_conflict → 重新拉取 config（`config.list` RPC）→ 提示用户「X 设备已修改，已刷新，请重试」

**测试要点**：
- A 改 provider（version 0→1）→ B 用 expectedVersion=0 改 → 拒绝（currentVersion=1）
- A 改 provider（version 0→1）→ B 用 expectedVersion=1 改 → 成功（version→2）
- 旧 models.json（无 version）读取 → version=0 → 第一次 set 成功

### 3.4 worktree in-flight 去重（D5）

`packages/runtime/src/services/worktree/worktree-service.ts` 改造：

- createBareWorktree/createPlainRepoWorktree 包裹 `worktreeMutex.run(${cwd}:${branchName}, async () => { ... }, 10_000)`
- 同分支并发第二个：等第一个完成 → 看到分支已存在 → 报错 reply（现状的错误路径，不特殊处理）
- 超时 → reply error `{ code: 'worktree_busy' }`

**测试要点**：
- 并发两个 create 同分支同 cwd：第二个等到第一个完成后报「分支已存在」
- 并发两个 create 不同分支：互不阻塞

### 3.5 session.delete 广播（D6，审查 m4 修正：broadcast 排除发起方）

`packages/runtime/src/transport/session-message-handler.ts:78-84` 改造：

现状：
```ts
clearExtensionTimeoutsForSession(delSid)
await sessionService.delete(delSid)
reply(ws, msg.id, 'session.deleted', { sessionId: delSid })   // 定向 reply
return broadcastSessionList()                                   // 全量列表
```

P6 目标（**审查 m4：session.deleted 广播排除发起方，避免发起方收到两次**）：
```ts
// D6 两步广播
broker.broadcast({ type: 'session.deleting', payload: { sessionId: delSid, byClientId: clientId } })
await sessionService.delete(delSid)
reply(ws, msg.id, 'session.deleted', { sessionId: delSid })           // 发起方 reply（点对点）
// 【审查 m4】broadcastExcept 排除发起方——发起方已通过 reply 收到，不重复收广播
broker.broadcastExcept(clientId, { type: 'session.deleted', payload: { sessionId: delSid } })
return broadcastSessionList()
```

**审查 m4 修正**：原 spec「broadcast session.deleted 给所有人 + reply 给发起方」会导致发起方收到两次（reply + broadcast）。改为 `broadcastExcept(clientId, session.deleted)`——发起方只收 reply，其他客户端只收 broadcast。客户端 cleanupSession 无需幂等处理（每条消息只到一个客户端一次）。broadcastExcept 是 P5 T2 新增的 broker API。

**两步广播的价值**：deleting 让其他客户端先收起 panel（UI 层），deleted 触发 store 清理（10+ store 分区）。如果只有 deleted，客户端可能在 panel 还开着时清分区，导致 panel 操作 404。

**客户端配合**：
- 发起方：收到 reply session.deleted → 走现状的 deleteSession 清理链（10+ store）
- 其他客户端：收到广播 session.deleting → soft close panel（unmount，暂不清 store）；收到广播 session.deleted → 走相同的 cleanupSession 清理链

**抽离 deleteSession 清理函数**：把 10+ store 清理抽成 `useSidebar.cleanupSession(sessionId)` 纯函数，发起方 reply 路径和其他客户端广播路径都能调。

### 3.6 terminal resize owner（D7）

`packages/runtime/src/services/terminal/terminal-service.ts` 改造：

- 新增 `Map<sessionId, { clientId, ownerDevice }>` 记录 resize owner（**R1-m1：字段名 ownerDevice**）
- resize handler：检查 owner，若已有 owner 且 ≠ 当前 clientId → 拒绝 reply error `{ code:'resize_locked', owner, ownerDevice }`；否则设 owner + proc.resize
- onDisconnect：清理该 clientId 持有的所有 resize owner（Map 遍历）

**测试要点**：
- A resize → owner=A → B resize 被拒（B 收到 resize_locked）
- A 断开 → owner 清理 → B resize 成功
- A resize → A 再 resize（同 owner）→ 成功（owner 不变）

### 3.7 【R4-C1 删除】terminal scrollback 归 P2

~~P6 新增 scrollback ring buffer 实现~~ **scrollback 已在 P2 D7/§五 落地**（per-session chunk ring buffer，attach 同步点对点回灌）。P6 不重复实现。R4-C1 审查发现原 P6 设计与 P2 D7 数据结构冲突（`RingBuffer<Uint8Array>` vs `Map<string, {chunks: string[]; bytes: number}>`），统一归 P2。

---

## 四、与 P5 的衔接

| P6 改动 | 依赖 P5 的什么 |
|---|---|
| config CAS | **不依赖**（D4 独立 version 字段，不用 fence） |
| session.delete 广播 | **【R2-C2 修正】用 P5 新增的 broker.broadcastExcept**（P5 T2 新增，非 P5 旧 broadcast）—— session.deleted 排除发起方避免双投递（spec §3.5 m4） |
| terminal resize owner | 用 P5 的 ctx.getClientId + onDisconnect 回调（P5 T2 新增） |
| terminal write 提示 | **【R2-M2 修正】不依赖 P5 isOperating**（语义错配，D8 已改） |
| git/worktree mutex | **不依赖 P5**（纯服务端 mutex，与 clientId 无关） |
| terminal scrollback | **【R4-C1】不依赖 P5，归 P2**（P2 D7 已落地） |

**结论**：P6 对 P5 的依赖是**工具复用**（clientId 透传 + broker broadcastExcept + onDisconnect 回调），不是**语义依赖**。P6 的并发保护逻辑自身独立。

---

## 五、与 feature-map §8.4 P2 原文的对照

| feature-map §8.4 P2 原文 | 本设计落点 |
|---|---|
| git per-cwd mutex（串行化所有 git 命令） | D2 修正为**只串行写入命令**，只读并发安全 |
| config 带 version 的 CAS | D3/D4 |
| worktree in-flight 去重 | D5（用 mutex 串行化替代显式 pending Map） |
| session metadata：删除前广播 session.deleting | D6 |
| terminal resize：per-session resize owner + 协商（取最小客户端或 owner 优先） | D7 简化为 owner 模型（不协商） |
| terminal write：接受字符交错 + presence 提示 | D8（**R2-M2：不绑定 presence isOperating**，typing 留后续） |
| terminal scrollback：attach 时回灌 ring buffer | **【R4-C1】归 P2 D7**（P2 已落地，P6 不重复） |

**与 feature-map 的偏离**：
1. git mutex 范围收窄（只写入命令，不全命令）——性能优化，不违背原意
2. terminal resize 不协商取最小——简化实现，owner 模型够用
3. worktree 用 mutex 替代 pending Map——架构选择，效果等价
4. **【R4-C1】terminal scrollback 归 P2**（原 feature-map §九 P6 列 scrollback 是双重归属，统一归 P2）
5. **【R2-M2】terminal write 不绑定 presence isOperating**（语义错配，typing 留后续）

---

## 六、测试计划

框架 vitest。

| 测试 | 位置 | 要点 |
|---|---|---|
| async-mutex 单测 | `infra/async-mutex.test.ts`（新建） | 同 key 串行（第二个等第一个）；不同 key 并发；超时拒绝；chain 清理无泄漏 |
| git per-cwd mutex | `services/git-service.test.ts`（扩展） | 并发两 commit 同 cwd 串行；并发两 commit 不同 cwd 不阻塞；只读命令不阻塞写入 |
| config CAS | `services/config-service.test.ts`（扩展） | expectedVersion 匹配→成功 version++；不匹配→VersionConflictError；旧 models.json 读取 version=0 |
| worktree 串行化 | `services/worktree/worktree-service.test.ts`（扩展） | 并发两 create 同分支：第二个等第一个完成后报分支已存在 |
| session.delete 广播 | `transport/session-message-handler.test.ts`（扩展） | 删除时广播 session.deleting + session.deleted；发起方收到 reply；其他客户端收到广播 |
| terminal resize owner | `services/terminal/terminal-service.test.ts`（扩展） | A 持有 owner → B resize 拒绝；A 断开 → B resize 成功；同 owner 重复 resize 成功 |
| 端到端 | `tools/verify-concurrency.cjs`（新建） | 真 runtime：并发 config CAS 冲突；并发 git commit；session delete 多客户端感知 |

---

## 七、开放问题

1. **config CAS 的粒度**：所有 set 命令共享一个 version，还是 per-provider/per-section 独立 version？倾向**全局单一 version**（简单，config 编辑低频，冲突罕见）。若未来某个 section（如 providers）编辑频繁，再拆分。
2. **git mutex 是否覆盖 push/pull**：现状白名单无 push/pull/merge/rebase（explorer 报告确认）。P6 不引入这些命令。若未来加 push/pull，应纳入 mutex（push 涉及远程，并发可能触发服务端限流）。
3. **【R2-M2】typing 提示信号**：D8 不绑定 P5 isOperating（语义错配）。真正的「X 正在输入」需要独立 typing 信号（per-session/per-client「最近 N 秒有 terminal.write」），P6 不做，留后续阶段。
4. **session.deleting 与 session.deleted 之间的窗口**：D6 说「不显式 await delay」，broadcast 是同步循环发送，deleting 先于 deleted 到达。客户端 handler 按到达顺序处理，天然有序。
5. **resize owner 与 P5 lease 的关系**：resize owner 是 terminal 级，lease 是 pi 操作级。两者独立——A 持有 pi lease 时，B 仍可持有 terminal resize owner。合理（resize 是 UI 操作，不冲突 pi 操作）。
