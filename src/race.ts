// agent-race: give the same task to several coding agents, each in its own git worktree,
// run them in parallel, and write a Markdown report comparing what they did.
//
//   node src/race.ts --repo ~/code/app --task "Add a --json flag to the CLI" [--test "npm test"]
//                    [--agents claude,codex] [--base HEAD] [--timeout 20] [--claude-model M] [--codex-model M] [--setup "<cmd>"]

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

type Result = {
  agent: string;
  dir: string;
  seconds: number;
  exitCode: number | null;
  timedOut: boolean;
  message: string; // the agent's final answer
  stats: Record<string, string | number>; // tokens, turns, cost... whatever the agent reports
  diff: { files: number; added: number; removed: number; newFiles: string[]; patch: string };
  test?: { passed: boolean; output: string };
};

type Agent = {
  command: (task: string, dir: string, model?: string) => string[];
  env?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  parse: (stdout: string) => { message: string; stats: Record<string, string | number> };
};

const withoutProxy = (env: NodeJS.ProcessEnv) => {
  const copy = { ...env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete copy[k];
  return copy;
};

// the model codex will use: -m if given, else `model` in ~/.codex/config.toml
let codexModelOverride: string | undefined;
function codexModel() {
  if (codexModelOverride) return codexModelOverride;
  try {
    const cfg = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
    return cfg.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}

const AGENTS: Record<string, Agent> = {
  claude: {
    command: (task, _dir, model) => ['claude', '-p', task, '--output-format', 'json', '--dangerously-skip-permissions', ...(model ? ['--model', model] : [])],
    parse: (out) => {
      const r = JSON.parse(out.trim().split('\n').pop() || '{}');
      return {
        message: r.result ?? '',
        stats: {
          model: Object.keys(r.modelUsage ?? {}).join(', ') || undefined,
          turns: r.num_turns,
          'output tokens': r.usage?.output_tokens,
          'cost (USD)': r.total_cost_usd?.toFixed?.(2),
        },
      };
    },
  },
  codex: {
    command: (task, dir, model) => ['codex', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-C', dir, ...(model ? ['-m', model] : []), task],
    // codex talks to an internal endpoint that must not go through the proxy
    env: withoutProxy,
    parse: (out) => {
      let message = '';
      let usage: Record<string, number> = {};
      let turns = 0;
      for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        const e = JSON.parse(line);
        if (e.type === 'item.completed' && e.item?.type === 'agent_message') message = e.item.text ?? message;
        if (e.type === 'turn.completed') {
          turns++;
          usage = e.usage ?? usage;
        }
      }
      return { message, stats: { model: codexModel(), turns, 'output tokens': usage.output_tokens } };
    },
  },
};

function args() {
  const a = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : fallback;
  };
  const repo = get('--repo');
  const task = get('--task');
  if (!repo || !task) {
    console.error('usage: node src/race.ts --repo <path> --task "<task>" [--test "<cmd>"] [--agents claude,codex] [--base HEAD] [--timeout 20] [--claude-model M] [--codex-model M] [--setup "<cmd>"]');
    process.exit(2);
  }
  return {
    repo: resolve(repo.replace(/^~/, homedir())),
    task,
    test: get('--test'),
    setup: get('--setup'), // run in each worktree before the agents start, e.g. linking node_modules
    agents: (get('--agents', 'claude,codex') as string).split(','),
    base: get('--base', 'HEAD') as string,
    models: { claude: get('--claude-model'), codex: get('--codex-model') } as Record<string, string | undefined>,
    timeoutMin: Number(get('--timeout', '20')),
  };
}

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });

function run(cmd: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((done) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGTERM');
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
  });
}

function diffOf(dir: string, base: string) {
  git(dir, 'add', '-A'); // stage new files too, so they show up in the diff
  // caches left behind when an agent runs the code to check its work aren't part of the answer
  const pathspec = ['--', '.', ':(exclude,glob)**/__pycache__/**', ':(exclude,glob)**/*.pyc', ':(exclude,glob)**/.DS_Store'];
  const numstat = git(dir, 'diff', '--cached', '--numstat', base, ...pathspec).trim();
  let added = 0;
  let removed = 0;
  const lines = numstat ? numstat.split('\n') : [];
  for (const l of lines) {
    const [a, r] = l.split('\t');
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  const newFiles = git(dir, 'diff', '--cached', '--name-status', base, ...pathspec)
    .split('\n')
    .filter((l) => l.startsWith('A\t'))
    .map((l) => l.slice(2));
  return { files: lines.length, added, removed, newFiles, patch: git(dir, 'diff', '--cached', base, ...pathspec) };
}

async function race() {
  const opt = args();
  codexModelOverride = opt.models.codex;
  const base = git(opt.repo, 'rev-parse', opt.base).trim();
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(homedir(), '.agent-race', basename(opt.repo), runId);
  mkdirSync(runDir, { recursive: true });
  console.log(`run: ${runDir}`);

  const results = await Promise.all(
    opt.agents.map(async (name): Promise<Result> => {
      const agent = AGENTS[name];
      if (!agent) throw new Error(`unknown agent: ${name}`);
      const dir = join(runDir, name);
      git(opt.repo, 'worktree', 'add', '--detach', dir, base);
      if (opt.setup) await run(['sh', '-c', opt.setup], dir, process.env, 5 * 60_000);
      const start = Date.now();
      const r = await run(agent.command(opt.task, dir, opt.models[name]), dir, agent.env ? agent.env(process.env) : process.env, opt.timeoutMin * 60_000);
      const seconds = Math.round((Date.now() - start) / 1000);
      writeFileSync(join(runDir, `${name}.stdout.log`), r.stdout);
      writeFileSync(join(runDir, `${name}.stderr.log`), r.stderr);
      let parsed = { message: '', stats: {} as Record<string, string | number> };
      try {
        parsed = agent.parse(r.stdout);
      } catch {
        parsed.message = r.stdout.slice(-2000);
      }
      console.log(`${name}: done in ${seconds}s (exit ${r.code}${r.timedOut ? ', timed out' : ''})`);
      const result: Result = {
        agent: name, dir, seconds, exitCode: r.code, timedOut: r.timedOut,
        message: parsed.message, stats: parsed.stats, diff: diffOf(dir, base),
      };
      if (opt.test) {
        const t = await run(['sh', '-c', opt.test], dir, process.env, 10 * 60_000);
        result.test = { passed: t.code === 0, output: (t.stdout + t.stderr).slice(-3000) };
      }
      return result;
    }),
  );

  const report = render(opt, base, results);
  writeFileSync(join(runDir, 'report.md'), report);
  console.log(`report: ${join(runDir, 'report.md')}`);
}

function render(opt: ReturnType<typeof args>, base: string, results: Result[]) {
  const statKeys = [...new Set(results.flatMap((r) => Object.keys(r.stats)))];
  const row = (cells: (string | number | undefined)[]) => `| ${cells.map((c) => c ?? '–').join(' | ')} |`;
  const out = [
    `# agent-race: ${basename(opt.repo)}`,
    '',
    `**Task:** ${opt.task}`,
    '',
    `Base: \`${base.slice(0, 8)}\`${opt.test ? ` · Test: \`${opt.test}\`` : ''}`,
    '',
    row(['', ...results.map((r) => r.agent)]),
    row(['---', ...results.map(() => '---')]),
    row(['Time', ...results.map((r) => `${r.seconds}s${r.timedOut ? ' (timeout)' : ''}`)]),
    row(['Exit', ...results.map((r) => r.exitCode)]),
    row(['Files changed', ...results.map((r) => r.diff.files)]),
    row(['Lines +/−', ...results.map((r) => `+${r.diff.added} / −${r.diff.removed}`)]),
    row(['New files', ...results.map((r) => r.diff.newFiles.length)]),
    ...(opt.test ? [row(['Test', ...results.map((r) => (r.test?.passed ? 'pass' : 'FAIL'))])] : []),
    ...statKeys.map((k) => row([k, ...results.map((r) => r.stats[k])])),
    '',
  ];
  for (const r of results) {
    out.push(`## ${r.agent}`, '', `Worktree: \`${r.dir}\``, '');
    if (r.diff.newFiles.length) out.push(`New files: ${r.diff.newFiles.map((f) => `\`${f}\``).join(', ')}`, '');
    out.push('**Final message**', '', '> ' + (r.message || '(none)').trim().split('\n').join('\n> '), '');
    if (r.test && !r.test.passed) out.push('**Test output**', '', '```', r.test.output.trim(), '```', '');
    out.push('<details><summary>Diff</summary>', '', '```diff', r.diff.patch.trim() || '(no changes)', '```', '', '</details>', '');
  }
  return out.join('\n');
}

race().catch((e) => {
  console.error(e);
  process.exit(1);
});
