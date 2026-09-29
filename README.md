# dsh-todo-keeper

[English](README.en.md) | 简体中文

让 DeepSeek Harness 的 agent **别把任务清单攒到最后才更新**的宿主侧插件。纯插件实现，不改核心、不动官方任何文件。

## 它解决什么问题

网页端的「任务」面板渲染的是**最后一次 `todo_write` 事件**：

- `@deepseek-ai/dsh-tool-todo` 注册的投影是 last-write-wins；
- 前端 `dsh-client-ui-conversation` 通过 `useProjection("todos")` 读它；
- `dsh-host-apiproxy` 在投影变化时立即推送 `session/projection` 帧。

也就是说，**只要模型再调用一次 `todo_write`，面板会在毫秒级刷新**。问题在于 harness 不会替模型补发这次调用：模型「开工写一次清单 → 埋头干两分钟 → 收工再写一次」，面板就全程停在第一份快照上，表现为「第一项一直转圈，最后唰一下全打勾」。

本插件是**建议型 loop-breaker**，与官方 `@deepseek-ai/dsh-repeat-tool-reminder` 同族：

- 不否决任何工具调用，不重写任何工具结果；
- 统计「自上次 `todo_write` 以来连续多少次工具调用」；
- agent 一旦启用过清单，就在达到阈值时通过 `post-execute` 决策的 `additionalContexts` 注入一条提醒（在会话里表现为一条带 `dsh-todo-keeper` 来源标记的合成 user 消息，模型可见、可审计）。

## 行为

| 情况 | 行为 |
|---|---|
| agent 从未写过清单 | 不打扰 |
| 连续 9 次工具调用未更新清单 | 注入「清单已陈旧」提醒，并附上上次写入的清单快照 |
| 超过最后一个阈值 | 每 10 次调用再提醒一次（避免喊三次后永远闭嘴） |
| 一次 `todo_write` 改了 ≥4 项状态 | 注入「批量勾选」警告 |
| 新一轮用户提示词 | 计数与清单缓存清零；模型重写清单后重新开始计数 |
| 插件自己注入的提醒 | 不会误触发清零 |

## 安装

```bash
dsh plugin --profile web add -w dsh-todo-keeper
```

宿主插件在 DSH 启动时加载，**装完必须完全退出并重启 DeepSeek Harness**。

## 配置（可选）

在 `cordis.patch.yml` 的对应行下加 `config`：

```yaml
- insert:
    - id: todo-keeper
      name: 'dsh-todo-keeper'
      config:
        thresholds: [9]             # 触发提醒的连跑次数；必须是升序的正整数
        repeatEvery: 10             # 超过最后一个阈值后的周期性提醒间隔
        batchWarnAt: 4              # 一次改多少项状态算「批量勾选」
        includeTodoSnapshot: true   # 提醒里是否附上上次的清单快照
```

配置错误会**直接抛错**（fail loud），不会静默回退到默认值。

## 卸载

删 `cordis.patch.yml` 里的 `todo-keeper` 插入行 + 删包目录，重启即可。

## 测试

不启动 DSH 也能跑单元测试：

```bash
node test/run.mjs    # 任意 Node >= 20
```

覆盖：无清单不打扰、阈值触发、清单更新清零、批量勾选警告、用户提示词重置、插件消息不误重置、参数解析与配置校验。

## 实现要点

- 依赖策略：不静态依赖任何包。消息优先用官方 `createUserMessage` 构造；解析不到时回退到手搓的等价消息对象（与官方形状一致：id / role / content / source）。
- 计数放在 `tools/post-execute`：被拒绝的调用也会流经这里，而模型反复撞墙正是需要提醒的时候。
- 每个 agent 独立记账（WeakMap 键为活的 agent 对象，对象销毁即自动回收）。
- 注入消息的 `source.kind` 是 producer-owned 的 `"dsh-todo-keeper"`（`plugin` 字段一并保留），UI 不会把它当成人写的用户消息。官方桌面 0.2.0 起会话格式为 v4，准入校验硬拒绝 `kind: "plugin"` 这一退役形状，故不能用旧写法。

## 兼容性

- DeepSeek Harness `0.1.5-rc.1`（web profile，宿主侧）
- 官方桌面端 `0.2.0-rc.2`（desktop profile，宿主侧；会话格式 v4，注入 source 为 producer-owned kind）
- 纯宿主插件，无浏览器半包

## License

MIT
