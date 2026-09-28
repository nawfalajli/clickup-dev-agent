import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasDetails, taskFingerprint, pickRepo, branchName, commitMessage, parseDecision, buildDevelopPrompt,
} from '../src/task.js';
import { parseRepos, loadConfig } from '../src/config.js';

const repos = [{ name: 'front', path: '/f', test: '' }, { name: 'back', path: '/b', test: 'npm test' }];

test('hasDetails: empty/short description is not enough, checklist items are', () => {
  assert.equal(hasDetails({ name: 'x', description: '' }, 20), false);
  assert.equal(hasDetails({ name: 'x', text_content: '  short  ' }, 20), false);
  assert.equal(hasDetails({ name: 'x', markdown_description: 'Add a Cancel button to the contract form' }, 20), true);
  assert.equal(hasDetails({ name: 'x', checklists: [{ name: 'c', items: [{ name: 'do it' }] }] }, 20), true);
});

test('taskFingerprint changes only when name/description change', () => {
  const a = { name: 'T', description: 'd' };
  assert.equal(taskFingerprint(a), taskFingerprint({ ...a, status: { status: 'x' } }));
  assert.notEqual(taskFingerprint(a), taskFingerprint({ ...a, description: 'd2' }));
});

test('pickRepo routes by tag, falls back to default', () => {
  assert.equal(pickRepo({ tags: [{ name: 'BACK' }] }, repos, 'front').name, 'back');
  assert.equal(pickRepo({ tags: [{ name: 'urgent' }] }, repos, 'front').name, 'front');
});

test('branchName and commitMessage', () => {
  const task = { id: '86abc', name: 'Ajouter le filtre Société (liste) !', url: 'https://app.clickup.com/t/86abc' };
  assert.equal(branchName(task, 'cu/'), 'cu/86abc-ajouter-le-filtre-societe-liste');
  assert.equal(branchName({ ...task, custom_id: 'BEE-12' }, 'cu/'), 'cu/BEE-12-ajouter-le-filtre-societe-liste');
  assert.match(commitMessage(task), /^\[CU-86abc\] Ajouter le filtre/);
});

test('parseDecision: valid JSON, unknown repo fallback, garbage -> needs_details', () => {
  const d = parseDecision('Sure:\n{"action":"develop","repo":"back","reason":"api change","plan":["a","b"]}', repos, repos[0]);
  assert.equal(d.action, 'develop');
  assert.equal(d.repo.name, 'back');
  assert.deepEqual(d.plan, ['a', 'b']);
  assert.equal(parseDecision('{"action":"skip","repo":"nope"}', repos, repos[0]).repo.name, 'front');
  assert.equal(parseDecision('{"action":"deploy"}', repos, repos[0]).action, 'needs_details');
  assert.equal(parseDecision('no json here', repos, repos[0]).action, 'needs_details');
});

test('buildDevelopPrompt includes the plan and forbids committing', () => {
  const p = buildDevelopPrompt({ name: 'T', url: 'u', description: 'desc' }, repos[0], ['step one']);
  assert.match(p, /1\. step one/);
  assert.match(p, /Do not commit, push/);
});

test('config: REPOS parsing and required keys', () => {
  const [r] = parseRepos('api|/tmp/api|npm test -- --run');
  assert.equal(r.name, 'api');
  assert.equal(r.test, 'npm test -- --run');
  assert.throws(() => parseRepos('broken'), /Invalid REPOS entry/);
  assert.throws(() => loadConfig({}), /CLICKUP_API_TOKEN, CLICKUP_TEAM_ID, REPOS/);
  const cfg = loadConfig({ CLICKUP_API_TOKEN: 'pk', CLICKUP_TEAM_ID: '1', REPOS: 'a|/a;b|/b', NO_DETAILS_STATUS: '' });
  assert.equal(cfg.defaultRepo, 'a');
  assert.equal(cfg.noDetailsStatus, '');
  assert.equal(cfg.git.targetBranch, 'dev');
  assert.ok(!cfg.claude.decisionTools.some((t) => /Edit|Write|Bash/.test(t)), 'decision step must be read-only');
});
