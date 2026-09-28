import {
  hasDetails, taskFingerprint, pickRepo, branchName, commitMessage, taskRef,
  buildDecisionPrompt, parseDecision, buildDevelopPrompt, formatSpec,
} from './task.js';
import { applyVerdict } from './jev.js';

const BOT = '🤖 [automation]';

const NO_DETAILS_COMMENT = `${BOT} This task has no description, so it could not be developed automatically.
Please add details (expected behaviour, screens/endpoints involved, acceptance criteria) and reopen it.`;

const ICONS = { done: '✅', error: '❌', blocked: '⚠️', 'no-changes': '⚠️' };

/** WhatsApp message for an outcome: short, with what the developer needs to act on. */
export function notifyText(outcome, task, detail = '') {
  const head = `${ICONS[outcome] ?? 'ℹ️'} ClickUp Dev Agent: ${outcome.toUpperCase()}\n[CU-${taskRef(task)}] ${task.name}`;
  return [head, detail.trim().slice(0, 600), task.url].filter(Boolean).join('\n\n');
}

/**
 * Handle one ClickUp task end to end. `deps` = { git, runClaude, runTests } (injected for tests),
 * `notify(event, text)` = WhatsApp notifier. Returns the outcome, or null when already handled.
 */
export async function handleTask(task, { cfg, cu, state, deps, log, notify = async () => {} }) {
  const fingerprint = taskFingerprint(task);
  const prev = state.get(task.id);
  const sameTask = prev?.fingerprint === fingerprint;
  if (sameTask && (prev.final || (prev.attempts ?? 0) >= cfg.maxAttempts)) return null;
  const attempts = sameTask ? prev.attempts ?? 0 : 0;
  const finish = async (outcome, extra = {}, detail = extra.reason ?? '') => {
    state.set(task.id, { fingerprint, outcome, final: true, attempts, name: task.name, ...extra });
    log(`${taskRef(task)} -> ${outcome}`);
    await notify(outcome, notifyText(outcome, task, detail));
    return outcome;
  };

  try {
    // 1. Empty task: comment and close without spending a Claude run.
    if (!hasDetails(task, cfg.minDescriptionLength)) {
      await cu.comment(task.id, NO_DETAILS_COMMENT);
      if (cfg.noDetailsStatus) await cu.setStatus(task.id, cfg.noDetailsStatus);
      return finish('no-details');
    }

    // 2. Decision step (read-only): develop / needs_details / skip, and which repo.
    const suggested = pickRepo(task, cfg.repos, cfg.defaultRepo);
    log(`${taskRef(task)} deciding "${task.name}"`);
    const verdict = await deps.runClaude(
      {
        bin: cfg.claude.bin, model: cfg.claude.decisionModel, tools: cfg.claude.decisionTools,
        timeoutMs: cfg.claude.decisionTimeoutMs, addDirs: cfg.repos.filter((r) => r !== suggested).map((r) => r.path),
      },
      suggested.path,
      buildDecisionPrompt(task, cfg.repos, suggested),
    );
    if (!verdict.ok) throw new Error(`Decision step failed: ${verdict.text}`);
    let decision = parseDecision(verdict.text, cfg.repos, suggested);
    log(`${taskRef(task)} triage: ${decision.action} (${decision.repo.name}) ${decision.reason}`);

    // 2b. Final decision by Jev (TypeSafe) when configured; on a Jev outage the triage decision stands.
    if (deps.judge) {
      try {
        const jv = await deps.judge({ task, repos: cfg.repos, proposal: decision });
        decision = applyVerdict(decision, jv, cfg.repos, cfg.jev.minConfidence);
        log(`${taskRef(task)} ${decision.jev} -> ${decision.action} (${decision.repo.name})`);
      } catch (err) {
        log(`${taskRef(task)} Jev unavailable, keeping the triage decision: ${err.message}`);
      }
    }

    if (decision.action === 'needs_details') {
      const questions = decision.questions.map((q) => `- ${q}`).join('\n');
      await cu.comment(task.id, `${BOT} Not enough details to develop this task automatically.\n${decision.reason}${questions ? `\n\nQuestions:\n${questions}` : ''}`);
      if (cfg.noDetailsStatus) await cu.setStatus(task.id, cfg.noDetailsStatus);
      return finish('needs-details', { reason: decision.reason });
    }
    if (decision.action === 'skip') {
      await cu.comment(task.id, `${BOT} Skipped: not a code task for ${cfg.repos.map((r) => r.name).join(' / ')}.\n${decision.reason}`);
      return finish('skipped', { reason: decision.reason });
    }

    // 3. Post the decision + reformulated spec, then develop on a task branch, verify, open a merge request.
    await cu.comment(task.id, `${BOT} Decision: develop in ${decision.repo.name}${decision.jev ? ` (${decision.jev})` : ''}.${decision.spec ? `\n\n${formatSpec(decision.spec)}` : ''}`);
    return await develop(task, decision, { cfg, cu, deps, log, finish });
  } catch (err) {
    const tries = attempts + 1;
    state.set(task.id, { fingerprint, outcome: 'error', final: false, attempts: tries, name: task.name, error: err.message });
    log(`${taskRef(task)} failed (attempt ${tries}/${cfg.maxAttempts}): ${err.message}`);
    if (tries >= cfg.maxAttempts) {
      await cu.comment(task.id, `${BOT} Gave up after ${tries} attempt(s):\n${err.message.slice(0, 3000)}`).catch(() => {});
      await notify('error', notifyText('error', task, `Gave up after ${tries} attempt(s):\n${err.message}`));
    }
    return 'error';
  }
}

async function develop(task, decision, { cfg, cu, deps, log, finish }) {
  const repo = decision.repo;
  const branch = branchName(task, cfg.git.branchPrefix);
  if (cfg.inProgressStatus) await cu.setStatus(task.id, cfg.inProgressStatus);
  await deps.git.startBranch(repo.path, cfg.git, branch);

  try {
    log(`${taskRef(task)} developing in ${repo.name} on ${branch}`);
    const res = await deps.runClaude(
      { bin: cfg.claude.bin, model: cfg.claude.model, tools: cfg.claude.allowedTools, timeoutMs: cfg.claude.timeoutMs },
      repo.path,
      buildDevelopPrompt(task, repo, decision.plan, decision.spec),
    );
    if (!res.ok) throw new Error(`Developer agent failed: ${res.text}`);

    if (res.text.startsWith('BLOCKED:')) {
      await cu.comment(task.id, `${BOT} ${res.text}`);
      return finish('blocked', {}, res.text);
    }
    if (!(await deps.git.hasChanges(repo.path))) {
      await cu.comment(task.id, `${BOT} The agent made no code changes.\n\n${res.text}`);
      return finish('no-changes', {}, res.text);
    }
    if (repo.test) {
      log(`${taskRef(task)} running "${repo.test}"`);
      const tests = await deps.runTests(repo.test, repo.path, cfg.testTimeoutMs);
      if (!tests.ok) throw new Error(`Tests failed (${repo.test}):\n${tests.tail}`);
    }

    const { sha, mrUrl } = await deps.git.commitAndOpenMr(
      repo.path, cfg.git, branch, commitMessage(task), `[CU-${taskRef(task)}] ${task.name}`,
    );
    await cu.comment(task.id, `${BOT} Implemented on ${repo.name}, branch ${branch} (${sha}).
Merge request into ${cfg.git.targetBranch}: ${mrUrl || '(see GitLab)'}

${res.text}`);
    await cu.setStatus(task.id, cfg.doneStatus);
    return finish('done', { repo: repo.name, branch, sha, mrUrl, costUsd: res.costUsd },
      `Repo: ${repo.name} · ${branch} (${sha})\nMR: ${mrUrl || '(see GitLab)'}`);
  } finally {
    await deps.git.cleanup(repo.path, cfg.git, branch).catch((e) => log(`cleanup failed in ${repo.path}: ${e.message}`));
  }
}
