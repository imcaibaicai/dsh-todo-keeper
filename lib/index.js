// dsh-todo-keeper — 让 agent 的任务清单保持「与实际进度一致」的宿主侧提醒插件。
//
// 解决什么问题
// ---------------------------------------------------------------------------
// 网页端「任务」面板渲染的是**最后一次 `todo_write` 事件**：dsh-tool-todo 注册的
// 投影是 last-write-wins，前端通过 useProjection("todos") 读它。harness 不会替
// 模型补发 `todo_write`，所以模型「开工写一次清单 → 埋头干两分钟 → 收工再写一次」
// 就会让面板全程停在第一份快照上，也就是「第一项一直转圈，最后唰一下全打勾」。
//
// 本插件怎么解决
// ---------------------------------------------------------------------------
// 与官方 @deepseek-ai/dsh-repeat-tool-reminder 同族的**建议型 loop-breaker**：
//   - 不否决任何调用、不重写任何工具结果；
//   - 只统计「自上次 todo_write 以来连续多少次工具调用」；
//   - 一旦 agent 已经启用过清单（写过至少一次 todo_write），在达到阈值时通过
//     post-execute 决策的 additionalContexts 注入一条提醒（在会话里表现为一条
//     带来源标记的合成 user 消息，模型可见、可审计）。
//
// 依赖策略：本文件**不静态依赖任何包**。消息优先用官方 createUserMessage 构造；
// 若该包在插件真实路径下解析不到（junction 安装时的常见情况），则回退到手搓的
// 等价消息对象（与 repeat-tool-reminder 产出的形状完全一致）。

/** 插件在 cordis loader 里的行 id 也用这个名字（cordis.patch.yml 的 name 字段）。 */
export const name = "dsh-todo-keeper";

/** 目标工具名：DSH 的任务清单工具。 */
const TODO_TOOL = "todo_write";

/** 注入消息的来源标记；`plugin` 字段是必填的，缺了会被当成用户真实输入渲染。 */
const PLUGIN_SOURCE = { kind: "plugin", plugin: "dsh-todo-keeper" };

/**
 * 配置（从 cordis.patch.yml 的 config 传进来）。这里手写默认值与校验，不依赖
 * schemastery，避免 junction 安装时的模块解析问题。
 */
const DEFAULTS = {
	thresholds: [4, 8, 14],
	repeatEvery: 10,
	batchWarnAt: 4,
	includeTodoSnapshot: true
};

/** 官方消息构造器（可选加载）。 */
let createUserMessage = null;
try {
	const mod = await import("@deepseek-ai/dsh-llm/message");
	if (typeof mod.createUserMessage === "function") createUserMessage = mod.createUserMessage;
} catch {
	// 解析不到就用手搓回退，见 makeNotice()。
}

/**
 * 手搓一条与 createUserMessage 等价的、冻结过的 user 消息。
 * 回退路径必须与官方形状一致：id / role / content / source 四个字段齐全。
 */
function makeNoticeFallback(text, summary) {
	const message = {
		id: crypto.randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: { ...PLUGIN_SOURCE, form: "notice", summary }
	};
	// 与官方 createMessage 一致地冻结（结构化克隆后递归冻结，避免共享引用）。
	const clone = structuredClone(message);
	const seen = new WeakSet();
	const pending = [clone];
	while (pending.length > 0) {
		const node = pending.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		for (const key of Object.keys(node)) pending.push(node[key]);
	}
	return clone;
}

/** 构造一条注入消息（优先官方构造器）。 */
function makeNotice(text, summary) {
	if (createUserMessage !== null) {
		return createUserMessage({
			content: [{ type: "text", text }],
			source: { ...PLUGIN_SOURCE, form: "notice", summary }
		});
	}
	return makeNoticeFallback(text, summary);
}

/** 校验并归一化阈值配置；配置错误一律抛错（fail loud），绝不静默回退。 */
function resolveConfig(config) {
	const raw = config ?? {};
	const thresholds = Array.isArray(raw.thresholds) ? raw.thresholds : DEFAULTS.thresholds;
	if (thresholds.length === 0) throw new Error("dsh-todo-keeper: `thresholds` 不能为空");
	for (const value of thresholds) {
		if (!Number.isInteger(value) || value < 1) {
			throw new Error(`dsh-todo-keeper: 非法阈值 ${value} —— 每个阈值必须是不小于 1 的整数`);
		}
	}
	const repeatEvery = Number.isInteger(raw.repeatEvery) ? raw.repeatEvery : DEFAULTS.repeatEvery;
	if (repeatEvery < 1) throw new Error("dsh-todo-keeper: `repeatEvery` 必须是不小于 1 的整数");
	const batchWarnAt = Number.isInteger(raw.batchWarnAt) ? raw.batchWarnAt : DEFAULTS.batchWarnAt;
	if (batchWarnAt < 2) throw new Error("dsh-todo-keeper: `batchWarnAt` 必须是不小于 2 的整数");
	const includeTodoSnapshot =
		typeof raw.includeTodoSnapshot === "boolean" ? raw.includeTodoSnapshot : DEFAULTS.includeTodoSnapshot;
	return { thresholds: [...thresholds].sort((a, b) => a - b), repeatEvery, batchWarnAt, includeTodoSnapshot };
}

/**
 * 解析一次 todo_write 的参数，取出规范化清单。
 * `arguments` 可能是对象（loop 的 JSON.parse 结果）或原始字符串（解析失败时的回退），
 * 两种情况都要能处理；拿不到合法清单时返回 null。
 */
function parseTodos(argumentsValue) {
	let value = argumentsValue;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (value === null || typeof value !== "object") return null;
	const todos = value.todos;
	if (!Array.isArray(todos)) return null;
	const parsed = [];
	for (const item of todos) {
		if (item === null || typeof item !== "object") continue;
		if (typeof item.content !== "string") continue;
		parsed.push({
			content: item.content,
			status: typeof item.status === "string" ? item.status : "pending"
		});
	}
	return parsed;
}

/** 统计两次清单之间「状态发生变化」的条目数（新增条目不计数，避免误报建表动作）。 */
function countStatusChanges(previous, next) {
	if (previous === null || previous === undefined) return 0;
	const before = new Map();
	for (const item of previous) before.set(item.content, item.status);
	let changed = 0;
	for (const item of next) {
		const old = before.get(item.content);
		if (old !== undefined && old !== item.status) changed += 1;
	}
	return changed;
}

/** 把清单渲染成给模型看的紧凑清单。 */
function renderTodos(todos) {
	return todos
		.map((item) => {
			const mark = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
			return `- ${mark} ${item.content}`;
		})
		.join("\n");
}

/** 「清单陈旧」提醒正文。 */
function staleText(idle, todos, includeSnapshot) {
	const lines = [
		`任务清单更新提醒：你已经连续 ${idle} 次工具调用没有调用 \`todo_write\`。`,
		"",
		"对话里的「任务」面板只在 `todo_write` 被调用时才刷新，所以用户此刻看到的仍是旧状态。请立刻核对并修正：",
		"1. 已经做完的条目是否已标记 `completed`？当前正在做的条目是否标了 `in_progress`？",
		"2. 若清单与实际进度不一致，马上用 `todo_write` 重发**完整列表**（整表替换，必须包含全部条目，不能只发变化的那几项）。",
		"3. 之后保持「完成一项就立刻更新」的节奏，不要攒到最后一次性勾选。"
	];
	if (includeSnapshot && Array.isArray(todos) && todos.length > 0) {
		lines.push("", "你上次写入的清单：", renderTodos(todos));
	}
	return lines.join("\n");
}

/** 「批量勾选」提醒正文。 */
function batchText(changed) {
	return [
		`任务清单批量更新警告：本次 \`todo_write\` 一次性改动了 ${changed} 项的状态。`,
		"",
		"这说明你在攒着更新。请改成「完成一项就立刻标记一项」，否则用户在整个执行过程中看到的进度都是过期的。",
		"下一次请在每完成一个条目后立刻调用 `todo_write`。"
	].join("\n");
}

/**
 * 安装监听。
 * @param ctx - 插件上下文（`ctx.on` 提供事件总线）。
 * @param config - cordis.patch.yml 里该行的 config。
 */
export function apply(ctx, config) {
	const { thresholds, repeatEvery, batchWarnAt, includeTodoSnapshot } = resolveConfig(config);
	const thresholdSet = new Set(thresholds);
	const lastThreshold = thresholds[thresholds.length - 1];

	/** 每个 agent 独立记账（WeakMap 键为活的 agent 对象，对象销毁即自动回收）。 */
	const states = new WeakMap();

	function stateOf(agent) {
		let state = states.get(agent);
		if (state === undefined) {
			state = { idle: 0, todos: null };
			states.set(agent, state);
		}
		return state;
	}

	/**
	 * 观察一次已执行的工具调用，返回需要注入的提醒（没有则 undefined）。
	 * 计数放在 post-execute：被拒绝的调用也会流经这里，而模型反复撞墙正是需要提醒的时候。
	 */
	function observe(exec) {
		if (exec === null || exec === undefined) return undefined;
		if (exec.agent === null || exec.agent === undefined) return undefined;
		const state = stateOf(exec.agent);

		// 清单工具本身：更新缓存、清零计数，必要时给批量勾选警告。
		if (exec.name === TODO_TOOL) {
			const next = parseTodos(exec.arguments);
			const changed = next === null ? 0 : countStatusChanges(state.todos, next);
			if (next !== null) state.todos = next;
			state.idle = 0;
			if (changed >= batchWarnAt) {
				return makeNotice(batchText(changed), `批量更新 ${changed} 项`);
			}
			return undefined;
		}

		// agent 从没写过清单：不打扰（保持与「简单任务不用清单」的约定一致）。
		if (state.todos === null) return undefined;

		state.idle += 1;
		const hit = thresholdSet.has(state.idle);
		// 超过最后一个阈值后按 repeatEvery 周期性再提醒，避免「喊了三次就永远闭嘴」。
		const periodic = state.idle > lastThreshold && (state.idle - lastThreshold) % repeatEvery === 0;
		if (!hit && !periodic) return undefined;

		return makeNotice(
			staleText(state.idle, state.todos, includeTodoSnapshot),
			`清单已 ${state.idle} 次调用未更新`
		);
	}

	/** 把我们的提醒放在下游上下文数组的最前面。 */
	function prepend(ours, theirs) {
		return [ours, ...(theirs ?? [])];
	}

	ctx.on("tools/post-execute", async (exec, _result, next) => {
		const notice = observe(exec);
		const downstream = await next();
		if (notice === undefined) return downstream;
		if (downstream.kind === "block") {
			return {
				kind: "block",
				feedback: downstream.feedback,
				additionalContexts: prepend(notice, downstream.additionalContexts)
			};
		}
		return { ...downstream, additionalContexts: prepend(notice, downstream.additionalContexts) };
	});

	// 新的用户提示词 = 新的一轮：清掉计数与清单缓存，避免上一轮的清单影响本轮判断。
	// 注意：本插件注入的提醒 source.kind 是 'plugin'，不会误触发这里的重置。
	ctx.on("agent/pre-step", ({ agent, messages }, next) => {
		if (Array.isArray(messages) && messages.some((message) => message?.source?.kind === "user")) {
			states.delete(agent);
		}
		return next();
	});
}

/** 测试用：暴露内部纯函数，方便在无 DSH 环境下做单元验证。 */
export const __test = { parseTodos, countStatusChanges, staleText, batchText, resolveConfig };
