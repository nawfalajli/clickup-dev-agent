import { spawn } from 'node:child_process';

function kill(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGKILL');
}

/**
 * Run a command with optional stdin and timeout. Resolves with the exit code, never rejects on it.
 * `env` overrides process.env for the child; an undefined value removes the key.
 */
export function run(cmd, args, { cwd, input, timeoutMs, shell = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    const child = spawn(cmd, args, { cwd, shell, env: childEnv, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill(child); }, timeoutMs) : null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.end(input);
  });
}
