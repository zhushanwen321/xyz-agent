# W2 Gate 复验报告（p1p4 P3 gate 改判：场景 3 restore/fork 重开一致性）

> 验收对象：`.xyz-harness/2026-08-19-p1p4-closure/acceptance/w2-acceptance.md`（基线 26f1f7419）。
> 执行方：主 agent 亲自；dev 隔离 `~/.xyz-agent-dev/`，真实 pi 子进程，无 mock。
> 复验时间：2026-08-19 23:10-23:25（boot1/boot2 两次精确启停，PGID 87527 / 88781，结束三端口确认清空）。

## 结论（三行）

- **P3 gate 改判 PASS**：上次 FAIL 的失败链（restore 后对话只落 tmp 孤儿 → 第二次重启整轮消失）已在含 W1 的 HEAD（96f37a754）上一手反转；fork 路径经引用 dcf0efe12（超集行为级验证）豁免。
- **W2 执行形态变更**（相对基线）：用户并行会话的 final gate（dcf0efe12，restore-fork-attach-fix 收官，22:08-22:42 执行）已完成 V1/V3 的超集验证（含 V2a/V2b legacy + G-X 断言零误报）。本 W2 不重复全量场景，改为「引用该证据 + 在含 W1 的 HEAD 上跑最小冒烟」——封住 W1 restoreSession 等价重构未经真实环境验证的缺口。变更依据与时间线重叠风险评估见 §3。
- **冒烟断言 A/B 全部成立**（§1），$TMPDIR 全程零新孤儿。

## 一、冒烟证据（HEAD = 96f37a754，含 W1）

目标 session：`2026-08-19T14-10-48-642Z_01a01a5c-….jsonl`（用户 gate 的 G-V1 同款 session，cwd=/Users/zhushanwen/Stock 存活、无 session_end → F2 直附着路径）。

### 1.1 操作时间线

| 时刻 | 操作 | 结果 |
|------|------|------|
| 22:52 | boot1 起后侧栏点开该 session（restoreSession） | **restore 零变换**：文件三项与基线全同（16 行 / md5 `c2816876` / mtime 22:14:59）——F2 直附着零写，与 dcf0efe12 G-V1 观察一致 |
| 22:54 | 发「记住这句暗号：closure冒烟W2」 | 回复「已记住。暗号 closure冒烟W2 已追加到暗号列表。」（已工作7s · 思考×2 · 工具×1）；**发消息期间原文件推进：16→21 行 / mtime 22:14:59→22:55:20 / md5 `c2816876`→`a6c50570`**；用量 50.5K→50.8K 单调 |
| 22:57 | `kill -TERM -87527`（boot1 精确停止，三端口清零） | kill 后文件完好（21 行 / md5 `a6c50570` 不变——落盘数据不依赖进程存活） |
| 23:01 | boot2 重启，侧栏重开该 session（再次 restore） | **暗号轮完整在列**（user「记住这句暗号：closure冒烟W2」+ assistant 回复 + 已工作6s/思考×2/工具×1 meta）；gate验证X7 历史轮仍在；用量 50.8K·5% 无回退；无「进行中」残留 |
| 23:04 | `kill -TERM -88781`（boot2 停止，三端口清零） | 冒烟结束 |

### 1.2 断言对照（W2 基线通过标准）

| 断言 | 内容 | 判定 | 证据 |
|------|------|------|------|
| A（断言 2+4 基线） | restore 后对话落原文件（mtime/行数推进）+ $TMPDIR 零新孤儿 | **PASS** | 16→21 行 / mtime +40min；`find $TMPDIR xyz-session-*.jsonl -newermt 22:40` = 0（全程仅 3 个前次 gate 遗留基线孤儿，mtime 18:55/19:12/19:35） |
| B（断言 6 基线，上次 FAIL 点） | 第二次重启重开：暗号轮完整在列、用量不回退 | **PASS** | user+assistant 双文本在 DOM；50.8K 持平无回退；JSONL grep「closure冒烟W2」4 处 |
| 附加 | attach 断言零误伤（运行时 I1 守卫未 throw） | PASS | restore/重开全程无 error toast、会话正常打开（截图 w2-01/w2-03） |

截图：`gate/w2-00-boot1-initial.png` / `w2-01-after-restore.png` / `w2-02-turn-complete.png` / `w2-03-boot2-reopened.png`。

## 二、fork 路径（断言 C/D）——引用豁免

- 依据：dcf0efe12 G-V3（fork 后暗号轮落 fork 文件、header parentSession 血缘指针指向源文件、源文件字节不变、重开一致）PASS。
- 豁免理由：W1 的 diff（verifier 逐行核对，w1-report.md）**零触碰 forkSession**——fork 代码态与 dcf0efe12 验证时一致，重跑无信息增益。

## 三、执行形态变更依据与风险评估

1. **引用证据充分性**：dcf0efe12（用户会话产出，公开入库）在相同环境（dev 隔离 + 真实 pi + 精确 kill PGID + 第二次重启断言）下完成了基线 W2 的超集验证：G-V1（上次 p3 gate 失败链原样反转：7→16 行落盘 + 二次重启零丢失 + 用量单调 + tmp 零孤儿）、G-V2a/V2b（legacy 归一化 + AI 记暗号上下文链 + 幂等）、G-V3（fork）、G-X（9 附着零断言误报 + 零 tmp 孤儿 + 零 .tmp-migrate 残留）。
2. **代码态差异 = W1**：renameSession 非活跃分支（restore/fork 路径不经过）+ restoreSession 等价重构。后者由本冒烟（§1）在 HEAD 一手验证 F2 直附着行为不变；前者不在场景 3 链路。
3. **时间线重叠风险**：dcf0efe12 gate 执行窗口 22:08-22:42；W1 builder 写文件始于 ~22:45+（派发 22:40，前段读码）。gate 核心场景 22:33 前完成；尾部（G-V3/G-X/收尾）即便与 builder 窗口擦边，gate 4/4 PASS 本身证明其加载的代码态行为正确（attach 断言全程未误伤）。无反向污染（builder 未跑 dev app）。

## 四、p1p4 P3 gate 改判

- 上次 FAIL 依据（用户裁决 2026-08-19）：「restore 数据丢失绝不能判 PASS」——场景 3 restore 路径一手复现数据丢失（p3-gate-report.md §3.3）。
- 本次复验：同 session 同操作序列下失败链反转（§1 断言 A/B）+ fork/legacy/断言护栏超集引用（§2/§3）。
- **改判：P3 gate PASS**。p1p4 ledger 同步更新（gate 表 + 事件节收官条目）。

## 五、观察项（非阻断，如实记录）

1. thinking 档显示波动：boot1 restore 后显示「最高」，冒烟轮完成后显示「高」，boot2 重开后恢复「最高」。状态感知类显示差异，非数据丢失形态，与 findings 既有状态感知问题族同域，不阻断（本 gate 断言不含 thinkingLevel 一致性）。
2. 冒烟期间 UI「变更集」面板显示 +224/-48——本仓 W1 改动的 git 状态投影，与验证无关。

## 六、环境收尾

- 两次 dev 启停均精确 kill 本方进程组（`kill -TERM -87527` / `-88781`），结束端口 1420/9222/3310 全部确认清零。
- 打包版 TaiJi.app 全程未触碰；测试数据留在 `~/.xyz-agent-dev/`（正常使用痕迹）；$TMPDIR 3 个历史孤儿保留（前次 gate 证据，OS 重启自动清）。
