// [D4-② 轮次结算职责轴] chatMode 轮次完成的业务闭包（原 SubagentService
// buildSessionRunnerContext 内的 onRoundSettled 回调 ~95 行区域）整体搬移至此
// （行为逐字节等价：搬移 + 依赖注入，不重写逻辑）。变化轴：改轮次增量派生 /
// notify 时序 / base 推进 / closeAfterRound 消费语义，只改本文件；Service 经
// buildSessionRunnerContext 注入三个依赖回调（notify / 持久化上报 / close 兑现）。

import { getLogger } from "../core/logger.ts";

import { getFullTextFrom, nextRoundBaseTurnIndex } from "./execution-record.ts";
import type { ExecutionRecord } from "./types.ts";

const logger = getLogger("subagents");

/** 轮次结算的依赖注入（Service 侧供给）。 */
export interface RoundSettlementDeps {
  /** 本轮增量的通知投递（Service.notifyComplete——经 notifyHost）。 */
  notifyComplete: (record: ExecutionRecord) => void;
  /** 轮终迁移持久化上报（store.reportRecordTransition——live ≡ reload 等价性）。 */
  reportRecordTransition: (record: ExecutionRecord) => void;
  /** closeAfterRound 兑现（Service.closeAfterRoundSettled——chatMode 优雅关闭的终态化）。 */
  closeAfterRoundSettled: (record: ExecutionRecord) => Promise<void>;
}

/** 构造 onRoundSettled 回调（session-runner agent_settled 时调用）。
 *
 * [V2 决策 2] chatMode 首轮闭环：session-runner 已 arm idle timer，
 * isIdle=true 让 notify 守卫放行（时序：armIdleTimer → onRoundSettled）。
 * 回调体原为 subagent-service.ts buildSessionRunnerContext 的内联闭包，D4-② 拆出。 */
export function createRoundSettler(deps: RoundSettlementDeps): (record: ExecutionRecord) => void {
  return (record) => {
    // v4 B-1：status 保持 running（旧 idle 折入 running）；session-runner 已 arm idle timer，
    // isIdle=true 让 notify 守卫放行（时序：armIdleTimer → onRoundSettled，见 session-runner.ts:670）。
    // round 可能初始 undefined（与 notifier.ts `record.round ?? 0` 兜底一致），
    // 首轮 0+1=1。round 是 notifier dedup key 的组成部分，递增后同 id 下一轮不被 60s dedup 吞。
    record.round = (record.round ?? 0) + 1;
    // [N2][增量] 轮次回复写点（增量语义）：roundText 自 roundBaseTurnIndex 起派生本轮增量
    //（undefined 视为 0——首轮增量 = 全量，与改造前首轮逐字节一致）。成功轮次的 MF-2 原写点
    //（doFinalizeRoundToIdle）不可达——agent_settled 恒 arm idle timer → runAndFinalize 恒
    // early return。写入 record.result 后再 notify；本轮无非空增量且无 lastError（纯工具轮 /
    // interrupt 抢占轮 / 模型空回复）时固定占位 "(no output this round)"（D5：增量语义下沿用
    // 旧 record.result = 上一轮增量 → 本轮通知正文 = 上一轮内容，父 agent 误读为原样重复回复；
    // lastError 兜底保留让失败轮通知可读）。后续 closeAfterRoundSettled 的合成 result 读
    // record.result，同样携带本轮增量。
    const roundText = getFullTextFrom(record, record.roundBaseTurnIndex ?? 0);
    record.result = roundText ||
      (record.lastError ? `round did not complete: ${record.lastError}` : "(no output this round)");
    // 先送达本轮增量（notify），再推进 base / 消费 closeAfterRound——终态通知由
    // closeAfterRoundSettled / closeChatIdle 的 notifyClosed 显式发出（dedup 身份为裸 id，
    // 与本次 round notify 的 id:round key 区分），保证「本轮增量 + 终态通知」都送达；
    // 轮次收尾 .then 的冷路径 notifyComplete 仍与本次 round notify 同 key 被 60s
    // dedup 吞（不构成第三条）。
    //
    // 幂等性（覆盖面如实限定）：同步路径 at-least-once——notifyComplete（同步 void）抛错时
    // 推进/消费被跳过 → base 不推进 → 增量未消费，下轮 roundText 必含本轮文本（重发载体为
    // 后续轮次增量拼接）。轮次收尾 .then 的冷路径 notifyComplete 不构成重发通道
    // （notifier dedup.set 与 pending.splice 均先于 sendMessage，同 key `${id}:${round}`——
    // round 已递增——60s 窗内重入被吞）。异步 flush 窗口不保证：合并 timer armed（其他 busy
    // background 在场）或 isIdle 退避期间 notify 的『成功』只是入队，实际 sendMessage 发生在
    // base 推进之后的异步时机；该窗口进程崩溃或 sendMessage 失败 → 丢失不可重发（现状全量
    // 重发的次轮自愈在增量语义下消失），wave1 期恢复通道仅父 agent 经 /subagents 详情读取
    // record.result，wave2 指针行落地后补全。反序（先推进后 notify）在同步路径 notify 失败时
    // 静默丢增量且无任何重算机会，故 notify 后推进是定案。重复发送由 notifier dedup key
    // 60s 窗界定。
    deps.notifyComplete(record);
    // R1 观测哨（不变式违反形态）：推进前检查末 turn 未闭合且 text 非空——pi 现序下不可达
    //（带 usage 的 message_end 恒先于 turn_end，settle 时 turn 全闭合，见 types.ts
    // roundBaseTurnIndex 注释的行号锚定），ES1 单测自造事件序列锁不住 pi 层变化；pi 升级若
    // 改变 turn_end/agent_end 时序，此哨兵留痕（该形态下公式仍把文本计入本轮，不丢数据）。
    const lastTurn = record.turns[record.turns.length - 1];
    if (lastTurn !== undefined && !lastTurn.closed && lastTurn.text.length > 0) {
      logger.warn(
        `[subagents] round settle with unclosed non-empty turn (record=${record.id}, turnIndex=${record.turns.length - 1}) — pi turn_end/agent_end ordering may have changed`,
      );
    }
    // [增量] base 推进（notify 之后）：下一轮增量从本轮边界起。滞后空 turn 不计入边界
    //（防御分支，留在下一轮增量内防丢文本——nextRoundBaseTurnIndex 注释）。
    record.roundBaseTurnIndex = nextRoundBaseTurnIndex(record);
    // 轮终迁移持久化（residual-fixes U3 补全）：热路径轮终不经 doFinalizeRoundToIdle
    //（agent_settled 恒 arm idle timer → runAndFinalize 恒 early return，MF-2 原写点
    // 不可达）——不 appendEntry 则 runtime/W18 派生缓存不失效，renderer 停留在
    // register 快照（无 result），chat 等续聊的 waiting 形态显示不出来、spinner
    // 卡死。显式上报：entry 携带本轮 result/round/chatMode（§5.4：result 有值 +
    // chatMode=true → waiting）。closeAfterRound 的终态 entry 在此后追加，序不变。
    deps.reportRecordTransition(record);
    // [M5] closeAfterRound 消费点：chatMode 每轮完成的统一汇聚点（热路径轮不经
    // runAndFinalize CAS 分支——agent_settled 恒 arm idle timer → runAndFinalize 恒
    // early return，旧消费点对 chatMode 不可达，标志置了无人消费、tool 谎报 closed:true）。
    if (record.closeAfterRound) {
      record.closeAfterRound = undefined;
      void deps.closeAfterRoundSettled(record);
    }
  };
}
