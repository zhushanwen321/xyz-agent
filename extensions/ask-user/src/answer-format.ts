// src/answer-format.ts
// 答案文本格式的唯一权威模块。
// TUI 路径（submit-view.ts:getAnswerText）和 RPC 路径（index.ts:protoAnswersToResult）
// 都调 formatAnswer 产出 "label1, label2 — comment" 格式，确保两条路径一致。
// renderExpandedOptions（index.ts）调 parseAnswerParts 精确反解析选中项。
import { ANSWER_COMMENT_SEPARATOR } from "./types";

/**
 * 把答案各部分拼装为最终文本格式："part1, part2 — comment"。
 * - parts 为空 + comment 有值 → comment-only 答案（allowComment 的「无选项适用但想说明原因」
 *   场景）：以 ANSWER_COMMENT_SEPARATOR 开头，保持 parseAnswerParts 往返可解析
 * - parts 与 comment 都为空 → 返回 null（未答）
 * - comment 有值 → 追加 ANSWER_COMMENT_SEPARATOR + comment
 */
export function formatAnswer(parts: string[], comment?: string | null): string | null {
	if (parts.length === 0) return comment ? `${ANSWER_COMMENT_SEPARATOR}${comment}` : null;
	const base = parts.join(", ");
	return comment ? `${base}${ANSWER_COMMENT_SEPARATOR}${comment}` : base;
}

/**
 * 从最终答案文本中精确解析出选中的 labels（不依赖子串匹配）。
 * 用于 renderExpandedOptions 反向判定哪些选项被选中。
 *
 * @param answer 最终答案文本（formatAnswer 产出）
 * @param labels 候选 label 列表（q.options 的 label），精确匹配
 * @returns selected=命中的 labels（按 answer 中出现顺序），comment=评论文本（如有）
 */
export function parseAnswerParts(
	answer: string,
	labels: string[],
): { selected: string[]; comment?: string; otherTokens: string[] } {
	const labelSet = new Set(labels);
	const trimmed = answer.trim();

	// 整串精确命中单个 label → 单选该 label、无 comment。label 自身可能含
	// ANSWER_COMMENT_SEPARATOR（如 "Postgres — prod"），首个分隔符切分会把它拦腰截断。
	if (labelSet.has(trimmed)) return { selected: [trimmed], comment: undefined, otherTokens: [] };

	// MF-6：整串逗号切分的每个 token 都是 label → 纯多选、无 comment。
	// 必须置于分隔符扫描之前——"Postgres — prod, MySQL"（两个 label 都含分隔符形态）
	// 若进扫描，首个分隔符切在 "Postgres — prod" 中间，剩余 "prod, MySQL" 被误判为
	// comment，两个选中项全部静默丢失。仅当全部 token 均为 label 时触发：
	// "Postgres — prod, MySQL — note" 中 "MySQL — note" 非 label → 不进此分支，
	// 由分隔符扫描解析为选中 "Postgres — prod" + "MySQL" + comment "note"
	// （含 comment 的多选形态不破坏）。
	const allTokens = trimmed.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
	if (allTokens.length > 0 && allTokens.every((t) => labelSet.has(t))) {
		return { selected: allTokens, comment: undefined, otherTokens: [] };
	}

	// body/comment 切分点：取「body 整串可解析为选中项」的最靠后分隔符 = 最长选中 body，
	// 其后的全部剩余文本为 comment。"可解析为选中项" = 整串精确命中单个 label（含逗号
	// label 如 "A, B"），或全部逗号 token 均为 label（多选 body，如 "Postgres — prod, MySQL"）。
	// 无任何这样的切分（Other 自由文本 + comment 场景）→ 保持默认第一个分隔符。
	// MF-7：重叠前缀 label 如 ["Postgres", "Postgres — prod"] 时，"Postgres — prod — x"
	// 若取首个切分 → 选中 "Postgres" + comment "prod — x"，用户实际更可能是选中长 label
	// + comment "x"——取最靠后的整串命中即最长匹配。固有歧义取舍：短 label 与长 label
	// 同时存在且用户意图确实是「选短 label + comment 含长 label 前缀」（"Postgres" +
	// comment "prod — x"）时此启发会误判为长 label——文本本身无法区分，精确 label body
	// 优先是更优启发而非完备解；长 label 不在候选时（"Postgres — prod" 非 label）该意图
	// 解析正确。
	// 注意：分隔符扫描用原始 answer（不 trim）——comment-only 答案以 " — comment" 开头，
	// trim 会吃掉前导空格导致 indexOf 失配。
	// S-17：Other 自由文本自身含 " — "（如 "custom — text"）与「选中/Other + comment」
	// 形态在纯解析层面固有歧义，此处保持首个分隔符切分行为（body "custom" + comment
	// "text"），不做解析层区分——由调用方（TUI encode）按 label 命中情况归属。
	let body = trimmed;
	let comment: string | undefined;
	let splitIdx = answer.indexOf(ANSWER_COMMENT_SEPARATOR);
	let scan = splitIdx;
	let bestSplit = -1;
	while (scan >= 0) {
		const candidateBody = answer.slice(0, scan).trim();
		if (labelSet.has(candidateBody)) {
			bestSplit = scan;
		} else {
			const candidateTokens = candidateBody.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
			if (candidateTokens.length > 0 && candidateTokens.every((t) => labelSet.has(t))) {
				bestSplit = scan;
			}
		}
		scan = answer.indexOf(ANSWER_COMMENT_SEPARATOR, scan + ANSWER_COMMENT_SEPARATOR.length);
	}
	if (bestSplit >= 0) {
		splitIdx = bestSplit;
	}
	if (splitIdx >= 0) {
		body = answer.slice(0, splitIdx).trim();
		comment = answer.slice(splitIdx + ANSWER_COMMENT_SEPARATOR.length).trim() || undefined;
	}

	// body 形如 "label1, label2" → 精确匹配候选 label；剩余 tokens 不匹配任何 label
	// → Other 自由文本（otherTokens 返回给调用方，如 channel-handler 提取 __other）
	const tokens = body.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
	const selected: string[] = [];
	const otherTokens: string[] = [];
	for (const token of tokens) {
		if (labelSet.has(token)) {
			selected.push(token);
		} else {
			otherTokens.push(token);
		}
	}
	return { selected, comment, otherTokens };
}
