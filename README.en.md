# dsh-todo-keeper

简体中文 | [English](README.en.md)

A host-side plugin for DeepSeek Harness that keeps the agent's task list honest: it injects a reminder when the model goes many tool calls without updating `todo_write`, and warns when it batch-checks items at the very end. Pure plugin, no core changes.

## The problem it solves

The web "Tasks" panel renders the **last `todo_write` event**:

- the projection registered by `@deepseek-ai/dsh-tool-todo` is last-write-wins;
- the frontend (`dsh-client-ui-conversation`) reads it via `useProjection("todos")`;
- `dsh-host-apiproxy` pushes a `session/projection` frame the moment it changes.

So **one more `todo_write` call refreshes the panel in milliseconds**. The catch: the harness never emits that call for the model. When the model writes the list once at the start, works head-down for two minutes, and writes again at the end, the panel is stuck on the first snapshot the whole time — "item one spins forever, then everything gets checked at once".

This plugin is an **advisory loop-breaker**, same family as the official `@deepseek-ai/dsh-repeat-tool-reminder`:

- it never vetoes a tool call and never rewrites a tool result;
- it counts "tool calls since the last `todo_write`";
- once the agent has adopted a list (at least one `todo_write`), it injects a reminder through the `post-execute` decision's `additionalContexts` when a threshold is hit — visible in the conversation as a synthetic user message tagged with a `dsh-todo-keeper` source, auditable by the model.

## Behavior

| Situation | Behavior |
|---|---|
| Agent never wrote a list | Left alone |
| 9 consecutive tool calls without a list update | Injects a "stale list" reminder, including the snapshot of the last written list |
| Past the last threshold | Reminds again every 10 calls (so it does not go silent after three) |
| One `todo_write` changes ≥4 item statuses | Injects a "batch check-off" warning |
| A new user prompt | Counters and list cache reset; counting restarts after the model rewrites the list |
| The plugin's own injected reminders | Never trigger the reset |

## Install

```bash
dsh plugin --profile web add -w dsh-todo-keeper
```

Host plugins load at DSH startup — **fully quit and restart DeepSeek Harness after install**.

## Configuration (optional)

Add a `config` block under the plugin's row in `cordis.patch.yml`:

```yaml
- insert:
    - id: todo-keeper
      name: 'dsh-todo-keeper'
      config:
        thresholds: [9]             # consecutive-call triggers; ascending positive integers
        repeatEvery: 10             # periodic reminder interval past the last threshold
        batchWarnAt: 4              # how many status changes in one write count as "batch"
        includeTodoSnapshot: true   # attach the last written list to the reminder
```

Configuration errors **throw loudly** (fail loud) — they never silently fall back to defaults.

## Uninstall

Remove the `todo-keeper` insert row from `cordis.patch.yml` plus the package directory, then restart.

## Tests

Unit tests run without starting DSH:

```bash
node test/run.mjs    # any Node >= 20
```

Coverage: no-list silence, threshold triggers, reset on list update, batch check-off warning, reset on new user prompt, plugin messages not triggering the reset, argument parsing and config validation.

## Implementation notes

- Dependency strategy: no static package dependencies. Messages are built with the official `createUserMessage` when resolvable, otherwise with a hand-built equivalent object (same shape as the official one: id / role / content / source).
- Counting happens at `tools/post-execute`: rejected calls also flow through here, and a model repeatedly hitting walls is exactly when a reminder is due.
- Per-agent bookkeeping via WeakMap keyed on the live agent object — entries are collected automatically.
- Injected messages carry the producer-owned `source.kind: "dsh-todo-keeper"` (the `plugin` field is kept alongside), so the UI never renders them as human user messages. The official desktop 0.2.0 moved sessions to format v4, whose admission check hard-rejects the retired `kind: "plugin"` shape.

## Compatibility

- DeepSeek Harness `0.1.5-rc.1` (web profile, host side)
- Official desktop `0.2.0-rc.2` (desktop profile, host side; session format v4, injected sources use a producer-owned kind)
- Host-only plugin, no browser half

## License

MIT
