import { existsSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

// Keys handed to child processes (git, claude). An empty value would override
// the user's git identity / Claude login, so empty ones are removed instead.
const PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
];

// Decision step: read-only look at the task and the repos.
export const DECISION_TOOLS = 'Read,Glob,Grep';

// Developer step: edit files, search, run tests/typecheck.
// No arbitrary shell, no git write commands, no network tools.
export const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npm run typecheck:*)',
  'Bash(npx tsc:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
].join(',');

export function loadEnv(file = path.join(ROOT, '.env')) {
  if (existsSync(file)) process.loadEnvFile(file);
  for (const key of PASSTHROUGH) if (process.env[key] === '') delete process.env[key];
}

const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

export function parseRepos(raw) {
  return raw.split(';').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [name, repoPath, test = ''] = entry.split('|').map((s) => s.trim());
    if (!name || !repoPath) throw new Error(`Invalid REPOS entry "${entry}" (expected name|path|test command)`);
    return { name, path: path.resolve(repoPath), test };
  });
}

export function loadConfig(env = process.env) {
  const missing = ['CLICKUP_API_TOKEN', 'CLICKUP_TEAM_ID', 'REPOS'].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`);

  const repos = parseRepos(env.REPOS);
  const defaultRepo = env.DEFAULT_REPO || repos[0].name;
  if (!repos.some((r) => r.name === defaultRepo)) throw new Error(`DEFAULT_REPO "${defaultRepo}" is not in REPOS`);

  return {
    clickup: {
      token: env.CLICKUP_API_TOKEN.trim(),
      teamId: env.CLICKUP_TEAM_ID.trim(),
      userId: env.CLICKUP_USER_ID?.trim() || '',
      apiUrl: env.CLICKUP_API_URL || 'https://api.clickup.com/api/v2',
    },
    pickStatuses: list(env.PICK_STATUSES),
    inProgressStatus: env.IN_PROGRESS_STATUS?.trim() ?? '',
    doneStatus: env.DONE_STATUS?.trim() || 'done',
    noDetailsStatus: env.NO_DETAILS_STATUS?.trim() ?? 'done',
    minDescriptionLength: num(env.MIN_DESCRIPTION_LENGTH, 20),
    repos,
    defaultRepo,
    git: {
      remote: env.GIT_REMOTE || 'origin',
      targetBranch: env.GIT_TARGET_BRANCH || 'dev',
      branchPrefix: env.GIT_BRANCH_PREFIX || 'cu/',
    },
    claude: {
      bin: env.CLAUDE_BIN || 'claude',
      model: env.CLAUDE_MODEL || '',
      decisionModel: env.CLAUDE_DECISION_MODEL || env.CLAUDE_MODEL || '',
      allowedTools: list(env.CLAUDE_ALLOWED_TOOLS || DEFAULT_ALLOWED_TOOLS),
      decisionTools: list(DECISION_TOOLS),
      timeoutMs: num(env.CLAUDE_TIMEOUT_MINUTES, 45) * 60_000,
      decisionTimeoutMs: num(env.CLAUDE_DECISION_TIMEOUT_MINUTES, 10) * 60_000,
    },
    testTimeoutMs: num(env.TEST_TIMEOUT_MINUTES, 15) * 60_000,
    pollMs: num(env.POLL_INTERVAL_SECONDS, 300) * 1000,
    maxAttempts: num(env.MAX_ATTEMPTS, 2),
    stateFile: env.STATE_FILE || path.join(ROOT, 'state.json'),
  };
}
