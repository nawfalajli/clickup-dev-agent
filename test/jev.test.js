import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jevJudge, applyVerdict } from '../src/jev.js';

const repos = [{ name: 'web-app' }, { name: 'api' }];
const jev = { apiKey: 'ts_key', apiUrl: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', minConfidence: 0.7 };
const task = { name: 'Paginate GET /orders', description: 'Return 20 orders per page.', tags: [{ name: 'backend' }] };
const spec = { title: 'Paginate orders', goal: 'Add page & limit.', acceptance: ['page=2 skips 20'], outOfScope: [] };
const proposal = { action: 'develop', repo: repos[0], reason: 'api change', spec, plan: [], questions: [] };

function stubFetch(t, responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const [status, body] = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(body), { status });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const answers = {
  model: 'jev-1.13.0',
  answers: {
    action: { type: 'choice', choice: 'develop', probabilities: { develop: 0.94, needs_details: 0.05, skip: 0.01 }, confidence: 0.9 },
    clarity: { type: 'score', score: 1.8, legend: {}, probabilities: {}, confidence: 0.85 },
    repo: { type: 'choice', choice: 'api', probabilities: { 'web-app': 0.03, api: 0.97 }, confidence: 0.95 },
    spec_faithful: { type: 'noul', noul: 0.93 },
  },
  usage: { input_tokens: 400, output_tokens: 30 },
};

test('jevJudge: documented request shape (state + typed questions) and parsed verdict', async (t) => {
  const calls = stubFetch(t, [[200, answers]]);
  const v = await jevJudge(jev, { task, repos, proposal });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ts_key');
  const { model, state, questions } = calls[0].body;
  assert.equal(model, 'jev-latest');
  assert.deepEqual(state.repositories, ['web-app', 'api']);
  assert.equal(state.triage_proposal.action, 'develop');
  assert.deepEqual(state.reformulated_spec, spec);
  assert.deepEqual(Object.keys(questions.action.criteria), ['develop', 'needs_details', 'skip']);
  assert.equal(questions.clarity.type, 'score');
  assert.deepEqual(Object.keys(questions.repo.criteria), ['web-app', 'api']);
  assert.equal(questions.spec_faithful.type, 'noul');
  assert.deepEqual(v, { model: 'jev-1.13.0', action: 'develop', confidence: 0.9, clarity: 1.8, repo: { name: 'api', confidence: 0.95 }, specFaithful: 0.93 });
});

test('jevJudge: retries 429/529, then surfaces errors', async (t) => {
  const calls = stubFetch(t, [[429, {}], [200, answers]]);
  assert.equal((await jevJudge(jev, { task, repos, proposal })).action, 'develop');
  assert.equal(calls.length, 2);
});

test('jevJudge: single repo and no spec -> no repo / spec_faithful questions', async (t) => {
  const calls = stubFetch(t, [[200, { model: 'jev', answers: { action: answers.answers.action, clarity: answers.answers.clarity } }]]);
  const v = await jevJudge(jev, { task, repos: [repos[0]], proposal: { ...proposal, spec: null } });
  assert.deepEqual(Object.keys(calls[0].body.questions), ['action', 'clarity']);
  assert.equal(v.repo, null);
  assert.equal(v.specFaithful, null);
});

test('applyVerdict: confident Jev has the final word (action + repo)', () => {
  const d = applyVerdict(proposal, { action: 'develop', confidence: 0.9, clarity: 1.8, repo: { name: 'api', confidence: 0.95 }, specFaithful: 0.93 }, repos, 0.7);
  assert.equal(d.action, 'develop');
  assert.equal(d.repo.name, 'api');
  assert.deepEqual(d.spec, spec);
  assert.match(d.jev, /Jev develop \(confidence 0\.90, clarity 1\.8\/2\)/);
  const skip = applyVerdict(proposal, { action: 'skip', confidence: 0.8, clarity: 0.2, repo: null, specFaithful: null }, repos, 0.7);
  assert.equal(skip.action, 'skip');
});

test('applyVerdict: low confidence -> back to a human; unfaithful spec -> original task', () => {
  const low = applyVerdict(proposal, { action: 'develop', confidence: 0.55, clarity: 1, repo: null, specFaithful: 0.9 }, repos, 0.7);
  assert.equal(low.action, 'needs_details');
  assert.equal(low.spec, null);
  assert.match(low.reason, /not confident enough to act \(0\.55 < 0\.7\)/);
  const bad = applyVerdict(proposal, { action: 'develop', confidence: 0.9, clarity: 2, repo: { name: 'api', confidence: 0.4 }, specFaithful: 0.2 }, repos, 0.7);
  assert.equal(bad.spec, null);
  assert.equal(bad.repo.name, 'web-app', 'unsure repo answer keeps the triage repo');
  assert.match(bad.jev, /spec rejected \(0\.20\)/);
});
