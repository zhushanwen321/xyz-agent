/**
 * goal_control adapter — successCriteria string[] handler 测试
 *
 * W1：handleCreate 接收 string[] 类型的 successCriteria，验证：
 * - 数组存入 state
 * - 空数组/空串项 → throw
 * - 完整字段后 state.successCriteria 为 string[]
 */
import { describe, expect, it } from "vitest";

import { handleCreate, type GoalControlParamsT } from "../adapters/goal-control-adapter";
import type { GoalRuntimeState } from "../engine/types";
import type { UiPort } from "../ports";
import type { ServicePorts } from "../service";
import { createGoalSession } from "../session";

function makeFakePorts(): ServicePorts & {
	states: GoalRuntimeState[];
	history: unknown[];
	notifications: Array<{ text: string; level: string }>;
} {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	const notifications: Array<{ text: string; level: string }> = [];
	return {
		states,
		history,
		notifications,
		persistence: {
			appendState: (s) => { states.push(s); },
			appendHistory: (e) => { history.push(e); },
		},
		ui: {
			setWidget: () => {},
			setStatus: () => {},
			notify: (text, level) => { notifications.push({ text, level }); },
			hasUI: true,
			isGui: false,
			setGuiWidget: () => {},
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as UiPort,
		messaging: {
			sendContextMessage: () => {},
			sendUserMessage: () => {},
		},
		session: {
			getEntries: () => [],
			getContextUsage: () => null,
			signal: undefined,
		},
	};
}

describe("handleCreate — successCriteria string[]", () => {
	it("successCriteria string[] → state.successCriteria 为 string[]", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		const details = handleCreate(
			{
				action: "create",
				slug: "test-goal",
				objective: "do something",
				successCriteria: ["criterion 1", "criterion 2", "criterion 3"],
			},
			session,
			ports,
		);

		expect(details.action).toBe("create");
		expect(details.status).toBe("active");
		expect(session.state!.successCriteria).toEqual(["criterion 1", "criterion 2", "criterion 3"]);
	});

	it("successCriteria 空数组 → throw", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		expect(() =>
			handleCreate(
				{
					action: "create",
					objective: "do something",
					successCriteria: [],
				},
				session,
				ports,
			),
		).toThrow(/successCriteria/);
	});

	it("successCriteria 含空串项 → throw（U6：文案含 Correct: 恢复正例）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		expect(() =>
			handleCreate(
				{
					action: "create",
					objective: "do something",
					successCriteria: ["valid", "  ", "also valid"],
				},
				session,
				ports,
			),
		).toThrow(/successCriteria[\s\S]*Correct:/);
	});

	it.each([
		["LF", ["line1\nline2"]],
		["CRLF", ["a\r\nb"]],
		["孤立 CR", ["a\rb"]],
	])("U7: 条目含换行（%s）→ throw 且文案含「单行」提示与 Correct: 正例", (_label, criteria) => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		expect(() =>
			handleCreate(
				{
					action: "create",
					objective: "do something",
					successCriteria: criteria,
				},
				session,
				ports,
			),
		).toThrow(/successCriteria[\s\S]*single-line[\s\S]*Correct:/);
	});

	it("U28②: 非 string 元素（绕过 schema 直调 handler）→ 业务 throw 含 Correct:，不产生 TypeError", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		// 直调 handler 绕过 schema 校验（测试/异常路径可能传入脏元素），断言运行时 typeof 防御
		const dirtyParams = {
			action: "create",
			objective: "do something",
			successCriteria: [1, null, true],
		} as unknown as GoalControlParamsT;

		expect(() => handleCreate(dirtyParams, session, ports)).toThrow(/successCriteria[\s\S]*Correct:/);
		expect(() => handleCreate(dirtyParams, session, ports)).not.toThrow(TypeError);
	});

	it("successCriteria undefined → throw", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();

		expect(() =>
			handleCreate(
				{
					action: "create",
					objective: "do something",
				},
				session,
				ports,
			),
		).toThrow(/successCriteria.*required/);
	});
});
