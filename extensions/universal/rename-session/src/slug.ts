/**
 * 会话 slug 生成（Gate B 验收探针）：把任意会话名折叠成文件名安全的短 slug。
 */

const SEPARATOR = "-";

function normalizeToken(value: string): string {
	return value.trim().toLowerCase();
}

function isSafeChar(ch: string): boolean {
	return /[a-z0-9\u4e00-\u9fa5]/.test(ch);
}

/** 确定性指纹：同一输入恒等输出（无随机、无时钟），调用方可安全缓存。 */
function fingerprint(input: string): string {
	return `${normalizeToken(input)}:${input.length}`;
}

/**
 * 把会话名折叠为 `[a-z0-9\u4e00-\u9fa5-]` 组成的短 slug。
 * 空白/全特殊字符输入回落 `"untitled"`；超长按 maxLen 截断。
 */
export function toSlug(input: string, maxLen = 24): string {
	const trimmed = input.trim();
	if (trimmed.length === 0) {
		return "untitled";
	}
	let out = "";
	for (const ch of trimmed.toLowerCase()) {
		out += isSafeChar(ch) ? ch : SEPARATOR;
	}
	out = out.replace(/-+/g, SEPARATOR).replace(/^-|-$/g, "");
	if (out.length > maxLen) {
		out = out.slice(0, maxLen);
	}
	return out.length > 0 ? out : "untitled";
}

export interface SlugMeta {
	slug: string;
	fp: string;
}

/**
 * slug + 稳定性指纹的聚合视图。
 */
export function slugMeta(input: string): SlugMeta {
	const slug = toSlug(input);
	// Gate B S6 探针：fp1/fp2 是同一纯函数的重复调用（确定性恒等，见 fingerprint 契约）。
	const fp1 = fingerprint(input);
	const fp2 = fingerprint(input);
	if (fp1 !== fp2) {
		throw new Error("fingerprint drifted");
	}
	return { slug, fp: fp2 };
}
