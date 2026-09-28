import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as git from '../src/git.js';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const g = { remote: 'origin', targetBranch: 'dev' };

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cu-git-'));
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  sh(dir, 'init', '--bare', '-b', 'dev', remote);
  sh(remote, 'config', 'receive.advertisePushOptions', 'true');
  sh(dir, 'clone', remote, work);
  sh(work, 'config', 'user.name', 'Test');
  sh(work, 'config', 'user.email', 't@t');
  sh(work, 'checkout', '-b', 'dev');
  writeFileSync(path.join(work, 'a.txt'), 'a');
  sh(work, 'add', '.');
  sh(work, 'commit', '-m', 'init');
  sh(work, 'push', '-u', 'origin', 'dev');
  return { remote, work };
}

test('task branch is pushed with MR options, dev untouched, tree cleaned', async () => {
  const { remote, work } = makeRepo();
  await git.startBranch(work, g, 'cu/1-x');
  assert.equal(await git.hasChanges(work), false);
  writeFileSync(path.join(work, 'b.txt'), 'b');
  assert.equal(await git.hasChanges(work), true);
  const { sha } = await git.commitAndOpenMr(work, g, 'cu/1-x', '[CU-1] x', '[CU-1] x');
  await git.cleanup(work, g, 'cu/1-x');

  assert.equal(sh(remote, 'rev-parse', '--short', 'cu/1-x'), sha);
  assert.equal(sh(remote, 'log', '--format=%s', 'dev'), 'init', 'dev is never pushed to');
  assert.equal(sh(work, 'branch', '--show-current'), 'dev');
  assert.equal(sh(work, 'branch', '--list', 'cu/1-x'), '');
});

test('failed task: cleanup drops edits and new files', async () => {
  const { work } = makeRepo();
  await git.startBranch(work, g, 'cu/2-y');
  writeFileSync(path.join(work, 'a.txt'), 'changed');
  writeFileSync(path.join(work, 'junk.txt'), 'junk');
  await git.cleanup(work, g, 'cu/2-y');
  assert.equal(await git.hasChanges(work), false);
  assert.equal(existsSync(path.join(work, 'junk.txt')), false);
});

test('refuses a dirty working copy', async () => {
  const { work } = makeRepo();
  writeFileSync(path.join(work, 'dirty.txt'), 'x');
  await assert.rejects(git.startBranch(work, g, 'cu/3'), /uncommitted changes/);
});
