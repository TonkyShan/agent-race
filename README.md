# agent-race

Give the same task to several coding agents, each in its own git worktree, run them in parallel, and get a Markdown report of what each one did: time, files and lines changed, new files, whether your test passes, the model, turns and tokens, the final message and the full diff.

```bash
node src/race.ts --repo ~/code/app --task "Add a --json flag to the CLI" --test "npm test"
```

Options: `--agents claude,codex` (default), `--claude-model M`, `--codex-model M`, `--setup "<cmd>"` (run in each worktree first, e.g. linking `node_modules`), `--base HEAD`, `--timeout 20` (minutes).

Needs Node 22.18+ (runs the TypeScript directly) and the `claude` and `codex` CLIs. Worktrees and reports go to `~/.agent-race/<repo>/<run>/`; both agents run with permission prompts disabled, inside their worktree.
