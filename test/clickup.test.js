import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ClickUp } from '../src/clickup.js';

test('ClickUp client: auth header, paging, comment, status', async (t) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const url = new URL(req.url, 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/team/9/task') {
        const page = Number(url.searchParams.get('page'));
        const tasks = page === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` })) : [{ id: 'last' }];
        return res.end(JSON.stringify({ tasks, last_page: page === 1 }));
      }
      if (url.pathname === '/task/bad/comment') { res.statusCode = 401; return res.end('{"err":"nope"}'); }
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());

  const cu = new ClickUp({ token: 'pk_test', apiUrl: `http://127.0.0.1:${server.address().port}/` });
  const tasks = await cu.assignedTasks('9', 42, ['to do', 'open']);
  assert.equal(tasks.length, 101);
  const first = new URL(calls[0].url, 'http://x');
  assert.equal(calls[0].auth, 'pk_test');
  assert.deepEqual(first.searchParams.getAll('assignees[]'), ['42']);
  assert.deepEqual(first.searchParams.getAll('statuses[]'), ['to do', 'open']);
  assert.equal(first.searchParams.get('include_closed'), 'false');

  await cu.comment('abc', 'hello');
  assert.deepEqual(JSON.parse(calls.at(-1).body), { comment_text: 'hello', notify_all: false });
  await cu.setStatus('abc', 'done');
  assert.equal(calls.at(-1).method, 'PUT');
  assert.deepEqual(JSON.parse(calls.at(-1).body), { status: 'done' });

  await assert.rejects(cu.comment('bad', 'x'), /401/);
});
