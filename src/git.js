import { run } from './proc.js';

async function git(cwd, args) {
  const res = await run('git', args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`);
  return { out: res.stdout.trim(), all: `${res.stdout}\n${res.stderr}` };
}

/** Fresh task branch on top of an up-to-date <remote>/<target>. Refuses to touch a dirty tree. */
export async function startBranch(cwd, { remote, targetBranch }, branch) {
  if ((await git(cwd, ['status', '--porcelain'])).out) {
    throw new Error(`${cwd} has uncommitted changes: point REPOS at a dedicated clean clone`);
  }
  await git(cwd, ['fetch', remote, targetBranch]);
  await git(cwd, ['checkout', '-B', branch, `${remote}/${targetBranch}`]);
}

export async function hasChanges(cwd) {
  return Boolean((await git(cwd, ['status', '--porcelain'])).out);
}

/** Back to <target>, dropping the task branch and anything left in the tree (ignored files are kept). */
export async function cleanup(cwd, { remote, targetBranch }, branch) {
  await git(cwd, ['reset', '--hard']);
  await git(cwd, ['clean', '-fd']);
  await git(cwd, ['checkout', '-B', targetBranch, `${remote}/${targetBranch}`]);
  await git(cwd, ['branch', '-D', branch]).catch(() => {});
}

/**
 * Commit and push the task branch, asking GitLab to open a merge request into <target>
 * through push options (no API token needed). Returns the short sha and the MR url GitLab prints.
 */
export async function commitAndOpenMr(cwd, { remote, targetBranch }, branch, message, title) {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
  const push = await git(cwd, [
    'push', '--force-with-lease', '-u', remote, branch,
    '-o', 'merge_request.create',
    '-o', `merge_request.target=${targetBranch}`,
    '-o', `merge_request.title=${title.replace(/[\r\n]+/g, ' ')}`,
    '-o', 'merge_request.remove_source_branch',
  ]);
  const sha = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).out;
  const mrUrl = push.all.match(/https?:\/\/\S+\/-\/merge_requests\/\d+/)?.[0] ?? '';
  return { sha, mrUrl };
}
