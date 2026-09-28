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

const comments = (log) => log.filter((l) => l[0] === 'comment').map((l) => l[2]);
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
