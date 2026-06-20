# runtime 相似代码第二轮审查（分级 + 修复方案）

> 审查范围：`src-electron/runtime/src/`（排除 test/、node_modules/）
> 审查日期：2026-06-20
>
> **进度（2026-06-20 更新）**：
> - ✅ P0-A（存储抽象层 JsonStore + WriteBackCache）已完成——C0–C6，6 个 store 全部迁移
> - ✅ P1-A（settings.json 单所有者收口）已完成——9 处 RMW 收口到 updateSettingsSync
> - ✅ P1-B（storage global/workspace ×4×2 折叠）已完成——C5 顺手做
> - ⬜ P0-B（transport 错误契约统一）待做
> - ⬜ P1-C/D/E 待做
> 与 [`duplicate-code-audit.md`](./duplicate-code-audit.md)（D1–D28）的关系：
> - 既有审计 D1–D28 多已标 ✅ 解决。本文件是**对未解决/新发现相似代码的第二轮审查**。
> - 本文件不重复 D1–D28 的已解决项，仅在**与既有结论冲突或补充**处交叉引用并标注「修正 Dxx」。
> - 分级口径沿用既有文档的 P0–P3 四档（见 [`duplicate-code-audit.md`](./duplicate-code-audit.md) 处置汇总表）。
>
> 核心原则：**只列形式/逻辑相似的代码，不预判真假重复**；判定在分级时单独给出。

---

## 分级口径

| 档 | 定义 | 信号 |
|---|---|---|
| **P0** | 需要建立**目前不存在的横切抽象/契约**，跨多子系统或多变化轴 | 不补它，每个新 store / 新错误都继续漂移 |
| **P1** | 抽象已存在或边界已清晰，**局部模块内部**重组（换调用、抽基类、改声明），改动局限在单子层 | port 已在、helper 已在、只差贯彻 |
| **P2** | 纯机械重复，提 helper / 常量 / 一行函数，不动结构 | grep 替换级 |

末尾单列 **真差异（明确不动）**——形式相似但语义必然不同。

---

## P0 — 整体架构调整（2 项）

### P0-A. 建立 runtime 存储抽象层（JsonStore + WriteBackCache）

**吸收相似点**：A1 read 骨架（9 处）、A2 TTL 缓存（2 套）、A3 write 包装（3 处）、A4 Map round-trip（3 处）、A6 内联 ENOENT、A7 size 双口径、B 两套 write-back 缓存。

**现状（核实过的代码）**：runtime 有 6 类 JSON 存储——models / settings / disabled-packages / permissions / plugin-KV / session-data，**没有一个共享的「JSON 文件存储」机制抽象**。read→parse→ENOENT 容错、atomicWrite、TTL 缓存各自重造 9+ 次；两套 write-back 缓存（PluginStorage / SessionDataStore）连 size 口径都不一致（`Buffer.byteLength` vs `JSON.stringify().length`）。

**为什么是 P0**：横切 infra/pi + services/plugin-service + infra/system，是架构空洞。不补，每加一个 store 就多一份漂移。

**关键判断——是同一变化轴吗？** 是。机制（文件读写 / 缓存 / 原子写 / ENOENT）是横切轴；实例（存什么 T、什么路径、谁的域）是不同实例。**抽机制、留实例**，符合「按变化轴拆分」。但 write-back（dirty+flush）不是所有 store 都要——models/settings 是 read-through，只有 KV 类要 write-back。所以分两层。

**方案对比**：

| | 方案 A：组合（推荐） | 方案 B：继承基类 |
|---|---|---|
| read-through store | `JsonStore<T>`（read 带 TTL / write atomic / ENOENT 容错） | `AbstractJsonStore<T>` 模板方法 |
| write-back store | `WriteBackCache<K,V>` **组合** 一个 JsonStore，加 dirty+timer+size | 继承 `AbstractJsonStore` + 加 flush 钩子 |
| 取舍 | 组合不锁死类型层次；WriteBackCache 可独立测试 | 继承强制 read/write 耦合，flush 成钩子易漏 |

**接口骨架（仅签名）**：
```ts
class JsonStore<T> {                          // read-through
  constructor(path, defaultVal, opts?: { ttlMs?, indent? })
  read(): T                                   // TTL 缓存 + ENOENT→default
  write(v: T): void                           // atomicWrite + 刷缓存
  invalidate(): void
}
class WriteBackCache<K, V> {                  // write-back，组合 JsonStore
  constructor(store: JsonStore<...>, opts: { flushMs, maxSize?, sizeOf?: (v)=>number })
  get/set/delete/keys(k, v)                   // 改内存 + 标 dirty + 调度 flush
  flush/flushAll()
}
```
- `sizeOf` 默认 `Buffer.byteLength`，**统一掉 A7 的双口径**。
- ENOENT 容错进 JsonStore 内部，**A6 的内联 isEnoent 自动消失**（顺带修正既有 D20 的遗漏，见 P1-A）。
- 迁移：models→`JsonStore<PiModelsConfig>`、settings→`JsonStore<PiSettings>`、permissions→`JsonStore<Record<string,string[]>>`、PluginStorage/SessionDataStore→`WriteBackCache`。

**阶段建议**：先落 `JsonStore` + 迁 read-through 那 4 个（独立 commit、可独立验证），再落 `WriteBackCache` 收两个 KV store。

---

### P0-B. transport 层错误契约统一

**吸收相似点**：D10（6 种错误 payload 形状）。

**现状**：同一个语义「告诉客户端操作失败」有 6 种 payload：sendError / extension.installError / message.error / file.read:error / bridge RPC error / 内联 `{success:false}`。客户端要写 6 套错误分支。这是 transport 协议层的契约空洞。

**关键判断——6 种全要合一吗？不。** 有 3 种是真差异（见末尾），真正该统一的是**请求级操作失败**：install / uninstall / toggle / file.read 这类。

**方案对比**：

| | 方案 A：单一 envelope（推荐） | 方案 B：每 type 一个 *Error 子类型 |
|---|---|---|
| 形状 | 统一 `sendError(ws, code, msg, id, { sessionId?, details? })` | `extension.installError` / `file.readError` 各自保留 |
| installError 的 hint | 进 `details.hint` | 原生字段 |
| 取舍 | 客户端一处 catch；扩展信息塞 details | 语义精细但碎片化，回到现状 |

**tree 的 `{success:false}` 要单独决策**：tree 的「部分成功」（tree 部分可用 + 返回降级空数组）语义和「请求失败」不同——它不是错误，是带错误信息的成功响应。保留，但要在契约里写明「这是部分成功，不是 error envelope」。

**依赖**：建议放在 P1-E（transport 分发重构）之后做——错误契约横切所有 handler，等 MessageHandler 基类落地后改起来更干净。

---

## P1 — 局部模块架构调整（5 项）

### P1-A. settings.json 单所有者收口（完成 D17 的遗漏部分） ｜ 修正既有 D17

**吸收相似点**：A5（pi-provider-store 9 处 RMW 绕过）。

**对既有文档的修正**：[`duplicate-code-audit.md`](./duplicate-code-audit.md) 的 **D17 标 ✅ 已解决，但核实当前代码后发现只完成了一半**——D17 收了 settings.json 的读写**归属**（建立了 pi-settings-store 单一读写层、两域分区），但 pi-provider-store 里 model 域的 setter **仍手写 RMW**，没有用 D17 一并建好的 `updateSettingsSync()`：

- `pi-provider-store.ts` 第 150、155、191、196、273、283、294、304、316 行——共 9 处仍是 `const settings = JSON.parse(JSON.stringify(readSettings())); settings.xxx = ...; writeSettings(settings)`。
- `pi-settings-store.ts:181-186` 的 `updateSettingsSync(mutator)` 正是为收口这批而建，但未被调用。

**诚实说明**：当前**不会爆竞态**——pi-settings-store.ts:175-180 的推理成立（sync RMW 靠单线程天然不交错）。这是**规约贯彻债**，不是活 bug。但 D17 的目标是「模块外不直接 RMW」，没做完。

**修复**：9 处替换为 `updateSettingsSync(s => { s.xxx = ... })`。纯局部，无新抽象。所以是 P1 不是 P0。

---

### P1-B. plugin-rpc-setup storage 方法 global/workspace ×4 ×2（新发现，未被既有 D 项覆盖）

**相似点**：`plugin-rpc-setup.ts:90-115` —— get/set/delete/keys 在 global 和 workspace 两个 scope 各写一遍，唯一差别是多传一个 `'workspace'` 参数。8 个 registerMethod 块、唯一差异是 scope 参数。

**修复**：`['global','workspace'].forEach(scope => { 注册 4 方法，workspace 末尾多传 scope })`。约消 18 行机械重复。纯局部。

---

### P1-C. transport 消息分发骨架重构

**吸收相似点**：D1 switch 骨架（6 处）、D2 reply 惯用法（40+ 处）、D3 service 守卫（7+1 处）、D4 mutate→scan→reply、D5 try/catch→toErrorMessage、D8 getClient→空抛→op（3 处）、D9 DI 构造器 + TreeHandlerContext 没 extends。

> 与既有 D8 的关系：[`duplicate-code-audit.md`](./duplicate-code-audit.md) D8 已抽 `MessageHandlerContext { send; sendError }`（ctx 契约），但**只解决了 D9 的 ctx 部分**，switch/reply/守卫三组重复仍在。

**修复方向（局限 transport 子层）**：
- `MessageHandler` 基类或 `Record<MsgType, (msg,ctx)=>Promise<void>>` map，消灭 6 个 switch 骨架（D1）。
- `reply(ws, msg.id, type, payload)` helper，消灭 40+ 处 `send(ws,{type,id:msg.id,payload})`（D2）。
- `ctx.requireService(name, msg.id)` helper，消灭「service not available」守卫（D3：extension-handler 7 处 + plugin-handler 1 处）。
- TreeHandlerContext 补 extends MessageHandlerContext（D9 的不对称）。
- message-dispatcher 的 abort/steer/followUp 抽 `getClientOrThrow`（D8）。

---

### P1-D. server.ts 内部结构化

**吸收相似点**：D7（context 字面量 4 份 / sendInitialState 6 段 / broadcast 3 个）。

**修复方向**（单文件内，风险低）：
- sendInitialState 改 `{load, type, key, label}[]` 循环，消灭 6 段结构相同的 best-effort try/catch（eslint-disable 注释也复制了 6 次）。
- broadcast 改 descriptor 驱动。
- context 用 `{send: this.send.bind(this), sendError:...}` 基对象 spread，消灭 4 份字面量重复。

---

### P1-E. plugin-service API 声明式 RPC

**吸收相似点**：C1（28 处 register）、C2（已被 P1-B 覆盖）、C3（25 处 client 代理）、C4/C5/C6（.then 丢弃 / null 默认 / 无参 eslint 不一致）、C7（Disposable 注册 3 处）、C8（onNotification dispatch 3 处）。

> 与既有 D5 的关系：[`duplicate-code-audit.md`](./duplicate-code-audit.md) D5 判定「api/* 对偶结构非重复，不动」。本项**不推翻 D5**（D5 说的是「register/create 骨架本身」不要强行合并），而是指**骨架内的样板**（params 解构、.then 丢弃、null 默认）可以声明式化。

**修复方向**：改为**声明式 method 表**——定义 `{name, params[], scope?}`，自动生成 server 注册 + client 代理。Disposable/onNotification 的 Map 管理可抽一个 `LocalHandlerRegistry`（收 C7/C8）。

---

## P2 — 机械提取（按手法归类）

| 手法 | 项（编号见下方相似点索引） | 动作 |
|---|---|---|
| **已有 helper 没用** | F7（pi-provider-store:259-263） | 改调已存在的 `pickFirstModelProvider`（:132）。注：既有 D10 已抽 helper 并改了 2 处，但 findValidDefaultModel 第 4 处仍内联——既有审计的遗漏 |
| **已有 helper 没用 ｜ 修正既有 D20** | A6（plugin-storage:261,280） | 改用同文件第 4 行已 import 的 `isEnoent(e)`。D20 标 ✅ 但漏了这两处 |
| **提小 helper** | C9 | `getOrCreate<K,V>(map, k, make)` 统一 4 处 Map get-or-create |
| | C10 | 错误码注入统一成 `withCode(err, code)`，消灭 `Object.assign` vs `(e as{}).code=` 两套 |
| | D6 | `isNotFound(e)` helper，消灭 tree 里 5 处 `e.message.includes('not found')` 字符串嗅探 |
| | G2 | `parseJsonl(raw): unknown[]` 统一 3 处「跳过畸形行」内层 catch |
| | G3 | 删 session-file-utils:73/112 多余的 `existsSync` 判断（`mkdirSync({recursive})` 本就幂等） |
| | F3 | `walkDir(dir, {filter, visit})` 统一 6 处目录扫描骨架 |
| | F4 | `tmpPathFor(path, suffix?)` 统一 atomicWrite 对里重复的 tmpPath 构造 |
| **统一常量** | H1 | `'session-data'` 目录名提进 pi-paths（getSessionDataDir） |
| | A2/A3 | `JSON_INDENT=2` 常量去重（P0-A 落地后自动消失） |
| **两套写法选一** | E3 | RpcClient 9 个 sendCommand 包装改命令表 `Record<cmd, fields>` |
| | D11 | compact 遥测两处（session-handler vs message-dispatcher）合一 |
| **需追问再定** | F6 | disabled-packages.json 双读（pi-extension-settings 返 string[] vs extension-resolver 返 Set）——注释声明「刻意独立」，但同进程两模块读同一文件仍是 split-brain。倾向合并成单一 reader + 本地 Set 转换，**需确认独立性是否有真实理由** |

---

## 真差异 — 明确不动（形式相似，语义必然不同）

| 项 | 为什么不动 |
|---|---|
| **E1** plugin-rpc-server/client pending 镜像 | client 给 reject Error 挂 `.code`、handleResponse 返 void；server 不挂 code、返 boolean。两端职责不同（请求方 vs 响应方），PendingTracker 已抽共享（既有 D15） |
| **F2** Record 词汇表（mapTypeToApi / STOP_REASON_MAP / parseSpec） | 内容是不同域词汇，必然不同；形式同构（`Record+??fallback`）可共享 `lookup()` 但收益极小 |
| **A 的 sync/async atomicWrite 对** | fs-utils:12/28 是 API 必然差异（同步 vs 异步），只 tmpPath 构造可抽（已归 P2-F4） |
| **B 的 size 策略**（增量 vs 全量重算） | 是 WriteBackCache 的子类差异，P0-A 抽基类后**保留为子类配置**（sizeOf 钩子），不是重复 |
| **D10 的 message.error** | session 消息流内错误（流语义），不是请求级错误，不走 sendError envelope。保留 |
| **D10 的 bridge RPC error** | JSON-RPC 响应格式，和 ws 消息错误是两个协议层。保留 |
| **event-adapter 5 个重量级 handler** | 含 hook 触发 / content-block 提取 / stop-reason 映射，是真逻辑，P1-E 已排除 |
| **adapter 类**（session-tree-reader-adapter / session-store） | ports-and-adapters 的有意 seam，1:1 转发 + cast 是该模式本意（既有 D7 已判定保留） |

---

## 相似点索引（字母编号，供上方引用）

> 完整代码引用见四份扫描明细（transport / plugin-service-api / session-data-persist / rpc-stores-bridges），归档于本审查的工作笔记。下方为摘要。

- **A 组（JSON 读写/缓存/原子写）**：A1 read 骨架 9 处、A2 TTL 缓存 2 套（provider/settings）、A3 write 包装 3 处、A4 Map round-trip 3 处、A5 RMW 9 处（pi-provider-store）、A6 内联 ENOENT（plugin-storage:261,280）、A7 size 双口径
- **B 组（write-back 缓存）**：PluginStorage（debounce 500ms/增量 size）vs SessionDataStore（interval 5s/全量 size）；B1 timer clear-then-arm
- **C 组（RPC 注册/代理）**：C1 register 28 处、C2 storage ×4×2、C3 client 代理 25 处、C4 .then 丢弃、C5 null 默认、C6 无参 eslint、C7 Disposable 3 处、C8 onNotification 3 处、C9 Map get-or-create 4 处、C10 错误码注入 2 语法
- **D 组（transport）**：D1 switch 6 处、D2 reply 40+、D3 service 守卫、D4 mutate→scan→reply、D5 try/catch→toErrorMessage、D6 not-found 嗅探 5 处、D7 server.ts 内部重复、D8 getClient 3 处、D9 DI 构造器、D10 错误形状 6 种、D11 compact 遥测 2 处
- **E 组（RPC pending/进程）**：E1 pending 镜像、E2 listener Set 3 处、E3 sendCommand 包装 9 处、E4 spawn 生命周期
- **F 组（event-adapter/installer/扫描）**：F1 字段拷贝 handler 8 处、F2 Record 词汇表、F3 目录扫描 6 处、F4 原子目录替换、F5 installer 流程、F6 disabled-packages 双读、F7 pickFirstModelProvider 第 4 处内联
- **G 组（JSONL/同步文件）**：G1 openSync/writeSync/closeSync 3 处、G2 跳过畸形行 3 处、G3 多余 existsSync 2 处
- **H 组（路径常量）**：H1 session-data 魔法串、H2 join 链手工拼

---

## 建议执行顺序

1. **P2 里「已有 helper 没用」+ 纯删除类先做**（F7、G3、A6）——零风险、独立 commit、热身。A6 顺带补既有 D20 的遗漏。
2. **P0-A JsonStore（先 read-through）**——建立抽象，迁 4 个 read-through store。这是后面所有存储项的地基。
3. **P1-A settings 收口**——9 处替换为 updateSettingsSync，补完既有 D17。
4. **P0-A WriteBackCache**——收 PluginStorage + SessionDataStore，顺带消灭 A7 size 双口径。
5. **P1-C / P1-D transport + server.ts**——一批，都在 transport 子层。
6. **P0-B 错误契约**——放后面，横切所有 handler，等 P1-C 的 MessageHandler 抽象落地后改起来更干净。
7. **P1-E 声明式 RPC + event-adapter 表驱动**——独立子层，可并行。
