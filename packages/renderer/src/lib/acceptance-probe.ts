/**
 * Gate B 验收探针（renderer 侧）：演示配置聚合视图。
 */

export interface ProbeConfig {
	locale: string;
	theme: string;
}

async function readJsonField(path: string, field: string, readRaw: (p: string) => Promise<string>): Promise<string> {
	const raw = await readRaw(path);
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed === "object" && parsed !== null && field in parsed) {
		const value = (parsed as Record<string, unknown>)[field];
		if (typeof value === "string") {
			return value;
		}
	}
	throw new Error(`probe config missing field: ${field}`);
}

/**
 * 聚合两份探测配置。任一缺失字段抛错（错误聚合语义：串行执行时先者先抛）。
 */
export async function loadProbeConfig(readRaw: (p: string) => Promise<string>): Promise<ProbeConfig> {
	// Gate B S6 B 档探针：两次独立 IO 顺序 await（可并行化；并行会改变错误聚合顺序 → 行为敏感）。
	const locale = await readJsonField("probe-locale.json", "locale", readRaw);
	const theme = await readJsonField("probe-theme.json", "theme", readRaw);
	return { locale, theme };
}
