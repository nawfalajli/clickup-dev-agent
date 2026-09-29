import { loadEnv, loadConfig } from './config.js';
import { ClickUp } from './clickup.js';
import { State } from './state.js';
import { handleTask } from './worker.js';
import { hasDetails, pickRepo, taskRef } from './task.js';
import * as git from './git.js';
import { runClaude, runTests } from './agent.js';
import { createNotifier } from './notify.js';
import { jevJudge } from './jev.js';
import { describeModel } from './providers.js';

const args = new Set(process.argv.slice(2));
const once = args.has('--once');
const dryRun = args.has('--dry-run');
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

loadEnv();
const cfg = loadConfig();
const cu = new ClickUp(cfg.clickup);
const state = new State(cfg.stateFile);
const notify = createNotifier(cfg.whatsapp, (m) => log(m));
const judge = cfg.jev.apiKey ? (input) => jevJudge(cfg.jev, input) : null;
let stopping = false;
let busy = false;

async function poll(userId) {
  const tasks = await cu.assignedTasks(cfg.clickup.teamId, userId, cfg.pickStatuses);
  log(`${tasks.length} open task(s) assigned`);
  for (const task of tasks) {
    if (stopping) return;
    if (dryRun) {
      const plan = hasDetails(task, cfg.minDescriptionLength)
        ? `decide + develop (repo hint: ${pickRepo(task, cfg.repos, cfg.defaultRepo).name})`
        : 'no details -> comment + close';
      log(`[dry-run] ${taskRef(task)} [${task.status?.status}] ${task.name} => ${plan}`);
      continue;
    }
    busy = true;
    await handleTask(task, { cfg, cu, state, deps: { git, runClaude, runTests, judge }, log, notify });
    busy = false;
  }
}

async function main() {
  const userId = cfg.clickup.userId || (await cu.me()).id;
  log(`ClickUp user ${userId}, repos: ${cfg.repos.map((r) => r.name).join(', ')}, MR target: ${cfg.git.targetBranch}, developer: ${describeModel(cfg.claude.developer)}, decision: ${describeModel(cfg.claude.decision)}, Jev: ${cfg.jev.apiKey ? cfg.jev.model : 'off'}, WhatsApp: ${cfg.whatsapp.provider || 'off'}${dryRun ? ' (dry run)' : ''}`);

  for (;;) {
    try {
      await poll(userId);
    } catch (err) {
      log(`poll failed: ${err.message}`);
    }
    if (once || stopping) return;
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping || !busy) process.exit(stopping ? 1 : 0);
    stopping = true;
    log('stopping after the current task (press again to force)');
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
