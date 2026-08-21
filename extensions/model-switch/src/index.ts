/**
 * Pi Model Switch — 模型切换扩展
 *
 * session_start/resume：注入精简的 [Available Models] 能力表（systemPrompt，仅首次，KV cache 友好）
 * switch_model tool：list/search/switch/recommend/setup
 *
 * 推荐功能（recommend action）仍保留 quota/snapshot/stickiness 计算逻辑，
 * 但不再每轮自动注入上下文——仅当 AI 主动调用 recommend 时才计算。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { migrateLegacyConfig } from "@zhushanwen/pi-llm-shared";
import { readCache } from "@zhushanwen/pi-quota-providers";
import { Type } from "typebox";

import { computePeakRecommend, computeQuotaSnapshot, computeStickiness } from "./advisor";
import { loadConfig } from "./config";
import { formatContextPrompt, formatSessionModels } from "./prompt";
import { deletePolicyConfig, generatePolicyConfig, getConfigPath, readEnabledModels, readPolicyConfigContent } from "./setup";
import { asSessionEntries, getCurrentModelId, type ModelPolicy } from "./types";

// ── Tool 返回值 helper ──────────────────────────────────

/**
 * execute 的返回形状（仅成功路径）。pi 契约里返回值不携带错误标记：
 * execute 只有 throw 才被置 isError:true（agent-loop.js:453-483），返回值里的
 * isError 字段会被 agent-loop 丢弃（W4 修复前曾误用，错误轮被标成功）。
 * 错误路径一律 throw new Error(文案)。
 */
interface ToolRes {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

function res(text: string): ToolRes {
	return { content: [{ type: "text" as const, text }], details: {} };
}

// ── 状态 ────────────────────────────────────────────────

interface SessionState {
	config: ModelPolicy | null;
	/** 首次 before_agent_start 时注入 [Available Models] 到 systemPrompt */
	injectedModelTable: boolean;
}

// ── Local interfaces (avoid `any` on Pi callback/event signatures) ────

/** Fields accessed from BeforeAgentStartEvent */
interface BeforeAgentStartLikeEvent {
	type: "before_agent_start";
	systemPrompt: string;
}

// ── 扩展入口 ────────────────────────────────────────────

export default function modelSwitchExtension(pi: ExtensionAPI) {
	const state: SessionState = { config: null, injectedModelTable: false };

	// [MIGRATION] Added in v0.6.0. Remove after v1.0.0 (one major past).
	// session_start 迁移：model-policy.json → config/model-switch-ext-config.json（幂等，过渡性）
	let configMigrationChecked = false;

	pi.on("session_start", async (_event: unknown, _ctx: ExtensionContext) => {
		if (!configMigrationChecked) {
			configMigrationChecked = true;
			migrateLegacyConfig(getAgentDir(), "model-policy.json", "config/model-switch-ext-config.json");
		}
		state.config = loadConfig();
		state.injectedModelTable = false;
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartLikeEvent, _ctx: ExtensionContext) => {
		if (!state.config) return;

		// 首次注入精简的 [Available Models] 到 systemPrompt（字节稳定 → KV cache 友好）
		if (!state.injectedModelTable) {
			const staticBlock = formatSessionModels(state.config);
			state.injectedModelTable = true;
			return {
				systemPrompt: `${event.systemPrompt}\n\n${staticBlock}\n`,
			};
		}
		return;
	});

	pi.registerCommand("setup-model-policy", {
		description: "Auto-generate config/model-switch-ext-config.json from your configured models",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (state.config) {
				ctx.ui.notify(`Config already exists at ${getConfigPath()}. Delete it first to regenerate.`, "info");
				return;
			}
			const enabledModels = readEnabledModels();
			const result = generatePolicyConfig(ctx.modelRegistry, enabledModels);
			ctx.ui.notify(result.summary, "info");
		},
	});

	registerSwitchTool(pi, state);
}

// ── Tool 注册 ──────────────────────────────────────────

function registerSwitchTool(pi: ExtensionAPI, state: SessionState): void {
	pi.registerTool({
		name: "switch_model",
		label: "Switch Model",
		description:
			"List configured models, search by alias/name, switch to another model, or show current data snapshot and rules. "
			+ "Configured models are defined in <agentDir>/config/model-switch-ext-config.json. "
			+ "Setup sub-actions: 'setup delete' (remove config), 'setup list' (show config), 'setup edit' (LLM-guided edit), 'setup' (generate new).",
		promptSnippet:
			"Use this tool to manage models. TRIGGERS: "
			+ "(1) User asks to list/search/switch models or mentions a specific model/provider. "
			+ "(2) Starting a simple task (file reads, quick edits, grep) — switch to the cheapest capable model to conserve quota. "
			+ "(3) Starting a complex task (architecture, refactoring, multi-file changes) — switch to the best reasoning model. "
			+ "(4) User mentions cost/quota concerns — recommend and switch to optimize usage. "
			+ "For policy management: 'setup delete' to remove, 'setup list' to view, 'setup edit' to modify through conversation.",
		parameters: Type.Object({
			action: StringEnum(["list", "search", "switch", "recommend", "setup"], {
				description: "Action: list (show all), search (filter), switch (change), recommend (show data+rules), setup (generate config)",
			}),
			query: Type.Optional(
				Type.String({
					description: "Search term (search/switch) or user's model preferences description (setup)",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { action: string; query?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ToolRes> {
			const action = params.action;
			const query = (params.query ?? "").trim().toLowerCase();

			if (action === "list") return handleList(state, ctx);
			if (action === "search") return handleSearch(state, query);
			if (action === "switch") return handleSwitch(state, pi, ctx, query);
			if (action === "recommend") return handleRecommend(state, ctx);
			if (action === "setup") return handleSetup(state, ctx, params.query);

			// 错误路径 throw（W4）：pi 只对 execute throw 置 isError:true，返回值 isError 被丢弃
			throw new Error(`Unknown action: ${action}. Supported: list, search, switch, recommend, setup.`);
		},
	});
}

// ── Action Handlers ────────────────────────────────────

function handleList(state: SessionState, ctx: ExtensionContext): ToolRes {
	if (!state.config) {
		return res("No model policy configured. Run /setup-model-policy to generate one.");
	}

	const currentModel = getCurrentModelId(ctx);
	const lines: string[] = [];

	for (const [provider, pcfg] of Object.entries(state.config.models)) {
		lines.push(`  ${provider} (plan: ${pcfg.plan}):`);
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			const modelStr = `${pcfg.plan}/${entry.modelId}`;
			const caps = entry.capabilities.length > 0 ? ` [${entry.capabilities.join(", ")}]` : "";
			const current = modelStr === currentModel ? " ← current" : "";
			lines.push(`    ${alias} → ${modelStr}${current}${caps}`);
		}
	}

	const sceneInfo = Object.entries(state.config.scenes)
		.filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
		.map(([s, aliases]) => `  ${s}: ${aliases.join(", ")}`)
		.join("\n");

	return res(`Configured models:\n\n${lines.join("\n")}\n\nScenes:\n${sceneInfo}`);
}

function handleSearch(state: SessionState, query: string): ToolRes {
	if (!state.config) return res("No model policy configured.");
	if (!query) throw new Error("Please provide a search query.");

	const matches: Array<{ provider: string; alias: string; entry: { modelId: string; capabilities: string[] } }> = [];

	for (const [provider, pcfg] of Object.entries(state.config.models)) {
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			if (alias.toLowerCase().includes(query)
				|| entry.modelId.toLowerCase().includes(query)
				|| provider.toLowerCase().includes(query)) {
				matches.push({ provider, alias, entry });
			}
		}
	}

	if (matches.length === 0) return res(`No models matching "${query}".`);

	const lines = matches.map(
		(m) => `  ${m.alias} (${m.provider}) → ${m.entry.modelId} [${m.entry.capabilities.join(", ")}]`,
	);
	return res(`Models matching "${query}" (${matches.length}):\n\n${lines.join("\n")}`);
}

async function handleSwitch(state: SessionState, pi: ExtensionAPI, ctx: ExtensionContext, query: string): Promise<ToolRes> {
	if (!state.config) throw new Error("No model policy configured. Cannot switch.");
	if (!query) throw new Error("Please specify a model alias to switch to (e.g., 'glm-5.1').");

	const match = findModelMatch(state.config, query);
	if (!match) throw new Error(`No model matching "${query}". Use 'list' to see available models.`);

	return switchToModel(pi, ctx, match.provider, match.plan, match.modelId, match.alias);
}

/** Exact match (alias or modelId), then fuzzy fallback. */
function findModelMatch(
	config: ModelPolicy,
	query: string,
): { provider: string; plan: string; modelId: string; alias: string } | undefined {
	// Exact match
	for (const [provider, pcfg] of Object.entries(config.models)) {
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			if (alias.toLowerCase() === query || entry.modelId.toLowerCase() === query) {
				return { provider, plan: pcfg.plan, modelId: entry.modelId, alias };
			}
		}
	}
	// Fuzzy match
	for (const [provider, pcfg] of Object.entries(config.models)) {
		for (const [alias, entry] of Object.entries(pcfg.models)) {
			if (alias.toLowerCase().includes(query) || entry.modelId.toLowerCase().includes(query)) {
				return { provider, plan: pcfg.plan, modelId: entry.modelId, alias };
			}
		}
	}
	return undefined;
}

function handleRecommend(state: SessionState, ctx: ExtensionContext): ToolRes {
	if (!state.config) return res("No model policy configured.");

	try {
		const currentModel = getCurrentModelId(ctx);
		const { snapshot, stickiness, recommend } = computeSnapshotAndRecommend(ctx, state.config);

		const formatted = formatContextPrompt({
			currentModel,
			stickiness,
			snapshot,
			recommend,
			config: state.config,
			now: new Date(),
		});

		return res(`Current model context:\n\n${formatted}`);
	} catch (err) {
		throw new Error(`Failed to compute context: ${(err as Error).message}`);
	}
}

function handleSetup(state: SessionState, ctx: ExtensionContext, query?: string): ToolRes {
	const subAction = (query ?? "").trim().toLowerCase();

	if (subAction === "delete") {
		const result = deletePolicyConfig();
		if (result.ok) {
			state.config = null;
			return res(`Config deleted: ${result.path}. Run /setup-model-policy to regenerate.`);
		}
		throw new Error(result.error);
	}

	if (subAction === "list") {
		const result = readPolicyConfigContent();
		if (!result.ok) throw new Error(result.error);
		return res(`Current config/model-switch-ext-config.json (${result.path}):\n\n\`\`\`json\n${result.content}\n\`\`\``);
	}

	if (subAction === "edit") {
		const result = readPolicyConfigContent();
		if (!result.ok) throw new Error(result.error);
		return res([
			"Current config/model-switch-ext-config.json for editing:\n",
			"```json",
			result.content,
			"```\n",
			"Tell me what you want to change. Examples:",
			'- "Change peak hours to 12-18"',
			'- "Add model X to coding scene"',
			'- "Set opencode-go rolling threshold to 90%"',
			'- "Remove minimax from the config"\n',
			"I'll modify the config and confirm with you before saving. Say 'save' when ready.",
		].join("\n"));
	}

	// No sub-action: generate new config
	if (state.config) {
		return res(`Config already exists at ${getConfigPath()}. Use 'setup delete' to remove, 'setup list' to view, or 'setup edit' to modify.`);
	}

	const enabledModels = readEnabledModels();
	const genResult = generatePolicyConfig(ctx.modelRegistry, enabledModels);

	return res([
		"Auto-generated config/model-switch-ext-config.json (v2).",
		"Review the config below. If it looks correct, write it to " + getConfigPath() + " using the write tool.",
		"",
		"```json",
		genResult.json,
		"```",
	].join("\n"));
}

// ── 辅助函数 ────────────────────────────────────────────

/** Shared quota snapshot + stickiness + recommend computation (for recommend tool action). */
function computeSnapshotAndRecommend(ctx: ExtensionContext, config: ModelPolicy) {
	const entries = asSessionEntries(ctx.sessionManager.getBranch());
	const cache = readCache();
	const snapshot = computeQuotaSnapshot(cache, config);
	const stickiness = computeStickiness(entries, config);
	const recommend = computePeakRecommend(new Date(), config, snapshot);
	return { snapshot, stickiness, recommend };
}

async function switchToModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	provider: string,
	plan: string,
	modelId: string,
	alias: string,
): Promise<ToolRes> {
	// pi 0.84.1 锚点：ModelRegistry.find(provider, modelId) 返回可直接喂给 setModel 的
	// Model 对象（node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:28）。
	// 解析链：config 的 provider key（setup 生成时已剥 -router 后缀）→ 补 -router 重试
	// （用户 models.json 可能用 router 变体注册同名 provider）→ plan 名兜底（部分 provider 与 plan 同名）。
	const model =
		ctx.modelRegistry.find(provider, modelId)
		?? ctx.modelRegistry.find(`${provider}-router`, modelId)
		?? ctx.modelRegistry.find(plan, modelId);
	if (!model) {
		// 错误路径 throw（W4）：pi 只对 execute throw 置 isError:true，返回值 isError 被丢弃
		throw new Error(`Model ${provider}/${modelId} not available in the pi model registry. Use 'list' to see configured models.`);
	}

	// pi 0.84.1 锚点：setModel 是 pi 唯一切模型 API（extensions/types.d.ts:954，
	// `setModel(model: Model<any>): Promise<boolean>`）。host 实现对未配置 auth 的
	// provider 返回 false（agent-session.js:1885-1890），因此 false 必须报错而非返回成功文案。
	// host setModel 内部自写原生 model_change entry（sessionManager.appendModelChange，
	// agent-session.js:1204 → session-manager.js:790-799）、持久化默认模型并广播 model_select
	// 事件——所以这里不再 appendEntry("model_change") custom entry：custom entry 非 pi 原生
	// 形态，session 重载恢复模型只认原生 entry（session-manager.js:146-160），写 custom 只会
	// 留下双份无效记录（曾因只写 custom entry 导致切换从未生效，见 pi-assumption-remediation B-F1）。
	let ok: boolean;
	try {
		ok = await pi.setModel(model);
	} catch (err) {
		// 错误路径 throw（W4）：包装文案保留原样，pi catch 后原样进 toolResult
		throw new Error(`Error switching: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!ok) {
		throw new Error(`Switch to ${alias} rejected: no API key/auth configured for provider ${model.provider}. Configure auth and retry.`);
	}

	return res(`Switched to ${alias} (${model.provider}/${model.id}).`);
}

// Re-export for programmatic usage (e.g., workflow extension)
