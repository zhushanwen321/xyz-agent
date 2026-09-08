-- ============================================================================
-- zcode-session-db-isolation.md 的 F6 / F8 / F9 证据查询（可一键复跑）
--
-- 两库均以只读模式打开（不会写入宿主数据）：
--   引擎库：~/.zcode/cli/db/db.sqlite
--   索引库：~/.zcode/v2/tasks-index.sqlite
--
-- 用法（macOS 自带 sqlite3）：
--   sqlite3 "file:$HOME/.zcode/cli/db/db.sqlite?mode=ro"      < counts.sql
--   sqlite3 "file:$HOME/.zcode/v2/tasks-index.sqlite?mode=ro" < counts.sql
-- 说明：同一份脚本在两个库上执行时，不适用的语句会因缺表报错——按下面的分节标记
--       分别在对应库上执行对应段落即可（或直接跑整份，忽略「no such table」行）。
-- 复现时点：2026-09-08；数字随时间变化属预期（本文件的价值是「查询可复跑」）。
-- ============================================================================

-- ── 1) F6：进索引的判别键是 task_type（不是 parent_id） ──── 引擎库 ──────
-- 输出（2026-09-08 实测）：
--   interactive|no_parent|867   subagent_child|has_parent|792
--   interactive|has_parent|13   fork|has_parent|6   selection_side_chat|has_parent|2
SELECT task_type,
       CASE WHEN parent_id IS NULL THEN 'no_parent' ELSE 'has_parent' END AS parent_state,
       COUNT(*) AS n
FROM session
GROUP BY task_type, parent_state
ORDER BY n DESC;

-- 索引库侧：列出已进索引的 task_id（与上面 session.id 交叉即得 F6 的
-- 「subagent_child 787/788 未进索引；interactive+has_parent 13/13 全进」结论）
SELECT COUNT(*) AS indexed_tasks FROM tasks;
SELECT task_id FROM tasks ORDER BY task_id;

-- ── 2) F8：xyz-agent 自身产生的会话与其索引命中数 ─────────── 两库 ──────
-- 白名单来源 = xyz-agent record 存储里的 engineHandle.sessionRef.sessionId：
--   grep -h -o '"sessionId":"[^"]*"' ~/.xyz-agent/pi/sessions/*.jsonl | sort -u
-- 把结果贴进下面两个 IN 列表（示例占位，勿留占位符执行）：
-- 引擎库：
SELECT COUNT(*) AS our_sessions,
       MIN(time_created) AS first_created,
       MAX(time_created) AS last_created
FROM session
WHERE id IN ('<sessionId-1>', '<sessionId-2>' /* … */);

-- 索引库：
SELECT COUNT(*) AS our_indexed_tasks
FROM tasks
WHERE task_id IN ('<sessionId-1>', '<sessionId-2>' /* … */);

-- ── 3) F9：会话标题生成的用量行（`titleGenerationEnabled:false` 的对照） ── 引擎库 ──
-- 判别列是 query_source（取值：main_turn / subagent / session_title / compact），
-- 不是 task_type（task_type 只有 interactive / subagent_child / fork）。
SELECT COUNT(*) AS title_usage_rows,
       SUM(input_tokens) AS input_tokens,
       SUM(output_tokens) AS output_tokens
FROM model_usage
WHERE query_source = 'session_title';

-- 对照：全部用量规模（**口径 = input+output+cache_read_input_tokens，与正文 §2.4.2 一致**）
SELECT COUNT(*) AS all_rows,
       SUM(input_tokens + output_tokens + cache_read_input_tokens) AS total_tokens_same_caliber,
       SUM(computed_total_tokens) AS computed_total_tokens_for_reference
FROM model_usage;
-- 注：computed_total_tokens 约为前者一半（实测 10.45B vs 20.57B）——两者口径不同，勿混用。

-- ── 5) D4 量级锚：我们自己的会话 vs 全库均值（可复现） ─────── 引擎库 ──
-- 白名单：先用第 2 节的 `grep -h -o '"sessionId":"[^"]*"' ~/.xyz-agent/pi/sessions/*.jsonl | sort -u`
-- 口径：逐 session 键控表 sum(length(data)) ÷ 命中会话数 × DB 页开销
SELECT (page_count * page_size) AS db_bytes,
       (SELECT SUM(length(data)) FROM part) AS part_bytes,
       (SELECT COUNT(*) FROM session) AS all_sessions
FROM pragma_page_count(), pragma_page_size();
-- 方法①（dbstat 按行数占比归属，与文档 D4 方法①对应）：
--   sqlite3 "file:$HOME/.zcode/cli/db/db.sqlite?mode=ro" \
--     "SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC;"
--   再乘以「我们命中行数 / 全表行数」即得归属占用（文档实测 part 11.70MB + message 1.25MB
--   + session_entry 0.22MB + model_usage 0.81MB + tool_usage 0.48MB ≈ 14.5MB / 50 = 0.29MB/条）。
-- 我们的子集（把 id 列表贴进 IN）：
SELECT (SELECT SUM(length(data)) FROM part  WHERE session_id IN ('<id>' /* … */)) AS our_part_bytes,
       (SELECT SUM(length(data)) FROM message WHERE session_id IN ('<id>' /* … */)) AS our_msg_bytes,
       (SELECT SUM(length(data)) FROM session_entry WHERE session_id IN ('<id>' /* … */)) AS our_entry_bytes;
-- 2026-09-08 实测：全库 1,726,000,853B / 1682 会话 → 1.80MB/条；
--   我们 10,459,192B / 50 会话 → 0.37MB/条（页开销 1.75×）→ **差 4.9×**。

-- ── 6) §2.4.1：宿主伴生写入面（shell，非 SQL） ──────────────────────────
-- 窗口增量（成文时的 3h 窗口；窗口已过，仅作口径示例）：
--   find ~/.zcode/cli/<dir> -newermt "2026-09-08 10:30" ! -newermt "2026-09-08 13:30" | wc -l
-- 累计存量（随时可复测）：
--   du -sh ~/.zcode/cli/*

-- ============================================================
-- W5 参照查询（D7 I1 的「独立参照 SQL」单一文本来源；本节即权威文本，勿在别处复制）
-- 口径：直接删除集 = record 白名单 ∩ 宿主库 ∩ 索引预检通过集；
--       删除集总数 = 直接集 + 派生集（parent_id ∈ 直接集 且 task_type='subagent_child'）。
-- 复跑方式：① 用下面第 0 步把白名单与 record 时间戳导入临时库；
--           ② 把 :WHITELIST_DB 换成临时库路径后执行 ①②③。
-- ============================================================

-- 第 0 步：从 record JSONL 导出 (sessionId, startedAt) → /tmp/w5_whitelist.jsonl
--   node -e '
--     const fs=require("fs"),os=require("os"),path=require("path");
--     const dir=path.join(os.homedir(),".xyz-agent/pi/sessions");
--     const out=[];
--     for(const f of fs.readdirSync(dir).filter(x=>x.endsWith(".jsonl"))){
--       for(const line of fs.readFileSync(path.join(dir,f),"utf8").split("\n")){
--         if(!line.trim())continue;
--         let e; try{e=JSON.parse(line)}catch{continue}
--         if(e.type!=="custom"||e.customType!=="subagent-record")continue;
--         const sid=e.data&&e.data.engineHandle&&e.data.engineHandle.sessionRef&&e.data.engineHandle.sessionRef.sessionId;
--         if(sid) out.push(JSON.stringify({sessionId:sid,startedAt:e.data.startedAt}));
--       }
--     }
--     fs.writeFileSync("/tmp/w5_whitelist.jsonl",out.join("\n")+"\n");
--     console.log("rows",out.length);'
--   sqlite3 /tmp/w5.db "CREATE TABLE wl(sessionId TEXT PRIMARY KEY, startedAt INTEGER);"
--   sqlite3 /tmp/w5.db ".mode json" ".import /tmp/w5_whitelist.jsonl wl"

-- ① 直接删除集（宿主库；:WHITELIST_DB = /tmp/w5.db）
ATTACH DATABASE ':WHITELIST_DB' AS wl;
SELECT s.id, s.task_type, s.title_source, s.time_created
FROM session s JOIN wl.wl w ON w.sessionId = s.id;

-- ② 索引预检（索引库 ~/.zcode/v2/tasks-index.sqlite；零 FK，必须显式预检）
--    命中即「两侧同时剔除」（宿主行也不删）
-- sqlite3 ~/.zcode/v2/tasks-index.sqlite "
--   SELECT DISTINCT task_id FROM task_group_members WHERE task_id IN (SELECT sessionId FROM wl.wl)
--   UNION SELECT target_task_id FROM automations WHERE target_task_id IN (SELECT sessionId FROM wl.wl)
--   UNION SELECT session_id FROM off_peak_tasks WHERE session_id IN (SELECT sessionId FROM wl.wl)
--   UNION SELECT task_id FROM tasks WHERE off_peak_task_id IS NOT NULL AND task_id IN (SELECT sessionId FROM wl.wl);"

-- ③ 派生删除集（宿主库）
SELECT id FROM session
WHERE parent_id IN (SELECT s.id FROM session s JOIN wl.wl w ON w.sessionId = s.id)
  AND task_type='subagent_child';

-- ④ D7 I2 容差取值依据（可执行）：Δ = |record.startedAt - session.time_created|
--    我们行的 Δ 分布（r7 复测 max ≈ 4022ms → 容差取 10s，约 2.5× 余量）
SELECT COUNT(*) AS rows_,
       MIN(ABS(w.startedAt - s.time_created)) AS delta_min_ms,
       MAX(ABS(w.startedAt - s.time_created)) AS delta_max_ms,
       SUM(CASE WHEN ABS(w.startedAt - s.time_created) > 10000 THEN 1 ELSE 0 END) AS over_10s
FROM session s JOIN wl.wl w ON w.sessionId = s.id;

-- ⑤ 碰撞面：用户 interactive 会话落入我们任一 record ±10s 窗的计数
SELECT COUNT(*) AS collisions_10s FROM session u
WHERE u.task_type='interactive'
  AND EXISTS (SELECT 1 FROM wl.wl w WHERE ABS(w.startedAt - u.time_created) <= 10000)
  AND u.id NOT IN (SELECT sessionId FROM wl.wl);
