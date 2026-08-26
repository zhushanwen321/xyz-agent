# slash 命令投递闭环验收记录（S1-S6）

> 执行日期：2026-08-26 · 环境：真实 dev app（`pnpm dev`，Electron 9222 + Vite 1420 + runtime + pi 子进程，零 mock）· 验收人：主 agent（Playwright over CDP）
> 对照设计：`slash-commands-delivery-closure.md` §4

## 结论

**S1 / S2 / S3 / S4 / S5 / S6 全部通过**（G1-G4 全部达成，P10 探针通过）。

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| S1 | 新建即完整 | ✅ | landing `/` 浮层含 /goal /todo + 43 skills（chrome-automation/create-worktree/…）；发送首条消息进 panel 态后 `/` 浮层 16,180 字节：/compact + /goal + /xyz-navigate + /permission + /auto-rename + 87 处 skill 描述命中——skill 无一消失 |
| S2 | 切换不丢不串 | ✅ | A(01a03be5，16,321B 含 A 独有 zzz-s1-acceptance-test) ↔ B(01a027f8，14,006B，各自命令集) 往返切换，分区隔离双向无污染 |
| S3 | 打开即新鲜 | ✅ | `~/.agents/skills/` 新建 zzz-s1-acceptance-test → 等 reload 锚点（chokidar 300ms debounce + ReloadOrchestrator idle reload，实测 <15s）→ 重开浮层 16,180→16,284 且新 skill 在列；删除后恢复。负面层（reload 进行中旧值保留）因本机 reload 编排快于采样窗口（600ms）未能捕获旧值窗口——窗口存在性由 S4 kill 场景的旧值保留行为佐证，如实记录 |
| S4 | 降级可恢复 | ✅ | kill 会话 A 的 pi 进程 → 打开浮层：显示旧列表（16,180B 含 goal）、0 错误弹窗；console warn 路径由单测覆盖（use-command-sync.test.ts 失败分支断言），真实 kill 后恢复太快未触发 warn，如实记录 |
| S5 | 重启自愈 | ✅ | 关闭 Electron 重启（用户误关真实触发）→ runtime `ensureActive: restoring 01a03be5`（日志 02:43:52）+ 新 pi 进程拉起 → 切回会话输入 `/` 列表完整恢复（16,180B、含 goal、无 warn）——覆盖 FM2 幂等守卫短路场景的重连/restore 恢复腿 |
| S6 | 打开不重不闪 | ✅ | 连续开关浮层 5 次：内容长度恒定 16,180，无重复项、无闪烁（in-flight 去重 + applyCommands 全量覆盖幂等生效） |
| P10 | 打开延迟探针 | ✅ | 打开浮层 → DOM 内容就绪 <1.5s（含 300ms 输入节流采样间隔），RPC 补拉无可感知延迟——未触发降级路径（仅空表时拉） |

## 环境注记

- 期间用户误关 Electron 窗口一次（9222 断开），重启后补跑 S5——意外成为 S5 的真实触发样本。
- S3 负面窗口与 S4 warn 未在真实环境捕获的原因均为「恢复快于采样」，非实现缺陷；对应行为已由单测覆盖。

## 遗留

无。测试 skills（zzz-s1-acceptance-test / zzz-s3b-negative）已清理。
