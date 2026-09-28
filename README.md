# ClickUp Dev Agent

> An AI developer for your ClickUp board: it picks up the tasks assigned to you, develops them in your codebase, and delivers each one as a merge request.

![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Claude Code](https://img.shields.io/badge/agent-Claude%20Code-d97757)

The service polls ClickUp for open tasks assigned to you and develops them with Claude Code. It works out which repository each task belongs to, then builds the feature or fix following the project's existing conventions. Before delivering anything it runs the tests to make sure the work is sound. It then opens a merge request into your integration branch and reports back on the ClickUp task.

---

## Table of contents

- [How it works](#how-it-works)
- [Guardrails](#guardrails)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Task outcomes](#task-outcomes)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security](#security)

---

## How it works

```mermaid
flowchart TD
    A[Poll ClickUp<br/>open tasks assigned to me] --> B{Has a description<br/>or checklist?}
    B -- no --> N1[Comment: please add details<br/>status: NO_DETAILS_STATUS]
    B -- yes --> C[Decision step<br/>read-only Claude run]
    C -- needs_details --> N2[Comment with questions<br/>status: NO_DETAILS_STATUS]
    C -- skip --> N3[Comment: not a code task<br/>status unchanged]
    C -- develop + repo + plan --> D[status: IN_PROGRESS_STATUS<br/>branch cu/&lt;task&gt;-&lt;slug&gt; from origin/dev]
    D --> E[Developer agent<br/>implement, write tests, run tests]
    E --> F[Service re-runs the repo's test command]
    F -- fail --> R[Reset clone, retry next poll<br/>give up after MAX_ATTEMPTS]
    F -- pass --> G[Commit, push, open merge request into dev]
    G --> H[Comment: summary + MR link<br/>status: DONE_STATUS]
```

1. **Pre-filter.** A task with no description (and no checklist) gets a comment asking for details. It never reaches Claude, so it costs nothing.
2. **Decision step.** Claude reads the task and looks through your repositories read-only. It returns `develop`, `needs_details` or `skip`, the target repository and a short implementation plan.
3. **Development.** On a fresh task branch, the developer agent implements the change, adds tests that follow the project's conventions, and runs them.
4. **Verification.** The service runs the repository's own test command independently. The work is pushed only if that command passes.
5. **Merge request.** The branch is pushed with GitLab push options, which opens a merge request into the target branch. No GitLab API token is needed.
6. **Report.** The agent's summary and the MR link are posted on the ClickUp task, and the task moves to the done status.

The service remembers every task it handled in `state.json`. A task runs again only if its **title or description changes**.

---

## Guardrails

| Concern | How it is handled |
|---|---|
| Unreviewed code reaching `dev` | Never pushed directly. Every task becomes a **merge request** that a human reviews and merges. |
| Agent running arbitrary commands | The developer agent runs in `dontAsk` mode with an **allowlist**: file edit/search, `npm test/lint/typecheck`, `npx tsc/vitest/jest`, `git status/diff/log`. Everything else is denied. |
| Agent committing or pushing | Not allowed. Only the service commits, after its own test run passes. |
| Decision step side effects | Read-only tools only (`Read`, `Glob`, `Grep`). |
| Touching your working copy | Each repository must be a **dedicated clone**. The service refuses a dirty tree and resets the clone after every task (git-ignored files such as `.env` are kept). |
| Endless retries | Failed tasks are retried up to `MAX_ATTEMPTS`, then the error is posted on the task. |
| Vague tasks | Commented with the questions to answer, not guessed at. |

---

## Requirements

- **Node.js 22+** (the service has no npm dependencies)
- **git**, with push access to your repositories
- **[Claude Code](https://docs.claude.com/en/docs/claude-code)** installed and logged in (`claude`), or an Anthropic API key
- A **ClickUp personal API token**
- Repositories hosted on **GitLab** (merge requests are opened through push options)

---

## Quick start

```bash
# 1. Get the service
git clone <this-repo-url> clickup-dev-agent
cd clickup-dev-agent

# 2. Create your local config (never committed)
cp .env.example .env
#    then fill in CLICKUP_API_TOKEN, CLICKUP_TEAM_ID and REPOS

# 3. Make a dedicated clone of each repository the agent will work on
git clone <your-frontend-repo-url> /path/to/automation/frontend
git clone <your-backend-repo-url>  /path/to/automation/backend
#    and run `npm install` in each so their tests can run

# 4. See what would happen, without side effects
npm run dry-run

# 5. Run it
npm run once     # a single pass
npm start        # keep polling
```

---

## Configuration

All settings live in `.env`. `.env.example` lists every key with a comment. **Only `.env.example` is committed.**

### ClickUp

| Key | Required | Default | Description |
|---|:---:|---|---|
| `CLICKUP_API_TOKEN` | ✅ | | Personal token: *ClickUp → Settings → Apps → API Token* |
| `CLICKUP_TEAM_ID` | ✅ | | Workspace id, the number in `app.clickup.com/<id>/…` |
| `CLICKUP_USER_ID` | | auto | Your user id. Detected from the token when empty. |
| `PICK_STATUSES` | | all open | Comma-separated statuses to pick tasks from, e.g. `to do` |
| `IN_PROGRESS_STATUS` | | | Status set while the agent works. Empty = unchanged. |
| `DONE_STATUS` | | `done` | Status set once the merge request is opened |
| `NO_DETAILS_STATUS` | | `done` | Status for tasks without details. Empty = unchanged. |
| `MIN_DESCRIPTION_LENGTH` | | `20` | Descriptions shorter than this count as "no details" |

> Status names must match the statuses of your ClickUp lists exactly (case-insensitive in ClickUp).

### Repositories and git

| Key | Required | Default | Description |
|---|:---:|---|---|
| `REPOS` | ✅ | | `name\|path\|test command` entries separated by `;` |
| `DEFAULT_REPO` | | first repo | Repository used when no tag matches |
| `GIT_REMOTE` | | `origin` | Remote to fetch from and push to |
| `GIT_TARGET_BRANCH` | | `dev` | Branch the merge requests target |
| `GIT_BRANCH_PREFIX` | | `cu/` | Prefix of the task branches |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | | repo config | Optional commit identity (same for `GIT_COMMITTER_*`) |

Example (placeholders):

```dotenv
REPOS=front|/path/to/automation/frontend|npm test;back|/path/to/automation/backend|npm test
DEFAULT_REPO=front
```

**Routing:** a task tagged `front` or `back` in ClickUp goes to the repository with that name. Otherwise it goes to `DEFAULT_REPO`. The decision step can override the choice when the task clearly belongs elsewhere.

### Claude Code

| Key | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Optional. When empty, your logged-in Claude Code session is used. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `CLAUDE_MODEL` | CLI default | Model for the developer agent |
| `CLAUDE_DECISION_MODEL` | `CLAUDE_MODEL` | Model for the decision step |
| `CLAUDE_ALLOWED_TOOLS` | safe allowlist | Comma-separated tools the developer agent may use |
| `CLAUDE_TIMEOUT_MINUTES` | `45` | Maximum time for one development run |
| `CLAUDE_DECISION_TIMEOUT_MINUTES` | `10` | Maximum time for one decision run |
| `TEST_TIMEOUT_MINUTES` | `15` | Maximum time for the verification test run |

### Service

| Key | Default | Description |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `300` | Delay between two polls |
| `MAX_ATTEMPTS` | `2` | Failed attempts per task before giving up |

---

## Commands

| Command | What it does |
|---|---|
| `npm start` | Polls forever. `Ctrl+C` stops after the current task (press twice to force). |
| `npm run once` | One polling pass, then exits. Handy for a cron job or scheduled task. |
| `npm run dry-run` | Lists tasks and what would happen. No Claude runs, comments or git operations. |
| `npm test` | Runs the test suite |

---

## Task outcomes

Recorded per task in `state.json` (git-ignored):

| Outcome | ClickUp comment | Status change | Retried when |
|---|---|---|---|
| `no-details` | asks for details | `NO_DETAILS_STATUS` | the task is edited |
| `needs-details` | questions from the decision step | `NO_DETAILS_STATUS` | the task is edited |
| `skipped` | reason it is not a code task | none | the task is edited |
| `blocked` | agent's reason and questions | none | the task is edited |
| `no-changes` | agent's summary | none | the task is edited |
| `done` | summary + merge request link | `DONE_STATUS` | the task is edited |
| `error` | posted after the last attempt | none | next poll, up to `MAX_ATTEMPTS` |

To force a task to run again, delete its entry from `state.json`.

---

## Project structure

```
clickup-dev-agent/
├── src/
│   ├── index.js     # entry point: polling loop, --once / --dry-run, graceful stop
│   ├── worker.js    # per-task flow: pre-filter → decision → develop → MR → report
│   ├── task.js      # prompts, decision parsing, routing, branch names, fingerprints
│   ├── agent.js     # Claude Code headless runs + verification test run
│   ├── git.js       # task branch, cleanup, commit + push with MR options
│   ├── clickup.js   # minimal ClickUp API v2 client
│   ├── config.js    # .env loading and validation
│   ├── state.js     # state.json persistence
│   └── proc.js      # child process helper with timeouts
├── test/            # node:test suites
├── .env.example     # every setting, documented (copy to .env)
└── package.json
```

---

## Testing

```bash
npm test
```

- **task / config:** routing, branch naming, decision parsing, config validation
- **clickup:** the client against a local mock HTTP server (auth header, paging, comments, statuses)
- **worker:** every outcome path, with ClickUp, Claude and git faked
- **git:** the real branch → push-with-MR-options → cleanup flow against a local bare repository, checking that the target branch is never pushed to directly

The tests never call ClickUp or Claude.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing in .env: …` | Copy `.env.example` to `.env` and fill in the listed keys. |
| `ClickUp … -> 401` | Invalid or expired `CLICKUP_API_TOKEN`. |
| `ClickUp … -> 400` when setting a status | The status name does not exist in that list. Check `DONE_STATUS` / `IN_PROGRESS_STATUS`. |
| `has uncommitted changes` | `REPOS` points at a working copy. Use a dedicated clean clone. |
| No merge request link in the comment | The remote is not GitLab, or push options are disabled. The branch is still pushed, so open the MR manually. |
| `Claude Code exited …` | Run `claude` once interactively to log in, or set `ANTHROPIC_API_KEY`. |
| Tasks are never picked | Check `PICK_STATUSES` and that the tasks are assigned to the token's user. |

---

## Security

- **Never commit `.env`.** It is in `.gitignore`. Only `.env.example`, which has empty values, belongs in the repository.
- Use a ClickUp token that belongs to the account the tasks are assigned to, and rotate it if it leaks.
- The agent works from task descriptions, so only point the service at workspaces whose authors you trust. Merge-request review is the final safety net: always review before merging.
- Every Claude run is billed to your Claude Code account or API key. Empty tasks never reach Claude, and the decision step stops out-of-scope tasks before the more expensive development run.
