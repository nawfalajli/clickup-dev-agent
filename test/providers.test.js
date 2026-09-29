import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, resolveModel, describeModel } from '../src/providers.js';
import { loadConfig } from '../src/config.js';
import { run } from '../src/proc.js';

const base = { CLICKUP_API_TOKEN: 'pk', CLICKUP_TEAM_ID: '1', REPOS: 'a|/a' };

test('anthropic is the default and changes nothing', () => {
  assert.deepEqual(resolveModel({}, '', ''), { provider: 'anthropic', model: '', env: {} });
  assert.deepEqual(resolveModel({}, 'Anthropic', 'opus'), { provider: 'anthropic', model: 'opus', env: {} });
});

test('covers US and Chinese providers', () => {
  assert.ok(['anthropic', 'openrouter'].every((p) => PROVIDERS[p].region === 'US'));
  assert.ok(['deepseek', 'qwen', 'kimi', 'glm', 'minimax'].every((p) => PROVIDERS[p].region === 'CN'));
});

test('a third-party provider points Claude Code at its endpoint', () => {
  const m = resolveModel({ DEEPSEEK_API_KEY: 'sk-ds' }, 'deepseek', '');
  assert.equal(m.model, 'deepseek-chat');
  assert.equal(m.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(m.env.ANTHROPIC_AUTH_TOKEN, 'sk-ds');
  assert.ok('ANTHROPIC_API_KEY' in m.env && m.env.ANTHROPIC_API_KEY === undefined, 'Anthropic key is never forwarded');
  assert.equal(m.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-chat');
  assert.equal(describeModel(m), 'deepseek/deepseek-chat');
});

test('base URL and model can be overridden (e.g. mainland China endpoints)', () => {
  const m = resolveModel({ ZAI_API_KEY: 'k', ZAI_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' }, 'glm', 'glm-4.5');
  assert.equal(m.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(m.model, 'glm-4.5');
});

test('missing key, unknown provider and incomplete custom are rejected', () => {
  assert.throws(() => resolveModel({}, 'kimi', ''), /MOONSHOT_API_KEY/);
  assert.throws(() => resolveModel({}, 'gpt', ''), /Unknown model provider "gpt"/);
  assert.throws(() => resolveModel({ CUSTOM_API_KEY: 'k' }, 'custom', ''), /CUSTOM_BASE_URL, LLM_MODEL/);
});

test('config: developer and decision models per provider', () => {
  const same = loadConfig({ ...base, LLM_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'k', LLM_MODEL: 'qwen3-max' });
  assert.equal(describeModel(same.claude.developer), 'qwen/qwen3-max');
  assert.equal(describeModel(same.claude.decision), 'qwen/qwen3-max', 'decision inherits on the same provider');

  const mixed = loadConfig({
    ...base, CLAUDE_MODEL: 'opus', DECISION_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k',
  });
  assert.equal(describeModel(mixed.claude.developer), 'anthropic/opus', 'CLAUDE_MODEL still works');
  assert.equal(describeModel(mixed.claude.decision), 'openrouter/openai/gpt-5', 'no Claude model id sent to another provider');

  assert.throws(() => loadConfig({ ...base, LLM_PROVIDER: 'minimax' }), /MINIMAX_API_KEY/);
});

test('run: env overrides reach the child, undefined removes a key', async () => {
  process.env.PROVIDERS_TEST_DROP = 'x';
  const res = await run(process.execPath, ['-e', 'process.stdout.write(`${process.env.PROVIDERS_TEST_SET}|${process.env.PROVIDERS_TEST_DROP ?? "gone"}`)'],
    { env: { PROVIDERS_TEST_SET: 'on', PROVIDERS_TEST_DROP: undefined } });
  delete process.env.PROVIDERS_TEST_DROP;
  assert.equal(res.stdout, 'on|gone');
});
