# 设计审查报告：update-network-resilience

- 对象：[update-network-resilience.md](update-network-resilience.md)
- 审查方式：tech-design 对抗式审查（agent：tech-design-review），3 轮循环，每轮全修 must-fix + suggestion 后聚焦复审
- 日期：2026-08-30

## 轮次与结论

| 轮次 | must-fix | suggestion | 轮次结论 |
|------|---------|-----------|---------|
| R1（初审） | 8 | 13 | 方向成立；硬伤集中在 curl 规格层（缺 `-L`）与降级状态语义（flag 过度泛化、中间失败无落盘）；关键事实声明全部经源码核实无误 |
| R2（复审） | 3 | 6 | R1 的 21 条全部落实；新引入矛盾 3 处（probe 置 flag 架空瞬时类收窄、Linux 无 curl 丢直连兜底、exit 22 引用不存在的 `--fail`） |
| R3（终审） | **0** | 3 | R2 的 9 条全部落实且联动一致；剩余 3 条 suggestion（install version 契约同步点、A 案行内与 D10 表述同步、残留一处对话上下文引用）已当轮修复入文档 |

## 最终判定

- **must_fix == 0，suggestion == 0（全部修复）**：设计就绪，可进入实施层。
- 审查确认的关键事实：文档引用的现状代码行为（检测有直连降级 / manifest fallback 裸 undici / 下载无降级 / `resolveByVersion` 网络前置 / 两 UI 入口共用 IPC / install 权威源 preloaded）全部与源码一致；§2.2 实测证据链自洽。
- 审查的主要战果（已固化进文档决策栏）：curl 必带 `-L` 与 `-f`（GitHub release 302 实证）、`enginePreference` 仅对连接建立失败四码置位（`EHOSTUNREACH`/`ECONNREFUSED`/`ENETUNREACH`/`UND_ERR_CONNECT_TIMEOUT`）、D10 三步降级链含 curl 缺失时回退 undici 直连、双引擎中间失败在降级点落盘 `source:'engine-fallback'`、双失败报 undici 分类（errno 精准）、认领三重校验与并发幂等语义、pending 落后边界的「宁拒不猜」。

## 被否谱系（最终形态）

- 全改 curl 子进程（弃 undici）——丢失流式进度/多段并发/精细超时，回归风险大。
- 仅在 download-asset 内联 fallback（不抽封装）——五条路径降级语义 drift。
- 仅下载直连降级（D 案单独成立）——不覆盖「直连被墙 + 授权失效」组合；被吸收为 D10 直连兜底。
- flag 对全部网络错误码置位——单 part 瞬时抖动（ECONNRESET/ENOTFOUND 国内常态）永久误杀多段并发。
- probe 降级成功即无条件置 flag——同上危害换入口（R2 抓回）。
- 仅文件名/仅 size 认领——恶意替换安装面；sha256 必须匹配。
- 认领时 force check 拿权威 release——认领场景恰恰断网，失去逃生通道意义。
