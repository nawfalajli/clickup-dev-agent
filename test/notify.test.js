import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/notify.js';
import { loadConfig } from '../src/config.js';

const base = { CLICKUP_API_TOKEN: 'pk', CLICKUP_TEAM_ID: '1', REPOS: 'a|/a' };

function stubFetch(t, status = 200) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return new Response('{}', { status }); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('config: WhatsApp off by default, validated per provider', () => {
  assert.equal(loadConfig(base).whatsapp.provider, '');
  assert.throws(() => loadConfig({ ...base, WHATSAPP_PROVIDER: 'sms' }), /twilio, meta, callmebot/);
  assert.throws(() => loadConfig({ ...base, WHATSAPP_PROVIDER: 'twilio', WHATSAPP_TO: '+1' }), /TWILIO_ACCOUNT_SID/);
  const w = loadConfig({ ...base, WHATSAPP_PROVIDER: 'callmebot', WHATSAPP_TO: '+2126', CALLMEBOT_API_KEY: 'k' }).whatsapp;
  assert.deepEqual(w.events, ['done', 'error', 'blocked', 'no-changes']);
});

test('twilio: form-encoded message with basic auth', async (t) => {
  const calls = stubFetch(t);
  await createNotifier({ provider: 'twilio', to: '+2126', from: '+14155238886', twilioSid: 'AC1', twilioToken: 'tok', events: ['done'] })('done', 'hi');
  assert.match(calls[0].url, /Accounts\/AC1\/Messages\.json$/);
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('AC1:tok').toString('base64')}`);
  const body = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(body.get('To'), 'whatsapp:+2126');
  assert.equal(body.get('From'), 'whatsapp:+14155238886');
  assert.equal(body.get('Body'), 'hi');
});

test('meta: Cloud API text message', async (t) => {
  const calls = stubFetch(t);
  await createNotifier({ provider: 'meta', to: '+2126', metaToken: 'EA', metaPhoneId: '99', events: ['error'] })('error', 'boom');
  assert.match(calls[0].url, /graph\.facebook\.com\/v\d+\.\d+\/99\/messages$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { messaging_product: 'whatsapp', to: '2126', type: 'text', text: { body: 'boom' } });
});

test('callmebot: GET with phone, text, apikey', async (t) => {
  const calls = stubFetch(t);
  await createNotifier({ provider: 'callmebot', to: '+2126', callmebotKey: 'k1', events: ['blocked'] })('blocked', 'a b');
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('phone'), '+2126');
  assert.equal(u.searchParams.get('text'), 'a b');
  assert.equal(u.searchParams.get('apikey'), 'k1');
});

test('muted events are not sent, provider errors are logged not thrown', async (t) => {
  const calls = stubFetch(t, 500);
  const logs = [];
  const notify = createNotifier({ provider: 'callmebot', to: '+1', callmebotKey: 'k', events: ['done'] }, (m) => logs.push(m));
  await notify('skipped', 'x');
  assert.equal(calls.length, 0);
  await notify('done', 'x');
  assert.match(logs[0], /WhatsApp notification failed: CallMeBot -> 500/);
  await createNotifier({ provider: '' })('done', 'x');
  assert.equal(calls.length, 1);
});
