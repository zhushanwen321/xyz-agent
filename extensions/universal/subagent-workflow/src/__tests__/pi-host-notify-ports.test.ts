// src/__tests__/pi-host-notify-ports.test.ts
//
// [W4 读侧过滤②] pi 宿主通知域窄端口的跨 session 过滤适配单测：currentSessionId
// 传入时 countActiveFromEntries 按「register entry 的 sessionId ≠ 当前 session →
// 跳过」过滤（fork 继承的父级注册残留不进后代判定差集，层主不被残留误判「尚有
// 活跃后代」而保持进程空等唤醒）；缺省不过滤（既有调用方零改动行为不变）。
//
// createPiNotifyDomainPorts 构造不触 pi 运行时（getAgentDir/createDelivery 仅在
// HostServices 其他成员调用时消费），本测试直接构造端口对象验证差集口径。

import { describe, expect, it } from "vitest";

import { createPiNotifyDomainPorts } from "../host/pi-host.ts";

function registerEntry(id: string, type: string, sessionId: string): unknown {
	return {
		type: "custom",
		customType: "pending:register",
		data: { id, type, name: id, registeredAt: 1, sessionId },
	};
}

describe("createPiNotifyDomainPorts 读侧过滤②（W4）", () => {
	const entries = [
		registerEntry("bg-parent", "subagent", "sess-parent"),
		registerEntry("wf-parent", "workflow", "sess-parent"),
		registerEntry("bg-own", "subagent", "sess-child"),
	];

	it("传入 currentSessionId → 跨 session 残留不进后代判定差集", () => {
		const ports = createPiNotifyDomainPorts({ currentSessionId: "sess-child" });
		expect(ports.countActiveFromEntries(entries)).toBe(1);
	});

	it("缺省（未传）→ 不过滤（向后兼容：既有调用方零改动）", () => {
		const ports = createPiNotifyDomainPorts();
		expect(ports.countActiveFromEntries(entries)).toBe(3);
	});
});
