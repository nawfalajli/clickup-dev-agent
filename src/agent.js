import { run } from './proc.js';

/**
 * Run Claude Code headless in `cwd`, prompt on stdin. `dontAsk` mode denies every tool
 * outside `tools`, so the agent can never go beyond its allowlist. `provider` + `env` (from
 * providers.js) point Claude Code at another Anthropic-compatible model provider.
 */
export async function runClaude({ bin, provider = 'anthropic', model, env = {}, tools, timeoutMs, addDirs = [] }, cwd, prompt) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', tools.join(',')];
  if (model) args.push('--model', model);
  for (const dir of addDirs) args.push('--add-dir', dir);
  const quoted = process.platform === 'win32' ? args.map((a) => (/[\s(),*:]/.test(a) ? `"${a}"` : a)) : args;
  const res = await run(bin, quoted, { cwd, input: prompt, timeoutMs, env, shell: process.platform === 'win32' });
  if (res.timedOut) return { ok: false, text: `Claude Code timed out after ${timeoutMs / 60_000} min` };

  let out;
  try {
    out = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    return { ok: false, text: `Claude Code exited ${res.code}: ${(res.stderr || res.stdout).slice(-2000)}` };
  }
  return {
    ok: !out.is_error && res.code === 0,
    text: String(out.result ?? '').trim(),
    // Claude Code prices every model at Anthropic rates: the cost is only meaningful for Anthropic.
    costUsd: provider === 'anthropic' ? out.total_cost_usd : undefined,
  };
}

/** The repo's own test command, run by the service as an independent check of the agent's work. */
export async function runTests(command, cwd, timeoutMs) {
  const res = await run(command, [], { cwd, timeoutMs, shell: true });
  const tail = `${res.stdout}\n${res.stderr}`.trim().slice(-3000);
  return { ok: res.code === 0 && !res.timedOut, tail: res.timedOut ? `timed out\n${tail}` : tail };
}
