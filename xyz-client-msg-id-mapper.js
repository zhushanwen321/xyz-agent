/**
 * xyz-client-msg-id-mapper.js — pi file-type extension.
 *
 * 建立 clientUuid ↔ userEntryId 映射，供 xyz-agent 重开 session 时回填 segment 元数据
 * （image path/displayName、file path/lineRange 等）。
 *
 * 机制（不改 pi 源码，纯 extension hook）：
 *  1. xyz-agent 发 prompt 时在文本末尾加 HTML 注释标记 `<!--xyz:msg:<uuid>-->`
 *     （uuid 是 appendUser 生成的完整 user message id，形如 `u-<36hex>`）。
 *  2. `input` hook 拦截 source==='rpc' 的 prompt，剥离标记（LLM 看不到 transform 后的版本
 *     之外的内容），并把 uuid 记到 pendingClientUuid。
 *  3. user `message_end` 后下一个触发的 hook（message_start/turn_end/agent_end）读
 *     `ctx.sessionManager.getLeafId()` —— 此时它返回的是已持久化的 userEntryId。
 *  4. `pi.appendEntry("xyz.client-msg-id", {clientUuid, userEntryId})` 把映射写进 pi JSONL
 *     （CustomEntry，不进 LLM 上下文）。
 *
 * 映射随 fork/clone 自动保留（在同一 JSONL 里）。xyz-agent 重开时调 `get_entries` 扫描
 * customType==="xyz.client-msg-id" 的 entry 重建映射表。
 *
 * 降级策略：任何 hook 抛错 → pi runner 的 try/catch 吞掉，映射缺失，重开时 xyz-agent
 * 自动降级为 textToSegments（按纯文本拆 segment）。映射缺失不影响 agent 主流程。
 *
 * 单文件 ESM，与 xyz-system-prompt-extension.js 同模式（无 build step、无 npm deps），
 * pi 通过 `--extension <path>` 在 spawn 时加载。
 */

// uuid = appendUser 生成的 user message id（`u-` + 36 字符 hex uuid，共 38 字符）。
// 与 shared SegmentsMetadataEntry.clientUuid 严格一致（同 appendUser 返回值）：
// extension 写入 custom entry 的 clientUuid = segments.json 的 clientUuid key，
// entry-tree-builder 据此精确回填 segments（无前缀转换、无双 source of truth）。
const TAG = /<!--xyz:msg:(u-[0-9a-fA-F-]{36})-->/
const ENTRY_TYPE = 'xyz.client-msg-id'

export default function (pi) {
  // 待处理的 client uuid（input hook 抓到标记后写入，flush 后清空）。
  let pendingClientUuid = undefined
  // user message 已 message_end、等待 flush（拿到 leafId 后写映射）。
  let awaitingUserPersist = false

  // input hook：拦截 xyz-agent 发来的 prompt（source === 'rpc'），剥离标记。
  // 非 rpc（interactive/extension）输入不含标记，直接 continue。
  pi.on('input', (event) => {
    try {
      if (event.source !== 'rpc') return { action: 'continue' }
      const m = event.text && event.text.match(TAG)
      if (!m) return { action: 'continue' }
      pendingClientUuid = m[1]
      // transform 后 LLM 看到的是剥离了标记的纯文本。
      return { action: 'transform', text: event.text.replace(TAG, '').trimEnd() }
    } catch (err) {
      // 吞错，不阻断主流程（pi runner 也会 try/catch，但显式兜底避免意外 return）。
      console.error('[xyz-client-msg-id-mapper] input hook error:', err)
      return undefined
    }
  })

  // message_end：user message 持久化前触发。此时 getLeafId() 还指向上一条 entry
  // （user message 尚未落盘），所以只置 flag，真正 flush 在下一个 hook。
  pi.on('message_end', (event) => {
    try {
      if (event.message && event.message.role === 'user' && pendingClientUuid) {
        awaitingUserPersist = true
      }
    } catch (err) {
      console.error('[xyz-client-msg-id-mapper] message_end hook error:', err)
    }
    return undefined
  })

  // flush：读 getLeafId()（= userEntryId，user message 已持久化）+ appendEntry 写映射。
  // 幂等：写完即清空 pendingClientUuid / awaitingUserPersist，重复触发无副作用。
  const flush = (ctx) => {
    if (!awaitingUserPersist || !pendingClientUuid) return
    try {
      const userEntryId = ctx && ctx.sessionManager && typeof ctx.sessionManager.getLeafId === 'function'
        ? ctx.sessionManager.getLeafId()
        : null
      if (!userEntryId) return // leafId 还没更新，等下一个 hook
      pi.appendEntry(ENTRY_TYPE, {
        clientUuid: pendingClientUuid,
        userEntryId,
      })
      pendingClientUuid = undefined
      awaitingUserPersist = false
    } catch (err) {
      console.error('[xyz-client-msg-id-mapper] flush error:', err)
    }
  }

  // 三重安全网：user message_end 后第一个触发的 hook 拿到的 leafId 才是 userEntryId。
  // message_start（assistant 开始，此时 user message 已落盘）—— 主路径。
  pi.on('message_start', (_event, ctx) => flush(ctx))
  // turn_end / agent_end 兜底（abort 等场景 message_start 可能不来）。
  pi.on('turn_end', (_event, ctx) => flush(ctx))
  pi.on('agent_end', (_event, ctx) => flush(ctx))
}
