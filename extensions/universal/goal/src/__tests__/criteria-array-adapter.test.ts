/**
 * goal_control adapter — successCriteria string[] handler 测试
 *
 * W1：handleCreate 接收 string[] 类型的 successCriteria，验证：
 * - 数组存入 state
 * - 空数组/空串项 → throw
 * - 完整字段后 state.successCriteria 为 string[]
 */
import { describe, expect, it } from "vitest";

import { handleCreate } from "../adapters/goal-control-adapter";
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

	it("successCriteria 含空串项 → throw", () => {
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
		).toThrow(/successCriteria/);
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
