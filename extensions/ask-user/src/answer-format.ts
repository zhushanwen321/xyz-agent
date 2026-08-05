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

	// body/comment 切分点：两级扫描 + 不切分回退，语义见各段注释。
	// 第一级（MF-7 语义）：取「body 整串可解析为选中项」的最靠后分隔符 = 最长选中 body，
	// 其后的全部剩余文本为 comment。"可解析为选中项" = 整串精确命中单个 label（含逗号
	// label 如 "A, B"），或全部逗号 token 均为 label（多选 body，如 "Postgres — prod, MySQL"）。
	// 第二级（MF-2 回归修复）：第一级无命中时回退「body 含 ≥1 个 label token」的首个分隔符——
	// "Postgres — prod, custom text — note"（label 含分隔符 + Other 自由文本 + comment）
	// 无任何 all-label body，单谓词扫描落空 → 回退首分隔符把 label 拦腰截断，选中项静默丢失；
	// ≥1 谓词在真正分隔选中/Other 与 comment 的第二个分隔符命中。
	// 不切分回退（MF-3）：两级都无命中但整串含 label token（"Postgres — prod, custom text"
	// 无 comment 形态）→ 整串作 body（选中 + Other），不切分——首分隔符切分把 label 拦腰
	// 截断产生空选中。整串无任何 label token（S-17："custom — text" Other 自由文本自身含
	// 分隔符）→ 保持首个分隔符切分（body "custom" + comment "text"），不做解析层区分，
	// 由调用方（TUI encode）按 label 命中情况归属。
	// MF-7 固有歧义取舍（第一级）：重叠前缀 label 如 ["Postgres", "Postgres — prod"] 时，
	// "Postgres — prod — x" 取最靠后的整串命中即最长匹配（选中长 label + comment "x"）；
	// 若用户意图确实是「选短 label + comment 含长 label 前缀」会被误判——文本本身无法区分，
	// 精确 label body 优先是更优启发而非完备解；长 label 不在候选时（"Postgres — prod" 非
	// label）该意图解析正确。
	// 注意：分隔符扫描用原始 answer（不 trim）——comment-only 答案以 " — comment" 开头，
	// trim 会吃掉前导空格导致 indexOf 失配。
	let body = trimmed;
	let comment: string | undefined;
	let splitIdx = answer.indexOf(ANSWER_COMMENT_SEPARATOR);
	// 第一级：取「body 整串可解析为选中项」的最靠后分隔符
	let bestSplit = -1;
	let scan = splitIdx;
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
	if (bestSplit < 0) {
		// 第二级：取「body 含 ≥1 个 label token」的首个分隔符（R2 的 some() 谓词回归，
		// 仅在第一级无命中时运行——"A, B — note — x" 形态第一级已命中，不会过切）
		scan = splitIdx;
		while (scan >= 0) {
			const candidateTokens = answer.slice(0, scan).trim().split(/[,，]/).map((t) => t.trim()).filter(Boolean);
			if (candidateTokens.some((t) => labelSet.has(t))) {
				bestSplit = scan;
				break;
			}
			scan = answer.indexOf(ANSWER_COMMENT_SEPARATOR, scan + ANSWER_COMMENT_SEPARATOR.length);
		}
	}
	// MF-3 不切分回退：整串含 label token 时以整串为 body（选中 + Other），不切分。
	// splitIdx >= 0 前置（无分隔符时本就整串为 body，无需走此分支）。
	const noSplit = bestSplit < 0 && splitIdx >= 0 && allTokens.some((t) => labelSet.has(t));
	if (!noSplit && splitIdx >= 0) {
		if (bestSplit >= 0) {
			splitIdx = bestSplit;
		}
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
