# scheduler

定时任务调度扩展：按 duration（`5m` / `2h` / `1d`）间隔或 cron 表达式，在指定时间向 agent 注入消息。支持一次性提醒（once）、强制触发（force）、过期策略（expires）与持久化（重启后任务保留）。

## 简介与安装

pi-scheduler 是 xyz-agent 的 **mandatory 扩展**（`packages/shared/src/mandatory-extensions.json`，tier: `feature`）——xyz-agent 启动时自动安装并启用，无需手动操作。

独立 pi 环境手动安装：

```bash
npm install @zhushanwen/pi-scheduler
```

安装后扩展在 pi 会话启动时自动装配（见下节），无需额外配置。

## 激活方式

扩展 factory（`src/index.ts`）监听 pi 的 session 生命周期事件，在 `session_start` 时装配完整调用链：

```
session_start
  └─ PiSchedulerBackend（FS 读写 + pi.sendMessage + 时间源）
       └─ SchedulerRuntime（内存态 + 30s tick 调度 + 限流）
            └─ SchedulerService（tool/command 唯一业务入口）
  ├─ runtime.loadTasks(backend.loadTasks())  ← 从磁盘恢复任务
  ├─ runtime.startScheduler()                ← 启动 tick
  └─ 注册 scheduler widget（30s 刷新）
```

`session_shutdown` 时执行 `runtime.persistSync()`（立即写盘）并停止 tick。任务状态因此随 session 持久化：关闭重开 session 后任务仍存在、到期仍会触发。

## /schedule 命令用法

注册为 `/schedule` 命令。无参数时显示 usage；第一个参数匹配子命令关键词则走子命令分支，否则尝试创建任务。

### 子命令

| 子命令 | 行为 |
|--------|------|
| `/schedule list` | 列出所有任务（id、名称、调度、下次执行时间） |
| `/schedule on <id>` | 启用任务 |
| `/schedule off <id>` | 停用任务（推荐临时暂停用 off，不用 rm） |
| `/schedule rm <id>` | 删除任务 |
| `/schedule run <id>` | 立即执行任务 |
| `/schedule once <schedule> <prompt>` | 创建一次性提醒（kind=once） |
| `/schedule cron <expression> <prompt>` | 创建 cron 任务 |

任务 id 由 8 位 hex 自动生成，`list` 后从输出中获取。

### 引号转义

参数用 shell 风格引号解析（`tokenizeQuoted`，`src/commands.ts`）：

- 单引号 `'...'` 或双引号 `"..."` 内的内容作为一个 token，引号字符本身被剥离
- 含空格的多词参数（cron 表达式、prompt）**必须加引号**，否则会被拆成多个 token

例如 cron 表达式 `0 9 * * 1-5` 含空格，必须写成 `'/schedule cron '0 9 * * 1-5' standup'`；prompt `check build` 同理写成 `'/schedule 5m 'check build''`。

### 子命令补全

输入 `/schedule ` 后 Tab 补全子命令关键词（list/on/off/rm/run/once/cron）；`on`/`off`/`rm`/`run` 之后补全当前任务 id。

## schedule 语法

### duration（间隔调度）

`<数字><单位>`，数字与单位间可有空格，**大小写不敏感**：

| 单位 | 含义 | 乘数 |
|------|------|------|
| `s` / `sec` / `second` / `seconds` | 秒 | 1,000 ms |
| `m` / `min` / `minute` / `minutes` | 分 | 60,000 ms |
| `h` / `hr` / `hour` / `hours` | 时 | 3,600,000 ms |
| `d` / `day` / `days` | 天 | 86,400,000 ms |

例如：`5m`、`2h`、`1d`、`30seconds`、`2hours`。非法输入（裸数字、未知单位、空串、负值）解析失败 → 创建任务报 `INVALID_SCHEDULE`。

### cron（时间点调度）

标准 cron 表达式，支持 5 字段与 6 字段：

- **5 字段**（分 时 日 月 周）：自动补 `0` 秒字段（如 `0 9 * * 1-5` → `0 0 9 * * 1-5`）
- **6 字段**（秒 分 时 日 月 周）：原样使用

**含空格自动走 cron 分支**：schedule 输入中不含空格 → 按 duration 解析；含空格 → 按 cron 解析。因此 cron 表达式必须包含空格（正常写法天然如此），duration 不得含空格。

## 选项语义

`schedule` tool 的 `kind` / `name` / `expires` / `force` 参数（`/schedule` 命令的 `once`/`cron` 前缀对应 kind）：

| 选项 | 取值 | 语义 |
|------|------|------|
| `kind` | `recurring`（默认）/ `once` | recurring 每次触发后按 schedule 重算下次时间；once 触发一次后自动删除 |
| `name` | 字符串 | 任务可读名称，缺省从 prompt 自动生成（≤30 字原样，超长截前 27 字加省略号） |
| `expires` | duration 字符串 / `never` | recurring 任务的过期时间：`now + duration`；`never` 永不过期；缺省 7 天。**once 任务不设过期**（触发即删，expires 忽略） |
| `force` | `true` / `false`（默认） | `true` 时即使 agent 忙（非 idle 或有 pending 消息）也强制 dispatch；`false` 时忙则延迟到下次 tick |

## 示例

**recurring 间隔任务**（每 5 分钟检查构建）：

```
/schedule 5m 'check build'
```

**一次性提醒**（10 秒后提醒）：

```
/schedule once 10s remind
```

**cron 任务**（工作日早 9 点站会）：

```
/schedule cron '0 9 * * 1-5' standup
```

**force 立即触发**（tool 调用：即使忙也执行）：

```json
{"prompt": "deploy staging", "schedule": "*/10 * * * *", "force": true}
```

**永不过期**（tool 调用：长期任务不设 7 天默认过期）：

```json
{"prompt": "monthly report", "schedule": "1d", "expires": "never"}
```

## 限制与运行时行为

| 限制/行为 | 值 | 说明 |
|-----------|-----|------|
| 任务上限 | **50**（`MAX_TASKS`） | 超过抛 `Task limit reached (50)`，需先删除任务 |
| 触发频率上限 | **6 次/分钟**（`RATE_LIMIT_PER_MINUTE`） | 滑动 60s 窗口。`/schedule run` 超限返回 `DISPATCH_SKIPPED`；tick 自动 dispatch 超限静默跳过 |
| tick 间隔 | **30s**（`TICK_INTERVAL_MS`） | 到期任务在下一个 tick 被 dispatch；实际触发时间可能比计划晚最多 30s |
| 默认过期 | **7 天**（`DEFAULT_EXPIRY_MS`） | recurring 任务缺省 `expires` 时；`expires: 'never'` 关闭 |
| once 任务 | 触发后自动删除 | 不参与后续调度 |
| cron 失效 | 任务停用 + `lastStatus=failed` + `lastError='cron expression invalid'` | 不会用 `now()` 兜底导致每 tick 重触发死循环 |
| persist 失败 | `console.warn` + 内存态保留 + `lastError='persist failed'` | 不打断调度，下次 tick 继续尝试 |
| 忙时 dispatch | 非 force 任务在 agent 忙（非 idle / 有 pending 消息）时跳过，延迟到下次 tick | force=true 可绕过 |
| history | 保留最近 **20** 条执行记录 | 超出丢弃最旧 |
| 持久化 | 每次变更写盘（session_shutdown 强制同步写） | 重启后任务保留 |

错误语义：创建时 schedule 解析失败 → `INVALID_SCHEDULE`；`run`/`toggle`/`delete` 引用不存在的 id → `TASK_NOT_FOUND`；`run` 时任务 disabled / busy / rate-limited → `DISPATCH_SKIPPED`（message 含 `busy, disabled, or rate-limited`）。

## 数据存储位置

任务存储为单个 JSON 文件，按 workspace 路径隔离（不同 cwd 存不同文件）：

```
~/.pi/agent/scheduler/<root>/<segments>/scheduler.json
```

- `<root>`：路径根（如 `/` → `root`）
- `<segments>`：cwd 相对根的路径段（如 `/Users/me/project` → `Users/me/project`）

删除文件即清除全部任务；损坏的 JSON 自动降级为空 store 并 `console.warn`。

## 开发

```bash
pnpm test          # 运行全部 vitest 测试（等价 npx vitest run）
npx vitest run src/__tests__/<file>.test.ts   # 单个文件
```

测试策略：

- **依赖反转**：`SchedulerRuntime` 只依赖 `SchedulerBackend` 接口（`sendMessage` / `persist` / `now`），不触碰 FS/pi。测试注入 `MockSchedulerBackend`（`src/backend.ts` 同文件 export）实现零副作用测试：`sentMessages` 记录发送、`persistedStores` 记录持久化、`persistError` 注入失败、`nowValue` 固定时间源
- **纯函数**：`parseDuration` / `formatDuration` / `parseSchedule` / `computeNextRunAt` / `computeNextRuns`（`src/parsing.ts`）无副作用，可直接断言
- **property-based**：`src/__tests__/property.test.ts` 用 fast-check 生成随机组合验证不变量（interval 精确、duration round-trip、format↔parse 一致性），生成器范围契约见该文件注释
- **round-trip**：`store.test.ts`（mock fs）验证路径与 GC；`store-roundtrip.test.ts`（真实 fs，os.tmpdir 隔离）验证 load 白名单字段（lastError/lastStatus/lastRunAt/expiresAt/force/history）持久化往返

扩展内部结构：`backend.ts`（后端抽象）→ `runtime.ts`（调度核心）→ `service.ts`（业务入口）→ `tool.ts`/`commands.ts`（tool 与 /schedule 命令适配层）→ `widget.ts`（状态栏 widget）。
