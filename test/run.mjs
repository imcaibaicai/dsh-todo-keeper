// dsh-todo-keeper 单元验证：用假 ctx 驱动插件的 post-execute 链路，不需要启动 DSH。
// 运行： node test/run.mjs   （任意 Node >= 20；或 Electron 内置 node + ELECTRON_RUN_AS_NODE=1）
// 或本机任意 node >= 20。

import { apply, __test } from "../lib/index.js";

let pass = 0;
const failures = [];

function check(label, condition, detail) {
	if (condition) {
		pass += 1;
		console.log(`  PASS  ${label}`);
	} else {
		failures.push(label);
		console.log(`  FAIL  ${label}${detail === undefined ? "" : `  → ${detail}`}`);
	}
}

/** 极简假 ctx：只实现插件用到的 ctx.on。 */
function makeCtx() {
	const handlers = new Map();
	const ctx = {
		on(event, handler) {
			handlers.set(event, handler);
		}
	};
	const fire = async (event, ...args) => {
		const handler = handlers.get(event);
		if (handler === undefined) throw new Error(`没有注册 ${event} 的处理器`);
		return handler(...args);
	};
	return { ctx, fire };
}

/** 跑一次工具调用，返回下游决策。 */
async function runCall(fire, agent, name, args) {
	const exec = { agent, name, arguments: args };
	return fire("tools/post-execute", exec, {}, async () => ({}));
}

const ctxs = makeCtx();
apply(ctxs.ctx, { thresholds: [4, 8, 14], repeatEvery: 10, batchWarnAt: 4, includeTodoSnapshot: true });

const list = (statuses) =>
	statuses.map((status, index) => ({ content: `任务${index + 1}`, status }));

console.log("\n[1] 还没启用清单的 agent 不应被打扰");
{
	const agent = { id: "a1" };
	for (let i = 0; i < 10; i += 1) {
		const d = await runCall(ctxs.fire, agent, "pwsh", {});
		check(`无清单时第 ${i + 1} 次调用不注入`, d.additionalContexts === undefined);
	}
}

console.log("\n[2] 启用清单后，按阈值注入陈旧提醒");
{
	const agent = { id: "a2" };
	const created = await runCall(ctxs.fire, agent, "todo_write", {
		todos: list(["in_progress", "pending", "pending", "pending", "pending", "pending"])
	});
	check("首次建表不注入", created.additionalContexts === undefined);

	for (let i = 1; i <= 3; i += 1) {
		const d = await runCall(ctxs.fire, agent, "pwsh", {});
		check(`第 ${i} 次未到阈值不注入`, d.additionalContexts === undefined);
	}
	const at4 = await runCall(ctxs.fire, agent, "pwsh", {});
	const text4 = at4.additionalContexts?.[0]?.content?.[0]?.text ?? "";
	check("第 4 次注入提醒", at4.additionalContexts?.length === 1);
	check("提醒文案含连跑次数", text4.includes("连续 4 次"), text4.slice(0, 80));
	check("提醒文案含上次清单快照", text4.includes("- [~] 任务1"));
	check("注入消息来源标记为 plugin", at4.additionalContexts?.[0]?.source?.plugin === "dsh-todo-keeper");
	check("注入消息角色为 user", at4.additionalContexts?.[0]?.role === "user");

	for (const n of [5, 6, 7]) {
		const d = await runCall(ctxs.fire, agent, "pwsh", {});
		check(`第 ${n} 次不重复注入`, d.additionalContexts === undefined);
	}
	const at8 = await runCall(ctxs.fire, agent, "pwsh", {});
	check("第 8 次（第二阈值）再次注入", at8.additionalContexts?.length === 1);
}

console.log("\n[3] 更新清单会清零计数");
{
	const agent = { id: "a3" };
	await runCall(ctxs.fire, agent, "todo_write", { todos: list(["in_progress", "pending"]) });
	for (let i = 0; i < 3; i += 1) await runCall(ctxs.fire, agent, "pwsh", {});
	const updated = await runCall(ctxs.fire, agent, "todo_write", {
		todos: list(["completed", "in_progress"])
	});
	check("单项状态变化不触发批量警告", updated.additionalContexts === undefined);
	const after = await runCall(ctxs.fire, agent, "pwsh", {});
	check("更新后计数已清零", after.additionalContexts === undefined);
}

console.log("\n[4] 一口气批量勾选要警告");
{
	const agent = { id: "a4" };
	await runCall(ctxs.fire, agent, "todo_write", {
		todos: list(["in_progress", "pending", "pending", "pending", "pending", "pending"])
	});
	const flushed = await runCall(ctxs.fire, agent, "todo_write", {
		todos: list(["completed", "completed", "completed", "completed", "completed", "completed"])
	});
	const text = flushed.additionalContexts?.[0]?.content?.[0]?.text ?? "";
	check("一次改 6 项触发警告", flushed.additionalContexts?.length === 1);
	check("警告文案含改动条数", text.includes("6 项"), text.slice(0, 60));
}

// 用 [4, 100] 这组阈值把「重置」变成可观测的：不重置时第 8 次调用不会触发提醒，
// 重置后第 4 次调用会触发。4/8/14 的默认阈值下这两个数字会撞车，无法区分。
console.log("\n[5] 新一轮用户提示词会重置状态");
{
	const { ctx, fire } = makeCtx();
	apply(ctx, { thresholds: [4, 100] });
	const agent = { id: "a5" };
	await runCall(fire, agent, "todo_write", { todos: list(["in_progress", "pending"]) });
	for (let i = 0; i < 4; i += 1) await runCall(fire, agent, "pwsh", {});
	await fire("agent/pre-step", { agent, messages: [{ source: { kind: "user" } }] }, async () => {});
	// 新一轮里模型还没重新写清单 → 不该打扰（哪怕调用很多次）。
	let beforeRewrite = 0;
	for (let i = 0; i < 6; i += 1) {
		const d = await runCall(fire, agent, "pwsh", {});
		if (d.additionalContexts !== undefined) beforeRewrite += 1;
	}
	check("新一轮未重写清单前不打扰", beforeRewrite === 0, `实际触发 ${beforeRewrite} 次`);
	// 重新写清单后，计数从零开始。
	await runCall(fire, agent, "todo_write", { todos: list(["in_progress", "pending"]) });
	let afterRewrite = 0;
	for (let i = 0; i < 4; i += 1) {
		const d = await runCall(fire, agent, "pwsh", {});
		if (d.additionalContexts !== undefined) afterRewrite += 1;
	}
	check("重写清单后计数归零（第 4 次重新触发）", afterRewrite === 1, `实际触发 ${afterRewrite} 次`);
}

console.log("\n[6] 插件自己注入的提醒不会触发重置");
{
	const { ctx, fire } = makeCtx();
	apply(ctx, { thresholds: [4, 100] });
	const agent = { id: "a6" };
	await runCall(fire, agent, "todo_write", { todos: list(["in_progress", "pending"]) });
	for (let i = 0; i < 4; i += 1) await runCall(fire, agent, "pwsh", {});
	await fire("agent/pre-step", {
		agent,
		messages: [{ source: { kind: "plugin", plugin: "dsh-todo-keeper" } }]
	}, async () => {});
	let fired = 0;
	for (let i = 0; i < 4; i += 1) {
		const d = await runCall(fire, agent, "pwsh", {});
		if (d.additionalContexts !== undefined) fired += 1;
	}
	check("plugin 来源消息不重置计数（计数继续累加，未再触发）", fired === 0, `实际触发 ${fired} 次`);
}

console.log("\n[7] 参数解析与配置校验");
{
	check("解析对象参数", __test.parseTodos({ todos: [{ content: "x", status: "pending" }] })?.length === 1);
	check("解析字符串参数", __test.parseTodos('{"todos":[{"content":"y","status":"completed"}]}')?.[0]?.status === "completed");
	check("坏 JSON 返回 null", __test.parseTodos("{不是 json") === null);
	check("缺 todos 返回 null", __test.parseTodos({ other: 1 }) === null);
	check("状态变化计数正确", __test.countStatusChanges(
		[{ content: "a", status: "pending" }, { content: "b", status: "pending" }],
		[{ content: "a", status: "completed" }, { content: "b", status: "pending" }]
	) === 1);

	let threw = false;
	try {
		__test.resolveConfig({ thresholds: [] });
	} catch {
		threw = true;
	}
	check("空阈值数组 fail loud", threw);

	threw = false;
	try {
		__test.resolveConfig({ thresholds: [0] });
	} catch {
		threw = true;
	}
	check("非法阈值 fail loud", threw);

	const resolved = __test.resolveConfig({ thresholds: [8, 4] });
	check("阈值会排序", JSON.stringify(resolved.thresholds) === "[4,8]");
	check("未给配置时用默认值", JSON.stringify(__test.resolveConfig(undefined).thresholds) === "[4,8,14]");
}

console.log(`\n=== 结果：${pass} 项通过，${failures.length} 项失败 ===`);
if (failures.length > 0) {
	for (const name of failures) console.log(`  失败：${name}`);
	process.exit(1);
}
