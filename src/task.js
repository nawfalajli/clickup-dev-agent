import { createHash } from 'node:crypto';

export function taskDescription(task) {
  return (task.markdown_description || task.text_content || task.description || '').trim();
}

/** Cheap pre-filter before the decision step: an empty task never reaches Claude. */
export function hasDetails(task, minLength) {
  const checklistItems = (task.checklists ?? []).reduce((n, c) => n + (c.items?.length ?? 0), 0);
  return taskDescription(task).length >= minLength || checklistItems > 0;
}

/** Fingerprint of what the agent works from: a handled task is retried only when it changes. */
export function taskFingerprint(task) {
  return createHash('sha1').update(`${task.name}\n${taskDescription(task)}`).digest('hex').slice(0, 12);
}

/** Tag matching a repo name wins, else the default repo. */
export function pickRepo(task, repos, defaultRepo) {
  const tags = (task.tags ?? []).map((t) => t.name.toLowerCase());
  return repos.find((r) => tags.includes(r.name.toLowerCase())) ?? repos.find((r) => r.name === defaultRepo);
}

export function taskRef(task) {
  return task.custom_id || task.id;
}

export function branchName(task, prefix) {
  const slug = task.name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  return `${prefix}${taskRef(task)}${slug ? `-${slug}` : ''}`;
}

export function commitMessage(task) {
  return `[CU-${taskRef(task)}] ${task.name}\n\nClickUp: ${task.url}\nAutomated by clickup-dev-agent`;
}

function formatTask(task) {
  const checklists = (task.checklists ?? [])
    .map((c) => `${c.name}:\n${(c.items ?? []).map((i) => `- [${i.resolved ? 'x' : ' '}] ${i.name}`).join('\n')}`)
    .join('\n\n');
  return `Title: ${task.name}
URL: ${task.url}
List: ${task.list?.name ?? ''}
Tags: ${(task.tags ?? []).map((t) => t.name).join(', ') || '-'}
Priority: ${task.priority?.priority ?? '-'}

Description:
${taskDescription(task) || '(none)'}
${checklists ? `\nChecklists:\n${checklists}\n` : ''}`;
}

export const ACTIONS = ['develop', 'needs_details', 'skip'];

export function buildDecisionPrompt(task, repos, suggestedRepo) {
  return `You triage a ClickUp task before a developer agent works on it. Look at the task and, read-only, at the repositories to decide what to do. Do not modify anything.

Repositories:
${repos.map((r) => `- ${r.name}: ${r.path}`).join('\n')}
Suggested repository (from tags / default): ${suggestedRepo.name}

Decide:
- "develop": the task is a concrete code change that one of these repositories can implement and test.
- "needs_details": the task could be coded but is too vague or ambiguous; list the questions to ask.
- "skip": the task is not a code change for these repositories (meeting, design, ops, another project...).

Reply with ONLY a JSON object, no other text:
{"action": "develop" | "needs_details" | "skip", "repo": "<repository name>", "reason": "<one sentence>", "questions": ["..."], "plan": ["<implementation step>", "..."]}

--- TASK ---
${formatTask(task)}`;
}

/** Parse the decision JSON; anything unparseable becomes a safe "needs_details". */
export function parseDecision(text, repos, fallbackRepo) {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  let d;
  try {
    d = JSON.parse(json);
  } catch {
    return { action: 'needs_details', repo: fallbackRepo, reason: 'Decision step returned no valid JSON', questions: [], plan: [] };
  }
  return {
    action: ACTIONS.includes(d.action) ? d.action : 'needs_details',
    repo: repos.find((r) => r.name === d.repo) ?? fallbackRepo,
    reason: String(d.reason ?? ''),
    questions: Array.isArray(d.questions) ? d.questions.map(String) : [],
    plan: Array.isArray(d.plan) ? d.plan.map(String) : [],
  };
}

export function buildDevelopPrompt(task, repo, plan = []) {
  return `You are a developer handling a ClickUp task in the current repository ("${repo.name}").

1. Explore the codebase first (read CLAUDE.md / convention docs if present) and follow how similar features are built.
2. Implement the task.
3. Add or update automated tests that cover the change, using the project's existing test framework and conventions.
4. Run the tests (plus typecheck/lint when the project has them) and fix every failure you introduced.
5. Do not commit, push or switch branches: the automation service commits your changes and opens a merge request for human review.

If the task turns out too ambiguous to implement safely, make no changes and reply with a first line starting with "BLOCKED:" followed by the reason and the questions to ask.
Otherwise end with a short summary (what changed, tests added, test results). It is posted as a ClickUp comment.
${plan.length ? `\nTriage plan (a starting point, adjust after reading the code):\n${plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : ''}
--- TASK ---
${formatTask(task)}`;
}
