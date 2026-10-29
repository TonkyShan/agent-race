# agent-race

[English](README.md) | 简体中文

把同一个任务同时交给 Claude Code 和 Codex，各自在独立的 git worktree 里并行干活，最后生成一份 Markdown 报告，对比它们各自做了什么。

做它是为了不再凭印象争论。「Codex 听不懂我的意思」「Claude 改得太多」，让两个 Agent 做同一个任务，看 diff 就知道了。

```bash
node src/race.ts --repo ~/code/app --task "给命令行加一个 --json 参数" --test "npm test"
```

报告开头是汇总表，后面是每个 Agent 的最终回复和完整 diff：

|  | claude | codex |
| --- | --- | --- |
| Time | 19s | 56s |
| Exit | 0 | 0 |
| Files changed | 1 | 1 |
| Lines +/− | +4 / −0 | +4 / −0 |
| New files | 0 | 0 |
| Test | pass | pass |
| model | claude-opus-5-5 | gpt-6-astra |
| turns | 4 | 1 |
| output tokens | 435 | 450 |
| cost (USD) | 0.12 | – |

## 依赖

- Node 22.18 以上（直接运行 TypeScript，不用构建，也没有依赖包）
- 已登录的 `claude` 和 `codex` 命令行
- 一个要在里面做任务的 git 仓库

## 参数

| 参数 | |
|---|---|
| `--repo <路径>` | 在哪个仓库里做任务（必填） |
| `--task "<描述>"` | 任务描述，原样交给每个 Agent（必填） |
| `--test "<命令>"` | 做完后在每个 worktree 里执行，报告里显示通过 / 失败 |
| `--agents claude,codex` | 让哪些 Agent 参赛（默认两个都上） |
| `--claude-model M`、`--codex-model M` | 指定模型 |
| `--setup "<命令>"` | Agent 开始前在每个 worktree 里先执行，比如 `ln -s ~/code/app/node_modules node_modules` |
| `--no-proxy codex` | 运行这些 Agent 时去掉 `HTTP(S)_PROXY`，适用于它们的 API 不能走你的代理的情况 |
| `--base HEAD` | 所有 worktree 的起点提交 |
| `--timeout 20` | 每个 Agent 的超时时间（分钟） |

## 原理

- 每个 Agent 从同一个提交新建一个 `git worktree`，放在 `~/.agent-race/<仓库>/<本次运行>/<agent>` 下面，不会动你的工作目录。
- 两边都用无头模式运行，并关闭权限确认（`claude -p --dangerously-skip-permissions`、`codex exec --dangerously-bypass-approvals-and-sandbox`），这样它们不用等你就能做完。它们只在自己的 worktree 里干活，但在里面可以执行任意命令，所以只在你信任的代码上用。
- 做完后，以起点提交为基准算 diff，新建的文件也算在内；`__pycache__` 这类缓存会被排除。
- 报告和每个 Agent 的原始输出都保存在 worktree 旁边。用完后可以用 `git worktree remove` 清理。

## 许可证

MIT
