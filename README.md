# agent-race

English | [简体中文](README.zh-CN.md)

Give the same task to Claude Code and Codex, let them work in parallel, each in its own git worktree, and get a Markdown report of what each one did.

I built it to stop arguing from impressions. "Codex doesn't get what I mean", "Claude changes too much": run the same task through both and look at the diffs.

```bash
node src/race.ts --repo ~/code/app --task "Add a --json flag to the CLI" --test "npm test"
```

The report starts with a summary, then each agent's final message and full diff:

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

## Requirements

- Node 22.18+ (it runs the TypeScript directly, no build step or dependencies)
- The `claude` and `codex` CLIs, logged in
- A git repository to run the task in

## Options

| Option | |
|---|---|
| `--repo <path>` | the repository to work in (required) |
| `--task "<text>"` | the task, given to every agent as is (required) |
| `--test "<cmd>"` | run in each worktree afterwards; the report shows pass / fail |
| `--agents claude,codex` | which agents to race (default: both) |
| `--claude-model M`, `--codex-model M` | override the model |
| `--setup "<cmd>"` | run in each worktree before the agents start, e.g. `ln -s ~/code/app/node_modules node_modules` |
| `--no-proxy codex` | drop `HTTP(S)_PROXY` for these agents, if their API isn't reachable through your proxy |
| `--base HEAD` | the commit every worktree starts from |
| `--timeout 20` | minutes per agent |

## How it works

- Each agent gets a fresh `git worktree` from the same base commit, under `~/.agent-race/<repo>/<run>/<agent>`. Your working copy is never touched.
- Both run headless with permission prompts disabled (`claude -p --dangerously-skip-permissions`, `codex exec --dangerously-bypass-approvals-and-sandbox`), so they can finish without you. They only work inside their worktree, but they can run any command there: use it on code you trust.
- Afterwards the diff is taken against the base commit, new files included; caches such as `__pycache__` are left out.
- The report, plus each agent's raw stdout and stderr, are saved next to the worktrees. Remove a run's worktrees with `git worktree remove` when you're done.

## License

MIT
