/**
 * [PROBE-ONLY] 会话 slug 生成（Gate B 验收探针）：把任意会话名折叠成文件名安全的短 slug。
 * 未接线进 rename 流程——Gate B 验收后接线或删除（review S-2）。
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
const DEFAULT_MAX_LEN = 24;

export function toSlug(input: string, maxLen = DEFAULT_MAX_LEN): string {
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
		// 截断发生在去尾分隔符之后（S-9）：截断后须再剥尾部悬挂分隔符
		out = out.slice(0, maxLen).replace(/-+$/, "");
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
	// fingerprint 为确定性纯函数（见契约注释），恒等无需重复调用自证
	return { slug, fp: fingerprint(input) };
}
