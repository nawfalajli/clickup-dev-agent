import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleTask } from '../src/worker.js';
import { State } from '../src/state.js';
import { loadConfig } from '../src/config.js';

const detailed = {
  id: 't1', name: 'Add export button', url: 'https://app.clickup.com/t/t1',
  description: 'Add an Excel export button on the contracts list, same as the payroll list.',
};

function setup({ decision, dev = { ok: true, text: 'Added button + test. 12 tests pass.' }, changes = true, tests = { ok: true, tail: '' }, test: testCmd = 'npm test' } = {}) {
  const cfg = loadConfig({
    CLICKUP_API_TOKEN: 'pk', CLICKUP_TEAM_ID: '1', REPOS: `front|/f|${testCmd};back|/b|`,
    IN_PROGRESS_STATUS: 'in progress', MAX_ATTEMPTS: '2',
    STATE_FILE: path.join(mkdtempSync(path.join(tmpdir(), 'cu-')), 'state.json'),
  });
  const log = [];
  const cu = {
    comment: async (id, text) => log.push(['comment', id, text]),
    setStatus: async (id, s) => log.push(['status', id, s]),
  };
  const claudeCalls = [];
  const deps = {
    runClaude: async (opts, cwd, prompt) => {
      claudeCalls.push({ opts, cwd, prompt });
      return prompt.startsWith("You triage")
        ? { ok: true, text: JSON.stringify(decision ?? { action: 'develop', repo: 'front', reason: 'ui', plan: ['p'] }) }
        : dev;
    },
    runTests: async () => tests,
    git: {
      startBranch: async (cwd, g, b) => log.push(['git.start', cwd, b]),
      hasChanges: async () => changes,
      commitAndOpenMr: async () => ({ sha: 'abc123', mrUrl: 'https://gitlab.com/x/-/merge_requests/7' }),
      cleanup: async (cwd, g, b) => log.push(['git.cleanup', cwd, b]),
    },
  };
  const ctx = { cfg, cu, state: new State(cfg.stateFile), deps, log: () => {} };
  return { ctx, log, claudeCalls };
}

const allComments = (log) => log.filter((l) => l[0] === 'comment').map((l) => l[2]);
const comments = (log) => allComments(log).filter((c) => !c.includes('Decision: develop'));
const statuses = (log) => log.filter((l) => l[0] === 'status').map((l) => l[2]);

test('no details: comment + done, Claude never called', async () => {
  const { ctx, log, claudeCalls } = setup();
  assert.equal(await handleTask({ id: 't0', name: 'fix', url: 'u', description: '' }, ctx), 'no-details');
  assert.equal(claudeCalls.length, 0);
  assert.match(comments(log)[0], /no description/);
  assert.deepEqual(statuses(log), ['done']);
  assert.equal(await handleTask({ id: 't0', name: 'fix', url: 'u', description: '' }, ctx), null, 'not processed twice');
});

test('happy path: decide (read-only) -> develop -> tests -> MR -> comment + done', async () => {
  const { ctx, log, claudeCalls } = setup();
  assert.equal(await handleTask(detailed, ctx), 'done');
  assert.deepEqual(claudeCalls[0].opts.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(claudeCalls[0].opts.addDirs, [path.resolve('/b')]);
  assert.ok(!claudeCalls[1].opts.tools.includes('Bash'), 'developer has no unrestricted Bash');
  assert.match(claudeCalls[1].prompt, /1\. p/);
  assert.deepEqual(statuses(log), ['in progress', 'done']);
  assert.match(comments(log)[0], /merge_requests\/7[\s\S]*12 tests pass/);
  assert.deepEqual(log.find((l) => l[0] === 'git.start'), ['git.start', path.resolve('/f'), 'cu/t1-add-export-button']);
  assert.ok(log.some((l) => l[0] === 'git.cleanup'));
  assert.equal(await handleTask(detailed, ctx), null);
  assert.equal(await handleTask({ ...detailed, description: `${detailed.description} Also CSV.` }, ctx), 'done', 'edited task is redone');
});

test('decision needs_details: questions commented, status done, no git', async () => {
  const { ctx, log } = setup({ decision: { action: 'needs_details', repo: 'front', reason: 'vague', questions: ['Which list?'] } });
  assert.equal(await handleTask(detailed, ctx), 'needs-details');
  assert.match(comments(log)[0], /Which list\?/);
  assert.deepEqual(statuses(log), ['done']);
  assert.ok(!log.some((l) => l[0].startsWith('git')));
});

test('decision skip: comment only, status untouched', async () => {
  const { ctx, log } = setup({ decision: { action: 'skip', repo: 'front', reason: 'meeting' } });
  assert.equal(await handleTask(detailed, ctx), 'skipped');
  assert.deepEqual(statuses(log), []);
});

test('decision picks another repo than the tag default', async () => {
  const { ctx, log } = setup({ decision: { action: 'develop', repo: 'back', reason: 'api' } });
  assert.equal(await handleTask(detailed, ctx), 'done');
  assert.equal(log.find((l) => l[0] === 'git.start')[1], path.resolve('/b'));
});

test('agent BLOCKED / no changes: commented, not done', async () => {
  const blocked = setup({ dev: { ok: true, text: 'BLOCKED: which table?' } });
  assert.equal(await handleTask(detailed, blocked.ctx), 'blocked');
  assert.ok(!statuses(blocked.log).includes('done'));
  const none = setup({ changes: false });
  assert.equal(await handleTask(detailed, none.ctx), 'no-changes');
});

test('failing tests: retried up to MAX_ATTEMPTS, then a give-up comment; branch always cleaned', async () => {
  const { ctx, log } = setup({ tests: { ok: false, tail: '1 failing' } });
  assert.equal(await handleTask(detailed, ctx), 'error');
  assert.equal(comments(log).length, 0);
  assert.equal(await handleTask(detailed, ctx), 'error');
  assert.match(comments(log)[0], /Gave up after 2[\s\S]*1 failing/);
  assert.equal(log.filter((l) => l[0] === 'git.cleanup').length, 2);
  assert.ok(!statuses(log).includes('done'));
  assert.equal(await handleTask(detailed, ctx), null);
});

test('WhatsApp: done carries the MR link, give-up and blocked are notified too', async () => {
  const sent = [];
  const notify = async (event, text) => sent.push([event, text]);
  const ok = setup();
  await handleTask(detailed, { ...ok.ctx, notify });
  assert.equal(sent[0][0], 'done');
  assert.match(sent[0][1], /DONE[\s\S]*Add export button[\s\S]*merge_requests\/7[\s\S]*app\.clickup\.com\/t\/t1/);

  const bad = setup({ tests: { ok: false, tail: 'boom' } });
  await handleTask(detailed, { ...bad.ctx, notify });
  assert.equal(sent.length, 1, 'no notification before the last attempt');
  await handleTask(detailed, { ...bad.ctx, notify });
  assert.equal(sent[1][0], 'error');
  assert.match(sent[1][1], /Gave up after 2[\s\S]*boom/);

  const blocked = setup({ dev: { ok: true, text: 'BLOCKED: which table?' } });
  await handleTask(detailed, { ...blocked.ctx, notify });
  assert.deepEqual(sent[2][0], 'blocked');
  assert.match(sent[2][1], /which table\?/);
});

test('triage: reformulated spec is posted on ClickUp and handed to the developer', async () => {
  const spec = { title: 'Add Excel export to contracts list', goal: 'Users export the filtered list.', acceptance_criteria: ['Button in toolbar', 'Exports current filters'], out_of_scope: ['PDF'] };
  const { ctx, log, claudeCalls } = setup({ decision: { action: 'develop', repo: 'front', reason: 'ui', spec, plan: [] } });
  assert.equal(await handleTask(detailed, ctx), 'done');
  assert.match(allComments(log)[0], /Decision: develop in front[\s\S]*Add Excel export[\s\S]*- \[ \] Exports current filters[\s\S]*Out of scope/);
  assert.match(claudeCalls[0].prompt, /You triage/);
  assert.match(claudeCalls[1].prompt, /reformulated at triage[\s\S]*Button in toolbar[\s\S]*ORIGINAL TASK/);
});

test('Jev overrides triage, and a Jev outage keeps the triage decision', async () => {
  const over = setup();
  over.ctx.deps.judge = async () => ({ action: 'skip', confidence: 0.92, clarity: 0.3, repo: null, specFaithful: null });
  assert.equal(await handleTask(detailed, over.ctx), 'skipped');
  assert.equal(over.claudeCalls.length, 1, 'no developer run after a Jev skip');

  const down = setup();
  down.ctx.deps.judge = async () => { throw new Error('Jev -> 529'); };
  assert.equal(await handleTask(detailed, down.ctx), 'done');

  const unsure = setup();
  unsure.ctx.deps.judge = async () => ({ action: 'develop', confidence: 0.4, clarity: 1, repo: null, specFaithful: null });
  assert.equal(await handleTask(detailed, unsure.ctx), 'needs-details');
  assert.match(comments(unsure.log)[0], /not confident enough/);
});
